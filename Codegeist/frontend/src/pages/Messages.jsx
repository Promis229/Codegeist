import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, get, getBlob, patch, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { fmtSize, toBase64 } from '../lib/image.js';
import { errText, localeOf, useT } from '../i18n/index.jsx';
import Icon from '../components/Icon.jsx';
import { Avatar, Badge, Card, ErrorNote, Field, Modal, PageHead, Skeleton, Spinner, cx, useBlobUrl, useToast } from '../components/ui.jsx';

const MAX_FILES = 4, MAX_FILE = 3 * 1024 * 1024, MAX_TOTAL = 3 * 1024 * 1024;
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf,.docx,.xlsx,.pptx,.zip,.txt,.csv,.log,.md';

/** Pièce jointe : les images s'affichent (téléchargées avec le jeton), les autres fichiers se téléchargent au clic. */
function AttachmentView({ a }) {
  const { t } = useT();
  const isImage = a.mime.startsWith('image/');
  const url = useBlobUrl(isImage ? `/chat/attachments/${a.id}` : null);
  async function download() {
    try {
      const blob = await getBlob(`/chat/attachments/${a.id}`);
      const u = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = u; link.download = a.name; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(u), 4000);
    } catch { /* le message d'erreur est inutile ici : le fichier reste cliquable */ }
  }
  if (isImage) {
    return url
      ? <button type="button" onClick={() => window.open(url, '_blank', 'noopener')} className="block overflow-hidden rounded-xl border border-line" aria-label={t('ms.openImage', { name: a.name })}><img src={url} alt={a.name} className="max-h-60 max-w-full object-contain" loading="lazy" /></button>
      : <span className="grid h-24 w-40 place-items-center rounded-xl border border-line"><Spinner size={16} /></span>;
  }
  return (
    <button type="button" onClick={download} className="flex max-w-full items-center gap-3 rounded-xl border border-line px-3 py-2 text-left hover:bg-surface" aria-label={t('ms.download', { name: a.name })}>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent"><Icon name="download" size={16} /></span>
      <span className="min-w-0"><span className="block truncate text-[13.5px] font-medium">{a.name}</span><span className="text-[12px] text-faint">{fmtSize(a.size)}</span></span>
    </button>
  );
}

const KEY_RE = /\b([A-Z]{2,5}-\d{1,7})\b/g;
const POLL_MS = 3000;
const LIST_MS = 8000;

/** Fusionne la page la plus recente (source de verite : edits et suppressions comprises) avec l'historique deja charge. */
const merge = (prev, fresh) => {
  if (!fresh.length) return [];
  const lo = fresh[0].id;
  return [...prev.filter((m) => m.id < lo), ...fresh];
};

function useVisibleInterval(fn, ms) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') ref.current(); };
    const h = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(h); document.removeEventListener('visibilitychange', tick); };
  }, [ms]);
}

export default function Messages() {
  const { t } = useT();
  const { can } = useAuth();
  const { id } = useParams();
  const nav = useNavigate();
  const [list, setList] = useState({ channels: [], unread: 0 });
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [modal, setModal] = useState(null); // 'channel' | 'dm'

  const loadList = useCallback(async () => {
    try { setList(await get('/chat/channels')); setError(null); } catch (e) { setError(e); } finally { setLoaded(true); }
  }, []);
  useEffect(() => { loadList(); }, [loadList]);
  useVisibleInterval(loadList, LIST_MS);

  // Sur grand ecran, on ouvre le salon general par defaut ; sur telephone on affiche d'abord la liste.
  useEffect(() => {
    if (id || !loaded || !list.channels.length) return;
    if (window.matchMedia('(min-width: 1024px)').matches) {
      const g = list.channels.find((c) => c.name === 'general') ?? list.channels[0];
      nav(`/messages/${g.id}`, { replace: true });
    }
  }, [id, loaded, list.channels, nav]);

  const channels = list.channels.filter((c) => c.kind === 'channel').sort((a, b) => (a.name === 'general' ? -1 : b.name === 'general' ? 1 : a.name.localeCompare(b.name)));
  const dms = list.channels.filter((c) => c.kind === 'dm');
  const active = list.channels.find((c) => c.id === id);
  const labelOf = (c) => (c.kind === 'dm' ? (c.peer?.name ?? t('ms.someone')) : `#${c.name}`);

  const row = (c) => (
    <li key={c.id}>
      <Link to={`/messages/${c.id}`} className={cx('flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors', c.id === id ? 'bg-surface2' : 'row-hover')}>
        <span className="min-w-0 flex-1">
          <span className={cx('block truncate text-[14px]', c.unread ? 'font-semibold' : 'font-medium')}>{labelOf(c)}</span>
          {c.last && <span className="block truncate text-[12px] text-muted">{c.last.mine ? `${t('ms.you')} : ` : ''}{c.last.body || (c.last.files ? t('ms.attachment') : '')}</span>}
        </span>
        {c.unread > 0 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-bold text-onaccent" aria-label={t('ms.unread', { n: c.unread })}>{c.unread}</span>}
      </Link>
    </li>
  );

  return (
    <>
      <PageHead eyebrow={t('ms.eyebrow')} title={t('ms.title')} />
      <ErrorNote error={error} retry={loadList} />
      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <Card className={cx('self-start p-3', id && 'hidden lg:block')}>
          <div className="flex items-center justify-between px-3 pb-1 pt-2">
            <p className="eyebrow">{t('ms.channels')}</p>
            {can('admin') && <button className="btn btn-ghost h-7 w-7 !p-0" onClick={() => setModal('channel')} aria-label={t('ms.newChannel')}><Icon name="plus" size={15} /></button>}
          </div>
          {!loaded ? <Skeleton className="m-2 h-24" /> : <ul>{channels.map(row)}</ul>}
          <div className="flex items-center justify-between px-3 pb-1 pt-4">
            <p className="eyebrow">{t('ms.dms')}</p>
            {can('agent') && <button className="btn btn-ghost h-7 w-7 !p-0" onClick={() => setModal('dm')} aria-label={t('ms.newDm')}><Icon name="plus" size={15} /></button>}
          </div>
          <ul>{dms.map(row)}</ul>
          {loaded && !dms.length && <p className="px-3 py-2 text-[13px] text-faint">{t('ms.noDms')}</p>}
        </Card>

        <div className={cx(!id && 'hidden lg:block')}>
          {active ? <Thread key={active.id} channel={active} label={labelOf(active)} onChanged={loadList} onDeleted={() => { loadList(); nav('/messages'); }} />
            : <Card className="hidden lg:block"><div className="flex flex-col items-center px-6 py-20 text-center"><span className="mb-4 grid h-12 w-12 place-items-center rounded-2xl border border-line text-accent"><Icon name="spark" size={22} /></span><p className="font-semibold">{t('ms.select')}</p><p className="mt-1 max-w-sm text-[13px] text-muted">{t('ms.selectText')}</p></div></Card>}
        </div>
      </div>

      {modal === 'channel' && <NewChannel onClose={() => setModal(null)} onDone={(c) => { setModal(null); loadList(); nav(`/messages/${c.id}`); }} />}
      {modal === 'dm' && <NewDm onClose={() => setModal(null)} onDone={(c) => { setModal(null); loadList(); nav(`/messages/${c.id}`); }} />}
    </>
  );
}

function Thread({ channel, label, onChanged, onDeleted }) {
  const { t } = useT();
  const { me, can } = useAuth();
  const toast = useToast();
  const [msgs, setMsgs] = useState(null);
  const [tickets, setTickets] = useState({});
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState(null); // { id, body }
  const [replyTo, setReplyTo] = useState(null);  // message auquel on répond
  const [files, setFiles] = useState([]);        // fichiers prêts à partir : { file, name, size }
  const [dragging, setDragging] = useState(false);
  const [flash, setFlash] = useState(null);      // message cité mis en évidence
  const picker = useRef(null);
  const composer = useRef(null);
  const box = useRef(null);
  const stick = useRef(true);
  const readUpTo = useRef(0);

  const fetchLatest = useCallback(async () => {
    try {
      const r = await get(`/chat/channels/${channel.id}/messages?limit=50`);
      setMsgs((prev) => (prev === null ? r.messages : merge(prev, r.messages)));
      if (msgs === null) setHasMore(r.hasMore);
      setTickets((p) => ({ ...p, ...r.tickets }));
      setError(null);
      const last = r.messages.at(-1)?.id ?? 0;
      if (last > readUpTo.current && document.visibilityState === 'visible') {
        readUpTo.current = last;
        post(`/chat/channels/${channel.id}/read`, { upTo: last }).then(onChanged, () => {});
      }
    } catch (e) { setError(e); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);
  useEffect(() => { fetchLatest(); }, [fetchLatest]);
  useVisibleInterval(fetchLatest, POLL_MS);

  useEffect(() => { if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight; }, [msgs]);
  const onScroll = () => { const el = box.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };

  async function older() {
    const first = msgs?.[0]?.id; if (!first) return;
    try {
      const r = await get(`/chat/channels/${channel.id}/messages?limit=50&before=${first}`);
      stick.current = false;
      setMsgs((p) => [...r.messages, ...p]); setHasMore(r.hasMore); setTickets((p) => ({ ...p, ...r.tickets }));
    } catch (e) { toast(errText(e), 'bad'); }
  }
  /** Ajoute des fichiers à l'envoi après contrôles côté navigateur (le serveur refait tous les contrôles de sécurité). */
  function addFiles(list) {
    const incoming = [...list];
    if (!incoming.length) return;
    const next = [...files];
    for (const f of incoming) {
      if (next.length >= MAX_FILES) { toast(t('ms.tooMany', { n: MAX_FILES }), 'bad'); break; }
      if (f.size > MAX_FILE) { toast(t('ms.tooBig', { name: f.name }), 'bad'); continue; }
      if (/\.(svg|html?|exe|dll|bat|cmd|js|vbs|ps1|sh|jar|msi|scr)$/i.test(f.name)) { toast(t('ms.refused', { name: f.name }), 'bad'); continue; }
      next.push({ file: f, name: f.name, size: f.size, key: `${f.name}-${f.size}-${Math.random()}` });
    }
    if (next.reduce((s, f) => s + f.size, 0) > MAX_TOTAL) { toast(t('ms.totalBig'), 'bad'); return; }
    setFiles(next);
  }
  function jumpTo(id) {
    const el = box.current?.querySelector(`[data-msg="${id}"]`);
    if (!el) { toast(t('ms.notLoaded'), 'bad'); return; }
    stick.current = false; el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(id); setTimeout(() => setFlash(null), 1600);
  }
  function startReply(m) { setReplyTo(m); setTimeout(() => composer.current?.focus(), 30); }

  // ---- Clic droit (PC) et geste tactile (téléphone) : menu du message et glissement vers la droite pour répondre
  const [menu, setMenu] = useState(null); // { m, x, y }
  const [swipe, setSwipe] = useState({ id: null, dx: 0 });
  const touch = useRef(null);
  const openMenu = (m, x, y) => setMenu({ m, x: Math.max(8, Math.min(x, window.innerWidth - 216)), y: Math.max(8, Math.min(y, window.innerHeight - 230)) });
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const key = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key); window.addEventListener('scroll', close, true); window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [menu]);
  function onTouchStart(e, m) {
    if (e.touches.length !== 1) return;
    const p = e.touches[0];
    // Appui long (iOS ne déclenche pas « contextmenu ») : ouvre le même menu qu'un clic droit.
    touch.current = { x: p.clientX, y: p.clientY, dir: null, timer: setTimeout(() => { touch.current = null; setSwipe({ id: null, dx: 0 }); openMenu(m, p.clientX, p.clientY); navigator.vibrate?.(15); }, 480) };
  }
  function onTouchMove(e, m) {
    const s = touch.current; if (!s) return;
    const p = e.touches[0], dx = p.clientX - s.x, dy = p.clientY - s.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(s.timer);
    if (s.dir === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) s.dir = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (s.dir === 'x' && dx > 0 && canWrite) setSwipe({ id: m.id, dx: Math.min(dx, 84) });
  }
  function onTouchEnd(m) {
    const s = touch.current; touch.current = null;
    if (!s) return;
    clearTimeout(s.timer);
    if (s.dir === 'x' && swipe.id === m.id && swipe.dx >= 56 && canWrite) { navigator.vibrate?.(10); startReply(m); }
    setSwipe({ id: null, dx: 0 });
  }

  async function send(e) {
    e?.preventDefault();
    const body = draft.trim(); if ((!body && !files.length) || sending) return;
    setSending(true);
    try {
      const attachments = await Promise.all(files.map(async (f) => ({ name: f.name, data: await toBase64(f.file) })));
      const m = await post(`/chat/channels/${channel.id}/messages`, { body, ...(replyTo ? { replyTo: replyTo.id } : {}), ...(attachments.length ? { attachments } : {}) });
      setDraft(''); setFiles([]); setReplyTo(null); stick.current = true; readUpTo.current = Math.max(readUpTo.current, m.id);
      setTickets((p) => ({ ...p, ...m.tickets }));
      setMsgs((p) => (p.some((x) => x.id === m.id) ? p : [...p, m]));
      onChanged();
    } catch (x) { toast(x?.status === 400 && files.length ? t('ms.fileRefused') : errText(x), 'bad'); } finally { setSending(false); }
  }
  async function saveEdit(e) {
    e.preventDefault();
    try { const u = await patch(`/chat/messages/${editing.id}`, { body: editing.body }); setMsgs((p) => p.map((m) => (m.id === u.id ? { ...m, body: u.body, editedAt: u.editedAt } : m))); setEditing(null); fetchLatest(); }
    catch (x) { toast(errText(x), 'bad'); }
  }
  async function remove(m) {
    if (!window.confirm(t('ms.confirmDelete'))) return;
    try { await del(`/chat/messages/${m.id}`); setMsgs((p) => p.filter((x) => x.id !== m.id)); } catch (x) { toast(errText(x), 'bad'); }
  }
  async function removeChannel() {
    if (!window.confirm(t('ms.confirmDeleteChannel', { name: channel.name }))) return;
    try { await del(`/chat/channels/${channel.id}`); toast(t('ms.channelDeleted')); onDeleted(); } catch (x) { toast(errText(x), 'bad'); }
  }

  const day = (d) => new Date(d).toLocaleDateString(localeOf(), { weekday: 'long', day: 'numeric', month: 'long' });
  const time = (d) => new Date(d).toLocaleTimeString(localeOf(), { hour: '2-digit', minute: '2-digit' });
  const render = (body) => body.split(KEY_RE).map((part, i) => {
    if (i % 2 === 0) return part;
    const tk = tickets[part];
    return tk ? <Link key={i} to={`/tickets/${tk.id}`} title={tk.title} className="rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[13px] font-semibold text-accent hover:underline">{part}</Link> : part;
  });
  const canWrite = can('agent');
  const protectedChannel = channel.kind === 'channel' && channel.name === 'general';

  return (
    <Card className={cx('relative flex h-[calc(100dvh-15rem)] min-h-[420px] flex-col overflow-hidden lg:h-[calc(100dvh-13rem)]', dragging && 'ring-2 ring-accent')}
      onDragOver={(e) => { if (canWrite && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
      onDrop={(e) => { if (!canWrite) return; e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}>
      {dragging && <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-bg/70 text-[15px] font-semibold backdrop-blur-sm">{t('ms.dropHere')}</div>}
      <header className="flex items-start gap-3 border-b border-line px-4 py-3.5 sm:px-5">
        <Link to="/messages" className="btn btn-ghost h-8 w-8 shrink-0 !p-0 lg:hidden" aria-label={t('ms.back')}><Icon name="arrow" size={16} className="rotate-180" /></Link>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{label}</h2>
          <p className="truncate text-[13px] text-muted">{channel.kind === 'dm' ? t('ms.dmHint') : channel.topic || (protectedChannel ? t('ms.generalTopic') : t('ms.noTopic'))}</p>
        </div>
        {can('admin') && channel.kind === 'channel' && !protectedChannel && <button className="btn btn-ghost btn-danger h-8 px-2.5" onClick={removeChannel} aria-label={t('ms.deleteChannel')}><Icon name="trash" size={15} /></button>}
      </header>

      <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5" role="log" aria-live="polite" aria-label={label}>
        {error && !msgs && <ErrorNote error={error} retry={fetchLatest} />}
        {msgs === null && !error && <div className="grid place-items-center py-16"><Spinner /></div>}
        {hasMore && <div className="pb-2 text-center"><button className="btn btn-ghost h-8 text-[13px]" onClick={older}>{t('ms.older')}</button></div>}
        {msgs?.length === 0 && <p className="py-16 text-center text-[14px] text-muted">{t('ms.noMessages')}</p>}
        {msgs?.map((m, i) => {
          const mine = m.authorId === me.user.id;
          const prev = msgs[i - 1];
          const newDay = !prev || day(prev.createdAt) !== day(m.createdAt);
          const grouped = prev && !newDay && prev.authorId === m.authorId && new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60000;
          return (
            <div key={m.id} className="relative">
              {newDay && <p className="eyebrow py-3 text-center">{day(m.createdAt)}</p>}
              {swipe.id === m.id && <span className="pointer-events-none absolute bottom-0 left-2 top-0 grid place-items-center text-accent" style={{ opacity: Math.min(1, swipe.dx / 56) }}><Icon name="reply" size={20} /></span>}
              <div data-msg={m.id} className={cx('group flex gap-3 rounded-xl px-2 py-1 transition-colors duration-500 hover:bg-surface', grouped ? '' : 'mt-2', flash === m.id && 'bg-accent/20')}
                style={{ touchAction: 'pan-y', transform: swipe.id === m.id ? `translateX(${swipe.dx}px)` : undefined, transition: swipe.id === m.id ? 'none' : 'transform 220ms var(--ease-out)' }}
                onContextMenu={(e) => { if (editing) return; e.preventDefault(); openMenu(m, e.clientX, e.clientY); }}
                onTouchStart={(e) => onTouchStart(e, m)} onTouchMove={(e) => onTouchMove(e, m)} onTouchEnd={() => onTouchEnd(m)} onTouchCancel={() => onTouchEnd(m)}>
                <Avatar name={m.authorName ?? '?'} src={m.authorAvatar} size={32} className={cx('mt-0.5', grouped && 'invisible')} />
                <div className="min-w-0 flex-1">
                  {!grouped && <p className="text-[13px]"><b>{m.authorName ?? t('ms.someone')}</b><span className="ml-2 text-[12px] text-faint">{time(m.createdAt)}</span></p>}
                  {m.replyTo && (
                    <button type="button" onClick={() => jumpTo(m.replyTo.id)} className="mb-1 mt-0.5 block w-full max-w-[34rem] rounded-lg border-l-[3px] border-accent bg-surface px-3 py-1.5 text-left hover:bg-surface2" aria-label={t('ms.jumpTo')}>
                      <span className="block truncate text-[12px] font-semibold text-accent">{m.replyTo.authorName ?? t('ms.someone')}</span>
                      <span className="block truncate text-[12.5px] text-muted">{m.replyTo.body || t('ms.attachment')}</span>
                    </button>
                  )}
                  {editing?.id === m.id ? (
                    <form onSubmit={saveEdit} className="mt-1 space-y-2">
                      <textarea className="input" rows={2} autoFocus maxLength={4000} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} aria-label={t('ms.edit')} />
                      <div className="flex gap-2"><button className="btn btn-primary h-8 text-[13px]">{t('common.save')}</button><button type="button" className="btn btn-ghost h-8 text-[13px]" onClick={() => setEditing(null)}>{t('common.cancel')}</button></div>
                    </form>
                  ) : (
                    <>
                      {m.body && <p className="whitespace-pre-wrap break-words text-[14.5px]">{render(m.body)}{m.editedAt && <span className="ml-1.5 text-[11px] text-faint">({t('ms.edited')})</span>}</p>}
                      {m.attachments?.length > 0 && <div className="mt-1.5 flex flex-wrap gap-2">{m.attachments.map((a) => <AttachmentView key={a.id} a={a} />)}</div>}
                    </>
                  )}
                </div>
                {!editing && (
                  <span className="hidden shrink-0 items-start gap-0.5 sm:flex sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                    {canWrite && <button className="btn btn-ghost h-7 w-7 !p-0" onClick={() => startReply(m)} aria-label={t('ms.reply')} title={t('ms.reply')}><Icon name="reply" size={14} /></button>}
                    {mine && m.body && <button className="btn btn-ghost h-7 w-7 !p-0" onClick={() => setEditing({ id: m.id, body: m.body })} aria-label={t('ms.edit')}><Icon name="copy" size={13} /></button>}
                    {(mine || can('admin')) && <button className="btn btn-ghost btn-danger h-7 w-7 !p-0" onClick={() => remove(m)} aria-label={t('common.delete')}><Icon name="trash" size={13} /></button>}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {menu && createPortal((
        <div role="menu" className="glass-xl fixed z-50 w-52 rounded-2xl p-1.5" style={{ left: menu.x, top: menu.y, background: 'var(--surface-solid)' }} onPointerDown={(e) => e.stopPropagation()}>
          {[
            canWrite && ['reply', t('ms.reply'), () => startReply(menu.m)],
            menu.m.body && ['copy', t('ms.copy'), () => { navigator.clipboard?.writeText(menu.m.body).then(() => toast(t('ms.copied')), () => {}); }],
            menu.m.authorId === me.user.id && menu.m.body && ['edit', t('ms.edit'), () => setEditing({ id: menu.m.id, body: menu.m.body })],
            (menu.m.authorId === me.user.id || can('admin')) && ['trash', t('common.delete'), () => remove(menu.m)],
          ].filter(Boolean).map(([icon, text, run]) => (
            <button key={icon} role="menuitem" type="button" onClick={() => { setMenu(null); run(); }}
              className={cx('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] hover:bg-surface2', icon === 'trash' && 'text-bad')}>
              <Icon name={icon === 'edit' ? 'copy' : icon} size={15} /> {text}
            </button>
          ))}
        </div>
      ), document.body)}

      {canWrite ? (
        <form onSubmit={send} className="border-t border-line p-3 sm:p-4">
          {replyTo && (
            <div className="mb-2 flex items-start gap-2 rounded-xl border-l-[3px] border-accent bg-surface px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-semibold text-accent">{t('ms.replyingTo', { name: replyTo.authorName ?? t('ms.someone') })}</p>
                <p className="truncate text-[12.5px] text-muted">{replyTo.body || t('ms.attachment')}</p>
              </div>
              <button type="button" className="btn btn-ghost h-6 w-6 shrink-0 !p-0" onClick={() => setReplyTo(null)} aria-label={t('common.cancel')}><Icon name="x" size={13} /></button>
            </div>
          )}
          {files.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-2">
              {files.map((f) => (
                <li key={f.key} className="flex max-w-full items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[12.5px]">
                  <Icon name="clip" size={13} className="shrink-0 text-accent" />
                  <span className="min-w-0 max-w-[12rem] truncate">{f.name}</span><span className="shrink-0 text-faint">{fmtSize(f.size)}</span>
                  <button type="button" className="shrink-0 text-faint hover:text-bad" onClick={() => setFiles(files.filter((x) => x.key !== f.key))} aria-label={t('ms.removeFile', { name: f.name })}><Icon name="x" size={12} /></button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-2">
            <input ref={picker} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} aria-label={t('ms.attach')} />
            <button type="button" className="btn btn-ghost h-11 w-11 shrink-0 !p-0" onClick={() => picker.current?.click()} aria-label={t('ms.attach')} title={t('ms.attach')}><Icon name="clip" size={18} /></button>
            <textarea ref={composer} className="input !min-h-11 flex-1 resize-none" rows={1} maxLength={4000} placeholder={t('ms.placeholder', { to: label })} value={draft}
              onChange={(e) => setDraft(e.target.value)} aria-label={t('ms.placeholderLabel')}
              onPaste={(e) => { const imgs = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/')); if (imgs.length) { e.preventDefault(); addFiles(imgs); } }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } if (e.key === 'Escape') setReplyTo(null); }} />
            <button className="btn btn-primary h-11" disabled={(!draft.trim() && !files.length) || sending} aria-label={t('ms.send')}>{sending ? <Spinner size={14} /> : <Icon name="arrow" size={16} />}<span className="hidden sm:inline">{t('ms.send')}</span></button>
          </div>
        </form>
      ) : <p className="border-t border-line px-5 py-3.5 text-[13px] text-muted">{t('ms.readOnly')}</p>}
    </Card>
  );
}

function NewChannel({ onClose, onDone }) {
  const { t } = useT();
  const toast = useToast();
  const [f, setF] = useState({ name: '', topic: '' });
  const [err, setErr] = useState(null);
  async function submit(e) {
    e.preventDefault(); setErr(null);
    try { const c = await post('/chat/channels', { name: f.name, ...(f.topic ? { topic: f.topic } : {}) }); toast(t('ms.channelCreated')); onDone(c); } catch (x) { setErr(x); }
  }
  return (
    <Modal title={t('ms.newChannel')} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('ms.channelName')} hint={t('ms.channelNameHint')}><input className="input" required autoFocus minLength={2} maxLength={39} pattern="[A-Za-z0-9][A-Za-z0-9-]{1,38}" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={t('ms.topic')}><input className="input" maxLength={200} value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} /></Field>
        {err && <p role="alert" className="text-[13px] text-bad">{errText(err)}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary">{t('common.create')}</button></div>
      </form>
    </Modal>
  );
}

function NewDm({ onClose, onDone }) {
  const { t } = useT();
  const { me } = useAuth();
  const toast = useToast();
  const [members, setMembers] = useState(null);
  useEffect(() => { get('/members').then((r) => setMembers(r.members.filter((m) => m.id !== me.user.id && m.role !== 'viewer')), () => setMembers([])); }, [me.user.id]);
  async function open(m) { try { onDone(await post('/chat/dm', { userId: m.id })); } catch (x) { toast(errText(x), 'bad'); } }
  return (
    <Modal title={t('ms.newDm')} onClose={onClose}>
      {members === null ? <Spinner /> : members.length ? (
        <ul className="-mx-2 max-h-[50vh] overflow-y-auto">
          {members.map((m) => (
            <li key={m.id}><button type="button" onClick={() => open(m)} className="row-hover flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left">
              <Avatar name={m.display_name} src={m.avatar_url} size={36} />
              <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{m.display_name}</span><span className="block truncate text-[12px] text-muted">{m.email}</span></span>
              <Badge tone="low">{t(`role.${m.role}`)}</Badge>
            </button></li>
          ))}
        </ul>
      ) : <p className="text-[14px] text-muted">{t('ms.noMembers')}</p>}
    </Modal>
  );
}
