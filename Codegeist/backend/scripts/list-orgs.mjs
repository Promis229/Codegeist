// Liste les organisations non issues des tests, avec les e-mails de leurs comptes.
const { pool, many } = await import('../src/db/pool.js');
const r = await many("SELECT o.slug, string_agg(u.email, ',') AS emails FROM orgs o LEFT JOIN memberships m ON m.org_id=o.id LEFT JOIN users u ON u.id=m.user_id GROUP BY o.slug, o.created_at ORDER BY o.created_at");
for (const x of r) if (!/example-com|^atl-cloud|^(reg|b)-desk/.test(x.slug)) console.log(x.slug, '|', x.emails);
await pool.end();
