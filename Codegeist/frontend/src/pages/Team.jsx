import { useState } from 'react';
import { del, get, patch, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useResource } from '../lib/hooks.js';
import { errText, useT } from '../i18n/index.jsx';
import Icon from '../components/Icon.jsx';
import { Avatar, Badge, Card, ErrorNote, Field, Meter, Modal, PageHead, Skeleton, Spinner, useToast } from '../components/ui.jsx';

const ROLES = ['viewer', 'agent', 'admin', 'owner'];
const csv = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

export default function Team() {
  const { t } = useT();
  const { can, me } = useAuth();
  const toast = useToast();
  const res = useResource(() => get('/members'));
  const [invite, setInvite] = useState(false);
  const [edit, setEdit] = useState(null);
  const [coach, setCoach] = useState(null);
  const members = res.data?.members ?? [];

  async function remove(m) {
    if (!window.confirm(t('tm.confirmRemove', { name: m.display_name }))) return;
    try { await del(`/members/${m.id}`); toast(t('tm.removed')); res.reload(); } catch (e) { toast(errText(e), 'bad'); }
  }

  return (
    <>
      <PageHead eyebrow={t('tm.eyebrow')} title={t('tm.title')}>
        {can('admin') && <button className="btn btn-primary" onClick={() => setInvite(true)}><Icon name="plus" size={16} /> {t('tm.invite')}</button>}
      </PageHead>

      <ErrorNote error={res.error} retry={res.reload} />
      {res.loading && !res.data ? <Skeleton className="h-64" /> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {members.map((m, i) => (
            <Card key={m.id} i={i} className="flex flex-col gap-3 p-5">
              <div className="flex items-start gap-3">
                <Avatar name={m.display_name} src={m.avatar_url} size={44} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{m.display_name}</p>
                  <p className="truncate text-[13px] text-muted">{m.email}</p>
                </div>
                <Badge tone={m.role === 'viewer' ? 'low' : m.role === 'agent' ? 'open' : 'premium'}>{t(`role.${m.role}`)}</Badge>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {m.skills.map((s) => <span key={s} className="chip">{s}</span>)}
                {m.languages.map((l) => <span key={l} className="chip text-accent">{l.toUpperCase()}</span>)}
                {!m.skills.length && !m.languages.length && <span className="text-[13px] text-faint">{t('tm.noSkills')}</span>}
              </div>
              <div>
                <p className="mb-1.5 flex justify-between text-[12px] text-muted"><span>{t('tm.load')}</span><span>{t('tm.openCount', { n: m.open_tickets })}</span></p>
                <Meter value={Math.min(1, m.open_tickets / 12)} tone={m.open_tickets > 9 ? 'bad' : m.open_tickets > 6 ? 'warn' : 'good'} />
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                {m.role !== 'viewer' && can('agent') && <button className="btn h-8 px-3 text-[13px]" onClick={() => setCoach(m)}><Icon name="spark" size={14} /> {t('tm.coaching')}</button>}
                {can('admin') && <button className="btn btn-ghost h-8 px-3 text-[13px]" onClick={() => setEdit(m)}>{t('tm.edit')}</button>}
                {can('admin') && m.id !== me.user.id && <button className="btn btn-ghost btn-danger ml-auto h-8 px-2.5" onClick={() => remove(m)} aria-label={t('tm.remove')}><Icon name="trash" size={15} /></button>}
              </div>
            </Card>
          ))}
        </div>
      )}

      {invite && <Invite onClose={() => setInvite(false)} onDone={() => { setInvite(false); res.reload(); }} />}
      {edit && <EditMember m={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); res.reload(); }} />}
      {coach && <Coaching m={coach} onClose={() => setCoach(null)} />}
    </>
  );
}

function Invite({ onClose, onDone }) {
  const { t } = useT();
  const toast = useToast();
  const [f, setF] = useState({ email: '', role: 'agent' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await post('/members', f); toast(r.invited ? t('tm.invited') : t('tm.added')); onDone(); } catch (x) { setErr(x); } finally { setBusy(false); }
  }
  return (
    <Modal title={t('tm.invite')} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-[14px] text-muted">{t('tm.inviteHint')}</p>
        <Field label={t('common.email')}><input className="input" type="email" required autoFocus value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label={t('tm.role')}><select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.slice(0, 3).map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}</select></Field>
        {err && <p role="alert" className="text-[13px] text-bad">{errText(err)}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={busy}>{t('tm.send')}</button></div>
      </form>
    </Modal>
  );
}

function EditMember({ m, onClose, onDone }) {
  const { t } = useT();
  const { me } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ role: m.role, skills: m.skills.join(', '), languages: m.languages.join(', '), timezone: m.timezone });
  const [err, setErr] = useState(null);
  const roles = me.role === 'owner' ? ROLES : ROLES.slice(0, 3);
  async function submit(e) {
    e.preventDefault(); setErr(null);
    try { await patch(`/members/${m.id}`, { role: f.role, skills: csv(f.skills), languages: csv(f.languages).map((l) => l.toLowerCase()), timezone: f.timezone }); toast(t('tm.saved')); onDone(); } catch (x) { setErr(x); }
  }
  return (
    <Modal title={m.display_name} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('tm.role')}><select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} disabled={m.role === 'owner' && me.role !== 'owner'}>{roles.map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}</select></Field>
        <Field label={t('tm.skills')} hint={t('tm.skillsHint')}><input className="input" value={f.skills} onChange={(e) => setF({ ...f, skills: e.target.value })} /></Field>
        <Field label={t('tm.languages')} hint={t('tm.languagesHint')}><input className="input" value={f.languages} onChange={(e) => setF({ ...f, languages: e.target.value })} /></Field>
        <Field label={t('tm.timezone')} hint={t('tm.timezoneHint')}><input className="input" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></Field>
        {err && <p role="alert" className="text-[13px] text-bad">{errText(err)}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary">{t('common.save')}</button></div>
      </form>
    </Modal>
  );
}

const METRICS = [['averageWords', 'tm.m.words'], ['averageSentenceWords', 'tm.m.sentence'], ['medianFirstResponseMinutes', 'tm.m.frt']];

function Coaching({ m, onClose }) {
  const { t } = useT();
  const r = useResource(() => get(`/intel/agents/${m.id}/coaching`), [m.id]);
  const d = r.data;
  return (
    <Modal title={t('tm.coachingOf', { name: m.display_name })} onClose={onClose} wide>
      <p className="-mt-2 text-[13px] text-muted">{t('tm.coachingHint')}</p>
      {r.loading && <Spinner />}
      <ErrorNote error={r.error} retry={r.reload} />
      {d?.insufficientData && <p className="rounded-xl border border-line px-4 py-3 text-[14px] text-muted">{t('tm.coachingNone', { n: d.replies })}</p>}
      {d?.metrics && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            {METRICS.map(([k, label]) => (
              <div key={k} className="rounded-2xl border border-line p-4">
                <p className="eyebrow">{t(label)}</p>
                <p className="num mt-2 text-[30px] leading-none">{d.metrics[k] ?? '–'}</p>
                <p className="mt-1.5 text-[12px] text-muted">{t('tm.team', { n: d.team[k] ?? '–' })}</p>
              </div>
            ))}
          </div>
          <div>
            <p className="eyebrow mb-2">{t('tm.tips')}</p>
            {d.tips.length ? (
              <ul className="space-y-2">{d.tips.map((x) => <li key={x.code} className="flex gap-2.5 rounded-xl border border-warn/30 bg-warn/10 px-3.5 py-2.5 text-[14px]"><Icon name="spark" size={16} className="mt-0.5 shrink-0 text-warn" />{t(`tm.tip.${x.code}`, { n: x.value, team: x.team ?? '' })}</li>)}</ul>
            ) : <p className="rounded-xl border border-good/30 bg-good/10 px-4 py-3 text-[14px] text-good">{t('tm.noTips')}</p>}
          </div>
        </>
      )}
    </Modal>
  );
}
