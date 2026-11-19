import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, post, del } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useDebounced, useResource } from '../lib/hooks.js';
import { errText, useT } from '../i18n/index.jsx';
import Icon from '../components/Icon.jsx';
import { Badge, Card, Empty, ErrorNote, Field, PageHead, Skeleton, ago, useToast } from '../components/ui.jsx';

export default function Knowledge() {
  const { t, lang } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const dq = useDebounced(q, 300);
  const [adding, setAdding] = useState(false);
  const [toDelete, setToDelete] = useState(null);
  const [allLangs, setAllLangs] = useState(params.has('q')); // venu de la recherche globale : l'article peut etre dans une autre langue // par défaut : seulement les articles dans la langue de l'interface
  const qs = new URLSearchParams();
  if (dq) qs.set('q', dq);
  if (!allLangs) qs.set('lang', lang);
  const r = useResource(() => get(`/kb${qs.toString() ? `?${qs}` : ''}`), [dq, allLangs, lang]);

  async function remove() {
    const a = toDelete; setToDelete(null);
    await del(`/kb/${a.id}`).then(() => { toast(t('kb.deleted')); r.reload(); }, (e) => toast(errText(e), 'bad'));
  }
  return (
    <>
      <PageHead eyebrow={t('kb.eyebrow')} title={t('kb.title')}>
        {can('agent') && <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> {t('kb.new')}</button>}
      </PageHead>
      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Icon name="search" size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
            <input className="input !h-10 !pl-10" placeholder={t('kb.searchPh')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('common.search')} />
          </div>
          <label className="flex items-center gap-2 px-2 text-[13px] text-muted"><input type="checkbox" className="accent-[var(--accent)]" checked={allLangs} onChange={(e) => setAllLangs(e.target.checked)} /> {t('kb.allLangs')}</label>
        </div>
      </Card>
      <ErrorNote error={r.error} retry={r.reload} />
      <Card i={1} className="overflow-hidden">
        {r.loading && !r.data ? <div className="space-y-2 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div> : r.data.articles.length ? (
          <ul className="divide-y divide-line">
            {r.data.articles.map((a) => (
              <li key={a.id} className="row-hover flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
                <Icon name="book" className="shrink-0 text-accent" />
                <div className="min-w-0 flex-1 basis-[10rem]">
                  <p className="break-words font-medium sm:truncate">{a.url ? <a href={a.url} target="_blank" rel="noreferrer noopener" className="hover:underline">{a.title}</a> : a.title}</p>
                  <p className="text-[13px] text-muted sm:truncate">{a.excerpt ?? t('kb.meta', { space: a.space ?? t('kb.internal'), when: ago(a.updated_at), n: a.views ?? 0 })}</p>
                </div>
                {allLangs && a.lang && <span className="chip !h-6 uppercase">{a.lang}</span>}
                {a.source && a.source !== 'manual' && <Badge tone="low">{a.source === 'confluence' ? 'Confluence' : t('kb.src.generated')}</Badge>}
                {can('admin') && <button className="btn btn-ghost btn-danger h-8 px-2.5 text-[13px]" onClick={() => setToDelete(a)}>{t('common.delete')}</button>}
              </li>
            ))}
          </ul>
        ) : <Empty icon="book" title={t('kb.empty')}>{dq ? t('kb.noResult') : !allLangs ? t('kb.noInLang') : t('kb.emptyText')}</Empty>}
      </Card>
      {adding && <NewArticle onClose={() => setAdding(false)} onDone={() => { setAdding(false); r.reload(); toast(t('kb.added')); }} />}
      {toDelete && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4 backdrop-blur-sm fade" onMouseDown={(e) => e.target === e.currentTarget && setToDelete(null)}>
          <div className="glass rise w-full max-w-[440px] rounded-3xl p-7" style={{ background: 'var(--surface-solid)' }} role="alertdialog" aria-modal="true">
            <h2 className="font-serif text-[24px] tracking-tight">{t('kb.confirmTitle')}</h2>
            <p className="mt-2 text-[14px] text-muted">{t('kb.confirmText', { title: toDelete.title })}</p>
            <div className="mt-6 flex justify-end gap-2"><button className="btn btn-ghost" onClick={() => setToDelete(null)}>{t('common.cancel')}</button><button className="btn btn-danger" onClick={remove}>{t('common.delete')}</button></div>
          </div>
        </div>
      )}
    </>
  );
}

function NewArticle({ onClose, onDone }) {
  const { t } = useT();
  const [f, setF] = useState({ title: '', body: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await post('/kb', f); onDone(); } catch (ex) { setErr(ex); } finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4 backdrop-blur-sm fade" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form onSubmit={submit} className="glass rise w-full max-w-[620px] space-y-4 rounded-3xl p-7" style={{ background: 'var(--surface-solid)' }} role="dialog" aria-modal="true" aria-label={t('kb.new')}>
        <h2 className="font-serif text-[26px] tracking-tight">{t('kb.new')}</h2>
        <Field label={t('tk.fTitle')}><input className="input" required autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label={t('kb.content')}><textarea className="input" rows={9} required value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        {err && <p role="alert" className="text-[13px] text-bad">{errText(err)}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={busy}>{t('common.add')}</button></div>
      </form>
    </div>
  );
}
