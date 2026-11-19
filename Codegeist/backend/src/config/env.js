import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Charge backend/.env en developpement (sans dependance). Les variables deja definies gagnent.
const here = path.dirname(fileURLToPath(import.meta.url));
for (const envFile of [path.resolve(here, '../../.env'), path.resolve(here, '../../../.env')]) {
  if (!existsSync(envFile)) continue;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined && m[2] !== '') process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const isTest = process.env.NODE_ENV === 'test';
const isProd = process.env.NODE_ENV === 'production';

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Variable d'environnement manquante: ${name}`);
  return v;
}

export function testDatabaseUrl(base) {
  if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;
  const u = new URL(base);
  if (!u.pathname.endsWith('_test')) u.pathname = `${u.pathname}_test`;
  return u.toString();
}

const jwtSecret = required('JWT_SECRET', isTest ? 'test-secret-test-secret-test-secret-00' : undefined);
const encKey = required('ENCRYPTION_KEY', isTest ? 'a'.repeat(64) : undefined);
if (jwtSecret.length < 32) throw new Error('JWT_SECRET doit faire au moins 32 caracteres');
if (!/^[0-9a-f]{64}$/i.test(encKey)) throw new Error('ENCRYPTION_KEY doit etre 64 caracteres hexadecimaux (32 octets)');

export const env = Object.freeze({
  isTest,
  isProd,
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '0.0.0.0',
  // Les tests utilisent TOUJOURS une base distincte (<nom>_test, ou DATABASE_URL_TEST) : ils recreent et suppriment des
  // donnees de demonstration, ce qui ne doit jamais toucher la base reelle.
  databaseUrl: isTest ? testDatabaseUrl(required('DATABASE_URL')) : required('DATABASE_URL'),
  jwtSecret,
  encryptionKey: Buffer.from(encKey, 'hex'),
  publicUrl: (process.env.PUBLIC_URL ?? 'http://localhost:4000').replace(/\/$/, ''),
  webUrl: (process.env.WEB_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
  // Limite stricte des routes sensibles (par IP et par minute). Relevee en test pour ne pas se bloquer soi-meme.
  strictRate: Number(process.env.STRICT_RATE_MAX ?? (isTest ? 10_000 : 10)),
  accessTtlSec: 15 * 60,
  refreshTtlSec: 30 * 24 * 3600,
  google: { id: process.env.GOOGLE_CLIENT_ID ?? '', secret: process.env.GOOGLE_CLIENT_SECRET ?? '' },
  github: { id: process.env.GITHUB_CLIENT_ID ?? '', secret: process.env.GITHUB_CLIENT_SECRET ?? '' },
  forgeAppId: process.env.FORGE_APP_ID ?? '',
  // Service d'IA (Kairos Brain) deploye a part. Facultatif : sans lui, les analyses lexicales prennent le relais.
  mlUrl: (process.env.ML_URL ?? '').replace(/\/$/, ''),
  mlApiKey: process.env.ML_API_KEY ?? '',
  seedDemo: (process.env.SEED_DEMO ?? 'false') === 'true',
  // Entree publique « essayer la demo » (session d'AGENT sur l'organisation de demonstration). Desactivee par defaut.
  demoLogin: (process.env.DEMO_LOGIN ?? 'false') === 'true',
});
