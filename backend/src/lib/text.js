// Moteur texte "maison" : aucune API payante, aucun modele distant. Tout est deterministe et testable.

const STOP = {
  en: 'a an the and or but if then else of to in on at by for with from as is are was were be been being it its this that these those i you he she we they me my your our their not no do does did done have has had can could will would should may might just so than too very also into out up down over under again still about after before when while'.split(' '),
  fr: 'le la les un une des du de d l et ou mais si alors donc or ni car que qui quoi dont ou au aux en dans sur sous par pour avec sans chez ce cet cette ces je tu il elle on nous vous ils elles me te se mon ton son ma ta sa mes tes ses notre votre leur est sont etait etre ete suis es sommes etes ai as a avons avez ont pas ne plus tres aussi encore deja cela ca'.split(' '),
  es: 'el la los las un una unos unas de del y o pero que en con por para sin su sus mi tu es son fue ser estar muy tambien ya no se lo'.split(' '),
  de: 'der die das ein eine und oder aber nicht ist sind war ich du er sie wir ihr mit von zu auf in an fur auch noch schon sehr es den dem des'.split(' '),
};
const STOPSET = new Set(Object.values(STOP).flat());

export const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
export const normalize = (s) => stripAccents(String(s ?? '').toLowerCase());

/** Racinisation legere multilingue (suffixes frequents). Suffisant pour BM25 sur du texte de support. */
function stem(w) {
  if (w.length < 5) return w;
  return w
    .replace(/(issements?|issement|ations?|ements?|ement|ments?|ing|ings|ed|es|s|x|er|ez|ent|ee|ees|ie|ies)$/u, '')
    .replace(/(.)\1$/, '$1');
}

export function tokenize(text, { keepStop = false, doStem = true } = {}) {
  const raw = normalize(text).match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g) ?? [];
  const out = [];
  for (const t of raw) {
    if (!keepStop && (t.length < 2 || STOPSET.has(t))) continue;
    out.push(doStem ? stem(t) : t);
  }
  return out;
}

export function detectLang(text) {
  const toks = normalize(text).match(/[a-z]+/g) ?? [];
  if (!toks.length) return 'en';
  const score = {};
  for (const [lang, words] of Object.entries(STOP)) {
    const set = new Set(words.map(normalize));
    score[lang] = toks.reduce((n, t) => n + (set.has(t) ? 1 : 0), 0);
  }
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best[1] === 0 ? 'en' : best[0];
}

// ---------------- Similarite ----------------
export function trigrams(s) {
  const t = `  ${normalize(s).replace(/\s+/g, ' ').trim()} `;
  const set = new Set();
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
}

export function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function fnv1a(str, seed) {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h | 0; // int4 Postgres
}

const SEEDS = Array.from({ length: 64 }, (_, i) => (i + 1) * 2654435761 % 4294967296);

/** Signature MinHash (64 permutations) sur les chevauchements de 2-grammes de mots. */
export function minhash(text) {
  const toks = tokenize(text, { doStem: true });
  const shingles = toks.length < 2 ? toks : toks.slice(1).map((t, i) => `${toks[i]} ${t}`);
  if (!shingles.length) return Array(64).fill(0);
  return SEEDS.map((seed) => {
    let min = 2147483647;
    for (const sh of shingles) { const h = fnv1a(sh, seed); if (h < min) min = h; }
    return min;
  });
}

export function minhashSimilarity(a, b) {
  if (!a?.length || a.length !== b?.length) return 0;
  let eq = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) eq++;
  return eq / a.length;
}

// ---------------- BM25 ----------------
export class BM25 {
  constructor(docs, { k1 = 1.4, b = 0.75 } = {}) {
    this.k1 = k1; this.b = b;
    this.docs = docs.map((d) => ({ id: d.id, tokens: tokenize(`${d.text}`) }));
    this.N = this.docs.length;
    this.avgdl = this.N ? this.docs.reduce((s, d) => s + d.tokens.length, 0) / this.N : 0;
    this.df = new Map();
    for (const d of this.docs) for (const t of new Set(d.tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.tf = this.docs.map((d) => {
      const m = new Map();
      for (const t of d.tokens) m.set(t, (m.get(t) ?? 0) + 1);
      return m;
    });
  }
  idf(t) {
    const n = this.df.get(t) ?? 0;
    return Math.log(1 + (this.N - n + 0.5) / (n + 0.5));
  }
  /** Renvoie [{id, score, matched}] trie par score decroissant. */
  search(query, limit = 10) {
    const q = [...new Set(tokenize(query))];
    const out = [];
    this.docs.forEach((d, i) => {
      let score = 0;
      const matched = [];
      for (const t of q) {
        const f = this.tf[i].get(t);
        if (!f) continue;
        matched.push(t);
        score += this.idf(t) * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.tokens.length) / (this.avgdl || 1))));
      }
      if (score > 0) out.push({ id: d.id, score, matched });
    });
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

/** Cosinus TF-IDF entre deux textes, avec IDF calcule sur un corpus donne. */
export function cosine(tokensA, tokensB, idf = () => 1) {
  const va = new Map(), vb = new Map();
  for (const t of tokensA) va.set(t, (va.get(t) ?? 0) + 1);
  for (const t of tokensB) vb.set(t, (vb.get(t) ?? 0) + 1);
  let dot = 0, na = 0, nb = 0;
  for (const [t, f] of va) { const w = f * idf(t); na += w * w; if (vb.has(t)) dot += w * vb.get(t) * idf(t); }
  for (const [t, f] of vb) { const w = f * idf(t); nb += w * w; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// ---------------- Sentiment & frustration (FR/EN, lexique + modificateurs) ----------------
const NEG = new Set(normalize(
  'broken bug error fail failed failing failure crash crashed down outage slow terrible awful horrible worst useless unacceptable angry furious annoyed frustrated disappointed ridiculous waste lost losing stuck blocked urgent impossible never nothing nobody ignored unresolved unusable disaster refund cancel cancelling complaint panne bug erreur echec plante plantage lent nul horrible inacceptable furieux enerve decu ridicule perdu bloque urgent impossible jamais rien personne ignore catastrophe rembourser resilier resiliation reclamation inadmissible scandaleux honteux inutile'
).split(' '));
const POS = new Set(normalize(
  'thanks thank great good perfect awesome excellent love helpful solved fixed works working resolved happy pleased wonderful fast quick easy merci super parfait genial excellent resolu repare fonctionne content ravi rapide facile bravo nickel top'
).split(' '));
const NEGATORS = new Set(['not', 'no', 'never', 'cant', 'dont', 'doesnt', 'isnt', 'wont', 'ne', 'pas', 'jamais', 'aucun', 'plus']);
const BOOST = new Set(['very', 'really', 'extremely', 'totally', 'completely', 'so', 'tres', 'vraiment', 'completement', 'totalement', 'super']);
const FRUSTRATION_MARKERS = [
  /\b(again|encore|toujours|still|third time|troisieme fois|deuxieme fois|second time|for the \w+ time|depuis \w+ (jours|semaines|heures)|since \w+ (days|weeks|hours))\b/g,
  /\b(unacceptable|inacceptable|inadmissible|ridiculous|ridicule|fed up|marre|ras le bol|worst|pire)\b/g,
  /\b(cancel|resilier|resiliation|refund|rembours|switch to|changer de fournisseur|competitor|concurrent)/g,
  /\b(escalate|escalader|manager|directeur|responsable|legal|avocat|lawyer)\b/g,
];

export function sentiment(text) {
  const raw = String(text ?? '');
  const toks = normalize(raw).match(/[a-z]+/g) ?? [];
  if (!toks.length) return 0;
  let score = 0, hits = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const polarity = NEG.has(t) ? -1 : POS.has(t) ? 1 : 0;
    if (!polarity) continue;
    let w = 1;
    const prev = toks.slice(Math.max(0, i - 3), i);
    if (prev.some((p) => NEGATORS.has(p))) w *= -0.8;
    if (prev.some((p) => BOOST.has(p))) w *= 1.5;
    score += polarity * w;
    hits++;
  }
  const letters = raw.replace(/[^A-Za-z]/g, '');
  const caps = letters.length > 12 ? (raw.replace(/[^A-Z]/g, '').length / letters.length) : 0;
  const bangs = (raw.match(/!/g) ?? []).length;
  let s = hits ? score / Math.sqrt(hits + 2) : 0;
  s -= caps > 0.45 ? 0.35 : 0;
  s -= Math.min(bangs, 4) * 0.05 * (s < 0.2 ? 1 : 0);
  return Math.max(-1, Math.min(1, Number(s.toFixed(3))));
}

/** Frustration 0..1 : negativite + marqueurs de repetition/menace de depart/escalade. */
export function frustration(text) {
  const n = normalize(text);
  const base = Math.max(0, -sentiment(text));
  let markers = 0;
  for (const re of FRUSTRATION_MARKERS) markers += (n.match(re) ?? []).length;
  const raw = base * 0.6 + Math.min(markers, 4) * 0.14;
  return Number(Math.max(0, Math.min(1, raw)).toFixed(3));
}

// ---------------- PII ----------------
function luhn(num) {
  const d = num.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

const PII_PATTERNS = [
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'secret', re: /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/g },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'iban', re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g },
  { kind: 'card', re: /\b\d(?:[ -]?\d){12,18}\b/g, validate: luhn },
  { kind: 'ipv4', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  { kind: 'phone', re: /(?<![\w])(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}(?![\w])/g, validate: (s) => { const d = s.replace(/\D/g, ''); return d.length >= 9 && d.length <= 15 && /[\s.+()-]/.test(s); } },
  { kind: 'ssn_fr', re: /\b[12]\s?\d{2}\s?(?:0[1-9]|1[0-2])\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{2}\b/g },
];

/**
 * Remplace chaque donnee personnelle par un jeton stable <KIND_ab12cd>. `tokenFor(kind, value)` permet
 * de brancher un coffre reversible. Renvoie le texte nettoye et la liste des trouvailles.
 */
export function redactPII(text, tokenFor = (kind, value) => `<${kind.toUpperCase()}_${shortHash(value)}>`) {
  const findings = [];
  let out = String(text ?? '');
  for (const { kind, re, validate } of PII_PATTERNS) {
    out = out.replace(re, (m) => {
      if (validate && !validate(m)) return m;
      if (/^<[A-Z0-9_]+>$/.test(m)) return m;
      const token = tokenFor(kind, m);
      findings.push({ kind, token });
      return token;
    });
  }
  return { text: out, findings };
}

export function shortHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(6, '0').slice(0, 6);
}

export const excerpt = (s, n = 220) => (String(s).length > n ? `${String(s).slice(0, n - 1).trimEnd()}…` : String(s));
