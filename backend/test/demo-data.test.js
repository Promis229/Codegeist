import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { buildApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { seedDemo, resetDemo, DEMO } = await import('../src/db/seed.js');
const { pool, many } = await import('../src/db/pool.js');
const { detectLang } = await import('../src/lib/text.js');

let app, tk;
const call = async (method, url, token, body) => {
  const res = await app.inject({ method, url: `/api/v1${url}`, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let json; try { json = res.json(); } catch { json = res.body; }
  return { status: res.statusCode, body: json };
};
before(async () => {
  await migrate(() => {}); await resetDemo(); await seedDemo(() => {});
  app = await buildApp({ logger: false }); await app.ready();
  tk = (await call('POST', '/auth/login', null, { email: DEMO.email, password: DEMO.password })).body.accessToken;
});
after(async () => { await app.close(); await pool.end(); });

describe('Jeu de démonstration : une langue par contenu, dans les trois langues de l\'interface', () => {
  it('la base de connaissances existe en français, anglais et espagnol (mêmes articles)', async () => {
    const byLang = {};
    for (const l of ['fr', 'en', 'es']) {
      const r = await call('GET', `/kb?lang=${l}`, tk);
      assert.equal(r.status, 200);
      byLang[l] = r.body.articles;
      assert.ok(r.body.articles.length >= 6, `${l} : ${r.body.articles.length} articles`);
      assert.ok(r.body.articles.every((a) => a.lang === l), `${l} : un article d'une autre langue s'est glissé dans la liste`);
    }
    const all = await call('GET', '/kb', tk);
    assert.ok(all.body.articles.every((a) => ['fr', 'en', 'es'].includes(a.lang)));
    assert.equal((await call('GET', '/kb?lang=xx', tk)).status, 400);
    // un titre anglais n'apparaît jamais dans la liste française, et inversement
    assert.ok(!byLang.fr.some((a) => /^Reset your password$/.test(a.title)));
    assert.ok(byLang.en.some((a) => a.title === 'Reset your password'));
    assert.ok(byLang.es.some((a) => a.title.startsWith('Restablecer')));
  });

  it('la recherche dans la base respecte aussi le filtre de langue', async () => {
    const r = await call('GET', '/kb?q=payment%20error%20checkout&lang=en', tk);
    assert.ok(r.body.articles.length >= 1);
    assert.ok(r.body.articles.every((a) => a.lang === 'en'));
  });

  it('les demandes existent dans les trois langues', async () => {
    const rows = await many(`SELECT lang, count(*)::int AS n FROM tickets t JOIN orgs o ON o.id=t.org_id WHERE o.slug='acme' GROUP BY lang`);
    const n = Object.fromEntries(rows.map((r) => [r.lang, r.n]));
    for (const l of ['fr', 'en', 'es']) assert.ok(n[l] >= 5, `langue ${l} : ${n[l] ?? 0} demandes (${JSON.stringify(n)})`);
  });

  it("l'agent répond dans la langue du client (fil cohérent, jamais un client anglais avec une réponse française)", async () => {
    const rows = await many(
      `SELECT t.title, t.body, c.body AS reply FROM tickets t JOIN orgs o ON o.id=t.org_id
         JOIN ticket_comments c ON c.ticket_id=t.id AND NOT c.author_is_customer AND NOT c.internal
        WHERE o.slug='acme'`);
    assert.ok(rows.length > 50);
    const mismatched = rows.filter((r) => detectLang(`${r.title}\n${r.body}`) !== detectLang(r.reply));
    assert.ok(mismatched.length / rows.length < 0.03, `${mismatched.length}/${rows.length} fils mélangent deux langues : ${JSON.stringify(mismatched.slice(0, 2))}`);
  });

  it('les notes internes et les relances suivent aussi la langue de la demande', async () => {
    const rows = await many(
      `SELECT t.title, t.body, c.body AS note, c.internal FROM tickets t JOIN orgs o ON o.id=t.org_id
         JOIN ticket_comments c ON c.ticket_id=t.id WHERE o.slug='acme' AND (c.internal OR c.author_is_customer)`);
    assert.ok(rows.length > 20);
    const mismatched = rows.filter((r) => detectLang(`${r.title}\n${r.body}`) !== detectLang(r.note));
    assert.ok(mismatched.length / rows.length < 0.1, `${mismatched.length}/${rows.length} : ${JSON.stringify(mismatched.slice(0, 2))}`);
  });
});
