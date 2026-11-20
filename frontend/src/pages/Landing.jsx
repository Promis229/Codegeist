import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api.js';
import { useResource, useTheme } from '../lib/hooks.js';
import { LangSwitch, useT } from '../i18n/index.jsx';
import { Logo } from '../components/Logo.jsx';
import Icon from '../components/Icon.jsx';
import { Ring, Sparkline } from '../components/Charts.jsx';

/* =====================================================================
   Landing : verre épais sur un cadran solaire en volume.
   La lumière, c'est le curseur : l'ombre du gnomon se déplace avec lui.
   Le gnomon sort du panneau de verre, comme l'objet qui déborde du cadre.
   ===================================================================== */

function Reveal({ as: Tag = 'div', d = 0, className = '', children, ...p }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { el?.setAttribute('data-in', ''); return; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { el.setAttribute('data-in', ''); io.disconnect(); } }, { threshold: 0.12 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <Tag ref={ref} data-reveal style={{ '--d': d }} className={className} {...p}>{children}</Tag>;
}

/** Échelle de la scène : tient dans la largeur de sa colonne ET dans la hauteur de l'écran (rien n'est coupé en bas). */
function useFit(designW, designH, max = 1) {
  const ref = useRef(null);
  const [s, setS] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    const fit = () => setS(Math.max(0.45, Math.min(max, el.clientWidth / designW, (window.innerHeight - 170) / designH)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener('resize', fit);
    return () => { ro.disconnect(); window.removeEventListener('resize', fit); };
  }, [designW, designH, max]);
  return [ref, s];
}

// ------------------------------------------------------------------ Scène du cadran
const W = 600, H = 560, CX = 300, CY = 270, RX = 245, RY = 132, K = RY / RX, THICK = 26;
const ROMAN = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];

function SunScene() {
  const { t } = useT();
  const [box, s] = useFit(W, H, 0.78); // volontairement plus petit : la scène accompagne le texte au lieu de le dominer
  const scene = useRef(null), shadow = useRef(null), glow = useRef(null), fin = useRef(null), cut = useRef(null), hand = useRef(null), handTip = useRef(null);

  useEffect(() => {
    // Au repos, l'ombre fait un tour complet en 80 s (lent, mais on le voit avancer). La souris (survol) ou le doigt (glisser sur le
    // cadran) la pilotent ; dès qu'on relâche, elle repart doucement de là où elle est.
    const host = box.current;
    let raf, hover = false, drag = false, mx = 0, my = 0, a = 0.6, len = 120, ex = 0, ey = 0, last = performance.now(), clock = 0;
    const SPEED = (Math.PI * 2) / 50; // un tour en 50 s : au ralenti, mais le mouvement se voit à l'œil nu
    let lastMove = 0;
    const aim = (e) => { mx = e.clientX; my = e.clientY; lastMove = performance.now(); };
    const move = (e) => { if (e.pointerType === 'mouse') { hover = true; aim(e); } else if (drag) aim(e); };
    const down = (e) => { drag = true; aim(e); host?.setPointerCapture?.(e.pointerId); };
    const up = () => { drag = false; };
    const leave = (e) => { if (e.pointerType === 'mouse' || !e.pointerType) hover = false; };
    window.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerleave', leave);
    host?.addEventListener('pointerdown', down);
    host?.addEventListener('pointerup', up); host?.addEventListener('pointercancel', up); host?.addEventListener('lostpointercapture', up);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now; clock += dt;
      const el = scene.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const sc = r.width / W || 1;
        const cx = r.left + CX * sc, cy = r.top + CY * sc;
        let tgtL, tx = 0, ty = 0;
        // La souris ne pilote l'ombre que tant qu'elle bouge (1,5 s) : une souris immobile ne fige plus l'horloge.
        if (drag || (hover && now - lastMove < 1500)) {
          const vx = (mx - cx) / sc, vy = (my - cy) / sc / K; // coordonnées dans le plan du cadran
          const dist = Math.hypot(vx, vy);
          const tgtA = Math.atan2(vy, vx) + Math.PI; // l'ombre fuit la lumière
          tgtL = Math.max(54, Math.min(200, 54 + dist * 0.2));
          tx = Math.max(-1, Math.min(1, (mx - (r.left + r.width / 2)) / 600));
          ty = Math.max(-1, Math.min(1, (my - (r.top + r.height / 2)) / 600));
          let da = tgtA - a; da = Math.atan2(Math.sin(da), Math.cos(da)); // plus court chemin
          a += da * 0.12;
        } else {
          a += SPEED * (reduce ? 0.5 : 1) * dt; // rotation lente et continue (deux fois plus lente si l'utilisateur a réduit les animations, mais jamais arrêtée)
          tgtL = 120 + Math.sin(clock * 0.3) * 24;
        }
        len += (tgtL - len) * 0.1; ex += (tx - ex) * 0.08; ey += (ty - ey) * 0.08;

        const dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
        const tipX = CX + dx * len, tipY = CY + dy * len * K;
        const pts = [
          [CX + nx * 7, CY + ny * 7 * K], [tipX + nx * 2.2, tipY + ny * 2.2 * K],
          [tipX - nx * 2.2, tipY - ny * 2.2 * K], [CX - nx * 7, CY - ny * 7 * K],
        ].map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');
        shadow.current?.setAttribute('points', pts);
        const hl = Math.min(len * 1.05, RX - 40), hx = (CX + dx * hl).toFixed(1), hy = (CY + dy * hl * K).toFixed(1);
        hand.current?.setAttribute('x2', hx); hand.current?.setAttribute('y2', hy);
        handTip.current?.setAttribute('cx', hx); handTip.current?.setAttribute('cy', hy);
        glow.current?.setAttribute('cx', (CX - dx * 120).toFixed(1));
        glow.current?.setAttribute('cy', (CY - dy * 120 * K).toFixed(1));
        if (fin.current) fin.current.style.transform = `translateX(-50%) skewX(${(-dx * 5).toFixed(2)}deg) rotate(${(-dx * 1.2).toFixed(2)}deg)`;
        el.style.setProperty('--px', ex.toFixed(3));
        el.style.setProperty('--py', ey.toFixed(3));
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf); window.removeEventListener('pointermove', move); document.removeEventListener('pointerleave', leave);
      host?.removeEventListener('pointerdown', down); host?.removeEventListener('pointerup', up); host?.removeEventListener('pointercancel', up); host?.removeEventListener('lostpointercapture', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const layer = (n) => ({ transform: `translate3d(calc(var(--px,0) * ${n}px), calc(var(--py,0) * ${n * 0.7}px), 0)` });

  return (
    <div ref={box} className="relative w-full cursor-grab select-none active:cursor-grabbing" style={{ height: H * s, touchAction: 'pan-y' }}>
      <div ref={scene} className="absolute left-1/2 top-0 origin-top" style={{ width: W, height: H, transform: `translateX(-50%) scale(${s})` }}>
        {/* Soleil : la lumière vive derrière le cadran, c'est elle que le verre réfracte et floute */}
        <div className="pointer-events-none absolute rounded-full" aria-hidden="true" style={{ left: CX - 270, top: CY - 250, width: 540, height: 540, background: 'radial-gradient(circle, rgb(255 150 60 / 0.75) 0%, rgb(255 105 55 / 0.32) 42%, transparent 70%)', filter: 'blur(14px)', ...layer(-10) }} />
        {/* Cadran : ellipse, épaisseur, face gravée */}
        <svg className="absolute inset-0" width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={layer(-6)} aria-hidden="true">
          <defs>
            <linearGradient id="brass" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stopColor="#ffd9a3" /><stop offset=".45" stopColor="#d98c43" /><stop offset="1" stopColor="#8a4a1e" /></linearGradient>
            <linearGradient id="edge" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#b8672b" /><stop offset="1" stopColor="#4a230d" /></linearGradient>
            <radialGradient id="face" cx=".5" cy=".42" r=".75"><stop offset="0" stopColor="#3a2b20" /><stop offset=".7" stopColor="#1c1410" /><stop offset="1" stopColor="#120d0a" /></radialGradient>
            <radialGradient id="sheen" cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="#ffcf94" stopOpacity=".85" /><stop offset="1" stopColor="#ffcf94" stopOpacity="0" /></radialGradient>
            <linearGradient id="cast" x1="0" x2="1"><stop offset="0" stopColor="#000" stopOpacity=".7" /><stop offset="1" stopColor="#000" stopOpacity=".05" /></linearGradient>
            <filter id="soft" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="2.4" /></filter>
            <clipPath id="faceClip"><ellipse cx={CX} cy={CY} rx={RX - 16} ry={(RX - 16) * K} /></clipPath>
          </defs>
          <ellipse cx={CX} cy={CY + 78} rx={RX + 30} ry={44} fill="#000" opacity=".55" filter="url(#soft)" style={{ filter: 'blur(26px)' }} />
          <path d={`M${CX - RX},${CY} v${THICK} a${RX},${RY} 0 0 0 ${RX * 2},0 v-${THICK} Z`} fill="url(#edge)" />
          <ellipse cx={CX} cy={CY} rx={RX} ry={RY} fill="url(#brass)" />
          <ellipse cx={CX} cy={CY} rx={RX - 16} ry={(RX - 16) * K} fill="url(#face)" />
          <ellipse cx={CX} cy={CY} rx={RX - 16} ry={(RX - 16) * K} fill="none" stroke="#000" strokeOpacity=".55" strokeWidth="2" />
          <g clipPath="url(#faceClip)">
            {Array.from({ length: 60 }, (_, i) => {
              const an = (i / 60) * Math.PI * 2, big = i % 5 === 0, r1 = RX - (big ? 52 : 40), r2 = RX - 26;
              return <line key={i} x1={CX + Math.cos(an) * r1} y1={CY + Math.sin(an) * r1 * K} x2={CX + Math.cos(an) * r2} y2={CY + Math.sin(an) * r2 * K} stroke="#f0c38c" strokeOpacity={big ? 0.9 : 0.4} strokeWidth={big ? 2.2 : 1} strokeLinecap="round" />;
            })}
            {ROMAN.map((n, i) => {
              const an = ((i - 3) / 12) * Math.PI * 2, r = RX - 78;
              return <text key={n + i} transform={`translate(${CX + Math.cos(an) * r} ${CY + Math.sin(an) * r * K}) scale(1 ${K})`} textAnchor="middle" dominantBaseline="central" fontSize="23" fill="#f6d9b3" fillOpacity=".92" style={{ fontFamily: 'var(--font-serif)', fontVariationSettings: '"opsz" 144, "SOFT" 40' }}>{n}</text>;
            })}
            <ellipse cx={CX} cy={CY} rx={RX - 112} ry={(RX - 112) * K} fill="none" stroke="#f0c38c" strokeOpacity=".22" />
            <ellipse ref={glow} cx={CX - 70} cy={CY} rx="150" ry={150 * K} fill="url(#sheen)" opacity=".55" />
            <polygon ref={shadow} points={`${CX},${CY} ${CX},${CY} ${CX},${CY} ${CX},${CY}`} fill="url(#cast)" filter="url(#soft)" />
            {/* Aiguille lumineuse : c'est elle qu'on voit balayer le cadran (l'ombre seule est trop discrète sur la face sombre) */}
            <line ref={hand} x1={CX} y1={CY} x2={CX} y2={CY} stroke="#ffd9a3" strokeWidth="3.2" strokeLinecap="round" opacity=".95" style={{ filter: 'drop-shadow(0 0 5px rgb(255 160 80 / .9))' }} />
            <circle ref={handTip} cx={CX} cy={CY} r="5.5" fill="#ff7b5c" style={{ filter: 'drop-shadow(0 0 7px rgb(255 120 70 / 1))' }} />
          </g>
          <ellipse cx={CX} cy={CY} rx={RX} ry={RY} fill="none" stroke="#fff" strokeOpacity=".35" strokeWidth="1.2" />
          <ellipse cx={CX} cy={CY} rx="9" ry={9 * K} fill="#2b170a" /><ellipse cx={CX} cy={CY - 1} rx="6" ry={6 * K} fill="#ff7b5c" />
        </svg>

        {/* Panneau central en verre : recouvre la moitié basse du cadran (flou de l'objet derrière) */}
        <div className="glass-xl absolute p-6" style={{ left: 90, top: 262, width: 420, height: 160, ...layer(4) }}>
          <div className="flex items-center justify-between">
            <p className="eyebrow">{t('lp.c.today')}</p>
            <span className="flex items-center gap-1.5 text-[11px] text-muted"><i className="pulse-dot h-1.5 w-1.5 rounded-full bg-good" />{t('lp.c.live')}</span>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4">
            {[['28', t('lp.c.open')], ['1,9 h', t('lp.c.frt')], ['94 %', t('lp.c.slaKept')]].map(([v, l]) => (
              <div key={l}><p className="num text-[34px] leading-none">{v}</p><p className="mt-2 text-[12px] text-muted">{l}</p></div>
            ))}
          </div>
        </div>

        {/* Gnomon : devant le verre, il sort du panneau */}
        <div ref={fin} className="pointer-events-none absolute z-20 origin-bottom" style={{ left: CX, top: CY - 190, width: 44, height: 196, transform: 'translateX(-50%)', ...layer(10) }} aria-hidden="true">
          <svg width="44" height="196" viewBox="0 0 44 196">
            <defs>
              <linearGradient id="gn" x1="0" x2="1"><stop offset="0" stopColor="#ffe6c4" /><stop offset=".5" stopColor="#e09a52" /><stop offset="1" stopColor="#8d4a1d" /></linearGradient>
            </defs>
            <polygon points="22,2 30,176 14,176" fill="url(#gn)" />
            <polygon points="22,2 24,176 14,176" fill="#fff" opacity=".28" />
            <ellipse cx="22" cy="178" rx="17" ry="7" fill="#7a3d17" /><ellipse cx="22" cy="176" rx="17" ry="7" fill="#e39a55" />
            <circle cx="22" cy="6" r="4" fill="#ffd9a3" /><circle cx="22" cy="6" r="9" fill="#ff9d4a" opacity=".35" />
          </svg>
        </div>

        {/* Cartes flottantes */}
        <div className="float-a glass-xl absolute z-10 p-4" style={{ left: 0, top: 70, width: 224, ...layer(16) }}>
          <p className="eyebrow">{t('lp.c.sla.title')}</p>
          <div className="mt-3 flex items-center gap-3">
            <Ring value={0.82} size={58} tone="var(--accent-2)" label="82" />
            <div className="min-w-0"><p className="truncate text-[13px] font-semibold">{t('lp.c.sla.ticket')}</p><p className="mt-0.5 text-[12px] text-warn">{t('lp.c.sla.line')}</p></div>
          </div>
        </div>
        <div className="float-a glass-xl absolute z-30 p-4" style={{ left: 312, top: 392, width: 288, ...layer(22) }}>
          <p className="eyebrow">{t('lp.c.ans.title')}</p>
          <p className="mt-2 text-[13px] leading-snug">{t('lp.c.ans.text')}</p>
          <div className="mt-3 flex items-center justify-between gap-2 text-[11.5px]">
            <span className="chip !h-6 truncate"><Icon name="book" size={12} className="text-accent" />{t('lp.c.ans.src')}</span>
            <span className="font-semibold text-good">{t('lp.c.ans.conf', { n: 78 })}</span>
          </div>
        </div>
        <div className="float-b glass-xl absolute z-30 flex items-center gap-3 px-4 py-3" style={{ left: 6, top: 496, width: 222, ...layer(-20) }}>
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-good/15 text-good"><Icon name="shield" size={18} /></span>
          <p className="text-[12.5px] leading-snug">{t('lp.c.pii')}</p>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Mini visuels (volontairement petits : trois graphiques, pas plus)
function SlaCurve() {
  return (
    <svg viewBox="0 0 320 120" className="mx-auto h-24 w-auto max-w-full" aria-hidden="true">
      <defs><linearGradient id="slaf" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity=".4" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
      <path d="M0,14 C60,16 90,30 130,52 S210,98 320,108 L320,120 L0,120Z" fill="url(#slaf)" />
      <path d="M0,14 C60,16 90,30 130,52 S210,98 320,108" fill="none" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" />
      <line x1="196" x2="196" y1="6" y2="120" stroke="var(--accent-2)" strokeDasharray="3 4" /><circle cx="196" cy="84" r="5.5" fill="var(--accent-2)" />
      <circle cx="130" cy="52" r="4.5" fill="var(--text)" />
    </svg>
  );
}
function IncidentBars() {
  const v = [2, 1, 2, 1, 3, 2, 1, 2, 2, 1, 2, 3, 2, 1, 2, 2, 3, 2, 1, 2, 2, 5, 8, 12, 15, 18];
  return (
    <svg viewBox="0 0 260 90" className="mx-auto h-24 w-auto max-w-full" aria-hidden="true">
      {v.map((n, i) => <rect key={i} x={i * 10} y={90 - n * 4.6} width="6.5" height={n * 4.6} rx="2" fill={i >= 21 ? 'var(--accent-2)' : 'var(--accent)'} opacity={i >= 21 ? 1 : 0.4} />)}
      <line x1="213" x2="213" y1="0" y2="90" stroke="var(--accent-2)" strokeDasharray="2 3" />
    </svg>
  );
}
function Gauge({ label }) {
  const r = 64, c = Math.PI * r, v = 0.78;
  return (
    <svg viewBox="0 0 160 96" className="mx-auto h-24 w-auto max-w-full" role="img" aria-label={label}>
      <path d="M16,86 A64,64 0 0 1 144,86" fill="none" stroke="var(--line)" strokeWidth="9" strokeLinecap="round" />
      <path d="M16,86 A64,64 0 0 1 144,86" fill="none" stroke="var(--good)" strokeWidth="9" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v)} />
      <text x="80" y="78" textAnchor="middle" className="num" fontSize="30" fill="var(--text)">78</text>
    </svg>
  );
}

function Bento() {
  const { t } = useT();
  const card = 'glass-xl p-5 sm:p-6';
  const head = (n) => (<><p className="eyebrow">{t(`lp.f.${n}.k`)}</p><h3 className="mt-2 font-serif text-[22px] leading-tight tracking-tight">{t(`lp.f.${n}.t`)}</h3><p className="mt-2 text-[13.5px] text-muted">{t(`lp.f.${n}.p`)}</p></>);
  return (
    <section id="features" className="relative z-10 mx-auto max-w-[1240px] px-5 pt-24 sm:px-8">
      <Reveal className="max-w-2xl">
        <p className="eyebrow">{t('lp.f.eyebrow')}</p>
        <h2 className="mt-3 font-serif text-[clamp(32px,4.2vw,50px)] leading-[1.04] tracking-tight" style={{ fontVariationSettings: '"opsz" 144, "SOFT" 40' }}>{t('lp.f.title')}</h2>
        <p className="mt-4 text-[16px] text-muted">{t('lp.f.sub')}</p>
      </Reveal>
      <div className="mt-10 grid gap-4 md:grid-cols-3">
        <Reveal className={card}>{head('sla')}<div className="mt-4"><SlaCurve /></div></Reveal>
        <Reveal d={1} className={card}>{head('inc')}<div className="mt-4"><IncidentBars /></div></Reveal>
        <Reveal d={2} className={card}>{head('ans')}<div className="mt-4"><Gauge label={t('lp.f.ans.gauge')} /></div></Reveal>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ Chiffres vérifiables
function Stats() {
  const { t } = useT();
  const items = [['48', 's1'], ['3', 's2'], ['0', 's3'], ['120', 's4']];
  return (
    <section className="relative z-10 mx-auto max-w-[1240px] px-5 pt-20 sm:px-8">
      <Reveal className="glass-xl grid grid-cols-2 gap-y-8 px-6 py-8 sm:px-10 lg:grid-cols-4">
        {items.map(([v, k]) => (
          <div key={k} className="text-center">
            <p className="num text-[clamp(40px,5vw,60px)] leading-none text-accent">{v}</p>
            <p className="mx-auto mt-3 max-w-[200px] text-[13.5px] text-muted">{t(`lp.x.${k}`)}</p>
          </div>
        ))}
      </Reveal>
    </section>
  );
}

// ------------------------------------------------------------------ Tout ce qu'il y a autour des graphiques
function Platform() {
  const { t } = useT();
  const tiles = [['chat', 'chat'], ['bolt', 'auto'], ['building', 'cust'], ['spark', 'lang'], ['plug', 'int'], ['shield', 'priv']];
  return (
    <section id="platform" className="relative z-10 mx-auto max-w-[1240px] px-5 pt-28 sm:px-8">
      <Reveal className="max-w-2xl">
        <p className="eyebrow">{t('lp.x.p.eyebrow')}</p>
        <h2 className="mt-3 font-serif text-[clamp(32px,4.2vw,50px)] leading-[1.04] tracking-tight" style={{ fontVariationSettings: '"opsz" 144, "SOFT" 40' }}>{t('lp.x.p.title')}</h2>
        <p className="mt-4 text-[16px] text-muted">{t('lp.x.p.sub')}</p>
      </Reveal>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map(([ic, k], i) => (
          <Reveal key={k} d={i % 3} className="glass-xl p-6">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-accent/15 text-accent"><Icon name={ic} size={21} /></span>
            <h3 className="mt-5 text-[17px] font-semibold">{t(`lp.x.p.${k}.t`)}</h3>
            <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{t(`lp.x.p.${k}.p`)}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ Captures réelles de l'application (démo)
function Shots() {
  const { t } = useT();
  const shots = [['dashboard', 1], ['messages', 2], ['copilot', 3]];
  return (
    <section id="shots" className="relative z-10 mx-auto max-w-[1240px] px-5 pt-28 sm:px-8">
      <Reveal className="max-w-2xl">
        <p className="eyebrow">{t('lp.x.shots.eyebrow')}</p>
        <h2 className="mt-3 font-serif text-[clamp(32px,4.2vw,50px)] leading-[1.04] tracking-tight" style={{ fontVariationSettings: '"opsz" 144, "SOFT" 40' }}>{t('lp.x.shots.title')}</h2>
        <p className="mt-4 text-[16px] text-muted">{t('lp.x.shots.sub')}</p>
      </Reveal>
      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {shots.map(([file, n], i) => (
          <Reveal key={file} d={i} className="glass-xl overflow-hidden p-3">
            <img src={`/shots/${file}.jpg`} alt={t(`lp.x.shots.${n}.t`)} width="1366" height="633" loading="lazy" className="w-full rounded-2xl border border-line" />
            <div className="px-3 pb-3 pt-4">
              <h3 className="text-[16px] font-semibold">{t(`lp.x.shots.${n}.t`)}</h3>
              <p className="mt-1 text-[13.5px] leading-relaxed text-muted">{t(`lp.x.shots.${n}.p`)}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ Trois étapes
function Steps() {
  const { t } = useT();
  return (
    <section className="relative z-10 mx-auto max-w-[1240px] px-5 pt-32 sm:px-8">
      <Reveal className="max-w-2xl">
        <p className="eyebrow">{t('lp.x.st.eyebrow')}</p>
        <h2 className="mt-3 font-serif text-[clamp(32px,4.2vw,50px)] leading-[1.04] tracking-tight" style={{ fontVariationSettings: '"opsz" 144, "SOFT" 40' }}>{t('lp.x.st.title')}</h2>
      </Reveal>
      <ol className="relative mt-10 grid gap-4 md:grid-cols-3">
        {[1, 2, 3].map((n) => (
          <Reveal as="li" key={n} d={n - 1} className="glass-xl relative list-none p-6">
            <span className="num text-[44px] leading-none text-accent">{n}</span>
            <h3 className="mt-4 text-[17px] font-semibold">{t(`lp.x.st.${n}.t`)}</h3>
            <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{t(`lp.x.st.${n}.p`)}</p>
          </Reveal>
        ))}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------ Masquage des données personnelles (résultat réel de redactPII)
const TOKEN = /(<[A-Z0-9_]+>)/g;
function PiiDemo() {
  const { t } = useT();
  const [masked, setMasked] = useState(true);
  const text = t(masked ? 'lp.x.pii.out' : 'lp.x.pii.raw');
  return (
    <section className="relative z-10 mx-auto grid max-w-[1240px] items-center gap-10 px-5 pt-32 sm:px-8 lg:grid-cols-[1fr_1.05fr]">
      <Reveal>
        <p className="eyebrow">{t('lp.x.pii.eyebrow')}</p>
        <h2 className="mt-3 font-serif text-[clamp(32px,4.2vw,50px)] leading-[1.04] tracking-tight" style={{ fontVariationSettings: '"opsz" 144, "SOFT" 40' }}>{t('lp.x.pii.title')}</h2>
        <p className="mt-4 max-w-lg text-[16px] text-muted">{t('lp.x.pii.text')}</p>
        <p className="mt-4 max-w-lg text-[14px] text-faint">{t('lp.x.pii.note')}</p>
      </Reveal>
      <Reveal d={1} className="glass-xl p-5 sm:p-6">
        <div role="group" aria-label={t('lp.x.pii.title')} className="inline-flex gap-1 rounded-xl border border-line p-1">
          {[[false, 'lp.x.pii.showRaw'], [true, 'lp.x.pii.showMasked']].map(([v, k]) => (
            <button key={k} type="button" aria-pressed={masked === v} onClick={() => setMasked(v)}
              className={`h-8 rounded-lg px-3.5 text-[13px] font-semibold transition-colors ${masked === v ? 'bg-accent text-onaccent' : 'text-muted hover:text-ink'}`}>{t(k)}</button>
          ))}
        </div>
        <p className="mt-5 min-h-[96px] text-[15px] leading-relaxed" aria-live="polite">
          {text.split(TOKEN).map((part, i) => (i % 2 ? <code key={i} className="rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[13px] text-accent">{part}</code> : part))}
        </p>
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4 text-[12.5px] text-muted">
          <span>{t('lp.x.pii.found')}</span>
          {['email', 'phone', 'card'].map((k) => <span key={k} className="chip !h-6">{t(`lp.x.pii.${k}`)}</span>)}
        </div>
      </Reveal>
    </section>
  );
}

// ------------------------------------------------------------------ Questions fréquentes
function Faq() {
  const { t } = useT();
  return (
    <section id="faq" className="relative z-10 mx-auto max-w-[1240px] px-5 pt-32 sm:px-8"><div className="max-w-[860px]">
      <Reveal>
        <p className="eyebrow">{t('lp.x.faq.eyebrow')}</p>
        <h2 className="mt-3 font-serif text-[clamp(32px,4.2vw,50px)] leading-[1.04] tracking-tight" style={{ fontVariationSettings: '"opsz" 144, "SOFT" 40' }}>{t('lp.x.faq.title')}</h2>
      </Reveal>
      <Reveal d={1} className="mt-8 space-y-3">
        {[1, 2, 3, 4, 5].map((n) => (
          <details key={n} className="glass-xl group rounded-2xl px-5 py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[16px] font-semibold [&::-webkit-details-marker]:hidden">
              {t(`lp.x.faq.q${n}`)}
              <Icon name="plus" size={18} className="shrink-0 text-accent transition-transform duration-300 group-open:rotate-45" />
            </summary>
            <p className="mt-3 text-[14.5px] leading-relaxed text-muted">{t(`lp.x.faq.a${n}`)}</p>
          </details>
        ))}
      </Reveal>
    </div></section>
  );
}

function Jira() {
  const { t } = useT();
  return (
    <section id="jira" className="relative z-10 mx-auto grid max-w-[1240px] items-center gap-12 px-5 pt-32 sm:px-8 lg:grid-cols-[1fr_1.05fr]">
      <Reveal>
        <p className="eyebrow">{t('lp.j.eyebrow')}</p>
        <h2 className="mt-3 font-serif text-[clamp(34px,4.4vw,54px)] leading-[1.04] tracking-tight" style={{ fontVariationSettings: '"opsz" 144, "SOFT" 40' }}>{t('lp.j.title')}</h2>
        <p className="mt-4 max-w-lg text-[16px] text-muted">{t('lp.j.text')}</p>
        <ul className="mt-7 grid gap-2.5 sm:grid-cols-2">
          {[1, 2, 3, 4, 5, 6].map((n) => <li key={n} className="flex items-center gap-2.5 text-[14px]"><span className="grid h-6 w-6 place-items-center rounded-lg bg-accent/15 text-accent"><Icon name="check" size={13} strokeWidth={2.4} /></span>{t(`lp.j.a${n}`)}</li>)}
        </ul>
      </Reveal>
      <Reveal d={1} className="relative">
        <div className="absolute -inset-6 -z-10 rounded-[40px] bg-[radial-gradient(circle,rgb(255_140_70/.35),transparent_65%)] blur-2xl" aria-hidden="true" />
        <div className="glass-xl p-5 sm:p-6">
          <div className="flex items-center gap-3 border-b border-line pb-4"><span className="grid h-9 w-9 place-items-center rounded-xl bg-accent text-onaccent"><Icon name="spark" size={18} /></span><div><p className="text-[14px] font-semibold">Kairos Support Copilot</p><p className="text-[12px] text-muted">{t('lp.j.agent')}</p></div></div>
          <div className="space-y-3 py-5">
            <p className="ml-auto max-w-[85%] rounded-2xl rounded-br-md border border-accent/30 bg-accent/15 px-4 py-2.5 text-[13.5px]">{t('lp.j.msg1')}</p>
            <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-3 text-[13.5px] leading-relaxed">
              <p>{t('lp.j.reply1')}</p>
              <ul className="mt-2.5 space-y-1.5 text-[12.5px] text-muted">
                <li className="flex gap-2"><Icon name="alert" size={14} className="mt-0.5 shrink-0 text-warn" />{t('lp.j.reply2')}</li>
                <li className="flex gap-2"><Icon name="book" size={14} className="mt-0.5 shrink-0 text-accent" />{t('lp.j.reply3')}</li>
              </ul>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">{[1, 2, 3].map((n) => <span key={n} className="chip !h-8 !text-[12.5px]">{t(`lp.j.s${n}`)}</span>)}</div>
        </div>
      </Reveal>
    </section>
  );
}

function Trust() {
  const { t } = useT();
  const items = [['shield', 'audit'], ['key', 'keys'], ['users', 'orgs'], ['link', 'ssrf']];
  return (
    <section id="trust" className="relative z-10 mx-auto max-w-[1240px] px-5 pt-32 sm:px-8">
      <Reveal className="max-w-2xl">
        <p className="eyebrow">{t('lp.t.eyebrow')}</p>
        <h2 className="mt-3 font-serif text-[clamp(34px,4.4vw,54px)] leading-[1.04] tracking-tight" style={{ fontVariationSettings: '"opsz" 144, "SOFT" 40' }}>{t('lp.t.title')}</h2>
      </Reveal>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map(([ic, k], i) => (
          <Reveal key={k} d={i} className="glass-xl p-6">
            <span className="grid h-10 w-10 place-items-center rounded-xl border border-line text-accent"><Icon name={ic} size={20} /></span>
            <h3 className="mt-5 text-[16px] font-semibold">{t(`lp.t.${k}.t`)}</h3>
            <p className="mt-1.5 text-[13.5px] text-muted">{t(`lp.t.${k}.p`)}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

export default function Landing() {
  const { t } = useT();
  const providers = useResource(() => get('/auth/providers', { auth: false }).catch(() => null), []);
  const [theme, toggleTheme] = useTheme();
  const strip = [1, 2, 3, 4, 5];
  return (
    <div className="lp min-h-screen">
      <div className="lp-aura" aria-hidden="true"><i className="a" /><i className="b" /><i className="c" /></div>
      <div className="lp-grid" aria-hidden="true" />

      <header className="fixed inset-x-0 top-4 z-50 flex justify-center px-4">
        <nav className="glass-xl flex w-full max-w-[1020px] items-center justify-between !rounded-full py-2 pl-5 pr-2" aria-label={t('nav.main')}>
          <Link to="/welcome" aria-label="Kairos"><Logo size={28} /></Link>
          <div className="hidden items-center gap-7 text-[14px] text-muted md:flex">
            <a href="#features" className="hover:text-ink">{t('lp.nav.features')}</a>
            <a href="#jira" className="hover:text-ink">{t('lp.nav.jira')}</a>
            <a href="#trust" className="hover:text-ink">{t('lp.nav.trust')}</a>
            <a href="#faq" className="hover:text-ink">{t('lp.x.nav')}</a>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:block"><LangSwitch /></div>
            <button type="button" className="btn btn-ghost h-9 w-9 !p-0" onClick={toggleTheme} aria-label={t('common.theme')} title={t('common.theme')}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} /></button>
            <Link to="/login" className="btn btn-ghost hidden h-9 sm:inline-flex">{t('lp.nav.login')}</Link>
            <Link to="/register" className="btn btn-primary h-9 !rounded-full">{t('lp.nav.start')}</Link>
          </div>
        </nav>
      </header>

      <main>
        <section className="relative z-10 mx-auto grid min-h-[100svh] max-w-[1240px] items-center gap-4 px-5 pb-10 pt-28 sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-10">
          <div className="min-w-0">
            <p className="rise inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[12.5px] text-muted"><i className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" />{t('lp.hero.eyebrow')}</p>
            <h1 className="rise mt-6 font-serif text-[clamp(42px,5.4vw,80px)] leading-[0.98] tracking-tight" style={{ '--i': 1, fontVariationSettings: '"opsz" 144, "SOFT" 50' }}>
              {t('lp.hero.t1')} <em className="text-accent" style={{ fontStyle: 'italic' }}>{t('lp.hero.t2')}</em>
            </h1>
            <p className="rise mt-6 max-w-[520px] text-[17px] leading-relaxed text-muted" style={{ '--i': 2 }}>{t('lp.hero.sub')}</p>
            <div className="rise mt-9 flex flex-wrap items-center gap-3" style={{ '--i': 3 }}>
              <Link to="/register" className="btn btn-primary !h-12 !rounded-full px-7 text-[15px]">{t('lp.hero.cta1')} <Icon name="arrow" size={16} /></Link>
              {providers.data?.demo && <Link to="/demo" className="btn !h-12 !rounded-full border-accent/50 px-6 text-[15px] text-accent">{t('lp.hero.demo')}</Link>}
              <a href="#features" className="btn !h-12 !rounded-full px-6 text-[15px]">{t('lp.hero.cta2')}</a>
            </div>
            <p className="rise mt-5 text-[13px] text-faint" style={{ '--i': 4 }}>{t('lp.hero.note')}</p>
          </div>
          <div className="rise" style={{ '--i': 2 }}><SunScene /></div>
        </section>

        <div className="relative z-10 mt-6 overflow-hidden border-y border-line py-4" aria-hidden="true">
          <div className="marquee flex w-max gap-12 whitespace-nowrap text-[14px] text-muted">
            {[...strip, ...strip, ...strip, ...strip].map((n, i) => <span key={i} className="flex items-center gap-12">{t(`lp.strip.${n}`)}<i className="h-1 w-1 rounded-full bg-accent" /></span>)}
          </div>
        </div>

        <Stats />
        <Bento />
        <Platform />
        <Shots />
        <Jira />
        <Steps />
        <PiiDemo />
        <Trust />
        <Faq />

        <section className="relative z-10 mx-auto max-w-[1240px] px-5 pb-28 pt-32 sm:px-8">
          <Reveal className="glass-xl relative overflow-hidden px-6 py-16 text-center sm:px-12">
            <div className="absolute left-1/2 top-0 -z-10 h-72 w-[640px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgb(255_140_70/.55),transparent_65%)] blur-2xl" aria-hidden="true" />
            <h2 className="mx-auto max-w-2xl font-serif text-[clamp(34px,5vw,62px)] leading-[1.03] tracking-tight" style={{ fontVariationSettings: '"opsz" 144, "SOFT" 50' }}>{t('lp.cta.title')}</h2>
            <p className="mx-auto mt-4 max-w-xl text-[16px] text-muted">{t('lp.cta.text')}</p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link to="/register" className="btn btn-primary !h-12 !rounded-full px-8 text-[15px]">{t('lp.cta.btn')} <Icon name="arrow" size={16} /></Link>
              <Link to="/login" className="btn !h-12 !rounded-full px-7 text-[15px]">{t('lp.cta.login')}</Link>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="relative z-10 border-t border-line px-5 py-8 sm:px-8">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-4 text-[13px] text-faint">
          <Logo size={22} />
          <p>{t('lp.foot')}</p>
          <nav className="flex gap-4"><Link to="/privacy" className="hover:text-ink">{t('legal.nav.privacy')}</Link><Link to="/terms" className="hover:text-ink">{t('legal.nav.terms')}</Link></nav>
          <LangSwitch />
        </div>
      </footer>
    </div>
  );
}
