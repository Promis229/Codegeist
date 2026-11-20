import { z } from 'zod';
import { env } from '../config/env.js';
import { many, one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import {
  decrypt, encrypt, newRecoveryCodes, newTotpSecret, randomToken, safeEqual, sha256, verifyTotp,
} from '../lib/crypto.js';
import { AppError, badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { sendMail } from '../lib/mailer.js';
import { dummyVerify, hashPassword, passwordSchema, verifyPassword } from './password.js';
import { confirmVerificationCode, sendVerificationCode } from './verification.js';
import { createUserWithOrg, publicUser, resolveMembership, startSession } from './service.js';
import { revokeFamilyByToken, rotateRefresh, signAccess, signPurpose, verifyPurpose } from './tokens.js';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const strict = { config: { rateLimit: { max: env.strictRate, timeWindow: '1 minute' } } };
const meta = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

const emailSchema = z.string().trim().toLowerCase().email().max(254);

export default async function authRoutes(app) {
  // ---------- Inscription ----------
  app.post('/auth/register', strict, async (req, reply) => {
    const body = z.object({
      email: emailSchema, password: passwordSchema,
      displayName: z.string().trim().min(1).max(80), orgName: z.string().trim().min(2).max(80).optional(),
      // Consentement explicite : les deux cases doivent etre cochees (le serveur refuse sinon, quel que soit le client).
      acceptTerms: z.literal(true), acceptPrivacy: z.literal(true),
    }).parse(req.body);
    const { user, org } = await createUserWithOrg({ ...body, consent: true }); // email_verified = false
    await audit(org.id, user.id, 'auth.register', 'user', user.id);
    try { await sendVerificationCode(user); }
    catch (e) {
      // L'e-mail n'a pas pu partir : on defait l'inscription pour que l'utilisateur puisse recommencer
      // (sinon l'adresse resterait « deja prise » par un compte qu'il ne peut jamais confirmer).
      if (e.code === 'email_unavailable') {
        await query('DELETE FROM orgs WHERE id=$1', [org.id]);
        await query('DELETE FROM users WHERE id=$1', [user.id]);
      }
      throw e;
    }
    // Aucune session avant confirmation : le code recu par email prouve la possession de l'adresse.
    reply.code(201);
    return { verificationRequired: true, email: user.email };
  });

  // ---------- Confirmation de l'inscription par code ----------
  app.post('/auth/verify-email', strict, async (req) => {
    const { email, code } = z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/, 'Code a 6 chiffres') }).parse(req.body);
    const user = await one('SELECT * FROM users WHERE email=$1', [email]);
    if (!user) throw new AppError(400, 'invalid_code', 'Code incorrect'); // meme message : pas d'enumeration
    if (!user.email_verified) await confirmVerificationCode(user, code);
    else throw new AppError(400, 'already_verified', 'Email deja confirme, connectez-vous');
    const m = await resolveMembership(user.id);
    await audit(m?.org_id ?? null, user.id, 'auth.email_verified', 'user', user.id);
    const fresh = await one('SELECT * FROM users WHERE id=$1', [user.id]);
    return { ...(await startSession(user.id, meta(req))), user: publicUser(fresh) };
  });

  app.post('/auth/verify-email/resend', strict, async (req) => {
    const { email } = z.object({ email: emailSchema }).parse(req.body);
    const user = await one('SELECT * FROM users WHERE email=$1 AND email_verified=false AND disabled=false', [email]);
    if (user) await sendVerificationCode(user).catch((e) => { if (e.status !== 429) throw e; });
    return { ok: true }; // reponse identique que le compte existe ou non
  });

  // ---------- Connexion (anti-enumeration, verrouillage, 2FA) ----------
  app.post('/auth/login', strict, async (req) => {
    const { email, password } = z.object({ email: emailSchema, password: z.string().min(1).max(200) }).parse(req.body);
    const user = await one('SELECT * FROM users WHERE email=$1', [email]);
    const generic = () => new AppError(401, 'invalid_credentials', 'Identifiants invalides');

    if (!user) { await dummyVerify(password); throw generic(); }
    if (user.disabled) throw new AppError(403, 'account_disabled', 'Compte desactive');
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw new AppError(423, 'locked', `Compte verrouille, reessayez dans ${LOCK_MINUTES} minutes maximum`);
    }
    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) {
      const upd = await one(
        `UPDATE users SET failed_logins = failed_logins + 1,
                locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE id=$1 RETURNING failed_logins`,
        [user.id, MAX_FAILS, LOCK_MINUTES],
      );
      const m = await resolveMembership(user.id);
      await audit(m?.org_id ?? null, user.id, 'auth.login_failed', 'user', user.id, { attempts: upd.failed_logins, ip: req.ip });
      throw generic();
    }
    await query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [user.id]);

    if (!user.email_verified) {
      // Mot de passe correct mais adresse non confirmee : on renvoie un nouveau code et on bloque la session.
      await sendVerificationCode(user).catch((e) => { if (e.status !== 429) throw e; });
      throw new AppError(403, 'email_not_verified', 'Confirmez votre email : un code vient de vous etre envoye', { email: user.email });
    }

    if (user.totp_enabled) {
      const mfaToken = await signPurpose('mfa', { uid: user.id }, 300);
      return { mfaRequired: true, mfaToken };
    }
    return { ...(await startSession(user.id, meta(req))), user: publicUser(user) };
  });

  // ---------- Entree demo (opt-in : DEMO_LOGIN=true) ----------
  // Pour un deploiement de presentation sans serveur d'e-mail. La session est celle d'un AGENT de l'organisation de
  // demonstration : jamais administrateur (ni export, ni cles d'API, ni audit), et jamais une autre organisation.
  app.post('/auth/demo', strict, async (req) => {
    if (!env.demoLogin) throw notFound('Route inconnue');
    const user = await one(`SELECT u.* FROM users u JOIN memberships m ON m.user_id=u.id JOIN orgs o ON o.id=m.org_id
                             WHERE u.email='bruno@kairos.dev' AND o.slug='acme' AND m.role='agent' AND u.disabled=false AND u.totp_enabled=false`);
    if (!user) throw notFound('Aucune demonstration disponible');
    return { ...(await startSession(user.id, meta(req), (await resolveMembership(user.id))?.org_id)), user: publicUser(user), demo: true };
  });

  app.post('/auth/login/mfa', strict, async (req) => {
    const { mfaToken, code, recoveryCode } = z.object({
      mfaToken: z.string(), code: z.string().optional(), recoveryCode: z.string().optional(),
    }).parse(req.body);
    const { uid } = await verifyPurpose('mfa', mfaToken);
    const user = await one('SELECT * FROM users WHERE id=$1', [uid]);
    if (!user?.totp_enabled) throw unauthorized();
    let ok = false;
    if (code) ok = verifyTotp(decrypt(user.totp_secret_enc), code);
    else if (recoveryCode) {
      const h = sha256(recoveryCode.trim().toLowerCase());
      const used = await one('UPDATE recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id', [uid, h]);
      ok = !!used;
    }
    if (!ok) {
      await query('UPDATE users SET failed_logins = failed_logins + 1, locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END WHERE id=$1', [uid, MAX_FAILS, LOCK_MINUTES]);
      throw new AppError(401, 'invalid_code', 'Code invalide');
    }
    await query('UPDATE users SET failed_logins=0 WHERE id=$1', [uid]);
    return { ...(await startSession(uid, meta(req))), user: publicUser(user) };
  });

  // ---------- Refresh / logout ----------
  app.post('/auth/refresh', strict, async (req) => {
    const { refreshToken, orgId } = z.object({ refreshToken: z.string().min(20), orgId: z.string().uuid().optional() }).parse(req.body);
    const { userId, token } = await rotateRefresh(refreshToken, meta(req));
    const m = await resolveMembership(userId, orgId);
    const u = await one('SELECT disabled FROM users WHERE id=$1', [userId]);
    if (!m || u?.disabled) throw new AppError(401, 'access_revoked', 'Acces revoque');
    return { accessToken: await signAccess({ userId, orgId: m.org_id, role: m.role }), refreshToken: token, expiresIn: 900 };
  });

  app.post('/auth/logout', async (req) => {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
    await revokeFamilyByToken(refreshToken);
    return { ok: true };
  });

  app.post('/auth/logout-all', { preHandler: app.guard('viewer') }, async (req) => {
    await query('UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id=$1', [req.auth.userId]);
    await audit(req.auth.orgId, req.auth.userId, 'auth.logout_all', 'user', req.auth.userId);
    return { ok: true };
  });

  // ---------- Profil ----------
  app.get('/auth/me', { preHandler: app.guard('viewer') }, async (req) => {
    const user = await one('SELECT * FROM users WHERE id=$1', [req.auth.userId]);
    const orgs = await many(
      'SELECT o.id, o.name, o.slug, m.role FROM memberships m JOIN orgs o ON o.id=m.org_id WHERE m.user_id=$1 ORDER BY m.created_at',
      [req.auth.userId],
    );
    const identities = await many('SELECT provider, email FROM oauth_identities WHERE user_id=$1', [req.auth.userId]);
    return { user: publicUser(user), activeOrgId: req.auth.orgId, role: req.auth.role, orgs, identities, hasPassword: !!user.password_hash };
  });

  app.patch('/auth/me', { preHandler: app.guard('viewer') }, async (req) => {
    const b = z.object({
      displayName: z.string().trim().min(1).max(80).optional(),
      locale: z.enum(['fr', 'en', 'es', 'de']).optional(),
      avatarUrl: z.string().url().max(500).nullable().optional(),
    }).parse(req.body);
    const u = await one(
      `UPDATE users SET display_name = coalesce($2, display_name), locale = coalesce($3, locale),
              avatar_url = CASE WHEN $4::boolean THEN $5 ELSE avatar_url END WHERE id=$1 RETURNING *`,
      [req.auth.userId, b.displayName ?? null, b.locale ?? null, 'avatarUrl' in b, b.avatarUrl ?? null],
    );
    return { user: publicUser(u) };
  });

  app.post('/auth/switch-org', { preHandler: app.guard('viewer') }, async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.body);
    const m = await one('SELECT role FROM memberships WHERE user_id=$1 AND org_id=$2', [req.auth.userId, orgId]);
    if (!m) throw forbidden('Vous n\'etes pas membre de cette organisation');
    return { accessToken: await signAccess({ userId: req.auth.userId, orgId, role: m.role }), orgId, role: m.role };
  });

  // ---------- Mot de passe ----------
  app.post('/auth/password/change', { ...strict, preHandler: app.guard('viewer') }, async (req) => {
    const { current, next } = z.object({ current: z.string().optional(), next: passwordSchema }).parse(req.body);
    const user = await one('SELECT password_hash FROM users WHERE id=$1', [req.auth.userId]);
    if (user.password_hash && !(await verifyPassword(user.password_hash, current ?? ''))) throw new AppError(401, 'wrong_password', 'Mot de passe actuel incorrect');
    await query('UPDATE users SET password_hash=$2 WHERE id=$1', [req.auth.userId, await hashPassword(next)]);
    // Toutes les autres sessions sont invalidees.
    await query('UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id=$1', [req.auth.userId]);
    await audit(req.auth.orgId, req.auth.userId, 'auth.password_changed', 'user', req.auth.userId);
    return { ok: true };
  });

  // Reponse identique que le compte existe ou non (anti-enumeration).
  app.post('/auth/password/forgot', strict, async (req) => {
    const { email } = z.object({ email: emailSchema }).parse(req.body);
    const user = await one('SELECT id, email FROM users WHERE email=$1 AND disabled=false', [email]);
    if (user) {
      const token = randomToken(32);
      await query(`INSERT INTO password_resets(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '30 minutes')`, [user.id, sha256(token)]);
      // La reponse reste identique que l'envoi reussisse ou non (anti-enumeration) ; l'echec est journalise par le mailer.
      await sendMail({ to: user.email, subject: 'Reinitialisation du mot de passe Kairos', text: `${env.webUrl}/reset?token=${token}` }).catch(() => {});
    }
    return { ok: true };
  });

  app.post('/auth/password/reset', strict, async (req) => {
    const { token, password } = z.object({ token: z.string().min(20), password: passwordSchema }).parse(req.body);
    const used = await tx(async (db) => {
      const r = await db.one(
        'UPDATE password_resets SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING user_id',
        [sha256(token)],
      );
      if (!r) return null;
      await db.query('UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL WHERE id=$1', [r.user_id, await hashPassword(password)]);
      await db.query('UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id=$1', [r.user_id]);
      return r.user_id;
    });
    if (!used) throw new AppError(400, 'invalid_link', 'Lien invalide ou expire');
    return { ok: true };
  });

  // ---------- 2FA TOTP ----------
  app.post('/auth/2fa/setup', { preHandler: app.guard('viewer') }, async (req) => {
    const user = await one('SELECT email, totp_enabled FROM users WHERE id=$1', [req.auth.userId]);
    if (user.totp_enabled) throw new AppError(400, 'mfa_already_enabled', '2FA deja active');
    const secret = newTotpSecret();
    await query('UPDATE users SET totp_secret_enc=$2 WHERE id=$1', [req.auth.userId, encrypt(secret)]);
    const uri = `otpauth://totp/Kairos:${encodeURIComponent(user.email)}?secret=${secret}&issuer=Kairos&digits=6&period=30`;
    return { secret, otpauthUri: uri };
  });

  app.post('/auth/2fa/enable', { ...strict, preHandler: app.guard('viewer') }, async (req) => {
    const { code } = z.object({ code: z.string() }).parse(req.body);
    const user = await one('SELECT totp_secret_enc FROM users WHERE id=$1', [req.auth.userId]);
    if (!user.totp_secret_enc || !verifyTotp(decrypt(user.totp_secret_enc), code)) throw new AppError(400, 'invalid_code', 'Code invalide');
    const codes = newRecoveryCodes();
    await tx(async (db) => {
      await db.query('UPDATE users SET totp_enabled=true WHERE id=$1', [req.auth.userId]);
      await db.query('DELETE FROM recovery_codes WHERE user_id=$1', [req.auth.userId]);
      for (const c of codes) await db.query('INSERT INTO recovery_codes(user_id, code_hash) VALUES ($1,$2)', [req.auth.userId, sha256(c)]);
    });
    await audit(req.auth.orgId, req.auth.userId, 'auth.2fa_enabled', 'user', req.auth.userId);
    return { enabled: true, recoveryCodes: codes }; // affiches UNE seule fois
  });

  app.post('/auth/2fa/disable', { ...strict, preHandler: app.guard('viewer') }, async (req) => {
    const { code, password } = z.object({ code: z.string(), password: z.string().optional() }).parse(req.body);
    const user = await one('SELECT * FROM users WHERE id=$1', [req.auth.userId]);
    if (user.password_hash && !(await verifyPassword(user.password_hash, password ?? ''))) throw new AppError(401, 'wrong_password', 'Mot de passe incorrect');
    if (!user.totp_enabled || !verifyTotp(decrypt(user.totp_secret_enc), code)) throw new AppError(400, 'invalid_code', 'Code invalide');
    await query('UPDATE users SET totp_enabled=false, totp_secret_enc=NULL WHERE id=$1', [req.auth.userId]);
    await query('DELETE FROM recovery_codes WHERE user_id=$1', [req.auth.userId]);
    await audit(req.auth.orgId, req.auth.userId, 'auth.2fa_disabled', 'user', req.auth.userId);
    return { enabled: false };
  });

  // ---------- Sessions actives ----------
  app.get('/auth/sessions', { preHandler: app.guard('viewer') }, async (req) => ({
    sessions: await many(
      `SELECT DISTINCT ON (family_id) family_id AS id, user_agent, ip, created_at, expires_at
         FROM refresh_tokens WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now()
         ORDER BY family_id, created_at DESC`,
      [req.auth.userId],
    ),
  }));

  app.delete('/auth/sessions/:id', { preHandler: app.guard('viewer') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await query('UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE family_id=$1 AND user_id=$2', [id, req.auth.userId]);
    if (!r.rowCount) throw notFound('Session introuvable');
    return { ok: true };
  });

  // ---------- Cles d'API ----------
  app.get('/api-keys', { preHandler: app.guard('admin') }, async (req) => ({
    keys: await many(
      'SELECT id, name, prefix, scopes, last_used_at, revoked_at, created_at FROM api_keys WHERE org_id=$1 ORDER BY created_at DESC',
      [req.auth.orgId],
    ),
  }));

  app.post('/api-keys', { preHandler: app.guard('admin') }, async (req, reply) => {
    const b = z.object({
      name: z.string().trim().min(1).max(60),
      scopes: z.array(z.enum(['read', 'write', 'admin'])).min(1).default(['read']),
    }).parse(req.body);
    const key = `kai_${randomToken(32)}`;
    const row = await one(
      'INSERT INTO api_keys(org_id, user_id, name, prefix, key_hash, scopes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, prefix, scopes, created_at',
      [req.auth.orgId, req.auth.userId, b.name, key.slice(0, 10), sha256(key), b.scopes],
    );
    await audit(req.auth.orgId, req.auth.userId, 'apikey.created', 'api_key', row.id, { name: b.name, scopes: b.scopes });
    reply.code(201);
    return { ...row, key }; // la cle en clair n'est montree qu'une fois
  });

  app.delete('/api-keys/:id', { preHandler: app.guard('admin') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await query('UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL', [id, req.auth.orgId]);
    if (!r.rowCount) throw notFound();
    await audit(req.auth.orgId, req.auth.userId, 'apikey.revoked', 'api_key', id);
    return { ok: true };
  });
}
