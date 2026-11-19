import { z } from 'zod';
import { env } from '../config/env.js';
import { many, one } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { mlCall, mlConfigured, mlOpen, scrub } from '../lib/ml.js';
import { BM25, detectLang, excerpt } from '../lib/text.js';

const uuid = z.string().uuid();

/** Journalise une prediction servie (pour mesurer sa justesse reelle une fois la demande traitee). */
export async function logPrediction(orgId, ticketId, task, predicted, confidence, fingerprint) {
  if (!ticketId || !predicted) return;
  const t = await one('SELECT 1 AS ok FROM tickets WHERE id=$1 AND org_id=$2', [ticketId, orgId]);
  if (!t) return;
  await one('INSERT INTO ml_predictions(org_id, ticket_id, task, predicted, confidence, model_fingerprint) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [orgId, ticketId, task, String(predicted), confidence ?? 0, fingerprint ?? null]);
}

const verdict = (s) => (s >= 0.75 ? 'duplicate' : s >= 0.6 ? 'probable' : 'related');

/**
 * Pont avec le service d'IA « Kairos Brain » :
 *   GET  /ml/export                       jeu d'entrainement (admin, donnees personnelles masquees, journalise)
 *   GET  /ml/status                       disponibilite et fiche du modele
 *   POST /intel/semantic/search           recherche semantique multilingue (repli lexical si le service est indisponible)
 *   GET  /intel/tickets/:id/semantic-similar   demandes proches, y compris dans une autre langue
 *   GET  /intel/tickets/:id/risk          delai de resolution (quantiles), risque de reouverture et de depassement de SLA
 */
export default async function mlRoutes(app) {
  const agent = { preHandler: app.guard('agent') };

  // ---------------------------------------------------------------- export d'entrainement
  app.get('/ml/export', { preHandler: app.guard('admin'), config: { rateLimit: { max: Math.max(3, Math.floor(env.strictRate / 2)), timeWindow: '1 minute' } } }, async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(10).max(20000).default(5000) }).parse(req.query);
    const tickets = await many(
      `SELECT t.id, t.key, t.title, t.body, t.lang, t.component, t.priority, t.channel, t.status, t.created_at, t.frustration, t.sentiment, t.reopened_count, c.tier,
              EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))/3600 AS resolution_hours,
              EXTRACT(EPOCH FROM (t.first_response_at - t.created_at))/60 AS first_response_minutes,
              (SELECT count(*) FROM ticket_comments x WHERE x.ticket_id=t.id AND x.author_is_customer)::int AS customer_messages
         FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id WHERE t.org_id=$1 ORDER BY t.created_at DESC LIMIT $2`, [req.auth.orgId, limit]);
    const kb = await many('SELECT id, title, body, updated_at FROM kb_articles WHERE org_id=$1', [req.auth.orgId]);
    const links = await many(`SELECT l.ticket_id, l.article_id, l.relation FROM ticket_kb_links l JOIN tickets t ON t.id=l.ticket_id WHERE t.org_id=$1`, [req.auth.orgId]);
    await audit(req.auth.orgId, req.auth.userId, 'ml.export', 'org', req.auth.orgId, { tickets: tickets.length, kb: kb.length });
    return {
      schema: 1, generatedAt: new Date().toISOString(), pii: 'masked',
      tickets: tickets.map((t) => ({ ...t, title: scrub(t.title), body: scrub(t.body), reopened: t.reopened_count > 0 })),
      kb: kb.map((a) => ({ ...a, title: scrub(a.title), body: scrub(a.body) })),
      links,
    };
  });

  // ---------------------------------------------------------------- suivi en production
  // Chaque prediction servie est journalisee ; une fois la demande traitee, on la compare a la decision finale des agents.
  app.get('/ml/monitoring', { preHandler: app.guard('admin') }, async (req) => {
    const rows = await many(
      `SELECT p.task, p.predicted, p.confidence, p.created_at, t.priority, t.component, t.status
         FROM ml_predictions p JOIN tickets t ON t.id=p.ticket_id WHERE p.org_id=$1 AND p.created_at > now() - interval '90 days'`, [req.auth.orgId]);
    const tasks = {};
    for (const task of ['priority', 'component']) {
      const done = rows.filter((r) => r.task === task && ['resolved', 'closed'].includes(r.status));
      const hit = (r) => r.predicted === (task === 'priority' ? r.priority : r.component);
      const acc = done.length ? done.filter(hit).length / done.length : null;
      const bins = [[0, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 1.01]].map(([lo, hi]) => {
        const b = done.filter((r) => r.confidence >= lo && r.confidence < hi);
        return { from: lo, to: Math.min(hi, 1), n: b.length, meanConfidence: b.length ? Math.round((b.reduce((s, r) => s + r.confidence, 0) / b.length) * 1000) / 1000 : null, accuracy: b.length ? Math.round((b.filter(hit).length / b.length) * 1000) / 1000 : null };
      });
      tasks[task] = { predictions: rows.filter((r) => r.task === task).length, evaluated: done.length, accuracy: acc == null ? null : Math.round(acc * 1000) / 1000, calibration: bins,
        status: done.length < 30 ? 'insufficient_data' : acc < 0.6 ? 'degraded' : 'healthy' };
    }
    const degraded = Object.values(tasks).some((t) => t.status === 'degraded');
    return { windowDays: 90, tasks, advice: degraded ? 'retrain' : null };
  });

  // ---------------------------------------------------------------- statut
  app.get('/ml/status', { preHandler: app.guard('viewer') }, async () => {
    if (!mlConfigured()) return { configured: false, available: false };
    const model = await mlCall('/v1/model', undefined, { timeoutMs: 1500 });
    return { configured: true, available: !!model, circuitOpen: mlOpen(), model: model ?? null };
  });

  // ---------------------------------------------------------------- recherche semantique
  const candidatesOf = async (orgId, scope, excludeId = null) => {
    const out = [];
    if (scope !== 'kb') {
      for (const t of await many(`SELECT id, key, title, body, lang FROM tickets WHERE org_id=$1 AND ($2::uuid IS NULL OR id<>$2) ORDER BY created_at DESC LIMIT 400`, [orgId, excludeId]))
        out.push({ type: 'ticket', id: t.id, label: t.key, title: t.title, text: `${t.title}. ${t.body}`.slice(0, 700), lang: t.lang });
    }
    if (scope !== 'tickets') {
      for (const a of await many('SELECT id, title, body FROM kb_articles WHERE org_id=$1 LIMIT 300', [orgId]))
        out.push({ type: 'kb', id: a.id, label: a.title, title: a.title, text: `${a.title}. ${a.body}`.slice(0, 900), lang: detectLang(`${a.title} ${a.body}`) });
    }
    return out;
  };

  /** Classe les candidats : semantique si le service repond, sinon BM25. Toujours la meme forme de sortie. */
  async function rank(query, cands, limit, queryLang) {
    const q = scrub(query);
    const sem = await mlCall('/v1/search', { query: q, top_k: limit, candidates: cands.map((c) => ({ id: c.id, text: scrub(c.text), lang: c.lang })) });
    if (sem?.results) {
      const byId = new Map(cands.map((c) => [c.id, c]));
      return { engine: 'semantic', model: sem.model ?? null, results: sem.results.filter((r) => byId.has(r.id)).map((r) => { const c = byId.get(r.id); return { type: c.type, id: c.id, label: c.label, title: c.title, lang: c.lang, score: Math.round(r.score * 1000) / 1000, crossLingual: !!queryLang && !!c.lang && c.lang !== queryLang }; }) };
    }
    const idx = new BM25(cands.map((c) => ({ id: c.id, text: c.text })));
    const byId = new Map(cands.map((c) => [c.id, c]));
    const top = idx.search(q, limit).filter((h) => h.score > 0);
    const max = top[0]?.score || 1;
    return { engine: 'lexical', model: null, results: top.map((h) => { const c = byId.get(h.id); return { type: c.type, id: c.id, label: c.label, title: c.title, lang: c.lang, score: Math.round((h.score / max) * 1000) / 1000, crossLingual: false }; }) };
  }

  /**
   * Recherche multilingue SANS modele d'embedding a heberger : l'appelant (l'agent Rovo, dont le LLM est heberge par Atlassian)
   * fournit la meme question traduite (`variants`). On cherche avec chaque version puis on fusionne les classements par
   * « Reciprocal Rank Fusion » : un resultat bien classe dans n'importe quelle langue remonte. Si le service d'IA est branche,
   * chaque version passe en plus par la recherche semantique.
   */
  const RRF_K = 60;
  async function rankMany(queries, cands, limit, mainLang) {
    const per = queries.length === 1 ? limit : Math.max(limit * 2, 10); // plus de candidats par version avant fusion
    const runs = await Promise.all(queries.map((q) => rank(q, cands, per, mainLang)));
    if (runs.length === 1) return runs[0];
    const fused = new Map();
    for (const run of runs) run.results.forEach((r, i) => {
      const f = fused.get(r.id) ?? { ...r, rrf: 0, hits: 0 };
      f.rrf += 1 / (RRF_K + i + 1); f.hits += 1;
      fused.set(r.id, f);
    });
    const best = 1 / (RRF_K + 1) * runs.length; // score maximal possible : premier dans toutes les versions
    // Les demandes au titre identique (doublons exacts) sont regroupees : sinon une douzaine de copies dans la langue de la
    // question masquent les autres langues, qui sont justement ce que la recherche multilingue doit faire remonter.
    const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const groups = new Map();
    for (const r of [...fused.values()].sort((a, b) => b.rrf - a.rrf)) {
      const g = groups.get(norm(r.title));
      if (g) g.identical += 1; else groups.set(norm(r.title), { ...r, identical: 0 });
    }
    const results = [...groups.values()].slice(0, limit)
      .map(({ rrf, hits, identical, ...r }) => ({ ...r, score: Math.round((rrf / best) * 1000) / 1000, matchedVariants: hits, identicalCount: identical, crossLingual: !!mainLang && !!r.lang && r.lang !== mainLang }));
    return { engine: runs.some((r) => r.engine === 'semantic') ? 'semantic+fusion' : 'lexical+fusion', model: runs[0].model, results };
  }

  app.post('/intel/semantic/search', agent, async (req) => {
    const { query, variants, scope, limit } = z.object({
      query: z.string().trim().min(3).max(1000),
      variants: z.array(z.string().trim().min(3).max(1000)).max(4).default([]),
      scope: z.enum(['tickets', 'kb', 'all']).default('all'),
      limit: z.coerce.number().int().min(1).max(20).default(8),
    }).parse(req.body);
    const queries = [...new Set([query, ...variants])];
    const cands = await candidatesOf(req.auth.orgId, scope);
    const r = await rankMany(queries, cands, limit, detectLang(query));
    return { query: excerpt(query, 160), queries: queries.length, scope, candidates: cands.length, ...r };
  });

  app.get('/intel/tickets/:id/semantic-similar', agent, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const t = await one('SELECT id, title, body, lang FROM tickets WHERE id=$1 AND org_id=$2', [id, req.auth.orgId]);
    if (!t) throw notFound('Ticket introuvable');
    const cands = await candidatesOf(req.auth.orgId, 'tickets', id);
    const r = await rank(`${t.title}. ${t.body}`, cands, 8, t.lang);
    return { ticketId: id, engine: r.engine, model: r.model, similar: r.results.filter((x) => x.score >= (r.engine === 'semantic' ? 0.45 : 0.2)).map((x) => ({ ...x, verdict: verdict(x.score) })) };
  });

  // ---------------------------------------------------------------- risque (delai, reouverture, SLA)
  app.get('/intel/tickets/:id/risk', agent, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const t = await one(
      `SELECT t.id, t.title, t.body, t.component, t.priority, t.channel, t.frustration, t.sentiment, c.tier, p.resolve_mins
         FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN sla_policies p ON p.org_id=t.org_id AND p.priority=t.priority
        WHERE t.id=$1 AND t.org_id=$2`, [id, req.auth.orgId]);
    if (!t) throw notFound('Ticket introuvable');
    const r = await mlCall('/v1/predict/risk', {
      title: scrub(t.title), body: scrub(t.body), component: t.component, priority: t.priority, channel: t.channel, tier: t.tier ?? 'standard',
      frustration: t.frustration, sentiment: t.sentiment, sla_hours: t.resolve_mins ? t.resolve_mins / 60 : null,
    });
    if (!r) return { engine: 'unavailable', configured: mlConfigured() };
    return { engine: 'ml', model: r.model ?? null, resolutionHours: r.resolution_hours, reopenProbability: r.reopen_probability, slaBreachProbability: r.sla_breach_probability ?? null, evidence: r.evidence ?? [] };
  });
}
