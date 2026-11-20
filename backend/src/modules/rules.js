import { loc, reqLang } from '../lib/lang.js';
import { z } from 'zod';
import { many, one, query } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { normalize } from '../lib/text.js';

// ---------------------------------------------------------------------------
// Policy-as-code : conditions JSON evaluees sans eval ni regex utilisateur (donc pas de ReDoS).
//   { "all": [ {"field":"priority","op":"eq","value":"critical"}, {"not": {...}} ] }
// ---------------------------------------------------------------------------
const FIELDS = ['priority', 'status', 'channel', 'lang', 'component', 'tags', 'title', 'body', 'text',
  'sentiment', 'frustration', 'customer.tier', 'hour', 'weekday', 'reopened_count'];
const OPS = ['eq', 'ne', 'in', 'contains', 'containsAny', 'startsWith', 'gt', 'gte', 'lt', 'lte', 'hasTag'];

const leaf = z.object({
  field: z.enum(FIELDS), op: z.enum(OPS),
  value: z.union([z.string().max(200), z.number(), z.array(z.union([z.string().max(100), z.number()])).max(50)]),
});
export const conditionSchema = z.lazy(() => z.union([
  leaf,
  z.object({ all: z.array(conditionSchema).min(1).max(20) }),
  z.object({ any: z.array(conditionSchema).min(1).max(20) }),
  z.object({ not: conditionSchema }),
]));

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_priority'), value: z.enum(['low', 'medium', 'high', 'critical']) }),
  z.object({ type: z.literal('set_status'), value: z.enum(['open', 'pending', 'resolved', 'closed']) }),
  z.object({ type: z.literal('add_tag'), value: z.string().min(1).max(40) }),
  z.object({ type: z.literal('assign'), value: z.string().min(1).max(60) }), // uuid | least_loaded | skill:<x> | lang_match
  z.object({ type: z.literal('escalate') }),
  z.object({ type: z.literal('notify'), value: z.string().min(1).max(60) }), // nom d'evenement webhook
]);

const MAX_NODES = 200;

function resolveField(field, ctx) {
  if (field === 'text') return `${ctx.title ?? ''} ${ctx.body ?? ''}`;
  if (field === 'customer.tier') return ctx.customer?.tier ?? 'standard';
  if (field === 'hour') return (ctx.at ?? new Date()).getUTCHours();
  if (field === 'weekday') return (ctx.at ?? new Date()).getUTCDay();
  return ctx[field];
}

function evalLeaf({ field, op, value }, ctx) {
  const actual = resolveField(field, ctx);
  const str = (v) => normalize(String(v ?? ''));
  switch (op) {
    case 'eq': return str(actual) === str(value);
    case 'ne': return str(actual) !== str(value);
    case 'in': return Array.isArray(value) && value.map(str).includes(str(actual));
    case 'contains': return str(actual).includes(str(value));
    case 'containsAny': return Array.isArray(value) && value.some((v) => str(actual).includes(str(v)));
    case 'startsWith': return str(actual).startsWith(str(value));
    case 'hasTag': return Array.isArray(actual) && actual.map(str).includes(str(value));
    case 'gt': return Number(actual) > Number(value);
    case 'gte': return Number(actual) >= Number(value);
    case 'lt': return Number(actual) < Number(value);
    case 'lte': return Number(actual) <= Number(value);
    default: return false;
  }
}

export function evaluate(cond, ctx, budget = { n: 0 }) {
  if (++budget.n > MAX_NODES) throw new Error('condition trop complexe');
  if ('all' in cond) return cond.all.every((c) => evaluate(c, ctx, budget));
  if ('any' in cond) return cond.any.some((c) => evaluate(c, ctx, budget));
  if ('not' in cond) return !evaluate(cond.not, ctx, budget);
  return evalLeaf(cond, ctx);
}

const PRIORITY_UP = { low: 'medium', medium: 'high', high: 'critical', critical: 'critical' };

/** Applique les regles actives (ordre de priorite croissante) a un contexte ; renvoie le patch et les journaux. */
export function runRules(rules, ctx) {
  const patch = {};
  const fired = [];
  const tags = new Set(ctx.tags ?? []);
  const notify = [];
  for (const r of [...rules].filter((x) => x.enabled).sort((a, b) => a.priority - b.priority)) {
    let ok = false;
    try { ok = evaluate(r.condition, { ...ctx, ...patch, tags: [...tags] }); } catch { ok = false; }
    if (!ok) continue;
    fired.push({ id: r.id, name: r.name });
    for (const a of r.actions) {
      if (a.type === 'set_priority') patch.priority = a.value;
      else if (a.type === 'set_status') patch.status = a.value;
      else if (a.type === 'add_tag') tags.add(a.value);
      else if (a.type === 'assign') patch.assign = a.value;
      else if (a.type === 'escalate') { patch.priority = PRIORITY_UP[patch.priority ?? ctx.priority ?? 'medium']; tags.add('escalated'); }
      else if (a.type === 'notify') notify.push(a.value);
    }
  }
  if (tags.size) patch.tags = [...tags];
  return { patch, fired, notify };
}

export async function loadRules(orgId) {
  return many('SELECT * FROM rules WHERE org_id=$1 AND enabled=true ORDER BY priority', [orgId]);
}

export default async function rulesRoutes(app) {
  const body = z.object({
    name: z.string().trim().min(1).max(100), enabled: z.boolean().default(true), priority: z.number().int().min(1).max(1000).default(100),
    condition: conditionSchema, actions: z.array(actionSchema).min(1).max(10),
  });

  app.get('/rules', { preHandler: app.guard('agent') }, async (req) => ({
    rules: (await many('SELECT * FROM rules WHERE org_id=$1 ORDER BY priority, created_at', [req.auth.orgId])).map(({ name_i18n, ...r }) => ({ ...r, name: loc(name_i18n, reqLang(req), r.name) })),
    fields: FIELDS, operators: OPS,
  }));

  app.post('/rules', { preHandler: app.guard('admin') }, async (req, reply) => {
    const b = body.parse(req.body);
    const r = await one(
      'INSERT INTO rules(org_id, name, enabled, priority, condition, actions) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.auth.orgId, b.name, b.enabled, b.priority, JSON.stringify(b.condition), JSON.stringify(b.actions)],
    );
    await audit(req.auth.orgId, req.auth.userId, 'rule.created', 'rule', r.id, { name: b.name });
    reply.code(201);
    return r;
  });

  app.put('/rules/:id', { preHandler: app.guard('admin') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = body.parse(req.body);
    const r = await one(
      'UPDATE rules SET name=$3, enabled=$4, priority=$5, condition=$6, actions=$7 WHERE id=$1 AND org_id=$2 RETURNING *',
      [id, req.auth.orgId, b.name, b.enabled, b.priority, JSON.stringify(b.condition), JSON.stringify(b.actions)],
    );
    if (!r) throw notFound();
    await audit(req.auth.orgId, req.auth.userId, 'rule.updated', 'rule', id);
    return r;
  });

  app.delete('/rules/:id', { preHandler: app.guard('admin') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await query('DELETE FROM rules WHERE id=$1 AND org_id=$2', [id, req.auth.orgId]);
    if (!r.rowCount) throw notFound();
    await audit(req.auth.orgId, req.auth.userId, 'rule.deleted', 'rule', id);
    return { ok: true };
  });

  // Dry-run : rejoue une regle candidate sur l'historique SANS rien modifier ("et si cette regle avait existe ?").
  app.post('/rules/simulate', { preHandler: app.guard('agent') }, async (req) => {
    const b = z.object({ condition: conditionSchema, actions: z.array(actionSchema).min(1).max(10), days: z.number().int().min(1).max(365).default(30) }).parse(req.body);
    const rows = await many(
      `SELECT t.*, json_build_object('tier', c.tier) AS customer FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id
        WHERE t.org_id=$1 AND t.created_at > now() - make_interval(days => $2) ORDER BY t.created_at DESC LIMIT 2000`,
      [req.auth.orgId, b.days],
    );
    const candidate = { id: 'candidate', name: 'candidate', enabled: true, priority: 1, condition: b.condition, actions: b.actions };
    const matches = [];
    for (const t of rows) {
      const { patch } = runRules([candidate], { ...t, at: new Date(t.created_at) });
      if (Object.keys(patch).length) matches.push({ id: t.id, key: t.key, title: t.title, wouldChange: patch });
    }
    return { examined: rows.length, matched: matches.length, matchRate: rows.length ? Number((matches.length / rows.length).toFixed(3)) : 0, sample: matches.slice(0, 25) };
  });
}
