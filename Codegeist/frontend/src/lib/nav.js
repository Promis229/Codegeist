// Écrans de l'application : source unique pour le menu et pour la recherche globale.
// `min` : rôle minimal pour voir l'écran (le serveur refuse de toute façon les appels non autorisés).
// `kw` : clé de dictionnaire des mots-clés en plus du nom (la recherche « mot de passe » mène à Réglages, par exemple).
export const NAV = [
  { to: '/', key: 'nav.today', kw: 'nav.kw.today', icon: 'today', end: true },
  { to: '/tickets', key: 'nav.tickets', kw: 'nav.kw.tickets', icon: 'ticket' },
  { to: '/messages', key: 'nav.messages', kw: 'nav.kw.messages', icon: 'chat', badge: true },
  { to: '/customers', key: 'nav.customers', kw: 'nav.kw.customers', icon: 'building' },
  { to: '/copilot', key: 'nav.copilot', kw: 'nav.kw.copilot', icon: 'spark' },
  { to: '/intelligence', key: 'nav.intel', kw: 'nav.kw.intel', icon: 'pulse' },
  { to: '/knowledge', key: 'nav.kb', kw: 'nav.kw.kb', icon: 'book' },
  { to: '/automation', key: 'nav.automation', kw: 'nav.kw.automation', icon: 'bolt', min: 'agent' },
  { to: '/team', key: 'nav.team', kw: 'nav.kw.team', icon: 'users' },
  { to: '/integrations', key: 'nav.integrations', kw: 'nav.kw.integrations', icon: 'plug', min: 'admin' },
  { to: '/settings', key: 'nav.settings', kw: 'nav.kw.settings', icon: 'gear' },
];

/** Minuscules sans accents : « Réglages » et « reglages » se valent. */
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
