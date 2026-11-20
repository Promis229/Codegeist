import { Suspense, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { get } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useTheme } from '../lib/hooks.js';
import { useInstall } from '../lib/pwa.js';
import { LangSwitch, useT } from '../i18n/index.jsx';
import { Logo } from './Logo.jsx';
import Icon from './Icon.jsx';
import { Avatar, Skeleton, cx } from './ui.jsx';
import GlobalSearch from './GlobalSearch.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';

import { NAV } from '../lib/nav.js';

export default function Layout() {
  const { t, lang } = useT();
  const { me, logout, switchOrg, can } = useAuth();
  const [theme, toggle] = useTheme();
  const { status: installStatus, install } = useInstall();
  const [open, setOpen] = useState(false);
  const search = useRef(null);
  const nav = useNavigate();
  const org = me.orgs.find((o) => o.id === me.activeOrgId);

  // Pastille de messages non lus : un compteur leger, interroge toutes les 15 s tant que l'onglet est visible.
  const [unread, setUnread] = useState(0);
  const loc = useLocation();
  useEffect(() => {
    let alive = true;
    const load = () => { if (document.visibilityState === 'visible') get('/chat/unread').then((r) => alive && setUnread(r.unread), () => {}); };
    load();
    const h = setInterval(load, 15000);
    document.addEventListener('visibilitychange', load);
    return () => { alive = false; clearInterval(h); document.removeEventListener('visibilitychange', load); };
  }, [loc.pathname]);

  useEffect(() => {
    const h = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); search.current?.focus(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const links = (
    <nav className="flex flex-col gap-1" aria-label={t('nav.main')}>
      {NAV.filter((n) => !n.min || can(n.min)).map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setOpen(false)}
          className={({ isActive }) => cx('group flex h-10 items-center gap-3 rounded-xl px-3 text-[14px] font-medium transition-[background,color,transform] duration-500',
            isActive ? 'bg-surface2 text-ink shadow-[inset_2px_0_0_var(--accent)]' : 'text-muted hover:bg-surface hover:text-ink')}
          style={{ transitionTimingFunction: 'var(--spring)' }}>
          <Icon name={n.icon} /> <span className="flex-1">{t(n.key)}</span>
          {n.badge && unread > 0 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-bold text-onaccent" aria-label={t('ms.unread', { n: unread })}>{unread > 99 ? '99+' : unread}</span>}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[252px_1fr]">
      <div className="aura" aria-hidden="true" />

      {/* Barre mobile */}
      <header className="glass sticky top-0 z-30 flex h-14 items-center justify-between border-x-0 border-t-0 px-4 lg:hidden">
        <Logo size={26} />
        <button className="btn btn-ghost h-9 w-9 !p-0" aria-label={t('nav.menu')} onClick={() => setOpen(!open)}><Icon name={open ? 'x' : 'menu'} /></button>
      </header>

      <aside className={cx('glass bg-solid lg:bg-surface fixed inset-x-0 top-14 z-20 max-h-[calc(100dvh-3.5rem)] origin-top overflow-y-auto overscroll-contain border-x-0 border-t-0 p-4 transition-[transform,opacity] duration-500 lg:sticky lg:top-0 lg:z-10 lg:flex lg:h-screen lg:max-h-none lg:translate-y-0 lg:flex-col lg:overflow-y-auto lg:border-y-0 lg:border-l-0 lg:p-5 lg:opacity-100',
        open ? 'translate-y-0 opacity-100' : '-translate-y-3 pointer-events-none opacity-0 lg:pointer-events-auto')}
        style={{ transitionTimingFunction: 'var(--spring)' }}>
        <div className="mb-8 hidden px-2 pt-1 lg:block"><Logo size={30} /></div>

        {me.orgs.length > 1 ? (
          <select className="input mb-5 !h-10 text-[13px]" value={me.activeOrgId} onChange={(e) => switchOrg(e.target.value)} aria-label={t('nav.org')}>
            {me.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        ) : (
          <div className="mb-5 rounded-xl border border-line px-3 py-2.5">
            <p className="eyebrow">{t('nav.org')}</p>
            <p className="mt-0.5 truncate text-[14px] font-semibold">{org?.name}</p>
          </div>
        )}

        {links}

        <div className="mt-6 space-y-3 border-t border-line pt-4 lg:mt-auto">
          <LangSwitch className="w-full justify-between [&>button]:flex-1" />
          {installStatus === 'available' && (
            <button className="btn btn-secondary w-full" type="button" onClick={install}>
              {t('pwa.install')}
            </button>
          )}
          <div className="flex items-center gap-3 px-1">
            <Avatar name={me.user.displayName} src={me.user.avatarUrl} size={36} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold">{me.user.displayName}</p>
              <p className="text-[12px] text-faint">{t(`role.${me.role}`)}</p>
            </div>
            <button className="btn btn-ghost h-8 w-8 !p-0" onClick={toggle} aria-label={t('common.theme')}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} /></button>
            <button className="btn btn-ghost h-8 w-8 !p-0" onClick={async () => { await logout(); nav('/login'); }} aria-label={t('nav.logout')}><Icon name="out" size={16} /></button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 px-5 pb-20 pt-8 sm:px-8 lg:px-12 lg:pt-12">
        <div className="mx-auto max-w-[1180px]">
          <GlobalSearch ref={search} className="relative z-[12] mb-8 w-full max-w-[560px]" />
          {/* Une page qui plante n'emporte ni le menu ni la recherche : seul son contenu est remplacé, et il se rétablit au changement de page. */}
          <ErrorBoundary resetKey={loc.pathname}><Suspense key={lang} fallback={<Skeleton className="h-64" />}><Outlet /></Suspense></ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
