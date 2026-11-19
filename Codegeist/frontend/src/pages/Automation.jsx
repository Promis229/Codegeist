import { useState } from 'react';
import { del, get, post, put } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useResource } from '../lib/hooks.js';
import { errText, useT } from '../i18n/index.jsx';
import Icon from '../components/Icon.jsx';
import { Badge, Card, CardHead, Empty, ErrorNote, Field, Meter, Modal, PageHead, Skeleton, Spinner, pct, useToast } from '../components/ui.jsx';

const PRIO = ['critical', 'high', 'medium', 'low'];
const STATUS = ['open', 'pending', 'resolved', 'closed'];
const ACTIONS = ['set_priority', 'set_status', 'add_tag', 'assign', 'escalate', 'notify'];
const NUMERIC = new Set(['gt', 'gte', 'lt', 'lte']);
const LISTY = new Set(['in', 'containsAny']);
const fkey = (f) => f.replace('.', '_');

const blank = () => ({ name: '', priority: 100, enabled: true, mode: 'all', conds: [{ field: 'priority', op: 'eq', value: 'critical' }], actions: [{ type: 'add_tag', value: '' }] });

/** Un arbre « tout / un des / pas » vers la forme plate du constructeur ; null si la regle est trop riche pour lui. */
function flatten(cond) {
  const leaf = (c) => (c && c.field ? { field: c.field, op: c.op, value: Array.isArray(c.value) ? c.value.join(', ') : String(c.value) } : null);
  if (leaf(cond)) return { mode: 'all', conds: [leaf(cond)] };
  const mode = cond.all ? 'all' : cond.any ? 'any' : null;
  if (!mode) return null;
  const conds = cond[mode].map(leaf);
  return conds.every(Boolean) ? { mode, conds } : null;
}

function build(f) {
  const leaves = f.conds.map((c) => ({
    field: c.field, op: c.op,
    value: NUMERIC.has(c.op) ? Number(c.value) : LISTY.has(c.op) ? String(c.value).split(',').map((x) => x.trim()).filter(Boolean) : String(c.value),
  }));
  const actions = f.actions.map((a) => (a.type === 'escalate' ? { type: 'escalate' } : { type: a.type, value: a.value }));
  return { condition: { [f.mode]: leaves }, actions };
}

function describe(cond, t) {
  if (cond.field) return `${t(`au.field.${fkey(cond.field)}`)} ${t(`au.op.${cond.op}`)} ${Array.isArray(cond.value) ? cond.value.join(', ') : cond.value}`;
  if (cond.not) return `${t('au.not')} (${describe(cond.not, t)})`;
  const k = cond.all ? 'all' : 'any';
  return cond[k].map((c) => describe(c, t)).join(k === 'all' ? ` ${t('au.and')} ` : ` ${t('au.or')} `);
}

const ASSIGN_LABEL = { least_loaded: 'au.assign.least', lang_match: 'au.assign.lang' };
const actionValue = (a, t) => {
  if (a.type === 'set_priority') return t(`prio.${a.value}`);
  if (a.type === 'set_status') return t(`status.${a.value}`);
  if (a.type === 'assign' && ASSIGN_LABEL[a.value]) return t(ASSIGN_LABEL[a.value]);
  return a.value;
};
const actionText = (a, t) => (a.type === 'escalate' ? t('au.act.escalate') : `${t(`au.act.${a.type}`)} : ${actionValue(a, t)}`);

export default function Automation() {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const res = useResource(() => get('/rules'));
  const [editing, setEditing] = useState(null);

  async function toggle(r) {
    try { await put(`/rules/${r.id}`, { name: r.name, enabled: !r.enabled, priority: r.priority, condition: r.condition, actions: r.actions }); res.reload(); } catch (e) { toast(errText(e), 'bad'); }
  }
  async function remove(r) {
    if (!window.confirm(t('au.confirmDelete', { name: r.name }))) return;
    try { await del(`/rules/${r.id}`); toast(t('au.deleted')); res.reload(); } catch (e) { toast(errText(e), 'bad'); }
  }
  const rules = res.data?.rules ?? [];

  return (
    <>
      <PageHead eyebrow={t('au.eyebrow')} title={t('au.title')}>
        {can('admin') && <button className="btn btn-primary" onClick={() => setEditing({ ...blank() })}><Icon name="plus" size={16} /> {t('au.new')}</button>}
      </PageHead>
      <p className="rise mb-6 max-w-[70ch] text-[15px] text-muted" style={{ '--i': 2 }}>{t('au.intro')}</p>

      <ErrorNote error={res.error} retry={res.reload} />
      {res.loading && !res.data ? <Skeleton className="h-48" /> : rules.length ? (
        <div className="space-y-3">
          {rules.map((r, i) => (
            <Card key={r.id} i={i} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">{r.name} <Badge tone={r.enabled ? 'good' : 'low'}>{r.enabled ? t('au.active') : t('au.paused')}</Badge><span className="chip">{t('au.order', { n: r.priority })}</span></p>
                  <p className="mt-2 text-[14px] text-muted"><span className="eyebrow mr-2">{t('au.when')}</span>{describe(r.condition, t)}</p>
                  <p className="mt-1 text-[14px]"><span className="eyebrow mr-2">{t('au.then')}</span>{r.actions.map((a) => actionText(a, t)).join(' · ')}</p>
                </div>
                {can('admin') && (
                  <div className="flex items-center gap-1.5">
                    <button className="btn h-8 px-3 text-[13px]" onClick={() => toggle(r)}>{r.enabled ? t('au.pause') : t('au.resume')}</button>
                    {flatten(r.condition) && <button className="btn btn-ghost h-8 px-3 text-[13px]" onClick={() => setEditing({ id: r.id, name: r.name, priority: r.priority, enabled: r.enabled, ...flatten(r.condition), actions: r.actions.map((a) => ({ type: a.type, value: a.value ?? '' })) })}>{t('tm.edit')}</button>}
                    <button className="btn btn-ghost btn-danger h-8 px-2.5" onClick={() => remove(r)} aria-label={t('common.delete')}><Icon name="trash" size={15} /></button>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      ) : <Card><Empty icon="bolt" title={t('au.empty')}>{t('au.emptyText')}</Empty></Card>}

      {editing && <RuleEditor initial={editing} fields={res.data?.fields ?? []} ops={res.data?.operators ?? []} onClose={() => setEditing(null)} onDone={() => { setEditing(null); res.reload(); }} />}
    </>
  );
}

function RuleEditor({ initial, fields, ops, onClose, onDone }) {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const members = useResource(() => get('/members').catch(() => null));
  const [f, setF] = useState(initial);
  const [sim, setSim] = useState(null);
  const [simBusy, setSimBusy] = useState(false);
  const [err, setErr] = useState(null);
  const setCond = (i, k, v) => setF((p) => ({ ...p, conds: p.conds.map((c, j) => (j === i ? { ...c, [k]: v } : c)) }));
  const setAct = (i, k, v) => setF((p) => ({ ...p, actions: p.actions.map((a, j) => (j === i ? (k === 'type' ? { type: v, value: v === 'set_priority' ? 'high' : v === 'set_status' ? 'pending' : v === 'assign' ? 'least_loaded' : '' } : { ...a, [k]: v }) : a)) }));

  async function simulate() {
    setSimBusy(true); setErr(null); setSim(null);
    try { setSim(await post('/rules/simulate', { ...build(f), days: 30 })); } catch (e) { setErr(e); } finally { setSimBusy(false); }
  }
  async function save(e) {
    e.preventDefault(); setErr(null);
    const body = { name: f.name, enabled: f.enabled, priority: Number(f.priority), ...build(f) };
    try { await (f.id ? put(`/rules/${f.id}`, body) : post('/rules', body)); toast(t('au.saved')); onDone(); } catch (x) { setErr(x); }
  }

  const valueInput = (a, i) => {
    if (a.type === 'escalate') return <span className="text-[13px] text-muted">{t('au.escalateHint')}</span>;
    if (a.type === 'set_priority') return <select className="input !h-10" value={a.value} onChange={(e) => setAct(i, 'value', e.target.value)}>{PRIO.map((v) => <option key={v} value={v}>{t(`prio.${v}`)}</option>)}</select>;
    if (a.type === 'set_status') return <select className="input !h-10" value={a.value} onChange={(e) => setAct(i, 'value', e.target.value)}>{STATUS.map((v) => <option key={v} value={v}>{t(`status.${v}`)}</option>)}</select>;
    if (a.type === 'assign') return (
      <select className="input !h-10" value={a.value} onChange={(e) => setAct(i, 'value', e.target.value)}>
        <option value="least_loaded">{t('au.assign.least')}</option><option value="lang_match">{t('au.assign.lang')}</option>
        {members.data?.members?.filter((m) => m.role !== 'viewer').map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
      </select>
    );
    return <input className="input !h-10" required maxLength={a.type === 'add_tag' ? 40 : 60} placeholder={a.type === 'add_tag' ? t('au.tagPh') : t('au.eventPh')} value={a.value} onChange={(e) => setAct(i, 'value', e.target.value)} />;
  };

  return (
    <Modal title={f.id ? t('au.edit') : t('au.new')} onClose={onClose} wide>
      <form onSubmit={save} className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
          <Field label={t('au.name')}><input className="input" required maxLength={100} autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label={t('au.orderLabel')} hint={t('au.orderHint')}><input className="input" type="number" min={1} max={1000} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} /></Field>
        </div>

        <div className="space-y-2.5 rounded-2xl border border-line p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="eyebrow">{t('au.when')}</span>
            <select className="input !h-9 !w-auto text-[13px]" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} aria-label={t('au.mode')}><option value="all">{t('au.mode.all')}</option><option value="any">{t('au.mode.any')}</option></select>
          </div>
          {f.conds.map((c, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1.1fr_1fr_1.2fr_auto]">
              <select className="input !h-10" value={c.field} onChange={(e) => setCond(i, 'field', e.target.value)} aria-label={t('au.field')}>{fields.map((x) => <option key={x} value={x}>{t(`au.field.${fkey(x)}`)}</option>)}</select>
              <select className="input !h-10" value={c.op} onChange={(e) => setCond(i, 'op', e.target.value)} aria-label={t('au.operator')}>{ops.map((x) => <option key={x} value={x}>{t(`au.op.${x}`)}</option>)}</select>
              <input className="input !h-10" required type={NUMERIC.has(c.op) ? 'number' : 'text'} step="any" placeholder={LISTY.has(c.op) ? t('au.listPh') : t('au.valuePh')} value={c.value} onChange={(e) => setCond(i, 'value', e.target.value)} aria-label={t('au.value')} />
              <button type="button" className="btn btn-ghost h-10 w-10 !p-0" disabled={f.conds.length < 2} onClick={() => setF({ ...f, conds: f.conds.filter((_, j) => j !== i) })} aria-label={t('common.delete')}><Icon name="x" size={16} /></button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost h-8 text-[13px]" disabled={f.conds.length >= 20} onClick={() => setF({ ...f, conds: [...f.conds, { field: 'priority', op: 'eq', value: '' }] })}><Icon name="plus" size={14} /> {t('au.addCondition')}</button>
        </div>

        <div className="space-y-2.5 rounded-2xl border border-line p-4">
          <span className="eyebrow">{t('au.then')}</span>
          {f.actions.map((a, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
              <select className="input !h-10" value={a.type} onChange={(e) => setAct(i, 'type', e.target.value)} aria-label={t('au.action')}>{ACTIONS.map((x) => <option key={x} value={x}>{t(`au.act.${x}`)}</option>)}</select>
              <div className="flex items-center">{valueInput(a, i)}</div>
              <button type="button" className="btn btn-ghost h-10 w-10 !p-0" disabled={f.actions.length < 2} onClick={() => setF({ ...f, actions: f.actions.filter((_, j) => j !== i) })} aria-label={t('common.delete')}><Icon name="x" size={16} /></button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost h-8 text-[13px]" disabled={f.actions.length >= 10} onClick={() => setF({ ...f, actions: [...f.actions, { type: 'add_tag', value: '' }] })}><Icon name="plus" size={14} /> {t('au.addAction')}</button>
        </div>

        <div className="rounded-2xl border border-line p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><p className="font-semibold">{t('au.simulate')}</p><p className="text-[13px] text-muted">{t('au.simulateHint')}</p></div>
            <button type="button" className="btn" onClick={simulate} disabled={simBusy}>{simBusy ? <Spinner size={14} /> : <Icon name="pulse" size={16} />} {t('au.simulateRun')}</button>
          </div>
          {sim && (
            <div className="mt-4 space-y-3">
              <p className="text-[14px]">{t('au.simResult', { m: sim.matched, n: sim.examined })}</p>
              <Meter value={sim.matchRate} tone={sim.matchRate > 0.5 ? 'warn' : 'accent'} />
              <p className="text-[12px] text-faint">{t('au.simRate', { n: pct(sim.matchRate) })}</p>
              {sim.sample.length > 0 && (
                <ul className="max-h-48 divide-y divide-line overflow-auto text-[13px]">
                  {sim.sample.map((x) => <li key={x.id} className="flex items-center gap-3 py-2"><span className="font-semibold text-faint">{x.key}</span><span className="min-w-0 flex-1 truncate">{x.title}</span><span className="text-faint">{Object.keys(x.wouldChange).map((k) => t(`au.patch.${k}`)).join(', ')}</span></li>)}
                </ul>
              )}
            </div>
          )}
        </div>

        {err && <p role="alert" className="text-[13px] text-bad">{errText(err)}</p>}
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-[13px] text-muted"><input type="checkbox" className="accent-[var(--accent)]" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> {t('au.active')}</label>
          <div className="flex gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button>{can('admin') && <button className="btn btn-primary">{t('common.save')}</button>}</div>
        </div>
      </form>
    </Modal>
  );
}
