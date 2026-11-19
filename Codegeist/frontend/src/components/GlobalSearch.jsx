import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { get } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useDebounced } from '../lib/hooks.js';
import { NAV, fold } from '../lib/nav.js';
import { useT } from '../i18n/index.jsx';
import Icon from './Icon.jsx';
import { Badge, Spinner, cx } from './ui.jsx';

/**
 * Recherche globale intégrée à la page : on écrit, les résultats apparaissent juste dessous (pas de fenêtre modale).
 * Elle trouve des écrans (instantané, sans réseau), des demandes, des clients, des collègues, des salons, des messages et des articles.
 * Ctrl/Cmd + K place le curseur dans le champ ; flèches + Entrée pour ouvrir, Échap pour fermer.
 */
const GlobalSearch = forwardRef(function GlobalSearch({ className = '' }, ref) {
  const { t } = useT();
  const { can } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ loading: false, data: null, error: false });
  const [cursor, setCursor] = useState(0);
  const dq = useDebounced(q.trim(), 200);
  const input = useRef(null);
  const box = useRef(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }));

  useEffect(() => { setOpen(false); setQ(''); }, [loc.pathname, loc.search]);

  useEffect(() => {
    if (dq.length < 2) { setState({ loading: false, data: null, error: false }); return undefined; }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    get(`/search?q=${encodeURIComponent(dq)}`).then(
      (data) => { if (alive) { setState({ loading: false, data, error: false }); setCursor(0); } },
      () => { if (alive) setState({ loading: false, data: null, error: true }); },
    );
    return () => { alive = false; };
  }, [dq]);

  useEffect(() => {
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, []);

  const items = useMemo(() => {
    const needle = fold(q.trim());
    // Écrans : trouvés tout de suite, même hors connexion ou quand l'organisation est vide.
    const pages = needle.length < 2 ? [] : NAV.filter((n) => !n.min || can(n.min))
      .filter((n) => fold(`${t(n.key)} ${t(n.kw)}`).includes(needle))
      .map((n) => ({ k: `p${n.to}`, group: 'sr.pages', icon: n.icon, label: t(n.key), hint: '', to: n.to }));
    const d = state.data;
    if (!d) return pages;
    return [
      ...pages,
      ...d.tickets.map((x) => ({ k: `t${x.id}`, group: 'sr.tickets', icon: 'ticket', label: x.title, hint: x.key, badge: x.priority, to: `/tickets/${x.id}` })),
      ...d.customers.map((x) => ({ k: `c${x.id}`, group: 'sr.customers', icon: 'building', label: x.name, hint: x.company || x.email, to: `/customers?q=${encodeURIComponent(x.email)}` })),
      ...(d.members ?? []).map((x) => ({ k: `m${x.id}`, group: 'sr.members', icon: 'users', label: x.name, hint: x.email, to: '/team' })),
      ...(d.channels ?? []).map((x) => ({ k: `h${x.id}`, group: 'sr.channels', icon: 'chat', label: `#${x.name}`, hint: '', to: `/messages/${x.id}` })),
      ...(d.messages ?? []).map((x) => ({ k: `g${x.id}`, group: 'sr.messages', icon: 'chat', label: x.body, hint: x.kind === 'dm' ? (x.author ?? '') : `#${x.channel}`, to: `/messages/${x.channelId}` })),
      ...d.kb.map((x) => ({ k: `k${x.id}`, group: 'sr.kb', icon: 'book', label: x.title, hint: '', to: `/knowledge?q=${encodeURIComponent(x.title)}` })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.data, q, can]);

  const go = (it) => { setOpen(false); input.current?.blur(); nav(it.to); };
  const onKey = (e) => {
    if (e.key === 'Escape') { setOpen(false); input.current?.blur(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setCursor((c) => Math.min(items.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === 'Enter' && items[cursor]) { e.preventDefault(); go(items[cursor]); }
  };
  const typed = q.trim().length >= 2;
  const showPanel = open && typed;
  const waiting = typed && !state.data && !state.error; // la réponse du serveur n'est pas encore là
  let lastGroup = null;

  return (
    <div ref={box} className={cx('relative', className)}>
      <div className="relative">
        <Icon name="search" size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
        <input ref={input} type="search" className="input !h-11 !pl-10 !pr-14" placeholder={t('sr.placeholder')} value={q} autoComplete="off"
          onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKey}
          role="combobox" aria-expanded={showPanel} aria-controls="global-search-results" aria-label={t('sr.title')} />
        <span className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
          {state.loading ? <Spinner size={14} /> : <kbd className="hidden rounded-md border border-line px-1.5 py-0.5 text-[11px] text-faint sm:block">{'Ctrl K'}</kbd>}
        </span>
      </div>

      {showPanel && (
        <div id="global-search-results" role="listbox" className="glass-xl absolute inset-x-0 top-full z-40 mt-2 max-h-[60vh] overflow-y-auto rounded-2xl p-2" style={{ background: 'var(--surface-solid)' }}>
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? <p className="eyebrow px-3 pb-1 pt-3">{t(it.group)}</p> : null;
            lastGroup = it.group;
            return (
              <div key={it.k}>
                {head}
                <button type="button" role="option" aria-selected={i === cursor} onMouseEnter={() => setCursor(i)} onClick={() => go(it)}
                  className={cx('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left', i === cursor ? 'bg-surface2' : '')}>
                  <Icon name={it.icon} size={16} className="shrink-0 text-accent" />
                  <span className="min-w-0 flex-1 truncate text-[14px]">{it.label}</span>
                  {it.hint && <span className="hidden max-w-[40%] shrink-0 truncate text-[12px] text-faint sm:inline">{it.hint}</span>}
                  {it.badge && <Badge tone={it.badge}>{t(`prio.${it.badge}`)}</Badge>}
                </button>
              </div>
            );
          })}
          {state.error && <p role="alert" className="px-4 py-4 text-center text-[13px] text-bad">{t('sr.error')}</p>}
          {waiting && !items.length && <p className="px-4 py-6 text-center text-[14px] text-muted">{t('common.loading')}</p>}
          {state.data && !items.length && !state.loading && (
            <div className="px-4 py-6 text-center">
              <p className="text-[14px] text-muted">{t('sr.none', { q: dq })}</p>
              <p className="mt-1 text-[12.5px] text-faint">{t('sr.tryHint')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default GlobalSearch;
