import { useEffect, useState } from 'react';

// Service worker : uniquement en production (en développement il masquerait les modifications).
export function registerSW() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
      // Cherche une nouvelle version au retour sur l'application (application installée ouverte des jours durant).
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => { /* navigation privée ou politique du navigateur : l'application fonctionne sans */ });
  });
}

let deferred = null;
const listeners = new Set();
const emit = () => listeners.forEach((f) => f());
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; emit(); });
  window.addEventListener('appinstalled', () => { deferred = null; emit(); });
}

const standalone = () => typeof window !== 'undefined' && (matchMedia('(display-mode: standalone)').matches || navigator.standalone === true);
const isIos = () => typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);

/** État de l'installation : 'installed' | 'available' (bouton natif) | 'ios' (consigne manuelle) | 'unsupported'. */
export function useInstall() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((n) => n + 1); listeners.add(f); return () => listeners.delete(f); }, []);
  const status = standalone() ? 'installed' : deferred ? 'available' : isIos() ? 'ios' : 'unsupported';
  async function install() {
    if (!deferred) return false;
    const p = deferred; deferred = null; emit();
    await p.prompt();
    return (await p.userChoice).outcome === 'accepted';
  }
  return { status, install };
}
