import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api.js';
import { useResource } from '../lib/hooks.js';
import { localeOf, useT } from '../i18n/index.jsx';
import { Badge, Card, CardHead, Empty, ErrorNote, Meter, Skeleton, pct } from '../components/ui.jsx';

const dayName = (dow, long = false) => new Date(Date.UTC(2023, 0, 1 + dow)).toLocaleDateString(localeOf(), { weekday: long ? 'long' : 'short', timeZone: 'UTC' });
const tone = (v) => (v > 0.66 ? 'bad' : v > 0.4 ? 'warn' : 'good');

/** Onglet « Opérations » : file de travail, prévisions, couverture, sujets, risques. Tout vient de /intel/*. */
export default function Operations() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <NextBest />
      <Backlog />
      <Capacity />
      <Coverage />
      <Topics />
      <Stale />
      <DuplicateClusters />
      <Fairness />
      <DeployRisk />
      <BusFactor />
      <Segments />
      <Macros />
      <KbImpact />
    </div>
  );
}

function Shell({ title, hint, i = 0, wide = false, state, children }) {
  return (
    <Card i={i} className={wide ? 'xl:col-span-2' : ''}>
      <CardHead title={title} hint={hint} />
      <ErrorNote error={state?.error} retry={state?.reload} />
      <div className="p-5 pt-4">{state?.loading ? <Skeleton className="h-32" /> : children}</div>
    </Card>
  );
}

function NextBest() {
  const { t } = useT();
  const r = useResource(() => get('/intel/next-best'));
  const reason = (x) => t(`op.reason.${x.code}`, { n: typeof x.value === 'number' ? pct(x.value) : x.value, tier: x.value && t(`tier.${x.value}`) });
  return (
    <Shell title={t('op.next.title')} hint={t('op.next.hint')} state={r} wide>
      <ul className="grid gap-2 md:grid-cols-2">
        {r.data?.items.slice(0, 6).map((x) => (
          <li key={x.id}>
            <Link to={`/tickets/${x.id}`} className="row-hover block rounded-xl border border-line p-3.5">
              <p className="flex items-center justify-between gap-3"><span className="min-w-0 truncate font-medium"><span className="mr-2 text-faint">{x.key}</span>{x.title}</span><Badge tone={x.priority}>{t(`prio.${x.priority}`)}</Badge></p>
              <p className="mt-1.5 flex flex-wrap gap-1.5">{x.reasons.map((y) => <span key={y.code} className="chip !h-6 !text-[11.5px]">{reason(y)}</span>)}</p>
            </Link>
          </li>
        ))}
      </ul>
      {r.data && !r.data.items.length && <Empty icon="check" title={t('op.next.none')} />}
    </Shell>
  );
}

function Backlog() {
  const { t } = useT();
  const r = useResource(() => get('/intel/backlog/forecast'));
  const d = r.data;
  return (
    <Shell title={t('op.backlog.title')} hint={t('op.backlog.hint')} i={1} state={r}>
      {d && (<>
        <p className="num text-[44px] leading-none">{d.openNow}<span className="ml-2 text-[16px] text-muted">{t('op.backlog.open')}</span></p>
        <p className="mt-2 text-[13px] text-muted">{t('op.backlog.rates', { a: d.averageArrivalsPerDay, b: d.averageThroughputPerDay })}</p>
        <p className={`mt-4 rounded-xl border px-4 py-3 text-[14px] ${d.stable ? 'border-good/40 bg-good/10' : 'border-warn/40 bg-warn/10 text-warn'}`}>
          {d.p50Days == null ? t('op.backlog.never') : t('op.backlog.eta', { a: d.p50Days, b: d.p90Days ?? '—' })}
        </p>
        {d.p50Days != null && <div className="mt-3"><Meter value={d.probabilityClearedIn7Days} tone="good" /><p className="mt-1.5 text-[12.5px] text-muted">{t('op.backlog.p7', { n: pct(d.probabilityClearedIn7Days) })}</p></div>}
      </>)}
    </Shell>
  );
}

function Capacity() {
  const { t } = useT();
  const r = useResource(() => get('/intel/capacity/forecast'));
  const max = Math.max(1, ...(r.data?.days.map((d) => d.high) ?? [1]));
  return (
    <Shell title={t('op.cap.title')} hint={t('op.cap.hint')} i={2} state={r}>
      {r.data && (<>
        <div className="flex h-36 items-end gap-2" role="img" aria-label={t('op.cap.title')}>
          {r.data.days.map((d) => (
            <div key={d.date} className="flex flex-1 flex-col items-center gap-1.5">
              <div className="relative flex w-full flex-1 items-end justify-center">
                <span className="absolute bottom-0 w-full rounded-md bg-accent/15" style={{ height: `${(d.high / max) * 100}%` }} />
                <span className="relative w-3/5 rounded-md bg-accent" style={{ height: `${(d.expected / max) * 100}%`, transition: 'height 1s var(--spring)' }} />
              </div>
              <span className="text-[11px] text-muted">{new Date(d.date).toLocaleDateString(localeOf(), { weekday: 'short', timeZone: 'UTC' })}</span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[13px] text-muted">{t('op.cap.line', { a: Math.max(...r.data.days.map((d) => d.agentsNeeded)), b: Math.max(...r.data.days.map((d) => d.agentsNeededHigh)), c: r.data.currentAgents })} · {t('op.cap.trend', { n: r.data.trend })}</p>
      </>)}
    </Shell>
  );
}

function Coverage() {
  const { t } = useT();
  const r = useResource(() => get('/intel/coverage/gaps'));
  const d = r.data;
  const cell = (dow, h) => d.grid.find((c) => c.dow === dow && c.hour === h);
  const maxA = d ? Math.max(1, ...d.grid.map((c) => c.arrivals)) : 1;
  const isGap = (c) => c && d.gaps.some((g) => g.dow === c.dow && g.hour === c.hour);
  return (
    <Shell title={t('op.cov.title')} hint={t('op.cov.hint')} i={3} state={r}>
      {d && (<>
        <div className="space-y-[3px]" role="img" aria-label={t('op.cov.title')}>
          {[1, 2, 3, 4, 5, 6, 0].map((dow) => (
            <div key={dow} className="grid items-center gap-[3px]" style={{ gridTemplateColumns: '34px repeat(24, 1fr)' }}>
              <span className="text-[10.5px] text-faint">{dayName(dow)}</span>
              {Array.from({ length: 24 }, (_, h) => { const c = cell(dow, h); return <i key={h} className="aspect-square rounded-[3px]" title={c ? t('op.cov.cell', { a: c.arrivals, b: c.medianFirstResponseMinutes ?? '—' }) : undefined}
                style={{ background: isGap(c) ? 'var(--bad)' : 'var(--accent)', opacity: c ? 0.18 + (c.arrivals / maxA) * 0.8 : 0.06 }} />; })}
            </div>
          ))}
        </div>
        <ul className="mt-4 space-y-1.5 text-[13px]">
          {d.gaps.slice(0, 3).map((g) => <li key={`${g.dow}-${g.hour}`} className="flex items-center justify-between gap-3"><span className="font-medium capitalize">{dayName(g.dow, true)} {g.hour} h</span><span className="text-muted">{t('op.cov.line', { a: g.arrivals, b: g.medianFirstResponseMinutes ?? '—' })}{g.unanswered ? ` · ${t('op.cov.unanswered', { n: g.unanswered })}` : ''}</span></li>)}
          {!d.gaps.length && <li className="text-muted">{t('op.cov.none')}</li>}
        </ul>
      </>)}
    </Shell>
  );
}

function Topics() {
  const { t } = useT();
  const r = useResource(() => get('/intel/topics'));
  return (
    <Shell title={t('op.topics.title')} hint={t('op.topics.hint')} i={4} state={r}>
      <ul className="space-y-2.5">
        {r.data?.topics.slice(0, 6).map((x, i) => (
          <li key={i} className="rounded-xl border border-line p-3.5">
            <p className="flex items-center justify-between gap-3"><span className="font-medium">{x.terms.join(' · ')}</span><span className="num text-[20px]">{x.size}</span></p>
            <p className="mt-1 text-[12.5px] text-muted">{t('op.topics.line', { a: x.size, b: x.open, c: pct(x.avgFrustration) })}{x.oldestOpenDays > 0 ? ` · ${t('op.topics.oldest', { n: x.oldestOpenDays })}` : ''}</p>
          </li>
        ))}
      </ul>
      {r.data && !r.data.topics.length && <Empty icon="spark" title={t('op.topics.none')} />}
    </Shell>
  );
}

function Stale() {
  const { t } = useT();
  const r = useResource(() => get('/intel/stale'));
  return (
    <Shell title={t('op.stale.title')} hint={t('op.stale.hint')} i={5} state={r}>
      <ul className="space-y-1">
        {r.data?.stale.slice(0, 6).map((x) => (
          <li key={x.id}>
            <Link to={`/tickets/${x.id}`} className="row-hover flex items-center gap-3 rounded-xl px-3 py-2.5">
              <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium"><span className="mr-2 text-faint">{x.key}</span>{x.title}</span>
                <span className="text-[12px] text-muted">{t('op.stale.idle', { n: x.idleDays })} · {t(`op.stale.waiting_${x.waitingOn}`)}</span></span>
              <Badge tone={x.action === 'close_candidate' ? 'low' : x.action === 'reply_now' ? 'bad' : 'warn'}>{t(`op.stale.${x.action}`)}</Badge>
            </Link>
          </li>
        ))}
      </ul>
      {r.data && !r.data.stale.length && <Empty icon="check" title={t('op.stale.none')} />}
    </Shell>
  );
}

function DuplicateClusters() {
  const { t } = useT();
  const r = useResource(() => get('/intel/duplicates/clusters'));
  return (
    <Shell title={t('op.dup.title')} hint={t('op.dup.hint')} i={6} state={r}>
      <ul className="space-y-2.5">
        {r.data?.clusters.slice(0, 5).map((c) => (
          <li key={c.primary.id} className="rounded-xl border border-line p-3.5">
            <Link to={`/tickets/${c.primary.id}`} className="flex items-center justify-between gap-3 font-medium hover:underline"><span className="truncate"><span className="mr-2 text-faint">{c.primary.key}</span>{c.primary.title}</span><Badge tone="warn">×{c.size}</Badge></Link>
            <p className="mt-1.5 flex flex-wrap gap-1.5">{c.mergeCandidates.slice(0, 5).map((m) => <Link key={m.id} to={`/tickets/${m.id}`} className="chip hover:text-ink">{m.key} · {pct(m.similarity)} %</Link>)}</p>
          </li>
        ))}
      </ul>
      {r.data && !r.data.clusters.length && <Empty icon="check" title={t('op.dup.none')} />}
    </Shell>
  );
}

function Fairness() {
  const { t } = useT();
  const r = useResource(() => get('/intel/fairness'));
  return (
    <Shell title={t('op.fair.title')} hint={t('op.fair.hint')} i={7} state={r}>
      <ul className="space-y-1">
        {r.data?.items.slice(0, 5).map((x) => (
          <li key={x.id}>
            <Link to={`/tickets/${x.id}`} className="row-hover flex items-center gap-3 rounded-xl px-3 py-2.5">
              <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium"><span className="mr-2 text-faint">{x.key}</span>{x.title}</span>
                <span className="text-[12px] text-muted">{t('op.fair.line', { a: Math.round(x.waitingHours), n: x.servedBefore })}</span></span>
              <Badge tone={x.tier}>{t(`tier.${x.tier}`)}</Badge>
            </Link>
          </li>
        ))}
      </ul>
      {r.data && !r.data.items.length && <Empty icon="shield" title={t('op.fair.none')} />}
    </Shell>
  );
}

function DeployRisk() {
  const { t } = useT();
  const overview = useResource(() => get('/analytics/overview'));
  const [comp, setComp] = useState('');
  const r = useResource(() => (comp ? get(`/intel/deploys/risk?component=${encodeURIComponent(comp)}`) : Promise.resolve(null)), [comp]);
  const d = r.data;
  return (
    <Shell title={t('op.dep.title')} hint={t('op.dep.hint')} i={8} state={overview}>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('op.dep.pick')}>
        {overview.data?.byComponent.map((c) => <button key={c.component} aria-pressed={comp === c.component} onClick={() => setComp(c.component)} className={`chip !h-8 !text-[13px] capitalize ${comp === c.component ? '!border-transparent !bg-accent !text-onaccent' : 'hover:text-ink'}`}>{c.component}</button>)}
      </div>
      {!comp && <p className="mt-4 text-[13px] text-muted">{t('op.dep.pick')}</p>}
      {d && (
        <div className="mt-4">
          <p className="flex items-end gap-3"><span className="num text-[44px] leading-none">{pct(d.risk)}<span className="text-[18px] text-muted"> %</span></span><Badge tone={d.level === 'high' ? 'bad' : d.level === 'medium' ? 'warn' : 'good'}>{t(`level.${d.level}`)}</Badge></p>
          <div className="mt-3"><Meter value={d.risk} tone={tone(d.risk)} /></div>
          <ul className="mt-3 space-y-1 text-[13px] text-muted">
            {d.factors.map((f) => <li key={f.code}>{t(`op.dep.${f.code}`, { n: f.code === 'history' ? pct(f.value) : f.value })}</li>)}
            <li>{t('op.dep.past', { a: d.pastDeploys, b: d.regressions })}</li>
            {d.bestWindow && <li className="text-ink">{t('op.dep.best', { day: dayName(d.bestWindow.dow, true), h: d.bestWindow.hourUtc })}</li>}
          </ul>
        </div>
      )}
    </Shell>
  );
}

function BusFactor() {
  const { t } = useT();
  const r = useResource(() => get('/intel/team/bus-factor'));
  return (
    <Shell title={t('op.bus.title')} hint={t('op.bus.hint')} i={9} state={r}>
      <ul className="space-y-3">
        {r.data?.components.slice(0, 6).map((c) => (
          <li key={c.component}>
            <p className="flex items-center justify-between gap-3 text-[14px]"><span className="font-medium capitalize">{c.component}</span>{c.atRisk && <Badge tone="bad">{t('op.bus.risk')}</Badge>}</p>
            <div className="mt-1.5"><Meter value={c.share} tone={c.atRisk ? 'bad' : 'good'} /></div>
            <p className="mt-1 text-[12px] text-muted">{t('op.bus.line', { name: c.topAgent.name, n: pct(c.share), c: c.resolved })}</p>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

function Segments() {
  const { t } = useT();
  const r = useResource(() => get('/intel/customers/segments'));
  return (
    <Shell title={t('op.seg.title')} hint={t('op.seg.hint')} i={10} state={r}>
      <ul className="space-y-2.5">
        {r.data?.segments?.map((s, i) => (
          <li key={i} className="rounded-xl border border-line p-3.5">
            <p className="flex items-center justify-between gap-3"><span className="font-semibold">{t(`op.seg.${s.code}`)}</span><span className="num text-[20px]">{s.size}</span></p>
            <p className="mt-0.5 text-[12.5px] text-muted">{t('op.seg.line', { n: s.averageTickets90d })} · {s.customers.slice(0, 3).map((c) => c.name).join(', ')}</p>
          </li>
        ))}
      </ul>
      {r.data?.insufficientData && <Empty icon="users" title={t('in.churn.noData')} />}
    </Shell>
  );
}

function Macros() {
  const { t } = useT();
  const r = useResource(() => get('/intel/macros'));
  return (
    <Shell title={t('op.macro.title')} hint={t('op.macro.hint')} i={11} state={r}>
      <ul className="space-y-2.5">
        {r.data?.macros.slice(0, 5).map((m, i) => (
          <li key={i} className="rounded-xl border border-line p-3.5 text-[13.5px]">
            <p>“{m.text}”</p>
            <p className="mt-1 text-[12px] text-muted">{t('op.macro.line', { n: m.distinctTickets, a: m.agents })}</p>
          </li>
        ))}
      </ul>
      {r.data && !r.data.macros.length && <Empty icon="spark" title={t('op.macro.none')} />}
    </Shell>
  );
}

function KbImpact() {
  const { t } = useT();
  const r = useResource(() => get('/intel/kb/impact'));
  return (
    <Shell title={t('op.kbi.title')} hint={t('op.kbi.hint')} i={12} wide state={r}>
      <div className="grid gap-2.5 md:grid-cols-2">
        {r.data?.articles.slice(0, 6).map((a) => (
          <div key={a.id} className="rounded-xl border border-line p-3.5">
            <p className="flex items-center justify-between gap-3 text-[14px] font-medium"><span className="truncate">{a.title}</span><Badge tone={a.hoursSavedPerTicket > 0 ? 'good' : 'warn'}>{a.hoursSavedPerTicket > 0 ? t('op.kbi.saves', { n: a.hoursSavedPerTicket }) : t('op.kbi.costs', { n: Math.abs(a.hoursSavedPerTicket) })}</Badge></p>
            <p className="mt-1 text-[12.5px] text-muted">{t('op.kbi.line', { a: a.medianHoursWith, b: a.medianHoursWithout, n: a.usedOn })}</p>
          </div>
        ))}
      </div>
      {r.data && <p className="mt-3 text-[12px] text-faint">{t('in.roi.caveat')}</p>}
    </Shell>
  );
}
