import { SignJWT, jwtVerify } from 'jose';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { one, query, tx } from '../db/pool.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';

const key = new TextEncoder().encode(env.jwtSecret);
const ISS = 'kairos';

export async function signAccess({ userId, orgId, role }) {
  return new SignJWT({ org: orgId, role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(ISS)
    .setAudience('kairos-api')
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime(`${env.accessTtlSec}s`)
    .sign(key);
}

export async function verifyAccess(token) {
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISS, audience: 'kairos-api', algorithms: ['HS256'] });
    return { userId: payload.sub, orgId: payload.org, role: payload.role };
  } catch {
    throw unauthorized('Jeton invalide ou expire');
  }
}

/** Emet un refresh token opaque (stocke hache). Une "famille" regroupe toute la chaine de rotation. */
export async function issueRefresh(userId, meta = {}, familyId = crypto.randomUUID()) {
  const token = randomToken(48);
  const row = await one(
    `INSERT INTO refresh_tokens(user_id, family_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1,$2,$3, now() + make_interval(secs => $4), $5, $6) RETURNING id`,
    [userId, familyId, sha256(token), env.refreshTtlSec, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null],
  );
  return { token, id: row.id, familyId };
}

const REUSE_GRACE_MS = 10_000;

/**
 * Rotation : chaque refresh token est a usage unique. Si un token deja consomme est rejoue
 * (signe de vol), TOUTE la famille est revoquee et l'utilisateur doit se reconnecter.
 */
export async function rotateRefresh(presented, meta = {}) {
  const hash = sha256(presented);
  // Ne JAMAIS lever d'exception dans la transaction : le ROLLBACK annulerait la revocation de la famille.
  const out = await tx(async (db) => {
    const row = await db.one('SELECT * FROM refresh_tokens WHERE token_hash=$1 FOR UPDATE', [hash]);
    if (!row) return { error: 'Session inconnue' };
    if (row.revoked_at || row.replaced_by) {
      // Tolerance de rejeu (10 s) : deux onglets ou un rechargement rapide presentent legitimement le meme jeton presque
      // en meme temps. Si le jeton vient d'etre remplace et que son remplacant est toujours actif, on emet un jeton
      // « frere » dans la meme famille au lieu de crier au vol. Au-dela, ou si la famille a ete fermee (deconnexion), c'est un rejeu.
      const replacement = row.replaced_by ? await db.one('SELECT revoked_at FROM refresh_tokens WHERE id=$1', [row.replaced_by]) : null;
      const recent = row.replaced_by && row.revoked_at && Date.now() - new Date(row.revoked_at).getTime() < REUSE_GRACE_MS;
      if (!(recent && replacement && !replacement.revoked_at)) {
        await db.query('UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE family_id=$1', [row.family_id]);
        return { error: 'Reutilisation de jeton detectee : session revoquee' };
      }
      if (new Date(row.expires_at) < new Date()) return { error: 'Session expiree' };
      const sibling = randomToken(48);
      await db.query(
        `INSERT INTO refresh_tokens(user_id, family_id, token_hash, expires_at, user_agent, ip)
         VALUES ($1,$2,$3, now() + make_interval(secs => $4), $5, $6)`,
        [row.user_id, row.family_id, sha256(sibling), env.refreshTtlSec, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null],
      );
      return { userId: row.user_id, token: sibling };
    }
    if (new Date(row.expires_at) < new Date()) return { error: 'Session expiree' };
    const next = randomToken(48);
    const created = await db.one(
      `INSERT INTO refresh_tokens(user_id, family_id, token_hash, expires_at, user_agent, ip)
       VALUES ($1,$2,$3, now() + make_interval(secs => $4), $5, $6) RETURNING id`,
      [row.user_id, row.family_id, sha256(next), env.refreshTtlSec, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null],
    );
    await db.query('UPDATE refresh_tokens SET replaced_by=$2, revoked_at=now() WHERE id=$1', [row.id, created.id]);
    return { userId: row.user_id, token: next };
  });
  if (out.error) throw unauthorized(out.error);
  return out;
}

export const revokeFamilyByToken = (presented) =>
  query(
    `UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now())
     WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash=$1)`,
    [sha256(presented)],
  );

/** Signe un jeton court a usage specifique (etat OAuth, challenge 2FA). */
export async function signPurpose(purpose, claims, ttlSec = 600) {
  return new SignJWT({ ...claims, purpose })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISS)
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(key);
}

export async function verifyPurpose(purpose, token) {
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISS, algorithms: ['HS256'] });
    if (payload.purpose !== purpose) throw new Error('purpose');
    return payload;
  } catch {
    throw unauthorized('Jeton invalide ou expire');
  }
}
