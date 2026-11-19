import argon2 from 'argon2';
import { z } from 'zod';

// argon2id, parametres OWASP 2023+ (19 MiB, t=2, p=1)
const OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (pw) => argon2.hash(pw, OPTS);
export const verifyPassword = async (hash, pw) => {
  if (!hash) return false;
  try { return await argon2.verify(hash, pw); } catch { return false; }
};

// Hash factice pour egaliser le temps de reponse quand l'email n'existe pas (anti-enumeration).
let dummy;
export async function dummyVerify(pw) {
  dummy ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(dummy, pw);
}

const COMMON = new Set(['password', 'password1', '12345678', '123456789', 'qwertyuiop', 'azertyuiop', 'motdepasse', 'iloveyou1', 'welcome123', 'admin1234', 'letmein123', 'changeme123']);

export const passwordSchema = z.string().min(10, '10 caracteres minimum').max(200)
  .refine((p) => !COMMON.has(p.toLowerCase()), 'Mot de passe trop courant')
  .refine((p) => /[a-z]/.test(p) && /[A-Z0-9\W_]/.test(p), 'Melange lettres minuscules et majuscules/chiffres/symboles');
