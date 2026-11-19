import dns from 'node:dns/promises';
import net from 'node:net';
import { z } from 'zod';
import { env } from '../config/env.js';
import { many, one, query } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt, hmac, randomToken } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';

// ---------------- Garde SSRF ----------------
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('::ffff:');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Refuse les cibles internes (metadata cloud 169.254.169.254, localhost, reseaux prives...). */
export async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw badRequest('URL invalide'); }
  if (!['https:', 'http:'].includes(u.protocol)) throw badRequest('Protocole non autorise');
  if (env.isProd && u.protocol !== 'https:') throw badRequest('HTTPS obligatoire');
  if (u.username || u.password) throw badRequest('Identifiants dans l\'URL interdits');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw badRequest('Hote introuvable');
  if (addrs.some((a) => isPrivateIp(a.address))) throw badRequest('Cible interne interdite (SSRF)');
  return u;
}

export const signPayload = (secret, ts, body) => `t=${ts},v1=${hmac(secret, `${ts}.${body}`)}`;

/** Verification cote recepteur : signature valide ET horodatage < 5 min (anti-rejeu). */
export function verifySignature(secret, header, body, toleranceSec = 300, now = Date.now()) {
  const m = String(header ?? '').match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  if (!m) return false;
  if (Math.abs(now / 1000 - Number(m[1])) > toleranceSec) return false;
  return hmac(secret, `${m[1]}.${body}`) === m[2];
}

/** File un evenement pour chaque webhook abonne de l'organisation. */
export async function emit(orgId, event, payload) {
  const hooks = await many('SELECT id FROM webhooks WHERE org_id=$1 AND active=true AND ($2 = ANY(events) OR \'*\' = ANY(events))', [orgId, event]);
  for (const h of hooks) {
    await query('INSERT INTO webhook_deliveries(webhook_id, event, payload) VALUES ($1,$2,$3)', [h.id, event, JSON.stringify({ event, orgId, at: new Date().toISOString(), data: payload })]);
  }
}

const BACKOFF_SEC = [30, 120, 600, 3600, 6 * 3600];

export async function deliverDue(limit = 20, log = console) {
  const due = await many(
    `SELECT d.*, w.url, w.secret_enc FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id
      WHERE d.status='pending' AND d.next_attempt_at <= now() AND w.active=true
      ORDER BY d.next_attempt_at LIMIT $1 FOR UPDATE OF d SKIP LOCKED`,
    [limit],
  ).catch(() => []);
  for (const d of due) {
    try {
      await assertPublicUrl(d.url);
      const body = JSON.stringify(d.payload);
      const ts = Math.floor(Date.now() / 1000);
      const res = await fetch(d.url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', 'Kairos-Event': d.event, 'Kairos-Delivery': d.id, 'Kairos-Signature': signPayload(decrypt(d.secret_enc), ts, body) },
        body,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await query(`UPDATE webhook_deliveries SET status='delivered', attempts=attempts+1, last_error=NULL WHERE id=$1`, [d.id]);
    } catch (e) {
      const attempts = d.attempts + 1;
      const dead = attempts > BACKOFF_SEC.length;
      await query(
        `UPDATE webhook_deliveries SET attempts=$2, last_error=$3, status=$4, next_attempt_at = now() + make_interval(secs => $5) WHERE id=$1`,
        [d.id, attempts, String(e.message).slice(0, 300), dead ? 'dead' : 'pending', BACKOFF_SEC[Math.min(attempts - 1, BACKOFF_SEC.length - 1)]],
      );
      log.warn?.(`webhook ${d.id} echec #${attempts}: ${e.message}`);
    }
  }
  return due.length;
}

export function startWebhookWorker(log) {
  const t = setInterval(() => deliverDue(20, log).catch((e) => log.error(e)), 10_000);
  t.unref();
  return () => clearInterval(t);
}

export default async function webhookRoutes(app) {
  app.get('/webhooks', { preHandler: app.guard('admin') }, async (req) => ({
    webhooks: await many('SELECT id, url, events, active, created_at FROM webhooks WHERE org_id=$1 ORDER BY created_at DESC', [req.auth.orgId]),
  }));

  app.post('/webhooks', { preHandler: app.guard('admin') }, async (req, reply) => {
    const b = z.object({ url: z.string().url().max(500), events: z.array(z.string().max(60)).min(1).max(20).default(['*']) }).parse(req.body);
    await assertPublicUrl(b.url);
    const secret = `whsec_${randomToken(24)}`;
    const w = await one(
      'INSERT INTO webhooks(org_id, url, secret_enc, events) VALUES ($1,$2,$3,$4) RETURNING id, url, events, active, created_at',
      [req.auth.orgId, b.url, encrypt(secret), b.events],
    );
    await audit(req.auth.orgId, req.auth.userId, 'webhook.created', 'webhook', w.id, { url: b.url });
    reply.code(201);
    return { ...w, secret }; // montre une seule fois
  });

  app.delete('/webhooks/:id', { preHandler: app.guard('admin') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await query('DELETE FROM webhooks WHERE id=$1 AND org_id=$2', [id, req.auth.orgId]);
    if (!r.rowCount) throw notFound();
    await audit(req.auth.orgId, req.auth.userId, 'webhook.deleted', 'webhook', id);
    return { ok: true };
  });

  app.get('/webhooks/deliveries', { preHandler: app.guard('admin') }, async (req) => {
    const { status } = z.object({ status: z.enum(['pending', 'delivered', 'dead']).optional() }).parse(req.query);
    return {
      deliveries: await many(
        `SELECT d.id, d.event, d.status, d.attempts, d.last_error, d.next_attempt_at, d.created_at, w.url
           FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id
          WHERE w.org_id=$1 AND ($2::text IS NULL OR d.status=$2) ORDER BY d.created_at DESC LIMIT 100`,
        [req.auth.orgId, status ?? null],
      ),
    };
  });

  // File des lettres mortes : rejouer manuellement une livraison abandonnee.
  app.post('/webhooks/deliveries/:id/replay', { preHandler: app.guard('admin') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await query(
      `UPDATE webhook_deliveries d SET status='pending', attempts=0, next_attempt_at=now(), last_error=NULL
         FROM webhooks w WHERE d.id=$1 AND w.id=d.webhook_id AND w.org_id=$2`,
      [id, req.auth.orgId],
    );
    if (!r.rowCount) throw notFound();
    return { ok: true };
  });

  app.post('/webhooks/deliveries/process', { preHandler: app.guard('admin') }, async () => ({ processed: await deliverDue(50) }));
}
