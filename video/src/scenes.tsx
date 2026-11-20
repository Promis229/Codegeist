import React from "react";
import { AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Browser, Chip as BaseChip, Clip, Device, Headline, Mark, SceneShell, Shot, blurIn, clamp, ease, glass, useSpring } from "./lib";
import { C, LEAD, cue, mono, sans, scene, serif } from "./theme";

/* ------------------------------------------------------------------ helpers */

const Chip: React.FC<React.ComponentProps<typeof BaseChip>> = (p) => (
  <>
    <Sequence from={Math.max(0, p.at)} durationInFrames={20}><Audio src={staticFile("audio/pop.wav")} volume={0.22} /></Sequence>
    <BaseChip {...p} />
  </>
);

/** Shows its children between two frames with a soft cross-fade. */
const Fade: React.FC<{ from: number; to?: number; children: React.ReactNode; d?: number }> = ({ from, to = 1e9, children, d = 14 }) => {
  const f = useCurrentFrame();
  const o = Math.min(interpolate(f, [from, from + d], [0, 1], clamp), interpolate(f, [to - d, to], [1, 0], clamp));
  if (o <= 0) return null;
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

/** A device that glides in from the side with a slight 3D tilt, then floats. */
const Float: React.FC<{ at?: number; dx?: number; tilt?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ at = 6, dx = 140, tilt = -5, children, style }) => {
  const f = useCurrentFrame();
  const p = useSpring(at, { damping: 18, stiffness: 90 });
  const bob = Math.sin(f / 36) * 6;
  return <div style={{ position: "absolute", transform: `perspective(2400px) translate(${(1 - p) * dx}px, ${bob}px) rotateY(${tilt * (0.5 + 0.5 * p) + (1 - p) * -12}deg) rotateX(2deg) scale(${0.94 + 0.06 * p})`, opacity: Math.min(1, p * 1.6), transformOrigin: "50% 50%", ...style }}>{children}</div>;
};

const Col: React.FC<{ children: React.ReactNode; x?: number; y?: number; w?: number }> = ({ children, x = 110, y = 230, w = 700 }) => (
  <div style={{ position: "absolute", left: x, top: y, width: w, display: "flex", flexDirection: "column", gap: 18, alignItems: "flex-start" }}>{children}</div>
);

const Counter: React.FC<{ to: number; at: number; size?: number; suffix?: string }> = ({ to, at, size = 190, suffix = "" }) => {
  const f = useCurrentFrame();
  const v = Math.round(interpolate(f, [at, at + 40], [0, to], { ...clamp, easing: ease }));
  return <span style={{ fontFamily: serif, fontSize: size, fontWeight: 500, color: C.amberHi, lineHeight: 1, textShadow: `0 0 60px rgba(240,163,94,.45)` }}>{v}{suffix}</span>;
};

/* ------------------------------------------------------------------ 1. hook */

const TICKETS = [
  ["ACM-127", "Payment fails at checkout", "Enterprise · 502 error"],
  ["ACM-131", "SSO login blocked for the whole team", "Enterprise · 3rd follow-up"],
  ["ACM-134", "Webhook signature rejected", "Premium · API"],
  ["ACM-140", "Mobile app closes on start", "Standard · iOS"],
];
export const Hook: React.FC = () => {
  const f = useCurrentFrame();
  const late = cue("hook", "late");
  const secs = Math.round(interpolate(f, [cue("hook", "answer"), late + 20], [0, 600], { ...clamp, easing: ease }));
  const mm = String(Math.floor(secs / 60)).padStart(2, "0"), ss = String(secs % 60).padStart(2, "0");
  const red = interpolate(f, [late - 10, late + 10], [0, 1], clamp);
  return (
    <SceneShell keyName="hook">
      <Col x={120} y={250} w={900}>
        <div style={{ ...blurIn(f, 4), fontFamily: mono, fontSize: 22, letterSpacing: "0.22em", color: C.amber }}>EVERY SUPPORT TEAM, EVERY DAY</div>
        <div style={{ fontFamily: serif, fontSize: 100, fontWeight: 500, lineHeight: 1.02, letterSpacing: "-0.02em" }}>
          <div style={blurIn(f, 10, 16, 40)}>Agents don't lack</div>
          <div style={blurIn(f, 14, 16, 40)}>knowledge.</div>
          <div style={{ ...blurIn(f, cue("hook", "moment") - 14, 16, 40), color: C.amberHi, marginTop: 18 }}>They lack the</div>
          <div style={{ ...blurIn(f, cue("hook", "moment") - 8, 16, 40), color: C.amberHi }}>right moment.</div>
        </div>
      </Col>
      <div style={{ position: "absolute", left: 1010, top: 150, width: 790 }}>
        {TICKETS.map(([k, t, m], i) => {
          const p = useSpring(18 + i * 16, { damping: 15, stiffness: 110 });
          return (
            <div key={k} style={{ ...glass(24, 0.08), padding: "20px 26px", marginBottom: 18, display: "flex", alignItems: "center", gap: 20, opacity: p, transform: `translateX(${(1 - p) * 120}px) scale(${0.95 + 0.05 * p})` }}>
              <span style={{ width: 14, height: 14, borderRadius: 7, background: i === 1 ? C.coral : C.amber, boxShadow: `0 0 18px ${i === 1 ? C.coral : C.amber}` }} />
              <div style={{ flex: 1, fontFamily: sans }}>
                <div style={{ fontSize: 27, fontWeight: 600 }}><span style={{ color: C.faint, marginRight: 12 }}>{k}</span>{t}</div>
                <div style={{ fontSize: 21, color: C.muted, marginTop: 4 }}>{m}</div>
              </div>
            </div>
          );
        })}
        <div style={{ ...glass(26, 0.08, true), padding: "22px 30px", display: "inline-flex", alignItems: "baseline", gap: 18, marginTop: 14, opacity: interpolate(f, [cue("hook", "answer") - 6, cue("hook", "answer") + 8], [0, 1], clamp), borderColor: `rgba(255,107,94,${0.15 + red * 0.6})` }}>
          <span style={{ fontFamily: mono, fontSize: 64, color: red > 0.5 ? C.bad : C.text }}>+{mm}:{ss}</span>
          <span style={{ fontFamily: sans, fontSize: 26, color: C.muted }}>the answer arrives late</span>
        </div>
      </div>
    </SceneShell>
  );
};

/* ------------------------------------------------------------------ 2. intro */

const Tile: React.FC<{ i: number; at: number; w: number; h: number; children: React.ReactNode; label: string }> = ({ i, at, w, h, children, label }) => {
  const f = useCurrentFrame();
  const p = useSpring(at + i * 7, { damping: 14, stiffness: 120 });
  return (
    <div style={{ width: w, height: h, ...glass(34, 0.09), opacity: Math.min(1, p * 1.5), transform: `translateY(${(1 - p) * 90 + Math.sin((f + i * 20) / 30) * 5}px) scale(${0.8 + 0.2 * p}) rotate(${(1 - p) * (i % 2 ? 6 : -6)}deg)`, padding: 22, display: "flex", flexDirection: "column", justifyContent: "space-between", position: "relative", overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>{children}</div>
      <div style={{ fontFamily: sans, fontSize: 22, fontWeight: 600, color: C.muted, textAlign: "center" }}>{label}</div>
    </div>
  );
};
const Ring: React.FC<{ v: number; size?: number; color?: string; text?: string }> = ({ v, size = 120, color = C.amber, text }) => {
  const r = size / 2 - 9, c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size}>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,.12)" strokeWidth="9" fill="none" />
      <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth="9" fill="none" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v)} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ filter: `drop-shadow(0 0 10px ${color})` }} />
      <text x="50%" y="54%" textAnchor="middle" dominantBaseline="middle" fill={C.text} fontFamily={serif} fontSize={size * 0.3}>{text}</text>
    </svg>
  );
};
export const Intro: React.FC = () => {
  const f = useCurrentFrame();
  const lp = useSpring(6, { damping: 12, stiffness: 80 });
  const ring = interpolate(f, [60, 130], [0, 0.87], { ...clamp, easing: ease });
  const bars = [0.4, 0.62, 0.5, 0.85, 0.7, 0.95];
  return (
    <SceneShell keyName="intro">
      <div style={{ position: "absolute", top: 90, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <div style={{ transform: `scale(${0.5 + 0.5 * lp}) rotate(${(1 - lp) * -40}deg)`, opacity: lp }}><Mark size={150} spin={f * 0.6} /></div>
        <div style={{ ...blurIn(f, 14, 18, 40), fontFamily: serif, fontSize: 190, fontWeight: 500, letterSpacing: "-0.03em", lineHeight: 1 }}>Kairos</div>
        <div style={{ ...blurIn(f, 26), fontFamily: sans, fontSize: 36, color: C.muted }}>The support copilot for <b style={{ color: C.text }}>Jira Service Management</b> and <b style={{ color: C.text }}>Confluence</b></div>
      </div>
      <div style={{ position: "absolute", left: 90, right: 90, top: 600, display: "flex", gap: 24, justifyContent: "center" }}>
        <Tile i={0} at={cue("intro", "right") - 10} w={270} h={280} label="SLA forecast">
          <svg width="200" height="120" viewBox="0 0 200 120"><path d="M0 100 C30 90 40 30 70 50 S110 100 130 60 S170 10 200 20" stroke={C.amber} strokeWidth="5" fill="none" strokeLinecap="round" strokeDasharray="400" strokeDashoffset={400 * (1 - interpolate(f, [60, 120], [0, 1], clamp))} style={{ filter: `drop-shadow(0 0 8px ${C.amber})` }} /><path d="M0 105 C40 100 60 80 90 90 S150 70 200 60" stroke={C.good} strokeWidth="4" fill="none" strokeLinecap="round" opacity=".8" /></svg>
        </Tile>
        <Tile i={1} at={cue("intro", "right") - 10} w={270} h={280} label="Sourced answers"><Ring v={ring} text={`${Math.round(ring * 100)}%`} /></Tile>
        <Tile i={2} at={cue("intro", "right") - 10} w={270} h={280} label="Team chat">
          <div style={{ display: "flex", flexDirection: "column", gap: 10, width: 210 }}>
            <div style={{ ...glass(16, 0.1), padding: "9px 14px", fontFamily: sans, fontSize: 18, color: C.muted }}>Same symptom here…</div>
            <div style={{ alignSelf: "flex-end", background: `linear-gradient(135deg, ${C.amber}, ${C.coral})`, borderRadius: 16, padding: "9px 14px", fontFamily: sans, fontSize: 18, color: "#2a160b", fontWeight: 600 }}>On it ✓</div>
          </div>
        </Tile>
        <Tile i={3} at={cue("intro", "right") - 10} w={270} h={280} label="Your language">
          <div style={{ display: "flex", gap: 10 }}>{["FR", "EN", "ES"].map((l, k) => <span key={l} style={{ ...glass(14, 0.1), padding: "12px 16px", fontFamily: mono, fontSize: 24, color: k === 1 ? C.amberHi : C.text, borderColor: k === 1 ? C.amber : C.line }}>{l}</span>)}</div>
        </Tile>
        <Tile i={4} at={cue("intro", "right") - 10} w={270} h={280} label="Insights, no LLM">
          <div style={{ display: "flex", alignItems: "flex-end", gap: 9, height: 120 }}>{bars.map((b, k) => <div key={k} style={{ width: 20, height: 120 * b * interpolate(f, [70 + k * 5, 100 + k * 5], [0, 1], { ...clamp, easing: ease }), borderRadius: 7, background: `linear-gradient(${C.amberHi}, ${C.coral})` }} />)}</div>
        </Tile>
        <Tile i={5} at={cue("intro", "right") - 10} w={270} h={280} label="Any screen">
          <div style={{ display: "flex", alignItems: "flex-end", gap: 12 }}>
            <div style={{ width: 100, height: 70, borderRadius: 10, border: `3px solid ${C.text}`, opacity: 0.85 }} /><div style={{ width: 50, height: 84, borderRadius: 10, border: `3px solid ${C.amber}` }} /><div style={{ width: 34, height: 62, borderRadius: 9, border: `3px solid ${C.coral}` }} />
          </div>
        </Tile>
      </div>
    </SceneShell>
  );
};

/* ------------------------------------------------------------------ feature scenes */

const FeatureText: React.FC<{ eyebrow: string; lines: string[]; size?: number; children?: React.ReactNode; y?: number }> = ({ eyebrow, lines, size = 76, children, y = 210 }) => (
  <Col x={110} y={y} w={720}>
    <Headline eyebrow={eyebrow} lines={lines} size={size} />
    <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 34, alignItems: "flex-start" }}>{children}</div>
  </Col>
);

export const Landing: React.FC = () => {
  const { dur } = scene("landing");
  const sw = Math.round(dur * 0.6);
  return (
    <SceneShell keyName="landing">
      <FeatureText eyebrow="01 · Landing page" lines={["A first look", "that feels alive."]}>
        <Chip at={cue("landing", "sundial")} label="Live sundial, draggable" />
        <Chip at={cue("landing", "day")} label="Day & night theme" accent={C.coral} />
        <Chip at={cue("landing", "product")} label="Real product shots" accent={C.good} />
        <Chip at={cue("landing", "copilot")} label="Copilot you can try" />
      </FeatureText>
      <Float style={{ left: 800, top: 170 }} at={4}>
        <Browser width={1060}>
          <Fade from={0} to={sw}><Clip src="landing" /></Fade>
          <Fade from={sw - 4}><Clip src="theme" /></Fade>
        </Browser>
      </Float>
    </SceneShell>
  );
};

const MiniCard: React.FC<{ src: string; label: string; at: number; x: number; y: number; w?: number; dur: number; accent?: string }> = ({ src, label, at, x, y, w = 560, dur, accent = C.amber }) => {
  const p = useSpring(at, { damping: 15, stiffness: 110 });
  const f = useCurrentFrame();
  return (
    <div style={{ position: "absolute", left: x, top: y, opacity: Math.min(1, p * 1.5), transform: `translateY(${(1 - p) * 80 + Math.sin((f + x) / 34) * 5}px) scale(${0.88 + 0.12 * p})` }}>
      <Browser width={w} url="" style={{ boxShadow: `0 30px 80px rgba(0,0,0,.5), 0 0 0 1px ${accent}22` }}><Shot src={src} dur={dur} zoom={1.04} /></Browser>
      <div style={{ position: "absolute", left: 20, bottom: -18 }}><BaseChip at={at + 10} label={label} accent={accent} style={{ fontSize: 22, padding: "9px 16px" }} /></div>
    </div>
  );
};

export const Auth: React.FC = () => {
  const { dur } = scene("auth");
  return (
    <SceneShell keyName="auth">
      <FeatureText eyebrow="02 · Sign in" lines={["Secure by", "default."]} size={80}>
        <Chip at={cue("auth", "six-digit", 0.1)} label="E-mail confirmation code" />
        <Chip at={cue("auth", "Google")} label="Google & GitHub (PKCE)" accent={C.coral} />
        <Chip at={cue("auth", "two-factor")} label="Authenticator app (2FA)" accent={C.good} />
        <Chip at={cue("auth", "backup")} label="Single-use backup codes" />
      </FeatureText>
      <MiniCard src="register" label="Sign up with a code" at={cue("auth", "six-digit", 0.1)} x={880} y={110} dur={dur} w={470} />
      <MiniCard src="login" label="Google · GitHub · demo" at={cue("auth", "Google")} x={1390} y={170} dur={dur} w={470} accent={C.coral} />
      <MiniCard src="twofa-setup" label="2FA setup" at={cue("auth", "two-factor")} x={880} y={500} dur={dur} w={470} accent={C.good} />
      <MiniCard src="twofa-codes" label="Backup codes" at={cue("auth", "backup")} x={1390} y={560} dur={dur} w={470} />
    </SceneShell>
  );
};

export const Dashboard: React.FC = () => {
  const { dur } = scene("dashboard");
  return (
    <SceneShell keyName="dashboard">
      <FeatureText eyebrow="03 · Today" lines={["Your day,", "at a glance."]}>
        <Chip at={cue("dashboard", "requests")} label="Live queue metrics" />
        <Chip at={cue("dashboard", "forecast")} label="SLA breach forecast" accent={C.coral} />
        <Chip at={cue("dashboard", "emerging")} label="Emerging-incident radar" accent={C.good} />
        <Chip at={cue("dashboard", "deployment")} label="Suspect deployment" />
      </FeatureText>
      <Float style={{ left: 800, top: 170 }}>
        <Browser width={1060}>
          <Fade from={0} to={cue("dashboard", "emerging") - 10}><Shot src="dashboard" dur={dur} zoom={1.06} /></Fade>
          <Fade from={cue("dashboard", "emerging") - 14}><Shot src="dashboard-2" dur={dur} zoom={1.06} /></Fade>
        </Browser>
      </Float>
    </SceneShell>
  );
};

export const Tickets: React.FC = () => {
  const { dur } = scene("tickets");
  return (
    <SceneShell keyName="tickets">
      <FeatureText eyebrow="04 · Requests" lines={["One queue,", "full context."]}>
        <Chip at={cue("tickets", "filter")} label="Filter · sort · bulk assign" />
        <Chip at={cue("tickets", "export")} label="CSV export" accent={C.good} />
        <Chip at={cue("tickets", "frustration")} label="Tone & frustration" accent={C.coral} />
        <Chip at={cue("tickets", "similar")} label="Similar past cases" />
      </FeatureText>
      <Float style={{ left: 800, top: 170 }} tilt={-4}>
        <Browser width={1060}>
          <Fade from={0} to={cue("tickets", "Open") - 6}><Shot src="tickets" dur={dur} zoom={1.05} /></Fade>
          <Fade from={cue("tickets", "Open") - 10} to={cue("tickets", "similar") - 4}><Shot src="ticket" dur={dur} zoom={1.05} /></Fade>
          <Fade from={cue("tickets", "similar") - 8}><Shot src="ticket-2" dur={dur} zoom={1.05} /></Fade>
        </Browser>
      </Float>
    </SceneShell>
  );
};

export const Copilot: React.FC = () => {
  const { dur } = scene("copilot");
  const doesnt = cue("copilot", "know");
  return (
    <SceneShell keyName="copilot">
      <FeatureText eyebrow="05 · Copilot" lines={["Answers you", "can trust."]} y={190}>
        <Chip at={cue("copilot", "cited")} label="Every sentence cited" />
        <Chip at={cue("copilot", "confidence")} label="Confidence ring" accent={C.good} />
        <Chip at={cue("copilot", "doesn't", 0.7)} label="Abstains when unsure" accent={C.coral} />
        <Chip at={cue("copilot", "paid")} label="No paid LLM" />
      </FeatureText>
      <Float style={{ left: 760, top: 150 }} tilt={-3}>
        <Browser width={1120}>
          <Fade from={0} to={doesnt - 20}><Clip src="copilot" /></Fade>
          <Fade from={doesnt - 24} to={doesnt + 150}><Shot src="copilot-abstain" dur={dur} zoom={1.03} /></Fade>
          <Fade from={doesnt + 146}><Shot src="copilot-answer" dur={dur} zoom={1.03} /></Fade>
        </Browser>
      </Float>
    </SceneShell>
  );
};

export const Intelligence: React.FC = () => {
  const { dur } = scene("intelligence");
  const names: [string, string, string?][] = [["gaps", "Documentation gaps"], ["stale", "Stale articles", C.coral], ["duplicate", "Duplicate clusters"], ["fairness", "Workload fairness", C.good], ["forecasts", "Backlog & capacity forecasts"], ["churn", "Churn risk", C.coral]];
  return (
    <SceneShell keyName="intelligence">
      <Col x={110} y={190} w={700}>
        <Headline eyebrow="06 · Intelligence" lines={["Forty-eight", "analyses."]} size={80} />
        <div style={{ marginTop: 6 }}><Counter to={48} at={cue("intelligence", "forty-eight", 0.05)} /><span style={{ fontFamily: sans, fontSize: 30, color: C.muted, marginLeft: 20 }}>no LLM</span></div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, maxWidth: 700 }}>
          {names.map(([w, l, a], i) => <Chip key={l} at={cue("intelligence", w, 0.2 + i * 0.1)} label={l} accent={a ?? C.amber} style={{ fontSize: 22, padding: "10px 16px" }} />)}
        </div>
      </Col>
      <Float style={{ left: 800, top: 170 }}>
        <Browser width={1060}>
          <Fade from={0} to={cue("intelligence", "workload") - 6}><Shot src="intelligence" dur={dur} zoom={1.05} /></Fade>
          <Fade from={cue("intelligence", "workload") - 10}><Shot src="intelligence-2" dur={dur} zoom={1.05} /></Fade>
        </Browser>
      </Float>
    </SceneShell>
  );
};

export const Search: React.FC = () => {
  const { dur } = scene("search");
  const kinds = ["Tickets", "Customers", "Teammates", "Channels", "Messages", "Articles"];
  return (
    <SceneShell keyName="search">
      <Col x={110} y={200} w={720}>
        <Headline eyebrow="07 · Search" lines={["One box.", "Everything."]} size={84} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, maxWidth: 700, marginTop: 30 }}>
          {kinds.map((k, i) => <Chip key={k} at={cue("search", k.toLowerCase().slice(0, 6), 0.2 + i * 0.08)} label={k} style={{ fontSize: 24 }} accent={i % 2 ? C.coral : C.amber} />)}
        </div>
        <Chip at={cue("search", "typos")} label="Typo & partial-word tolerant" accent={C.good} />
      </Col>
      <Float style={{ left: 800, top: 170 }}>
        <Browser width={1060}>
          <Fade from={0} to={Math.round(dur * 0.78)}><Clip src="search" /></Fade>
          <Fade from={Math.round(dur * 0.78) - 4}><Shot src="knowledge" dur={dur} zoom={1.04} /></Fade>
        </Browser>
      </Float>
    </SceneShell>
  );
};

export const Chat: React.FC = () => {
  const { dur } = scene("chat");
  return (
    <SceneShell keyName="chat">
      <FeatureText eyebrow="08 · Team chat" lines={["Talk where", "the work is."]} y={190}>
        <Chip at={cue("chat", "channels")} label="Channels & direct messages" />
        <Chip at={cue("chat", "key", 0.3)} label="Tickets linked by key" accent={C.good} />
        <Chip at={cue("chat", "WhatsApp-style", 0.4)} label="WhatsApp-style replies" accent={C.coral} />
        <Chip at={cue("chat", "swipe")} label="Right-click · swipe on phone" />
        <Chip at={cue("chat", "malware")} label="Every upload scanned" accent={C.good} />
      </FeatureText>
      <Float style={{ left: 760, top: 160 }} tilt={-3}>
        <Browser width={920}><Clip src="chat" /></Browser>
      </Float>
      <Float style={{ left: 1560, top: 280 }} at={cue("chat", "swipe") - 10} dx={90} tilt={-6}>
        <Device width={290} ratio={2.17}><Shot src="m-messages" dur={dur} zoom={1.03} /></Device>
      </Float>
    </SceneShell>
  );
};

export const Workspace: React.FC = () => {
  const { dur } = scene("workspace");
  return (
    <SceneShell keyName="workspace">
      <FeatureText eyebrow="09 · Workspace" lines={["Everything", "around the ticket."]} size={70} y={250}>
        <Chip at={cue("workspace", "Customers")} label="Customers & plans" />
        <Chip at={cue("workspace", "skills")} label="Team skills & languages" accent={C.good} />
        <Chip at={cue("workspace", "Automation")} label="Automation rules" accent={C.coral} />
        <Chip at={cue("workspace", "webhooks")} label="Signed webhooks · API keys" />
      </FeatureText>
      <MiniCard src="customers" label="Customers" at={cue("workspace", "Customers")} x={850} y={105} dur={dur} w={500} />
      <MiniCard src="team" label="Team" at={cue("workspace", "skills")} x={1380} y={160} dur={dur} w={500} accent={C.good} />
      <MiniCard src="automation" label="Automation" at={cue("workspace", "Automation")} x={850} y={500} dur={dur} w={500} accent={C.coral} />
      <MiniCard src="integrations" label="Integrations" at={cue("workspace", "webhooks")} x={1380} y={555} dur={dur} w={500} />
    </SceneShell>
  );
};

export const Settings: React.FC = () => {
  const { dur } = scene("settings");
  return (
    <SceneShell keyName="settings">
      <FeatureText eyebrow="10 · Account" lines={["Yours to", "control."]}>
        <Chip at={cue("settings", "photo")} label="Profile photo" />
        <Chip at={cue("settings", "sessions")} label="Active sessions" accent={C.good} />
        <Chip at={cue("settings", "audit")} label="Tamper-evident audit log" accent={C.coral} />
        <Chip at={cue("settings", "masked")} label="Personal data masked" />
      </FeatureText>
      <Float style={{ left: 800, top: 170 }}>
        <Browser width={1060}>
          <Fade from={0} to={cue("settings", "audit") - 6}><Shot src="settings" dur={dur} zoom={1.05} /></Fade>
          <Fade from={cue("settings", "audit") - 10}><Shot src="settings-2" dur={dur} zoom={1.05} /></Fade>
        </Browser>
      </Float>
    </SceneShell>
  );
};

export const Languages: React.FC = () => {
  const { dur } = scene("languages");
  return (
    <SceneShell keyName="languages">
      <Col x={0} y={80} w={1920}>
        <div style={{ width: 1920, display: "flex", justifyContent: "center" }}><Headline eyebrow="11 · Languages" lines={["French · English · Spanish"]} size={78} align="center" /></div>
      </Col>
      <MiniCard src="messages-fr" label="Français" at={cue("languages", "French")} x={110} y={330} dur={dur} w={560} />
      <MiniCard src="messages-en" label="English" at={cue("languages", "English")} x={680} y={300} dur={dur} w={560} accent={C.coral} />
      <MiniCard src="messages-es" label="Español" at={cue("languages", "Spanish")} x={1250} y={330} dur={dur} w={560} accent={C.good} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 780, display: "flex", justifyContent: "center" }}>
        <Chip at={cue("languages", "demo")} label="Even the demo content follows your language" accent={C.amber} />
      </div>
    </SceneShell>
  );
};

export const Responsive: React.FC = () => {
  const { dur } = scene("responsive");
  return (
    <SceneShell keyName="responsive">
      <Col x={110} y={170} w={700}>
        <Headline eyebrow="12 · Every screen" lines={["Desktop,", "tablet, phone."]} size={78} />
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 30, alignItems: "flex-start" }}>
          <Chip at={cue("responsive", "Phone")} label="Fully responsive" />
          <Chip at={cue("responsive", "Install")} label="Installable app (PWA)" accent={C.good} />
          <Chip at={cue("responsive", "offline")} label="Offline fallback" accent={C.coral} />
          <Chip at={cue("responsive", "Light")} label="Light & dark themes" />
        </div>
      </Col>
      <Float style={{ left: 760, top: 200 }} at={4} tilt={-3}><Browser width={640}><Shot src="dashboard-light" dur={dur} zoom={1.04} /></Browser></Float>
      <Float style={{ left: 1260, top: 330 }} at={cue("responsive", "Phone") - 6} tilt={-5}><Device width={290} ratio={1.44} radius={40}><Shot src="t-dashboard" dur={dur} zoom={1.03} /></Device></Float>
      <Float style={{ left: 1600, top: 250 }} at={cue("responsive", "Phone")} tilt={-7}><Device width={270} ratio={2.17}><Shot src="m-dashboard" dur={dur} zoom={1.03} /></Device></Float>
    </SceneShell>
  );
};

/* ------------------------------------------------------------------ 15. AI */

const Node: React.FC<{ x: number; y: number; w: number; h: number; at: number; title: string; sub?: string; state?: "ok" | "off" | "plain" }> = ({ x, y, w, h, at, title, sub, state = "plain" }) => {
  const p = useSpring(at, { damping: 14, stiffness: 120 });
  const col = state === "ok" ? C.good : state === "off" ? C.coral : C.amber;
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, height: h, ...glass(26, 0.09), opacity: Math.min(1, p * 1.5), transform: `scale(${0.85 + 0.15 * p}) translateY(${(1 - p) * 40}px)`, padding: "18px 22px", display: "flex", flexDirection: "column", justifyContent: "center", boxShadow: `0 30px 80px rgba(0,0,0,.5), 0 0 0 1px ${col}33` }}>
      <div style={{ fontFamily: sans, fontSize: 28, fontWeight: 700, color: C.text }}>{title}</div>
      {sub ? <div style={{ fontFamily: sans, fontSize: 20, color: state === "plain" ? C.muted : col, marginTop: 6, fontWeight: state === "plain" ? 400 : 600 }}>{sub}</div> : null}
    </div>
  );
};
const Link: React.FC<{ x1: number; y1: number; x2: number; y2: number; at: number }> = ({ x1, y1, x2, y2, at }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [at, at + 18], [0, 1], { ...clamp, easing: ease });
  return <svg style={{ position: "absolute", inset: 0 }} width={1920} height={1080}><line x1={x1} y1={y1} x2={x1 + (x2 - x1) * p} y2={y1 + (y2 - y1) * p} stroke={C.amber} strokeOpacity=".7" strokeWidth="3" strokeDasharray="8 8" /></svg>;
};
export const Brain: React.FC = () => {
  const models: [string, string, "ok" | "off"][] = [["Priority", "gate not passed → lexical fallback", "off"], ["Component", "gate not passed → lexical fallback", "off"], ["Resolution time", "quantiles · gate passed", "ok"], ["Reopening risk", "probability · gate passed", "ok"]];
  return (
    <SceneShell keyName="brain">
      <div style={{ position: "absolute", left: 0, right: 0, top: 70, display: "flex", justifyContent: "center" }}><Headline eyebrow="13 · Kairos Brain" lines={["A model that has to earn its place."]} size={66} align="center" /></div>
      <Node x={100} y={470} w={330} h={150} at={cue("brain", "model", 0.2)} title="Ticket text" sub="personal data masked first" />
      <Link x1={430} y1={545} x2={560} y2={545} at={cue("brain", "model", 0.25) + 10} />
      <Node x={560} y={440} w={400} h={210} at={cue("brain", "open-source")} title="Multilingual embedding" sub="open-source · hosted by us · 384 dims" />
      {models.map(([t, s, st], i) => {
        const y = 250 + i * 150;
        const at = cue("brain", "estimates", 0.45) + i * 9;
        return (
          <React.Fragment key={t}>
            <Link x1={960} y1={545} x2={1060} y2={y + 60} at={at} />
            <Node x={1060} y={y} w={470} h={120} at={at} title={t} sub={s} state={st} />
          </React.Fragment>
        );
      })}
      <Node x={1590} y={430} w={250} h={230} at={cue("brain", "pass", 0.7)} title="Evidence" sub="closest past cases cited" />
      <div style={{ position: "absolute", left: 100, right: 100, bottom: 150, display: "flex", gap: 16, justifyContent: "center" }}>
        <Chip at={cue("brain", "baselines")} label="Simple baselines to beat" />
        <Chip at={cue("brain", "cross-validation")} label="Nested cross-validation" accent={C.good} />
        <Chip at={cue("brain", "permutation")} label="Permutation test" accent={C.coral} />
        <Chip at={cue("brain", "served", 0.9)} label="No pass, no serving" />
      </div>
    </SceneShell>
  );
};

/* ------------------------------------------------------------------ 16. stack */

export const Stack: React.FC = () => {
  const items: [string, string, string?][] = [
    ["Fastify 5 + PostgreSQL", "API · JWT · audit chain"], ["React 19 + Tailwind", "PWA · 3 languages"], ["Forge app + Rovo agent", "7 actions for Jira"],
    ["Vercel", "frontend & API, separate"], ["Neon", "serverless Postgres"], ["Modal", "AI service · scales to zero"],
    ["153 automated tests", "real database, real flows"], ["No paid API", "open-source model, free tiers"], ["fr · en · es", "checked at every build"],
  ];
  const keys = ["Fastify", "React", "Forge", "Vercel", "Neon", "Modal", "tests", "paid", "paid"];
  return (
    <SceneShell keyName="stack">
      <div style={{ position: "absolute", left: 0, right: 0, top: 70, display: "flex", justifyContent: "center" }}><Headline eyebrow="14 · Built to ship" lines={["Production-ready, end to end."]} size={66} align="center" /></div>
      <div style={{ position: "absolute", left: 160, top: 290, width: 1600, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 26 }}>
        {items.map(([t, s], i) => <Tile key={t} i={i} at={cue("stack", keys[i], 0.1 + i * 0.09) - 14} w={510} h={170} label=""><div style={{ textAlign: "center" }}><div style={{ fontFamily: serif, fontSize: 40, fontWeight: 500 }}>{t}</div><div style={{ fontFamily: sans, fontSize: 22, color: C.muted, marginTop: 6 }}>{s}</div></div></Tile>)}
      </div>
    </SceneShell>
  );
};

/* ------------------------------------------------------------------ 17. outro */

export const Outro: React.FC = () => {
  const f = useCurrentFrame();
  const lp = useSpring(4, { damping: 12, stiffness: 70 });
  return (
    <SceneShell keyName="outro" captions={false}>
      <div style={{ ...{ position: "absolute", inset: 0 }, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
        <div style={{ transform: `scale(${0.6 + 0.4 * lp})`, opacity: lp }}><Mark size={170} spin={f * 0.5} /></div>
        <div style={{ ...blurIn(f, 10, 18, 40), fontFamily: serif, fontSize: 210, fontWeight: 500, letterSpacing: "-0.03em", lineHeight: 1 }}>Kairos</div>
        <div style={{ ...blurIn(f, cue("outro", "right") - 8, 18, 30), fontFamily: serif, fontSize: 56, color: C.amberHi, fontStyle: "italic" }}>The right answer, at the right moment.</div>
        <div style={{ display: "flex", gap: 18, marginTop: 30 }}>
          <Chip at={60} label="kairos-web-pi-lilac.vercel.app" />
          <Chip at={72} label="Atlassian Codegeist 2026" accent={C.coral} />
        </div>
      </div>
    </SceneShell>
  );
};

export const SCENE_COMPONENTS: Record<string, React.FC> = {
  hook: Hook, intro: Intro, landing: Landing, auth: Auth, dashboard: Dashboard, tickets: Tickets, copilot: Copilot, intelligence: Intelligence,
  search: Search, chat: Chat, workspace: Workspace, settings: Settings, languages: Languages, responsive: Responsive, brain: Brain, stack: Stack, outro: Outro,
};
export { LEAD };
