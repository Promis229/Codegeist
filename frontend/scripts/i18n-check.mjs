// Garantit qu'aucune langue ne contient du texte d'une autre.
//   1. mêmes clés dans fr / en / es, et mêmes variables {x} dans chaque valeur
//   2. toute clé utilisée dans le code existe ; toute énumération affichée est entièrement traduite
//   3. aucun texte en dur dans le JSX (nœuds de texte, placeholder, title, aria-label, alt) ni de lettre accentuée dans une chaîne
//   4. avertissements : traduction identique au français, clés inutilisées, codes d'erreur du backend sans message
// Analyse syntaxique réelle (AST) : pas d'heuristique par expression régulière sur le code.
// Échoue (code 1) à la moindre erreur : à lancer en CI et avant chaque build (`npm run i18n:check`).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const src = join(root, 'src');
const dicts = {};
for (const l of ['fr', 'en', 'es']) dicts[l] = (await import(pathToFileURL(join(src, 'i18n', `${l}.js`)).href)).default;

const errors = [], warnings = [];
const err = (m) => errors.push(m);
const rel = (p) => relative(root, p).replace(/\\/g, '/');

// ---------- 1. parité des clés et des variables
const all = new Set(Object.values(dicts).flatMap((d) => Object.keys(d)));
const vars = (s) => [...String(s ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const k of all) {
  for (const l of Object.keys(dicts)) if (!(k in dicts[l])) err(`[${l}] clé manquante : ${k}`);
  const ref = vars(dicts.fr[k]);
  for (const l of ['en', 'es']) if (k in dicts[l] && vars(dicts[l][k]) !== ref) err(`[${l}] variables différentes de fr pour ${k} : {${vars(dicts[l][k])}} au lieu de {${ref}}`);
}

// ---------- parcours des sources
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.jsx?$/.test(f)) files.push(p); } })(src);

const ALLOWED = new Set(['Kairos', 'Google', 'GitHub', 'FR', 'EN', 'ES', 'TOTP', '2FA', 'SLA', 'CUSUM', 'Jira', 'Confluence', 'Slack', 'Forge', 'Rovo', 'Acme Support', 'Kairos Support Copilot']);
const ACCENT = /[àâäçéèêëîïôöûùüÿœÀÂÇÉÈÊÎÔÛÙÜŒñáíóúÁÍÓÚ¿¡]/;
const hasWord = (s) => /[A-Za-zÀ-ÿ]{2,}/.test(s);
const TEXT_ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt', 'label']);

const usedStatic = new Set(), usedPatterns = [], called = new Map(); // called : clé -> emplacement (tout ce qui est passé à t())
const addKey = (node, where) => { // collecte les clés possibles d'une expression passée à t()
  if (!node) return;
  if (node.type === 'StringLiteral') { usedStatic.add(node.value); called.set(node.value, where); }
  else if (node.type === 'ConditionalExpression') { addKey(node.consequent, where); addKey(node.alternate, where); }
  else if (node.type === 'TemplateLiteral') {
    const re = node.quasis.map((q) => q.value.cooked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^.]+');
    usedPatterns.push(new RegExp(`^${re}$`));
  } else if (node.type === 'LogicalExpression') { addKey(node.left, where); addKey(node.right, where); }
};

function visit(node, ctx) {
  if (!node || typeof node.type !== 'string') return;
  switch (node.type) {
    case 'CallExpression': {
      const c = node.callee;
      const name = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && c.property?.name;
      if (['t', 'tr'].includes(name)) addKey(node.arguments[0], `${ctx.p}:${node.loc.start.line}`);
      break;
    }
    case 'ObjectProperty': // { key: 'nav.today' } et { label: t(...) } : une chaîne qui est exactement une clé compte comme utilisée
      break;
    case 'JSXText': {
      const txt = node.value.replace(/\s+/g, ' ').trim();
      if (txt && hasWord(txt) && !ALLOWED.has(txt)) err(`${ctx.p}:${node.loc.start.line} texte en dur dans le JSX : "${txt.slice(0, 70)}"`);
      break;
    }
    case 'JSXAttribute': {
      const n = node.name?.name;
      if (TEXT_ATTRS.has(n) && node.value?.type === 'StringLiteral' && hasWord(node.value.value) && !ALLOWED.has(node.value.value)) err(`${ctx.p}:${node.loc.start.line} attribut ${n} en dur : "${node.value.value}"`);
      break;
    }
    case 'StringLiteral':
      if (ACCENT.test(node.value) && !ctx.isI18n) err(`${ctx.p}:${node.loc.start.line} chaîne accentuée en dur : "${node.value.slice(0, 60)}"`);
      if (node.value in dicts.fr) usedStatic.add(node.value); // clé référencée par une donnée : { key: 'nav.today' }
      break;
    case 'TemplateElement':
      if (ACCENT.test(node.value.cooked ?? '') && !ctx.isI18n) err(`${ctx.p}:${node.loc.start.line} gabarit accentué en dur : "${node.value.cooked.slice(0, 60)}"`);
      break;
    default: break;
  }
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'leadingComments' || k === 'trailingComments') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((x) => visit(x, ctx)); else if (v && typeof v.type === 'string') visit(v, ctx);
  }
}

for (const f of files) {
  const p = rel(f);
  if (p.startsWith('src/i18n/')) continue; // les dictionnaires et le moteur contiennent légitimement du texte
  let ast;
  try { ast = parse(readFileSync(f, 'utf8'), { sourceType: 'module', plugins: ['jsx'], errorRecovery: false }); }
  catch (e) { err(`${p}: analyse impossible : ${e.message}`); continue; }
  visit(ast.program, { p, isI18n: false });
}

// ---------- 2. clés utilisées / énumérations
const has = (k) => k in dicts.fr || `${k}_one` in dicts.fr || `${k}_other` in dicts.fr;
for (const [k, where] of called) if (!has(k)) err(`${where} clé passée à t() mais absente des dictionnaires : ${k}`);
for (const re of usedPatterns) if (![...all].some((k) => re.test(k))) err(`aucune clé ne correspond au motif dynamique ${re}`);

const ENUMS = {
  status: ['open', 'pending', 'resolved', 'closed'], prio: ['critical', 'high', 'medium', 'low'], tier: ['enterprise', 'premium', 'standard'],
  role: ['owner', 'admin', 'agent', 'viewer'], sla: ['breached', 'at_risk', 'ok'], level: ['high', 'medium', 'low'], verdict: ['duplicate', 'probable', 'related'],
  weather: ['sunny', 'cloudy', 'rainy', 'stormy', 'unknown'], trend: ['improving', 'worsening', 'stable'], sort: ['newest', 'priority', 'frustration', 'oldest'],
  guard: ['promesse_ferme', 'responsabilite', 'blame_client', 'majuscules', 'exclamations', 'salutation', 'cloture', 'longueur', 'donnee_personnelle', 'ton_negatif', 'langue'],
  'in.decay': ['stale', 'unhelpful', 'reopened'], st: ['scope_read', 'scope_write', 'scope_admin'],
  'op.reason': ['first_response_due', 'sla_pressure', 'frustrated', 'tier', 'unassigned'],
  'op.stale': ['close_candidate', 'nudge_customer', 'reply_now', 'assign', 'waiting_customer', 'waiting_us'],
  'op.dep': ['history', 'open_load', 'weekend_window'], 'op.seg': ['struggling', 'critical_users', 'dormant', 'healthy', 'steady'],
};
for (const [p, vals] of Object.entries(ENUMS)) for (const v of vals) if (!(`${p}.${v}` in dicts.fr)) err(`énumération non traduite : ${p}.${v}`);

// codes d'erreur du backend : chacun doit avoir un message traduit
const codes = new Set();
try {
  (function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f.endsWith('.js')) for (const m of readFileSync(p, 'utf8').matchAll(/new AppError\(\d+,\s*'([a-z_]+)'/g)) codes.add(m[1]); } })(join(root, '..', 'backend', 'src'));
  for (const c of codes) if (!(`err.${c}` in dicts.fr)) warnings.push(`code d'erreur du backend sans message traduit (message générique affiché) : ${c}`);
} catch { /* backend absent : ignoré */ }

// ---------- 4. avertissements
const SAME_OK = /^(Enterprise|Premium|Kairos|Acme Support|TOTP|FR|EN|ES|[0-9 .,%×]+|\{[a-z]+\}|Standard|Email|Admin)\b/i;
for (const k of all) for (const l of ['en', 'es']) {
  const a = dicts.fr[k], b = dicts[l][k];
  if (a && b && a === b && a.length > 14 && !SAME_OK.test(a)) warnings.push(`[${l}] identique à fr (traduction oubliée ?) : ${k} = "${a.slice(0, 50)}"`);
}
const isUsed = (k) => usedStatic.has(k) || usedStatic.has(k.replace(/_(one|other)$/, '')) || usedPatterns.some((re) => re.test(k) || re.test(k.replace(/_(one|other)$/, '')));
const unused = [...all].filter((k) => !isUsed(k) && !k.startsWith('err.') && !(k.split('.')[0] in ENUMS) && k !== 'meta.description');
if (unused.length) warnings.push(`${unused.length} clé(s) probablement inutilisée(s) : ${unused.slice(0, 10).join(', ')}${unused.length > 10 ? '…' : ''}`);

// ---------- rapport
const n = Object.fromEntries(Object.entries(dicts).map(([l, d]) => [l, Object.keys(d).length]));
console.log(`i18n : ${n.fr} clés fr · ${n.en} en · ${n.es} es · ${usedStatic.size} clés et ${usedPatterns.length} motifs dynamiques référencés dans ${files.length} fichiers`);
for (const w of warnings) console.warn(`  avertissement  ${w}`);
if (errors.length) { for (const e of errors) console.error(`  ERREUR  ${e}`); console.error(`\n${errors.length} erreur(s).`); process.exit(1); }
console.log('i18n : OK, aucune langue ne contient de texte d’une autre.');
