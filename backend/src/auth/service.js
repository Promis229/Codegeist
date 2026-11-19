import crypto from 'node:crypto';
import { one, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, conflict } from '../lib/errors.js';
import { hashPassword } from './password.js';
import { issueRefresh, signAccess } from './tokens.js';

export const slugify = (s) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org';

/** Cree un utilisateur + sa premiere organisation (proprietaire). */
export async function createUserWithOrg({ email, password, displayName, orgName, emailVerified = false, avatarUrl = null }) {
  const passwordHash = password ? await hashPassword(password) : null;
  return tx(async (db) => {
    const exists = await db.one('SELECT 1 FROM users WHERE email=$1', [email]);
    if (exists) throw new AppError(409, 'email_taken', 'Un compte existe deja avec cet email');
    const user = await db.one(
      `INSERT INTO users(email, password_hash, display_name, email_verified, avatar_url)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, email, display_name`,
      [email, passwordHash, displayName, emailVerified, avatarUrl],
    );
    const base = slugify(orgName ?? `${displayName}-desk`);
    const org = await db.one(
      'INSERT INTO orgs(name, slug) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET slug = orgs.slug || $3 RETURNING id, slug',
      [orgName ?? `${displayName} Desk`, base, `-${crypto.randomBytes(2).toString('hex')}`],
    );
    await db.query('INSERT INTO memberships(user_id, org_id, role) VALUES ($1,$2,$3)', [user.id, org.id, 'owner']);
    return { user, org };
  });
}

/** Choisit l'organisation a utiliser pour une session (la plus ancienne par defaut, ou celle demandee). */
export async function resolveMembership(userId, preferredOrgId) {
  return one(
    `SELECT m.org_id, m.role FROM memberships m
      WHERE m.user_id=$1 AND ($2::uuid IS NULL OR m.org_id=$2)
      ORDER BY m.created_at LIMIT 1`,
    [userId, preferredOrgId ?? null],
  );
}

export async function startSession(userId, meta, preferredOrgId) {
  const m = await resolveMembership(userId, preferredOrgId);
  if (!m) throw conflict('Aucune organisation pour cet utilisateur');
  const accessToken = await signAccess({ userId, orgId: m.org_id, role: m.role });
  const refresh = await issueRefresh(userId, meta);
  await audit(m.org_id, userId, 'auth.login', 'user', userId, { ip: meta.ip ?? null });
  return { accessToken, refreshToken: refresh.token, expiresIn: 900, orgId: m.org_id, role: m.role };
}

export const publicUser = (u) => ({
  id: u.id, email: u.email, displayName: u.display_name, avatarUrl: u.avatar_url ?? null,
  locale: u.locale, emailVerified: u.email_verified, totpEnabled: u.totp_enabled,
});
