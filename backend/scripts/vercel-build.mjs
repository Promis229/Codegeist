// Exécuté à chaque déploiement Vercel : applique les migrations (idempotent, verrou consultatif) et, si demandé, le jeu de démonstration.
// Connexion DIRECTE (non poolée) : le verrou consultatif et les transactions de migration ne passent pas par un pooler.
import { mkdirSync, writeFileSync } from 'node:fs';

// Sortie statique minimale exigée par Vercel (l'API elle-même est la fonction /api).
mkdirSync('public', { recursive: true });
writeFileSync('public/robots.txt', 'User-agent: *\nDisallow: /\n');

if (process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED;
const { env } = await import('../src/config/env.js');
const { migrate } = await import('../src/db/migrate.js');
const { pool } = await import('../src/db/pool.js');

try {
  await migrate();
  if (env.seedDemo) { const { seedDemo } = await import('../src/db/seed.js'); await seedDemo(); }
  console.log('base prête');
} finally { await pool.end(); }
