/* Kairos — service worker.
 * - Coquille de l'application disponible hors ligne (page d'accueil + page « hors ligne »).
 * - Fichiers /assets/ (noms à empreinte, immuables) : cache d'abord.
 * - Navigations : réseau d'abord, repli sur la coquille en cache, puis sur la page hors ligne.
 * - L'API (/api/) n'est JAMAIS mise en cache : aucune donnée de support ni jeton ne se retrouve sur le disque.
 */
const VERSION = 'v2';
const SHELL = `kairos-shell-${VERSION}`;
const ASSETS = `kairos-assets-${VERSION}`;
const MAX_ASSETS = 150;
const PRECACHE = ['/', '/offline.html', '/offline.js', '/icon-192.png', '/favicon.svg', '/theme.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (![SHELL, ASSETS].includes(k)) await caches.delete(k);
    // Le préchargement de navigation envoyait chaque requête DEUX fois (même aux redirections OAuth, dont le code est à usage unique) : désactivé.
    if (self.registration.navigationPreload) await self.registration.navigationPreload.disable().catch(() => {});
    await self.clients.claim();
  })());
});

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function navigate(event) {
  try {
    const res = await fetch(event.request);
    if (res.ok && res.type === 'basic') {
      // Seules les pages publiques de la coquille sont gardées (la page est la même pour tous : c'est l'application React).
      const c = await caches.open(SHELL); await c.put('/', res.clone());
    }
    return res;
  } catch {
    const c = await caches.open(SHELL);
    return (await c.match('/')) || (await c.match('/offline.html')) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // réseau uniquement

  if (req.mode === 'navigate') { event.respondWith(navigate(event)); return; }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const c = await caches.open(ASSETS);
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { c.put(req, res.clone()).then(() => trim(c, MAX_ASSETS)).catch(() => {}); }
      return res;
    })());
    return;
  }

  if (PRECACHE.includes(url.pathname) || /\.(?:png|jpg|svg|webmanifest)$/.test(url.pathname)) {
    event.respondWith((async () => {
      const c = await caches.open(SHELL);
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
  }
});

self.addEventListener('message', (event) => { if (event.data === 'skipWaiting') self.skipWaiting(); });
