// Crée la base de test (<nom>_test) si elle n'existe pas. Lancé avant `npm test` : les tests ne touchent jamais la vraie base.
import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
for (const f of [join(root, '.env'), join(root, '..', '.env')]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined && m[2] !== '') process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const base = process.env.DATABASE_URL;
if (!base) { console.error('DATABASE_URL manquante'); process.exit(1); }
const target = process.env.DATABASE_URL_TEST ? new URL(process.env.DATABASE_URL_TEST) : (() => { const u = new URL(base); if (!u.pathname.endsWith('_test')) u.pathname += '_test'; return u; })();
const name = target.pathname.slice(1);
if (!/^[a-z0-9_]+$/i.test(name)) { console.error(`nom de base invalide : ${name}`); process.exit(1); }
const admin = new URL(target); admin.pathname = '/postgres';
const c = new pg.Client({ connectionString: admin.toString() });
await c.connect();
const exists = (await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount;
if (!exists) { await c.query(`CREATE DATABASE "${name}"`); console.log(`base de test créée : ${name}`); } else console.log(`base de test présente : ${name}`);
await c.end();
