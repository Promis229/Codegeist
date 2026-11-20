import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../components/Logo.jsx';
import { LangSwitch, useT } from '../i18n/index.jsx';

const SECTIONS = 10;
/** Page de contact des demandes de confidentialite et d'assistance (le depot du projet). */
const CONTACT_URL = 'https://github.com/Promis229/Codegeist/issues';

/** Un bloc "a\nb\n- c\n- d" devient des paragraphes et des listes. */
function Body({ text }) {
  const blocks = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('- ')) {
      const last = blocks[blocks.length - 1];
      if (last?.list) last.items.push(line.slice(2));
      else blocks.push({ list: true, items: [line.slice(2)] });
    } else blocks.push({ list: false, text: line });
  }
  return blocks.map((b, i) => b.list
    ? <ul key={i} className="mt-3 list-disc space-y-1.5 pl-5">{b.items.map((it, j) => <li key={j}>{it}</li>)}</ul>
    : <p key={i} className="mt-3">{b.text}</p>);
}

/** Politique de confidentialite (doc="privacy") et conditions d'utilisation (doc="terms") : pages publiques, dans les trois langues. */
export default function Legal({ doc }) {
  const { t } = useT();
  useEffect(() => { window.scrollTo(0, 0); document.title = `${t(`legal.${doc}.title`)} · Kairos`; return () => { document.title = 'Kairos'; }; }, [doc, t]);
  const other = doc === 'privacy' ? 'terms' : 'privacy';
  return (
    <div className="relative min-h-screen px-5 py-8 sm:px-8">
      <div className="aura" aria-hidden="true" />
      <div className="mx-auto max-w-[760px]">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <Link to="/" aria-label={t('legal.back')}><Logo size={28} /></Link>
          <LangSwitch />
        </header>
        <main className="mt-12">
          <p className="eyebrow">{t('legal.updated')}</p>
          <h1 className="mt-3 font-serif text-[40px] leading-tight tracking-tight sm:text-[52px]" style={{ fontVariationSettings: '"opsz" 144, "SOFT" 50' }}>{t(`legal.${doc}.title`)}</h1>
          <p className="mt-5 text-[16px] leading-relaxed text-muted">{t(`legal.${doc}.intro`)}</p>
          <div className="mt-10 space-y-9">
            {Array.from({ length: SECTIONS }, (_, i) => i + 1).map((n) => (
              <section key={n}>
                <h2 className="font-serif text-[24px] tracking-tight">{n}. {t(`legal.${doc}.s${n}.h`)}</h2>
                <div className="text-[15px] leading-relaxed text-muted"><Body text={t(`legal.${doc}.s${n}.p`)} /></div>
              </section>
            ))}
          </div>
          <div className="glass mt-12 rounded-2xl p-5">
            <p className="eyebrow">{t('legal.contact.label')}</p>
            <a href={CONTACT_URL} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block font-semibold text-accent underline underline-offset-4">{t('legal.contact.link')}</a>
          </div>
        </main>
        <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 text-[13px] text-faint">
          <Link to="/" className="hover:text-ink">{t('legal.back')}</Link>
          <Link to={`/${other}`} className="hover:text-ink">{t(`legal.nav.${other}`)}</Link>
        </footer>
      </div>
    </div>
  );
}
