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
  if (env.seedDemo) {
    const { seedDemo, resetDemo } = await import('../src/db/seed.js');
    // Jeu de démonstration créé avant les versions multilingues : on le recrée (il ne touche jamais une autre organisation).
    const old = await pool.query("SELECT 1 FROM chat_messages m JOIN chat_channels c ON c.id=m.channel_id JOIN orgs o ON o.id=c.org_id WHERE o.slug='acme' AND m.body_i18n IS NULL LIMIT 1");
    if (old.rowCount) { console.log('démo : recréation avec contenus multilingues'); await resetDemo(); }
    await seedDemo();
  }
  console.log('base prête');
} finally { await pool.end(); }
