import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, patch, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useDebounced, useResource } from '../lib/hooks.js';
import { errText, useT } from '../i18n/index.jsx';
import Icon from '../components/Icon.jsx';
import { Sparkline } from '../components/Charts.jsx';
import { Badge, Card, Empty, ErrorNote, Field, Meter, Modal, PageHead, Skeleton, Spinner, ago, useToast } from '../components/ui.jsx';

const TIERS = ['standard', 'premium', 'enterprise'];
const HEALTH_TONE = { recovering: 'good', stable: 'low', declining: 'bad', unknown: 'low' };

export default function Customers() {
  const { t } = useT();
  const { can } = useAuth();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const dq = useDebounced(q, 300);
  const res = useResource(() => get(`/customers?limit=100${dq ? `&q=${encodeURIComponent(dq)}` : ''}`), [dq]);
  const list = res.data?.customers ?? [];

  return (
    <>
      <PageHead eyebrow={t('cu.eyebrow')} title={t('cu.title')}>
        {can('agent') && <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> {t('cu.new')}</button>}
      </PageHead>

      <Card className="mb-4 p-3">
        <div className="relative">
          <Icon name="search" size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input !h-10 !pl-10" placeholder={t('cu.searchPh')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('common.search')} />
        </div>
      </Card>

      <ErrorNote error={res.error} retry={res.reload} />
      <Card i={1} className="overflow-hidden">
        {res.loading && !res.data ? <div className="space-y-2 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div> : (
          list.length ? (
            <ul className="divide-y divide-line">
              {list.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => setOpen(c.id)} className="row-hover grid w-full items-center gap-x-4 gap-y-1 px-5 py-3.5 text-left sm:grid-cols-[1fr_auto_110px]">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{c.name}</span>
                      <span className="block truncate text-[13px] text-muted">{c.company ? `${c.company} · ` : ''}{c.email}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Badge tone={c.tier}>{t(`tier.${c.tier}`)}</Badge>
                      <span className="chip">{t('cu.tickets', { n: c.tickets })}</span>
                      {c.open_tickets > 0 && <span className="chip text-accent">{t('cu.openCount', { n: c.open_tickets })}</span>}
                    </span>
                    <span className="hidden sm:block" title={t('tk.frustrationPct', { n: Math.round((c.avg_frustration ?? 0) * 100) })}>
                      <Meter value={Number(c.avg_frustration ?? 0)} tone={c.avg_frustration > 0.6 ? 'bad' : c.avg_frustration > 0.35 ? 'warn' : 'good'} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <Empty icon="users" title={t('cu.empty')}>{t('cu.emptyText')}</Empty>
        )}
      </Card>

      {open && <CustomerPanel id={open} customer={list.find((c) => c.id === open)} onClose={() => setOpen(null)} onChanged={res.reload} />}
      {creating && <NewCustomer onClose={() => setCreating(false)} onDone={() => { setCreating(false); res.reload(); }} />}
    </>
  );
}

function CustomerPanel({ id, customer, onClose, onChanged }) {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const health = useResource(() => get(`/intel/customers/${id}/health`).catch(() => null), [id]);
  const tickets = useResource(() => get(`/tickets?customer=${id}&limit=6&sort=newest`).catch(() => null), [id]);
  const h = health.data;
  async function setTier(tier) {
    try { await patch(`/customers/${id}`, { tier }); toast(t('cu.saved')); onChanged(); health.reload(); } catch (e) { toast(errText(e), 'bad'); }
  }
  return (
    <Modal title={customer?.name ?? h?.customer?.name ?? ''} onClose={onClose} wide>
      <p className="-mt-2 text-[14px] text-muted">{customer?.company ? `${customer.company} · ` : ''}{customer?.email}</p>
      {can('agent') && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('cu.tier')}>
          <span className="eyebrow mr-1">{t('cu.tier')}</span>
          {TIERS.map((v) => (
            <button key={v} type="button" aria-pressed={customer?.tier === v} onClick={() => setTier(v)}
              className={`h-8 rounded-lg border px-3 text-[13px] font-semibold ${customer?.tier === v ? 'border-transparent bg-accent text-onaccent' : 'border-line text-muted hover:text-ink'}`}>{t(`tier.${v}`)}</button>
          ))}
        </div>
      )}

      <div className="rounded-2xl border border-line p-4">
        <p className="eyebrow mb-2">{t('cu.health')}</p>
        {health.loading ? <Spinner /> : h ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={HEALTH_TONE[h.status]}>{t(`cu.health.${h.status}`)}</Badge>
              {h.averageSentiment != null && <span className="text-[13px] text-muted">{t('cu.avgSentiment', { n: h.averageSentiment })}</span>}
            </div>
            {h.series?.length > 1 && <Sparkline values={h.series.map((s) => s.sentiment)} width={320} height={44} />}
            {h.status === 'unknown' && <p className="text-[13px] text-muted">{t('cu.healthUnknown')}</p>}
          </div>
        ) : <p className="text-[13px] text-muted">{t('cu.healthNone')}</p>}
      </div>

      <div>
        <p className="eyebrow mb-1.5">{t('cu.recent')}</p>
        {tickets.loading ? <Skeleton className="h-16" /> : (
          <ul className="divide-y divide-line">
            {tickets.data?.tickets?.map((x) => (
              <li key={x.id}><Link to={`/tickets/${x.id}`} className="row-hover flex items-center gap-3 rounded-lg px-2 py-2.5">
                <span className="text-[13px] font-semibold text-faint">{x.key}</span>
                <span className="min-w-0 flex-1 truncate text-[14px]">{x.title}</span>
                <Badge tone={x.status}>{t(`status.${x.status}`)}</Badge>
                <span className="hidden text-[12px] text-faint sm:inline">{ago(x.created_at)}</span>
              </Link></li>
            ))}
            {!tickets.data?.tickets?.length && <li className="py-3 text-[13px] text-muted">{t('cu.noTickets')}</li>}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function NewCustomer({ onClose, onDone }) {
  const { t } = useT();
  const toast = useToast();
  const [f, setF] = useState({ name: '', email: '', company: '', tier: 'standard' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await post('/customers', { ...f, company: f.company || undefined }); toast(t('cu.created')); onDone(); } catch (x) { setErr(x); } finally { setBusy(false); }
  }
  return (
    <Modal title={t('cu.new')} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('cu.fName')}><input className="input" required autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={t('common.email')}><input className="input" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label={t('cu.fCompany')}><input className="input" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} /></Field>
        <Field label={t('cu.tier')}><select className="input" value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })}>{TIERS.map((v) => <option key={v} value={v}>{t(`tier.${v}`)}</option>)}</select></Field>
        {err && <p role="alert" className="text-[13px] text-bad">{errText(err)}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={busy}>{t('common.create')}</button></div>
      </form>
    </Modal>
  );
}
