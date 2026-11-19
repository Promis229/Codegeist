// Exécuté à chaque déploiement Vercel : applique les migrations (idempotent, verrou consultatif) et, si demandé, le jeu de démonstration.
import { env } from '../src/config/env.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';

try {
  await migrate();
  if (env.seedDemo) { const { seedDemo } = await import('../src/db/seed.js'); await seedDemo(); }
  console.log('base prête');
} finally { await pool.end(); }
