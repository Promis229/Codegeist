import { lazy } from 'react';

/**
 * Après un déploiement, un onglet resté ouvert connaît encore les anciens noms de fichiers de pages (ils portent un hash) :
 * charger une page qu'il n'a pas encore visitée échoue. On recharge alors l'application UNE fois, automatiquement, pour récupérer
 * la nouvelle version. Le garde-fou évite toute boucle si le problème venait d'ailleurs (réseau coupé, par exemple).
 */
const KEY = 'kairos.reload';
const WINDOW_MS = 15_000;

export const isChunkError = (e) => /dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk|Unable to preload CSS|reading 'default'/i.test(String(e?.message ?? e));

/** Recharge une seule fois dans la fenêtre de temps ; renvoie true si un rechargement a été lancé. */
export function reloadOnce() {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < WINDOW_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch { /* stockage indisponible : on recharge quand même, une fois par appel */ }
  window.location.reload();
  return true;
}

/** Équivalent de React.lazy qui se répare tout seul quand la page demandée n'existe plus sur le serveur. */
export function lazyPage(factory) {
  return lazy(() => factory().catch((e) => {
    if (isChunkError(e) && reloadOnce()) return new Promise(() => {}); // la page se recharge : on n'affiche rien entre-temps
    throw e;
  }));
}
