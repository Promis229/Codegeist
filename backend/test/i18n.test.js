import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { buildApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { seedDemo, resetDemo, DEMO } = await import('../src/db/seed.js');
const { pool } = await import('../src/db/pool.js');

let app, token;
const get = async (url, lang) => {
  const res = await app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}`, ...(lang ? { 'x-lang': lang } : {}) } });
  return res.json();
};

before(async () => {
  await migrate(() => {}); await resetDemo(); await seedDemo(() => {});
  app = await buildApp({ logger: false }); await app.ready();
  token = (await (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'bruno@kairos.dev', password: DEMO.password } })).json()).accessToken;
});
after(async () => { await app.close(); await pool.end(); });

describe('Contenus de démonstration dans la langue de l’interface (en-tête X-Lang)', () => {
  const firstMessage = async (lang) => {
    const channels = (await get('/chat/channels', lang)).channels;
    const general = channels.find((c) => c.name === 'general');
    return (await get(`/chat/channels/${general.id}/messages`, lang)).messages[0].body;
  };
  it('affiche les messages d’équipe dans chaque langue, et le français sans en-tête', async () => {
    assert.match(await firstMessage('fr'), /Bonjour à tous/);
    assert.match(await firstMessage('en'), /Morning everyone/);
    assert.match(await firstMessage('es'), /Buenos días/);
    assert.match(await firstMessage(null), /Bonjour à tous/);
    assert.match(await firstMessage('de'), /Bonjour à tous/, 'langue inconnue : texte d’origine');
  });
  it('traduit le sujet du salon, l’aperçu du dernier message et le message cité', async () => {
    const en = (await get('/chat/channels', 'en')).channels;
    const incidents = en.find((c) => c.name === 'incidents');
    assert.equal(incidents.topic, 'Ongoing outages and coordination');
    const es = (await get('/chat/channels', 'es')).channels.find((c) => c.name === 'incidents');
    assert.match(es.last.body, /agrupo/);
    const msgs = (await get(`/chat/channels/${incidents.id}/messages`, 'en')).messages;
    const quoted = msgs.find((m) => m.replyTo);
    assert.match(quoted.replyTo.body, /Spike in payment requests/);
  });
  it('traduit les noms des règles d’automatisation et retrouve un message par sa traduction', async () => {
    const rules = (await get('/rules', 'en')).rules;
    assert.ok(rules.some((r) => r.name === 'Enterprise customers: high priority'));
    assert.ok((await get('/rules')).rules.some((r) => /Clients enterprise/.test(r.name)));
    const hit = (await get('/search?q=firewall', 'en')).messages;
    assert.ok(hit.length > 0 && /firewall/i.test(hit[0].body), 'recherche dans la traduction, résultat affiché en anglais');
  });
  it('copilote : la réponse reste dans une seule langue, celle de la question (jamais un mélange de versions)', async () => {
    const ask = async (question) => (await app.inject({ method: 'POST', url: '/api/v1/intel/answer', headers: { authorization: `Bearer ${token}` }, payload: { question } })).json();
    const en = await ask('How do I reset my password? My customer cannot log in');
    assert.equal(en.abstained, false);
    assert.doesNotMatch(en.answer, /restablecer|réinitialiser|Para |Pour /, 'monolingue : pas de phrases espagnoles ou françaises');
    const fr = await ask('Comment un client peut-il réinitialiser son mot de passe ?');
    assert.equal(fr.abstained, false);
    assert.doesNotMatch(fr.answer, /To reset|Para restablecer/, 'monolingue : pas de phrases anglaises ou espagnoles');
  });
});
