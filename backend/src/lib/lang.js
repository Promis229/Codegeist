// Langue demandee par l'interface (en-tete X-Lang : fr, en ou es). Sert a afficher dans la langue de l'utilisateur les contenus
// qui existent en plusieurs versions (donnees de demonstration, messages d'equipe d'amorce). Absent ou inconnu : texte d'origine.
export const LANGS = ['fr', 'en', 'es'];
export const reqLang = (req) => {
  const h = String(req.headers['x-lang'] ?? '').toLowerCase().slice(0, 2);
  return LANGS.includes(h) ? h : null;
};
/** Version de `fallback` dans `lang` si `i18n` ({ fr, en, es }) la contient, sinon `fallback`. */
export const loc = (i18n, lang, fallback) => (lang && i18n && typeof i18n === 'object' && i18n[lang]) || fallback;
