// Point d'entrée Vercel (fonction serverless) : l'application Fastify est construite une fois par instance puis réutilisée.
import { waitUntil } from '@vercel/functions';
import { buildApp } from '../src/app.js';
import { deliverDue } from '../src/modules/webhooks.js';
import { mlCall, mlConfigured, resetMlBreaker } from '../src/lib/ml.js';

let ready;
let lastWarm = 0;
function getApp() {
  ready ??= (async () => {
    const app = await buildApp();
    // Pas de processus permanent en serverless : les webhooks sortants partent juste après chaque écriture,
    // et une tâche planifiée (voir vercel.json) rattrape les relances.
    app.addHook('onResponse', async (req) => {
      if (req.method !== 'GET' && req.method !== 'OPTIONS') waitUntil(deliverDue(10, app.log).catch(() => {}));
    });
    // Le service d'IA s'éteint sans trafic (hébergement serverless gratuit) : on le réveille dès qu'une session s'ouvre,
    // pour qu'il soit prêt quand le copilote est utilisé. Jamais bloquant pour la réponse.
    app.addHook('onResponse', async (req) => {
      if (!mlConfigured() || req.method !== 'GET' || !req.url.startsWith('/api/v1/auth/me') || Date.now() - lastWarm < 4 * 60_000) return;
      lastWarm = Date.now();
      resetMlBreaker();
      waitUntil(mlCall('/health', undefined, { timeoutMs: 60_000 }).catch(() => {}));
    });
    // Appelé à l'ouverture du copilote : réveille le service d'IA (≈ 30 s à froid) pendant que l'agent rédige sa question.
    app.post('/api/v1/ml/warm', { preHandler: app.guard('viewer') }, async () => {
      if (!mlConfigured()) return { warming: false };
      resetMlBreaker();
      waitUntil(mlCall('/health', undefined, { timeoutMs: 60_000 }).catch(() => {}));
      return { warming: true };
    });
    app.get('/internal/cron', async (req, reply) => {
      const secret = process.env.CRON_SECRET;
      if (!secret || req.headers.authorization !== `Bearer ${secret}`) return reply.status(401).send({ error: 'unauthorized' });
      return { delivered: await deliverDue(50, app.log) };
    });
    await app.ready();
    return app;
  })().catch((e) => { ready = undefined; throw e; });
  return ready;
}

export default async function handler(req, res) {
  const app = await getApp();
  app.server.emit('request', req, res);
}
