import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { errText, useT } from '../i18n/index.jsx';
import Icon from '../components/Icon.jsx';
import { Card, CardHead, PageHead, Spinner, cx, pct, useToast } from '../components/ui.jsx';
import { Ring } from '../components/Charts.jsx';

// Réveille le service d'IA (il s'éteint sans trafic) dès l'ouverture du copilote : il est prêt quand la question part.
const warmUp = () => post('/ml/warm', {}).catch(() => {});

const DEMO_QUESTIONS = [1, 2, 3, 4, 5, 6];
const THINK_MS = 1600; // durée minimale de l'animation « Kairos réfléchit » dans la démo

/** Trois points qui rebondissent : la réponse se prépare. */
function Typing() {
  const { t } = useT();
  return (
    <span className="typing inline-flex items-center gap-1.5 py-2" role="status" aria-label={t('cp.demo.thinking')}>
      <i /><i /><i />
    </span>
  );
}

function AnswerResult({ res, onUse, rated, rate }) {
  const { t } = useT();
  return (
    <div className="space-y-4 fade">
      <div className="flex items-center gap-4">
        <Ring value={res.confidence} size={52} tone={res.abstained ? 'var(--bad)' : res.confidence > 0.6 ? 'var(--good)' : 'var(--warn)'} label={t('cp.confidence', { n: pct(res.confidence) })} />
        <div>
          <p className="font-semibold">{res.abstained ? t('cp.abstain') : t('cp.proposed')}</p>
          <p className="text-[13px] text-muted">{res.abstained ? t(res.emptyBase ? 'cp.emptyBase' : res.confidence === 0 ? 'cp.noSource' : 'cp.lowConfidence') : t('cp.stats', { a: pct(res.confidence), b: pct(res.coverage) })}</p>
        </div>
      </div>
      {res.emptyBase && <Link to="/knowledge" className="btn btn-primary inline-flex"><Icon name="plus" size={15} /> {t('cp.emptyAction')}</Link>}
      {res.answer && (
        <>
          <p className="rounded-xl border border-accent/30 bg-accent/10 p-4 text-[14px] leading-relaxed">{res.answer}</p>
          <div>
            <p className="eyebrow mb-2">{t('cp.sources')}</p>
            <ul className="space-y-2">
              {res.citations.map((c, k) => (
                <li key={k} className="rounded-xl border border-line p-3 text-[13px]">
                  <p className="mb-1 flex items-center gap-1.5 font-semibold"><Icon name={c.source.type === 'kb' ? 'book' : 'ticket'} size={14} className="text-accent" />
                    {c.source.url ? <a href={c.source.url} target="_blank" rel="noreferrer noopener" className="hover:underline">{c.source.label}</a> : c.source.label}</p>
                  <p className="text-muted">“{c.quote}”</p>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {onUse && <button className="btn" onClick={() => onUse(res.answer)}>{t('cp.insert')}</button>}
            <span className="flex items-center gap-1 text-[13px] text-muted">{t('cp.useful')}
              <button className="btn btn-ghost h-8 px-2.5" disabled={rated !== null} onClick={() => rate(true)}>{t('common.yes')}</button>
              <button className="btn btn-ghost h-8 px-2.5" disabled={rated !== null} onClick={() => rate(false)}>{t('common.no')}</button></span>
          </div>
        </>
      )}
    </div>
  );
}

/** Reponse sourcee : citations tracables ; le copilote s'abstient quand la confiance est faible. */
export function AnswerPanel({ ticketId, seed = '', onUse, i = 0, standalone = false }) {
  const { t } = useT();
  const { isDemo } = useAuth();
  const toast = useToast();
  const demoMode = standalone && isDemo;
  const [q, setQ] = useState(standalone ? '' : seed);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [rated, setRated] = useState(null);
  const convo = useRef(null);

  async function ask(e) {
    e?.preventDefault(); setBusy(true); setErr(null); setRes(null); setRated(null);
    try { setRes(await post('/intel/answer', { question: q, ...(ticketId ? { ticketId } : {}) })); }
    catch (ex) { setErr(ex); } finally { setBusy(false); }
  }
  /** Démo : une question toute prête. La réponse est la vraie (même moteur, mêmes sources) ; l'animation couvre le temps de calcul. */
  async function askDemo(question) {
    if (busy) return;
    setQ(question); setBusy(true); setErr(null); setRes(null); setRated(null);
    setTimeout(() => convo.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
    try {
      const [r] = await Promise.all([post('/intel/answer', { question }), new Promise((done) => setTimeout(done, THINK_MS))]);
      setRes(r);
    } catch (ex) { setErr(ex); } finally { setBusy(false); }
  }
  async function rate(accepted) {
    setRated(accepted);
    await post(`/intel/answer/${res.id}/feedback`, { accepted }).catch(() => {});
    toast(accepted ? t('cp.thanksYes') : t('cp.thanksNo'));
  }

  if (demoMode) {
    return (
      <Card i={i}>
        <CardHead title={t('cp.title')} hint={t('cp.demo.pick')} />
        <div className="flex flex-wrap gap-2 p-5 pt-4" role="group" aria-label={t('cp.demo.suggested')}>
          {DEMO_QUESTIONS.map((n) => {
            const text = t(`cp.demo.q${n}`);
            return (
              <button key={n} type="button" disabled={busy} onClick={() => askDemo(text)} aria-pressed={q === text}
                className={cx('rounded-2xl border px-3.5 py-2 text-left text-[13.5px] leading-snug transition-colors disabled:cursor-wait',
                  q === text ? 'border-accent/60 bg-accent/15 text-ink' : 'border-line text-muted hover:border-line2 hover:text-ink')}>{text}</button>
            );
          })}
        </div>
        {q && (
          <div ref={convo} className="space-y-3 border-t border-line p-5" aria-live="polite">
            <p className="ml-auto max-w-[88%] rounded-2xl rounded-br-md border border-accent/30 bg-accent/15 px-4 py-2.5 text-[14px]">{q}</p>
            <div className="max-w-[96%] rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-3">
              {busy && <Typing />}
              {err && <p role="alert" className="text-[13px] text-bad">{errText(err)}</p>}
              {res && <AnswerResult res={res} onUse={onUse} rated={rated} rate={rate} />}
            </div>
          </div>
        )}
      </Card>
    );
  }

  return (
    <Card i={i}>
      <CardHead title={t('cp.title')} hint={t('cp.hint')} />
      <form onSubmit={ask} className="space-y-3 p-5 pt-4">
        <textarea className="input" rows={standalone ? 4 : 3} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('cp.ph')} aria-label={t('cp.question')} />
        <button className="btn btn-primary w-full" disabled={busy || q.trim().length < 5}>{busy ? <Spinner size={14} /> : <Icon name="spark" size={16} />} {t('cp.search')}</button>
      </form>
      {err && <p role="alert" className="px-5 pb-5 text-[13px] text-bad">{errText(err)}</p>}
      {res && <div className="border-t border-line p-5"><AnswerResult res={res} onUse={onUse} rated={rated} rate={rate} /></div>}
    </Card>
  );
}

export default function Copilot() {
  const { t } = useT();
  useEffect(() => { warmUp(); }, []);
  return (
    <>
      <PageHead eyebrow={t('cp.eyebrow')} title={t('cp.pageTitle')} />
      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <AnswerPanel standalone />
        <Card i={2} className="p-6">
          <h2 className="font-semibold">{t('cp.how')}</h2>
          <ol className="mt-4 space-y-4 text-[14px] text-muted">
            {[1, 2, 3, 4].map((n) => <li key={n}><b className="text-ink">{n}. {t(`cp.h${n}.t`)}</b> {t(`cp.h${n}.p`)}</li>)}
          </ol>
        </Card>
      </div>
    </>
  );
}
