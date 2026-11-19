import { useState } from 'react';
import { del, get, patch, post, put } from '../lib/api.js';
import { useResource } from '../lib/hooks.js';
import { errText, useT } from '../i18n/index.jsx';
import Icon from '../components/Icon.jsx';
import { Badge, Card, CardHead, Empty, ErrorNote, Field, Meter, PageHead, Skeleton, Spinner, Tabs, ago, fmtDate, pct, useToast } from '../components/ui.jsx';

const EVENTS = ['*', 'ticket.created', 'ticket.reopened', 'ticket.resolved'];
const PRIO = ['critical', 'high', 'medium', 'low'];

export default function Integrations() {
  const { t } = useT();
  const [tab, setTab] = useState('hooks');
  const tabs = [
    { id: 'hooks', label: t('ig.tab.hooks') }, { id: 'sla', label: t('ig.tab.sla') },
    { id: 'deploys', label: t('ig.tab.deploys') }, { id: 'workspace', label: t('ig.tab.workspace') },
  ];
  return (
    <>
      <PageHead eyebrow={t('ig.eyebrow')} title={t('ig.title')} />
      <div className="mb-5 max-w-full overflow-x-auto"><Tabs tabs={tabs} value={tab} onChange={setTab} /></div>
      {tab === 'hooks' && <Webhooks />}
      {tab === 'sla' && <Sla />}
      {tab === 'deploys' && <Deploys />}
      {tab === 'workspace' && <Workspace />}
    </>
  );
}

// ------------------------------------------------------------ Webhooks
const DELIVERY_TONE = { delivered: 'good', pending: 'warn', dead: 'bad' };

function Webhooks() {
  const { t } = useT();
  const toast = useToast();
  const hooks = useResource(() => get('/webhooks'));
  const [status, setStatus] = useState('');
  const dels = useResource(() => get(`/webhooks/deliveries${status ? `?status=${status}` : ''}`), [status]);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState(['*']);
  const [fresh, setFresh] = useState(null);
  const [busy, setBusy] = useState(false);

  const toggleEvent = (e) => setEvents((p) => {
    if (e === '*') return ['*'];
    const base = p.filter((x) => x !== '*');
    const next = base.includes(e) ? base.filter((x) => x !== e) : [...base, e];
    return next.length ? next : ['*'];
  });
  async function create(e) {
    e.preventDefault(); setBusy(true);
    try { setFresh(await post('/webhooks', { url, events })); setUrl(''); setEvents(['*']); hooks.reload(); } catch (x) { toast(errText(x), 'bad'); } finally { setBusy(false); }
  }
  async function remove(h) {
    if (!window.confirm(t('ig.hooks.confirm', { url: h.url }))) return;
    try { await del(`/webhooks/${h.id}`); toast(t('ig.hooks.deleted')); hooks.reload(); dels.reload(); } catch (x) { toast(errText(x), 'bad'); }
  }
  async function replay(d) { try { await post(`/webhooks/deliveries/${d.id}/replay`); toast(t('ig.hooks.replayed')); dels.reload(); } catch (x) { toast(errText(x), 'bad'); } }
  async function process() { try { const r = await post('/webhooks/deliveries/process'); toast(t('ig.hooks.processed', { n: r.processed })); dels.reload(); } catch (x) { toast(errText(x), 'bad'); } }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHead title={t('ig.hooks.title')} hint={t('ig.hooks.hint')} />
        <form onSubmit={create} className="space-y-3 p-5 pt-4">
          <Field label={t('ig.hooks.url')} hint={t('ig.hooks.urlHint')}><input className="input" type="url" required placeholder={'https://'} value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium text-muted">{t('ig.hooks.events')}</legend>
            <div className="flex flex-wrap gap-1.5">
              {EVENTS.map((e) => (
                <button type="button" key={e} aria-pressed={events.includes(e)} onClick={() => toggleEvent(e)}
                  className={`h-8 rounded-lg border px-3 text-[13px] font-semibold ${events.includes(e) ? 'border-transparent bg-accent text-onaccent' : 'border-line text-muted hover:text-ink'}`}>{e === '*' ? t('ig.hooks.all') : e}</button>
              ))}
            </div>
          </fieldset>
          <div className="flex justify-end"><button className="btn btn-primary" disabled={busy}>{busy ? <Spinner size={14} /> : <Icon name="plus" size={16} />} {t('common.add')}</button></div>
        </form>
        {fresh && (
          <div className="mx-5 mb-4 rounded-xl border border-warn/40 bg-warn/10 p-4 text-[13px]">
            <p className="mb-2 font-semibold text-warn">{t('ig.hooks.secret')}</p>
            <code className="block select-all break-all rounded-lg bg-bg/50 p-2.5">{fresh.secret}</code>
            <p className="mt-2 text-muted">{t('ig.hooks.secretHint')}</p>
          </div>
        )}
        <ErrorNote error={hooks.error} retry={hooks.reload} />
        <ul className="p-3 pt-0">
          {hooks.data?.webhooks?.map((h) => (
            <li key={h.id} className="row-hover flex items-center gap-3 rounded-xl px-3 py-2.5">
              <Icon name="plug" className="shrink-0 text-faint" />
              <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{h.url}</span><span className="text-[12px] text-muted">{h.events.map((e) => (e === '*' ? t('ig.hooks.all') : e)).join(', ')} · {ago(h.created_at)}</span></span>
              <button className="btn btn-ghost btn-danger h-8 px-2.5" onClick={() => remove(h)} aria-label={t('common.delete')}><Icon name="trash" size={15} /></button>
            </li>
          ))}
          {hooks.data && !hooks.data.webhooks.length && <li><Empty icon="plug" title={t('ig.hooks.empty')}>{t('ig.hooks.emptyText')}</Empty></li>}
        </ul>
      </Card>

      <Card i={1}>
        <CardHead title={t('ig.dl.title')} hint={t('ig.dl.hint')} right={<button className="btn h-9 text-[13px]" onClick={process}><Icon name="bolt" size={14} /> {t('ig.dl.process')}</button>} />
        <div className="flex flex-wrap gap-1 px-5 pt-4" role="group" aria-label={t('ig.dl.filter')}>
          {['', 'pending', 'delivered', 'dead'].map((s) => (
            <button key={s} aria-pressed={status === s} onClick={() => setStatus(s)} className={`h-8 rounded-lg px-3 text-[13px] font-semibold ${status === s ? 'bg-accent text-onaccent' : 'text-muted hover:text-ink'}`}>{s ? t(`ig.dl.${s}`) : t('tk.all')}</button>
          ))}
        </div>
        <ErrorNote error={dels.error} retry={dels.reload} />
        <ul className="max-h-[440px] divide-y divide-line overflow-auto p-3">
          {dels.data?.deliveries?.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-[13px]">
              <Badge tone={DELIVERY_TONE[d.status]}>{t(`ig.dl.${d.status}`)}</Badge>
              <span className="font-medium">{d.event}</span>
              <span className="min-w-0 flex-1 truncate text-muted">{d.last_error ?? d.url}</span>
              <span className="text-faint">{t('ig.dl.attempts', { n: d.attempts })} · {fmtDate(d.created_at)}</span>
              {d.status !== 'delivered' && <button className="btn btn-ghost h-7 px-2.5 text-[12px]" onClick={() => replay(d)}>{t('ig.dl.replay')}</button>}
            </li>
          ))}
          {dels.data && !dels.data.deliveries.length && <li><Empty icon="pulse" title={t('ig.dl.empty')}>{t('ig.dl.emptyText')}</Empty></li>}
        </ul>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------ SLA
function Sla() {
  const { t } = useT();
  const toast = useToast();
  const res = useResource(() => get('/sla'));
  const [rows, setRows] = useState(null);
  const data = rows ?? PRIO.map((p) => {
    const s = res.data?.policies?.find((x) => x.priority === p);
    return { priority: p, name: s?.name ?? '', firstResponseMins: s?.first_response_mins ?? '', resolveMins: s?.resolve_mins ?? '' };
  });
  const set = (i, k, v) => setRows(data.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  async function save(e) {
    e.preventDefault();
    const policies = data.filter((r) => r.firstResponseMins !== '' && r.resolveMins !== '').map((r) => ({ name: r.name || t(`prio.${r.priority}`), priority: r.priority, firstResponseMins: Number(r.firstResponseMins), resolveMins: Number(r.resolveMins) }));
    if (!policies.length) return;
    try { await put('/sla', { policies }); toast(t('ig.sla.saved')); setRows(null); res.reload(); } catch (x) { toast(errText(x), 'bad'); }
  }
  if (res.loading && !res.data) return <Skeleton className="h-64" />;
  return (
    <Card>
      <CardHead title={t('ig.sla.title')} hint={t('ig.sla.hint')} />
      <ErrorNote error={res.error} retry={res.reload} />
      <form onSubmit={save} className="space-y-3 p-5 pt-4">
        <div className="hidden gap-3 px-1 text-[12px] text-faint sm:grid sm:grid-cols-[110px_1fr_1fr_1fr]"><span>{t('tk.priority')}</span><span>{t('ig.sla.name')}</span><span>{t('ig.sla.first')}</span><span>{t('ig.sla.resolve')}</span></div>
        {data.map((r, i) => (
          <div key={r.priority} className="grid items-center gap-2 sm:grid-cols-[110px_1fr_1fr_1fr] sm:gap-3">
            <Badge tone={r.priority}>{t(`prio.${r.priority}`)}</Badge>
            <input className="input !h-10" aria-label={t('ig.sla.name')} placeholder={t(`prio.${r.priority}`)} maxLength={60} value={r.name} onChange={(e) => set(i, 'name', e.target.value)} />
            <input className="input !h-10" type="number" min={1} max={100000} aria-label={t('ig.sla.first')} placeholder={t('ig.sla.first')} value={r.firstResponseMins} onChange={(e) => set(i, 'firstResponseMins', e.target.value)} />
            <input className="input !h-10" type="number" min={1} max={1000000} aria-label={t('ig.sla.resolve')} placeholder={t('ig.sla.resolve')} value={r.resolveMins} onChange={(e) => set(i, 'resolveMins', e.target.value)} />
          </div>
        ))}
        <p className="text-[12px] text-faint">{t('ig.sla.unit')}</p>
        <div className="flex justify-end"><button className="btn btn-primary">{t('common.save')}</button></div>
      </form>
    </Card>
  );
}

// ------------------------------------------------------------ Deploiements
function Deploys() {
  const { t } = useT();
  const toast = useToast();
  const res = useResource(() => get('/deploys'));
  const [f, setF] = useState({ name: '', version: '', component: '' });
  async function add(e) {
    e.preventDefault();
    try { await post('/deploys', { name: f.name, version: f.version || undefined, component: f.component || undefined }); setF({ name: '', version: '', component: '' }); toast(t('ig.dp.saved')); res.reload(); } catch (x) { toast(errText(x), 'bad'); }
  }
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
      <Card>
        <CardHead title={t('ig.dp.title')} hint={t('ig.dp.hint')} />
        <form onSubmit={add} className="space-y-3 p-5 pt-4">
          <Field label={t('ig.dp.name')}><input className="input" required maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('ig.dp.version')}><input className="input" maxLength={40} value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} /></Field>
            <Field label={t('ig.dp.component')}><input className="input" maxLength={60} value={f.component} onChange={(e) => setF({ ...f, component: e.target.value })} /></Field>
          </div>
          <div className="flex justify-end"><button className="btn btn-primary"><Icon name="plus" size={16} /> {t('common.add')}</button></div>
        </form>
      </Card>
      <Card i={1}>
        <CardHead title={t('ig.dp.history')} />
        <ErrorNote error={res.error} retry={res.reload} />
        <ul className="max-h-[420px] divide-y divide-line overflow-auto p-3">
          {res.data?.deploys?.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-[14px]">
              <span className="font-medium">{d.name}</span>
              {d.version && <span className="chip">{d.version}</span>}
              {d.component && <span className="chip text-accent">{d.component}</span>}
              <span className="ml-auto text-[12px] text-faint">{fmtDate(d.deployed_at)}</span>
            </li>
          ))}
          {res.data && !res.data.deploys.length && <li><Empty icon="clock" title={t('ig.dp.empty')}>{t('ig.dp.emptyText')}</Empty></li>}
        </ul>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------ Espace de travail + IA
function Workspace() {
  const { t } = useT();
  const toast = useToast();
  const org = useResource(() => get('/org'));
  const [f, setF] = useState(null);
  const cur = f ?? (org.data && { name: org.data.name, piiShield: !!org.data.settings?.piiShield, portalEnabled: !!org.data.settings?.portalEnabled, keyPrefix: org.data.settings?.keyPrefix ?? '' });
  async function save(e) {
    e.preventDefault();
    try {
      await patch('/org', { name: cur.name, settings: { piiShield: cur.piiShield, portalEnabled: cur.portalEnabled, ...(cur.keyPrefix ? { keyPrefix: cur.keyPrefix } : {}) } });
      toast(t('ig.ws.saved')); setF(null); org.reload();
    } catch (x) { toast(errText(x), 'bad'); }
  }
  if (org.loading && !org.data) return <Skeleton className="h-64" />;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHead title={t('ig.ws.title')} hint={t('ig.ws.hint')} />
        <ErrorNote error={org.error} retry={org.reload} />
        {cur && (
          <form onSubmit={save} className="space-y-4 p-5 pt-4">
            <Field label={t('ig.ws.name')}><input className="input" required minLength={2} maxLength={80} value={cur.name} onChange={(e) => setF({ ...cur, name: e.target.value })} /></Field>
            <Field label={t('ig.ws.prefix')} hint={t('ig.ws.prefixHint')}><input className="input" pattern="[A-Za-z]{2,5}" maxLength={5} value={cur.keyPrefix} onChange={(e) => setF({ ...cur, keyPrefix: e.target.value.toUpperCase() })} /></Field>
            <label className="flex items-start gap-3 text-[14px]"><input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={cur.piiShield} onChange={(e) => setF({ ...cur, piiShield: e.target.checked })} /><span><b>{t('ig.ws.pii')}</b><span className="block text-[13px] text-muted">{t('ig.ws.piiHint')}</span></span></label>
            <label className="flex items-start gap-3 text-[14px]"><input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={cur.portalEnabled} onChange={(e) => setF({ ...cur, portalEnabled: e.target.checked })} /><span><b>{t('ig.ws.portal')}</b><span className="block text-[13px] text-muted">{t('ig.ws.portalHint')}</span></span></label>
            <div className="flex justify-end"><button className="btn btn-primary">{t('common.save')}</button></div>
          </form>
        )}
      </Card>
      <ModelHealth />
    </div>
  );
}

function ModelHealth() {
  const { t } = useT();
  const st = useResource(() => get('/ml/status').catch(() => null));
  const mon = useResource(() => get('/ml/monitoring').catch(() => null));
  const s = st.data;
  return (
    <Card i={1}>
      <CardHead title={t('ig.ml.title')} hint={t('ig.ml.hint')}
        right={s && <Badge tone={!s.configured ? 'low' : s.available ? 'good' : 'bad'}>{!s.configured ? t('ig.ml.off') : s.available ? t('ig.ml.up') : t('ig.ml.down')}</Badge>} />
      <div className="space-y-4 p-5 pt-4">
        {s && !s.configured && <p className="text-[14px] text-muted">{t('ig.ml.offText')}</p>}
        {s?.circuitOpen && <p className="rounded-xl border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-[13px] text-warn">{t('ig.ml.circuit')}</p>}
        {mon.data && Object.entries(mon.data.tasks).map(([task, v]) => (
          <div key={task}>
            <p className="mb-1.5 flex items-center justify-between text-[13px]"><span className="font-medium">{t(`ig.ml.task.${task}`)}</span><Badge tone={v.status === 'healthy' ? 'good' : v.status === 'degraded' ? 'bad' : 'low'}>{t(`ig.ml.status.${v.status}`)}</Badge></p>
            {v.accuracy != null ? <><Meter value={v.accuracy} tone={v.accuracy < 0.6 ? 'bad' : 'good'} /><p className="mt-1 text-[12px] text-muted">{t('ig.ml.acc', { n: pct(v.accuracy), m: v.evaluated })}</p></> : <p className="text-[12px] text-muted">{t('ig.ml.noData', { n: v.predictions })}</p>}
          </div>
        ))}
        {mon.data?.advice === 'retrain' && <p className="rounded-xl border border-bad/40 bg-bad/10 px-3.5 py-2.5 text-[13px] text-bad">{t('ig.ml.retrain')}</p>}
      </div>
    </Card>
  );
}
