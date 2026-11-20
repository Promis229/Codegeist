import React from "react";
import { AbsoluteFill, Audio, Easing, Img, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FPS, H, LEAD, SCENES, W, mono, sans, serif, scene } from "./theme";

export const ease = Easing.bezier(0.16, 1, 0.3, 1);
export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** 0 → 1 spring starting at `at` (frames, relative to the scene). */
export const useSpring = (at: number, cfg: { damping?: number; stiffness?: number; mass?: number } = {}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - at, fps, config: { damping: 16, stiffness: 120, ...cfg } });
};

/** "Blur → sharp" rise used for every piece of text. */
export const blurIn = (frame: number, at: number, dur = 14, dy = 28) => {
  const p = interpolate(frame, [at, at + dur], [0, 1], { ...clamp, easing: ease });
  return { opacity: p, filter: `blur(${(1 - p) * 14}px)`, transform: `translateY(${(1 - p) * dy}px)` } as React.CSSProperties;
};

/** Glassmorphism surface. Heavy backdrop blur is kept for a few hero panels only (render time). */
export const glass = (r = 28, a = 0.07, blur = false): React.CSSProperties => ({
  borderRadius: r,
  background: `linear-gradient(150deg, rgba(255,255,255,${a + 0.06}) 0%, rgba(255,255,255,${a * 0.45}) 100%)`,
  border: `1px solid ${C.line}`,
  boxShadow: "0 40px 90px rgba(0,0,0,0.5), 0 2px 0 rgba(255,255,255,0.05) inset, 0 1px 0 rgba(255,255,255,0.24) inset",
  ...(blur ? { backdropFilter: "blur(22px) saturate(140%)" } : {}),
});

/** Warm drifting light behind everything. */
export const Backdrop: React.FC = () => {
  const f = useCurrentFrame();
  const blob = (x: number, y: number, r: number, color: string, sp: number, ph: number) => {
    const cx = x + Math.sin(f / sp + ph) * 130;
    const cy = y + Math.cos(f / (sp * 1.3) + ph) * 90;
    return `radial-gradient(${r}px ${r}px at ${cx}px ${cy}px, ${color}, transparent 70%)`;
  };
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${C.bg2}, ${C.bg} 55%, #0b0807)` }}>
      <AbsoluteFill style={{ background: [blob(380, 260, 640, "rgba(240,163,94,0.30)", 90, 0), blob(1580, 840, 720, "rgba(255,123,92,0.22)", 120, 2), blob(1000, 560, 520, "rgba(190,110,50,0.14)", 150, 4)].join(",") }} />
      <AbsoluteFill style={{ background: "radial-gradient(120% 90% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)" }} />
    </AbsoluteFill>
  );
};

export const Mark: React.FC<{ size?: number; spin?: number }> = ({ size = 64, spin = 0 }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
    <g style={{ transformOrigin: "32px 32px", transform: `rotate(${spin}deg)` }}>
      <circle cx="32" cy="32" r="26" stroke={C.amber} strokeOpacity=".38" strokeWidth="1.6" strokeDasharray="1.5 5.2" strokeLinecap="round" />
    </g>
    <circle cx="32" cy="32" r="21" stroke={C.amber} strokeOpacity=".5" strokeWidth="1.6" />
    <path d="M23 15v34" stroke={C.text} strokeWidth="5" strokeLinecap="round" />
    <path d="M25 33 44 16" stroke={C.amber} strokeWidth="5" strokeLinecap="round" />
    <path d="M25 33 45 49" stroke={C.text} strokeOpacity=".42" strokeWidth="5" strokeLinecap="round" />
    <circle cx="25" cy="33" r="2.4" fill={C.coral} />
  </svg>
);

/** Still image with a slow push-in. */
export const Shot: React.FC<{ src: string; dur: number; zoom?: number; from?: [number, number]; pos?: string; style?: React.CSSProperties }> = ({ src, dur, zoom = 1.05, from = [0, 0], pos = "top center", style }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [0, dur], [0, 1], clamp);
  return <Img src={staticFile(`shots/${src}.png`)} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: pos, transform: `scale(${1 + (zoom - 1) * p}) translate(${from[0] * (1 - p)}px, ${from[1] * (1 - p)}px)`, transformOrigin: "50% 30%", ...style }} />;
};

/** Screen recording of the real application, trimmed/sped to the time available. */
export const Clip: React.FC<{ src: string; start?: number; rate?: number; style?: React.CSSProperties }> = ({ src, start = 0, rate = 1, style }) => (
  <OffthreadVideo src={staticFile(`clips/${src}.mp4`)} muted startFrom={Math.round(start * FPS)} playbackRate={rate} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top center", ...style }} />
);

/** Browser window (glass chrome) around any 16:10 content. */
export const Browser: React.FC<{ width: number; children: React.ReactNode; url?: string; style?: React.CSSProperties }> = ({ width, children, url = "kairos-web-pi-lilac.vercel.app", style }) => {
  const h = Math.round(width * 0.625);
  return (
    <div style={{ width, ...glass(26, 0.06, true), padding: 0, overflow: "hidden", ...style }}>
      <div style={{ height: 46, display: "flex", alignItems: "center", gap: 10, padding: "0 18px", borderBottom: `1px solid ${C.line}`, background: "rgba(255,255,255,0.04)" }}>
        {["#ff7b5c", "#f0c05e", "#7fcfa6"].map((c) => <i key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c, opacity: 0.85 }} />)}
        <div style={{ flex: 1, margin: "0 40px", height: 26, borderRadius: 13, background: "rgba(0,0,0,0.28)", color: C.faint, fontFamily: sans, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>{url}</div>
      </div>
      <div style={{ width, height: h, position: "relative", overflow: "hidden", background: "#120d0a" }}>{children}</div>
    </div>
  );
};

/** Phone / tablet bezel. `ratio` = height / width of the screen. */
export const Device: React.FC<{ width: number; ratio: number; radius?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ width, ratio, radius = 54, children, style }) => (
  <div style={{ width, padding: 12, ...glass(radius, 0.1, true), ...style }}>
    <div style={{ width: width - 24, height: Math.round((width - 24) * ratio), borderRadius: radius - 12, overflow: "hidden", position: "relative", background: "#120d0a" }}>{children}</div>
  </div>
);

/** Floating label with a glowing dot. */
export const Chip: React.FC<{ at: number; label: string; x?: number; y?: number; accent?: string; icon?: string; style?: React.CSSProperties }> = ({ at, label, x, y, accent = C.amber, icon, style }) => {
  const p = useSpring(at, { damping: 13, stiffness: 150 });
  const f = useCurrentFrame();
  const float = Math.sin((f + at * 3) / 22) * 4;
  return (
    <div style={{ position: x !== undefined ? "absolute" : "relative", left: x, top: y, opacity: Math.min(1, p * 1.4), transform: `translateY(${float + (1 - p) * 26}px) scale(${0.86 + 0.14 * p})`, ...glass(18, 0.09, false), padding: "12px 20px 12px 16px", display: "inline-flex", alignItems: "center", gap: 12, fontFamily: sans, fontSize: 25, fontWeight: 600, color: C.text, whiteSpace: "nowrap", ...style }}>
      <span style={{ width: 14, height: 14, borderRadius: 7, background: accent, boxShadow: `0 0 16px ${accent}` }} />
      {icon ? <span style={{ fontSize: 26 }}>{icon}</span> : null}
      {label}
    </div>
  );
};

/** Eyebrow + serif headline, word by word. */
export const Headline: React.FC<{ eyebrow: string; lines: string[]; at?: number; size?: number; align?: "left" | "center"; style?: React.CSSProperties }> = ({ eyebrow, lines, at = 4, size = 84, align = "left", style }) => {
  const f = useCurrentFrame();
  let k = 0;
  return (
    <div style={{ textAlign: align, ...style }}>
      <div style={{ ...blurIn(f, at), fontFamily: mono, fontSize: 21, letterSpacing: "0.22em", color: C.amber, textTransform: "uppercase", marginBottom: 22 }}>{eyebrow}</div>
      {lines.map((line, li) => (
        <div key={li} style={{ fontFamily: serif, fontWeight: 500, fontSize: size, lineHeight: 1.04, letterSpacing: "-0.02em", color: C.text }}>
          {line.split(" ").map((w, wi) => <span key={wi} style={{ display: "inline-block", marginRight: size * 0.24, ...blurIn(f, at + 4 + 3 * k++, 14, 34) }}>{w}</span>)}
        </div>
      ))}
    </div>
  );
};

/** Burned-in captions driven by the word timings of the scene's line. */
export const Captions: React.FC<{ keyName: string }> = ({ keyName }) => {
  const f = useCurrentFrame();
  const words = scene(keyName).line.words;
  const t = (f - LEAD) / FPS;
  if (t < -0.1) return null;
  // chunks of up to 7 words, broken at punctuation
  const chunks: { s: number; e: number; w: typeof words }[] = [];
  let cur: typeof words = [];
  words.forEach((w, i) => {
    cur.push(w);
    const last = i === words.length - 1;
    if (cur.length >= 7 || last || /[.,!?]$/.test(w.text) && cur.length >= 3) { chunks.push({ s: cur[0].start, e: cur[cur.length - 1].end, w: cur }); cur = []; }
  });
  const ci = chunks.findIndex((c, i) => t >= c.s - 0.05 && (t < (chunks[i + 1]?.s ?? 1e9) - 0.05));
  const chunk = chunks[Math.max(0, ci)];
  if (!chunk || t > chunk.e + 0.9) return null;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 44, display: "flex", justifyContent: "center" }}>
      <div style={{ ...glass(20, 0.1, true), padding: "14px 30px", fontFamily: sans, fontSize: 34, fontWeight: 600, color: C.muted, maxWidth: 1500, textAlign: "center", lineHeight: 1.25 }}>
        {chunk.w.map((w, i) => <span key={i} style={{ color: t >= w.start - 0.02 ? C.text : C.muted, marginRight: 9 }}>{w.text}</span>)}
      </div>
    </div>
  );
};

/** Wraps every scene: fade/slide/blur in and out, voice-over, whoosh, captions. */
export const SceneShell: React.FC<{ keyName: string; children: React.ReactNode; captions?: boolean }> = ({ keyName, children, captions = true }) => {
  const f = useCurrentFrame();
  const { dur } = scene(keyName);
  const inn = interpolate(f, [0, 16], [0, 1], { ...clamp, easing: ease });
  const out = interpolate(f, [dur - 12, dur], [1, 0], { ...clamp, easing: Easing.in(Easing.cubic) });
  const o = Math.min(inn, out);
  return (
    <AbsoluteFill style={{ color: C.text, fontFamily: sans, opacity: o, filter: `blur(${(1 - o) * 10}px)`, transform: `scale(${0.985 + 0.015 * o})` }}>
      <Sequence from={LEAD}><Audio src={staticFile(`vo/${keyName}.mp3`)} volume={1} /></Sequence>
      <Audio src={staticFile("audio/whoosh.wav")} volume={0.28} />
      {children}
      {captions ? <Captions keyName={keyName} /> : null}
    </AbsoluteFill>
  );
};

export const centerStyle: React.CSSProperties = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" };
export const dims = { W, H };
export { C, FPS, serif, sans, mono, SCENES };
