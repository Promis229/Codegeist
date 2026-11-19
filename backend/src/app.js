import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { errorHandler } from './lib/errors.js';
import authPlugin from './auth/plugin.js';
import authRoutes from './auth/routes.js';
import oauthRoutes from './auth/oauth.js';
import { domainRoutes } from './modules/index.js';

export async function buildApp({ logger = !env.isTest } = {}) {
  const app = Fastify({
    logger: logger ? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] } : false,
    bodyLimit: 1_048_576,
    trustProxy: process.env.TRUST_PROXY === 'true',
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: 'not_found', message: 'Route inconnue' }));

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: env.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cors, {
    origin: [env.webUrl, 'http://localhost:5173', 'http://localhost:8080'],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  await app.register(rateLimit, { global: true, max: env.isTest ? 10_000 : 300, timeWindow: '1 minute' });

  if (!env.isProd) {
    await app.register(swagger, {
      openapi: {
        info: { title: 'Kairos API', version: '1.0.0', description: 'Copilote de support contextuel pour Jira Service Management' },
        components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
        security: [{ bearer: [] }],
      },
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  await app.register(authPlugin);

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (req, reply) => {
    try { await pool.query('SELECT 1'); return { status: 'ready' }; }
    catch { return reply.status(503).send({ status: 'db_unavailable' }); }
  });

  await app.register(async (api) => {
    await api.register(authRoutes);
    await api.register(oauthRoutes);
    await api.register(domainRoutes);
  }, { prefix: '/api/v1' });

  return app;
}
