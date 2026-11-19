import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { BASE, ApiError, get, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useResource, useTheme } from '../lib/hooks.js';
import { LangSwitch, errText, useT } from '../i18n/index.jsx';
import { Logo, Mark } from '../components/Logo.jsx';
import Icon from '../components/Icon.jsx';
import { Field, PasswordInput, Spinner } from '../components/ui.jsx';

/** Coque commune : panneau editorial a gauche, formulaire en verre a droite. */
function Shell({ title, subtitle, children, footer }) {
  const { t } = useT();
  const [theme, toggle] = useTheme();
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <aside className="relative hidden overflow-hidden border-r border-line lg:flex lg:flex-col lg:justify-between lg:p-12">
        <Link to="/welcome" aria-label="Kairos"><Logo size={34} /></Link>
        <div className="relative">
          <div className="pointer-events-none absolute left-[230px] top-[-340px] opacity-80" style={{ maskImage: 'linear-gradient(to right, transparent 0%, #000 38%)', WebkitMaskImage: 'linear-gradient(to right, transparent 0%, #000 38%)' }}>
            <Dial />
          </div>
          <p className="eyebrow rise" style={{ '--i': 1 }}>{t('auth.side.eyebrow')}</p>
          <h2 className="rise mt-4 max-w-[15ch] font-serif text-[58px] leading-[1.02] tracking-tight" style={{ '--i': 2, fontVariationSettings: '"opsz" 144, "SOFT" 40' }}>
            {t('auth.side.t1')} <em className="text-accent" style={{ fontStyle: 'italic' }}>{t('auth.side.t2')}</em>.
          </h2>
          <p className="rise mt-5 max-w-md text-[16px] text-muted" style={{ '--i': 3 }}>{t('auth.side.text')}</p>
        </div>
        <ul className="rise grid grid-cols-3 gap-6 text-[13px] text-muted" style={{ '--i': 4 }}>
          <li><span className="num block text-[28px] text-ink">48</span>{t('auth.side.s1')}</li>
          <li><span className="num block text-[28px] text-ink">0</span>{t('auth.side.s2')}</li>
          <li><span className="num block text-[28px] text-ink">2FA</span>{t('auth.side.s3')}</li>
        </ul>
      </aside>

      <main className="relative flex flex-col px-5 py-6 sm:px-10">
        <div className="flex items-center justify-between lg:justify-end lg:gap-2">
          <Link to="/welcome" className="lg:hidden" aria-label="Kairos"><Logo size={28} /></Link>
          <div className="flex items-center gap-2">
            <LangSwitch />
            <button onClick={toggle} className="btn btn-ghost h-9 w-9 !p-0" aria-label={t('common.theme')}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
          </div>
        </div>
        {/* my-auto : centré quand il y a de la place, sinon la page défile normalement (plus de carte repoussée vers le bas) */}
        <div className="mx-auto my-auto w-full max-w-[440px] py-4">
          <Link to="/welcome" className="rise mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><Icon name="arrow" size={14} className="rotate-180" />{t('auth.backHome')}</Link>
          <div className="glass-xl rise p-6 sm:p-8">
            <h1 className="font-serif text-[30px] leading-tight tracking-tight" style={{ fontVariationSettings: '"opsz" 96, "SOFT" 50' }}>{title}</h1>
            {subtitle && <p className="mt-1.5 text-[14px] text-muted">{subtitle}</p>}
            <div className="mt-6">{children}</div>
          </div>
          {footer && <p className="rise mt-5 text-center text-[14px] text-muted" style={{ '--i': 2 }}>{footer}</p>}
        </div>
      </main>
    </div>
  );
}

/** Grand cadran solaire decoratif : graduations, gnomon, ombre qui avance. */
function Dial() {
  const ticks = Array.from({ length: 60 }, (_, i) => i);
  return (
    <svg width="560" height="560" viewBox="-140 -140 280 280" fill="none" aria-hidden="true">
      <g className="dial-ring" style={{ transformOrigin: '0 0', animationDuration: '240s' }}>
        {ticks.map((i) => {
          const a = (i / 60) * Math.PI * 2, big = i % 5 === 0, r1 = big ? 112 : 118, r2 = 124;
          return <line key={i} x1={Math.cos(a) * r1} y1={Math.sin(a) * r1} x2={Math.cos(a) * r2} y2={Math.sin(a) * r2} stroke="var(--accent)" strokeOpacity={big ? 0.55 : 0.22} strokeWidth={big ? 1.6 : 1} strokeLinecap="round" />;
        })}
      </g>
      <circle r="96" stroke="var(--accent)" strokeOpacity=".16" />
      <circle r="62" stroke="var(--accent)" strokeOpacity=".1" />
      <g style={{ transformOrigin: '0 0', animation: 'sweep 18s ease-in-out infinite alternate' }}>
        <path d="M0 0 L0 0 L88 62 L110 88 L40 88 Z" fill="var(--text)" fillOpacity=".05" />
        <line x1="0" y1="0" x2="104" y2="74" stroke="var(--text)" strokeOpacity=".3" strokeWidth="2" strokeLinecap="round" />
      </g>
      <line x1="0" y1="0" x2="0" y2="-78" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
      <circle r="5" fill="var(--accent-2)" />
    </svg>
  );
}

/** Champ code a 6 chiffres : un champ par chiffre, collage et fleches gerees. */
function CodeInput({ value, onChange, autoFocus }) {
  const { t } = useT();
  const refs = useRef([]);
  const set = (i, d) => {
    const arr = value.padEnd(6, ' ').split('');
    arr[i] = d || ' ';
    onChange(arr.join('').replace(/ +$/, ''));
  };
  return (
    <div className="flex justify-between gap-2" onPaste={(e) => {
      const txt = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
      if (txt) { e.preventDefault(); onChange(txt); refs.current[Math.min(txt.length, 5)]?.focus(); }
    }}>
      {Array.from({ length: 6 }, (_, i) => (
        <input key={i} ref={(el) => (refs.current[i] = el)} className="input !h-14 !w-full text-center font-serif !text-[24px] !px-0"
          inputMode="numeric" autoComplete={i === 0 ? 'one-time-code' : 'off'} maxLength={1} autoFocus={autoFocus && i === 0}
          aria-label={t('auth.digit', { n: i + 1 })} value={(value[i] ?? '').trim()}
          onChange={(e) => { const d = e.target.value.replace(/\D/g, '').slice(-1); set(i, d); if (d && i < 5) refs.current[i + 1]?.focus(); }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !value[i] && i > 0) refs.current[i - 1]?.focus();
            if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
            if (e.key === 'ArrowRight' && i < 5) refs.current[i + 1]?.focus();
          }} />
      ))}
    </div>
  );
}

function Submit({ busy, children }) {
  return <button type="submit" className="btn btn-primary mt-2 w-full !h-12 text-[15px]" disabled={busy}>{busy ? <Spinner size={16} /> : children}</button>;
}
const FormError = ({ msg }) => msg ? <p role="alert" className="rounded-xl border border-bad/40 bg-bad/10 px-3.5 py-2.5 text-[13px] text-bad">{msg}</p> : null;

/** Logo Google officiel (4 couleurs, indépendant du thème). */
const GoogleLogo = () => (
  <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true" className="shrink-0">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);
/** Marque GitHub : prend la couleur du texte, donc lisible en thème clair comme sombre. */
const GithubLogo = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0" fill="currentColor">
    <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
  </svg>
);
const LOGO = { google: GoogleLogo, github: GithubLogo };

function OAuthButtons() {
  const { t } = useT();
  const { data } = useResource(() => get('/auth/providers', { auth: false }), []);
  const on = (data?.providers ?? []).filter((p) => p.enabled);
  if (!on.length && !data?.demo) return null;
  const label = { google: 'Google', github: 'GitHub' };
  return (
    <>
      <div className="my-5 flex items-center gap-3 text-[12px] text-faint"><span className="h-px flex-1 bg-line" />{t('auth.or')}<span className="h-px flex-1 bg-line" /></div>
      <div className="grid gap-2.5">
        {on.map((p) => {
          const Logo = LOGO[p.name];
          return (
            <a key={p.name} className="btn !h-11 gap-3" href={`${BASE}/auth/oauth/${p.name}/start`}>{Logo && <Logo />}{t('auth.continueWith', { p: label[p.name] })}</a>
          );
        })}
        {data?.demo && <Link to="/demo" className="btn !h-11 border-accent/40 text-accent">{t('auth.demo.link')}</Link>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Connexion
export function Login() {
  const { t } = useT();
  const { completeLogin } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [f, setF] = useState({ email: '', password: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const dest = loc.state?.from || '/';

  async function submit(e) {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const r = mfa
        ? await post('/auth/login/mfa', { mfaToken: mfa, ...(useRecovery ? { recoveryCode: code } : { code }) }, { auth: false })
        : await post('/auth/login', f, { auth: false });
      if (r.mfaRequired) { setMfa(r.mfaToken); setCode(''); return; }
      await completeLogin(r);
      nav(dest, { replace: true });
    } catch (ex) {
      if (ex instanceof ApiError && ex.code === 'email_not_verified') return nav('/verify', { state: { email: ex.details?.email ?? f.email } });
      setErr(ex);
    } finally { setBusy(false); }
  }

  if (mfa) {
    return (
      <Shell title={t('auth.mfa.title')} subtitle={useRecovery ? t('auth.mfa.recoverySub') : t('auth.mfa.sub')}
        footer={<button className="underline decoration-line2 underline-offset-4 hover:text-ink" onClick={() => { setMfa(null); setCode(''); }}>{t('common.back')}</button>}>
        <form onSubmit={submit} className="space-y-4">
          {useRecovery
            ? <Field label={t('auth.mfa.recoveryCode')}><input className="input" value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="off" /></Field>
            : <CodeInput value={code} onChange={setCode} autoFocus />}
          <FormError msg={err && errText(err)} />
          <Submit busy={busy}>{t('common.validate')}</Submit>
          <button type="button" className="w-full text-center text-[13px] text-muted hover:text-ink" onClick={() => { setUseRecovery(!useRecovery); setCode(''); }}>
            {useRecovery ? t('auth.mfa.useApp') : t('auth.mfa.useRecovery')}
          </button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell title={t('auth.login.title')} subtitle={t('auth.login.sub')} footer={<>{t('auth.login.noAccount')} <Link to="/register" className="font-semibold text-accent hover:underline">{t('auth.login.create')}</Link></>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('common.email')}><input className="input" type="email" autoComplete="email" required autoFocus value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder={t('auth.emailPh')} /></Field>
        <Field label={t('common.password')}><PasswordInput autoComplete="current-password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <div className="text-right"><Link to="/forgot" className="text-[13px] text-muted hover:text-ink">{t('auth.forgotLink')}</Link></div>
        <FormError msg={err && errText(err)} />
        <Submit busy={busy}>{t('auth.login.submit')}</Submit>
      </form>
      <OAuthButtons />
    </Shell>
  );
}

// ---------------------------------------------------------------- Inscription
export function Register() {
  const { t } = useT();
  const nav = useNavigate();
  const [f, setF] = useState({ displayName: '', email: '', password: '', orgName: '' });
  const [err, setErr] = useState(null);
  const [issues, setIssues] = useState({});
  const [busy, setBusy] = useState(false);
  const up = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault(); setErr(null); setIssues({}); setBusy(true);
    try {
      const body = { ...f }; if (!body.orgName.trim()) delete body.orgName;
      const r = await post('/auth/register', body, { auth: false });
      nav('/verify', { state: { email: r.email } });
    } catch (ex) {
      if (ex.issues) setIssues(Object.fromEntries(ex.issues.map((i) => [i.path, errText({ code: 'validation_error' })])));
      else setErr(ex);
    } finally { setBusy(false); }
  }
  return (
    <Shell title={t('auth.reg.title')} subtitle={t('auth.reg.sub')} footer={<>{t('auth.reg.have')} <Link to="/login" className="font-semibold text-accent hover:underline">{t('auth.reg.login')}</Link></>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('auth.reg.name')} error={issues.displayName}><input className="input" required autoFocus autoComplete="name" value={f.displayName} onChange={up('displayName')} /></Field>
        <Field label={t('auth.reg.email')} error={issues.email}><input className="input" type="email" required autoComplete="email" value={f.email} onChange={up('email')} /></Field>
        <Field label={t('common.password')} hint={t('auth.pwRule')} error={issues.password}><PasswordInput required autoComplete="new-password" value={f.password} onChange={up('password')} /></Field>
        <Field label={t('auth.reg.org')} error={issues.orgName}><input className="input" value={f.orgName} onChange={up('orgName')} placeholder={t('auth.reg.orgPh')} /></Field>
        <FormError msg={err && errText(err)} />
        <Submit busy={busy}>{t('auth.reg.submit')}</Submit>
      </form>
      <OAuthButtons />
    </Shell>
  );
}

// ---------------------------------------------------------------- Code email
export function Verify() {
  const { t } = useT();
  const { state } = useLocation();
  const { completeLogin } = useAuth();
  const nav = useNavigate();
  const email = state?.email;
  const [code, setCode] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [cool, setCool] = useState(30);

  useEffect(() => { if (cool <= 0) return; const id = setTimeout(() => setCool(cool - 1), 1000); return () => clearTimeout(id); }, [cool]);
  useEffect(() => { if (code.length === 6 && !busy) submit(); /* envoi auto au 6e chiffre */ }, [code]); // eslint-disable-line

  if (!email) return <Shell title={t('auth.ver.missingTitle')} footer={<Link to="/login" className="text-accent">{t('auth.backToLogin')}</Link>}><p className="text-muted">{t('auth.ver.missing')}</p></Shell>;

  async function submit(e) {
    e?.preventDefault(); setErr(null); setBusy(true);
    try { const r = await post('/auth/verify-email', { email, code }, { auth: false }); await completeLogin(r); nav('/', { replace: true }); }
    catch (ex) { setErr(ex); setCode(''); }
    finally { setBusy(false); }
  }
  async function resend() {
    setErr(null);
    try { await post('/auth/verify-email/resend', { email }, { auth: false }); setSent(true); setCool(30); }
    catch (e) { setErr(e); } // ex. e-mail non configuré : on le dit, on ne fait pas semblant d'avoir envoyé
  }
  return (
    <Shell title={t('auth.ver.title')} subtitle={t('auth.ver.sub', { email })}
      footer={<Link to="/login" className="hover:text-ink">{t('auth.backToLogin')}</Link>}>
      <form onSubmit={submit} className="space-y-5">
        <CodeInput value={code} onChange={setCode} autoFocus />
        <FormError msg={err && errText(err)} />
        <Submit busy={busy}>{t('common.confirm')}</Submit>
        <p className="text-center text-[13px] text-muted">
          {sent && cool > 0 ? `${t('auth.ver.sent')} ` : ''}
          {cool > 0 ? t('auth.ver.wait', { n: cool }) : <button type="button" className="font-semibold text-accent hover:underline" onClick={resend}>{t('auth.ver.resend')}</button>}
        </p>
      </form>
    </Shell>
  );
}

// ---------------------------------------------------------------- Mot de passe oublie / reinitialisation
export function Forgot() {
  const { t } = useT();
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e) { e.preventDefault(); setBusy(true); await post('/auth/password/forgot', { email }, { auth: false }).catch(() => {}); setDone(true); setBusy(false); }
  return (
    <Shell title={t('auth.forgot.title')} subtitle={t('auth.forgot.sub')} footer={<Link to="/login" className="hover:text-ink">{t('auth.backToLogin')}</Link>}>
      {done ? <p className="rounded-xl border border-good/40 bg-good/10 px-4 py-3 text-[14px] text-good">{t('auth.forgot.done')}</p> : (
        <form onSubmit={submit} className="space-y-4">
          <Field label={t('common.email')}><input className="input" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Submit busy={busy}>{t('auth.forgot.submit')}</Submit>
        </form>
      )}
    </Shell>
  );
}

export function Reset() {
  const { t } = useT();
  const [q] = useSearchParams();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setErr(null); setBusy(true);
    try { await post('/auth/password/reset', { token: q.get('token') || '', password }, { auth: false }); nav('/login', { replace: true }); }
    catch (ex) { setErr(ex); } finally { setBusy(false); }
  }
  return (
    <Shell title={t('auth.reset.title')} subtitle={t('auth.reset.sub')}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('auth.reset.new')} hint={t('auth.pwRule')}><PasswordInput required autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <FormError msg={err && errText(err)} />
        <Submit busy={busy}>{t('common.save')}</Submit>
      </form>
    </Shell>
  );
}

// ---------------------------------------------------------------- Entrée démo (si le serveur l'autorise)
export function DemoEntry() {
  const { t } = useT();
  const { completeLogin } = useAuth();
  const nav = useNavigate();
  const [err, setErr] = useState(null);
  useEffect(() => {
    post('/auth/demo', {}, { auth: false }).then((r) => completeLogin(r)).then(() => nav('/', { replace: true }), (e) => setErr(e));
  }, []); // eslint-disable-line
  return (
    <div className="grid min-h-screen place-items-center px-5">
      {err ? <div className="text-center"><p className="text-bad">{errText(err)}</p><Link to="/login" className="mt-3 inline-block text-accent">{t('auth.backToLogin')}</Link></div>
        : <div className="flex items-center gap-3 text-muted"><Mark size={28} /> {t('auth.demo.progress')}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Retour OAuth (jetons dans le fragment)
export function OAuthCallback() {
  const { t } = useT();
  const { completeLogin } = useAuth();
  const nav = useNavigate();
  const [err, setErr] = useState(null);
  const done = useRef(false);
  useEffect(() => {
    // Une seule exécution : en développement React exécute l'effet DEUX fois ; la seconde ne retrouve plus le fragment
    // (déjà effacé) et affichait « connexion refusée » en rouge une fraction de seconde avant la redirection réussie.
    if (done.current) return;
    done.current = true;
    const p = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname); // efface les jetons de la barre d'adresse
    if (!p.get('access')) return setErr({ code: p.get('error') || 'oauth_refused' }); // le backend renvoie un code d'erreur dans le fragment
    completeLogin({ accessToken: p.get('access'), refreshToken: p.get('refresh') }).then(() => nav('/', { replace: true }), (e) => setErr(e));
  }, []); // eslint-disable-line
  return (
    <div className="grid min-h-screen place-items-center">
      {err ? <div className="text-center"><p className="text-bad">{errText(err)}</p><Link to="/login" className="mt-3 inline-block text-accent">{t('common.back')}</Link></div> : <div className="flex items-center gap-3 text-muted"><Mark size={28} /> {t('auth.oauth.progress')}</div>}
    </div>
  );
}
