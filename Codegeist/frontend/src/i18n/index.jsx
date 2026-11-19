import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import fr from './fr.js';
import en from './en.js';
import es from './es.js';

// i18n sans dependance : dictionnaires plats, interpolation {nom}, pluriel via Intl.PluralRules (cle_one / cle_other).
const DICT = { fr, en, es };
export const LANGS = [
  { id: 'fr', short: 'FR', name: 'Français', locale: 'fr-FR' },
  { id: 'en', short: 'EN', name: 'English', locale: 'en-GB' },
  { id: 'es', short: 'ES', name: 'Español', locale: 'es-ES' },
];
const KEY = 'kairos.lang';

function detect() {
  try { const s = localStorage.getItem(KEY); if (DICT[s]) return s; } catch { /* stockage indisponible */ }
  const n = (typeof navigator !== 'undefined' ? navigator.language || 'fr' : 'fr').slice(0, 2).toLowerCase();
  return DICT[n] ? n : 'fr';
}

let current = detect();
export const getLang = () => current;
export const localeOf = () => LANGS.find((l) => l.id === current).locale;

/** Traduit hors composant (utilitaires). Dans un composant, preferer useT() pour se re-rendre au changement de langue. */
export function tr(key, params) {
  const d = DICT[current];
  let s = d[key];
  if (params && typeof params.n === 'number') {
    const k = `${key}_${new Intl.PluralRules(localeOf()).select(params.n)}`;
    if (d[k] != null) s = d[k];
    else if (DICT.fr[k] != null && d[key] == null) s = DICT.fr[k];
  }
  s ??= DICT.fr[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (m, k) => (params[k] ?? m)) : s;
}

const Ctx = createContext(null);
export const useT = () => useContext(Ctx);

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(current);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.querySelector('meta[name="description"]')?.setAttribute('content', tr('meta.description'));
  }, [lang]);
  const value = useMemo(() => ({
    lang,
    t: (k, p) => tr(k, p),
    setLang(l) {
      if (!DICT[l]) return;
      current = l;
      try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
      setLangState(l);
    },
  }), [lang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Selecteur de langue compact FR / EN / ES */
export function LangSwitch({ className = '' }) {
  const { lang, setLang } = useT();
  return (
    <div role="group" aria-label="Language" className={`inline-flex rounded-lg border border-line p-0.5 ${className}`}>
      {LANGS.map((l) => (
        <button key={l.id} type="button" onClick={() => setLang(l.id)} aria-pressed={lang === l.id} title={l.name} lang={l.id}
          className={`h-7 rounded-md px-2 text-[12px] font-semibold transition-colors ${lang === l.id ? 'bg-accent text-onaccent' : 'text-muted hover:text-ink'}`}>{l.short}</button>
      ))}
    </div>
  );
}

/**
 * Message d'erreur API, toujours dans la langue de l'interface : traduit par code d'erreur.
 * Le texte du serveur n'est jamais affiche tel quel (il est en francais) : un code inconnu donne un message generique.
 */
export function errText(err) {
  const k = `err.${err?.code}`;
  if (DICT.fr[k] != null) return tr(k);
  if (err instanceof TypeError) return tr('err.network'); // fetch() echoue : serveur injoignable
  return tr('err.generic');
}
