import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { buildApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { seedDemo, resetDemo, DEMO } = await import('../src/db/seed.js');
const { pool } = await import('../src/db/pool.js');
const { outbox } = await import('../src/lib/mailer.js');

let app, bruno, chen, outsider;
const rid = Math.random().toString(36).slice(2, 8);
const call = async (method, url, token, body) => {
  const res = await app.inject({ method, url: `/api/v1${url}`, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let json; try { json = res.json(); } catch { json = null; }
  return { status: res.statusCode, body: json };
};
const login = async (email) => (await call('POST', '/auth/login', null, { email, password: DEMO.password })).body.accessToken;
const search = (t, q) => call('GET', `/search?q=${encodeURIComponent(q)}`, t);

before(async () => {
  await migrate(() => {}); await resetDemo(); await seedDemo(() => {});
  app = await buildApp({ logger: false }); await app.ready();
  bruno = await login('bruno@kairos.dev'); chen = await login('chen@kairos.dev');
  const email = `search-out-${rid}@example.com`;
  await call('POST', '/auth/register', null, { email, password: 'Str0ng-Passphrase!', displayName: 'Outsider', orgName: `Out ${rid}` });
  const code = [...outbox].reverse().find((m) => m.to === email).text.match(/\b(\d{6})\b/)[1];
  outsider = (await call('POST', '/auth/verify-email', null, { email, code })).body.accessToken;
});
after(async () => { await app.close(); await pool.end(); });

describe('Recherche globale', () => {
  it('trouve des mots entiers, des mots incomplets et sans tenir compte des majuscules', async () => {
    assert.ok((await search(bruno, 'paiement')).body.tickets.length > 0);
    assert.ok((await search(bruno, 'PAIEMENT')).body.tickets.length > 0);
    assert.ok((await search(bruno, 'paiem')).body.tickets.length > 0, 'mot incomplet');
    assert.ok((await search(bruno, 'factur')).body.kb.length > 0 || (await search(bruno, 'factur')).body.tickets.length > 0, 'préfixe de « facturation »');
  });
  it('trouve les clients par nom, société ou e-mail, et les collègues par nom', async () => {
    assert.equal((await search(bruno, 'sofia')).body.customers[0].name, 'Sofia Rossi');
    assert.ok((await search(bruno, 'umbrella')).body.customers.length > 0, 'société');
    assert.equal((await search(bruno, 'chen')).body.members[0].name, 'Chen Wei');
    assert.ok((await search(bruno, 'kairos.dev')).body.members.length >= 3, 'e-mail');
  });
  it('trouve les salons et le contenu des messages', async () => {
    assert.ok((await search(bruno, 'incid')).body.channels.some((c) => c.name === 'incidents'));
    const r = await search(bruno, 'déploiement');
    assert.ok(r.body.messages.length > 0);
    assert.ok(r.body.messages[0].channelId && r.body.messages[0].body);
  });
  it('ne révèle jamais les messages directs des autres', async () => {
    const members = (await call('GET', '/members', bruno)).body.members;
    const dm = (await call('POST', '/chat/dm', chen, { userId: members.find((m) => m.email === 'dana@kairos.dev').id })).body;
    await call('POST', `/chat/channels/${dm.id}/messages`, chen, { body: `secret-${rid}-confidentiel` });
    assert.equal((await search(bruno, `secret-${rid}`)).body.messages.length, 0, 'Bruno ne fait pas partie de cette conversation');
    assert.equal((await search(chen, `secret-${rid}`)).body.messages.length, 1, 'Chen, si');
  });
  it('est cloisonnée par organisation', async () => {
    const r = (await search(outsider, 'paiement')).body;
    assert.deepEqual([r.tickets.length, r.customers.length, r.kb.length, r.members.length, r.messages.length], [0, 0, 0, 0, 0]);
  });
  it('traite les caractères spéciaux comme du texte ordinaire', async () => {
    for (const q of ['50%', 'a_b', "l'erreur", '"guillemets"', 'a\\b', '%%']) assert.equal((await search(bruno, q)).status, 200, q);
    assert.equal((await search(bruno, '%%')).body.tickets.length, 0, '« % » ne doit pas tout renvoyer');
  });
  it('copilote : une organisation sans contenu le dit clairement (base vide), une organisation remplie répond', async () => {
    const empty = await call('POST', '/intel/answer', outsider, { question: 'comment aider mon client qui n a plus son compte' });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.abstained, true);
    assert.equal(empty.body.emptyBase, true, 'base vide signalée comme telle');
    const full = await call('POST', '/intel/answer', bruno, { question: 'customer cannot log in reset password' });
    assert.ok(!full.body.emptyBase);
    assert.equal(full.body.abstained, false);
  });
  it('refuse une requête trop courte', async () => {
    assert.equal((await search(bruno, 'e')).status, 400);
  });
});
