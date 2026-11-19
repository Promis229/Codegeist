import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { getBlob } from '../lib/api.js';
import { errText, localeOf, tr, useT } from '../i18n/index.jsx';
import Icon from './Icon.jsx';

export const cx = (...a) => a.filter(Boolean).join(' ');

export function Card({ className = '', i = 0, children, ...p }) {
  return <section {...p} style={{ '--i': i, ...p.style }} className={cx('glass rise rounded-2xl', className)}>{children}</section>;
}

export function CardHead({ title, hint, right }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-5">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}
      </div>
      {right}
    </header>
  );
}

export function PageHead({ eyebrow, title, children }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <p className="eyebrow rise">{eyebrow}</p>}
        <h1 className="rise mt-1 font-serif text-[34px] leading-[1.1] tracking-tight sm:text-[42px]" style={{ '--i': 1, fontVariationSettings: '"opsz" 144, "SOFT" 40' }}>{title}</h1>
      </div>
      <div className="rise flex min-w-0 max-w-full items-center gap-2" style={{ '--i': 2 }}>{children}</div>
    </div>
  );
}

export function Stat({ label, value, unit, hint, tone, i = 0 }) {
  const color = { good: 'text-good', warn: 'text-warn', bad: 'text-bad' }[tone] || 'text-ink';
  return (
    <Card i={i} className="p-5">
      <p className="eyebrow">{label}</p>
      <p className={cx('num mt-3 text-[44px] leading-none', color)}>
        {value ?? <span className="text-faint">–</span>}
        {unit && value != null && <span className="ml-1 text-[18px] text-muted">{unit}</span>}
      </p>
      {hint && <p className="mt-3 text-[13px] text-muted">{hint}</p>}
    </Card>
  );
}

const TONES = {
  critical: 'text-bad border-bad/40 bg-bad/10', high: 'text-accent2 border-accent2/40 bg-accent2/10',
  medium: 'text-warn border-warn/40 bg-warn/10', low: 'text-muted',
  open: 'text-accent border-accent/40 bg-accent/10', pending: 'text-warn border-warn/40 bg-warn/10',
  resolved: 'text-good border-good/40 bg-good/10', closed: 'text-muted',
  good: 'text-good border-good/40 bg-good/10', bad: 'text-bad border-bad/40 bg-bad/10', warn: 'text-warn border-warn/40 bg-warn/10',
  enterprise: 'text-accent border-accent/40 bg-accent/10', premium: 'text-warn border-warn/40 bg-warn/10', standard: 'text-muted',
};
export const Badge = ({ tone, children }) => <span className={cx('chip', TONES[tone])}>{children}</span>;

export function Field({ label, hint, error, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-muted">{label}</span>
      {children}
      {hint && !error && <span className="mt-1.5 block text-[12px] text-faint">{hint}</span>}
      {error && <span role="alert" className="mt-1.5 block text-[12px] text-bad">{error}</span>}
    </label>
  );
}

/** Champ mot de passe avec bascule afficher / masquer (œil). Même API qu'un <input>. */
export function PasswordInput({ className = '', ...props }) {
  const { t } = useT();
  const [shown, setShown] = useState(false);
  return (
    <span className="relative block">
      <input {...props} type={shown ? 'text' : 'password'} className={cx('input !pr-12', className)} />
      <button type="button" onClick={() => setShown(!shown)} aria-pressed={shown} tabIndex={0}
        aria-label={shown ? t('common.hidePassword') : t('common.showPassword')} title={shown ? t('common.hidePassword') : t('common.showPassword')}
        className="absolute right-1.5 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-lg text-faint transition-colors hover:bg-surface2 hover:text-ink">
        <Icon name={shown ? 'eyeOff' : 'eye'} size={18} />
      </button>
    </span>
  );
}

export function Spinner({ size = 18 }) {
  return <span className="inline-block animate-spin rounded-full border-2 border-line2 border-t-accent" style={{ width: size, height: size }} aria-label={tr('common.loading')} />;
}

export function Skeleton({ className = 'h-24' }) {
  return <div className={cx('shimmer rounded-xl', className)} />;
}

export function Empty({ icon = 'spark', title, children }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="mb-4 grid h-12 w-12 place-items-center rounded-2xl border border-line text-accent"><Icon name={icon} size={22} /></span>
      <p className="font-semibold">{title}</p>
      {children && <p className="mt-1 max-w-sm text-[13px] text-muted">{children}</p>}
    </div>
  );
}

export function ErrorNote({ error, retry }) {
  const { t } = useT();
  if (!error) return null;
  return (
    <div role="alert" className="flex items-center gap-3 rounded-xl border border-bad/40 bg-bad/10 px-4 py-3 text-[14px] text-bad">
      <Icon name="alert" /> <span className="flex-1">{errText(error)}</span>
      {retry && <button className="btn btn-ghost h-8" onClick={retry}>{t('common.retry')}</button>}
    </div>
  );
}

/** Bandeau de progression 0..1 */
export function Meter({ value, tone = 'accent' }) {
  const bg = { accent: 'bg-accent', bad: 'bg-bad', warn: 'bg-warn', good: 'bg-good' }[tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line" role="meter" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full rounded-full transition-[width] duration-[900ms]', bg)} style={{ width: `${Math.max(2, Math.min(1, value) * 100)}%`, transitionTimingFunction: 'var(--spring)' }} />
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div role="tablist" className="glass inline-flex max-w-full gap-1 overflow-x-auto rounded-xl p-1">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cx('h-8 shrink-0 whitespace-nowrap rounded-lg px-3.5 text-[13px] font-semibold transition-[background,color,transform] duration-500',
            value === t.id ? 'bg-accent text-onaccent' : 'text-muted hover:text-ink')}
          style={{ transitionTimingFunction: 'var(--spring)' }}>{t.label}</button>
      ))}
    </div>
  );
}

// ---------- Avatar : photo téléversée, photo du fournisseur de connexion, ou deux initiales ----------
/** « Promis FANGNON » → « PF » ; un seul mot → ses deux premières lettres. */
export function initials(name = '') {
  const p = String(name).trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  const a = [...p[0]][0] ?? '';
  const b = p.length > 1 ? [...p[p.length - 1]][0] : ([...p[0]][1] ?? '');
  return `${a}${b}`.toUpperCase();
}
const blobUrls = new Map(); // chemin -> Promise<URL d'objet> (une photo n'est téléchargée qu'une fois par session)
export function useBlobUrl(path) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!path) { setUrl(null); return undefined; }
    if (!blobUrls.has(path)) blobUrls.set(path, getBlob(path).then((b) => URL.createObjectURL(b)).catch((e) => { blobUrls.delete(path); throw e; }));
    blobUrls.get(path).then((u) => alive && setUrl(u), () => alive && setUrl(null));
    return () => { alive = false; };
  }, [path]);
  return url;
}
const EXTERNAL_OK = /^https:\/\/(lh3\.googleusercontent\.com|avatars\.githubusercontent\.com)\//; // hôtes autorisés par la CSP
export function Avatar({ name, src, size = 36, className = '' }) {
  const own = src && src.startsWith('/users/') ? src : null;
  const blob = useBlobUrl(own);
  const url = blob ?? (src && EXTERNAL_OK.test(src) ? src : null);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  return (
    <span className={cx('grid shrink-0 select-none place-items-center overflow-hidden rounded-full bg-accent font-semibold text-onaccent', className)}
      style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.38)) }} aria-hidden="true">
      {url && !broken ? <img src={url} alt="" className="h-full w-full object-cover" onError={() => setBroken(true)} referrerPolicy="no-referrer" /> : initials(name)}
    </span>
  );
}

/** Fenetre modale : fermeture par Echap ou clic hors du cadre, defilement interne sur petit ecran. */
export function Modal({ title, onClose, children, wide = false }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fade fixed inset-0 z-40 grid place-items-start overflow-y-auto bg-black/50 p-4 backdrop-blur-sm sm:place-items-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('glass rise my-auto w-full space-y-4 rounded-3xl p-6 sm:p-7', wide ? 'max-w-[760px]' : 'max-w-[540px]')} style={{ background: 'var(--surface-solid)' }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-serif text-[26px] leading-tight tracking-tight">{title}</h2>
          <button type="button" className="btn btn-ghost h-9 w-9 shrink-0 !p-0" onClick={onClose} aria-label={tr('common.close')}><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- Toasts ----------
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [items, set] = useState([]);
  const push = useCallback((message, tone = 'good') => {
    const id = Math.random().toString(36).slice(2);
    set((l) => [...l, { id, message, tone }]);
    setTimeout(() => set((l) => l.filter((x) => x.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="glass rise pointer-events-auto flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-[14px]" style={{ background: 'var(--surface-solid)' }}>
            <Icon name={t.tone === 'bad' ? 'alert' : 'check'} size={16} className={t.tone === 'bad' ? 'text-bad' : 'text-good'} /> {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const fmtDate = (d) => new Date(d).toLocaleString(localeOf(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
export const ago = (d) => {
  const m = Math.max(0, (Date.now() - new Date(d)) / 60000);
  if (m < 1) return tr('time.now');
  if (m < 60) return tr('time.min', { n: Math.round(m) });
  if (m < 1440) return tr('time.hour', { n: Math.round(m / 60) });
  return tr('time.day', { n: Math.round(m / 1440) });
};
export const pct = (v) => (v == null ? null : Math.round(v * 100));
