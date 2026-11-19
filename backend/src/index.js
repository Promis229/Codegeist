import { buildApp } from './app.js';
import { env } from './config/env.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { startWebhookWorker } from './modules/webhooks.js';

await migrate();
if (env.seedDemo) {
  const { seedDemo } = await import('./db/seed.js');
  await seedDemo();
}
const app = await buildApp();
const stopWorker = startWebhookWorker(app.log);

async function shutdown(sig) {
  app.log.info(`${sig} recu, arret propre`);
  stopWorker();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await app.listen({ port: env.port, host: env.host });
