// Supprime de la base RÉELLE les résidus d'anciens essais : organisations et comptes dont tous les e-mails sont @example.com / @kairos.dev.
// Une organisation comptant au moins un vrai compte est conservée. Sans --yes : simulation.
const { pool, many, query } = await import('../src/db/pool.js');
const fake = (e) => /@(example\.com|kairos\.dev)$/i.test(e);
const orgs = await many("SELECT o.id, o.slug, coalesce(array_agg(u.email::text) FILTER (WHERE u.email IS NOT NULL), '{}'::text[]) AS emails FROM orgs o LEFT JOIN memberships m ON m.org_id=o.id LEFT JOIN users u ON u.id=m.user_id GROUP BY o.id, o.slug");
const doomed = orgs.filter((o) => o.emails.every(fake));
const keep = orgs.filter((o) => !o.emails.every(fake));
console.log(`à supprimer : ${doomed.length} organisations ; conservées : ${keep.map((o) => `${o.slug} (${o.emails.join(', ')})`).join(' ; ')}`);
if (process.argv.includes('--yes')) {
  for (const o of doomed) await query('DELETE FROM orgs WHERE id=$1', [o.id]);
  const gone = await query("DELETE FROM users u WHERE u.email ~* '@(example\\.com|kairos\\.dev)$' RETURNING 1");
  console.log(`supprimé : ${doomed.length} organisations, ${gone.rowCount} comptes factices`);
}
await pool.end();
