// Écrit l'export d'entraînement de la démo dans un fichier (même contenu que GET /ml/export, sans lancer de serveur).
//   node scripts/export-demo.mjs ../ml/data/demo-export.json
process.env.NODE_ENV = 'test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const { buildApp } = await import('../src/app.js');
const { DEMO } = await import('../src/db/seed.js');
const { pool } = await import('../src/db/pool.js');
const app = await buildApp({ logger: false });
await app.ready();
const post = (u, token, body) => app.inject({ method: 'POST', url: `/api/v1${u}`, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
const login = (await post('/auth/login', null, { email: DEMO.email, password: DEMO.password })).json();
const r = await app.inject({ method: 'GET', url: '/api/v1/ml/export?limit=5000', headers: { authorization: `Bearer ${login.accessToken}` } });
const out = process.argv[2] ?? 'export.json';
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, r.body);
const j = r.json();
console.log(`${out} : ${j.tickets.length} demandes, ${j.kb.length} articles, ${j.links.length} liens`);
await app.close(); await pool.end();
