import crypto from 'node:crypto';
import { z } from 'zod';
import { many, one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { encrypt, randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { detectLang, frustration, minhash, redactPII, sentiment, shortHash } from '../lib/text.js';
import { loadRules, runRules } from './rules.js';
import { emit } from './webhooks.js';

const STATUS = ['open', 'pending', 'resolved', 'closed'];
const PRIORITY = ['low', 'medium', 'high', 'critical'];

// ---------------- Helpers metier ----------------
/** Choisit un agent selon une strategie : uuid | least_loaded | skill:<x> | lang_match. */
export async function pickAssignee(db, orgId, ticket, strategy = 'least_loaded') {
  if (/^[0-9a-f-]{36}$/i.test(strategy)) {
    const ok = await db.one('SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2', [orgId, strategy]);
    return ok ? strategy : null;
  }
  const agents = await db.many(
    `SELECT m.user_id, m.skills, m.languages,
            (SELECT count(*) FROM tickets t WHERE t.assignee_id=m.user_id AND t.org_id=m.org_id AND t.status IN ('open','pending'))::int AS load
       FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.org_id=$1 AND m.role IN ('agent','admin','owner') AND u.disabled=false`,
    [orgId],
  );
  let pool = agents;
  if (strategy.startsWith('skill:')) {
    const skill = strategy.slice(6).toLowerCase();
    const s = agents.filter((a) => a.skills.map((x) => x.toLowerCase()).includes(skill));
    if (s.length) pool = s;
  } else if (strategy === 'lang_match') {
    const l = agents.filter((a) => a.languages.includes(ticket.lang));
    if (l.length) pool = l;
  }
  return pool.sort((a, b) => a.load - b.load)[0]?.user_id ?? null;
}

async function vaultTokenizer(db, orgId, ticketId) {
  const pending = [];
  const tokenFor = (kind, value) => {
    const token = `<${kind.toUpperCase()}_${shortHash(`${orgId}|${value}`)}>`;
    pending.push({ token, kind, value });
    return token;
  };
  const flush = async () => {
    for (const p of pending) {
      await db.query(
        'INSERT INTO pii_vault(org_id, token, ticket_id, kind, value_enc) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [orgId, p.token, ticketId, p.kind, encrypt(p.value)],
      );
    }
  };
  return { tokenFor, flush };
}

const shouldShield = async (orgId) => {
  const o = await one('SELECT settings FROM orgs WHERE id=$1', [orgId]);
  return o?.settings?.piiShield !== false; // actif par defaut
};

async function logEvent(db, ticketId, type, actor, data = {}) {
  await db.query('INSERT INTO ticket_events(ticket_id, type, actor, data) VALUES ($1,$2,$3,$4)', [ticketId, type, actor ?? null, JSON.stringify(data)]);
}

// ---------------- Creation ----------------
export async function createTicket(orgId, input, actor = null) {
  const rules = await loadRules(orgId);
  const shield = await shouldShield(orgId);
  const id = crypto.randomUUID();
  const created = await tx(async (db) => {
    let customer = null;
    if (input.customerEmail) {
      customer = await db.one(
        // Le nom n'est ecrase que s'il est fourni explicitement : jamais par un nom devine depuis l'email.
        `INSERT INTO customers(org_id, email, name, company) VALUES ($1::uuid, $2::citext, coalesce($3::text, split_part($2::text,'@',1)), $4::text)
         ON CONFLICT (org_id, email) DO UPDATE SET name = coalesce($3::text, customers.name), company = coalesce($4::text, customers.company) RETURNING *`,
        [orgId, input.customerEmail.toLowerCase(), input.customerName ?? null, input.company ?? null],
      );
    }
    let title = input.title, body = input.body ?? '', redacted = false, flushVault = null;
    if (shield) {
      const v = await vaultTokenizer(db, orgId, id);
      const t = redactPII(title, v.tokenFor), b = redactPII(body, v.tokenFor);
      title = t.text; body = b.text; redacted = t.findings.length + b.findings.length > 0;
      flushVault = v.flush; // le coffre reference le ticket : on l'ecrit apres l'insertion (cle etrangere)
    }
    const text = `${title}\n${body}`;
    const lang = input.lang ?? detectLang(text);
    const sent = sentiment(text), frus = frustration(text);
    const ctx = { title, body, priority: input.priority ?? 'medium', status: 'open', channel: input.channel ?? 'portal', lang,
      component: input.component ?? null, tags: input.tags ?? [], sentiment: sent, frustration: frus, customer, reopened_count: 0, at: new Date() };
    const { patch, fired, notify } = runRules(rules, ctx);

    const org = await db.one('UPDATE orgs SET ticket_seq = ticket_seq + 1 WHERE id=$1 RETURNING ticket_seq, settings, slug', [orgId]);
    const prefix = (org.settings?.keyPrefix ?? org.slug.replace(/[^a-z]/g, '').slice(0, 3)).toUpperCase().padEnd(3, 'X');
    const ticket = await db.one(
      `INSERT INTO tickets(id, org_id, seq, key, customer_id, title, body, status, priority, channel, lang, tags, component,
                           sentiment, frustration, minhash, jira_issue_key, pii_redacted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [id, orgId, org.ticket_seq, `${prefix}-${org.ticket_seq}`, customer?.id ?? null, title, body, patch.status ?? 'open',
        patch.priority ?? ctx.priority, ctx.channel, lang, patch.tags ?? ctx.tags, ctx.component, sent, frus, minhash(text),
        input.jiraIssueKey ?? null, redacted],
    );
    if (flushVault) await flushVault();
    if (patch.assign) {
      const who = await pickAssignee(db, orgId, ticket, patch.assign);
      if (who) { await db.query('UPDATE tickets SET assignee_id=$2 WHERE id=$1', [id, who]); ticket.assignee_id = who; }
    }
    await logEvent(db, id, 'created', actor, { channel: ctx.channel, rules: fired.map((f) => f.name) });
    for (const f of fired) await db.query('UPDATE rules SET hits = hits + 1 WHERE id=$1', [f.id]);
    return { ticket, notify, fired };
  });
  await emit(orgId, 'ticket.created', { id, key: created.ticket.key, priority: created.ticket.priority });
  for (const n of created.notify) await emit(orgId, n, { id, key: created.ticket.key });
  return { ...created.ticket, rulesFired: created.fired.map((f) => f.name) };
}

// ---------------- Commentaires ----------------
export async function addComment(orgId, ticketId, { body, internal = false, authorUserId = null, authorIsCustomer = false }) {
  const t = await one('SELECT * FROM tickets WHERE id=$1 AND org_id=$2', [ticketId, orgId]);
  if (!t) throw notFound('Ticket introuvable');
  const shield = await shouldShield(orgId);
  return tx(async (db) => {
    let text = body;
    if (shield && !internal) {
      const v = await vaultTokenizer(db, orgId, ticketId);
      text = redactPII(body, v.tokenFor).text;
      await v.flush();
    }
    const s = sentiment(text);
    const c = await db.one(
      `INSERT INTO ticket_comments(ticket_id, author_user_id, author_is_customer, internal, body, sentiment)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [ticketId, authorUserId, authorIsCustomer, internal, text, s],
    );
    const patch = [];
    // Premiere reponse publique d'un agent => horodatage SLA.
    if (!authorIsCustomer && !internal && !t.first_response_at) patch.push('first_response_at = now()');
    // Un client qui repond sur un ticket resolu le rouvre (signal de regression).
    let reopened = false;
    if (authorIsCustomer && ['resolved', 'closed'].includes(t.status)) { patch.push("status='open'", 'reopened_count = reopened_count + 1', 'resolved_at = NULL'); reopened = true; }
    if (authorIsCustomer) {
      // La frustration du ticket suit la derniere parole du client, lissee.
      patch.push(`frustration = least(1, greatest(0, 0.6 * ${frustration(text)} + 0.4 * frustration))`, `sentiment = 0.6 * ${s} + 0.4 * sentiment`);
    }
    if (patch.length) await db.query(`UPDATE tickets SET ${patch.join(', ')} WHERE id=$1`, [ticketId]);
    await logEvent(db, ticketId, reopened ? 'reopened' : internal ? 'internal_note' : 'comment', authorUserId, { customer: authorIsCustomer });
    if (reopened) await emit(orgId, 'ticket.reopened', { id: ticketId, key: t.key });
    return c;
  });
}

// ---------------- Mise a jour ----------------
export async function updateTicket(orgId, ticketId, patch, actor) {
  const t = await one('SELECT * FROM tickets WHERE id=$1 AND org_id=$2', [ticketId, orgId]);
  if (!t) throw notFound('Ticket introuvable');
  const sets = [], vals = [ticketId];
  const add = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  for (const k of ['title', 'priority', 'component', 'tags']) if (k in patch) add(k, patch[k]);
  if ('assigneeId' in patch) {
    if (patch.assigneeId) {
      const ok = await one('SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2', [orgId, patch.assigneeId]);
      if (!ok) throw badRequest('Assigne hors organisation');
    }
    add('assignee_id', patch.assigneeId);
  }
  let reopened = false;
  if (patch.status && patch.status !== t.status) {
    add('status', patch.status);
    if (patch.status === 'resolved') sets.push('resolved_at = now()');
    if (['resolved', 'closed'].includes(t.status) && ['open', 'pending'].includes(patch.status)) { sets.push('resolved_at = NULL', 'reopened_count = reopened_count + 1'); reopened = true; }
  }
  if (!sets.length) return t;
  const updated = await tx(async (db) => {
    const u = await db.one(`UPDATE tickets SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) await logEvent(db, ticketId, `${k === 'status' ? 'status_changed' : 'updated'}`, actor, { field: k, from: t[k === 'assigneeId' ? 'assignee_id' : k], to: v });
    return u;
  });
  await emit(orgId, reopened ? 'ticket.reopened' : 'ticket.updated', { id: ticketId, key: t.key, changes: Object.keys(patch) });
  if (patch.status === 'resolved') await emit(orgId, 'ticket.resolved', { id: ticketId, key: t.key });
  return updated;
}

// ---------------- Routes ----------------
const createSchema = z.object({
  title: z.string().trim().min(3).max(300), body: z.string().max(20000).default(''),
  priority: z.enum(PRIORITY).optional(), channel: z.string().max(30).optional(), component: z.string().max(60).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(), lang: z.string().length(2).optional(),
  customerEmail: z.string().email().optional(), customerName: z.string().max(100).optional(), company: z.string().max(100).optional(),
  jiraIssueKey: z.string().max(30).optional(),
});

export default async function ticketRoutes(app) {
  app.get('/tickets', { preHandler: app.guard('viewer') }, async (req) => {
    const q = z.object({
      status: z.enum(STATUS).optional(), priority: z.enum(PRIORITY).optional(), assignee: z.string().optional(),
      component: z.string().optional(), tag: z.string().optional(), customer: z.string().uuid().optional(),
      q: z.string().max(200).optional(), minFrustration: z.coerce.number().min(0).max(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).default(0),
      sort: z.enum(['newest', 'oldest', 'frustration', 'priority']).default('newest'),
    }).parse(req.query);
    const where = ['t.org_id=$1'], vals = [req.auth.orgId];
    const f = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
    if (q.status) f('t.status=?', q.status);
    if (q.priority) f('t.priority=?', q.priority);
    if (q.assignee === 'me') f('t.assignee_id=?', req.auth.userId);
    else if (q.assignee === 'none') where.push('t.assignee_id IS NULL');
    else if (q.assignee) f('t.assignee_id=?', q.assignee);
    if (q.component) f('t.component=?', q.component);
    if (q.tag) f('? = ANY(t.tags)', q.tag);
    if (q.customer) f('t.customer_id=?', q.customer);
    if (q.minFrustration !== undefined) f('t.frustration >= ?', q.minFrustration);
    if (q.q) {
      vals.push(q.q);
      const i = vals.length;
      where.push(`(t.search @@ websearch_to_tsquery('simple', $${i}) OR t.title % $${i} OR t.key ILIKE $${i} || '%')`);
    }
    const order = { newest: 't.created_at DESC', oldest: 't.created_at ASC', frustration: 't.frustration DESC, t.created_at DESC',
      priority: `array_position(ARRAY['critical','high','medium','low'], t.priority), t.created_at DESC` }[q.sort];
    vals.push(q.limit, q.offset);
    const rows = await many(
      `SELECT t.id, t.key, t.title, t.status, t.priority, t.channel, t.lang, t.tags, t.component, t.sentiment, t.frustration,
              t.reopened_count, t.assignee_id, t.created_at, t.updated_at, c.name AS customer_name, c.tier AS customer_tier,
              u.display_name AS assignee_name, count(*) OVER()::int AS total
         FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN users u ON u.id=t.assignee_id
        WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals,
    );
    return { total: rows[0]?.total ?? 0, tickets: rows.map(({ total, ...r }) => r) };
  });

  app.post('/tickets', { preHandler: app.guard('agent') }, async (req, reply) => {
    const t = await createTicket(req.auth.orgId, createSchema.parse(req.body), req.auth.userId);
    reply.code(201);
    return t;
  });

  app.get('/tickets/:id', { preHandler: app.guard('viewer') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = await one(
      `SELECT t.*, c.name AS customer_name, c.email AS customer_email, c.tier AS customer_tier, c.company AS customer_company,
              u.display_name AS assignee_name
         FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN users u ON u.id=t.assignee_id
        WHERE t.id=$1 AND t.org_id=$2`,
      [id, req.auth.orgId],
    );
    if (!t) throw notFound('Ticket introuvable');
    const showInternal = req.auth.role !== 'viewer';
    const [comments, kb, events] = await Promise.all([
      many(`SELECT c.*, u.display_name AS author_name FROM ticket_comments c LEFT JOIN users u ON u.id=c.author_user_id
             WHERE c.ticket_id=$1 AND ($2 OR c.internal=false) ORDER BY c.created_at`, [id, showInternal]),
      many(`SELECT a.id, a.title, a.url, l.relation, l.score FROM ticket_kb_links l JOIN kb_articles a ON a.id=l.article_id WHERE l.ticket_id=$1`, [id]),
      many('SELECT type, actor, data, created_at FROM ticket_events WHERE ticket_id=$1 ORDER BY id', [id]),
    ]);
    const { minhash: _m, search: _s, ...ticket } = t;
    return { ...ticket, comments, kb, events };
  });

  app.patch('/tickets/:id', { preHandler: app.guard('agent') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({
      title: z.string().trim().min(3).max(300).optional(), status: z.enum(STATUS).optional(), priority: z.enum(PRIORITY).optional(),
      assigneeId: z.string().uuid().nullable().optional(), component: z.string().max(60).nullable().optional(),
      tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    }).parse(req.body);
    return updateTicket(req.auth.orgId, id, b, req.auth.userId);
  });

  app.post('/tickets/:id/comments', { preHandler: app.guard('agent') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ body: z.string().trim().min(1).max(10000), internal: z.boolean().default(false) }).parse(req.body);
    const c = await addComment(req.auth.orgId, id, { ...b, authorUserId: req.auth.userId });
    reply.code(201);
    return c;
  });

  app.post('/tickets/bulk', { preHandler: app.guard('agent') }, async (req) => {
    const b = z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
      patch: z.object({ status: z.enum(STATUS).optional(), priority: z.enum(PRIORITY).optional(), assigneeId: z.string().uuid().nullable().optional() }),
    }).parse(req.body);
    let ok = 0;
    for (const id of b.ids) { await updateTicket(req.auth.orgId, id, b.patch, req.auth.userId); ok++; }
    await audit(req.auth.orgId, req.auth.userId, 'ticket.bulk_update', 'ticket', null, { count: ok, patch: b.patch });
    return { updated: ok };
  });

  app.delete('/tickets/:id', { preHandler: app.guard('admin') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await query('DELETE FROM tickets WHERE id=$1 AND org_id=$2', [id, req.auth.orgId]);
    if (!r.rowCount) throw notFound();
    await audit(req.auth.orgId, req.auth.userId, 'ticket.deleted', 'ticket', id);
    return { ok: true };
  });

  // Lien de suivi public : jeton opaque (hache en base), expiration, revocable.
  app.post('/tickets/:id/share', { preHandler: app.guard('agent') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { days } = z.object({ days: z.number().int().min(1).max(60).default(14) }).parse(req.body ?? {});
    const t = await one('SELECT 1 FROM tickets WHERE id=$1 AND org_id=$2', [id, req.auth.orgId]);
    if (!t) throw notFound();
    const token = randomToken(24);
    await query(`INSERT INTO share_links(ticket_id, token_hash, expires_at) VALUES ($1,$2, now() + make_interval(days => $3))`, [id, sha256(token), days]);
    reply.code(201);
    return { token, path: `/api/v1/public/track/${token}`, expiresInDays: days };
  });

  app.get('/tickets.csv', { preHandler: app.guard('agent') }, async (req, reply) => {
    const rows = await many(
      `SELECT t.key, t.title, t.status, t.priority, t.component, t.created_at, t.resolved_at, c.name AS customer
         FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id WHERE t.org_id=$1 ORDER BY t.created_at DESC LIMIT 10000`,
      [req.auth.orgId],
    );
    // Protection contre l'injection de formules (CSV injection) : prefixe les cellules dangereuses.
    const esc = (v) => {
      let s = v instanceof Date ? v.toISOString() : String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const head = 'key,title,status,priority,component,created_at,resolved_at,customer';
    const csv = [head, ...rows.map((r) => [r.key, r.title, r.status, r.priority, r.component, r.created_at, r.resolved_at, r.customer].map(esc).join(','))].join('\n');
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="tickets.csv"');
    return csv;
  });
}
