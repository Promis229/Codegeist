import { z } from 'zod';
import { many, one } from '../db/pool.js';
import { frustration, jaccard, minhash, minhashSimilarity, sentiment, trigrams } from '../lib/text.js';
import { searchKb } from './core.js';
import { createTicket, addComment } from './tickets.js';
import { loadRules, runRules } from './rules.js';

/**
 * Endpoints appeles par l'application Forge (Forge Remote). Authentification : Forge Invocation Token.
 * Tous les endpoints /intel/* sont aussi accessibles avec ce meme jeton.
 */
export default async function forgeRoutes(app) {
  const g = { preHandler: app.guard('agent') };

  // Triage en lecture seule : utilise par l'action Rovo "triage-request" et le panneau JSM.
  app.post('/forge/triage', g, async (req) => {
    const b = z.object({ summary: z.string().min(3).max(300), description: z.string().max(20000).default(''), component: z.string().max(60).optional(), priority: z.enum(['low', 'medium', 'high', 'critical']).optional() }).parse(req.body);
    const text = `${b.summary}\n${b.description}`;
    const mh = minhash(text), tri = trigrams(b.summary);
    const [kb, cands, rules] = await Promise.all([
      searchKb(req.auth.orgId, text, 3),
      many(`SELECT id, key, title, status, minhash FROM tickets WHERE org_id=$1 AND created_at > now() - interval '180 days' LIMIT 1500`, [req.auth.orgId]),
      loadRules(req.auth.orgId),
    ]);
    const dups = cands.map((c) => ({ key: c.key, title: c.title, status: c.status, score: Number((0.6 * minhashSimilarity(mh, c.minhash) + 0.4 * jaccard(tri, trigrams(c.title))).toFixed(3)) }))
      .filter((d) => d.score >= 0.4).sort((a, c) => c.score - a.score).slice(0, 3);
    const { patch, fired } = runRules(rules, { title: b.summary, body: b.description, priority: b.priority ?? 'medium', status: 'open', component: b.component ?? null, tags: [], sentiment: sentiment(text), frustration: frustration(text), at: new Date() });
    return {
      sentiment: sentiment(text), frustration: frustration(text), suggestedPriority: patch.priority ?? b.priority ?? 'medium', suggestedTags: patch.tags ?? [], suggestedRoute: patch.assign ?? 'least_loaded',
      rulesFired: fired.map((f) => f.name), knowledge: kb.map((a) => ({ id: a.id, title: a.title, url: a.url, relevance: a.score })), possibleDuplicates: dups,
    };
  });

  // Reception d'un evenement Jira (issue creee) depuis un declencheur Forge.
  app.post('/forge/issues', g, async (req, reply) => {
    const b = z.object({
      issueKey: z.string().max(30), summary: z.string().min(3).max(300), description: z.string().max(20000).default(''),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional(), component: z.string().max(60).optional(),
      reporterEmail: z.string().email().optional(), reporterName: z.string().max(100).optional(), labels: z.array(z.string().max(40)).max(20).optional(),
    }).parse(req.body);
    const existing = await one('SELECT id, key FROM tickets WHERE org_id=$1 AND jira_issue_key=$2', [req.auth.orgId, b.issueKey]);
    if (existing) return { ...existing, deduplicated: true }; // idempotent : un declencheur rejoue ne cree pas de doublon
    const t = await createTicket(req.auth.orgId, { title: b.summary, body: b.description, priority: b.priority, component: b.component, tags: b.labels, customerEmail: b.reporterEmail, customerName: b.reporterName, channel: 'jira', jiraIssueKey: b.issueKey }, null);
    reply.code(201);
    return t;
  });

  app.post('/forge/comments', g, async (req, reply) => {
    const b = z.object({ issueKey: z.string().max(30), body: z.string().min(1).max(10000), fromCustomer: z.boolean().default(false), internal: z.boolean().default(false) }).parse(req.body);
    const t = await one('SELECT id FROM tickets WHERE org_id=$1 AND jira_issue_key=$2', [req.auth.orgId, b.issueKey]);
    if (!t) { reply.code(404); return { error: 'not_found', message: 'Issue non synchronisee' }; }
    reply.code(201);
    return addComment(req.auth.orgId, t.id, { body: b.body, internal: b.internal, authorIsCustomer: b.fromCustomer });
  });

  // Synchronisation de pages Confluence vers la base de connaissances (upsert par source_id).
  app.post('/forge/kb/sync', g, async (req) => {
    const b = z.object({ pages: z.array(z.object({ id: z.string().max(60), title: z.string().min(1).max(200), body: z.string().max(100000), url: z.string().url().max(500).optional(), space: z.string().max(60).optional() })).min(1).max(100) }).parse(req.body);
    let upserted = 0;
    for (const p of b.pages) {
      const r = await one(
        `UPDATE kb_articles SET title=$3, body=$4, url=$5, space=$6, last_verified_at=now() WHERE org_id=$1 AND source='confluence' AND source_id=$2 RETURNING id`,
        [req.auth.orgId, p.id, p.title, p.body, p.url ?? null, p.space ?? null],
      );
      if (!r) await one(`INSERT INTO kb_articles(org_id, title, body, url, space, source, source_id, last_verified_at) VALUES ($1,$2,$3,$4,$5,'confluence',$6, now()) RETURNING id`, [req.auth.orgId, p.title, p.body, p.url ?? null, p.space ?? null, p.id]);
      upserted++;
    }
    return { upserted };
  });
}
