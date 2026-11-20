import { z } from 'zod';
import { many, one, query } from '../db/pool.js';
import { hashPassword } from '../auth/password.js';
import { audit, verifyAuditChain } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { sendMail } from '../lib/mailer.js';
import { env } from '../config/env.js';
import { loc, reqLang } from '../lib/lang.js';
import { BM25, detectLang, excerpt } from '../lib/text.js';

const uuid = z.string().uuid();

export async function searchKb(orgId, text, limit = 5) {
  const arts = await many('SELECT id, title, body, url, updated_at, helpful, unhelpful FROM kb_articles WHERE org_id=$1', [orgId]);
  const idx = new BM25(arts.map((a) => ({ id: a.id, text: `${a.title} ${a.title} ${a.body}` })));
  const byId = new Map(arts.map((a) => [a.id, a]));
  const hits = idx.search(text, limit);
  const top = hits[0]?.score || 1;
  return hits.map((h) => ({ ...byId.get(h.id), score: Number((h.score / top).toFixed(3)), rawScore: h.score, matched: h.matched }));
}

export default async function coreRoutes(app) {
  // ---------------- Organisation ----------------
  app.get('/org', { preHandler: app.guard('viewer') }, async (req) =>
    one('SELECT id, name, slug, settings, created_at FROM orgs WHERE id=$1', [req.auth.orgId]));

  app.patch('/org', { preHandler: app.guard('admin') }, async (req) => {
    const b = z.object({
      name: z.string().trim().min(2).max(80).optional(),
      settings: z.object({ piiShield: z.boolean().optional(), keyPrefix: z.string().regex(/^[A-Za-z]{2,5}$/).optional(), portalEnabled: z.boolean().optional() }).optional(),
    }).parse(req.body);
    const o = await one(
      `UPDATE orgs SET name = coalesce($2, name), settings = settings || $3::jsonb WHERE id=$1 RETURNING id, name, slug, settings`,
      [req.auth.orgId, b.name ?? null, JSON.stringify(b.settings ?? {})],
    );
    await audit(req.auth.orgId, req.auth.userId, 'org.updated', 'org', req.auth.orgId, b);
    return o;
  });

  // ---------------- Membres & roles ----------------
  app.get('/members', { preHandler: app.guard('viewer') }, async (req) => ({
    members: await many(
      `SELECT u.id, u.email, u.display_name, u.avatar_url, m.role, m.skills, m.languages, m.timezone, u.totp_enabled,
              (SELECT count(*) FROM tickets t WHERE t.assignee_id=u.id AND t.org_id=m.org_id AND t.status IN ('open','pending'))::int AS open_tickets
         FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 ORDER BY m.created_at`,
      [req.auth.orgId],
    ),
  }));

  app.post('/members', { preHandler: app.guard('admin') }, async (req, reply) => {
    const b = z.object({
      email: z.string().trim().toLowerCase().email(), role: z.enum(['admin', 'agent', 'viewer']).default('agent'),
      displayName: z.string().trim().min(1).max(80).optional(),
    }).parse(req.body);
    let user = await one('SELECT id, email FROM users WHERE email=$1', [b.email]);
    let invited = false;
    if (!user) {
      // Compte sans mot de passe : l'invite le definit via un lien a usage unique (valable 7 jours).
      user = await one('INSERT INTO users(email, password_hash, display_name, email_verified) VALUES ($1,$2,$3,true) RETURNING id, email',
        [b.email, await hashPassword(randomToken(24)), b.displayName ?? b.email.split('@')[0]]);
      const token = randomToken(32);
      await query(`INSERT INTO password_resets(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '7 days')`, [user.id, sha256(token)]);
      await sendMail({ to: b.email, subject: 'Invitation Kairos', text: `${env.webUrl}/reset?token=${token}` });
      invited = true;
    }
    const exists = await one('SELECT 1 FROM memberships WHERE user_id=$1 AND org_id=$2', [user.id, req.auth.orgId]);
    if (exists) throw conflict('Deja membre');
    await query('INSERT INTO memberships(user_id, org_id, role) VALUES ($1,$2,$3)', [user.id, req.auth.orgId, b.role]);
    await audit(req.auth.orgId, req.auth.userId, 'member.added', 'user', user.id, { role: b.role });
    reply.code(201);
    return { id: user.id, email: user.email, role: b.role, invited };
  });

  app.patch('/members/:userId', { preHandler: app.guard('admin') }, async (req) => {
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    const b = z.object({
      role: z.enum(['owner', 'admin', 'agent', 'viewer']).optional(), skills: z.array(z.string().max(40)).max(30).optional(),
      languages: z.array(z.string().length(2)).max(10).optional(), timezone: z.string().max(60).optional(),
    }).parse(req.body);
    const target = await one('SELECT role FROM memberships WHERE user_id=$1 AND org_id=$2', [userId, req.auth.orgId]);
    if (!target) throw notFound('Membre introuvable');
    // Seul un owner peut toucher a un owner ou en creer un (pas d'escalade de privileges).
    if ((target.role === 'owner' || b.role === 'owner') && req.auth.role !== 'owner') throw forbidden('Reserve aux proprietaires');
    if (b.role && target.role === 'owner' && b.role !== 'owner') {
      const owners = await one(`SELECT count(*)::int AS n FROM memberships WHERE org_id=$1 AND role='owner'`, [req.auth.orgId]);
      if (owners.n <= 1) throw badRequest('Il doit rester au moins un proprietaire');
    }
    const m = await one(
      `UPDATE memberships SET role=coalesce($3,role), skills=coalesce($4,skills), languages=coalesce($5,languages), timezone=coalesce($6,timezone)
        WHERE user_id=$1 AND org_id=$2 RETURNING role, skills, languages, timezone`,
      [userId, req.auth.orgId, b.role ?? null, b.skills ?? null, b.languages ?? null, b.timezone ?? null],
    );
    await audit(req.auth.orgId, req.auth.userId, 'member.updated', 'user', userId, b);
    return m;
  });

  app.delete('/members/:userId', { preHandler: app.guard('admin') }, async (req) => {
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    const target = await one('SELECT role FROM memberships WHERE user_id=$1 AND org_id=$2', [userId, req.auth.orgId]);
    if (!target) throw notFound();
    if (target.role === 'owner' && req.auth.role !== 'owner') throw forbidden('Reserve aux proprietaires');
    if (target.role === 'owner') {
      const owners = await one(`SELECT count(*)::int AS n FROM memberships WHERE org_id=$1 AND role='owner'`, [req.auth.orgId]);
      if (owners.n <= 1) throw badRequest('Impossible de retirer le dernier proprietaire');
    }
    await query('DELETE FROM memberships WHERE user_id=$1 AND org_id=$2', [userId, req.auth.orgId]);
    await query('UPDATE tickets SET assignee_id=NULL WHERE assignee_id=$1 AND org_id=$2', [userId, req.auth.orgId]);
    await query('UPDATE api_keys SET revoked_at=now() WHERE user_id=$1 AND org_id=$2 AND revoked_at IS NULL', [userId, req.auth.orgId]);
    await audit(req.auth.orgId, req.auth.userId, 'member.removed', 'user', userId);
    return { ok: true };
  });

  // ---------------- Clients ----------------
  app.get('/customers', { preHandler: app.guard('viewer') }, async (req) => {
    const { q, limit } = z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    return {
      customers: await many(
        `SELECT c.*, count(t.id)::int AS tickets, count(t.id) FILTER (WHERE t.status IN ('open','pending'))::int AS open_tickets,
                round(avg(t.frustration)::numeric, 3) AS avg_frustration
           FROM customers c LEFT JOIN tickets t ON t.customer_id=c.id
          WHERE c.org_id=$1 AND ($2::text IS NULL OR c.name ILIKE '%'||$2||'%' OR c.email::text ILIKE '%'||$2||'%' OR c.company ILIKE '%'||$2||'%')
          GROUP BY c.id ORDER BY c.created_at DESC LIMIT $3`,
        [req.auth.orgId, q ?? null, limit],
      ),
    };
  });

  app.post('/customers', { preHandler: app.guard('agent') }, async (req, reply) => {
    const b = z.object({
      email: z.string().trim().toLowerCase().email(), name: z.string().trim().min(1).max(100),
      company: z.string().max(100).optional(), tier: z.enum(['standard', 'premium', 'enterprise']).default('standard'),
    }).parse(req.body);
    reply.code(201);
    return one('INSERT INTO customers(org_id, email, name, company, tier) VALUES ($1,$2,$3,$4,$5) RETURNING *', [req.auth.orgId, b.email, b.name, b.company ?? null, b.tier]);
  });

  app.patch('/customers/:id', { preHandler: app.guard('agent') }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ name: z.string().max(100).optional(), company: z.string().max(100).optional(), tier: z.enum(['standard', 'premium', 'enterprise']).optional() }).parse(req.body);
    const c = await one('UPDATE customers SET name=coalesce($3,name), company=coalesce($4,company), tier=coalesce($5,tier) WHERE id=$1 AND org_id=$2 RETURNING *',
      [id, req.auth.orgId, b.name ?? null, b.company ?? null, b.tier ?? null]);
    if (!c) throw notFound();
    return c;
  });

  // ---------------- Base de connaissances ----------------
  app.get('/kb', { preHandler: app.guard('viewer') }, async (req) => {
    const { q, lang } = z.object({ q: z.string().max(200).optional(), lang: z.enum(['fr', 'en', 'es', 'de']).optional() }).parse(req.query);
    // La langue d'un article est detectee a la lecture : elle vaut aussi pour les articles ajoutes a la main ou synchronises
    // depuis Confluence. `?lang=` ne garde que les articles dans cette langue (l'interface affiche la sienne par defaut).
    const langOf = (title, text) => detectLang(`${title} ${String(text ?? '').slice(0, 500)}`);
    const keep = (a) => !lang || a.lang === lang;
    if (q) return { articles: (await searchKb(req.auth.orgId, q, 20)).map((a) => ({ id: a.id, title: a.title, url: a.url, score: a.score, excerpt: excerpt(a.body, 200), lang: langOf(a.title, a.body) })).filter(keep) };
    const rows = await many('SELECT id, title, source, url, space, views, helpful, unhelpful, updated_at, last_verified_at, left(body, 500) AS sample FROM kb_articles WHERE org_id=$1 ORDER BY updated_at DESC LIMIT 200', [req.auth.orgId]);
    return { articles: rows.map(({ sample, ...a }) => ({ ...a, lang: langOf(a.title, sample) })).filter(keep) };
  });

  const kbBody = z.object({ title: z.string().trim().min(3).max(200), body: z.string().min(1).max(100000), url: z.string().url().max(500).optional(), space: z.string().max(60).optional(), source: z.enum(['manual', 'confluence', 'generated']).default('manual'), sourceId: z.string().max(100).optional() });

  app.post('/kb', { preHandler: app.guard('agent') }, async (req, reply) => {
    const b = kbBody.parse(req.body);
    reply.code(201);
    return one('INSERT INTO kb_articles(org_id, title, body, url, space, source, source_id, last_verified_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now()) RETURNING *',
      [req.auth.orgId, b.title, b.body, b.url ?? null, b.space ?? null, b.source, b.sourceId ?? null]);
  });

  app.get('/kb/:id', { preHandler: app.guard('viewer') }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const a = await one('UPDATE kb_articles SET views = views + 1 WHERE id=$1 AND org_id=$2 RETURNING *', [id, req.auth.orgId]);
    if (!a) throw notFound();
    return a;
  });

  app.put('/kb/:id', { preHandler: app.guard('agent') }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = kbBody.partial().parse(req.body);
    const a = await one(
      'UPDATE kb_articles SET title=coalesce($3,title), body=coalesce($4,body), url=coalesce($5,url), space=coalesce($6,space), last_verified_at=now() WHERE id=$1 AND org_id=$2 RETURNING *',
      [id, req.auth.orgId, b.title ?? null, b.body ?? null, b.url ?? null, b.space ?? null],
    );
    if (!a) throw notFound();
    return a;
  });

  app.delete('/kb/:id', { preHandler: app.guard('admin') }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await query('DELETE FROM kb_articles WHERE id=$1 AND org_id=$2', [id, req.auth.orgId]);
    if (!r.rowCount) throw notFound();
    return { ok: true };
  });

  app.post('/kb/:id/feedback', { preHandler: app.guard('viewer') }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { helpful } = z.object({ helpful: z.boolean() }).parse(req.body);
    const a = await one(`UPDATE kb_articles SET ${helpful ? 'helpful = helpful + 1' : 'unhelpful = unhelpful + 1'} WHERE id=$1 AND org_id=$2 RETURNING id, helpful, unhelpful`, [id, req.auth.orgId]);
    if (!a) throw notFound();
    return a;
  });

  app.post('/tickets/:id/kb', { preHandler: app.guard('agent') }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ articleId: uuid, relation: z.enum(['suggested', 'cited', 'used']).default('used'), score: z.number().min(0).max(1).default(1) }).parse(req.body);
    const ok = await one('SELECT 1 FROM tickets t, kb_articles a WHERE t.id=$1 AND a.id=$2 AND t.org_id=$3 AND a.org_id=$3', [id, b.articleId, req.auth.orgId]);
    if (!ok) throw notFound();
    await query('INSERT INTO ticket_kb_links(ticket_id, article_id, relation, score) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, b.articleId, b.relation, b.score]);
    return { ok: true };
  });

  // ---------------- SLA ----------------
  app.get('/sla', { preHandler: app.guard('viewer') }, async (req) => ({
    policies: await many('SELECT * FROM sla_policies WHERE org_id=$1 ORDER BY array_position(ARRAY[\'critical\',\'high\',\'medium\',\'low\'], priority)', [req.auth.orgId]),
  }));

  app.put('/sla', { preHandler: app.guard('admin') }, async (req) => {
    const b = z.object({ policies: z.array(z.object({
      name: z.string().max(60), priority: z.enum(['low', 'medium', 'high', 'critical']),
      firstResponseMins: z.number().int().min(1).max(100000), resolveMins: z.number().int().min(1).max(1000000),
    })).min(1).max(4) }).parse(req.body);
    for (const p of b.policies) {
      await query(
        `INSERT INTO sla_policies(org_id, name, priority, first_response_mins, resolve_mins) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (org_id, priority) DO UPDATE SET name=EXCLUDED.name, first_response_mins=EXCLUDED.first_response_mins, resolve_mins=EXCLUDED.resolve_mins`,
        [req.auth.orgId, p.name, p.priority, p.firstResponseMins, p.resolveMins],
      );
    }
    await audit(req.auth.orgId, req.auth.userId, 'sla.updated', 'sla', null, b);
    return { ok: true };
  });

  // ---------------- Deploiements (alimentent la detection de regressions) ----------------
  app.get('/deploys', { preHandler: app.guard('viewer') }, async (req) => ({
    deploys: await many('SELECT * FROM deploys WHERE org_id=$1 ORDER BY deployed_at DESC LIMIT 100', [req.auth.orgId]),
  }));

  app.post('/deploys', { preHandler: app.guard('agent') }, async (req, reply) => {
    const b = z.object({ name: z.string().max(100), version: z.string().max(40).optional(), component: z.string().max(60).optional(), deployedAt: z.string().datetime().optional() }).parse(req.body);
    reply.code(201);
    return one('INSERT INTO deploys(org_id, name, version, component, deployed_at) VALUES ($1,$2,$3,$4, coalesce($5::timestamptz, now())) RETURNING *',
      [req.auth.orgId, b.name, b.version ?? null, b.component ?? null, b.deployedAt ?? null]);
  });

  // ---------------- Audit ----------------
  app.get('/audit', { preHandler: app.guard('admin') }, async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return { entries: await many('SELECT id, actor, action, entity, entity_id, data, hash, created_at FROM audit_log WHERE org_id=$1 ORDER BY id DESC LIMIT $2', [req.auth.orgId, limit]) };
  });
  app.get('/audit/verify', { preHandler: app.guard('admin') }, async (req) => verifyAuditChain(req.auth.orgId));

  // ---------------- Appareils mobiles ----------------
  app.post('/devices', { preHandler: app.guard('viewer') }, async (req, reply) => {
    const b = z.object({ platform: z.enum(['android', 'ios', 'web']), pushToken: z.string().min(10).max(500) }).parse(req.body);
    await query('INSERT INTO devices(user_id, platform, push_token) VALUES ($1,$2,$3) ON CONFLICT (user_id, push_token) DO NOTHING', [req.auth.userId, b.platform, b.pushToken]);
    reply.code(201);
    return { ok: true };
  });

  // ---------------- Recherche globale ----------------
  app.get('/search', { preHandler: app.guard('viewer') }, async (req) => {
    const { q } = z.object({ q: z.string().trim().min(2).max(200) }).parse(req.query);
    // Recherche tolérante : mots entiers (plein texte), mots INCOMPLETS (« factur » trouve « facturation ») et fautes légères (trigrammes).
    const org = req.auth.orgId, uid = req.auth.userId;
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const [tickets, customers, members, channels, messages, kbHits, kbTitles] = await Promise.all([
      many(`SELECT id, key, title, status, priority FROM tickets
             WHERE org_id=$1 AND (search @@ websearch_to_tsquery('simple',$2) OR title % $2 OR key ILIKE $3 OR title ILIKE $3 OR body ILIKE $3)
             ORDER BY (key ILIKE $2 || '%') DESC, (title ILIKE $3) DESC, similarity(title,$2) DESC, created_at DESC LIMIT 8`, [org, q, like]),
      many(`SELECT id, name, email, company FROM customers WHERE org_id=$1 AND (name ILIKE $2 OR email::text ILIKE $2 OR company ILIKE $2) ORDER BY name LIMIT 5`, [org, like]),
      many(`SELECT u.id, u.display_name, u.email FROM memberships m JOIN users u ON u.id=m.user_id
             WHERE m.org_id=$1 AND u.disabled=false AND (u.display_name ILIKE $2 OR u.email::text ILIKE $2) ORDER BY u.display_name LIMIT 5`, [org, like]),
      many(`SELECT id, name FROM chat_channels WHERE org_id=$1 AND kind='channel' AND name ILIKE $2 ORDER BY name LIMIT 5`, [org, like]),
      // Messages : salons de l'organisation + messages directs dont l'utilisateur fait partie (jamais ceux des autres).
      many(`SELECT m.id, m.channel_id, left(m.body, 140) AS body, m.body_i18n, c.kind, c.name, u.display_name AS author
              FROM chat_messages m JOIN chat_channels c ON c.id=m.channel_id LEFT JOIN users u ON u.id=m.author_id
             WHERE c.org_id=$1 AND (c.kind='channel' OR split_part(c.dm_key, ':', 1)=$3 OR split_part(c.dm_key, ':', 2)=$3) AND (m.body ILIKE $2 OR m.body_i18n::text ILIKE $2)
             ORDER BY m.id DESC LIMIT 5`, [org, like, uid]),
      searchKb(org, q, 5),
      many('SELECT id, title FROM kb_articles WHERE org_id=$1 AND (title ILIKE $2 OR body ILIKE $2) ORDER BY updated_at DESC LIMIT 5', [org, like]),
    ]);
    const seen = new Set();
    const kb = [...kbHits.map((a) => ({ id: a.id, title: a.title, score: a.score })), ...kbTitles.map((a) => ({ id: a.id, title: a.title, score: 0.3 }))]
      .filter((a) => !seen.has(a.id) && seen.add(a.id)).slice(0, 6);
    return {
      tickets, customers, kb,
      members: members.map((m) => ({ id: m.id, name: m.display_name, email: m.email })),
      channels,
      messages: messages.map((m) => ({ id: Number(m.id), channelId: m.channel_id, body: loc(m.body_i18n, reqLang(req), m.body), author: m.author, kind: m.kind, channel: m.name })),
    };
  });
}
