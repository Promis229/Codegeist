import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useResource } from '../lib/hooks.js';
import { localeOf, useT } from '../i18n/index.jsx';
import { AreaChart, Bars, Ring } from '../components/Charts.jsx';
import Icon from '../components/Icon.jsx';
import { Badge, Card, CardHead, Empty, ErrorNote, Meter, PageHead, Skeleton, Stat, pct, useToast } from '../components/ui.jsx';

/** Briefing de relève en Markdown, construit à partir des données structurées (donc dans la langue de l'interface). */
function handoffMarkdown(d, hours, t) {
  const list = (rows, f, empty) => (rows.length ? rows.map(f) : [`- ${empty}`]);
  return [
    `# ${t('hand.title', { n: hours })}`,
    t('hand.stats', { a: d.stats.created, b: d.stats.resolved, c: d.stats.open }),
    '', `## ${t('hand.first')}`, ...list(d.critical, (x) => `- [${t(`prio.${x.priority}`).toUpperCase()}] ${x.key} ${x.title}`, t('hand.noCritical')),
    '', `## ${t('hand.waiting')}`, ...list(d.waitingOnUs, (x) => `- ${x.key} ${x.title} (${x.waiting_h} h)`, t('hand.none')),
    '', `## ${t('hand.tense')}`, ...list(d.tense, (x) => `- ${x.key} ${x.title} (${t('hand.frustration')} ${Math.round(x.frustration * 100)} %)`, t('hand.none')),
  ].join('\n');
}

const dur = (m) => m == null ? null : m < 90 ? { v: Math.round(m), u: 'min' } : { v: Math.round(m / 6) / 10, u: 'h' };
const tone = { breached: 'bad', at_risk: 'warn', ok: 'good' };

export default function Dashboard() {
  const { t } = useT();
  const { me } = useAuth();
  const toast = useToast();
  const overview = useResource(() => get('/analytics/overview'));
  const series = useResource(() => get('/analytics/timeseries?days=30'));
  const sla = useResource(() => get('/intel/sla/forecast'));
  const inc = useResource(() => get('/intel/incidents/emerging'));
  const risk = useResource(() => get('/intel/customers-at-risk'));
  const hand = useResource(() => get('/intel/handoff?hours=8'));
  const [copied, setCopied] = useState(false);

  const o = overview.data;
  const frt = dur(o?.medianFirstResponseMinutes);
  const h = new Date().getHours();
  const greeting = h < 6 ? t('dash.hello.night') : h < 18 ? t('dash.hello.day') : t('dash.hello.evening');

  return (
    <>
      <PageHead eyebrow={new Date().toLocaleDateString(localeOf(), { weekday: 'long', day: 'numeric', month: 'long' })} title={`${greeting}, ${me.user.displayName.split(' ')[0]}.`}>
        <Link to="/tickets" className="btn btn-primary">{t('dash.seeTickets')} <Icon name="arrow" size={16} /></Link>
      </PageHead>

      <ErrorNote error={overview.error} retry={overview.reload} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {overview.loading ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[148px]" />) : <>
          <Stat i={0} label={t('dash.open')} value={o.totals.open} hint={t('dash.openHint', { a: o.totals.last24h, b: o.totals.resolved24h })} />
          <Stat i={1} label={t('dash.frt')} value={frt?.v} unit={frt?.u === 'min' ? t('unit.min') : t('unit.h')} hint={t('dash.frtHint')} />
          <Stat i={2} label={t('dash.sla')} value={pct(o.slaCompliance)} unit="%" tone={o.slaCompliance == null ? undefined : o.slaCompliance >= 0.9 ? 'good' : o.slaCompliance >= 0.75 ? 'warn' : 'bad'} hint={t('dash.slaHint')} />
          <Stat i={3} label={t('dash.accept')} value={pct(o.aiAnswerAcceptance)} unit="%" hint={t('dash.acceptHint')} />
        </>}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.7fr_1fr]">
        <Card i={4}>
          <CardHead title={t('dash.volume')} hint={t('dash.volumeHint')} />
          <div className="p-5 pt-3">{series.loading ? <Skeleton className="h-[240px]" /> : <AreaChart data={series.data.series} />}</div>
        </Card>
        <Card i={5}>
          <CardHead title={t('dash.where')} hint={t('dash.whereHint')} />
          <div className="p-5 pt-4">
            {overview.loading ? <Skeleton className="h-40" /> : o.byComponent.length ? <Bars rows={o.byComponent.map((c) => ({ label: c.component, n: c.n }))} /> : <Empty icon="pulse" title={t('dash.noComponent')} />}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card i={6}>
          <CardHead title={t('dash.slaForecast')} hint={t('dash.slaForecastHint')}
            right={sla.data && <div className="flex gap-1.5"><Badge tone="bad">{t('dash.breached', { n: sla.data.summary.breached })}</Badge><Badge tone="warn">{t('dash.atRisk', { n: sla.data.summary.atRisk })}</Badge></div>} />
          <ul className="p-3">
            {sla.loading && <li className="p-2"><Skeleton className="h-40" /></li>}
            {sla.data?.tickets.filter((x) => x.state !== 'ok').slice(0, 6).map((x) => (
              <li key={x.id}>
                <Link to={`/tickets/${x.id}`} className="row-hover flex items-center gap-4 rounded-xl px-3 py-2.5">
                  <Ring value={x.breachProbability} tone={`var(--${tone[x.state] === 'bad' ? 'bad' : 'warn'})`} label={t('dash.probLabel', { n: pct(x.breachProbability) })} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium"><span className="mr-2 text-faint">{x.key}</span>{x.title}</span>
                    <span className="text-[12px] text-muted">{t(`sla.${x.state}`)}{x.minutesLeft > 0 ? ` · ${t('dash.minLeft', { n: x.minutesLeft })}` : ''}{x.firstResponseOverdue ? ` · ${t('dash.frtLate')}` : ''}</span>
                  </span>
                  <Badge tone={x.priority}>{t(`prio.${x.priority}`)}</Badge>
                </Link>
              </li>
            ))}
            {sla.data && !sla.data.tickets.some((x) => x.state !== 'ok') && <Empty icon="check" title={t('dash.allOk')}>{t('dash.allOkText')}</Empty>}
          </ul>
        </Card>

        <Card i={7}>
          <CardHead title={t('dash.incidents')} hint={t('dash.incidentsHint')} />
          <ul className="space-y-3 p-5 pt-4">
            {inc.loading && <Skeleton className="h-40" />}
            {inc.data?.incidents.map((i) => (
              <li key={i.component} className="rounded-xl border border-line p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-semibold capitalize">{i.component}</p>
                  <Badge tone={i.severity === 'major' ? 'bad' : 'warn'}>{t(i.severity === 'major' ? 'dash.major' : 'dash.minor')}</Badge>
                </div>
                <p className="mt-1 text-[13px] text-muted">{t('dash.incLine', { a: i.ticketsLast6h, b: i.blastRadius.customers })}{i.blastRadius.enterprise ? ` ${t('dash.incEnt', { n: i.blastRadius.enterprise })}` : ''}</p>
                {i.suspectedDeploy && <p className="mt-2 text-[13px]"><span className="text-accent">{t('dash.suspectDeploy')}</span> : {i.suspectedDeploy.name}, {t('dash.hoursBefore', { n: i.suspectedDeploy.hoursBefore })}</p>}
              </li>
            ))}
            {inc.data && !inc.data.incidents.length && <Empty icon="shield" title={t('dash.noIncident')}>{t('dash.noIncidentText')}</Empty>}
          </ul>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card i={8}>
          <CardHead title={t('dash.atRiskCustomers')} hint={t('dash.atRiskHint')} right={<Link to="/intelligence" className="text-[13px] text-accent hover:underline">{t('common.seeAll')}</Link>} />
          <ul className="p-3">
            {risk.loading && <li className="p-2"><Skeleton className="h-40" /></li>}
            {risk.data?.customers.slice(0, 5).map((c) => (
              <li key={c.customer.id} className="row-hover flex items-center gap-4 rounded-xl px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium">{c.customer.name}<span className="ml-2 text-faint">{c.customer.company}</span></span>
                  <Meter value={c.churnRisk} tone={c.level === 'high' ? 'bad' : c.level === 'medium' ? 'warn' : 'good'} />
                </span>
                <Badge tone={c.customer.tier}>{t(`tier.${c.customer.tier}`)}</Badge>
                <span className="num w-10 text-right text-[22px]">{pct(c.churnRisk)}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card i={9}>
          <CardHead title={t('dash.handoff')} hint={t('dash.handoffHint')}
            right={hand.data && <button className="btn h-8 text-[13px]" onClick={async () => { await navigator.clipboard.writeText(handoffMarkdown(hand.data, 8, t)); setCopied(true); toast(t('dash.copiedToast')); setTimeout(() => setCopied(false), 1800); }}>
              <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? t('common.copied') : t('common.copy')}</button>} />
          <div className="p-5 pt-4">
            {hand.loading ? <Skeleton className="h-40" /> : <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-bg/40 p-4 font-sans text-[13px] leading-relaxed text-muted">{hand.data && handoffMarkdown(hand.data, 8, t)}</pre>}
          </div>
        </Card>
      </div>
    </>
  );
}
