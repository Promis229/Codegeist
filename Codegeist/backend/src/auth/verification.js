import crypto from 'node:crypto';
import { one, query, tx } from '../db/pool.js';
import { hmac, safeEqual } from '../lib/crypto.js';
import { env } from '../config/env.js';
import { AppError, badRequest } from '../lib/errors.js';
import { sendMail } from '../lib/mailer.js';

const MAX_ATTEMPTS = 5;
const TTL_MIN = 15;
const RESEND_COOLDOWN_SEC = 60;

const hashCode = (userId, code) => hmac(env.jwtSecret, `emailcode|${userId}|${code}`);

/** Genere et envoie un code a 6 chiffres. Invalide les codes precedents. Respecte un delai entre deux envois. */
export async function sendVerificationCode(user) {
  const last = await one('SELECT created_at FROM email_verifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [user.id]);
  if (last && Date.now() - new Date(last.created_at).getTime() < RESEND_COOLDOWN_SEC * 1000) {
    throw new AppError(429, 'too_soon', `Patientez ${RESEND_COOLDOWN_SEC}s avant de redemander un code`);
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await tx(async (db) => {
    await db.query('UPDATE email_verifications SET used_at = now() WHERE user_id=$1 AND used_at IS NULL', [user.id]);
    await db.query(
      `INSERT INTO email_verifications(user_id, code_hash, expires_at) VALUES ($1,$2, now() + make_interval(mins => $3))`,
      [user.id, hashCode(user.id, code), TTL_MIN],
    );
  });
  await sendMail({
    to: user.email,
    subject: 'Votre code de confirmation Kairos',
    text: `Votre code de confirmation est ${code}. Il expire dans ${TTL_MIN} minutes. Si vous n'etes pas a l'origine de cette demande, ignorez ce message.`,
  });
}

/** Verifie le code (max 5 essais, usage unique). Marque l'email comme confirme. */
export async function confirmVerificationCode(user, code) {
  // IMPORTANT : on ne leve JAMAIS d'exception dans la transaction, sinon le ROLLBACK annulerait le
  // compteur d'essais (et rendrait la force brute illimitee). On renvoie un statut, puis on leve apres COMMIT.
  const outcome = await tx(async (db) => {
    const v = await db.one(
      `SELECT * FROM email_verifications WHERE user_id=$1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [user.id],
    );
    if (!v || new Date(v.expires_at) < new Date()) return 'expired';
    if (v.attempts >= MAX_ATTEMPTS) {
      await db.query('UPDATE email_verifications SET used_at = now() WHERE id=$1', [v.id]); // code brule
      return 'too_many';
    }
    if (!safeEqual(hashCode(user.id, code), v.code_hash)) {
      await db.query('UPDATE email_verifications SET attempts = attempts + 1 WHERE id=$1', [v.id]);
      return 'wrong';
    }
    await db.query('UPDATE email_verifications SET used_at = now() WHERE id=$1', [v.id]);
    await db.query('UPDATE users SET email_verified = true WHERE id=$1', [user.id]);
    return 'ok';
  });
  if (outcome === 'expired') throw new AppError(400, 'code_expired', 'Code expire ou inexistant, demandez-en un nouveau');
  if (outcome === 'too_many') throw new AppError(429, 'too_many_attempts', 'Trop d\'essais, demandez un nouveau code');
  if (outcome === 'wrong') throw new AppError(400, 'invalid_code', 'Code incorrect');
  return true;
}

export const hasPendingCode = (userId) =>
  query('SELECT 1 FROM email_verifications WHERE user_id=$1 AND used_at IS NULL AND expires_at > now()', [userId]).then((r) => r.rowCount > 0);
