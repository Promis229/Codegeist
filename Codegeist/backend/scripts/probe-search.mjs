process.env.NODE_ENV = 'test';
const { buildApp } = await import('../src/app.js');
const { DEMO } = await import('../src/db/seed.js');
const { pool } = await import('../src/db/pool.js');
const app = await buildApp({ logger: false });
await app.ready();
const call = async (u, token, body) => (await app.inject({ method: 'POST', url: `/api/v1${u}`, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} })).json();
const tk = (await call('/auth/login', null, { email: DEMO.email, password: DEMO.password })).accessToken;
const q = 'Payment fails at checkout with error 502';
for (const [name, body] of [['seul', { query: q }], ['+ variantes', { query: q, variants: ['Erreur 502 lors du paiement', 'Error 502 al pagar'] }]]) {
  const r = await call('/intel/semantic/search', tk, { ...body, scope: 'tickets', limit: 8 });
  console.log(`\n${name} : engine=${r.engine} requêtes=${r.queries}`);
  for (const x of r.results) console.log(`  ${x.lang} ${x.crossLingual ? 'AUTRE-LANGUE' : '            '} ${x.score} ${x.label} ${x.title}`);
}
await app.close(); await pool.end();
