import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, get, patch, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useResource } from '../lib/hooks.js';
import { errText, useT } from '../i18n/index.jsx';
import Icon from '../components/Icon.jsx';
import { AnswerPanel } from './Copilot.jsx';
import { Badge, Card, CardHead, ErrorNote, Meter, Skeleton, Spinner, ago, cx, fmtDate, pct, useToast } from '../components/ui.jsx';

const STATUSES = ['open', 'pending', 'resolved', 'closed'];
const verdict = { duplicate: 'bad', probable: 'warn', related: 'low' };

export default function TicketDetail() {
  const { t } = useT();
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const tk = useResource(() => get(`/tickets/${id}`), [id]);
  const dups = useResource(() => get(`/intel/tickets/${id}/duplicates`).catch(() => null), [id]);
  const experts = useResource(() => get(`/intel/experts?ticketId=${id}`).catch(() => null), [id]);
  const risk = useResource(() => get(`/intel/tickets/${id}/risk`).catch(() => null), [id]);
  const sem = useResource(() => get(`/intel/tickets/${id}/semantic-similar`).catch(() => null), [id]);

  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [guard, setGuard] = useState(null);
  const [busy, setBusy] = useState('');

  if (tk.loading && !tk.data) return <Skeleton className="h-[480px]" />;
  if (tk.error) return <ErrorNote error={tk.error} retry={tk.reload} />;
  const d = tk.data;

  async function removeTicket() {
    if (!window.confirm(t('td.confirmDelete', { key: d.key }))) return;
    try { await del(`/tickets/${id}`); toast(t('td.deleted')); nav('/tickets'); } catch (e) { toast(errText(e), 'bad'); }
  }
  async function setStatus(status) { await patch(`/tickets/${id}`, { status }); toast(t('td.statusUpdated')); tk.reload(); }
  async function check() {
    setBusy('guard');
    try { setGuard(await post('/intel/reply/guard', { body: reply, ticketId: id })); } catch (e) { toast(errText(e), 'bad'); } finally { setBusy(''); }
  }
  async function send() {
    setBusy('send');
    try { await post(`/tickets/${id}/comments`, { body: reply, internal }); setReply(''); setGuard(null); tk.reload(); toast(internal ? t('td.noteAdded') : t('td.replySent')); }
    catch (e) { toast(errText(e), 'bad'); } finally { setBusy(''); }
  }

  return (
    <>
      <Link to="/tickets" className="rise mb-6 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><Icon name="arrow" size={14} className="rotate-180" /> {t('tk.title')}</Link>
      <div className="rise mb-8" style={{ '--i': 1 }}>
        <p className="eyebrow">{d.key}</p>
        <h1 className="mt-1 max-w-[28ch] font-serif text-[34px] leading-[1.1] tracking-tight sm:max-w-none sm:text-[40px]" style={{ fontVariationSettings: '"opsz" 144, "SOFT" 40' }}>{d.title}</h1>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge tone={d.priority}>{t(`prio.${d.priority}`)}</Badge><Badge tone={d.status}>{t(`status.${d.status}`)}</Badge>
          {d.component && <span className="chip">{d.component}</span>}
          {d.customer_tier && <Badge tone={d.customer_tier}>{d.customer_name} · {t(`tier.${d.customer_tier}`)}</Badge>}
          <span className="text-[13px] text-faint">{t('td.created', { when: ago(d.created_at) })}</span>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <div className="space-y-4">
          <Card i={2}>
            <div className="p-5"><p className="whitespace-pre-wrap text-[15px] leading-relaxed">{d.body}</p></div>
          </Card>

          <Card i={3}>
            <CardHead title={t('td.thread')} hint={t('td.messages', { n: d.comments.length })} />
            <ul className="space-y-3 p-5">
              {d.comments.map((c) => (
                <li key={c.id} className={cx('max-w-[90%] rounded-2xl border px-4 py-3', c.author_is_customer ? 'border-line bg-surface' : c.internal ? 'ml-auto border-warn/30 bg-warn/10' : 'ml-auto border-accent/30 bg-accent/10')}>
                  <p className="mb-1 text-[12px] text-muted"><b className="text-ink">{c.author_is_customer ? (d.customer_name ?? t('td.customer')) : (c.author_name ?? t('td.team'))}</b>{c.internal ? ` · ${t('td.internalNote')}` : ''} · {fmtDate(c.created_at)}</p>
                  <p className="whitespace-pre-wrap text-[14px]">{c.body}</p>
                </li>
              ))}
              {!d.comments.length && <li className="text-[14px] text-muted">{t('td.noThread')}</li>}
            </ul>

            {can('agent') && (
              <div className="border-t border-line p-5">
                <textarea className="input" rows={4} placeholder={t('td.replyPh')} value={reply} onChange={(e) => { setReply(e.target.value); setGuard(null); }} aria-label={t('td.reply')} />
                {guard && <Guard g={guard} onApply={() => { setReply(guard.redactedSuggestion); setGuard(null); }} />}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-[13px] text-muted"><input type="checkbox" className="accent-[var(--accent)]" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> {t('td.internalNote')}</label>
                  <div className="flex gap-2">
                    <button className="btn" disabled={reply.trim().length < 3 || !!busy} onClick={check}>{busy === 'guard' ? <Spinner size={14} /> : <Icon name="shield" size={16} />} {t('td.check')}</button>
                    <button className="btn btn-primary" disabled={!reply.trim() || !!busy || (guard && !guard.safeToSend && !internal)} onClick={send}>{busy === 'send' ? <Spinner size={14} /> : t('td.send')}</button>
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card i={3}>
            <CardHead title={t('td.follow')} />
            <div className="space-y-4 p-5 pt-3 text-[14px]">
              {can('agent') && (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('td.changeStatus')}>
                  {STATUSES.map((v) => <button key={v} onClick={() => setStatus(v)} aria-pressed={d.status === v} className={cx('h-8 rounded-lg border px-3 text-[13px] font-semibold', d.status === v ? 'border-transparent bg-accent text-onaccent' : 'border-line text-muted hover:text-ink')}>{t(`status.${v}`)}</button>)}
                </div>
              )}
              <div><p className="mb-1.5 flex justify-between text-[12px] text-muted"><span>{t('td.frustration')}</span><span>{pct(d.frustration ?? 0)} %</span></p><Meter value={d.frustration ?? 0} tone={d.frustration > 0.6 ? 'bad' : d.frustration > 0.35 ? 'warn' : 'good'} /></div>
              <p className="text-muted">{t('td.assignedTo')} <b className="text-ink">{d.assignee_name ?? t('td.nobody')}</b></p>
              {d.reopened_count > 0 && <p className="text-warn">{t('td.reopened', { n: d.reopened_count })}</p>}
              {can('admin') && <button className="btn btn-ghost btn-danger h-8 px-3 text-[13px]" onClick={removeTicket}><Icon name="trash" size={14} /> {t('td.delete')}</button>}
            </div>
          </Card>

          {can('agent') && <AssignCard id={id} current={d.assignee_id} onDone={tk.reload} />}
          {can('agent') && <AnswerPanel ticketId={id} seed={`${d.title}\n${d.body}`.slice(0, 400)} onUse={(txt) => setReply((r) => (r ? `${r}\n\n${txt}` : txt))} i={4} />}
          {can('agent') && <Insights id={id} />}

          {risk.data && (
            <Card i={4}>
              <CardHead title={t('td.risk.title')} hint={t('td.risk.hint')} />
              <div className="space-y-3 p-5 pt-3 text-[14px]">
                {risk.data.engine === 'ml' ? (<>
                  {risk.data.resolutionHours && <p className="num text-[30px] leading-none">{risk.data.resolutionHours.p50}<span className="ml-1.5 text-[16px] text-muted">{t('unit.h')}</span></p>}
                  {risk.data.resolutionHours && <p className="text-[13px] text-muted">{t('td.risk.eta', { a: risk.data.resolutionHours.p50, b: risk.data.resolutionHours.p90 })}</p>}
                  {risk.data.slaBreachProbability != null && <div><p className="mb-1.5 text-[12.5px] text-muted">{t('td.risk.sla', { n: pct(risk.data.slaBreachProbability) })}</p><Meter value={risk.data.slaBreachProbability} tone={risk.data.slaBreachProbability > 0.6 ? 'bad' : risk.data.slaBreachProbability > 0.3 ? 'warn' : 'good'} /></div>}
                  {risk.data.reopenProbability != null && <div><p className="mb-1.5 text-[12.5px] text-muted">{t('td.risk.reopen', { n: pct(risk.data.reopenProbability) })}</p><Meter value={risk.data.reopenProbability} tone={risk.data.reopenProbability > 0.5 ? 'bad' : 'warn'} /></div>}
                </>) : <p className="text-[13px] text-muted">{t('td.risk.off')}</p>}
              </div>
            </Card>
          )}

          {sem.data && (
            <Card i={5}>
              <CardHead title={t('td.sem.title')} hint={t('td.sem.hint')} />
              <ul className="p-3">
                {sem.data.similar.slice(0, 5).map((x) => (
                  <li key={x.id}><Link to={`/tickets/${x.id}`} className="row-hover flex items-center gap-3 rounded-xl px-3 py-2.5">
                    <span className="min-w-0 flex-1"><span className="block truncate text-[14px]"><span className="mr-2 text-faint">{x.label}</span>{x.title}</span></span>
                    {x.crossLingual && <Badge tone="good">{t('td.sem.cross')}</Badge>}
                    <span className="num w-9 text-right text-[16px]">{pct(x.score)}</span>
                  </Link></li>
                ))}
                {!sem.data.similar.length && <li className="px-3 py-4 text-[13px] text-muted">{t('td.sem.none')}</li>}
              </ul>
              {sem.data.engine === 'lexical' && <p className="px-5 pb-4 text-[12px] text-faint">{t('td.sem.lexical')}</p>}
            </Card>
          )}

          <Card i={5}>
            <CardHead title={t('td.similar')} hint={t('td.similarHint')} />
            <ul className="p-3">
              {dups.loading && <li className="p-2"><Skeleton className="h-20" /></li>}
              {dups.data?.duplicates.slice(0, 5).map((x) => (
                <li key={x.id}><Link to={`/tickets/${x.id}`} className="row-hover flex items-center gap-3 rounded-xl px-3 py-2.5">
                  <span className="min-w-0 flex-1"><span className="block truncate text-[14px]"><span className="mr-2 text-faint">{x.key}</span>{x.title}</span></span>
                  <Badge tone={verdict[x.verdict]}>{t(`verdict.${x.verdict}`)}</Badge>
                </Link></li>
              ))}
              {dups.data && !dups.data.duplicates.length && <li className="px-3 py-4 text-[13px] text-muted">{t('td.noSimilar')}</li>}
            </ul>
          </Card>

          {experts.data?.experts?.length > 0 && (
            <Card i={6}>
              <CardHead title={t('td.experts')} hint={t('td.expertsHint')} />
              <ul className="p-3">
                {experts.data.experts.slice(0, 3).map((e) => (
                  <li key={e.userId} className="rounded-xl px-3 py-2.5">
                    <p className="flex justify-between text-[14px] font-medium"><span>{e.name}</span><span className="text-muted">{t('td.similarCases', { n: e.solved })}</span></p>
                    <div className="mt-1.5"><Meter value={e.score} /></div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {d.kb.length > 0 && (
            <Card i={7}>
              <CardHead title={t('td.linked')} />
              <ul className="p-3">{d.kb.map((a) => <li key={a.id} className="flex items-center gap-2 px-3 py-2 text-[14px]"><Icon name="book" size={15} className="text-accent" />{a.url ? <a href={a.url} target="_blank" rel="noreferrer noopener" className="hover:underline">{a.title}</a> : a.title}</li>)}</ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

/** Recommandation d'assignation : competences, langue, charge, disponibilite horaire et experience reelle de chaque agent. */
function AssignCard({ id, current, onDone }) {
  const { t } = useT();
  const toast = useToast();
  const [rec, setRec] = useState(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try { setRec(await post('/intel/assign/recommend', { ticketId: id })); } catch (e) { toast(errText(e), 'bad'); } finally { setBusy(false); }
  }
  async function assign(userId) {
    try { await patch(`/tickets/${id}`, { assigneeId: userId }); toast(t('td.assigned')); onDone(); } catch (e) { toast(errText(e), 'bad'); }
  }
  return (
    <Card i={4}>
      <CardHead title={t('td.assign.title')} hint={t('td.assign.hint')} right={<button className="btn h-9 text-[13px]" onClick={run} disabled={busy}>{busy ? <Spinner size={14} /> : <Icon name="users" size={15} />} {t('td.assign.run')}</button>} />
      {rec && (
        <ul className="p-3">
          {rec.ranking.map((r, i) => (
            <li key={r.userId} className="rounded-xl px-3 py-2.5">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{r.name}{i === 0 && <span className="ml-2 chip text-good">{t('td.assign.best')}</span>}</span><span className="text-[12px] text-muted">{t('td.assign.load', { n: r.openLoad })}</span></span>
                <span className="num text-[18px]">{pct(r.score)}</span>
                <button className="btn h-8 px-3 text-[13px]" disabled={current === r.userId} onClick={() => assign(r.userId)}>{current === r.userId ? t('td.assign.current') : t('td.assign.do')}</button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {['skill', 'language', 'availability'].map((k) => <span key={k} className={cx('chip', r.parts[k] ? 'border-good/40 text-good' : 'opacity-60')}>{t(`td.assign.${k}`)}</span>)}
              </div>
            </li>
          ))}
          {!rec.ranking.length && <li className="px-3 py-4 text-[13px] text-muted">{t('td.assign.none')}</li>}
        </ul>
      )}
    </Card>
  );
}

/** Resume extractif, delai estime par cas similaires, et bascules de ton du client dans le fil. */
function Insights({ id }) {
  const { t } = useT();
  const sum = useResource(() => get(`/intel/tickets/${id}/summary`).catch(() => null), [id]);
  const eta = useResource(() => get(`/intel/tickets/${id}/eta`).catch(() => null), [id]);
  const tone = useResource(() => get(`/intel/tickets/${id}/tone-shift`).catch(() => null), [id]);
  const riskTone = { high: 'bad', medium: 'warn', low: 'good' };
  return (
    <Card i={5}>
      <CardHead title={t('td.ins.title')} hint={t('td.ins.hint')} />
      <div className="space-y-5 p-5 pt-4 text-[14px]">
        <div>
          <p className="eyebrow mb-1.5">{t('td.ins.summary')}</p>
          {sum.loading ? <Skeleton className="h-16" /> : sum.data?.sentences?.length ? (
            <ul className="space-y-1.5">{sum.data.sentences.map((s, i) => <li key={i} className="flex gap-2"><span className={cx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', s.from === 'customer' ? 'bg-accent' : 'bg-good')} /><span>{s.text}<span className="ml-1.5 text-[12px] text-faint">{t(`td.ins.from.${s.from}`)}</span></span></li>)}</ul>
          ) : <p className="text-muted">{t('td.ins.noSummary')}</p>}
        </div>
        <div>
          <p className="eyebrow mb-1.5">{t('td.ins.eta')}</p>
          {eta.loading ? <Skeleton className="h-12" /> : eta.data?.method && eta.data.method !== 'none' ? (
            <div className="space-y-1">
              <p className="num text-[28px] leading-none">{eta.data.p50Hours}<span className="ml-1.5 text-[15px] text-muted">{t('unit.h')}</span></p>
              <p className="text-[13px] text-muted">{t('td.ins.etaRange', { a: eta.data.p80Hours, b: eta.data.p95Hours })}</p>
              <p className="text-[12px] text-faint">{t(`td.ins.etaBasis.${eta.data.method}`, { n: eta.data.basedOn })}</p>
            </div>
          ) : <p className="text-muted">{t('td.ins.noEta')}</p>}
        </div>
        <div>
          <p className="eyebrow mb-1.5 flex items-center justify-between"><span>{t('td.ins.tone')}</span>{tone.data && <Badge tone={riskTone[tone.data.escalationRisk]}>{t(`level.${tone.data.escalationRisk}`)}</Badge>}</p>
          {tone.loading ? <Skeleton className="h-12" /> : tone.data?.shifts?.length ? (
            <ul className="space-y-2">{tone.data.shifts.map((s, i) => (
              <li key={i} className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2.5 text-[13px]">
                <p className="font-semibold text-warn">{t('td.ins.drop', { n: Math.round(s.drop * 100) })}</p>
                <p className="mt-1 text-muted">{t('td.ins.after', { who: s.triggerReply.author ?? t('td.team') })} : <q>{s.triggerReply.excerpt}</q></p>
              </li>
            ))}</ul>
          ) : <p className="text-muted">{t('td.ins.noShift')}</p>}
        </div>
      </div>
    </Card>
  );
}

function Guard({ g, onApply }) {
  const { t } = useT();
  const col = { high: 'text-bad', medium: 'text-warn', low: 'text-muted' };
  return (
    <div className={cx('mt-3 rounded-xl border p-4 text-[13px]', g.safeToSend ? 'border-good/40 bg-good/10' : 'border-bad/40 bg-bad/10')} role="status">
      <p className="font-semibold">{g.safeToSend ? t('guard.ok') : t('guard.fix')} · {t('guard.score', { n: g.score })}</p>
      {g.issues.length > 0 && <ul className="mt-2 space-y-1">{g.issues.map((i, k) => <li key={k} className={col[i.severity]}>{t(`guard.${i.code}`, i.params)}</li>)}</ul>}
      {g.redactedSuggestion && <button className="btn mt-3 h-8 text-[13px]" onClick={onApply}>{t('guard.redact')}</button>}
    </div>
  );
}
