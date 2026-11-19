import { z } from 'zod';
import { many, one } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { clamp, linreg, mean, quantile, round, sigmoid, stddev } from '../lib/stats.js';
import { BM25, cosine, excerpt, jaccard, minhashSimilarity, redactPII, tokenize } from '../lib/text.js';
import { mlCall, scrub } from '../lib/ml.js';
import { sentences } from './intelligence.js';
import { logPrediction } from './ml.js';
import { localParts } from './intelligence2.js';

/**
 * Intelligence, deuxieme vague : 23 analyses supplementaires, toutes sans LLM (statistiques, recherche lexicale, graphes).
 * Chaque reponse est structuree (codes + nombres) : le client l'affiche dans sa langue, rien de redige en dur ici.
 *   26 triage de priorite (Bayes naif)        27 ETA par cas similaires          28 sante d'un client dans le temps
 *   29 recommandation d'assignation           30 cartographie des sujets         31 prevision de vidage du backlog (Monte Carlo)
 *   32 grappes de doublons                    33 effort client                   34 coaching d'agent
 *   35 demandes zombies                       36 prevision de capacite           37 trous de couverture horaire
 *   38 impact reel des articles               39 risque de deploiement           40 composants qui en entrainent d'autres
 *   41 segments de clients (k-means)          42 prochaine meilleure action      43 macros a creer
 *   44 bascule de ton dans un fil             45 resume extractif (TextRank)     46 facteur bus
 *   47 equite de traitement                   48 audit de fuites de donnees personnelles
 */

const uuid = z.string().uuid();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const PRIO_W = { low: 1, medium: 2, high: 3, critical: 4 };
const TIER_W = { standard: 0, premium: 0.5, enterprise: 1 };

/** PRNG deterministe (mulberry32) : memes entrees => memes resultats, donc testable et explicable. */
function rng(seed = 1234) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const wquantile = (items, q) => {
  const s = [...items].sort((a, b) => a.v - b.v); const tot = s.reduce((x, i) => x + i.w, 0); let acc = 0;
  for (const i of s) { acc += i.w; if (acc >= q * tot) return i.v; }
  return s.at(-1)?.v ?? 0;
};
const pearson = (a, b) => {
  const n = Math.min(a.length, b.length); if (n < 5) return 0;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n)); let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
};
/** Vecteurs TF-IDF normalises (cosine = produit scalaire). */
function tfidf(docs) {
  const toks = docs.map((d) => tokenize(d)); const df = new Map();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const N = docs.length;
  return toks.map((t) => {
    const tf = new Map(); for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1);
    const v = new Map(); let norm = 0;
    for (const [w, c] of tf) { const x = (1 + Math.log(c)) * Math.log(1 + N / df.get(w)); v.set(w, x); norm += x * x; }
    norm = Math.sqrt(norm) || 1; for (const [w, x] of v) v.set(w, x / norm);
    return v;
  });
}
const dot = (a, b) => { let s = 0; const [x, y] = a.size < b.size ? [a, b] : [b, a]; for (const [k, v] of x) { const o = y.get(k); if (o) s += v * o; } return s; };

export default async function intelligence3Routes(app) {
  const agent = { preHandler: app.guard('agent') };
  const org = (req) => req.auth.orgId;

  // ======================================================================
  // 26. Triage de priorite : Bayes naif multinomial entraine sur VOS tickets, avec les mots qui decident
  // ======================================================================
  app.post('/intel/triage/priority', agent, async (req) => {
    const { title, body, ticketId } = z.object({ title: z.string().min(3).max(300), body: z.string().max(20000).default(''), ticketId: uuid.optional() }).parse(req.body);
    // 1) modele entraine (service Kairos Brain) s'il repond ; 2) sinon Bayes naif entraine a la volee sur vos tickets.
    const brain = await mlCall('/v1/predict/triage', { title: scrub(title), body: scrub(body.slice(0, 4000)) });
    if (brain?.priority?.probabilities) {
      const p = brain.priority.probabilities;
      const fp = brain.model?.data_fingerprint;
      await logPrediction(org(req), ticketId, 'priority', brain.priority.label, p[brain.priority.label], fp);
      if (brain.component) await logPrediction(org(req), ticketId, 'component', brain.component.label, brain.component.probabilities[brain.component.label], fp);
      return { engine: 'ml', model: brain.model ?? null, predicted: brain.priority.label, probabilities: p, confidence: p[brain.priority.label], component: brain.component ?? null, evidence: brain.evidence ?? [], topTerms: [], trainedOn: brain.model?.n_train ?? null };
    }
    const rows = await many('SELECT title, body, priority FROM tickets WHERE org_id=$1 ORDER BY created_at DESC LIMIT 3000', [org(req)]);
    if (rows.length < 20) return { insufficientData: true, trainedOn: rows.length };
    const classes = Object.keys(PRIO_W);
    const model = Object.fromEntries(classes.map((c) => [c, { n: 0, tok: new Map(), total: 0 }]));
    const vocab = new Set();
    for (const r of rows) { const m = model[r.priority]; m.n++; for (const t of tokenize(`${r.title} ${r.body}`)) { m.tok.set(t, (m.tok.get(t) ?? 0) + 1); m.total++; vocab.add(t); } }
    const V = vocab.size;
    const toks = [...new Set(tokenize(`${title} ${body}`))].filter((t) => vocab.has(t));
    const ll = (c, t) => Math.log(((model[c].tok.get(t) ?? 0) + 1) / (model[c].total + V));
    const score = {};
    for (const c of classes) score[c] = model[c].n ? Math.log(model[c].n / rows.length) + toks.reduce((s, t) => s + ll(c, t), 0) : -Infinity;
    const mx = Math.max(...Object.values(score)); const ex = Object.fromEntries(classes.map((c) => [c, Math.exp(score[c] - mx)])); const Z = Object.values(ex).reduce((a, b) => a + b, 0);
    const probabilities = Object.fromEntries(classes.map((c) => [c, round(ex[c] / Z, 3)]));
    const predicted = classes.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
    const others = classes.filter((c) => c !== predicted && model[c].n);
    const topTerms = toks.map((t) => ({ term: t, lift: round(ll(predicted, t) - mean(others.map((c) => ll(c, t))), 2) })).sort((a, b) => b.lift - a.lift).slice(0, 5);
    return { engine: 'naive-bayes', predicted, probabilities, confidence: probabilities[predicted], topTerms, trainedOn: rows.length };
  });

  // ======================================================================
  // 27. ETA par cas similaires : quantiles ponderes des durees de resolution des tickets proches
  // ======================================================================
  app.get('/intel/tickets/:id/eta', agent, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const t = await one('SELECT id, key, title, body, priority, created_at FROM tickets WHERE id=$1 AND org_id=$2', [id, org(req)]);
    if (!t) throw notFound('Ticket introuvable');
    const solved = await many(`SELECT id, key, title, body, priority, EXTRACT(EPOCH FROM (resolved_at - created_at))/3600 AS hrs FROM tickets
                                WHERE org_id=$1 AND resolved_at IS NOT NULL AND id<>$2 AND created_at > now() - interval '365 days'`, [org(req), id]);
    const idx = new BM25(solved.map((s) => ({ id: s.id, text: `${s.title} ${s.body}` })));
    const byId = new Map(solved.map((s) => [s.id, s]));
    const hits = idx.search(`${t.title} ${t.body}`, 15).filter((h) => h.score > 0);
    let method = 'similar', items = hits.map((h) => ({ v: byId.get(h.id).hrs, w: h.score }));
    if (items.length < 3) { method = 'priority'; items = solved.filter((s) => s.priority === t.priority).map((s) => ({ v: s.hrs, w: 1 })); }
    if (!items.length) return { method: 'none', basedOn: 0 };
    const elapsed = (Date.now() - new Date(t.created_at)) / HOUR;
    const p = (q) => round(wquantile(items, q), 1);
    return {
      method, basedOn: items.length, elapsedHours: round(elapsed, 1), p50Hours: p(0.5), p80Hours: p(0.8), p95Hours: p(0.95),
      remainingMedianHours: round(Math.max(0, wquantile(items.filter((i) => i.v > elapsed), 0.5) - elapsed) || 0, 1),
      similar: method === 'similar' ? hits.slice(0, 4).map((h) => ({ key: byId.get(h.id).key, title: byId.get(h.id).title, hours: round(byId.get(h.id).hrs, 1), score: round(h.score, 2) })) : [],
    };
  });

  // ======================================================================
  // 28. Sante d'un client dans le temps : tendance du ton sur ses demandes, redressement detecte
  // ======================================================================
  app.get('/intel/customers/:id/health', agent, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const c = await one('SELECT id, name, company, tier FROM customers WHERE id=$1 AND org_id=$2', [id, org(req)]);
    if (!c) throw notFound('Client introuvable');
    const rows = await many('SELECT key, created_at, sentiment, frustration, status FROM tickets WHERE customer_id=$1 AND org_id=$2 ORDER BY created_at', [id, org(req)]);
    if (rows.length < 2) return { customer: c, status: 'unknown', series: rows };
    const fit = linreg(rows.map((r) => r.sentiment));
    const last = rows.slice(-2).map((r) => r.sentiment), first = rows.slice(0, Math.ceil(rows.length / 2)).map((r) => r.sentiment);
    const status = mean(last) > mean(first) + 0.15 ? 'recovering' : fit.slope < -0.04 ? 'declining' : 'stable';
    return { customer: c, status, slope: round(fit.slope, 3), averageSentiment: round(mean(rows.map((r) => r.sentiment)), 2), lastSentiment: round(rows.at(-1).sentiment, 2), tickets: rows.length,
      series: rows.map((r) => ({ key: r.key, at: r.created_at, sentiment: round(r.sentiment, 2), frustration: round(r.frustration, 2) })) };
  });

  // ======================================================================
  // 29. Recommandation d'assignation : competences + langue + charge + disponibilite horaire + experience reelle
  // ======================================================================
  app.post('/intel/assign/recommend', agent, async (req) => {
    const { ticketId } = z.object({ ticketId: uuid }).parse(req.body);
    const t = await one('SELECT id, title, body, component, lang, tags, priority FROM tickets WHERE id=$1 AND org_id=$2', [ticketId, org(req)]);
    if (!t) throw notFound('Ticket introuvable');
    const members = await many(
      `SELECT u.id, u.display_name, m.skills, m.languages, m.timezone,
              (SELECT count(*) FROM tickets x WHERE x.assignee_id=u.id AND x.org_id=m.org_id AND x.status IN ('open','pending'))::int AS load,
              (SELECT count(*) FROM tickets x WHERE x.assignee_id=u.id AND x.org_id=m.org_id AND x.component IS NOT DISTINCT FROM $2 AND x.resolved_at IS NOT NULL AND x.reopened_count=0)::int AS clean_solved
         FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND u.disabled=false AND m.role IN ('agent','admin','owner')`, [org(req), t.component]);
    const maxLoad = Math.max(1, ...members.map((m) => m.load)), maxSolved = Math.max(1, ...members.map((m) => m.clean_solved));
    const want = new Set([t.component, ...(t.tags ?? [])].filter(Boolean).map((s) => s.toLowerCase()));
    const ranked = members.map((m) => {
      const skill = [...want].some((w) => (m.skills ?? []).map((s) => s.toLowerCase()).includes(w));
      const lang = (m.languages ?? []).includes(t.lang);
      const p = localParts(new Date(), m.timezone || 'UTC');
      const working = p.hour >= 8 && p.hour < 19 && !['Sat', 'Sun'].includes(p.weekday);
      const parts = { skill: skill ? 1 : 0, language: lang ? 1 : 0, availability: working ? 1 : 0, freeCapacity: round(1 - m.load / maxLoad, 2), experience: round(m.clean_solved / maxSolved, 2) };
      const score = 0.3 * parts.skill + 0.2 * parts.language + 0.15 * parts.availability + 0.2 * parts.freeCapacity + 0.15 * parts.experience;
      return { userId: m.id, name: m.display_name, score: round(score, 3), openLoad: m.load, parts };
    }).sort((a, b) => b.score - a.score);
    return { ticketId, recommendation: ranked[0] ?? null, ranking: ranked.slice(0, 5) };
  });

  // ======================================================================
  // 30. Cartographie des sujets : TF-IDF + regroupement par meneur, mots-cles et indicateurs par sujet
  // ======================================================================
  app.get('/intel/topics', agent, async (req) => {
    const rows = await many(`SELECT id, key, title, body, status, frustration, created_at FROM tickets WHERE org_id=$1 AND created_at > now() - interval '60 days' ORDER BY created_at DESC LIMIT 600`, [org(req)]);
    const vecs = tfidf(rows.map((r) => `${r.title} ${r.title} ${r.body}`));
    const clusters = [];
    rows.forEach((r, i) => {
      let best = null, bs = 0.27;
      for (const c of clusters) { const s = dot(vecs[i], c.centroid); if (s > bs) { bs = s; best = c; } }
      if (best) { best.items.push(i); for (const [w, x] of vecs[i]) best.centroid.set(w, (best.centroid.get(w) ?? 0) + x / best.items.length); }
      else clusters.push({ centroid: new Map(vecs[i]), items: [i] });
    });
    const topics = clusters.filter((c) => c.items.length >= 3).map((c) => {
      const agg = new Map(); for (const i of c.items) for (const [w, x] of vecs[i]) agg.set(w, (agg.get(w) ?? 0) + x);
      const its = c.items.map((i) => rows[i]); const open = its.filter((x) => ['open', 'pending'].includes(x.status));
      return { size: its.length, open: open.length, terms: [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w]) => w), avgFrustration: round(mean(its.map((x) => x.frustration)), 2),
        oldestOpenDays: open.length ? round((Date.now() - Math.min(...open.map((x) => +new Date(x.created_at)))) / DAY, 1) : 0, sample: its.slice(0, 3).map((x) => ({ id: x.id, key: x.key, title: x.title })) };
    }).sort((a, b) => b.size - a.size).slice(0, 12);
    return { analysed: rows.length, topics };
  });

  // ======================================================================
  // 31. Prevision de vidage du backlog : Monte Carlo sur le debit et les arrivees reels (bootstrap)
  // ======================================================================
  app.get('/intel/backlog/forecast', agent, async (req) => {
    const days = await many(
      `SELECT d::date AS day,
              (SELECT count(*)::int FROM tickets t WHERE t.org_id=$1 AND t.created_at::date=d::date) AS created,
              (SELECT count(*)::int FROM tickets t WHERE t.org_id=$1 AND t.resolved_at::date=d::date) AS resolved
         FROM generate_series(current_date - 27, current_date - 1, interval '1 day') d`, [org(req)]);
    const openNow = (await one(`SELECT count(*)::int AS n FROM tickets WHERE org_id=$1 AND status IN ('open','pending')`, [org(req)])).n;
    const arr = days.map((d) => d.created), thr = days.map((d) => d.resolved);
    const meanArr = mean(arr), meanThr = mean(thr);
    const rand = rng(7), runs = [];
    for (let s = 0; s < 1500; s++) {
      let backlog = openNow, d = 0;
      while (backlog > 0 && d < 120) { backlog += arr[Math.floor(rand() * arr.length)] - thr[Math.floor(rand() * thr.length)]; d++; }
      runs.push(backlog > 0 ? Infinity : d);
    }
    runs.sort((a, b) => a - b);
    const q = (p) => { const v = runs[Math.floor(p * (runs.length - 1))]; return Number.isFinite(v) ? v : null; };
    return { openNow, averageArrivalsPerDay: round(meanArr, 1), averageThroughputPerDay: round(meanThr, 1), netPerDay: round(meanThr - meanArr, 1),
      stable: meanThr >= meanArr, p50Days: q(0.5), p90Days: q(0.9), probabilityClearedIn7Days: round(runs.filter((r) => r <= 7).length / runs.length, 2), simulations: runs.length };
  });

  // ======================================================================
  // 32. Grappes de doublons parmi les demandes ouvertes (union-find sur la similarite MinHash)
  // ======================================================================
  app.get('/intel/duplicates/clusters', agent, async (req) => {
    const rows = await many(`SELECT t.id, t.key, t.title, t.minhash, t.created_at, t.customer_id FROM tickets t WHERE t.org_id=$1 AND t.status IN ('open','pending') ORDER BY t.created_at LIMIT 400`, [org(req)]);
    const parent = rows.map((_, i) => i); const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) if (rows[i].minhash?.length && minhashSimilarity(rows[i].minhash, rows[j].minhash) >= 0.55) parent[find(j)] = find(i);
    const groups = new Map(); rows.forEach((r, i) => { const g = find(i); (groups.get(g) ?? groups.set(g, []).get(g)).push(r); });
    const clusters = [...groups.values()].filter((g) => g.length >= 2).map((g) => ({
      primary: { id: g[0].id, key: g[0].key, title: g[0].title }, size: g.length, customers: new Set(g.map((x) => x.customer_id).filter(Boolean)).size,
      mergeCandidates: g.slice(1).map((x) => ({ id: x.id, key: x.key, title: x.title, similarity: round(minhashSimilarity(g[0].minhash, x.minhash), 2) })),
    })).sort((a, b) => b.size - a.size);
    return { openAnalysed: rows.length, clusters, mergeable: clusters.reduce((s, c) => s + c.size - 1, 0) };
  });

  // ======================================================================
  // 33. Effort client : allers-retours, reassignations, reouvertures et plus longue attente
  // ======================================================================
  app.get('/intel/effort', agent, async (req) => {
    const rows = await many(
      `SELECT t.id, t.key, t.title, t.status, t.reopened_count,
              (SELECT count(*) FROM ticket_comments c WHERE c.ticket_id=t.id AND c.author_is_customer)::int AS customer_messages,
              (SELECT count(*) FROM ticket_events e WHERE e.ticket_id=t.id AND e.type='updated' AND e.data->>'field'='assigneeId')::int AS reassignments,
              coalesce((SELECT max(EXTRACT(EPOCH FROM (nxt - cur))/3600) FROM (
                 SELECT c.created_at AS cur, (SELECT min(a.created_at) FROM ticket_comments a WHERE a.ticket_id=c.ticket_id AND NOT a.author_is_customer AND NOT a.internal AND a.created_at > c.created_at) AS nxt
                   FROM ticket_comments c WHERE c.ticket_id=t.id AND c.author_is_customer) g WHERE nxt IS NOT NULL), 0) AS longest_wait_h
         FROM tickets t WHERE t.org_id=$1 AND t.created_at > now() - interval '60 days'`, [org(req)]);
    const scored = rows.map((r) => ({ id: r.id, key: r.key, title: r.title, status: r.status, customerMessages: r.customer_messages, reassignments: r.reassignments, reopened: r.reopened_count, longestWaitHours: round(r.longest_wait_h, 1),
      effort: round(0.3 * Math.min(r.customer_messages / 6, 1) + 0.25 * Math.min(r.reassignments / 3, 1) + 0.25 * Math.min(r.reopened_count / 2, 1) + 0.2 * Math.min(r.longest_wait_h / 48, 1), 3) }))
      .sort((a, b) => b.effort - a.effort);
    return { averageEffort: round(mean(scored.map((s) => s.effort)), 3), tickets: scored.slice(0, 10) };
  });

  // ======================================================================
  // 34. Coaching d'agent : metriques de ses reponses comparees a la mediane de l'equipe
  // ======================================================================
  const replyMetrics = (replies) => {
    const n = replies.length || 1; const words = replies.map((b) => (b.match(/\S+/g) ?? []).length);
    const sents = replies.flatMap((b) => b.split(/[.!?]+\s/).filter(Boolean)).map((s) => (s.match(/\S+/g) ?? []).length);
    const rate = (re) => round(replies.filter((b) => re.test(b)).length / n, 2);
    return { replies: replies.length, averageWords: round(mean(words), 1), averageSentenceWords: round(mean(sents), 1),
      empathyRate: rate(/\b(desole|desolee|sorry|apolog|comprends|understand|merci de|thank you for|merci pour)\b/i), greetingRate: rate(/\b(bonjour|bonsoir|hello|hi|dear|cher|chere)\b/i),
      closingRate: rate(/\b(cordialement|bien a vous|regards|best|sincerely|a bientot)\b/i), stepsRate: rate(/(^|\n)\s*(\d+[.)]|[-*•])\s/) };
  };
  app.get('/intel/agents/:id/coaching', agent, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const u = await one('SELECT u.id, u.display_name FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=$1 AND m.org_id=$2', [id, org(req)]);
    if (!u) throw notFound('Agent introuvable');
    const all = await many(`SELECT c.author_user_id AS uid, c.body FROM ticket_comments c JOIN tickets t ON t.id=c.ticket_id
                             WHERE t.org_id=$1 AND NOT c.author_is_customer AND NOT c.internal AND c.author_user_id IS NOT NULL AND c.created_at > now() - interval '90 days'`, [org(req)]);
    const mine = all.filter((r) => r.uid === id).map((r) => r.body);
    if (mine.length < 3) return { agent: { id: u.id, name: u.display_name }, insufficientData: true, replies: mine.length };
    const m = replyMetrics(mine), team = replyMetrics(all.map((r) => r.body));
    const frt = async (who) => { const r = await many(`SELECT EXTRACT(EPOCH FROM (first_response_at - created_at))/60 AS m FROM tickets WHERE org_id=$1 AND first_response_at IS NOT NULL ${who ? 'AND assignee_id=$2' : ''} AND created_at > now() - interval '90 days'`, who ? [org(req), id] : [org(req)]); return round(quantile(r.map((x) => x.m).sort((a, b) => a - b), 0.5), 1); };
    const frtMine = await frt(true), frtTeam = await frt(false);
    const tips = [];
    if (m.averageWords > Math.max(120, team.averageWords * 1.5)) tips.push({ code: 'too_long', value: m.averageWords, team: team.averageWords });
    if (m.averageSentenceWords > 24) tips.push({ code: 'long_sentences', value: m.averageSentenceWords });
    if (team.empathyRate > 0.1 && m.empathyRate < team.empathyRate * 0.5) tips.push({ code: 'low_empathy', value: m.empathyRate, team: team.empathyRate });
    if (m.stepsRate < team.stepsRate * 0.5 && team.stepsRate > 0.1) tips.push({ code: 'no_steps', value: m.stepsRate, team: team.stepsRate });
    if (m.greetingRate < 0.5) tips.push({ code: 'no_greeting', value: m.greetingRate });
    if (frtTeam && frtMine > frtTeam * 1.5) tips.push({ code: 'slow_first_response', value: frtMine, team: frtTeam });
    return { agent: { id: u.id, name: u.display_name }, metrics: { ...m, medianFirstResponseMinutes: frtMine }, team: { ...team, medianFirstResponseMinutes: frtTeam }, tips };
  });

  // ======================================================================
  // 35. Demandes zombies : inactives, avec la suite logique (relancer, repondre, cloturer, assigner)
  // ======================================================================
  app.get('/intel/stale', agent, async (req) => {
    const rows = await many(
      `SELECT t.id, t.key, t.title, t.priority, t.assignee_id, t.created_at,
              lc.created_at AS last_at, lc.author_is_customer AS last_is_customer
         FROM tickets t LEFT JOIN LATERAL (SELECT created_at, author_is_customer FROM ticket_comments WHERE ticket_id=t.id AND NOT internal ORDER BY created_at DESC LIMIT 1) lc ON true
        WHERE t.org_id=$1 AND t.status IN ('open','pending')`, [org(req)]);
    const items = rows.map((r) => {
      const since = new Date(r.last_at ?? r.created_at); const idleDays = (Date.now() - since) / DAY;
      const waitingOn = r.last_is_customer === false ? 'customer' : 'us';
      let action = null, p = 0;
      if (waitingOn === 'customer') { p = sigmoid(0.45 * (idleDays - 5)); action = idleDays > 10 ? 'close_candidate' : idleDays > 3 ? 'nudge_customer' : null; }
      else { p = sigmoid(0.9 * (idleDays - 1.5)); action = idleDays > 1 ? (r.assignee_id ? 'reply_now' : 'assign') : null; }
      return { id: r.id, key: r.key, title: r.title, priority: r.priority, waitingOn, idleDays: round(idleDays, 1), risk: round(p, 3), action };
    }).filter((x) => x.action).sort((a, b) => b.risk - a.risk);
    return { stale: items.slice(0, 15), total: items.length };
  });

  // ======================================================================
  // 36. Prevision de capacite : profil hebdomadaire x tendance recente, intervalle a 80 %, besoin en agents
  // ======================================================================
  app.get('/intel/capacity/forecast', agent, async (req) => {
    const hist = await many(
      `SELECT d::date AS day, EXTRACT(dow FROM d)::int AS dow, (SELECT count(*)::int FROM tickets t WHERE t.org_id=$1 AND t.created_at::date=d::date) AS n
         FROM generate_series(current_date - 55, current_date - 1, interval '1 day') d`, [org(req)]);
    const byDow = Array.from({ length: 7 }, (_, k) => mean(hist.filter((h) => h.dow === k).map((h) => h.n)));
    const recent = mean(hist.slice(-14).map((h) => h.n)), prior = mean(hist.slice(-28, -14).map((h) => h.n)) || recent || 1;
    const trend = clamp(recent / (prior || 1), 0.7, 1.4);
    const resid = hist.slice(-28).map((h) => h.n - byDow[h.dow] * trend), sd = stddev(resid);
    const thr = await one(`SELECT count(*)::int AS n FROM tickets WHERE org_id=$1 AND resolved_at > now() - interval '28 days'`, [org(req)]);
    const agents = (await one(`SELECT count(*)::int AS n FROM memberships WHERE org_id=$1 AND role IN ('agent','admin','owner')`, [org(req)])).n || 1;
    const perAgent = Math.max(0.5, thr.n / 28 / agents);
    const out = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(Date.now() + (i + 1) * DAY); const f = byDow[d.getUTCDay()] * trend;
      return { date: d.toISOString().slice(0, 10), expected: round(f, 1), low: round(Math.max(0, f - 1.28 * sd), 1), high: round(f + 1.28 * sd, 1), agentsNeeded: Math.ceil(f / perAgent), agentsNeededHigh: Math.ceil((f + 1.28 * sd) / perAgent) };
    });
    return { trend: round(trend, 2), ticketsPerAgentPerDay: round(perAgent, 1), currentAgents: agents, days: out };
  });

  // ======================================================================
  // 37. Trous de couverture : carte heure x jour des arrivees et du delai de premiere reponse (UTC)
  // ======================================================================
  app.get('/intel/coverage/gaps', agent, async (req) => {
    const rows = await many(
      `SELECT EXTRACT(dow FROM created_at)::int AS dow, EXTRACT(hour FROM created_at)::int AS hour, EXTRACT(EPOCH FROM (first_response_at - created_at))/60 AS frt
         FROM tickets WHERE org_id=$1 AND created_at > now() - interval '90 days'`, [org(req)]);
    const cells = new Map(); for (const r of rows) { const k = r.dow * 24 + r.hour; (cells.get(k) ?? cells.set(k, []).get(k)).push(r.frt); }
    const all = rows.map((r) => r.frt).filter((x) => x != null).sort((a, b) => a - b);
    const overall = quantile(all, 0.5), avgArr = rows.length / (7 * 24);
    const grid = [...cells.entries()].map(([k, v]) => { const f = v.filter((x) => x != null).sort((a, b) => a - b); return { dow: Math.floor(k / 24), hour: k % 24, arrivals: v.length, medianFirstResponseMinutes: f.length ? round(quantile(f, 0.5), 1) : null, unanswered: v.length - f.length }; });
    const gaps = grid.filter((c) => c.arrivals >= Math.max(2, avgArr) && ((c.medianFirstResponseMinutes ?? Infinity) > overall * 1.5 || c.unanswered / c.arrivals > 0.4))
      .sort((a, b) => b.arrivals * (b.medianFirstResponseMinutes ?? overall * 3) - a.arrivals * (a.medianFirstResponseMinutes ?? overall * 3)).slice(0, 6);
    return { timezone: 'UTC', overallMedianFirstResponseMinutes: round(overall, 1), grid, gaps };
  });

  // ======================================================================
  // 38. Impact reel des articles : resolution des tickets qui les utilisent vs tickets comparables qui ne les utilisent pas
  // ======================================================================
  app.get('/intel/kb/impact', agent, async (req) => {
    const rows = await many(
      `SELECT t.id, t.component, EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))/3600 AS hrs, t.reopened_count,
              coalesce(array_agg(l.article_id) FILTER (WHERE l.relation='used'), '{}') AS used
         FROM tickets t LEFT JOIN ticket_kb_links l ON l.ticket_id=t.id WHERE t.org_id=$1 AND t.resolved_at IS NOT NULL GROUP BY t.id`, [org(req)]);
    const arts = await many('SELECT id, title FROM kb_articles WHERE org_id=$1', [org(req)]);
    const med = (a) => quantile(a.map((x) => x.hrs).sort((x, y) => x - y), 0.5);
    const out = [];
    for (const a of arts) {
      const treated = rows.filter((r) => r.used.includes(a.id)); if (treated.length < 2) continue;
      const comps = new Set(treated.map((r) => r.component));
      const control = rows.filter((r) => !r.used.includes(a.id) && comps.has(r.component)); if (control.length < 3) continue;
      out.push({ id: a.id, title: a.title, usedOn: treated.length, controlSize: control.length, medianHoursWith: round(med(treated), 1), medianHoursWithout: round(med(control), 1),
        hoursSavedPerTicket: round(med(control) - med(treated), 1), reopenRateWith: round(mean(treated.map((r) => (r.reopened_count > 0 ? 1 : 0))), 2), reopenRateWithout: round(mean(control.map((r) => (r.reopened_count > 0 ? 1 : 0))), 2) });
    }
    return { caveat: 'observational', articles: out.sort((a, b) => b.hoursSavedPerTicket * b.usedOn - a.hoursSavedPerTicket * a.usedOn) };
  });

  // ======================================================================
  // 39. Risque de deploiement : historique de regressions du composant, jour, charge actuelle, meilleure fenetre
  // ======================================================================
  app.get('/intel/deploys/risk', agent, async (req) => {
    const { component } = z.object({ component: z.string().min(1).max(60) }).parse(req.query);
    const deploys = await many(`SELECT deployed_at FROM deploys WHERE org_id=$1 AND component=$2 AND deployed_at > now() - interval '365 days'`, [org(req), component]);
    let regressions = 0; const ratios = [];
    for (const d of deploys) {
      const r = await one(`SELECT count(*) FILTER (WHERE created_at BETWEEN $3::timestamptz - interval '24 hours' AND $3::timestamptz)::int AS b, count(*) FILTER (WHERE created_at BETWEEN $3::timestamptz AND $3::timestamptz + interval '24 hours')::int AS a
                              FROM tickets WHERE org_id=$1 AND component=$2`, [org(req), component, d.deployed_at]);
      const ratio = (r.a + 1) / (r.b + 1); ratios.push(ratio); if (r.a >= 3 && ratio >= 2) regressions++;
    }
    const open = (await one(`SELECT count(*)::int AS n FROM tickets WHERE org_id=$1 AND component=$2 AND status IN ('open','pending')`, [org(req), component])).n;
    const dow = new Date().getUTCDay(); const riskyDay = dow === 5 || dow === 6 || dow === 0;
    const histRate = (regressions + 0.5) / (deploys.length + 1);
    const factors = [{ code: 'history', value: round(histRate, 2) }, { code: 'open_load', value: open }, ...(riskyDay ? [{ code: 'weekend_window', value: 1 }] : [])];
    const risk = round(clamp(0.55 * histRate + 0.25 * Math.min(open / 10, 1) + (riskyDay ? 0.2 : 0), 0, 1), 2);
    const arrivals = await many(`SELECT EXTRACT(dow FROM created_at)::int AS dow, EXTRACT(hour FROM created_at)::int AS hour, count(*)::int AS n FROM tickets WHERE org_id=$1 AND created_at > now() - interval '90 days' AND EXTRACT(dow FROM created_at) BETWEEN 2 AND 4 GROUP BY 1,2 ORDER BY n, dow, hour LIMIT 1`, [org(req)]);
    return { component, risk, level: risk > 0.6 ? 'high' : risk > 0.35 ? 'medium' : 'low', factors, pastDeploys: deploys.length, regressions, averageRatio: round(mean(ratios), 2), bestWindow: arrivals[0] ? { dow: arrivals[0].dow, hourUtc: arrivals[0].hour } : null };
  });

  // ======================================================================
  // 40. Composants qui en entrainent d'autres : correlation croisee a retard (0 a 3 jours)
  // ======================================================================
  app.get('/intel/components/lead-lag', agent, async (req) => {
    const rows = await many(`SELECT component, created_at::date AS day, count(*)::int AS n FROM tickets WHERE org_id=$1 AND component IS NOT NULL AND created_at > now() - interval '60 days' GROUP BY 1,2`, [org(req)]);
    const days = Array.from({ length: 60 }, (_, i) => new Date(Date.now() - (59 - i) * DAY).toISOString().slice(0, 10));
    const comps = [...new Set(rows.map((r) => r.component))];
    const series = Object.fromEntries(comps.map((c) => [c, days.map((d) => rows.find((r) => r.component === c && r.day.toISOString().slice(0, 10) === d)?.n ?? 0)]));
    const pairs = [];
    for (const a of comps) for (const b of comps) {
      if (a === b) continue;
      let best = { lag: 0, r: 0 };
      for (let k = 1; k <= 3; k++) { const r = pearson(series[a].slice(0, 60 - k), series[b].slice(k)); if (Math.abs(r) > Math.abs(best.r)) best = { lag: k, r }; }
      if (best.r >= 0.45) pairs.push({ leader: a, follower: b, lagDays: best.lag, correlation: round(best.r, 2), sameDay: round(pearson(series[a], series[b]), 2) });
    }
    return { pairs: pairs.sort((x, y) => y.correlation - x.correlation).slice(0, 8), days: 60 };
  });

  // ======================================================================
  // 41. Segments de clients : k-means (k=4, initialisation deterministe) sur recence, frequence, gravite, ton
  // ======================================================================
  app.get('/intel/customers/segments', agent, async (req) => {
    const rows = await many(
      `SELECT c.id, c.name, c.tier, EXTRACT(EPOCH FROM (now() - max(t.created_at)))/86400 AS recency, count(*) FILTER (WHERE t.created_at > now() - interval '90 days')::int AS freq,
              avg(CASE t.priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) AS severity, avg(t.sentiment) AS tone
         FROM customers c JOIN tickets t ON t.customer_id=c.id WHERE c.org_id=$1 AND t.created_at > now() - interval '180 days' GROUP BY c.id`, [org(req)]);
    if (rows.length < 4) return { insufficientData: true, customers: rows.length };
    const raw = rows.map((r) => [r.recency, r.freq, Number(r.severity), Number(r.tone)]);
    const mu = [0, 1, 2, 3].map((j) => mean(raw.map((x) => x[j]))), sd = [0, 1, 2, 3].map((j) => stddev(raw.map((x) => x[j])) || 1);
    const X = raw.map((x) => x.map((v, j) => (v - mu[j]) / sd[j]));
    // Initialisation "farthest-point" deterministe : on part du client le plus proche de la moyenne, puis on ajoute
    // a chaque fois le plus eloigne des centres deja choisis (evite les centres confondus quand des valeurs sont ex aequo).
    const d2 = (a, b) => a.reduce((s, v, j) => s + (v - b[j]) ** 2, 0);
    const K = Math.min(4, X.length);
    const chosen = [X.reduce((bi, x, i) => (d2(x, [0, 0, 0, 0]) < d2(X[bi], [0, 0, 0, 0]) ? i : bi), 0)];
    while (chosen.length < K) chosen.push(X.reduce((bi, x, i) => (Math.min(...chosen.map((c) => d2(x, X[c]))) > Math.min(...chosen.map((c) => d2(X[bi], X[c]))) ? i : bi), 0));
    let cents = chosen.map((i) => [...X[i]]); let assign = [];
    for (let it = 0; it < 25; it++) {
      assign = X.map((x) => cents.reduce((bi, c, i) => (c.reduce((s, v, j) => s + (v - x[j]) ** 2, 0) < cents[bi].reduce((s, v, j) => s + (v - x[j]) ** 2, 0) ? i : bi), 0));
      cents = cents.map((c, i) => { const m = X.filter((_, k) => assign[k] === i); return m.length ? c.map((_, j) => mean(m.map((x) => x[j]))) : c; });
    }
    const name = (c) => (c[3] < -0.4 && c[1] > 0 ? 'struggling' : c[2] > 0.5 ? 'critical_users' : c[0] > 0.5 ? 'dormant' : c[3] > 0.2 ? 'healthy' : 'steady');
    const segments = cents.map((c, i) => {
      const members = rows.filter((_, k) => assign[k] === i); if (!members.length) return null;
      return { code: name(c), size: members.length, averageTickets90d: round(mean(members.map((m) => m.freq)), 1), averageTone: round(mean(members.map((m) => Number(m.tone))), 2), averageRecencyDays: round(mean(members.map((m) => m.recency)), 0),
        customers: members.slice(0, 6).map((m) => ({ id: m.id, name: m.name, tier: m.tier })) };
    }).filter(Boolean).sort((a, b) => b.size - a.size);
    return { customers: rows.length, segments };
  });

  // ======================================================================
  // 42. Prochaine meilleure action : une file unique, classee, avec les raisons chiffrees
  // ======================================================================
  app.get('/intel/next-best', agent, async (req) => {
    const rows = await many(
      `SELECT t.id, t.key, t.title, t.priority, t.frustration, t.created_at, t.first_response_at, t.assignee_id, c.tier, p.first_response_mins, p.resolve_mins
         FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN sla_policies p ON p.org_id=t.org_id AND p.priority=t.priority
        WHERE t.org_id=$1 AND t.status IN ('open','pending') AND (t.assignee_id=$2 OR t.assignee_id IS NULL)`, [org(req), req.auth.userId]);
    const items = rows.map((r) => {
      const el = (Date.now() - new Date(r.created_at)) / 60000;
      const sla = r.resolve_mins ? clamp(el / r.resolve_mins, 0, 1.5) : 0, frt = !r.first_response_at && r.first_response_mins ? clamp(el / r.first_response_mins, 0, 1.5) : 0;
      const tier = TIER_W[r.tier ?? 'standard'];
      const score = 0.35 * Math.max(sla, frt) + 0.25 * r.frustration + 0.2 * tier + 0.2 * PRIO_W[r.priority] / 4;
      const reasons = [];
      if (frt >= 0.8) reasons.push({ code: 'first_response_due', value: round(frt, 2) });
      if (sla >= 0.6) reasons.push({ code: 'sla_pressure', value: round(sla, 2) });
      if (r.frustration > 0.5) reasons.push({ code: 'frustrated', value: round(r.frustration, 2) });
      if (tier > 0) reasons.push({ code: 'tier', value: r.tier });
      if (!r.assignee_id) reasons.push({ code: 'unassigned', value: 1 });
      return { id: r.id, key: r.key, title: r.title, priority: r.priority, score: round(score, 3), reasons };
    }).sort((a, b) => b.score - a.score);
    return { items: items.slice(0, 10), considered: rows.length };
  });

  // ======================================================================
  // 43. Macros a creer : phrases que les agents retapent sans cesse (regroupement par recouvrement de mots)
  // ======================================================================
  app.get('/intel/macros', agent, async (req) => {
    const rows = await many(`SELECT c.ticket_id, c.author_user_id, c.body FROM ticket_comments c JOIN tickets t ON t.id=c.ticket_id
                              WHERE t.org_id=$1 AND NOT c.author_is_customer AND NOT c.internal AND c.created_at > now() - interval '180 days'`, [org(req)]);
    const groups = [];
    for (const r of rows) for (const s of sentences(r.body)) {
      const words = (s.match(/\S+/g) ?? []).length; if (words < 6 || words > 40) continue;
      const set = new Set(tokenize(s)); if (set.size < 4) continue;
      let g = groups.find((x) => jaccard(x.set, set) >= 0.7);
      if (!g) { g = { set, texts: new Map(), tickets: new Set(), agents: new Set() }; groups.push(g); }
      g.texts.set(s, (g.texts.get(s) ?? 0) + 1); g.tickets.add(r.ticket_id); if (r.author_user_id) g.agents.add(r.author_user_id);
    }
    const macros = groups.filter((g) => g.tickets.size >= 3).map((g) => ({ text: [...g.texts.entries()].sort((a, b) => b[1] - a[1])[0][0], uses: [...g.texts.values()].reduce((a, b) => a + b, 0), distinctTickets: g.tickets.size, agents: g.agents.size }))
      .sort((a, b) => b.distinctTickets - a.distinctTickets).slice(0, 12);
    return { analysedReplies: rows.length, macros };
  });

  // ======================================================================
  // 44. Bascule de ton dans un fil : chute de sentiment du client, et la reponse qui l'a precedee
  // ======================================================================
  app.get('/intel/tickets/:id/tone-shift', agent, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const t = await one('SELECT id FROM tickets WHERE id=$1 AND org_id=$2', [id, org(req)]); if (!t) throw notFound('Ticket introuvable');
    const msgs = await many(`SELECT c.author_is_customer AS customer, c.body, c.sentiment, c.created_at, u.display_name AS author FROM ticket_comments c LEFT JOIN users u ON u.id=c.author_user_id WHERE c.ticket_id=$1 AND NOT c.internal ORDER BY c.created_at`, [id]);
    const shifts = [];
    let prevCustomer = null, between = null;
    for (const m of msgs) {
      if (m.customer) {
        if (prevCustomer && between && prevCustomer.sentiment - m.sentiment >= 0.3) shifts.push({ drop: round(prevCustomer.sentiment - m.sentiment, 2), at: m.created_at, from: round(prevCustomer.sentiment, 2), to: round(m.sentiment, 2), triggerReply: { author: between.author, excerpt: excerpt(between.body, 160) } });
        prevCustomer = m; between = null;
      } else if (prevCustomer) between = m;
    }
    const cust = msgs.filter((m) => m.customer);
    return { messages: msgs.length, customerMessages: cust.length, shifts, escalationRisk: shifts.length ? 'high' : cust.length >= 2 && cust.at(-1).sentiment < cust[0].sentiment - 0.2 ? 'medium' : 'low' };
  });

  // ======================================================================
  // 45. Resume extractif : TextRank (PageRank sur un graphe de similarite entre phrases)
  // ======================================================================
  app.get('/intel/tickets/:id/summary', agent, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const t = await one('SELECT id, title, body, created_at, first_response_at, resolved_at, status FROM tickets WHERE id=$1 AND org_id=$2', [id, org(req)]); if (!t) throw notFound('Ticket introuvable');
    const msgs = await many('SELECT author_is_customer AS customer, body, created_at FROM ticket_comments WHERE ticket_id=$1 AND NOT internal ORDER BY created_at', [id]);
    const sents = [...sentences(t.body).map((s) => ({ s, customer: true })), ...msgs.flatMap((m) => sentences(m.body).map((s) => ({ s, customer: m.customer })))].filter((x) => x.s.split(/\s+/).length >= 4);
    if (sents.length < 3) return { sentences: sents.map((x) => ({ text: x.s, from: x.customer ? 'customer' : 'agent' })), messages: msgs.length };
    const toks = sents.map((x) => tokenize(x.s)); const n = sents.length;
    const W = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : cosine(toks[i], toks[j]))));
    let pr = Array(n).fill(1 / n);
    for (let it = 0; it < 30; it++) pr = pr.map((_, i) => 0.15 / n + 0.85 * W.reduce((s, row, j) => { const out = row.reduce((a, b) => a + b, 0); return s + (out ? (W[j][i] / out) * pr[j] : 0); }, 0));
    const top = pr.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, i]) => i).sort((a, b) => a - b);
    return { sentences: top.map((i) => ({ text: sents[i].s, from: sents[i].customer ? 'customer' : 'agent' })), messages: msgs.length,
      ageHours: round((Date.now() - new Date(t.created_at)) / HOUR, 1), firstResponseMinutes: t.first_response_at ? round((new Date(t.first_response_at) - new Date(t.created_at)) / 60000, 0) : null, status: t.status };
  });

  // ======================================================================
  // 46. Facteur bus : composants dont la connaissance repose sur une seule personne
  // ======================================================================
  app.get('/intel/team/bus-factor', agent, async (req) => {
    const rows = await many(`SELECT t.component, u.display_name AS name, u.id AS uid, count(*)::int AS n FROM tickets t JOIN users u ON u.id=t.assignee_id
                              WHERE t.org_id=$1 AND t.component IS NOT NULL AND t.resolved_at IS NOT NULL AND t.created_at > now() - interval '180 days' GROUP BY 1,2,3`, [org(req)]);
    const by = new Map(); for (const r of rows) (by.get(r.component) ?? by.set(r.component, []).get(r.component)).push(r);
    const components = [...by.entries()].map(([component, a]) => { const total = a.reduce((s, x) => s + x.n, 0); const top = a.sort((x, y) => y.n - x.n)[0]; return { component, resolved: total, topAgent: { id: top.uid, name: top.name }, share: round(top.n / total, 2), contributors: a.length, atRisk: total >= 5 && top.n / total >= 0.7 }; })
      .sort((x, y) => y.share - x.share);
    return { components, atRisk: components.filter((c) => c.atRisk).length };
  });

  // ======================================================================
  // 47. Equite de traitement : inversions de priorite (un dossier moins urgent servi avant un plus urgent)
  // ======================================================================
  app.get('/intel/fairness', agent, async (req) => {
    const rows = await many(`SELECT t.id, t.key, t.title, t.priority, t.created_at, t.first_response_at, c.tier FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id
                              WHERE t.org_id=$1 AND t.created_at > now() - interval '7 days' AND t.status IN ('open','pending','resolved')`, [org(req)]);
    const rank = (r) => PRIO_W[r.priority] * 10 + TIER_W[r.tier ?? 'standard'] * 6;
    const waiting = rows.filter((r) => !r.first_response_at), served = rows.filter((r) => r.first_response_at);
    const list = waiting.map((w) => {
      const jumped = served.filter((s) => new Date(s.created_at) > new Date(w.created_at) && rank(s) < rank(w));
      return { id: w.id, key: w.key, title: w.title, priority: w.priority, tier: w.tier ?? 'standard', waitingHours: round((Date.now() - new Date(w.created_at)) / HOUR, 1), servedBefore: jumped.length, example: jumped[0] ? { key: jumped[0].key, priority: jumped[0].priority } : null };
    }).filter((x) => x.servedBefore > 0).sort((a, b) => b.servedBefore - a.servedBefore).slice(0, 10);
    return { waitingWithoutReply: waiting.length, inversions: list.length, items: list };
  });

  // ======================================================================
  // 48. Audit de fuites : donnees personnelles presentes dans des reponses deja envoyees aux clients
  // ======================================================================
  app.get('/intel/pii/audit', { preHandler: app.guard('admin') }, async (req) => {
    const rows = await many(`SELECT c.id, c.body, c.created_at, t.key, u.display_name AS agent FROM ticket_comments c JOIN tickets t ON t.id=c.ticket_id LEFT JOIN users u ON u.id=c.author_user_id
                              WHERE t.org_id=$1 AND NOT c.author_is_customer AND NOT c.internal AND c.created_at > now() - interval '90 days'`, [org(req)]);
    const kinds = {}, agents = {}, findings = [];
    for (const r of rows) {
      const f = redactPII(r.body).findings; if (!f.length) continue;
      for (const x of f) kinds[x.kind] = (kinds[x.kind] ?? 0) + 1;
      agents[r.agent ?? '?'] = (agents[r.agent ?? '?'] ?? 0) + f.length;
      findings.push({ ticket: r.key, agent: r.agent, at: r.created_at, kinds: [...new Set(f.map((x) => x.kind))], preview: excerpt(redactPII(r.body).text, 120) });
    }
    return { scannedReplies: rows.length, leaks: findings.length, byKind: kinds, byAgent: Object.entries(agents).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n), findings: findings.slice(0, 10) };
  });

  void badRequest;
}
