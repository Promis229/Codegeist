// Applique le thème avant le premier rendu (évite le flash). Fichier externe : la CSP interdit les scripts en ligne.
try {
  var t = localStorage.getItem('kairos.theme');
  if (!t) t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
} catch (e) { /* stockage indisponible : thème sombre par défaut */ }
