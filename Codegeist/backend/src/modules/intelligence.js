import { z } from 'zod';
import { env } from '../config/env.js';
import { decrypt } from '../lib/crypto.js';
import { many, one, query } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { clamp, linreg, mean, quantile, round, sigmoid } from '../lib/stats.js';
import {
  BM25, detectLang, excerpt, frustration, jaccard, minhashSimilarity, redactPII, sentiment, tokenize, trigrams,
} from '../lib/text.js';
import { pickAssignee } from './tickets.js';
import { createHash } from 'node:crypto';

const uuid = z.string().uuid();
const DAY = 86_400_000;
const hours = (a, b) => (new Date(b) - new Date(a)) / 3_600_000;

async function getTicket(orgId, id) {
  const t = await one('SELECT * FROM tickets WHERE id=$1 AND org_id=$2', [id, orgId]);
  if (!t) throw notFound('Ticket introuvable');
  return t;
}

/** Decoupe un texte en phrases exploitables (>= 4 mots). */
export function sentences(text) {
  return String(text ?? '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 4);
}

export default async function intelligenceRoutes(app) {
  const agent = { preHandler: app.guard('agent') };

  // ======================================================================
  // 1. Trajectoire de frustration : predit l'escalade AVANT qu'elle arrive
  // ======================================================================
  app.get('/intel/tickets/:id/frustration', agent, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const t = await getTicket(req.auth.orgId, id);
    const cs = await many('SELECT author_is_customer, internal, body, sentiment, created_at FROM ticket_comments WHERE ticket_id=$1 ORDER BY created_at', [id]);
    const customer = cs.filter((c) => c.author_is_customer);
    const series = [{ at: t.created_at, sentiment: sentiment(`${t.title} ${t.body}`), frustration: frustration(`${t.title} ${t.body}`) },
      ...customer.map((c) => ({ at: c.created_at, sentiment: c.sentiment, frustration: frustration(c.body) }))];
    const slope = linreg(series.map((s) => s.sentiment)).slope;
    // EMA : les derniers messages pesent plus
    const ema = series.reduce((acc, s) => 0.5 * s.frustration + 0.5 * acc, series[0].frustration);
    // Silence de l'equipe apres le dernier message client
    const last = cs.at(-1);
    const waitingH = last?.author_is_customer || !cs.length ? hours(last?.created_at ?? t.created_at, new Date()) : 0;
    const gaps = [];
    cs.forEach((c, i) => { if (c.author_is_customer) { const next = cs.slice(i + 1).find((x) => !x.author_is_customer && !x.internal); if (next) gaps.push(hours(c.created_at, next.created_at)); } });
    const risk = sigmoid(3.2 * ema - 2.4 * slope + 0.12 * Math.min(waitingH, 48) / 4 + 0.6 * t.reopened_count + (t.priority === 'critical' ? 0.4 : 0) - 1.9);
    const drivers = [];
    if (ema > 0.4) drivers.push({ factor: 'frustration_elevee', detail: `niveau lisse ${round(ema)}` });
    if (slope < -0.05) drivers.push({ factor: 'ton_en_degradation', detail: `pente ${round(slope, 3)} par message` });
    if (waitingH > 8) drivers.push({ factor: 'client_sans_reponse', detail: `${round(waitingH, 1)} h d'attente` });
    if (t.reopened_count) drivers.push({ factor: 'reouverture', detail: `${t.reopened_count} fois` });
    const level = risk > 0.66 ? 'high' : risk > 0.4 ? 'medium' : 'low';
    return {
      ticketId: id, escalationRisk: round(risk, 3), level, trend: slope < -0.05 ? 'worsening' : slope > 0.05 ? 'improving' : 'stable',
      series: series.map((s) => ({ at: s.at, sentiment: round(s.sentiment), frustration: round(s.frustration) })), meanAgentGapHours: gaps.length ? round(mean(gaps), 1) : null, drivers,
      recommendation: level === 'high' ? 'Reponse humaine prioritaire dans l\'heure, ton empathique, proposer un appel.' : level === 'medium' ? 'Accuser reception et donner un delai precis.' : 'Suivi normal.',
    };
  });

  // ======================================================================
  // 2. Doublons : MinHash (sens) + trigrammes (forme) + meme client
  // ======================================================================
  app.get('/intel/tickets/:id/duplicates', agent, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const t = await getTicket(req.auth.orgId, id);
    const cands = await many(
      `SELECT id, key, title, status, minhash, customer_id, component, created_at FROM tickets
        WHERE org_id=$1 AND id<>$2 AND created_at > now() - interval '180 days' ORDER BY created_at DESC LIMIT 1500`, [req.auth.orgId, id]);
    const tri = trigrams(t.title);
    const out = cands.map((c) => {
      const mh = minhashSimilarity(t.minhash, c.minhash), tr = jaccard(tri, trigrams(c.title));
      let score = 0.6 * mh + 0.4 * tr;
      if (c.customer_id && c.customer_id === t.customer_id) score += 0.1;
      if (c.component && c.component === t.component) score += 0.05;
      return { id: c.id, key: c.key, title: c.title, status: c.status, score: round(Math.min(score, 1), 3), semantic: round(mh, 3), lexical: round(tr, 3) };
    }).filter((x) => x.score >= 0.25).sort((a, b) => b.score - a.score).slice(0, 8);
    return { ticketId: id, duplicates: out.map((x) => ({ ...x, verdict: x.score >= 0.6 ? 'duplicate' : x.score >= 0.4 ? 'probable' : 'related' })) };
  });

  // ======================================================================
  // 3. Peremption de la connaissance : quelles pages Confluence mentent encore ?
  // ======================================================================
  app.get('/intel/kb/decay', agent, async (req) => {
    const rows = await many(
      `SELECT a.id, a.title, a.url, a.updated_at, a.last_verified_at, a.views, a.helpful, a.unhelpful,
              count(DISTINCT l.ticket_id) FILTER (WHERE l.relation IN ('used','cited'))::int AS uses,
              count(DISTINCT t.id) FILTER (WHERE t.reopened_count > 0)::int AS reopened_uses
         FROM kb_articles a LEFT JOIN ticket_kb_links l ON l.article_id=a.id LEFT JOIN tickets t ON t.id=l.ticket_id
        WHERE a.org_id=$1 GROUP BY a.id`, [req.auth.orgId]);
    const items = rows.map((a) => {
      const ageDays = (Date.now() - new Date(a.last_verified_at ?? a.updated_at)) / DAY;
      const votes = a.helpful + a.unhelpful;
      const unhelpfulRatio = (a.unhelpful + 1) / (votes + 2); // lissage de Laplace
      const reopenRate = a.uses ? a.reopened_uses / a.uses : 0;
      const decay = 0.35 * clamp(ageDays / 365, 0, 1) + 0.3 * unhelpfulRatio + 0.35 * reopenRate;
      const reasons = [];
      const reasonCodes = []; // meme information, structuree : le client la traduit
      if (ageDays > 180) { reasons.push(`non verifie depuis ${Math.round(ageDays)} jours`); reasonCodes.push({ code: 'stale', n: Math.round(ageDays) }); }
      if (votes >= 3 && a.unhelpful / votes > 0.4) { reasons.push(`${Math.round((a.unhelpful / votes) * 100)} % de retours negatifs`); reasonCodes.push({ code: 'unhelpful', n: Math.round((a.unhelpful / votes) * 100) }); }
      if (a.uses >= 2 && reopenRate > 0.25) { reasons.push(`${a.reopened_uses}/${a.uses} tickets cites ont ete rouverts`); reasonCodes.push({ code: 'reopened', a: a.reopened_uses, b: a.uses }); }
      return { id: a.id, title: a.title, url: a.url, decay: round(decay, 3), impact: round(decay * Math.log(1 + a.uses + a.views / 10), 3), uses: a.uses, ageDays: Math.round(ageDays), reasons, reasonCodes };
    }).sort((a, b) => b.impact - a.impact);
    return { articles: items, needsReview: items.filter((i) => i.decay > 0.45 && i.reasons.length).length };
  });

  // ======================================================================
  // 4. Lacunes de connaissance ("ghost knowledge") + brouillon d'article
  // ======================================================================
  app.get('/intel/kb/gaps', agent, async (req) => {
    const tickets = await many(
      `SELECT t.id, t.key, t.title, t.body, t.status, t.frustration, t.resolved_at,
              (SELECT string_agg(c.body, E'\n' ORDER BY c.created_at) FROM ticket_comments c WHERE c.ticket_id=t.id AND NOT c.author_is_customer AND NOT c.internal) AS answers
         FROM tickets t
        WHERE t.org_id=$1 AND t.created_at > now() - interval '90 days'
          AND NOT EXISTS (SELECT 1 FROM ticket_kb_links l WHERE l.ticket_id=t.id AND l.relation IN ('used','cited'))
        ORDER BY t.created_at DESC LIMIT 600`, [req.auth.orgId]);
    const arts = await many('SELECT id, title, body FROM kb_articles WHERE org_id=$1', [req.auth.orgId]);
    const idx = new BM25(arts.map((a) => ({ id: a.id, text: `${a.title} ${a.body}` })));
    const uncovered = tickets.filter((t) => {
      const q = [...new Set(tokenize(t.title))];
      if (!q.length) return false;
      const best = idx.search(t.title, 1)[0];
      return !best || best.matched.length / q.length < 0.4;
    }).map((t) => ({ ...t, set: new Set(tokenize(`${t.title} ${t.body}`)) }));
    // Regroupement glouton par chevauchement de vocabulaire
    const clusters = [];
    for (const t of uncovered) {
      const home = clusters.find((c) => jaccard(c.centroid, t.set) >= 0.22);
      if (home) { home.items.push(t); for (const x of t.set) home.centroid.add(x); } else clusters.push({ centroid: new Set(t.set), items: [t] });
    }
    const out = clusters.filter((c) => c.items.length >= 2).map((c) => {
      const df = new Map();
      for (const it of c.items) for (const tok of it.set) df.set(tok, (df.get(tok) ?? 0) + 1);
      const terms = [...df.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k);
      const resolved = c.items.filter((i) => i.answers);
      const steps = resolved.flatMap((r) => sentences(r.answers)).filter((s, i, a) => a.indexOf(s) === i).slice(0, 5);
      return {
        size: c.items.length, avgFrustration: round(mean(c.items.map((i) => i.frustration)), 3), topTerms: terms,
        impact: round(c.items.length * (1 + mean(c.items.map((i) => i.frustration))), 2),
        tickets: c.items.slice(0, 6).map((i) => ({ id: i.id, key: i.key, title: i.title })),
        symptom: excerpt(c.items[0].body || c.items[0].title, 300), steps, // donnees brutes : le client compose le brouillon dans sa langue
        draft: { title: `Comment resoudre : ${c.items[0].title}`, body: `## Symptome\n${excerpt(c.items[0].body || c.items[0].title, 300)}\n\n## Resolution\n${steps.length ? steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : '_A completer : aucune resolution documentee dans les tickets._'}\n\n_Brouillon genere a partir de ${c.items.length} tickets sans documentation._` },
      };
    }).sort((a, b) => b.impact - a.impact);
    return { uncoveredTickets: uncovered.length, gaps: out };
  });

  // ======================================================================
  // 5. Experts reels : qui a REELLEMENT resolu des problemes similaires, vite et sans reouverture
  // ======================================================================
  app.get('/intel/experts', agent, async (req) => {
    const { ticketId, q } = z.object({ ticketId: uuid.optional(), q: z.string().max(500).optional() }).parse(req.query);
    let text = q;
    if (ticketId) { const t = await getTicket(req.auth.orgId, ticketId); text = `${t.title} ${t.body}`; }
    if (!text) throw badRequest('Fournir ticketId ou q');
    const solved = await many(
      `SELECT t.id, t.key, t.title, t.body, t.assignee_id, t.reopened_count, EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))/3600 AS hrs, u.display_name
         FROM tickets t JOIN users u ON u.id=t.assignee_id WHERE t.org_id=$1 AND t.resolved_at IS NOT NULL AND t.assignee_id IS NOT NULL
          AND t.created_at > now() - interval '365 days'`, [req.auth.orgId]);
    const idx = new BM25(solved.map((s) => ({ id: s.id, text: `${s.title} ${s.body}` })));
    const hits = idx.search(text, 25);
    const top = hits[0]?.score || 1;
    const med = quantile(solved.map((s) => s.hrs).sort((a, b) => a - b), 0.5) || 1;
    const byId = new Map(solved.map((s) => [s.id, s]));
    const agents = new Map();
    for (const h of hits) {
      const s = byId.get(h.id);
      const speed = clamp(med / Math.max(s.hrs, 0.1), 0.3, 2);
      const quality = s.reopened_count ? 0.5 : 1;
      const w = (h.score / top) * speed * quality;
      const a = agents.get(s.assignee_id) ?? { userId: s.assignee_id, name: s.display_name, score: 0, evidence: [] };
      a.score += w; a.evidence.push({ key: s.key, title: s.title, hours: round(s.hrs, 1), reopened: s.reopened_count > 0 });
      agents.set(s.assignee_id, a);
    }
    const ranked = [...agents.values()].sort((a, b) => b.score - a.score).slice(0, 5);
    const max = ranked[0]?.score || 1;
    return { experts: ranked.map((a) => ({ ...a, score: round(a.score / max, 3), solved: a.evidence.length, evidence: a.evidence.slice(0, 3) })) };
  });

  // ======================================================================
  // 7. "Murmure de churn" : risque d'attrition d'un client
  // ======================================================================
  const churnFor = async (orgId, customerId) => {
    const c = await one('SELECT * FROM customers WHERE id=$1 AND org_id=$2', [customerId, orgId]);
    if (!c) throw notFound('Client introuvable');
    const ts = await many(`SELECT id, key, title, body, status, frustration, reopened_count, created_at FROM tickets WHERE customer_id=$1 AND created_at > now() - interval '90 days'`, [customerId]);
    const recent = ts.filter((t) => Date.now() - new Date(t.created_at) < 30 * DAY).length;
    const prior = ts.length - recent;
    const velocity = clamp(recent / Math.max(prior / 2, 1), 0, 4) / 4;
    const frus = ts.length ? mean(ts.map((t) => t.frustration)) : 0;
    const reopen = ts.length ? ts.filter((t) => t.reopened_count > 0).length / ts.length : 0;
    const stale = ts.filter((t) => ['open', 'pending'].includes(t.status) && Date.now() - new Date(t.created_at) > 3 * DAY).length;
    const leaving = ts.filter((t) => /cancel|resilier|rembours|refund|switch|concurrent|competitor|changer de/i.test(`${t.title} ${t.body}`)).length;
    const z = 2.2 * frus + 1.4 * reopen + 1.1 * velocity + 0.5 * Math.min(stale, 3) + 1.6 * Math.min(leaving, 2) - 2.4;
    const p = sigmoid(z);
    const mult = { standard: 1, premium: 1.15, enterprise: 1.3 }[c.tier];
    return {
      customer: { id: c.id, name: c.name, company: c.company, tier: c.tier }, churnRisk: round(p, 3), level: p > 0.66 ? 'high' : p > 0.4 ? 'medium' : 'low',
      priorityScore: round(p * mult, 3),
      signals: { avgFrustration: round(frus, 3), reopenRate: round(reopen, 3), ticketVelocity: round(velocity, 3), staleOpenTickets: stale, departureLanguage: leaving, tickets90d: ts.length },
    };
  };
  app.get('/intel/customers/:id/churn', agent, async (req) => churnFor(req.auth.orgId, z.object({ id: uuid }).parse(req.params).id));
  app.get('/intel/customers-at-risk', agent, async (req) => {
    const cs = await many(`SELECT DISTINCT customer_id AS id FROM tickets WHERE org_id=$1 AND customer_id IS NOT NULL AND created_at > now() - interval '90 days'`, [req.auth.orgId]);
    const all = [];
    for (const c of cs) all.push(await churnFor(req.auth.orgId, c.id));
    return { customers: all.sort((a, b) => b.priorityScore - a.priorityScore).slice(0, 20) };
  });

  // ======================================================================
  // 10. Garde-fou de reponse : ton, promesses risquees, juridique, PII, structure
  // ======================================================================
  app.post('/intel/reply/guard', agent, async (req) => {
    const { body, ticketId } = z.object({ body: z.string().min(1).max(10000), ticketId: uuid.optional() }).parse(req.body);
    const issues = [];
    // `code` + `params` permettent au client d'afficher le message dans sa langue ; `message` reste un repli lisible.
    const add = (severity, code, message, params) => issues.push({ severity, code, message, ...(params ? { params } : {}) });
    const n = body.toLowerCase();
    if (/\b(garanti|guarantee[sd]?|100 ?%|sans aucun doute|certain que|jamais plus|never happen again|promis|promise)\b/.test(n)) add('high', 'promesse_ferme', 'Promesse ferme ou garantie : risque contractuel. Preferer un engagement mesurable.');
    if (/\b(notre faute|our fault|nous sommes responsables|we are liable|responsabilit|dedommag|compensation|indemn)/.test(n)) add('high', 'responsabilite', 'Reconnaissance de responsabilite ou indemnisation : a valider par le juridique.');
    if (/\b(vous auriez du|you should have|c'est votre faute|your fault|vous n'avez pas lu|as i already said|comme deja dit)/.test(n)) add('medium', 'blame_client', 'Formulation qui renvoie la faute au client.');
    const letters = body.replace(/[^A-Za-z]/g, '');
    if (letters.length > 20 && body.replace(/[^A-Z]/g, '').length / letters.length > 0.3) add('medium', 'majuscules', 'Trop de majuscules : ton percu comme agressif.');
    if ((body.match(/!/g) ?? []).length > 2) add('low', 'exclamations', 'Trop de points d\'exclamation.');
    if (!/\b(bonjour|bonsoir|salut|hello|hi|dear|cher|chere)\b/.test(n)) add('low', 'salutation', 'Pas de formule d\'accueil.');
    if (!/\b(cordialement|bien a vous|regards|best|sincerely|merci|thanks|thank you)\b/.test(n)) add('low', 'cloture', 'Pas de formule de cloture.');
    if (body.length > 2500) add('low', 'longueur', 'Reponse tres longue : privilegier des etapes numerotees.');
    const pii = redactPII(body);
    if (pii.findings.length) add('high', 'donnee_personnelle', `${pii.findings.length} donnee(s) personnelle(s) detectee(s) (${[...new Set(pii.findings.map((f) => f.kind))].join(', ')}).`, { n: pii.findings.length, kinds: [...new Set(pii.findings.map((f) => f.kind))].join(', ') });
    if (sentiment(body) < -0.25) add('medium', 'ton_negatif', 'Ton globalement negatif.');
    let lang = null;
    if (ticketId) {
      const t = await getTicket(req.auth.orgId, ticketId);
      lang = { ticket: t.lang, reply: detectLang(body) };
      if (lang.ticket !== lang.reply) add('medium', 'langue', `Le client ecrit en ${lang.ticket}, la reponse semble en ${lang.reply}.`, { ticket: lang.ticket, reply: lang.reply });
    }
    const penalty = { high: 30, medium: 12, low: 4 };
    const score = clamp(100 - issues.reduce((s, i) => s + penalty[i.severity], 0), 0, 100);
    return { score, safeToSend: !issues.some((i) => i.severity === 'high'), issues, redactedSuggestion: pii.findings.length ? pii.text : null, lang };
  });

  // ======================================================================
  // 11. Bouclier PII : apercu de redaction + revelation tracee (admin)
  // ======================================================================
  app.post('/intel/pii/redact', agent, async (req) => {
    const { text } = z.object({ text: z.string().max(20000) }).parse(req.body);
    const r = redactPII(text);
    return { text: r.text, findings: r.findings.map((f) => ({ kind: f.kind, token: f.token })) };
  });

  app.post('/intel/pii/reveal', { preHandler: app.guard('admin'), config: { rateLimit: { max: env.strictRate * 2, timeWindow: '1 minute' } } }, async (req) => {
    const { token, reason } = z.object({ token: z.string().max(80), reason: z.string().trim().min(8).max(300) }).parse(req.body);
    const row = await one('SELECT kind, value_enc, ticket_id FROM pii_vault WHERE org_id=$1 AND token=$2', [req.auth.orgId, token]);
    if (!row) throw notFound('Jeton inconnu');
    // Toute revelation est inscrite dans le journal infalsifiable, avec la justification.
    await audit(req.auth.orgId, req.auth.userId, 'pii.revealed', 'ticket', row.ticket_id, { token, kind: row.kind, reason });
    return { kind: row.kind, value: decrypt(row.value_enc) };
  });

  // ======================================================================
  // 12. Rejeu de resolution : comment ce ticket a-t-il vraiment ete resolu ?
  // ======================================================================
  app.get('/intel/tickets/:id/replay', agent, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const t = await getTicket(req.auth.orgId, id);
    const [events, cs] = await Promise.all([
      many('SELECT type, actor, data, created_at FROM ticket_events WHERE ticket_id=$1', [id]),
      many(`SELECT c.author_is_customer, c.internal, c.body, c.sentiment, c.created_at, u.display_name FROM ticket_comments c LEFT JOIN users u ON u.id=c.author_user_id WHERE c.ticket_id=$1`, [id]),
    ]);
    const timeline = [
      ...events.map((e) => ({ at: e.created_at, kind: 'event', label: e.type, data: e.data })),
      ...cs.map((c) => ({ at: c.created_at, kind: c.internal ? 'note' : c.author_is_customer ? 'customer' : 'agent', label: c.display_name ?? (c.author_is_customer ? 'Client' : 'Agent'), text: excerpt(c.body, 180), sentiment: c.sentiment })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at));
    let prev = new Date(t.created_at);
    for (const s of timeline) { s.sincePreviousMin = Math.round((new Date(s.at) - prev) / 60000); prev = new Date(s.at); }
    // Point de bascule : reponse agent suivie de la plus forte hausse de sentiment client
    let turning = null;
    const pub = cs.filter((c) => !c.internal).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    pub.forEach((c, i) => {
      if (c.author_is_customer) return;
      const before = [...pub.slice(0, i)].reverse().find((x) => x.author_is_customer);
      const after = pub.slice(i + 1).find((x) => x.author_is_customer);
      if (before && after) { const d = after.sentiment - before.sentiment; if (!turning || d > turning.delta) turning = { delta: round(d, 3), at: c.created_at, agent: c.display_name, text: excerpt(c.body, 220) }; }
    });
    const idleGaps = timeline.filter((s) => s.sincePreviousMin > 240).map((s) => ({ at: s.at, idleHours: round(s.sincePreviousMin / 60, 1) }));
    return {
      ticket: { id: t.id, key: t.key, title: t.title, status: t.status },
      firstResponseMin: t.first_response_at ? Math.round((new Date(t.first_response_at) - new Date(t.created_at)) / 60000) : null,
      resolutionHours: t.resolved_at ? round(hours(t.created_at, t.resolved_at), 1) : null, turningPoint: turning, idleGaps, timeline,
    };
  });

  // ======================================================================
  // 13. Synthese de runbook a partir de tickets resolus
  // ======================================================================
  app.post('/intel/runbooks/synthesize', agent, async (req) => {
    const { ticketIds, title, save } = z.object({ ticketIds: z.array(uuid).min(1).max(30), title: z.string().max(200).optional(), save: z.boolean().default(false) }).parse(req.body);
    const rows = await many(
      `SELECT t.id, t.key, c.body, c.created_at FROM tickets t JOIN ticket_comments c ON c.ticket_id=t.id
        WHERE t.org_id=$1 AND t.id = ANY($2) AND NOT c.author_is_customer AND NOT c.internal ORDER BY t.id, c.created_at`, [req.auth.orgId, ticketIds]);
    if (!rows.length) throw badRequest('Aucune reponse d\'agent exploitable dans ces tickets');
    const per = new Map();
    for (const r of rows) per.set(r.id, [...(per.get(r.id) ?? []), r]);
    const items = [];
    for (const [tid, cs] of per) cs.forEach((c, i) => sentences(c.body).forEach((s) => items.push({ tid, s, set: new Set(tokenize(s)), pos: cs.length > 1 ? i / (cs.length - 1) : 0.5 })));
    const clusters = [];
    for (const it of items) {
      if (it.set.size < 3) continue;
      const home = clusters.find((c) => jaccard(c.set, it.set) >= 0.5);
      if (home) { home.members.push(it); } else clusters.push({ set: it.set, members: [it], rep: it.s });
    }
    const need = per.size >= 3 ? 2 : 1;
    const steps = clusters.map((c) => ({ text: c.rep, support: new Set(c.members.map((m) => m.tid)).size, pos: mean(c.members.map((m) => m.pos)) }))
      .filter((c) => c.support >= need).sort((a, b) => a.pos - b.pos).slice(0, 10);
    const result = { basedOn: per.size, steps: steps.map((s, i) => ({ n: i + 1, text: s.text, support: s.support, confidence: round(s.support / per.size, 2) })) };
    if (save && steps.length) {
      const name = title ?? `Runbook : ${rows[0].key}`;
      const md = `## Procedure\n${steps.map((s, i) => `${i + 1}. ${s.text}`).join('\n')}\n\n_Genere automatiquement a partir de ${per.size} resolution(s) reelle(s)._`;
      const a = await one(`INSERT INTO kb_articles(org_id, title, body, source) VALUES ($1,$2,$3,'generated') RETURNING id`, [req.auth.orgId, name, md]);
      result.savedArticleId = a.id;
    }
    return result;
  });

  // ======================================================================
  // 20. Routage par langue + competence
  // ======================================================================
  app.post('/intel/lang/route', agent, async (req) => {
    const { text } = z.object({ text: z.string().min(1).max(5000) }).parse(req.body);
    const lang = detectLang(text);
    const agents = await many(
      `SELECT u.id, u.display_name, m.languages, m.skills,
              (SELECT count(*) FROM tickets t WHERE t.assignee_id=u.id AND t.org_id=m.org_id AND t.status IN ('open','pending'))::int AS load
         FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.role IN ('agent','admin','owner') AND u.disabled=false`, [req.auth.orgId]);
    const ranked = agents.map((a) => ({ id: a.id, name: a.display_name, speaksLanguage: a.languages.includes(lang), load: a.load, score: (a.languages.includes(lang) ? 10 : 0) - a.load }))
      .sort((a, b) => b.score - a.score);
    return { detectedLanguage: lang, candidates: ranked.slice(0, 5) };
  });

  // ======================================================================
  // 16. Simulateur contrefactuel de routage
  // ======================================================================
  app.post('/intel/routing/counterfactual', agent, async (req) => {
    const { ticketId } = z.object({ ticketId: uuid }).parse(req.body);
    const t = await getTicket(req.auth.orgId, ticketId);
    const hist = await many(
      `SELECT assignee_id, title, body, EXTRACT(EPOCH FROM (resolved_at - created_at))/3600 AS hrs, reopened_count FROM tickets
        WHERE org_id=$1 AND resolved_at IS NOT NULL AND assignee_id IS NOT NULL AND id<>$2 AND created_at > now() - interval '365 days'`, [req.auth.orgId, ticketId]);
    if (hist.length < 5) return { ticketId, message: 'Historique insuffisant (< 5 resolutions)', candidates: [] };
    const idx = new BM25(hist.map((h, i) => ({ id: i, text: `${h.title} ${h.body}` })));
    const sims = idx.search(`${t.title} ${t.body}`, 40);
    const names = new Map((await many('SELECT id, display_name FROM users WHERE id = ANY($1)', [[...new Set(hist.map((h) => h.assignee_id))]])).map((u) => [u.id, u.display_name]));
    const per = new Map();
    for (const s of sims) {
      const h = hist[s.id];
      const x = per.get(h.assignee_id) ?? { hrs: [], reopen: 0, w: 0 };
      x.hrs.push(h.hrs * s.score); x.w += s.score; x.reopen += h.reopened_count > 0 ? s.score : 0; per.set(h.assignee_id, x);
    }
    const cands = [...per.entries()].filter(([, x]) => x.w > 0).map(([id, x]) => ({
      userId: id, name: names.get(id), expectedHours: round(x.hrs.reduce((a, b) => a + b, 0) / x.w, 1), expectedReopenRate: round(x.reopen / x.w, 2), basedOn: x.hrs.length,
    })).sort((a, b) => a.expectedHours - b.expectedHours);
    const current = cands.find((c) => c.userId === t.assignee_id) ?? null;
    return {
      ticketId, currentAssignee: current, best: cands[0] ?? null, candidates: cands.slice(0, 5),
      potentialGainHours: current && cands[0] ? round(Math.max(0, current.expectedHours - cands[0].expectedHours), 1) : null,
      suggestedStrategy: await pickAssignee({ one: (q, p) => one(q, p), many: (q, p) => many(q, p) }, req.auth.orgId, t, 'least_loaded'),
    };
  });

  // Empreinte stable d'un texte (utile pour deduplication de fils d'emails cote integrations).
  app.post('/intel/fingerprint', agent, async (req) => {
    const { text } = z.object({ text: z.string().max(20000) }).parse(req.body);
    const core = tokenize(text.replace(/^(\s*(re|tr|fwd|fw)\s*:\s*)+/i, '').replace(/^>.*$/gm, '')).sort().join(' ');
    return { fingerprint: createHash('sha256').update(core).digest('hex').slice(0, 24), tokens: core.split(' ').length };
  });
  void query;
}
