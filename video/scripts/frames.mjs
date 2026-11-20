// Prints, for each scene, its start frame and length (same formula as src/theme.ts).
import fs from 'node:fs';
const L = JSON.parse(fs.readFileSync(new URL('../src/voiceover.json', import.meta.url)));
const FPS = 30, LEAD = 14, TAIL = 12, T = 289 * FPS;
const PAD = { hook: 1.2, intro: 2.2, landing: 1.6, auth: 1.8, dashboard: 1.6, tickets: 1.4, copilot: 2, intelligence: 1.4, search: 1.5, chat: 1.8, workspace: 1.5, settings: 1.4, languages: 1.6, responsive: 1.6, brain: 1.6, stack: 1.4, recap: 1.4, outro: 2.8 };
const vo = (l) => Math.ceil(l.words.at(-1).end * FPS);
const base = L.reduce((s, l) => s + LEAD + vo(l) + TAIL, 0), extra = Math.max(0, T - base), w = L.reduce((s, l) => s + PAD[l.key], 0);
let c = 0; for (const l of L) { const d = LEAD + vo(l) + TAIL + Math.round(extra * PAD[l.key] / w); console.log(l.key, c, d); c += d; }
console.log('TOTAL', c, (c / FPS).toFixed(1) + 's');
