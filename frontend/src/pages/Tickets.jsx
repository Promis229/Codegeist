import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useDebounced, useResource } from '../lib/hooks.js';
import { errText, useT } from '../i18n/index.jsx';
import Icon from '../components/Icon.jsx';
import { Badge, Card, Empty, ErrorNote, Field, Meter, PageHead, Skeleton, ago, cx, useToast } from '../components/ui.jsx';

const STATUS = ['', 'open', 'pending', 'resolved', 'closed'];
const PRIO = ['', 'critical', 'high', 'medium', 'low'];
const SORT = ['newest', 'priority', 'frustration', 'oldest'];
const PAGE = 20;

export default function Tickets() {
  const { t } = useT();
  const { can, me } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ status: 'open', priority: '', q: '', sort: 'newest', mine: false });
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const q = useDebounced(f.q, 300);
  const qs = new URLSearchParams({ limit: PAGE, offset: page * PAGE, sort: f.sort });
  if (f.status) qs.set('status', f.status);
  if (f.priority) qs.set('priority', f.priority);
  if (q) qs.set('q', q);
  if (f.mine) qs.set('assignee', 'me');
  const res = useResource(() => get(`/tickets?${qs}`), [qs.toString()]);
  const set = (k, v) => { setF((p) => ({ ...p, [k]: v })); setPage(0); };
  const pages = Math.ceil((res.data?.total ?? 0) / PAGE);
  const [sel, setSel] = useState(new Set());
  const toggleSel = (id) => setSel((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function bulk(patchBody) {
    try { const r = await post('/tickets/bulk', { ids: [...sel], patch: patchBody }); toast(t('tk.bulkDone', { n: r.updated })); setSel(new Set()); res.reload(); }
    catch (e) { toast(errText(e), 'bad'); }
  }
  async function exportCsv() {
    try {
      const csv = await get('/tickets.csv');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a'); a.href = url; a.download = 'tickets.csv'; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast(errText(e), 'bad'); }
  }

  return (
    <>
      <PageHead eyebrow={t('tk.eyebrow')} title={t('tk.title')}>
        {can('agent') && <button className="btn shrink-0 whitespace-nowrap" onClick={exportCsv} aria-label={t('tk.export')} title={t('tk.export')}><Icon name="download" size={16} /> <span className="max-sm:hidden">{t('tk.export')}</span></button>}
        {can('agent') && <button className="btn btn-primary shrink-0 whitespace-nowrap" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> {t('tk.new')}</button>}
      </PageHead>

      {sel.size > 0 && (
        <Card className="mb-4 flex flex-wrap items-center gap-2 p-3" role="region" aria-label={t('tk.bulk')}>
          <span className="px-2 text-[14px] font-semibold">{t('tk.selected', { n: sel.size })}</span>
          {STATUS.slice(1).map((v) => <button key={v} className="btn h-9 text-[13px]" onClick={() => bulk({ status: v })}>{t(`status.${v}`)}</button>)}
          <select className="input !h-9 !w-auto text-[13px]" value="" onChange={(e) => e.target.value && bulk({ priority: e.target.value })} aria-label={t('tk.priority')}>
            <option value="">{t('tk.setPriority')}</option>{PRIO.slice(1).map((v) => <option key={v} value={v}>{t(`prio.${v}`)}</option>)}
          </select>
          <button className="btn h-9 text-[13px]" onClick={() => bulk({ assigneeId: me.user.id })}>{t('tk.assignMe')}</button>
          <button className="btn btn-ghost ml-auto h-9 text-[13px]" onClick={() => setSel(new Set())}>{t('tk.clear')}</button>
        </Card>
      )}

      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Icon name="search" size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
            <input className="input !h-10 !pl-10" placeholder={t('tk.searchPh')} value={f.q} onChange={(e) => set('q', e.target.value)} aria-label={t('common.search')} />
          </div>
          <div className="flex max-w-full flex-wrap gap-1 rounded-xl border border-line p-1" role="group" aria-label={t('tk.status')}>
            {STATUS.map((v) => (
              <button key={v} onClick={() => set('status', v)} aria-pressed={f.status === v}
                className={cx('h-8 rounded-lg px-3 text-[13px] font-semibold transition-colors', f.status === v ? 'bg-accent text-onaccent' : 'text-muted hover:text-ink')}>{v ? t(`status.${v}`) : t('tk.all')}</button>
            ))}
          </div>
          <select className="input !h-10 !w-auto text-[13px]" value={f.priority} onChange={(e) => set('priority', e.target.value)} aria-label={t('tk.priority')}>{PRIO.map((v) => <option key={v} value={v}>{v ? t(`prio.${v}`) : t('tk.allPrio')}</option>)}</select>
          <select className="input !h-10 !w-auto text-[13px]" value={f.sort} onChange={(e) => set('sort', e.target.value)} aria-label={t('tk.sort')}>{SORT.map((v) => <option key={v} value={v}>{t(`sort.${v}`)}</option>)}</select>
          <label className="flex items-center gap-2 px-2 text-[13px] text-muted"><input type="checkbox" className="accent-[var(--accent)]" checked={f.mine} onChange={(e) => set('mine', e.target.checked)} /> {t('tk.mine')}</label>
        </div>
      </Card>

      <ErrorNote error={res.error} retry={res.reload} />
      <Card i={1} className="overflow-hidden">
        {res.loading && !res.data ? <div className="space-y-2 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div> : (
          res.data.tickets.length ? (
            <ul className="divide-y divide-line">
              {res.data.tickets.map((x) => (
                <li key={x.id} className="flex items-center">
                  {can('agent') && <input type="checkbox" className="ml-5 shrink-0 accent-[var(--accent)]" checked={sel.has(x.id)} onChange={() => toggleSel(x.id)} aria-label={t('tk.select', { key: x.key })} />}
                  <Link to={`/tickets/${x.id}`} className="row-hover grid min-w-0 flex-1 items-center gap-x-4 gap-y-1 px-4 py-3.5 sm:grid-cols-[84px_1fr_auto_90px] sm:px-5">
                    <span className="text-[13px] font-semibold text-faint">{x.key}</span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{x.title}</span>
                      <span className="block truncate text-[13px] text-muted">{x.customer_name ?? t('tk.unknownCustomer')}{x.component ? ` · ${x.component}` : ''} · {ago(x.created_at)}{x.assignee_name ? ` · ${x.assignee_name}` : ` · ${t('tk.unassigned')}`}</span>
                    </span>
                    <span className="flex items-center gap-1.5"><Badge tone={x.priority}>{t(`prio.${x.priority}`)}</Badge><Badge tone={x.status}>{t(`status.${x.status}`)}</Badge></span>
                    <span title={t('tk.frustrationPct', { n: Math.round((x.frustration ?? 0) * 100) })} className="hidden sm:block"><Meter value={x.frustration ?? 0} tone={x.frustration > 0.6 ? 'bad' : x.frustration > 0.35 ? 'warn' : 'good'} /></span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <Empty icon="ticket" title={t('tk.empty')}>{t('tk.emptyText')}</Empty>
        )}
      </Card>

      {pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-[13px] text-muted">
          <span>{t('tk.count', { n: res.data.total })}</span>
          <div className="flex items-center gap-2">
            <button className="btn h-9" disabled={page === 0} onClick={() => setPage(page - 1)}>{t('common.prev')}</button>
            <span>{page + 1} / {pages}</span>
            <button className="btn h-9" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>{t('common.next')}</button>
          </div>
        </div>
      )}
      {creating && <NewTicket onClose={() => setCreating(false)} onDone={() => { setCreating(false); res.reload(); }} />}
    </>
  );
}

function NewTicket({ onClose, onDone }) {
  const { t } = useT();
  const nav = useNavigate();
  const toast = useToast();
  const [f, setF] = useState({ title: '', body: '', priority: 'medium' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const dup = useResource(async () => (f.title.trim().length > 8 ? get(`/kb?q=${encodeURIComponent(f.title)}`) : null), [useDebounced(f.title, 500)]);

  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const x = await post('/tickets', f); toast(t('tk.created', { key: x.key })); onDone(); nav(`/tickets/${x.id}`); }
    catch (ex) { setErr(ex); } finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4 backdrop-blur-sm fade" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form onSubmit={submit} className="glass rise w-full max-w-[560px] space-y-4 rounded-3xl p-7" style={{ background: 'var(--surface-solid)' }} role="dialog" aria-modal="true" aria-label={t('tk.new')}>
        <h2 className="font-serif text-[26px] tracking-tight">{t('tk.new')}</h2>
        <Field label={t('tk.fTitle')}><input className="input" required autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        {dup.data?.articles?.length > 0 && (
          <p className="rounded-xl border border-accent/40 bg-accent/10 px-3.5 py-2.5 text-[13px]"><Icon name="book" size={14} className="mr-1.5 inline text-accent" />{t('tk.maybeArticle')} <b>{dup.data.articles[0].title}</b></p>
        )}
        <Field label={t('tk.fBody')}><textarea className="input" rows={5} required value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        <Field label={t('tk.priority')}><select className="input" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{PRIO.slice(1).map((v) => <option key={v} value={v}>{t(`prio.${v}`)}</option>)}</select></Field>
        {err && <p role="alert" className="text-[13px] text-bad">{errText(err)}</p>}
        <div className="flex justify-end gap-2 pt-1"><button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={busy}>{t('common.create')}</button></div>
      </form>
    </div>
  );
}
