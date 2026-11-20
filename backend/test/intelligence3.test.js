import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { buildApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { seedDemo, resetDemo, DEMO } = await import('../src/db/seed.js');
const { pool } = await import('../src/db/pool.js');
const { outbox } = await import('../src/lib/mailer.js');

let app;
const rid = Math.random().toString(36).slice(2, 8);
const call = async (method, url, { token, body } = {}) => {
  const res = await app.inject({ method, url: `/api/v1${url}`, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let json; try { json = res.json(); } catch { json = res.body; }
  return { status: res.statusCode, body: json };
};
const lastCode = (email) => [...outbox].reverse().find((m) => m.to === email)?.text.match(/\b(\d{6})\b/)?.[1];
async function newUser(email) {
  await call('POST', '/auth/register', { body: { email, password: 'Str0ng-Passphrase!', acceptTerms: true, acceptPrivacy: true, displayName: 'Autre', orgName: `Org ${email}` } });
  return (await call('POST', '/auth/verify-email', { body: { email, code: lastCode(email) } })).body.accessToken;
}

before(async () => {
  await migrate(() => {});
  await resetDemo();
  await seedDemo(() => {});
  app = await buildApp({ logger: false });
  await app.ready();
});
after(async () => { await app.close(); await pool.end(); });

describe('Intelligence, deuxième vague (26 à 48)', () => {
  let tk, open, solved, customer, agentId, other;
  before(async () => {
    tk = (await call('POST', '/auth/login', { body: { email: DEMO.email, password: DEMO.password } })).body.accessToken;
    open = (await call('GET', '/tickets?status=open&sort=frustration&limit=1', { token: tk })).body.tickets[0];
    solved = (await call('GET', '/tickets?status=resolved&limit=1', { token: tk })).body.tickets[0];
    customer = (await call('GET', '/customers', { token: tk })).body.customers[0];
    agentId = (await call('GET', '/members', { token: tk })).body.members.find((m) => m.role === 'agent')?.id;
    other = await newUser(`o3-${rid}@example.com`); // propriétaire d'une AUTRE organisation
  });
  const get = async (url) => { const r = await call('GET', url, { token: tk }); assert.equal(r.status, 200, `${url} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r.body; };

  it('26. triage de priorité : probabilités normalisées et mots décisifs', async () => {
    const r = await call('POST', '/intel/triage/priority', { token: tk, body: { title: 'Erreur 502 lors du paiement', body: 'Le paiement echoue en production pour tous nos clients, urgent' } });
    assert.equal(r.status, 200);
    assert.ok(Math.abs(Object.values(r.body.probabilities).reduce((a, b) => a + b, 0) - 1) < 0.02);
    assert.ok(['low', 'medium', 'high', 'critical'].includes(r.body.predicted));
  });
  it('27. ETA : quantiles croissants', async () => {
    const r = await get(`/intel/tickets/${open.id}/eta`);
    assert.ok(r.p50Hours <= r.p80Hours && r.p80Hours <= r.p95Hours);
    assert.ok(r.basedOn > 0);
  });
  it('28. santé client', async () => {
    const r = await get(`/intel/customers/${customer.id}/health`);
    assert.ok(['recovering', 'declining', 'stable', 'unknown'].includes(r.status));
  });
  it('29. assignation : classement trié, scores bornés', async () => {
    const r = await call('POST', '/intel/assign/recommend', { token: tk, body: { ticketId: open.id } });
    assert.equal(r.status, 200);
    const s = r.body.ranking.map((x) => x.score);
    assert.deepEqual(s, [...s].sort((a, b) => b - a));
    assert.ok(s.every((x) => x >= 0 && x <= 1));
  });
  it('30. sujets : chaque sujet a au moins 3 demandes et des mots-clés', async () => {
    const r = await get('/intel/topics');
    assert.ok(r.topics.length >= 1);
    assert.ok(r.topics.every((t) => t.size >= 3 && t.terms.length > 0));
  });
  it('31. backlog : probabilités et quantiles cohérents, déterministe', async () => {
    const r = await get('/intel/backlog/forecast');
    assert.ok(r.probabilityClearedIn7Days >= 0 && r.probabilityClearedIn7Days <= 1);
    assert.equal(typeof r.averageThroughputPerDay, 'number');
    assert.equal(r.stable, r.averageThroughputPerDay >= r.averageArrivalsPerDay);
    if (!r.stable) assert.equal(r.p50Days, null); // débit inférieur aux arrivées : jamais vidé
    if (r.p50Days != null && r.p90Days != null) assert.ok(r.p50Days <= r.p90Days);
    assert.deepEqual(await get('/intel/backlog/forecast'), r);
  });
  it('32. grappes de doublons fusionnables', async () => {
    const r = await get('/intel/duplicates/clusters');
    assert.ok(r.clusters.length >= 1);
    assert.equal(r.mergeable, r.clusters.reduce((s, c) => s + c.size - 1, 0));
  });
  it('33. effort client borné', async () => {
    const r = await get('/intel/effort');
    assert.ok(r.tickets.every((t) => t.effort >= 0 && t.effort <= 1));
  });
  it('34. coaching : répond pour un agent, 404 pour un inconnu', async () => {
    const r = await get(`/intel/agents/${agentId}/coaching`);
    assert.ok(r.insufficientData || r.metrics.averageWords > 0);
    assert.equal((await call('GET', '/intel/agents/00000000-0000-4000-8000-000000000000/coaching', { token: tk })).status, 404);
  });
  it('35. zombies : action et risque valides', async () => {
    const r = await get('/intel/stale');
    assert.ok(r.stale.length >= 1, 'les demandes SAML en attente du client sont inactives depuis des semaines');
    assert.ok(r.stale.every((x) => ['close_candidate', 'nudge_customer', 'reply_now', 'assign'].includes(x.action) && x.risk >= 0 && x.risk <= 1));
  });
  it('36. capacité : 7 jours, intervalle autour de la valeur attendue', async () => {
    const r = await get('/intel/capacity/forecast');
    assert.equal(r.days.length, 7);
    assert.ok(r.days.every((d) => d.low <= d.expected && d.expected <= d.high && d.agentsNeeded >= 0));
  });
  it('37. couverture horaire', async () => {
    const r = await get('/intel/coverage/gaps');
    assert.ok(r.grid.length > 0);
    assert.equal(typeof r.overallMedianFirstResponseMinutes, 'number'); // régression : les numeric PostgreSQL arrivaient en texte
    assert.ok(r.overallMedianFirstResponseMinutes > 0);
  });
  it('38. impact des articles', async () => {
    const r = await get('/intel/kb/impact');
    assert.ok(r.articles.length >= 1);
    assert.equal(r.caveat, 'observational');
    assert.ok(r.articles.every((a) => typeof a.medianHoursWith === 'number' && typeof a.medianHoursWithout === 'number' && Number.isFinite(a.hoursSavedPerTicket)));
  });
  it('39. risque de déploiement : checkout, et composant inconnu', async () => {
    const r = await get('/intel/deploys/risk?component=checkout');
    assert.ok(r.risk >= 0 && r.risk <= 1 && ['low', 'medium', 'high'].includes(r.level));
    assert.equal((await get('/intel/deploys/risk?component=inexistant')).pastDeploys, 0);
  });
  it('40. composants entraînés : corrélations valides', async () => {
    const r = await get('/intel/components/lead-lag');
    assert.ok(r.pairs.every((p) => p.lagDays >= 1 && p.lagDays <= 3 && p.correlation >= 0.45 && p.leader !== p.follower));
  });
  it('41. segments : chaque client classé exactement une fois', async () => {
    const r = await get('/intel/customers/segments');
    assert.equal(r.segments.reduce((s, x) => s + x.size, 0), r.customers);
    assert.ok(r.segments.length >= 2, 'la démo contient des profils différents (régression : centres confondus)');
  });
  it('42. prochaine meilleure action : scores décroissants', async () => {
    const r = await get('/intel/next-best');
    const s = r.items.map((x) => x.score);
    assert.deepEqual(s, [...s].sort((a, b) => b - a));
  });
  it('43. macros : au moins 3 demandes distinctes chacune', async () => {
    const r = await get('/intel/macros');
    assert.ok(r.macros.length >= 1, 'la démo contient des phrases répétées');
    assert.ok(r.macros.every((m) => m.distinctTickets >= 3));
  });
  it('44. bascule de ton', async () => {
    assert.ok(['low', 'medium', 'high'].includes((await get(`/intel/tickets/${solved.id}/tone-shift`)).escalationRisk));
  });
  it('45. résumé extractif : 3 phrases au plus', async () => {
    assert.ok((await get(`/intel/tickets/${open.id}/summary`)).sentences.length <= 3);
  });
  it('46. facteur bus : part entre 0 et 1', async () => {
    const r = await get('/intel/team/bus-factor');
    assert.ok(r.components.every((c) => c.share > 0 && c.share <= 1));
    assert.ok(r.atRisk >= 1, 'Chen Wei résout presque tout sur mobile');
  });
  it('47. équité : chaque inversion cite un dossier servi avant', async () => {
    const r = await get('/intel/fairness');
    assert.ok(r.items.length >= 1);
    assert.ok(r.items.every((x) => x.servedBefore > 0 && x.example));
  });
  it('48. audit de fuites : réservé aux admins', async () => {
    assert.ok((await get('/intel/pii/audit')).scannedReplies >= 0);
  });
  it("recherche multilingue sans modèle d'embedding : les traductions fournies par l'agent retrouvent l'autre langue", async () => {
    const q = 'Payment fails at checkout with error 502';
    const alone = await call('POST', '/intel/semantic/search', { token: tk, body: { query: q, scope: 'tickets', limit: 8 } });
    const withFr = await call('POST', '/intel/semantic/search', { token: tk, body: { query: q, variants: ['Erreur 502 lors du paiement', 'Error 502 al pagar'], scope: 'tickets', limit: 8 } });
    assert.equal(alone.status, 200);
    assert.equal(withFr.status, 200);
    assert.equal(alone.body.engine, 'lexical');
    assert.equal(withFr.body.engine, 'lexical+fusion');
    assert.equal(withFr.body.queries, 3);
    const frAlone = alone.body.results.filter((r) => r.lang === 'fr').length;
    const frFused = withFr.body.results.filter((r) => r.lang === 'fr').length;
    assert.ok(frFused > frAlone, `la fusion doit faire remonter des demandes françaises (${frAlone} -> ${frFused})`);
    assert.ok(withFr.body.results.some((r) => r.crossLingual), 'au moins un résultat est marqué « autre langue »');
    assert.ok(withFr.body.results.every((r) => r.score > 0 && r.score <= 1));
    assert.equal((await call('POST', '/intel/semantic/search', { token: tk, body: { query: q, variants: ['a', 'b', 'c', 'd', 'e'] } })).status, 400); // au plus 4 variantes
  });

  it("isolation : une autre organisation n'accède jamais aux données de la démo", async () => {
    for (const u of [`/intel/tickets/${open.id}/eta`, `/intel/tickets/${open.id}/summary`, `/intel/tickets/${solved.id}/tone-shift`, `/intel/customers/${customer.id}/health`]) {
      assert.equal((await call('GET', u, { token: other })).status, 404, u);
    }
    const assign = await call('POST', '/intel/assign/recommend', { token: other, body: { ticketId: open.id } });
    assert.equal(assign.status, 404);
    // et ses propres analyses sont vides plutôt que mélangées à celles de la démo
    const topics = await call('GET', '/intel/topics', { token: other });
    assert.equal(topics.status, 200);
    assert.equal(topics.body.analysed, 0);
  });
});
