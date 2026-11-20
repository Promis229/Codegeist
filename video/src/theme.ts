import voiceover from "./voiceover.json";

export const serif = "KFraunces, Georgia, serif";
export const sans = "KHanken, system-ui, sans-serif";
export const mono = "ui-monospace, Menlo, Consolas, monospace";

// Same warm palette as the product: amber and coral on a deep brown-black (no purple, no cyan).
export const C = {
  bg: "#0f0b09",
  bg2: "#1a120d",
  text: "#f6efe7",
  muted: "rgba(246,239,231,0.66)",
  faint: "rgba(246,239,231,0.38)",
  amber: "#f0a35e",
  amberHi: "#ffc58a",
  coral: "#ff7b5c",
  good: "#7fcfa6",
  bad: "#ff6b5e",
  line: "rgba(255,255,255,0.14)",
};

export const FPS = 30;
export const W = 1920;
export const H = 1080;
/** Frames between the start of a scene and the start of its voice-over. */
export const LEAD = 14;
const TAIL = 12;
/** YouTube reviewers only watch the first 5 minutes: stay safely under. */
export const TARGET_SECONDS = 293;

export type Word = { text: string; start: number; end: number };
type Line = { key: string; text: string; words: Word[] };
export const LINES = voiceover as Line[];

// Relative breathing room after each line (extra visual time on scenes that need to be looked at).
const PAD: Record<string, number> = {
  hook: 1.2, intro: 2.2, landing: 1.6, auth: 1.8, dashboard: 1.6, tickets: 1.4, copilot: 2, intelligence: 1.4, search: 1.5,
  chat: 1.8, workspace: 1.5, settings: 1.4, languages: 1.6, responsive: 1.6, brain: 1.6, stack: 1.4, outro: 2.8,
};

const voFrames = (l: Line) => Math.ceil((l.words[l.words.length - 1]?.end ?? 1) * FPS);
const base = LINES.reduce((s, l) => s + LEAD + voFrames(l) + TAIL, 0);
const target = Math.max(base, TARGET_SECONDS * FPS);
const extra = target - base;
const wSum = LINES.reduce((s, l) => s + (PAD[l.key] ?? 1), 0);

let cursor = 0;
export const SCENES = LINES.map((l) => {
  const dur = LEAD + voFrames(l) + TAIL + Math.round((extra * (PAD[l.key] ?? 1)) / wSum);
  const s = { key: l.key, start: cursor, dur, vo: voFrames(l), line: l };
  cursor += dur;
  return s;
});
export const TOTAL = cursor;
export const scene = (key: string) => SCENES.find((s) => s.key === key)!;

/** Frame (relative to the scene start) at which a word is spoken; falls back to a fraction of the line. */
export const cue = (key: string, word: string, fallback = 0.5): number => {
  const l = LINES.find((x) => x.key === key)!;
  const w = l.words.find((x) => x.text.toLowerCase().replace(/[^a-z0-9-]/g, "").includes(word.toLowerCase()));
  return LEAD + Math.floor((w ? w.start : (l.words[l.words.length - 1]?.end ?? 1) * fallback) * FPS);
};
