// Validation hors ligne du manifeste avec le validateur officiel @forge/manifest (celui de `forge lint`).
const path = require('path');
const base = path.join(process.env.HOME, '.local/forge/node_modules/@forge/cli/node_modules/@forge/manifest');
const { validate } = require(base);
(async () => {
  const res = await validate(false, 'manifest.yml');
  console.log('success:', res.success);
  for (const e of res.errors || []) console.log('ERREUR  ', e.message, e.reference ? '(' + e.reference + ')' : '', e.line ? 'ligne ' + e.line : '');
  for (const w of res.warnings || []) console.log('AVERTIS.', w.message, w.line ? 'ligne ' + w.line : '');
})().catch((e) => { console.error('ERR', e.stack); process.exit(1); });
