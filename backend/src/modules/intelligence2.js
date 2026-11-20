import { z } from 'zod';
import { many, one } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { clamp, cusum, linreg, mean, quantile, round } from '../lib/stats.js';
import { BM25, excerpt, tokenize } from '../lib/text.js';
import { searchKb } from './core.js';
import { sentences } from './intelligence.js';
import { mlCall, mlConfigured, mlOpen, resetMlBreaker, scrub } from '../lib/ml.js';

const uuid = z.string().uuid();
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Heure/jour locaux d'un instant dans un fuseau IANA (repli UTC si fuseau invalide). */
/**
 * Reponse sourcee, version SEMANTIQUE (service d'IA) : retrouve les phrases qui repondent a la question meme sans mot en commun
 * ou dans une autre langue (question en francais, article en anglais). Renvoie null si le service est indisponible : l'appelant
 * garde alors le resultat lexical. La confiance vient de la similarite cosinus reelle, jamais d'une valeur fixee.
 */
async function semanticAnswer(orgId, question, solved) {
  if (!mlConfigured()) return null;
  if (mlOpen()) resetMlBreaker(); // ici on peut attendre : mieux vaut patienter que conclure a tort « aucune source »
  const kb = await many('SELECT id, title, url, body, updated_at FROM kb_articles WHERE org_id=$1 ORDER BY updated_at DESC LIMIT 60', [orgId]);
  const src = [
    ...kb.map((a) => ({ type: 'kb', id: a.id, label: a.title, url: a.url, text: `${a.title}. ${a.body}`, updatedAt: a.updated_at })),
    ...solved.filter((t) => t.answers).slice(0, 80).map((t) => ({ type: 'ticket', id: t.id, label: t.key, text: t.answers })),
  ];
  const cands = [];
  src.forEach((x, si) => sentences(x.text).slice(0, 12).forEach((t, k) => { if (cands.length < 400) cands.push({ id: `${si}:${k}`, s: t, si }); }));
  if (!cands.length) return null;
  const r = await mlCall('/v1/search', { query: scrub(question), top_k: 12, candidates: cands.map((c) => ({ id: c.id, text: scrub(c.s) })) }, { timeoutMs: 50_000 });
  if (!r?.results?.length) return null;
  const byId = new Map(cands.map((c) => [c.id, c]));
  const ranked = r.results.filter((x) => byId.has(x.id)).map((x) => ({ ...byId.get(x.id), score: x.score }));
  if (!ranked.length) return null;
  const top = ranked[0].score;
  const picked = [];
  const seen = new Set();
  for (const c of ranked) {
    if (picked.length >= 4 || c.score < 0.27 || c.score < top - 0.12) break;
    const norm = c.s.toLowerCase().replace(/s+/g, ' ');
    if (seen.has(norm) || picked.filter((x) => x.si === c.si).length >= 2) continue; // meme phrase recopiee dans plusieurs tickets : une seule fois
    seen.add(norm);
    picked.push(c);
  }
  const distinct = new Set(picked.map((x) => x.si)).size;
  const kbBest = src[picked[0]?.si];
  const fresh = kbBest?.updatedAt ? ((Date.now() - new Date(kbBest.updatedAt)) / DAY < 180 ? 1 : 0.5) : 0.5;
  const confidence = picked.length ? round(clamp(0.4 + 0.75 * (top - 0.27) + 0.02 * Math.min(distinct / 2, 1) + 0.02 * fresh - 0.02, 0, 0.9), 3) : 0;
  return { sources: src, picked: picked.map((c) => ({ s: c.s, si: c.si, matched: [] })), confidence, coverage: round(top, 3), top };
}

export function localParts(date, tz = 'UTC') {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', weekday: 'short', hourCycle: 'h23' }).formatToParts(date);
    return { hour: Number(p.find((x) => x.type === 'hour').value), weekday: p.find((x) => x.type === 'weekday').value };
  } catch { return { hour: date.getUTCHours(), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()] }; }
}

export default async function intelligence2Routes(app) {
  const agent = { preHandler: app.guard('agent') };

  // ======================================================================
  // 6. Prevision de rupture de SLA par survie conditionnelle empirique
  // ======================================================================
  app.get('/intel/sla/forecast', agent, async (req) => {
    const policies = new Map((await many('SELECT * FROM sla_policies WHERE org_id=$1', [req.auth.orgId])).map((p) => [p.priority, p]));
    const hist = await many(
      `SELECT priority, EXTRACT(EPOCH FROM (resolved_at - created_at))/60 AS mins FROM tickets
        WHERE org_id=$1 AND resolved_at IS NOT NULL AND created_at > now() - interval '180 days'`, [req.auth.orgId]);
    const byPrio = {};
    for (const h of hist) (byPrio[h.priority] ??= []).push(h.mins);
    const open = await many(`SELECT id, key, title, priority, created_at, first_response_at, status FROM tickets WHERE org_id=$1 AND status IN ('open','pending')`, [req.auth.orgId]);
    const out = [];
    for (const t of open) {
      const pol = policies.get(t.priority);
      if (!pol) continue;
      const elapsed = (Date.now() - new Date(t.created_at)) / 60000;
      const durations = byPrio[t.priority] ?? [];
      const survivors = durations.filter((d) => d > elapsed);
      // P(duree > limite | duree > ecoule). Repli lineaire si historique pauvre (< 5 points).
      const pBreach = elapsed >= pol.resolve_mins ? 1
        : durations.length >= 5 && survivors.length ? survivors.filter((d) => d > pol.resolve_mins).length / survivors.length
          : clamp(elapsed / pol.resolve_mins, 0, 1);
      const frtBreached = !t.first_response_at && elapsed > pol.first_response_mins;
      const state = elapsed >= pol.resolve_mins || frtBreached ? 'breached' : pBreach >= 0.5 ? 'at_risk' : 'ok';
      const med = survivors.length ? quantile(survivors.sort((a, b) => a - b), 0.5) : null;
      out.push({
        id: t.id, key: t.key, title: t.title, priority: t.priority, state, breachProbability: round(pBreach, 3),
        minutesLeft: Math.round(pol.resolve_mins - elapsed), firstResponseOverdue: frtBreached,
        expectedResolutionMinutes: med ? Math.round(med) : null, basedOn: durations.length,
      });
    }
    out.sort((a, b) => b.breachProbability - a.breachProbability);
    return { summary: { breached: out.filter((o) => o.state === 'breached').length, atRisk: out.filter((o) => o.state === 'at_risk').length, ok: out.filter((o) => o.state === 'ok').length }, tickets: out };
  });

  // ======================================================================
  // 8. Detecteur d'incident emergent + rayon d'impact (CUSUM par composant)
  // ======================================================================
  app.get('/intel/incidents/emerging', agent, async (req) => {
    const rows = await many(
      `SELECT t.id, t.key, t.title, t.component, t.created_at, t.customer_id, c.tier, c.name AS customer
         FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id
        WHERE t.org_id=$1 AND t.created_at > now() - interval '48 hours' AND t.component IS NOT NULL`, [req.auth.orgId]);
    const now = Date.now();
    const comps = [...new Set(rows.map((r) => r.component))];
    const deploys = await many(`SELECT name, component, deployed_at FROM deploys WHERE org_id=$1 AND deployed_at > now() - interval '48 hours'`, [req.auth.orgId]);
    const incidents = [];
    for (const comp of comps) {
      const mine = rows.filter((r) => r.component === comp);
      const buckets = Array(48).fill(0);
      for (const r of mine) { const i = 47 - Math.floor((now - new Date(r.created_at)) / HOUR); if (i >= 0 && i < 48) buckets[i]++; }
      const res = cusum(buckets, { k: 0.5, h: 4, baselineLen: 36 });
      const lastHours = mine.filter((r) => now - new Date(r.created_at) < 6 * HOUR);
      if (res.alarm < 0 || lastHours.length < 3) continue;
      const customers = new Map(lastHours.filter((r) => r.customer_id).map((r) => [r.customer_id, r]));
      const near = deploys.filter((d) => d.component === comp && new Date(d.deployed_at) < new Date(lastHours.at(-1).created_at)).sort((a, b) => new Date(b.deployed_at) - new Date(a.deployed_at))[0];
      incidents.push({
        component: comp, detectedBucketHoursAgo: 47 - res.alarm, ticketsLast6h: lastHours.length, baselinePerHour: res.mu, severity: lastHours.length >= 8 ? 'major' : 'minor',
        blastRadius: { customers: customers.size, enterprise: [...customers.values()].filter((c) => c.tier === 'enterprise').length, premium: [...customers.values()].filter((c) => c.tier === 'premium').length },
        suspectedDeploy: near ? { name: near.name, hoursBefore: round((now - new Date(near.deployed_at)) / HOUR, 1) } : null,
        sample: lastHours.slice(0, 4).map((r) => ({ key: r.key, title: r.title })),
      });
    }
    return { incidents: incidents.sort((a, b) => b.ticketsLast6h - a.ticketsLast6h) };
  });

  // 9. Points de rupture du volume (quotidien) : global + par composant
  app.get('/intel/volume/changepoints', agent, async (req) => {
    const rows = await many(
      `SELECT date_trunc('day', created_at) AS d, component, count(*)::int AS n FROM tickets
        WHERE org_id=$1 AND created_at > now() - interval '60 days' GROUP BY 1,2`, [req.auth.orgId]);
    const days = Array.from({ length: 60 }, (_, i) => new Date(new Date().setUTCHours(0, 0, 0, 0) - (59 - i) * DAY).toISOString().slice(0, 10));
    const series = (filter) => days.map((d) => rows.filter((r) => r.d.toISOString().slice(0, 10) === d && filter(r)).reduce((s, r) => s + r.n, 0));
    const comps = [...new Set(rows.map((r) => r.component).filter(Boolean))];
    const mk = (name, s) => { const r = cusum(s, { k: 0.5, h: 4, baselineLen: 40 }); return { scope: name, changeDetected: r.alarm >= 0, changeDay: r.alarm >= 0 ? days[r.alarm] : null, baselinePerDay: r.mu, series: s }; };
    return { global: mk('all', series(() => true)), components: comps.map((c) => mk(c, series((r) => r.component === c))).filter((x) => x.changeDetected) };
  });

  // ======================================================================
  // 14. Radar de burn-out (heures decalees, week-ends, serie sans pause, dossiers durs)
  // ======================================================================
  app.get('/intel/team/burnout', agent, async (req) => {
    const members = await many(
      `SELECT u.id, u.display_name, m.timezone,
              (SELECT count(*) FROM tickets t WHERE t.assignee_id=u.id AND t.org_id=m.org_id AND t.status IN ('open','pending'))::int AS load
         FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.role IN ('agent','admin','owner')`, [req.auth.orgId]);
    const acts = await many(
      `SELECT c.author_user_id AS uid, c.created_at FROM ticket_comments c JOIN tickets t ON t.id=c.ticket_id
        WHERE t.org_id=$1 AND c.author_user_id IS NOT NULL AND c.created_at > now() - interval '14 days'`, [req.auth.orgId]);
    const hard = await many(
      `SELECT assignee_id AS uid, count(*)::int AS total, count(*) FILTER (WHERE frustration > 0.5 OR priority='critical')::int AS hard
         FROM tickets WHERE org_id=$1 AND assignee_id IS NOT NULL AND created_at > now() - interval '14 days' GROUP BY 1`, [req.auth.orgId]);
    const hardBy = new Map(hard.map((h) => [h.uid, h]));
    const out = members.map((m) => {
      const mine = acts.filter((a) => a.uid === m.id).map((a) => new Date(a.created_at));
      const off = mine.filter((d) => { const p = localParts(d, m.timezone); return p.hour < 8 || p.hour >= 20 || ['Sat', 'Sun'].includes(p.weekday); }).length;
      const afterRatio = mine.length ? off / mine.length : 0;
      const days = new Set(mine.map((d) => d.toISOString().slice(0, 10)));
      let streak = 0;
      for (let i = 0; i < 14; i++) { if (days.has(new Date(Date.now() - i * DAY).toISOString().slice(0, 10))) streak++; else break; }
      const h = hardBy.get(m.id);
      const hardRatio = h?.total ? h.hard / h.total : 0;
      const score = 0.35 * afterRatio + 0.25 * Math.min(streak / 10, 1) + 0.2 * hardRatio + 0.2 * Math.min(m.load / 15, 1);
      const advice = [];
      if (afterRatio > 0.3) advice.push('Activite hors horaires elevee : reequilibrer les astreintes.');
      if (streak >= 7) advice.push(`${streak} jours consecutifs d'activite : prevoir une pause.`);
      if (hardRatio > 0.5) advice.push('Majorite de dossiers difficiles : redistribuer une partie.');
      if (m.load > 12) advice.push(`${m.load} tickets ouverts : au-dessus de la charge saine.`);
      return { userId: m.id, name: m.display_name, risk: round(score, 3), level: score > 0.55 ? 'high' : score > 0.35 ? 'medium' : 'low', afterHoursShare: round(afterRatio, 2), consecutiveDays: streak, hardTicketShare: round(hardRatio, 2), openLoad: m.load, advice };
    }).sort((a, b) => b.risk - a.risk);
    return { team: out };
  });

  // ======================================================================
  // 25. Meteo d'equipe : ton des notes internes
  // ======================================================================
  app.get('/intel/team/mood', agent, async (req) => {
    const rows = await many(
      `SELECT date_trunc('day', c.created_at) AS d, avg(c.sentiment)::float AS s, count(*)::int AS n
         FROM ticket_comments c JOIN tickets t ON t.id=c.ticket_id
        WHERE t.org_id=$1 AND c.internal AND c.created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`, [req.auth.orgId]);
    if (!rows.length) return { weather: 'unknown', series: [] };
    const recent = rows.slice(-5), s = mean(recent.map((r) => r.s));
    const slope = linreg(rows.map((r) => r.s)).slope;
    const weather = s > 0.15 ? 'sunny' : s > 0 ? 'cloudy' : s > -0.15 ? 'rainy' : 'stormy';
    return { weather, score: round(s, 3), trend: slope > 0.01 ? 'improving' : slope < -0.01 ? 'worsening' : 'stable', series: rows.map((r) => ({ day: r.d.toISOString().slice(0, 10), mood: round(r.s, 3), notes: r.n })) };
  });

  // ======================================================================
  // 15. Briefing de releve d'equipe (Markdown pret a poster dans Confluence / Slack)
  // ======================================================================
  app.get('/intel/handoff', agent, async (req) => {
    const { hours } = z.object({ hours: z.coerce.number().int().min(1).max(48).default(8) }).parse(req.query);
    const [crit, waiting, esc, stats] = await Promise.all([
      many(`SELECT key, title, status, priority FROM tickets WHERE org_id=$1 AND status IN ('open','pending') AND priority IN ('critical','high') ORDER BY array_position(ARRAY['critical','high'], priority), created_at LIMIT 10`, [req.auth.orgId]),
      many(`SELECT t.key, t.title, round(EXTRACT(EPOCH FROM (now() - c.created_at))/3600) AS waiting_h FROM tickets t
            JOIN LATERAL (SELECT author_is_customer, created_at FROM ticket_comments WHERE ticket_id=t.id AND NOT internal ORDER BY created_at DESC LIMIT 1) c ON true
            WHERE t.org_id=$1 AND t.status IN ('open','pending') AND c.author_is_customer ORDER BY c.created_at LIMIT 8`, [req.auth.orgId]),
      many(`SELECT key, title, frustration FROM tickets WHERE org_id=$1 AND status IN ('open','pending') AND frustration > 0.5 ORDER BY frustration DESC LIMIT 6`, [req.auth.orgId]),
      one(`SELECT count(*) FILTER (WHERE created_at > now() - make_interval(hours => $2))::int AS created, count(*) FILTER (WHERE resolved_at > now() - make_interval(hours => $2))::int AS resolved,
                  count(*) FILTER (WHERE status IN ('open','pending'))::int AS open FROM tickets WHERE org_id=$1`, [req.auth.orgId, hours]),
    ]);
    const md = [
      `# Releve d'equipe (${hours} h)`, `**${stats.created}** crees · **${stats.resolved}** resolus · **${stats.open}** ouverts`,
      '', '## A traiter en premier', ...(crit.length ? crit.map((t) => `- [${t.priority.toUpperCase()}] ${t.key} ${t.title}`) : ['- Rien de critique.']),
      '', '## Clients en attente de reponse', ...(waiting.length ? waiting.map((t) => `- ${t.key} ${t.title} (${t.waiting_h} h)`) : ['- Aucun.']),
      '', '## Clients tendus', ...(esc.length ? esc.map((t) => `- ${t.key} ${t.title} (frustration ${round(t.frustration, 2)})`) : ['- Aucun.']),
    ].join('\n');
    return { stats, critical: crit, waitingOnUs: waiting, tense: esc, markdown: md };
  });

  // ======================================================================
  // 21. Regressions silencieuses : pics de tickets / reouvertures apres un deploiement
  // ======================================================================
  app.get('/intel/regressions', agent, async (req) => {
    const deploys = await many(`SELECT * FROM deploys WHERE org_id=$1 AND component IS NOT NULL AND deployed_at > now() - interval '60 days' ORDER BY deployed_at DESC`, [req.auth.orgId]);
    const out = [];
    for (const d of deploys) {
      const r = await one(
        `SELECT count(*) FILTER (WHERE created_at BETWEEN $3::timestamptz - interval '24 hours' AND $3::timestamptz)::int AS before,
                count(*) FILTER (WHERE created_at BETWEEN $3::timestamptz AND $3::timestamptz + interval '24 hours')::int AS after,
                count(*) FILTER (WHERE reopened_count > 0 AND updated_at BETWEEN $3::timestamptz AND $3::timestamptz + interval '72 hours')::int AS reopened
           FROM tickets WHERE org_id=$1 AND component=$2`, [req.auth.orgId, d.component, d.deployed_at]);
      const ratio = (r.after + 1) / (r.before + 1);
      if (r.after >= 3 && ratio >= 2) out.push({ deploy: { id: d.id, name: d.name, version: d.version, component: d.component, at: d.deployed_at }, ticketsBefore24h: r.before, ticketsAfter24h: r.after, ratio: round(ratio, 2), reopenedAfter: r.reopened, verdict: ratio >= 3 || r.reopened >= 2 ? 'likely_regression' : 'suspect' });
    }
    return { regressions: out.sort((a, b) => b.ratio - a.ratio) };
  });

  // ======================================================================
  // 22. ROI de la deflexion avec intervalle de confiance (bootstrap deterministe)
  // ======================================================================
  app.get('/intel/roi', agent, async (req) => {
    const rows = await many(
      `SELECT t.id, EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))/60 AS mins,
              (EXISTS (SELECT 1 FROM ticket_kb_links l WHERE l.ticket_id=t.id AND l.relation='used')
               OR EXISTS (SELECT 1 FROM answer_provenance p WHERE p.ticket_id=t.id AND p.accepted)) AS assisted
         FROM tickets t WHERE t.org_id=$1 AND t.resolved_at IS NOT NULL AND t.created_at > now() - interval '90 days'`, [req.auth.orgId]);
    const assisted = rows.filter((r) => r.assisted).map((r) => r.mins), plain = rows.filter((r) => !r.assisted).map((r) => r.mins);
    if (assisted.length < 3 || plain.length < 3) return { message: 'Pas assez de donnees comparables', assisted: assisted.length, unassisted: plain.length };
    const base = quantile([...plain].sort((a, b) => a - b), 0.5);
    let seed = 42;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const sims = Array.from({ length: 400 }, () => {
      const sample = Array.from({ length: assisted.length }, () => assisted[Math.floor(rnd() * assisted.length)]);
      return Math.max(0, base - quantile(sample.sort((a, b) => a - b), 0.5)) * assisted.length / 60;
    }).sort((a, b) => a - b);
    const point = Math.max(0, base - quantile([...assisted].sort((a, b) => a - b), 0.5)) * assisted.length / 60;
    return { assistedTickets: assisted.length, baselineMedianMinutes: round(base, 1), assistedMedianMinutes: round(quantile([...assisted].sort((a, b) => a - b), 0.5), 1), hoursSaved: round(point, 1), ci95: [round(quantile(sims, 0.025), 1), round(quantile(sims, 0.975), 1)], caveat: 'Comparaison observationnelle : les tickets assistes peuvent etre plus simples.' };
  });

  // ======================================================================
  // 23. Vocabulaire emergent : de nouveaux mots apparaissent dans les tickets
  // ======================================================================
  app.get('/intel/terms/emerging', agent, async (req) => {
    const rows = await many(`SELECT title, body, created_at FROM tickets WHERE org_id=$1 AND created_at > now() - interval '35 days'`, [req.auth.orgId]);
    const recent = rows.filter((r) => Date.now() - new Date(r.created_at) < 7 * DAY), older = rows.filter((r) => Date.now() - new Date(r.created_at) >= 7 * DAY);
    const df = (docs) => { const m = new Map(); for (const d of docs) for (const t of new Set(tokenize(`${d.title} ${d.body}`))) m.set(t, (m.get(t) ?? 0) + 1); return m; };
    const a = df(recent), b = df(older);
    const terms = [...a.entries()].filter(([, c]) => c >= 3).map(([term, c]) => {
      const lift = ((c + 1) / (recent.length + 1)) / (((b.get(term) ?? 0) + 1) / (older.length + 1));
      return { term, recentCount: c, previousCount: b.get(term) ?? 0, lift: round(lift, 2), isNew: !b.has(term) };
    }).filter((t) => t.lift >= 2).sort((x, y) => y.lift * Math.log(1 + y.recentCount) - x.lift * Math.log(1 + x.recentCount)).slice(0, 15);
    return { windowDays: 7, recentTickets: recent.length, terms };
  });

  // ======================================================================
  // 17. Reponse sourcee : extractive, citations tracables, ABSTENTION si confiance faible
  // ======================================================================
  app.post('/intel/answer', agent, async (req) => {
    // Base vide (ni article, ni resolution avec reponse) : on le dit, au lieu d'un « aucune source » qui ressemble a une panne.
    const isEmpty = async (orgId) => Number((await one(`SELECT (SELECT count(*) FROM kb_articles WHERE org_id=$1) + (SELECT count(*) FROM ticket_comments c JOIN tickets t ON t.id=c.ticket_id WHERE t.org_id=$1 AND t.status IN ('resolved','closed') AND NOT c.author_is_customer AND NOT c.internal) AS n`, [orgId])).n) === 0;
    const { question, ticketId } = z.object({ question: z.string().trim().min(5).max(2000), ticketId: uuid.optional() }).parse(req.body);
    const arts = await searchKb(req.auth.orgId, question, 3);
    const solved = await many(
      `SELECT t.id, t.key, t.title, t.body, (SELECT string_agg(c.body, E'\n' ORDER BY c.created_at) FROM ticket_comments c WHERE c.ticket_id=t.id AND NOT c.author_is_customer AND NOT c.internal) AS answers
         FROM tickets t WHERE t.org_id=$1 AND t.status IN ('resolved','closed') AND t.id IS DISTINCT FROM $2::uuid ORDER BY t.resolved_at DESC LIMIT 400`, [req.auth.orgId, ticketId ?? null]);
    const sIdx = new BM25(solved.map((s) => ({ id: s.id, text: `${s.title} ${s.body}` })));
    const sim = sIdx.search(question, 3).map((h) => ({ ...solved.find((s) => s.id === h.id), score: h.score }));
    let sources = [
      ...arts.map((a) => ({ type: 'kb', id: a.id, label: a.title, url: a.url, rank: a.score, text: a.body, updatedAt: a.updated_at })),
      ...sim.filter((s) => s.answers).map((s) => ({ type: 'ticket', id: s.id, label: s.key, rank: 0.7, text: s.answers })),
    ];
    const pool = sources.flatMap((src, si) => sentences(src.text).map((s) => ({ s, si })));
    const sem = await semanticAnswer(req.auth.orgId, question, solved).catch(() => null);
    if (!pool.length && !sem?.picked.length) {
      const saved = await one(`INSERT INTO answer_provenance(org_id, ticket_id, question, answer, confidence, citations) VALUES ($1,$2,$3,'',0,'[]') RETURNING id`, [req.auth.orgId, ticketId ?? null, question]);
      return { id: saved.id, abstained: true, confidence: 0, emptyBase: await isEmpty(req.auth.orgId), reason: 'Aucune source pertinente dans la base de connaissances ni dans les resolutions passees.', citations: [] };
    }
    const idx = new BM25(pool.map((p, i) => ({ id: i, text: p.s })));
    const qTokens = [...new Set(tokenize(question))];
    let picked = [];
    const covered = new Set();
    for (const h of idx.search(question, 12)) {
      if (picked.length >= 4) break;
      const p = pool[h.id];
      if (picked.some((x) => x.si === p.si && picked.filter((y) => y.si === p.si).length >= 2)) continue;
      picked.push({ ...p, matched: h.matched }); h.matched.forEach((m) => covered.add(m));
    }
    const wAll = qTokens.reduce((s, t) => s + idx.idf(t), 0) || 1;
    let coverage = qTokens.reduce((s, t) => s + (covered.has(t) ? idx.idf(t) : 0), 0) / wAll;
    const distinct = new Set(picked.map((p) => p.si)).size;
    const kbBest = arts[0];
    const fresh = kbBest ? ((Date.now() - new Date(kbBest.updated_at)) / DAY < 180 ? 1 : 0.5) : 0.5;
    let confidence = round(clamp(0.6 * coverage + 0.25 * Math.min(distinct / 3, 1) + 0.15 * fresh, 0, 1), 3);
    if (sem && sem.picked.length && sem.confidence > confidence) { ({ sources, picked, confidence, coverage } = sem); }
    const citations = picked.map((p) => ({ source: { type: sources[p.si].type, id: sources[p.si].id, label: sources[p.si].label, url: sources[p.si].url ?? null }, quote: p.s, matchedTerms: p.matched }));
    const abstained = confidence < 0.4;
    const answer = abstained ? '' : picked.map((p) => p.s).join(' ');
    const saved = await one(`INSERT INTO answer_provenance(org_id, ticket_id, question, answer, confidence, citations) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [req.auth.orgId, ticketId ?? null, question, answer, confidence, JSON.stringify(citations)]);
    return { id: saved.id, abstained, confidence, coverage: round(coverage, 3), semanticTop: sem?.top ?? null, answer: abstained ? null : answer, reason: abstained ? 'Confiance insuffisante : mieux vaut une reponse humaine qu\'une reponse inventee.' : undefined, citations };
  });

  app.post('/intel/answer/:id/feedback', agent, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { accepted } = z.object({ accepted: z.boolean() }).parse(req.body);
    const r = await one('UPDATE answer_provenance SET accepted=$3 WHERE id=$1 AND org_id=$2 RETURNING id, accepted', [id, req.auth.orgId, accepted]);
    if (!r) throw notFound();
    return r;
  });

  app.get('/intel/answer/:id', agent, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await one('SELECT * FROM answer_provenance WHERE id=$1 AND org_id=$2', [id, req.auth.orgId]);
    if (!r) throw notFound();
    return r;
  });

  void badRequest; void excerpt;
}
