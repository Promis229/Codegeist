import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api.js';
import { useResource } from '../lib/hooks.js';
import { localeOf, useT } from '../i18n/index.jsx';
import { Sparkline } from '../components/Charts.jsx';
import Operations from './Operations.jsx';
import { Badge, Card, CardHead, Empty, ErrorNote, Meter, PageHead, Skeleton, Tabs, pct } from '../components/ui.jsx';

const lvl = { high: 'bad', medium: 'warn', low: 'good' };

export default function Intelligence() {
  const { t } = useT();
  const [tab, setTab] = useState('clients');
  const TABS = ['clients', 'team', 'volume', 'impact', 'ops'].map((id) => ({ id, label: t(`in.tab.${id}`) }));
  return (
    <>
      <PageHead eyebrow={t('in.eyebrow')} title={t('in.title')}><Tabs tabs={TABS} value={tab} onChange={setTab} /></PageHead>
      {tab === 'clients' && <Clients />}
      {tab === 'team' && <Team />}
      {tab === 'volume' && <Volume />}
      {tab === 'impact' && <Impact />}
      {tab === 'ops' && <Operations />}
    </>
  );
}

function Clients() {
  const { t } = useT();
  const r = useResource(() => get('/intel/customers-at-risk'));
  return (
    <Card>
      <CardHead title={t('in.churn.title')} hint={t('in.churn.hint')} />
      <ErrorNote error={r.error} retry={r.reload} />
      {r.loading ? <div className="p-5"><Skeleton className="h-64" /></div> : (
        <div className="overflow-x-auto p-3">
          <table className="w-full text-left text-[14px]">
            <thead><tr className="eyebrow"><th className="px-3 py-2 font-semibold">{t('in.churn.customer')}</th><th className="px-3 py-2 font-semibold">{t('in.churn.risk')}</th><th className="hidden px-3 py-2 font-semibold md:table-cell">{t('in.churn.signals')}</th><th className="hidden px-3 py-2 sm:table-cell" /></tr></thead>
            <tbody>
              {r.data.customers.map((c) => (
                <tr key={c.customer.id} className="row-hover border-t border-line">
                  <td className="px-3 py-3"><p className="font-medium">{c.customer.name}</p><p className="text-[12px] text-faint">{c.customer.company}</p></td>
                  <td className="px-3 py-3 sm:w-52"><div className="flex items-center gap-3"><span className="num w-9 shrink-0 text-[22px]">{pct(c.churnRisk)}</span><div className="min-w-[56px] flex-1"><Meter value={c.churnRisk} tone={lvl[c.level]} /></div></div></td>
                  <td className="hidden px-3 py-3 text-[13px] text-muted md:table-cell">
                    {t('in.churn.sig', { a: pct(c.signals.avgFrustration), b: c.signals.staleOpenTickets })}{c.signals.departureLanguage ? ` · ${t('in.churn.leave', { n: c.signals.departureLanguage })}` : ''}
                  </td>
                  <td className="hidden px-3 py-3 text-right sm:table-cell"><Badge tone={c.customer.tier}>{t(`tier.${c.customer.tier}`)}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!r.data.customers.length && <Empty icon="users" title={t('in.churn.noData')}>{t('in.churn.noDataText')}</Empty>}
        </div>
      )}
    </Card>
  );
}

/** Conseils de surcharge : reconstruits côté client à partir des mesures (donc dans la langue de l'interface). */
function advice(m, t) {
  const a = [];
  if (m.afterHoursShare > 0.3) a.push(t('in.adv.after'));
  if (m.consecutiveDays >= 7) a.push(t('in.adv.streak', { n: m.consecutiveDays }));
  if (m.hardTicketShare > 0.5) a.push(t('in.adv.hard'));
  if (m.openLoad > 12) a.push(t('in.adv.load', { n: m.openLoad }));
  return a;
}

function Team() {
  const { t } = useT();
  const burn = useResource(() => get('/intel/team/burnout'));
  const mo = useResource(() => get('/intel/team/mood'));
  return (
    <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
      <Card>
        <CardHead title={t('in.burn.title')} hint={t('in.burn.hint')} />
        <ErrorNote error={burn.error} retry={burn.reload} />
        <ul className="space-y-3 p-5 pt-4">
          {burn.loading && <Skeleton className="h-56" />}
          {burn.data?.team.map((m) => (
            <li key={m.userId} className="rounded-xl border border-line p-4">
              <div className="flex items-center justify-between gap-3"><p className="font-semibold">{m.name}</p><Badge tone={lvl[m.level]}>{t(`level.${m.level}`)}</Badge></div>
              <div className="mt-2"><Meter value={m.risk} tone={lvl[m.level]} /></div>
              <p className="mt-2 text-[12.5px] text-muted">{t('in.burn.line', { a: pct(m.afterHoursShare), b: m.consecutiveDays, c: m.openLoad })}</p>
              {advice(m, t).map((a) => <p key={a} className="mt-1 text-[13px] text-accent">{a}</p>)}
            </li>
          ))}
        </ul>
      </Card>
      <Card i={1}>
        <CardHead title={t('in.mood.title')} hint={t('in.mood.hint')} />
        <div className="p-5 pt-4">
          {mo.loading ? <Skeleton className="h-40" /> : mo.data?.series?.length ? (
            <>
              <p className="num text-[40px] leading-none">{t(`weather.${mo.data.weather}`)}</p>
              <p className="mt-2 text-[13px] text-muted">{t('in.mood.trend')} : {t(`trend.${mo.data.trend}`)}</p>
              <div className="mt-5"><Sparkline values={mo.data.series.map((s) => s.mood + 1)} width={300} height={56} /></div>
            </>
          ) : <Empty icon="users" title={t('in.mood.none')} />}
        </div>
      </Card>
    </div>
  );
}

function Volume() {
  const { t } = useT();
  const reg = useResource(() => get('/intel/regressions'));
  const ch = useResource(() => get('/intel/volume/changepoints'));
  const terms = useResource(() => get('/intel/terms/emerging'));
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHead title={t('in.reg.title')} hint={t('in.reg.hint')} />
        <ul className="space-y-3 p-5 pt-4">
          {reg.loading && <Skeleton className="h-32" />}
          {reg.data?.regressions.map((r, i) => (
            <li key={i} className="rounded-xl border border-line p-4 text-[14px]">
              <p className="flex items-center justify-between gap-3 font-semibold"><span>{r.deploy.name} <span className="font-normal text-faint">{r.deploy.version}</span></span><Badge tone="warn">×{r.ratio}</Badge></p>
              <p className="mt-1 text-[13px] text-muted">{r.deploy.component} : {t('in.reg.line', { a: r.ticketsBefore24h, b: r.ticketsAfter24h })}{r.reopenedAfter ? ` · ${t('in.reg.reopened', { n: r.reopenedAfter })}` : ''}</p>
            </li>
          ))}
          {reg.data && !reg.data.regressions.length && <Empty icon="shield" title={t('in.reg.none')} />}
        </ul>
      </Card>
      <Card i={1}>
        <CardHead title={t('in.cp.title')} hint={t('in.cp.hint')} />
        <div className="space-y-4 p-5 pt-4">
          {ch.loading && <Skeleton className="h-32" />}
          {ch.data && [ch.data.global, ...ch.data.components].map((s) => (
            <div key={s.scope} className="flex items-center justify-between gap-4">
              <div><p className="font-medium capitalize">{s.scope === 'all' ? t('in.cp.all') : s.scope}</p><p className="text-[13px] text-muted">{s.changeDetected ? t('in.cp.changed', { d: new Date(s.changeDay).toLocaleDateString(localeOf(), { day: 'numeric', month: 'long' }) }) : t('in.cp.stable')}</p></div>
              <Sparkline values={s.series} color={s.changeDetected ? 'var(--accent-2)' : 'var(--muted)'} />
            </div>
          ))}
        </div>
      </Card>
      <Card i={2} className="xl:col-span-2">
        <CardHead title={t('in.terms.title')} hint={t('in.terms.hint')} />
        <div className="flex flex-wrap gap-2 p-5 pt-4">
          {terms.loading && <Skeleton className="h-10 w-full" />}
          {terms.data?.terms.map((x) => <span key={x.term} className="chip !h-8 !text-[13px]">{x.term}<b className="text-accent">{x.isNew ? t('in.terms.new') : `×${x.lift}`}</b></span>)}
          {terms.data && !terms.data.terms.length && <p className="text-[14px] text-muted">{t('in.terms.none')}</p>}
        </div>
      </Card>
    </div>
  );
}

function reasonText(r, t) {
  return t(`in.decay.${r.code}`, r);
}

/** Brouillon d'article composé côté client (titre + sections dans la langue de l'interface). */
function draftBody(g, t) {
  const steps = g.steps?.length ? g.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : `_${t('in.gap.todo')}_`;
  return `## ${t('in.gap.symptom')}\n${g.symptom}\n\n## ${t('in.gap.resolution')}\n${steps}\n\n_${t('in.gap.footer', { n: g.size })}_`;
}

function Impact() {
  const { t } = useT();
  const roi = useResource(() => get('/intel/roi'));
  const decay = useResource(() => get('/intel/kb/decay'));
  const gaps = useResource(() => get('/intel/kb/gaps'));
  const r = roi.data;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHead title={t('in.roi.title')} hint={t('in.roi.hint')} />
        <div className="p-5 pt-4">
          {roi.loading ? <Skeleton className="h-32" /> : r?.hoursSaved != null ? (
            <>
              <p className="num text-[56px] leading-none text-accent">{r.hoursSaved}<span className="ml-2 text-[20px] text-muted">{t('unit.h')}</span></p>
              <p className="mt-3 text-[14px] text-muted">{t('in.roi.line', { a: r.ci95[0], b: r.ci95[1], c: r.assistedTickets, d: r.assistedMedianMinutes, e: r.baselineMedianMinutes })}</p>
              <p className="mt-3 text-[12px] text-faint">{t('in.roi.caveat')}</p>
            </>
          ) : <Empty icon="clock" title={t('in.roi.none')}>{t('in.roi.noneText')}</Empty>}
        </div>
      </Card>
      <Card i={1}>
        <CardHead title={t('in.decay.title')} hint={t('in.decay.hint')} />
        <ul className="p-3">
          {decay.loading && <li className="p-2"><Skeleton className="h-32" /></li>}
          {decay.data?.articles.slice(0, 5).map((a) => (
            <li key={a.id} className="row-hover rounded-xl px-3 py-2.5">
              <p className="flex justify-between gap-3 text-[14px] font-medium"><span className="truncate">{a.title}</span><span className="text-muted">{t('in.decay.days', { n: a.ageDays })}</span></p>
              <div className="mt-1.5"><Meter value={a.decay} tone={a.decay > 0.6 ? 'bad' : a.decay > 0.4 ? 'warn' : 'good'} /></div>
              {a.reasonCodes?.length > 0 && <p className="mt-1 text-[12px] text-muted">{a.reasonCodes.map((x) => reasonText(x, t)).join(' · ')}</p>}
            </li>
          ))}
        </ul>
      </Card>
      <Card i={2} className="xl:col-span-2">
        <CardHead title={t('in.gap.title')} hint={t('in.gap.hint')} />
        <div className="grid gap-3 p-5 pt-4 md:grid-cols-2">
          {gaps.loading && <Skeleton className="h-32" />}
          {gaps.data?.gaps.slice(0, 4).map((g, i) => (
            <div key={i} className="rounded-xl border border-line p-4">
              <p className="font-semibold">{t('in.gap.draftTitle', { title: g.tickets[0]?.title ?? '' })}</p>
              <p className="mt-1 text-[13px] text-muted">{t('in.gap.line', { n: g.size })} · {g.topTerms.join(', ')}</p>
              <pre className="mt-3 max-h-28 overflow-auto whitespace-pre-wrap rounded-lg bg-bg/40 p-3 font-sans text-[12.5px] text-muted">{draftBody(g, t)}</pre>
              <div className="mt-2 flex flex-wrap gap-1.5">{g.tickets.slice(0, 3).map((x) => <Link key={x.id} to={`/tickets/${x.id}`} className="chip hover:text-ink">{x.key}</Link>)}</div>
            </div>
          ))}
          {gaps.data && !gaps.data.gaps.length && <Empty icon="book" title={t('in.gap.none')} />}
        </div>
      </Card>
    </div>
  );
}
