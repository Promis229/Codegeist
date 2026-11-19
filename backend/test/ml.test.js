import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Faux service « Kairos Brain » : enregistre ce qu'il reçoit pour vérifier l'authentification et l'absence de données personnelles.
const received = [];
let mode = 'ok';
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    received.push({ url: req.url, auth: req.headers.authorization, body });
    if (mode === 'unauthorized' || req.headers.authorization !== 'Bearer test-key') { res.writeHead(401).end('{}'); return; }
    if (mode === 'down') { res.writeHead(500).end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/model') return res.end(JSON.stringify({ name: 'kairos-brain', version: '1.0.0', embedding_model: 'stub', n_train: 120, data_fingerprint: 'abc123', gates: { priority: { passed: true } } }));
    if (req.url === '/v1/search') return res.end(JSON.stringify({ model: { embedding_model: 'stub' }, results: body.candidates.slice(0, body.top_k).map((c, i) => ({ id: c.id, score: 0.9 - i * 0.05 })) }));
    if (req.url === '/v1/predict/triage') return res.end(JSON.stringify({ model: { data_fingerprint: 'abc123' }, priority: { label: 'critical', probabilities: { low: 0.02, medium: 0.08, high: 0.1, critical: 0.8 } }, component: { label: 'checkout', probabilities: { checkout: 0.7, api: 0.3 } }, evidence: [{ key: 'ACM-1', title: 'x', priority: 'critical', score: 0.9 }] }));
    if (req.url === '/v1/predict/risk') return res.end(JSON.stringify({ model: {}, resolution_hours: { p10: 1, p25: 2, p50: 4, p75: 8, p90: 16, p95: 24 }, reopen_probability: 0.2, sla_breach_probability: 0.35, evidence: [] }));
    res.writeHead(404).end('{}');
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
process.env.ML_URL = `http://127.0.0.1:${stub.address().port}`;
process.env.ML_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';

const { buildApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { seedDemo, resetDemo, DEMO } = await import('../src/db/seed.js');
const { pool, one } = await import('../src/db/pool.js');
const { outbox } = await import('../src/lib/mailer.js');
const { resetMlBreaker } = await import('../src/lib/ml.js');

let app;
const rid = Math.random().toString(36).slice(2, 8);
const call = async (method, url, { token, body } = {}) => {
  const res = await app.inject({ method, url: `/api/v1${url}`, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let json; try { json = res.json(); } catch { json = res.body; }
  return { status: res.statusCode, body: json };
};
const lastCode = (email) => [...outbox].reverse().find((m) => m.to === email)?.text.match(/\b(\d{6})\b/)?.[1];

before(async () => {
  await migrate(() => {});
  await resetDemo();
  await seedDemo(() => {});
  app = await buildApp({ logger: false });
  await app.ready();
});
after(async () => { await app.close(); await pool.end(); stub.close(); });

describe('Raccordement au service d\'IA (Kairos Brain)', () => {
  let tk, viewer, ticket, other;
  before(async () => {
    tk = (await call('POST', '/auth/login', { body: { email: DEMO.email, password: DEMO.password } })).body.accessToken;
    // clé d'API en lecture seule de l'organisation de démonstration : ne doit jamais atteindre les routes d'administration
    viewer = (await call('POST', '/api-keys', { token: tk, body: { name: `lecture-${rid}`, scopes: ['read'] } })).body.key;
    // propriétaire d'une AUTRE organisation
    const email = `ml-${rid}@example.com`;
    await call('POST', '/auth/register', { body: { email, password: 'Str0ng-Passphrase!', displayName: 'Autre', orgName: `Org ${email}` } });
    other = (await call('POST', '/auth/verify-email', { body: { email, code: lastCode(email) } })).body.accessToken;
    ticket = (await call('GET', '/tickets?status=open&limit=1', { token: tk })).body.tickets[0];
  });
  const reset = (m = 'ok') => { mode = m; resetMlBreaker(); received.length = 0; };

  it('statut : le service est joignable et la fiche du modèle est exposée', async () => {
    reset();
    const r = await call('GET', '/ml/status', { token: tk });
    assert.equal(r.status, 200);
    assert.equal(r.body.available, true);
    assert.equal(r.body.model.data_fingerprint, 'abc123');
    assert.equal(received[0].auth, 'Bearer test-key'); // authentifié par clé partagée
  });

  it("l'export d'entraînement est réservé aux admins, masque les données personnelles et est journalisé", async () => {
    assert.equal((await call('GET', '/ml/export', { token: viewer })).status, 403);
    const made = await call('POST', '/tickets', { token: tk, body: { title: `Facturation ${rid}`, body: 'Contactez-moi sur jean.dupont@example.com ou au 06 12 34 56 78 merci', priority: 'medium' } });
    assert.equal(made.status, 201);
    const r = await call('GET', '/ml/export?limit=500', { token: tk });
    assert.equal(r.status, 200);
    const mine = r.body.tickets.find((t) => t.title.includes(rid));
    assert.ok(mine);
    assert.ok(!/jean\.dupont@example\.com/.test(mine.body), 'aucun email en clair dans l\'export');
    assert.ok(r.body.tickets.length > 100 && r.body.kb.length > 3);
    assert.ok(r.body.tickets.every((t) => !('customer_email' in t)));
    const log = await one(`SELECT count(*)::int AS n FROM audit_log WHERE action='ml.export'`);
    assert.ok(log.n >= 1);
    // isolation : l'export d'une autre organisation ne contient rien de la démonstration
    const theirs = await call('GET', '/ml/export', { token: other });
    assert.equal(theirs.status, 200);
    assert.equal(theirs.body.tickets.length, 0);
    assert.equal(theirs.body.kb.length, 0);
  });

  it("recherche sémantique : classement du service, et aucune donnée personnelle ne sort du backend", async () => {
    reset();
    const r = await call('POST', '/intel/semantic/search', { token: tk, body: { query: 'Paiement impossible, écrivez à marie.curie@example.org', scope: 'tickets', limit: 5 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.engine, 'semantic');
    assert.equal(r.body.results.length, 5);
    const sent = JSON.stringify(received.find((x) => x.url === '/v1/search').body);
    assert.ok(!/marie\.curie@example\.org/.test(sent), 'la requête est masquée avant envoi');
    assert.ok(r.body.results.every((x) => x.score > 0 && x.id && x.label));
  });

  it('repli lexical si le service tombe, puis disjoncteur : il n\'est plus sollicité', async () => {
    reset('down');
    for (let i = 0; i < 3; i++) {
      const r = await call('POST', '/intel/semantic/search', { token: tk, body: { query: 'erreur 502 paiement checkout', scope: 'tickets' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.engine, 'lexical');
      assert.ok(r.body.results.length > 0, 'le repli lexical répond quand même');
    }
    const hits = received.length;
    const after3 = await call('POST', '/intel/semantic/search', { token: tk, body: { query: 'erreur 502 paiement checkout', scope: 'tickets' } });
    assert.equal(after3.body.engine, 'lexical');
    assert.equal(received.length, hits, 'disjoncteur ouvert : aucun appel supplémentaire');
    reset();
  });

  it('triage : le modèle répond, la prédiction est journalisée puis comparée à la décision finale', async () => {
    reset();
    const r = await call('POST', '/intel/triage/priority', { token: tk, body: { title: 'Paiement échoue', body: 'Erreur 502', ticketId: ticket.id } });
    assert.equal(r.body.engine, 'ml');
    assert.equal(r.body.predicted, 'critical');
    assert.equal(r.body.component.label, 'checkout');
    const logged = await one(`SELECT count(*)::int AS n FROM ml_predictions WHERE ticket_id=$1`, [ticket.id]);
    assert.equal(logged.n, 2); // priorité + composant
    // La demande est clôturée avec la priorité prédite : la justesse mesurée doit le refléter.
    await call('PATCH', `/tickets/${ticket.id}`, { token: tk, body: { priority: 'critical', status: 'resolved' } });
    const m = await call('GET', '/ml/monitoring', { token: tk });
    assert.equal(m.status, 200);
    assert.ok(m.body.tasks.priority.evaluated >= 1);
    assert.ok(m.body.tasks.priority.accuracy > 0);
    assert.equal(m.body.tasks.priority.status, 'insufficient_data'); // trop peu pour conclure : on ne prétend rien
    assert.equal((await call('GET', '/ml/monitoring', { token: viewer })).status, 403);
  });

  it('risque : délai, réouverture et SLA ; « indisponible » quand le service est coupé', async () => {
    reset();
    const ok = await call('GET', `/intel/tickets/${ticket.id}/risk`, { token: tk });
    assert.equal(ok.body.engine, 'ml');
    assert.ok(ok.body.resolutionHours.p50 <= ok.body.resolutionHours.p90);
    assert.equal(ok.body.slaBreachProbability, 0.35);
    reset('down');
    const down = await call('GET', `/intel/tickets/${ticket.id}/risk`, { token: tk });
    assert.equal(down.body.engine, 'unavailable');
    reset();
  });

  it('une clé incorrecte côté service donne un repli propre, jamais une erreur pour l\'utilisateur', async () => {
    reset('unauthorized');
    const r = await call('POST', '/intel/triage/priority', { token: tk, body: { title: 'Paiement échoue', body: 'Erreur 502' } });
    assert.equal(r.status, 200);
    assert.notEqual(r.body.engine, 'ml');
    reset();
  });
});
