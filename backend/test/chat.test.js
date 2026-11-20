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
const call = async (method, url, token, body) => {
  const res = await app.inject({ method, url: `/api/v1${url}`, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let json; try { json = res.json(); } catch { json = res.body; }
  return { status: res.statusCode, body: json };
};
const login = async (email) => (await call('POST', '/auth/login', null, { email, password: DEMO.password })).body;
let alice, bruno, chen, viewer, outsider;
let general, incidents;

before(async () => {
  await migrate(() => {});
  await resetDemo();
  await seedDemo(() => {});
  app = await buildApp({ logger: false });
  await app.ready();
  alice = await login(DEMO.email);
  bruno = await login('bruno@kairos.dev');
  chen = await login('chen@kairos.dev');
  viewer = await login('viewer@kairos.dev');
  // Un compte d'une AUTRE organisation, pour vérifier le cloisonnement.
  const email = `chat-out-${rid}@example.com`;
  await call('POST', '/auth/register', null, { email, password: 'Str0ng-Passphrase!', acceptTerms: true, acceptPrivacy: true, displayName: 'Outsider', orgName: `Out ${rid}` });
  const code = [...outbox].reverse().find((m) => m.to === email).text.match(/\b(\d{6})\b/)[1];
  outsider = (await call('POST', '/auth/verify-email', null, { email, code })).body;
});
after(async () => { await app.close(); await pool.end(); });

describe('Messagerie : salons et compteurs de non-lus', () => {
  it('liste les salons de la démo avec leurs compteurs', async () => {
    const r = await call('GET', '/chat/channels', bruno.accessToken);
    assert.equal(r.status, 200);
    general = r.body.channels.find((c) => c.name === 'general');
    incidents = r.body.channels.find((c) => c.name === 'incidents');
    assert.ok(general && incidents);
    assert.equal(incidents.unread, 1, 'Bruno n\'a pas lu le message de Dana dans #incidents');
    assert.equal(general.unread, 0);
    const dm = r.body.channels.find((c) => c.kind === 'dm');
    assert.equal(dm.peer.name, 'Alice Martin');
    assert.equal(r.body.unread, 1);
    assert.equal((await call('GET', '/chat/unread', bruno.accessToken)).body.unread, 1);
  });

  it('lire les messages puis marquer comme lu remet le compteur à zéro', async () => {
    const m = await call('GET', `/chat/channels/${incidents.id}/messages`, bruno.accessToken);
    assert.equal(m.status, 200);
    assert.equal(m.body.messages.length, 3);
    assert.ok(m.body.messages[0].id < m.body.messages[2].id, 'ordre chronologique');
    assert.ok(m.body.messages[0].authorName);
    const r = await call('POST', `/chat/channels/${incidents.id}/read`, bruno.accessToken, {});
    assert.equal(r.status, 200);
    assert.equal((await call('GET', '/chat/unread', bruno.accessToken)).body.unread, 0);
  });

  it('un message posté apparaît chez les autres (non lu) mais pas chez son auteur', async () => {
    const posted = await call('POST', `/chat/channels/${general.id}/messages`, chen.accessToken, { body: '  Bonjour l\'équipe  ' });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.body, 'Bonjour l\'équipe', 'le texte est nettoyé des espaces');
    assert.equal(posted.body.authorName, 'Chen Wei');
    const bruno1 = await call('GET', '/chat/channels', bruno.accessToken);
    assert.equal(bruno1.body.channels.find((c) => c.id === general.id).unread, 1);
    const chen1 = await call('GET', '/chat/channels', chen.accessToken);
    assert.equal(chen1.body.channels.find((c) => c.id === general.id).unread, 0);
  });

  it('le mode « après » ne renvoie que les nouveaux messages (rafraîchissement)', async () => {
    const all = await call('GET', `/chat/channels/${general.id}/messages`, bruno.accessToken);
    const lastId = all.body.messages.at(-1).id;
    assert.deepEqual((await call('GET', `/chat/channels/${general.id}/messages?after=${lastId}`, bruno.accessToken)).body.messages, []);
    await call('POST', `/chat/channels/${general.id}/messages`, alice.accessToken, { body: 'Un de plus' });
    const next = await call('GET', `/chat/channels/${general.id}/messages?after=${lastId}`, bruno.accessToken);
    assert.equal(next.body.messages.length, 1);
    assert.equal(next.body.messages[0].body, 'Un de plus');
  });

  it('pagine vers le passé avec « before »', async () => {
    const page = await call('GET', `/chat/channels/${general.id}/messages?limit=2`, bruno.accessToken);
    assert.equal(page.body.messages.length, 2);
    assert.equal(page.body.hasMore, true);
    const older = await call('GET', `/chat/channels/${general.id}/messages?limit=2&before=${page.body.messages[0].id}`, bruno.accessToken);
    assert.ok(older.body.messages.every((m) => m.id < page.body.messages[0].id));
  });

  it('transforme les références de demandes en liens (seulement celles de son organisation)', async () => {
    const t = (await call('GET', '/tickets?limit=1', bruno.accessToken)).body.tickets[0];
    const r = await call('POST', `/chat/channels/${general.id}/messages`, bruno.accessToken, { body: `Voir ${t.key} et ZZZ-9999` });
    assert.equal(r.status, 201);
    assert.equal(r.body.tickets[t.key].id, t.id);
    assert.equal(r.body.tickets['ZZZ-9999'], undefined);
  });
});

describe('Messagerie : messages directs et droits', () => {
  let dmId;
  it('ouvre un message direct, une seule conversation par couple', async () => {
    const members = (await call('GET', '/members', alice.accessToken)).body.members;
    const dana = members.find((m) => m.email === 'dana@kairos.dev');
    const a = await call('POST', '/chat/dm', chen.accessToken, { userId: dana.id });
    const b = await call('POST', '/chat/dm', chen.accessToken, { userId: dana.id });
    assert.equal(a.status, 200);
    assert.equal(a.body.id, b.body.id);
    assert.equal(a.body.peer.name, 'Dana Okafor');
    dmId = a.body.id;
    assert.equal((await call('POST', '/chat/dm', chen.accessToken, { userId: members.find((m) => m.email === 'chen@kairos.dev').id })).status, 403, 'pas de conversation avec soi-même');
  });

  it("un message direct est invisible pour un tiers de la même organisation", async () => {
    await call('POST', `/chat/channels/${dmId}/messages`, chen.accessToken, { body: 'Entre nous' });
    assert.equal((await call('GET', `/chat/channels/${dmId}/messages`, bruno.accessToken)).status, 404);
    assert.equal((await call('POST', `/chat/channels/${dmId}/messages`, bruno.accessToken, { body: 'Intrus' })).status, 404);
    assert.equal((await call('GET', '/chat/channels', bruno.accessToken)).body.channels.some((c) => c.id === dmId), false);
  });

  it("une autre organisation ne voit ni salons, ni messages, et ne peut pas écrire dans les nôtres", async () => {
    const mine = await call('GET', '/chat/channels', outsider.accessToken);
    assert.deepEqual(mine.body.channels.map((c) => c.name), ['general'], 'sa propre organisation a seulement son salon par défaut');
    assert.notEqual(mine.body.channels[0].id, general.id);
    assert.equal((await call('GET', `/chat/channels/${general.id}/messages`, outsider.accessToken)).status, 404);
    assert.equal((await call('POST', `/chat/channels/${general.id}/messages`, outsider.accessToken, { body: 'Hello' })).status, 404);
  });

  it('un lecteur lit mais ne peut pas écrire', async () => {
    assert.equal((await call('GET', `/chat/channels/${general.id}/messages`, viewer.accessToken)).status, 200);
    assert.equal((await call('POST', `/chat/channels/${general.id}/messages`, viewer.accessToken, { body: 'Salut' })).status, 403);
  });

  it('valide les messages : vide, trop long', async () => {
    assert.equal((await call('POST', `/chat/channels/${general.id}/messages`, bruno.accessToken, { body: '   ' })).status, 400);
    assert.equal((await call('POST', `/chat/channels/${general.id}/messages`, bruno.accessToken, { body: 'x'.repeat(4001) })).status, 400);
    assert.equal((await call('GET', '/chat/channels/not-a-uuid/messages', bruno.accessToken)).status, 400);
  });
});

describe('Messagerie : modification, suppression, création de salons', () => {
  let msg;
  it("seul l'auteur modifie son message", async () => {
    msg = (await call('POST', `/chat/channels/${general.id}/messages`, bruno.accessToken, { body: 'Version 1' })).body;
    const edited = await call('PATCH', `/chat/messages/${msg.id}`, bruno.accessToken, { body: 'Version 2' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.body, 'Version 2');
    assert.ok(edited.body.editedAt);
    assert.equal((await call('PATCH', `/chat/messages/${msg.id}`, chen.accessToken, { body: 'Piraté' })).status, 403);
    assert.equal((await call('PATCH', `/chat/messages/${msg.id}`, alice.accessToken, { body: 'Même admin' })).status, 403);
  });

  it("l'auteur ou un administrateur supprime ; un autre agent non ; une autre organisation ne peut rien", async () => {
    assert.equal((await call('DELETE', `/chat/messages/${msg.id}`, chen.accessToken)).status, 403);
    assert.equal((await call('DELETE', `/chat/messages/${msg.id}`, outsider.accessToken)).status, 404);
    assert.equal((await call('DELETE', `/chat/messages/${msg.id}`, alice.accessToken)).status, 200, 'le propriétaire modère');
    const own = (await call('POST', `/chat/channels/${general.id}/messages`, chen.accessToken, { body: 'Je me reprends' })).body;
    assert.equal((await call('DELETE', `/chat/messages/${own.id}`, chen.accessToken)).status, 200);
  });

  it('seuls les administrateurs créent des salons, avec un nom valide et unique', async () => {
    assert.equal((await call('POST', '/chat/channels', bruno.accessToken, { name: 'facturation' })).status, 403);
    assert.equal((await call('POST', '/chat/channels', alice.accessToken, { name: 'Nom invalide !' })).status, 400);
    const ok = await call('POST', '/chat/channels', alice.accessToken, { name: 'Facturation', topic: 'Tout sur la facturation' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.name, 'facturation', 'le nom est mis en minuscules');
    assert.equal((await call('POST', '/chat/channels', alice.accessToken, { name: 'facturation' })).status, 409);
    // Un salon créé après la première visite d'un membre apparaît chez lui, sans historique « non lu » parasite.
    const bruno2 = await call('GET', '/chat/channels', bruno.accessToken);
    assert.ok(bruno2.body.channels.some((c) => c.name === 'facturation' && c.unread === 0));
  });

  it('le salon général est protégé, un autre salon peut être supprimé par un administrateur', async () => {
    assert.equal((await call('DELETE', `/chat/channels/${general.id}`, alice.accessToken)).status, 403);
    const c = (await call('POST', '/chat/channels', alice.accessToken, { name: `temp-${rid}` })).body;
    assert.equal((await call('DELETE', `/chat/channels/${c.id}`, bruno.accessToken)).status, 403);
    assert.equal((await call('DELETE', `/chat/channels/${c.id}`, alice.accessToken)).status, 200);
    assert.equal((await call('GET', `/chat/channels/${c.id}/messages`, alice.accessToken)).status, 404);
  });

  it('refuse sans authentification', async () => {
    assert.equal((await call('GET', '/chat/channels')).status, 401);
  });
});
