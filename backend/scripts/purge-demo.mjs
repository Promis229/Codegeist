// Supprime de la base RÉELLE le jeu de démonstration (organisation « acme » et comptes @kairos.dev). Ne touche aucune autre organisation.
//   node scripts/purge-demo.mjs          affiche ce qui serait supprimé
//   node scripts/purge-demo.mjs --yes    supprime
const { pool, many } = await import('../src/db/pool.js');
const { resetDemo, DEMO } = await import('../src/db/seed.js');
const orgs = await many(`SELECT o.slug, o.name, (SELECT count(*)::int FROM tickets t WHERE t.org_id=o.id) AS tickets FROM orgs o ORDER BY o.created_at`);
const users = await many(`SELECT email FROM users WHERE email LIKE '%@kairos.dev'`);
console.log('organisations :', orgs.map((o) => `${o.slug} (${o.tickets} demandes)`).join(', '));
console.log('comptes de démonstration :', users.map((u) => u.email).join(', ') || 'aucun');
if (process.argv.includes('--yes')) {
  await resetDemo();
  const left = await many('SELECT slug FROM orgs ORDER BY created_at');
  console.log(`supprimé. Organisations restantes : ${left.map((o) => o.slug).join(', ') || 'aucune'} (démo « ${DEMO.orgSlug} » retirée)`);
} else console.log('(simulation : relancer avec --yes pour supprimer)');
await pool.end();
