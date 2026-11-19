import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
process.env.DEMO_LOGIN = 'false'; // ce fichier vérifie le comportement par défaut, quelle que soit la valeur du .env local
const { buildApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { seedDemo, resetDemo, DEMO } = await import('../src/db/seed.js');
const { pool } = await import('../src/db/pool.js');
const { outbox } = await import('../src/lib/mailer.js');
const { totpAt } = await import('../src/lib/crypto.js');
const { setForgeVerifier } = await import('../src/auth/forge.js');
const { verifySignature, signPayload } = await import('../src/modules/webhooks.js');

let app;
const rid = Math.random().toString(36).slice(2, 8);
const call = async (method, url, { token, body, headers } = {}) => {
  const res = await app.inject({ method, url: `/api/v1${url}`, payload: body, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  let json; try { json = res.json(); } catch { json = res.body; }
  return { status: res.statusCode, body: json };
};
const lastCode = (email) => [...outbox].reverse().find((m) => m.to === email)?.text.match(/\b(\d{6})\b/)?.[1];

async function registerAndVerify(email, password = 'Str0ng-Passphrase!') {
  const reg = await call('POST', '/auth/register', { body: { email, password, displayName: 'Test User', orgName: `Org ${email}` } });
  assert.equal(reg.status, 201);
  const ver = await call('POST', '/auth/verify-email', { body: { email, code: lastCode(email) } });
  assert.equal(ver.status, 200, JSON.stringify(ver.body));
  return { ...ver.body, password };
}

before(async () => {
  await migrate(() => {});
  await resetDemo(); // données neuves : la démo est datée « il y a X heures » et vieillit sinon
  await seedDemo(() => {});
  app = await buildApp({ logger: false });
  await app.ready();
});
after(async () => { await app.close(); await pool.end(); });

describe('Inscription et confirmation par code', () => {
  const email = `reg-${rid}@example.com`;
  it("n'ouvre AUCUNE session a l'inscription et envoie un code", async () => {
    const r = await call('POST', '/auth/register', { body: { email, password: 'Str0ng-Passphrase!', displayName: 'Reg' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.verificationRequired, true);
    assert.equal(r.body.accessToken, undefined);
    assert.match(lastCode(email), /^\d{6}$/);
  });
  it('refuse la connexion tant que l\'email n\'est pas confirme', async () => {
    const r = await call('POST', '/auth/login', { body: { email, password: 'Str0ng-Passphrase!' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'email_not_verified');
  });
  it('rejette un mauvais code puis accepte le bon et ouvre la session', async () => {
    const bad = await call('POST', '/auth/verify-email', { body: { email, code: '000000' === lastCode(email) ? '111111' : '000000' } });
    assert.equal(bad.status, 400);
    const ok = await call('POST', '/auth/verify-email', { body: { email, code: lastCode(email) } });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.accessToken);
    const again = await call('POST', '/auth/verify-email', { body: { email, code: lastCode(email) } });
    assert.equal(again.status, 400); // usage unique
  });
  it('bloque apres 5 essais errones', async () => {
    const e = `brute-${rid}@example.com`;
    await call('POST', '/auth/register', { body: { email: e, password: 'Str0ng-Passphrase!', displayName: 'B' } });
    const real = lastCode(e);
    let lastStatus;
    for (let i = 0; i < 6; i++) lastStatus = (await call('POST', '/auth/verify-email', { body: { email: e, code: real === '123456' ? '654321' : '123456' } })).status;
    assert.equal(lastStatus, 429);
    const ok = await call('POST', '/auth/verify-email', { body: { email: e, code: real } });
    assert.notEqual(ok.status, 200); // le bon code ne rattrape plus un code brule
  });
  it('rejette un mot de passe faible', async () => {
    const r = await call('POST', '/auth/register', { body: { email: `weak-${rid}@example.com`, password: 'password', displayName: 'W' } });
    assert.equal(r.status, 400);
  });
});

describe('Entrée démo : désactivée par défaut', () => {
  it("/auth/demo n'existe pas sans DEMO_LOGIN=true, et /auth/providers ne l'annonce pas", async () => {
    assert.equal((await call('POST', '/auth/demo')).status, 404);
    assert.equal((await call('GET', '/auth/providers')).body.demo, false);
  });
});

describe('Securite des sessions', () => {
  it('verrouille le compte apres 5 echecs, meme avec le bon mot de passe ensuite', async () => {
    const email = `lock-${rid}@example.com`;
    await registerAndVerify(email);
    for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/auth/login', { body: { email, password: 'wrong-password-123' } })).status, 401);
    const r = await call('POST', '/auth/login', { body: { email, password: 'Str0ng-Passphrase!' } });
    assert.equal(r.status, 423);
  });
  it("ne revele pas l'existence d'un compte", async () => {
    const a = await call('POST', '/auth/login', { body: { email: `ghost-${rid}@example.com`, password: 'whatever-123456' } });
    const b = await call('POST', '/auth/login', { body: { email: DEMO.email, password: 'whatever-123456' } });
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.equal(a.body.message, b.body.message);
  });
  it('rotation du refresh token + revocation de toute la famille en cas de rejeu', async () => {
    const s = await registerAndVerify(`rot-${rid}@example.com`);
    const r1 = await call('POST', '/auth/refresh', { body: { refreshToken: s.refreshToken } });
    assert.equal(r1.status, 200);
    // Tolérance de 10 s : deux onglets / un rechargement rapide présentent le même jeton presque en même temps.
    const twin = await call('POST', '/auth/refresh', { body: { refreshToken: s.refreshToken } });
    assert.equal(twin.status, 200, 'un rejeu immédiat (second onglet) ne doit pas déconnecter');
    assert.notEqual(twin.body.refreshToken, r1.body.refreshToken);
    assert.equal((await call('POST', '/auth/refresh', { body: { refreshToken: r1.body.refreshToken } })).status, 200, 'le premier onglet reste connecté');
    // Hors tolérance, le rejeu d'un ancien jeton = vol : toute la famille est révoquée.
    await pool.query(`UPDATE refresh_tokens SET revoked_at = now() - interval '5 minutes' WHERE token_hash = encode(sha256($1::bytea), 'hex')`, [s.refreshToken]);
    const replay = await call('POST', '/auth/refresh', { body: { refreshToken: s.refreshToken } });
    assert.equal(replay.status, 401);
    const after = await call('POST', '/auth/refresh', { body: { refreshToken: twin.body.refreshToken } }); // la famille entiere est morte
    assert.equal(after.status, 401);
  });
  it('après une déconnexion, un ancien jeton ne ressuscite pas la session, même dans la fenêtre de tolérance', async () => {
    const s = await registerAndVerify(`rot2-${rid}@example.com`);
    const r1 = await call('POST', '/auth/refresh', { body: { refreshToken: s.refreshToken } });
    assert.equal(r1.status, 200);
    await call('POST', '/auth/logout', { body: { refreshToken: r1.body.refreshToken } });
    assert.equal((await call('POST', '/auth/refresh', { body: { refreshToken: s.refreshToken } })).status, 401);
    assert.equal((await call('POST', '/auth/refresh', { body: { refreshToken: r1.body.refreshToken } })).status, 401);
  });
  it('2FA TOTP : activation, exigence a la connexion, code de secours a usage unique', async () => {
    const email = `mfa-${rid}@example.com`;
    const s = await registerAndVerify(email);
    const setup = await call('POST', '/auth/2fa/setup', { token: s.accessToken });
    const en = await call('POST', '/auth/2fa/enable', { token: s.accessToken, body: { code: totpAt(setup.body.secret) } });
    assert.equal(en.status, 200);
    assert.equal(en.body.recoveryCodes.length, 8);
    const login = await call('POST', '/auth/login', { body: { email, password: s.password } });
    assert.equal(login.body.mfaRequired, true);
    assert.equal(login.body.accessToken, undefined);
    const bad = await call('POST', '/auth/login/mfa', { body: { mfaToken: login.body.mfaToken, code: '000000' } });
    assert.equal(bad.status, 401);
    const good = await call('POST', '/auth/login/mfa', { body: { mfaToken: login.body.mfaToken, code: totpAt(setup.body.secret) } });
    assert.equal(good.status, 200);
    const rec = await call('POST', '/auth/login/mfa', { body: { mfaToken: login.body.mfaToken, recoveryCode: en.body.recoveryCodes[0] } });
    assert.equal(rec.status, 200);
    const rec2 = await call('POST', '/auth/login/mfa', { body: { mfaToken: login.body.mfaToken, recoveryCode: en.body.recoveryCodes[0] } });
    assert.equal(rec2.status, 401);
  });
  it('rejette un JWT forge ou sans signature valide', async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"x","org":"y","role":"owner"}').toString('base64url')}.`;
    assert.equal((await call('GET', '/auth/me', { token: none })).status, 401);
    assert.equal((await call('GET', '/auth/me', { token: 'abc.def.ghi' })).status, 401);
    assert.equal((await call('GET', '/auth/me')).status, 401);
  });
  it('reinitialisation de mot de passe : reponse neutre, lien a usage unique, sessions coupees', async () => {
    const email = `pwr-${rid}@example.com`;
    const s = await registerAndVerify(email);
    const unknown = await call('POST', '/auth/password/forgot', { body: { email: `nobody-${rid}@example.com` } });
    const known = await call('POST', '/auth/password/forgot', { body: { email } });
    assert.deepEqual(unknown.body, known.body);
    const token = [...outbox].reverse().find((m) => m.to === email && m.text.includes('/reset?token='))?.text.split('token=')[1];
    const r = await call('POST', '/auth/password/reset', { body: { token, password: 'Another-Str0ng-Pass!' } });
    assert.equal(r.status, 200);
    assert.equal((await call('POST', '/auth/password/reset', { body: { token, password: 'Third-Str0ng-Pass!!' } })).status, 400);
    assert.equal((await call('POST', '/auth/refresh', { body: { refreshToken: s.refreshToken } })).status, 401);
    assert.equal((await call('POST', '/auth/login', { body: { email, password: 'Another-Str0ng-Pass!' } })).status, 200);
  });
});

describe('Autorisations & isolation multi-organisation', () => {
  let demo, other;
  before(async () => {
    demo = (await call('POST', '/auth/login', { body: { email: DEMO.email, password: DEMO.password } })).body;
    other = await registerAndVerify(`other-${rid}@example.com`);
  });
  it('une autre organisation ne voit aucun ticket de la demo', async () => {
    const mine = await call('GET', '/tickets', { token: other.accessToken });
    assert.equal(mine.body.total, 0);
    const demoList = await call('GET', '/tickets?limit=1', { token: demo.accessToken });
    assert.ok(demoList.body.total > 100);
    const id = demoList.body.tickets[0].id;
    assert.equal((await call('GET', `/tickets/${id}`, { token: other.accessToken })).status, 404);
    assert.equal((await call('PATCH', `/tickets/${id}`, { token: other.accessToken, body: { status: 'closed' } })).status, 404);
    assert.equal((await call('GET', `/intel/tickets/${id}/replay`, { token: other.accessToken })).status, 404);
  });
  it('un viewer ne peut pas ecrire ni administrer', async () => {
    const v = (await call('POST', '/auth/login', { body: { email: 'viewer@kairos.dev', password: DEMO.password } })).body;
    assert.equal((await call('GET', '/tickets', { token: v.accessToken })).status, 200);
    assert.equal((await call('POST', '/tickets', { token: v.accessToken, body: { title: 'Hello world' } })).status, 403);
    assert.equal((await call('GET', '/api-keys', { token: v.accessToken })).status, 403);
    assert.equal((await call('GET', '/audit', { token: v.accessToken })).status, 403);
  });
  it("les cles d'API respectent leurs portees", async () => {
    const k = await call('POST', '/api-keys', { token: demo.accessToken, body: { name: `ro-${rid}`, scopes: ['read'] } });
    assert.equal(k.status, 201);
    assert.match(k.body.key, /^kai_/);
    assert.equal((await call('GET', '/tickets?limit=1', { token: k.body.key })).status, 200);
    assert.equal((await call('POST', '/tickets', { token: k.body.key, body: { title: 'Ecriture interdite' } })).status, 403);
    assert.equal((await call('GET', '/api-keys', { token: k.body.key })).status, 403);
    await call('DELETE', `/api-keys/${k.body.id}`, { token: demo.accessToken });
    assert.equal((await call('GET', '/tickets?limit=1', { token: k.body.key })).status, 401);
  });
  it('seul un owner peut promouvoir un owner ; le dernier owner est protege', async () => {
    const members = (await call('GET', '/members', { token: demo.accessToken })).body.members;
    const alice = members.find((m) => m.email === DEMO.email);
    assert.equal((await call('PATCH', `/members/${alice.id}`, { token: demo.accessToken, body: { role: 'agent' } })).status, 400);
    assert.equal((await call('DELETE', `/members/${alice.id}`, { token: demo.accessToken })).status, 400);
  });
});

describe('Tickets, PII et audit infalsifiable', () => {
  let s;
  before(async () => { s = await registerAndVerify(`tk-${rid}@example.com`); });
  it('cree un ticket, masque les donnees personnelles et garde un coffre reversible', async () => {
    const r = await call('POST', '/tickets', { token: s.accessToken, body: { title: 'Facture incorrecte', body: 'Mon email est jean.dupont@example.com et ma carte 4111 1111 1111 1111 a ete debitee deux fois.', customerEmail: 'jean.dupont@example.com' } });
    assert.equal(r.status, 201);
    assert.doesNotMatch(r.body.body, /jean\.dupont@/);
    assert.doesNotMatch(r.body.body, /4111/);
    assert.match(r.body.body, /<EMAIL_/);
    assert.match(r.body.body, /<CARD_/);
    assert.equal(r.body.pii_redacted, true);
    const token = r.body.body.match(/<CARD_[a-z0-9]+>/)[0];
    const rev = await call('POST', '/intel/pii/reveal', { token: s.accessToken, body: { token, reason: 'Demande legale ref 42' } });
    assert.equal(rev.body.value, '4111 1111 1111 1111');
    assert.equal((await call('POST', '/intel/pii/reveal', { token: s.accessToken, body: { token, reason: 'x' } })).status, 400);
  });
  it('la chaine d\'audit est valide, puis detecte toute falsification', async () => {
    const ok = await call('GET', '/audit/verify', { token: s.accessToken });
    assert.equal(ok.body.valid, true);
    assert.ok(ok.body.checked >= 2);
    await pool.query(`UPDATE audit_log SET actor='attaquant' WHERE id = (SELECT min(id) FROM audit_log WHERE org_id=$1)`, [(await call('GET', '/auth/me', { token: s.accessToken })).body.activeOrgId]);
    const broken = await call('GET', '/audit/verify', { token: s.accessToken });
    assert.equal(broken.body.valid, false);
    assert.ok(broken.body.brokenAt > 0);
  });
  it('le CSV neutralise les injections de formules', async () => {
    await call('POST', '/tickets', { token: s.accessToken, body: { title: '=HYPERLINK("http://evil","x")' } });
    const r = await app.inject({ method: 'GET', url: '/api/v1/tickets.csv', headers: { authorization: `Bearer ${s.accessToken}` } });
    assert.match(r.body, /"'=HYPERLINK/);
  });
  it('lien de suivi public : jeton opaque, aucune donnee interne', async () => {
    const t = (await call('POST', '/tickets', { token: s.accessToken, body: { title: 'Suivi public test' } })).body;
    await call('POST', `/tickets/${t.id}/comments`, { token: s.accessToken, body: { body: 'Note interne secrete', internal: true } });
    await call('POST', `/tickets/${t.id}/comments`, { token: s.accessToken, body: { body: 'Bonjour, nous regardons ca. Cordialement.' } });
    const share = await call('POST', `/tickets/${t.id}/share`, { token: s.accessToken, body: {} });
    const pub = await call('GET', `/public/track/${share.body.token}`);
    assert.equal(pub.status, 200);
    assert.match(pub.body.lastUpdate.message, /regardons/);
    assert.doesNotMatch(JSON.stringify(pub.body), /secrete|assignee|customer/i);
    assert.equal((await call('GET', '/public/track/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status, 404);
  });
});

describe('Webhooks : SSRF, signature, anti-rejeu', () => {
  let s;
  before(async () => { s = await registerAndVerify(`wh-${rid}@example.com`); });
  it('refuse les cibles internes', async () => {
    for (const url of ['http://127.0.0.1:8080/x', 'http://169.254.169.254/latest/meta-data', 'http://localhost/x', 'http://[::1]/x', 'http://10.0.0.5/x', 'ftp://example.com/x']) {
      assert.equal((await call('POST', '/webhooks', { token: s.accessToken, body: { url } })).status, 400, url);
    }
  });
  it('signature HMAC valide, falsifiee ou rejouee', () => {
    const body = '{"a":1}', ts = Math.floor(Date.now() / 1000), sec = 'whsec_x';
    assert.equal(verifySignature(sec, signPayload(sec, ts, body), body), true);
    assert.equal(verifySignature(sec, signPayload(sec, ts, body), '{"a":2}'), false);
    assert.equal(verifySignature('autre', signPayload(sec, ts, body), body), false);
    assert.equal(verifySignature(sec, signPayload(sec, ts - 3600, body), body), false); // rejeu > 5 min
  });
});

describe('Regles (policy-as-code)', () => {
  let s;
  before(async () => { s = (await call('POST', '/auth/login', { body: { email: DEMO.email, password: DEMO.password } })).body; });
  it('simule une regle sur l\'historique sans rien modifier', async () => {
    const r = await call('POST', '/rules/simulate', { token: s.accessToken, body: { condition: { field: 'text', op: 'contains', value: '502' }, actions: [{ type: 'set_priority', value: 'critical' }] } });
    assert.equal(r.status, 200);
    assert.ok(r.body.matched > 5);
  });
  it('rejette une condition malformee ou une action inconnue', async () => {
    assert.equal((await call('POST', '/rules', { token: s.accessToken, body: { name: 'x', condition: { field: 'nope', op: 'eq', value: 1 }, actions: [{ type: 'set_priority', value: 'low' }] } })).status, 400);
    assert.equal((await call('POST', '/rules', { token: s.accessToken, body: { name: 'x', condition: { field: 'text', op: 'contains', value: 'a' }, actions: [{ type: 'rm_rf' }] } })).status, 400);
  });
  it('applique les regles a la creation (enterprise => haute priorite, menace de depart => escalade)', async () => {
    const t = await call('POST', '/tickets', { token: s.accessToken, body: { title: 'Nous allons resilier', body: 'Sans correctif nous allons resilier notre contrat.', customerEmail: 'sofia@initech.eu', priority: 'low' } });
    assert.equal(t.status, 201);
    assert.ok(['high', 'critical'].includes(t.body.priority));
    assert.ok(t.body.tags.includes('escalated'));
    assert.ok(t.body.rulesFired.length >= 2);
  });
});

describe('Intelligence sur les donnees de demonstration', () => {
  let tk, first;
  before(async () => {
    tk = (await call('POST', '/auth/login', { body: { email: DEMO.email, password: DEMO.password } })).body.accessToken;
    first = (await call('GET', '/tickets?status=open&sort=frustration&limit=1', { token: tk })).body.tickets[0];
  });
  it('1. trajectoire de frustration', async () => {
    const r = await call('GET', `/intel/tickets/${first.id}/frustration`, { token: tk });
    assert.equal(r.status, 200); assert.ok(r.body.escalationRisk >= 0 && r.body.escalationRisk <= 1);
  });
  it('2. doublons detectes parmi les tickets checkout', async () => {
    const list = (await call('GET', '/tickets?component=checkout&limit=3', { token: tk })).body.tickets;
    const r = await call('GET', `/intel/tickets/${list[0].id}/duplicates`, { token: tk });
    assert.ok(r.body.duplicates.some((d) => d.verdict === 'duplicate'));
  });
  it('3. peremption : l\'article mobile obsolete ressort en tete', async () => {
    const r = await call('GET', '/intel/kb/decay', { token: tk });
    assert.ok(r.body.articles[0].decay > 0.3);
    assert.ok(r.body.articles.some((a) => a.reasons.length));
  });
  it('4. lacune documentaire : le SAML n\'a aucun article', async () => {
    const r = await call('GET', '/intel/kb/gaps', { token: tk });
    assert.ok(r.body.gaps.some((g) => g.topTerms.some((t) => /saml|sso|certificat|metadata/.test(t))), JSON.stringify(r.body.gaps.map((g) => g.topTerms)));
  });
  it('5. experts', async () => {
    const r = await call('GET', '/intel/experts?q=SAML metadata certificat', { token: tk });
    assert.ok(r.body.experts.length >= 1);
  });
  it('6. prevision SLA', async () => {
    const r = await call('GET', '/intel/sla/forecast', { token: tk });
    assert.ok(r.body.summary.breached + r.body.summary.atRisk > 0);
  });
  it('7. churn : le client a menace de partir est en tete', async () => {
    const r = await call('GET', '/intel/customers-at-risk', { token: tk });
    assert.equal(r.body.customers[0].customer.name, 'Sofia Rossi');
    assert.equal(r.body.customers[0].level, 'high');
  });
  it('8. incident emergent sur checkout, avec deploiement suspect', async () => {
    const r = await call('GET', '/intel/incidents/emerging', { token: tk });
    const inc = r.body.incidents.find((i) => i.component === 'checkout');
    assert.ok(inc, JSON.stringify(r.body));
    assert.ok(inc.blastRadius.enterprise >= 1);
    assert.equal(inc.suspectedDeploy?.name, 'Checkout service');
  });
  it('9. rupture de volume', async () => {
    assert.equal((await call('GET', '/intel/volume/changepoints', { token: tk })).status, 200);
  });
  it('10. garde-fou de reponse', async () => {
    const r = await call('POST', '/intel/reply/guard', { token: tk, body: { body: 'NOUS GARANTISSIMONS QUE CA NE SE REPRODUIRA JAMAIS !!! Contactez-moi au 06 12 34 56 78. Notre faute.' } });
    assert.equal(r.body.safeToSend, false);
    assert.ok(r.body.issues.some((i) => i.code === 'donnee_personnelle'));
    const good = await call('POST', '/intel/reply/guard', { token: tk, body: { body: 'Bonjour, nous avons bien recu votre demande et revenons vers vous sous 24 h. Cordialement.' } });
    assert.equal(good.body.safeToSend, true);
  });
  it('12. rejeu de resolution', async () => {
    const t = (await call('GET', '/tickets?status=resolved&limit=1', { token: tk })).body.tickets[0];
    const r = await call('GET', `/intel/tickets/${t.id}/replay`, { token: tk });
    assert.ok(r.body.timeline.length >= 2);
  });
  it('13. synthese de runbook', async () => {
    const ids = (await call('GET', '/tickets?component=sso&status=resolved&limit=4', { token: tk })).body.tickets.map((t) => t.id);
    const r = await call('POST', '/intel/runbooks/synthesize', { token: tk, body: { ticketIds: ids } });
    assert.equal(r.status, 200); assert.ok(r.body.steps.length >= 1);
  });
  it('14/25. burn-out et meteo d\'equipe', async () => {
    assert.ok((await call('GET', '/intel/team/burnout', { token: tk })).body.team.length >= 4);
    assert.ok((await call('GET', '/intel/team/mood', { token: tk })).body.weather);
  });
  it('15. releve d\'equipe', async () => {
    assert.match((await call('GET', '/intel/handoff', { token: tk })).body.markdown, /Releve d'equipe/);
  });
  it('16. contrefactuel de routage', async () => {
    const t = (await call('GET', '/tickets?component=sso&status=open&limit=1', { token: tk })).body.tickets[0];
    const r = await call('POST', '/intel/routing/counterfactual', { token: tk, body: { ticketId: t.id } });
    assert.equal(r.status, 200); assert.ok(r.body.candidates.length >= 1);
  });
  it('17. reponse sourcee avec citations, et ABSTENTION hors sujet', async () => {
    const ok = await call('POST', '/intel/answer', { token: tk, body: { question: 'Comment reinitialiser mon mot de passe ? Le lien expire' } });
    assert.equal(ok.body.abstained, false);
    assert.ok(ok.body.citations.length >= 1);
    assert.ok(ok.body.confidence >= 0.35);
    const off = await call('POST', '/intel/answer', { token: tk, body: { question: 'Quelle est la capitale de la Mongolie et sa population ?' } });
    assert.equal(off.body.abstained, true);
  });
  it('21. regression apres deploiement API', async () => {
    const r = await call('GET', '/intel/regressions', { token: tk });
    assert.ok(r.body.regressions.some((x) => x.deploy.component === 'api'), JSON.stringify(r.body));
  });
  it('22-23. ROI et vocabulaire emergent', async () => {
    assert.equal((await call('GET', '/intel/roi', { token: tk })).status, 200);
    assert.equal((await call('GET', '/intel/terms/emerging', { token: tk })).status, 200);
  });
  it('26. suggestion de portail publique (rate-limited, portail active uniquement)', async () => {
    const r = await call('POST', '/public/portal/acme/suggest', { body: { text: 'Je ne peux plus me connecter mot de passe oublie' } });
    assert.equal(r.status, 200); assert.ok(r.body.suggestions.length >= 1);
    assert.equal((await call('POST', '/public/portal/inconnu/suggest', { body: { text: 'Je ne peux plus me connecter' } })).status, 404);
  });
  it('analytics', async () => {
    const r = await call('GET', '/analytics/overview', { token: tk });
    assert.ok(r.body.totals.total > 100); assert.ok(r.body.slaCompliance > 0);
  });
});

describe('Integration Forge (FIT)', () => {
  it('refuse un jeton non signe par Atlassian puis accepte un jeton verifie', async () => {
    const fake = `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.sig`;
    const { unauthorized } = await import('../src/lib/errors.js');
    setForgeVerifier(async () => { throw unauthorized('Forge Invocation Token invalide'); });
    const bad = await call('POST', '/forge/triage', { token: fake, body: { summary: 'Test' } });
    assert.equal(bad.status, 401);
    setForgeVerifier(async () => ({ context: { cloudId: `cloud-${rid}-abcdef` }, principal: { accountId: 'x' } }));
    const created = await call('POST', '/forge/issues', { token: fake, body: { issueKey: 'SUP-1', summary: 'Paiement impossible 502', description: 'Erreur a la caisse', reporterEmail: 'a@b.co' } });
    assert.equal(created.status, 201);
    const again = await call('POST', '/forge/issues', { token: fake, body: { issueKey: 'SUP-1', summary: 'Paiement impossible 502' } });
    assert.equal(again.body.deduplicated, true); // idempotent
    const triage = await call('POST', '/forge/triage', { token: fake, body: { summary: 'Paiement impossible 502', description: 'caisse' } });
    assert.equal(triage.status, 200);
    assert.ok(triage.body.possibleDuplicates.length >= 1);
    setForgeVerifier(null);
  });
});
