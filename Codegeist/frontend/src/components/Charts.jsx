import { useId, useState } from 'react';
import { localeOf, useT } from '../i18n/index.jsx';

/** Courbe lissee (Catmull-Rom -> Bezier) */
function smooth(pts) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const t = 0.18;
    d += ` C${p1[0] + (p2[0] - p0[0]) * t},${p1[1] + (p2[1] - p0[1]) * t} ${p2[0] - (p3[0] - p1[0]) * t},${p2[1] - (p3[1] - p1[1]) * t} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/** Deux series (creees / resolues) sur le temps, avec survol. */
export function AreaChart({ data, height = 220 }) {
  const { t } = useT();
  const id = useId().replace(/:/g, '');
  const [hover, setHover] = useState(null);
  const W = 720, H = height, pad = { l: 34, r: 10, t: 14, b: 26 };
  if (!data?.length) return null;
  const max = Math.max(4, ...data.flatMap((d) => [d.created, d.resolved]));
  const nice = Math.ceil(max / 4) * 4;
  const x = (i) => pad.l + (i / (data.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / nice) * (H - pad.t - pad.b);
  const line = (k) => data.map((d, i) => [x(i), y(d[k])]);
  const created = line('created'), resolved = line('resolved');
  const area = `${smooth(created)} L${x(data.length - 1)},${H - pad.b} L${x(0)},${H - pad.b} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(nice * f));
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(data.length - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (data.length - 1)))));
  };
  const h = hover != null ? data[hover] : null;
  const short = (day) => new Date(day).toLocaleDateString(localeOf(), { day: '2-digit', month: '2-digit' });
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={t('ch.aria')} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={`a${id}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity=".34" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((tk) => (
          <g key={tk}>
            <line x1={pad.l} x2={W - pad.r} y1={y(tk)} y2={y(tk)} stroke="var(--line)" strokeDasharray="2 5" />
            <text x={pad.l - 8} y={y(tk) + 4} textAnchor="end" fontSize="10.5" fill="var(--faint)">{tk}</text>
          </g>
        ))}
        {data.map((d, i) => (i % Math.ceil(data.length / 6) === 0) && (
          <text key={d.day} x={x(i)} y={H - 6} textAnchor="middle" fontSize="10.5" fill="var(--faint)">{short(d.day)}</text>
        ))}
        <path d={area} fill={`url(#a${id})`} className="fade" />
        <path d={smooth(created)} fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" className="draw" style={{ '--len': 2400 }} />
        <path d={smooth(resolved)} fill="none" stroke="var(--good)" strokeWidth="2" strokeLinecap="round" strokeDasharray="1 0" opacity=".9" className="draw" style={{ '--len': 2400 }} />
        {h && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--line-strong)" />
            <circle cx={x(hover)} cy={y(h.created)} r="4.5" fill="var(--accent)" stroke="var(--bg)" strokeWidth="2" />
            <circle cx={x(hover)} cy={y(h.resolved)} r="4.5" fill="var(--good)" stroke="var(--bg)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {h && (
        <div className="glass pointer-events-none absolute top-1 rounded-lg px-3 py-2 text-[12px]" style={{ left: `${(x(hover) / W) * 100}%`, transform: `translateX(${hover > data.length * 0.7 ? '-105%' : '8px'})`, background: 'var(--surface-solid)' }}>
          <p className="font-semibold">{new Date(h.day).toLocaleDateString(localeOf(), { weekday: 'short', day: 'numeric', month: 'short' })}</p>
          <p className="text-accent">{t('ch.created', { n: h.created })}</p><p className="text-good">{t('ch.resolved', { n: h.resolved })}</p>
        </div>
      )}
      <div className="mt-1 flex gap-4 pl-[34px] text-[12px] text-muted">
        <span className="inline-flex items-center gap-1.5"><i className="h-0.5 w-4 rounded bg-accent" /> {t('ch.legendCreated')}</span>
        <span className="inline-flex items-center gap-1.5"><i className="h-0.5 w-4 rounded bg-good" /> {t('ch.legendResolved')}</span>
      </div>
    </div>
  );
}

export function Sparkline({ values, width = 120, height = 32, color = 'var(--accent)' }) {
  if (!values?.length) return null;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * width, height - 3 - (v / max) * (height - 6)]);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={smooth(pts)} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** Anneau de probabilite (0..1) */
export function Ring({ value, size = 56, tone = 'var(--accent)', label }) {
  const r = (size - 8) / 2, c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth="4" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth="4" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0.02, Math.min(1, value)))} transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 1.1s var(--spring)' }} />
      <text x="50%" y="50%" dy=".35em" textAnchor="middle" fontSize={size * 0.27} fontWeight="650" fill="var(--text)" className="num">{Math.round(value * 100)}</text>
    </svg>
  );
}

/** Barres horizontales simples */
export function Bars({ rows, color = 'var(--accent)' }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <ul className="space-y-2.5">
      {rows.map((r, i) => (
        <li key={r.label} className="grid grid-cols-[110px_1fr_32px] items-center gap-3 text-[13px]">
          <span className="truncate text-muted">{r.label}</span>
          <span className="h-2 overflow-hidden rounded-full bg-line">
            <span className="block h-full rounded-full" style={{ width: `${(r.n / max) * 100}%`, background: color, transition: 'width 1s var(--spring)', transitionDelay: `${i * 60}ms` }} />
          </span>
          <span className="num text-right text-[15px]">{r.n}</span>
        </li>
      ))}
    </ul>
  );
}
