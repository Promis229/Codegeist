import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
process.env.DEMO_LOGIN = 'true';
const { buildApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { seedDemo, resetDemo } = await import('../src/db/seed.js');
const { pool, query } = await import('../src/db/pool.js');

let app;
const call = async (method, url, token, body) => {
  const res = await app.inject({ method, url: `/api/v1${url}`, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let json; try { json = res.json(); } catch { json = res.body; }
  return { status: res.statusCode, body: json };
};

before(async () => { await migrate(() => {}); await resetDemo(); await seedDemo(() => {}); app = await buildApp({ logger: false }); await app.ready(); });
after(async () => { await app.close(); await pool.end(); });

describe('Entrée « essayer la démo » (DEMO_LOGIN=true)', () => {
  it('est annoncée par /auth/providers', async () => {
    assert.equal((await call('GET', '/auth/providers')).body.demo, true);
  });
  it("ouvre une session d'AGENT sur l'organisation de démonstration, sans mot de passe", async () => {
    const r = await call('POST', '/auth/demo');
    assert.equal(r.status, 200);
    assert.equal(r.body.role, 'agent');
    assert.ok(r.body.accessToken && r.body.refreshToken);
    const me = await call('GET', '/auth/me', r.body.accessToken);
    assert.equal(me.body.orgs[0].slug, 'acme');
    assert.equal((await call('GET', '/tickets?limit=1', r.body.accessToken)).status, 200);
    assert.equal((await call('GET', '/intel/topics', r.body.accessToken)).status, 200); // les analyses d'agent fonctionnent
  });
  it("n'est JAMAIS administrateur : ni export, ni clés d'API, ni audit, ni gestion des membres", async () => {
    const t = (await call('POST', '/auth/demo')).body.accessToken;
    for (const [m, u] of [['GET', '/ml/export'], ['GET', '/api-keys'], ['GET', '/audit'], ['GET', '/webhooks'], ['GET', '/ml/monitoring']]) {
      assert.equal((await call(m, u, t)).status, 403, `${m} ${u}`);
    }
    assert.equal((await call('POST', '/members', t, { email: 'x@example.com', role: 'owner' })).status, 403);
  });
  it('renvoie 404 si la démonstration n’existe pas (jamais un compte au hasard)', async () => {
    await resetDemo();
    assert.equal((await call('POST', '/auth/demo')).status, 404);
    await seedDemo(() => {});
  });
  it('un compte avec 2FA activée n’est pas utilisable pour la démo', async () => {
    await query(`UPDATE users SET totp_enabled=true WHERE email='bruno@kairos.dev'`);
    assert.equal((await call('POST', '/auth/demo')).status, 404);
    await query(`UPDATE users SET totp_enabled=false WHERE email='bruno@kairos.dev'`);
  });
});
