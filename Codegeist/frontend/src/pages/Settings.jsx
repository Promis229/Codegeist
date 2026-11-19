import { useRef, useState } from 'react';
import { del, get, patch, post, put } from '../lib/api.js';
import { resizeToSquare } from '../lib/image.js';
import { useAuth } from '../lib/auth.jsx';
import { useResource } from '../lib/hooks.js';
import { useInstall } from '../lib/pwa.js';
import { LANGS, errText, useT } from '../i18n/index.jsx';
import Icon from '../components/Icon.jsx';
import { Avatar, Badge, Card, CardHead, ErrorNote, Field, PageHead, PasswordInput, Spinner, ago, fmtDate, useToast } from '../components/ui.jsx';

export default function Settings() {
  const { t } = useT();
  const { can } = useAuth();
  return (
    <>
      <PageHead eyebrow={t('st.eyebrow')} title={t('st.title')} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Profile />
        <InstallApp />
        <Password />
        <TwoFactor />
        <Sessions />
        {can('admin') && <ApiKeys />}
        {can('admin') && <Audit />}
      </div>
    </>
  );
}

function InstallApp() {
  const { t } = useT();
  const { status, install } = useInstall();
  const toast = useToast();
  return (
    <Card i={1}>
      <CardHead title={t('pwa.title')} hint={t('pwa.hint')} right={status === 'installed' ? <Badge tone="good">{t('pwa.installed')}</Badge> : null} />
      {status === 'available' && <button type="button" className="btn btn-primary" onClick={async () => { if (await install()) toast(t('pwa.done')); }}><Icon name="download" size={15} /> {t('pwa.install')}</button>}
      {status === 'ios' && <p className="text-[13.5px] leading-relaxed text-[var(--muted)]">{t('pwa.ios')}</p>}
      {status === 'unsupported' && <p className="text-[13.5px] leading-relaxed text-[var(--muted)]">{t('pwa.manual')}</p>}
    </Card>
  );
}

function Profile() {
  const { t, lang, setLang } = useT();
  const { me, reload } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(me.user.displayName);
  const fileInput = useRef(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    await patch('/auth/me', { displayName: name, locale: lang }).then(() => { reload(); toast(t('st.profileSaved')); }, (x) => toast(errText(x), 'bad'));
  }
  async function pickPhoto(e) {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/') || f.type === 'image/svg+xml') { toast(t('st.photoInvalid'), 'bad'); return; }
    setPhotoBusy(true);
    try { await put('/me/avatar', { data: await resizeToSquare(f) }); await reload(); toast(t('st.photoSaved')); }
    catch (x) { toast(x?.status ? errText(x) : t('st.photoInvalid'), 'bad'); } finally { setPhotoBusy(false); }
  }
  async function removePhoto() {
    setPhotoBusy(true);
    try { await del('/me/avatar'); await reload(); toast(t('st.photoRemoved')); } catch (x) { toast(errText(x), 'bad'); } finally { setPhotoBusy(false); }
  }
  return (
    <Card>
      <CardHead title={t('st.profile')} hint={me.user.email} />
      <div className="flex items-center gap-4 px-5 pt-4">
        <Avatar name={me.user.displayName} src={me.user.avatarUrl} size={72} />
        <div className="min-w-0">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn h-9 text-[13px]" onClick={() => fileInput.current?.click()} disabled={photoBusy}>{photoBusy ? <Spinner size={14} /> : <Icon name="plus" size={14} />} {t('st.photoUpload')}</button>
            {me.user.avatarUrl && <button type="button" className="btn btn-ghost btn-danger h-9 text-[13px]" onClick={removePhoto} disabled={photoBusy}>{t('st.photoRemove')}</button>}
          </div>
          <p className="mt-1.5 text-[12px] text-faint">{t('st.photoHint')}</p>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={pickPhoto} aria-label={t('st.photoUpload')} />
        </div>
      </div>
      <form onSubmit={save} className="space-y-4 p-5 pt-4">
        <Field label={t('st.displayName')}><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label={t('st.language')}><select className="input" value={lang} onChange={(e) => setLang(e.target.value)}>{LANGS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        <div className="flex items-center justify-between">
          <span className="flex gap-1.5">{me.identities.map((i) => <Badge key={i.provider} tone="low">{i.provider}</Badge>)}</span>
          <button className="btn btn-primary">{t('common.save')}</button>
        </div>
      </form>
    </Card>
  );
}

function Password() {
  const { t } = useT();
  const { me } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ current: '', next: '' });
  const [err, setErr] = useState(null);
  async function save(e) {
    e.preventDefault(); setErr(null);
    try { await post('/auth/password/change', me.hasPassword ? f : { next: f.next }); setF({ current: '', next: '' }); toast(t('st.pwChanged')); }
    catch (x) { setErr(x); }
  }
  return (
    <Card i={1}>
      <CardHead title={t('common.password')} hint={t('st.pwHint')} />
      <form onSubmit={save} className="space-y-4 p-5 pt-4">
        {me.hasPassword && <Field label={t('st.pwCurrent')}><PasswordInput autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required /></Field>}
        <Field label={t('auth.reset.new')} hint={t('auth.pwRule')}><PasswordInput autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required /></Field>
        {err && <p role="alert" className="text-[13px] text-bad">{errText(err)}</p>}
        <div className="flex justify-end"><button className="btn btn-primary">{t('st.pwChange')}</button></div>
      </form>
    </Card>
  );
}

function TwoFactor() {
  const { t } = useT();
  const { me, reload } = useAuth();
  const toast = useToast();
  const [step, setStep] = useState('idle'); // idle | setup | codes | disable
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [codes, setCodes] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function begin() { setBusy(true); try { setSetup(await post('/auth/2fa/setup')); setStep('setup'); } catch (x) { toast(errText(x), 'bad'); } finally { setBusy(false); } }
  async function enable(e) {
    e.preventDefault(); setErr(null);
    try { const r = await post('/auth/2fa/enable', { code }); setCodes(r.recoveryCodes); setStep('codes'); setCode(''); reload(); } catch (x) { setErr(x); }
  }
  async function disable(e) {
    e.preventDefault(); setErr(null);
    try { await post('/auth/2fa/disable', { code, ...(me.hasPassword ? { password: pw } : {}) }); toast(t('st.mfaOff')); setStep('idle'); setCode(''); setPw(''); reload(); }
    catch (x) { setErr(x); }
  }
  const codeField = (
    <Field label={t('st.code6')} error={err && errText(err)}><input className="input" inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required /></Field>
  );
  return (
    <Card i={2}>
      <CardHead title={t('st.mfa')} hint={t('st.mfaHint')} right={<Badge tone={me.user.totpEnabled ? 'good' : 'low'}>{me.user.totpEnabled ? t('st.on') : t('st.off')}</Badge>} />
      <div className="space-y-4 p-5 pt-4">
        {step === 'idle' && (me.user.totpEnabled
          ? <button className="btn btn-danger" onClick={() => { setErr(null); setStep('disable'); }}>{t('st.disable')}</button>
          : <button className="btn btn-primary" onClick={begin} disabled={busy}>{busy ? <Spinner size={14} /> : <Icon name="shield" size={16} />} {t('st.enable')}</button>)}
        {step === 'disable' && (
          <form onSubmit={disable} className="space-y-3">
            {me.hasPassword && <Field label={t('common.password')}><PasswordInput autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></Field>}
            {codeField}
            <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={() => setStep('idle')}>{t('common.cancel')}</button><button className="btn btn-danger">{t('st.disableMfa')}</button></div>
          </form>
        )}
        {step === 'setup' && setup && (
          <form onSubmit={enable} className="space-y-3">
            <p className="text-[14px] text-muted">{t('st.mfaSetup')}</p>
            <code className="block select-all break-all rounded-xl border border-line bg-bg/40 p-3 text-[13px]">{setup.secret}</code>
            <a className="inline-flex items-center gap-1.5 text-[13px] text-accent hover:underline" href={setup.otpauthUri}><Icon name="link" size={14} /> {t('st.openApp')}</a>
            {codeField}
            <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={() => setStep('idle')}>{t('common.cancel')}</button><button className="btn btn-primary">{t('common.confirm')}</button></div>
          </form>
        )}
        {step === 'codes' && (
          <div className="space-y-3">
            <p className="rounded-xl border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-[13px] text-warn">{t('st.recoveryWarn')}</p>
            <ul className="grid grid-cols-2 gap-2 font-mono text-[13px]">{codes.map((c) => <li key={c} className="rounded-lg border border-line px-3 py-1.5">{c}</li>)}</ul>
            <button className="btn" onClick={() => { navigator.clipboard.writeText(codes.join('\n')); toast(t('st.codesCopied')); }}><Icon name="copy" size={14} /> {t('common.copy')}</button>
            <button className="btn btn-primary ml-2" onClick={() => setStep('idle')}>{t('st.noted')}</button>
          </div>
        )}
      </div>
    </Card>
  );
}

function Sessions() {
  const { t } = useT();
  const toast = useToast();
  const r = useResource(() => get('/auth/sessions'));
  return (
    <Card i={3}>
      <CardHead title={t('st.sessions')} hint={t('st.sessionsHint')} />
      <ErrorNote error={r.error} retry={r.reload} />
      <ul className="p-3">
        {r.data?.sessions.map((s) => (
          <li key={s.id} className="row-hover flex items-center gap-3 rounded-xl px-3 py-2.5">
            <Icon name="clock" className="shrink-0 text-faint" />
            <span className="min-w-0 flex-1"><span className="block truncate text-[14px]">{s.user_agent || t('st.unknownDevice')}</span><span className="text-[12px] text-muted">{s.ip} · {t('st.opened', { when: ago(s.created_at) })}</span></span>
            <button className="btn btn-ghost btn-danger h-8 px-2.5 text-[13px]" onClick={() => del(`/auth/sessions/${s.id}`).then(() => { toast(t('st.sessionClosed')); r.reload(); })}>{t('st.close')}</button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ApiKeys() {
  const { t } = useT();
  const toast = useToast();
  const r = useResource(() => get('/api-keys'));
  const [name, setName] = useState('');
  const [scope, setScope] = useState('write');
  const [fresh, setFresh] = useState(null);
  async function create(e) {
    e.preventDefault();
    try { const k = await post('/api-keys', { name, scopes: [scope] }); setFresh(k); setName(''); r.reload(); } catch (x) { toast(errText(x), 'bad'); }
  }
  return (
    <Card i={4}>
      <CardHead title={t('st.keys')} hint={t('st.keysHint')} />
      <form onSubmit={create} className="flex gap-2 p-5 pt-4"><input className="input !h-10" placeholder={t('st.keyName')} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /><select className="input !h-10 !w-auto text-[13px]" value={scope} onChange={(e) => setScope(e.target.value)} aria-label={t('st.scope')}><option value="read">{t('st.scopeRead')}</option><option value="write">{t('st.scopeWrite')}</option><option value="admin">{t('st.scopeAdmin')}</option></select><button className="btn btn-primary">{t('common.create')}</button></form>
      {fresh && (
        <div className="mx-5 mb-3 rounded-xl border border-warn/40 bg-warn/10 p-4 text-[13px]">
          <p className="mb-2 font-semibold text-warn">{t('st.keyCopy')}</p>
          <code className="block select-all break-all rounded-lg bg-bg/50 p-2.5">{fresh.key}</code>
        </div>
      )}
      <ul className="p-3 pt-0">
        {r.data?.keys?.filter((k) => !k.revoked_at).map((k) => (
          <li key={k.id} className="row-hover flex items-center gap-3 rounded-xl px-3 py-2.5">
            <Icon name="key" className="shrink-0 text-faint" />
            <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{k.name}</span><span className="text-[12px] text-muted">{k.prefix ?? ''} · {(k.scopes || []).map((s) => t(`st.scope_${s}`)).join(', ')}</span></span>
            <button className="btn btn-ghost btn-danger h-8 px-2.5 text-[13px]" onClick={() => del(`/api-keys/${k.id}`).then(() => { toast(t('st.keyRevoked')); r.reload(); })}>{t('st.revoke')}</button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Audit() {
  const { t } = useT();
  const r = useResource(async () => ({ log: await get('/audit'), chain: await get('/audit/verify').catch(() => null) }));
  const rows = r.data?.log?.entries ?? [];
  return (
    <Card i={5}>
      <CardHead title={t('st.audit')} hint={t('st.auditHint')}
        right={r.data?.chain && <Badge tone={r.data.chain.valid ? 'good' : 'bad'}>{r.data.chain.valid ? t('st.chainOk', { n: r.data.chain.checked }) : t('st.chainBroken', { n: r.data.chain.brokenAt })}</Badge>} />
      <ul className="max-h-[320px] divide-y divide-line overflow-auto p-3">
        {rows.slice(0, 40).map((e) => (
          <li key={e.id} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]"><span className="font-medium">{e.action}</span><span className="text-faint">{fmtDate(e.created_at)}</span></li>
        ))}
      </ul>
    </Card>
  );
}
