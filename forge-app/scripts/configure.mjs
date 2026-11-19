// Renseigne le manifeste Forge pour VOTRE déploiement : URL publique du backend (remote) et adresse autorisée (egress).
//   node scripts/configure.mjs https://api.mon-domaine.com            applique et valide
//   node scripts/configure.mjs https://api.mon-domaine.com --dry      affiche seulement
// L'identifiant d'application (app.id) est écrit par `forge register`, jamais ici.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const file = join(root, 'manifest.yml');
const [urlArg, flag] = process.argv.slice(2);
if (!urlArg) { console.error('Usage : node scripts/configure.mjs https://votre-backend [--dry]'); process.exit(2); }

let url;
try { url = new URL(urlArg); } catch { console.error(`URL invalide : ${urlArg}`); process.exit(2); }
if (url.protocol !== 'https:') { console.error('Forge exige du HTTPS pour le backend (remote). Mettez un proxy TLS devant (voir DEPLOY.md).'); process.exit(2); }
if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname) || url.hostname.endsWith('.local')) { console.error(`Adresse non publique : ${url.hostname}. Forge doit pouvoir joindre le backend depuis Internet.`); process.exit(2); }

const base = `${url.protocol}//${url.host}`;
let text = readFileSync(file, 'utf8');
const before = text;
text = text.replace(/(remotes:[\s\S]*?baseUrl:\s*)\S+/, `$1${base}`);
text = text.replace(/(external:\s*\n\s*fetch:\s*\n\s*backend:\s*\n[\s\S]*?- address:\s*)\S+/, `$1${url.host}`);
if (text === before && !before.includes(base)) { console.error('Aucun emplacement trouvé dans manifest.yml : structure inattendue.'); process.exit(1); }

console.log(`remote  baseUrl : ${base}\negress  address : ${url.host}`);
if (flag === '--dry') process.exit(0);
writeFileSync(file, text);
console.log('manifest.yml mis à jour. Étapes suivantes : forge register (si pas déjà fait), forge lint, forge deploy, forge install.');
