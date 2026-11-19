import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';

// Faux « Google » et faux « GitHub » : ils vérifient réellement PKCE (S256), le secret client et l'usage unique du code.
const sha256b64 = (s) => createHash('sha256').update(s).digest('base64url');
const issued = new Map();   // code -> { challenge, profile }
const tokens = new Map();   // access_token -> profil
let upstreamDown = false;
const stub = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://stub');
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const bearer = (req.headers.authorization ?? '').replace('Bearer ', '');
    if (/\/token$/.test(url.pathname)) {
      const f = new URLSearchParams(raw);
      const entry = issued.get(f.get('code'));
      const secret = url.pathname.startsWith('/google') ? 'gsecret' : 'hsecret';
      if (f.get('client_secret') !== secret || !entry || sha256b64(f.get('code_verifier') ?? '') !== entry.challenge) return json(400, { error: 'invalid_grant' });
      issued.delete(f.get('code')); // usage unique
      const at = `at-${f.get('code')}`;
      tokens.set(at, entry.profile);
      return json(200, { access_token: at });
    }
    if (upstreamDown) return json(500, {});
    const p = tokens.get(bearer);
    if (!p) return json(401, {});
    if (url.pathname === '/google/userinfo') return json(200, p.google);
    if (url.pathname === '/github/user') return json(200, p.githubUser);
    if (url.pathname === '/github/user/emails') return json(200, p.githubEmails);
    return json(404, {});
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
process.env.OAUTH_TEST_BASE = `http://127.0.0.1:${stub.address().port}`;
process.env.GOOGLE_CLIENT_ID = 'gid'; process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
process.env.GITHUB_CLIENT_ID = 'hid'; process.env.GITHUB_CLIENT_SECRET = 'hsecret';
process.env.NODE_ENV = 'test';

const { buildApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { pool, one, query } = await import('../src/db/pool.js');
const { outbox } = await import('../src/lib/mailer.js');
const { env } = await import('../src/config/env.js');

let app;
const rid = Math.random().toString(36).slice(2, 8);
const call = async (method, url, { token, body } = {}) => {
  const res = await app.inject({ method, url: `/api/v1${url}`, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let json; try { json = res.json(); } catch { json = res.body; }
  return { status: res.statusCode, body: json, headers: res.headers };
};
const WEB = `${env.webUrl}/auth/callback`;
const frag = (loc) => new URLSearchParams(new URL(loc).hash.slice(1));

/** Côté « navigateur » : démarre la connexion et récupère ce que le fournisseur reçoit (état, défi PKCE). */
async function start(provider, redirect) {
  const r = await call('GET', `/auth/oauth/${provider}/start${redirect ? `?redirect=${encodeURIComponent(redirect)}` : ''}`);
  return r;
}
/** Côté « fournisseur » : l'utilisateur s'est authentifié, le fournisseur émet un code lié au défi PKCE de la demande. */
function authorize(startRes, profile) {
  const u = new URL(startRes.headers.location);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  const code = `code-${Math.random().toString(36).slice(2)}`;
  issued.set(code, { challenge: u.searchParams.get('code_challenge'), profile });
  return { code, state: u.searchParams.get('state'), redirectUri: u.searchParams.get('redirect_uri'), clientId: u.searchParams.get('client_id') };
}
const google = (sub, email, verified = true, name = 'Gabi Google') => ({ google: { sub, email, email_verified: verified, name, picture: 'https://example.com/p.png' } });
const github = (id, email, verified = true, primary = true) => ({ githubUser: { id, login: `gh${id}`, name: 'Hugo Hub', avatar_url: 'https://example.com/a.png' }, githubEmails: email ? [{ email, primary, verified }] : [] });
const callback = (provider, q) => app.inject({ method: 'GET', url: `/api/v1/auth/oauth/${provider}/callback?${new URLSearchParams(q)}` });

before(async () => { await migrate(() => {}); app = await buildApp({ logger: false }); await app.ready(); });
after(async () => { await app.close(); await pool.end(); stub.close(); });

describe('OAuth Google et GitHub (flux complet contre de faux fournisseurs)', () => {
  it('annonce les fournisseurs configurés', async () => {
    const r = await call('GET', '/auth/providers');
    assert.deepEqual(r.body.providers.map((p) => [p.name, p.enabled]), [['google', true], ['github', true]]);
  });

  it("la demande de connexion redirige vers le fournisseur avec PKCE S256, un état signé et la bonne adresse de retour", async () => {
    const r = await start('google');
    assert.equal(r.status, 302);
    const u = new URL(r.headers.location);
    assert.equal(u.searchParams.get('client_id'), 'gid');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('redirect_uri'), `${env.publicUrl}/api/v1/auth/oauth/google/callback`);
    assert.ok(u.searchParams.get('state').length > 40 && u.searchParams.get('code_challenge').length === 43);
    assert.match(u.searchParams.get('scope'), /openid email profile/);
  });

  it('refuse une adresse de retour non autorisée (anti open-redirect)', async () => {
    assert.equal((await start('google', 'https://evil.example/steal')).status, 400);
    assert.equal((await start('google', 'kairos://auth/callback')).status, 302); // application mobile : autorisée
  });

  it("Google : crée le compte, e-mail déjà vérifié, session ouverte, jetons dans le FRAGMENT (jamais dans la requête)", async () => {
    const email = `gabi-${rid}@example.com`;
    const a = authorize(await start('google'), google(`sub-${rid}`, email));
    const r = await callback('google', { code: a.code, state: a.state });
    assert.equal(r.statusCode, 302);
    const loc = r.headers.location;
    assert.ok(loc.startsWith(`${WEB}#`), loc);
    assert.equal(new URL(loc).search, '');
    const f = frag(loc);
    const me = await call('GET', '/auth/me', { token: f.get('access') });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, email);
    assert.equal(me.body.user.emailVerified, true);
    assert.equal(me.body.hasPassword, false);
    assert.equal(me.body.identities[0].provider, 'google');
    assert.ok(me.body.orgs.length >= 1);
    // le refresh token fonctionne
    assert.equal((await call('POST', '/auth/refresh', { body: { refreshToken: f.get('refresh') } })).status, 200);
  });

  it('une seconde connexion avec le même compte Google retrouve le même utilisateur', async () => {
    const email = `again-${rid}@example.com`;
    const p = google(`sub-again-${rid}`, email);
    const a1 = authorize(await start('google'), p);
    const t1 = frag((await callback('google', { code: a1.code, state: a1.state })).headers.location).get('access');
    const a2 = authorize(await start('google'), p);
    const t2 = frag((await callback('google', { code: a2.code, state: a2.state })).headers.location).get('access');
    const [m1, m2] = [await call('GET', '/auth/me', { token: t1 }), await call('GET', '/auth/me', { token: t2 })];
    assert.equal(m1.body.user.id, m2.body.user.id);
  });

  it("PKCE : un code émis pour un AUTRE défi est refusé, et un code ne sert qu'une fois", async () => {
    const a = authorize(await start('google'), google(`sub-pk-${rid}`, `pk-${rid}@example.com`));
    const other = authorize(await start('google'), google(`sub-pk2-${rid}`, `pk2-${rid}@example.com`));
    // on présente le code de A avec l'état de B : le vérificateur ne correspond pas au défi de A
    const bad = await callback('google', { code: a.code, state: other.state });
    assert.equal(frag(bad.headers.location).get('error'), 'oauth_exchange_failed');
    const ok = authorize(await start('google'), google(`sub-once-${rid}`, `once-${rid}@example.com`));
    assert.ok(frag((await callback('google', { code: ok.code, state: ok.state })).headers.location).get('access'));
    const replay = await callback('google', { code: ok.code, state: ok.state });
    assert.equal(frag(replay.headers.location).get('error'), 'oauth_exchange_failed'); // code déjà consommé
  });

  it("l'utilisateur refuse l'accès chez le fournisseur : retour dans l'application avec un code d'erreur, pas une page JSON", async () => {
    const r = await callback('google', { error: 'access_denied', state: 'x' });
    assert.equal(r.statusCode, 302);
    assert.equal(frag(r.headers.location).get('error'), 'oauth_refused');
    assert.ok(r.headers.location.startsWith(WEB));
  });

  it("état falsifié, expiré ou d'un autre fournisseur : refusé", async () => {
    const a = authorize(await start('google'), google(`sub-st-${rid}`, `st-${rid}@example.com`));
    assert.equal(frag((await callback('google', { code: a.code, state: `${a.state}x` })).headers.location).get('error'), 'oauth_state_invalid');
    assert.equal(frag((await callback('github', { code: a.code, state: a.state })).headers.location).get('error'), 'oauth_state_invalid');
    assert.equal(frag((await callback('google', { code: 'c', state: 'pas.un.jeton' })).headers.location).get('error'), 'oauth_state_invalid');
  });

  it("e-mail non vérifié chez Google : aucun compte créé", async () => {
    const email = `unver-${rid}@example.com`;
    const a = authorize(await start('google'), google(`sub-un-${rid}`, email, false));
    assert.equal(frag((await callback('google', { code: a.code, state: a.state })).headers.location).get('error'), 'oauth_email_unverified');
    assert.equal(await one('SELECT 1 AS x FROM users WHERE email=$1', [email]), null);
  });

  it("compte existant et vérifié : l'identité Google est liée, le mot de passe est conservé", async () => {
    const email = `linked-${rid}@example.com`;
    await call('POST', '/auth/register', { body: { email, password: 'Str0ng-Passphrase!', displayName: 'Lia', orgName: `Org ${email}` } });
    const code = [...outbox].reverse().find((m) => m.to === email).text.match(/\b(\d{6})\b/)[1];
    const verified = await call('POST', '/auth/verify-email', { body: { email, code } });
    const a = authorize(await start('google'), google(`sub-ln-${rid}`, email));
    const t = frag((await callback('google', { code: a.code, state: a.state })).headers.location).get('access');
    const me = await call('GET', '/auth/me', { token: t });
    assert.equal(me.body.user.id, verified.body.user.id);
    assert.equal(me.body.hasPassword, true);
  });

  it("anti pré-piratage : un compte NON confirmé créé par un tiers perd son mot de passe quand le vrai propriétaire se connecte par Google", async () => {
    const email = `victim-${rid}@example.com`;
    // l'attaquant s'inscrit avec l'e-mail de la victime et SON mot de passe, sans pouvoir le confirmer
    assert.equal((await call('POST', '/auth/register', { body: { email, password: 'Attacker-Pass-123!', displayName: 'Pirate' } })).status, 201);
    const before = await one('SELECT password_hash, email_verified FROM users WHERE email=$1', [email]);
    assert.ok(before.password_hash && before.email_verified === false);
    // la victime se connecte avec Google (le fournisseur prouve qu'elle possède l'adresse)
    const a = authorize(await start('google'), google(`sub-vic-${rid}`, email));
    assert.ok(frag((await callback('google', { code: a.code, state: a.state })).headers.location).get('access'));
    const after = await one('SELECT password_hash, email_verified FROM users WHERE email=$1', [email]);
    assert.equal(after.password_hash, null, "le mot de passe de l'attaquant doit être effacé");
    assert.equal(after.email_verified, true);
    assert.equal((await call('POST', '/auth/login', { body: { email, password: 'Attacker-Pass-123!' } })).status, 401);
  });

  it('compte désactivé : accès refusé', async () => {
    const email = `off-${rid}@example.com`;
    const p = google(`sub-off-${rid}`, email);
    const a = authorize(await start('google'), p);
    await callback('google', { code: a.code, state: a.state });
    await query('UPDATE users SET disabled=true WHERE email=$1', [email]);
    const b = authorize(await start('google'), p);
    assert.equal(frag((await callback('google', { code: b.code, state: b.state })).headers.location).get('error'), 'account_disabled');
  });

  it('fournisseur en panne : message clair, pas une erreur brute', async () => {
    const a = authorize(await start('google'), google(`sub-dn-${rid}`, `dn-${rid}@example.com`));
    upstreamDown = true;
    try { assert.equal(frag((await callback('google', { code: a.code, state: a.state })).headers.location).get('error'), 'oauth_upstream'); }
    finally { upstreamDown = false; }
  });

  it("application mobile : le retour se fait vers kairos://auth/callback", async () => {
    const a = authorize(await start('google', 'kairos://auth/callback'), google(`sub-mob-${rid}`, `mob-${rid}@example.com`));
    const r = await callback('google', { code: a.code, state: a.state });
    assert.ok(r.headers.location.startsWith('kairos://auth/callback#'), r.headers.location);
    assert.ok(frag(r.headers.location).get('access'));
  });

  it("GitHub : n'accepte qu'un e-mail PRINCIPAL et VÉRIFIÉ", async () => {
    const email = `hugo-${rid}@example.com`;
    const ok = authorize(await start('github'), github(7000 + 1, email));
    const t = frag((await callback('github', { code: ok.code, state: ok.state })).headers.location).get('access');
    assert.equal((await call('GET', '/auth/me', { token: t })).body.identities[0].provider, 'github');
    for (const [id, p] of [[7002, github(7002, `nv-${rid}@example.com`, false)], [7003, github(7003, `np-${rid}@example.com`, true, false)], [7004, github(7004, null)]]) {
      const a = authorize(await start('github'), p);
      assert.equal(frag((await callback('github', { code: a.code, state: a.state })).headers.location).get('error'), 'oauth_email_unverified', `profil ${id}`);
    }
  });
});
