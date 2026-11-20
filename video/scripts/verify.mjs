// End-to-end smoke test of the PRODUCTION site: every page x 3 languages x desktop/phone, PWA, console errors, horizontal overflow.
import { chromium } from 'playwright-core';

const BASE = process.env.APP_URL ?? 'https://kairos-web-pi-lilac.vercel.app';
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox'] });
const ROUTES = ['/', '/tickets', '/copilot', '/intelligence', '/knowledge', '/messages', '/customers', '/team', '/automation', '/integrations', '/settings'];
const KEY_TEXT = { fr: /Aujourd|Demandes|Messages|Clients/i, en: /Today|Requests|Messages|Customers/i, es: /Hoy|Solicitudes|Mensajes|Clientes/i };
const devices = { desktop: { viewport: { width: 1440, height: 900 } }, phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, tablet: { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true } };
let fails = 0, checks = 0;
const bad = (m) => { fails++; console.log('FAIL', m); };

for (const [dname, dev] of Object.entries(devices)) {
  for (const lang of ['fr', 'en', 'es']) {
    const ctx = await browser.newContext({ ...dev, serviceWorkers: 'allow' });
    await ctx.addInitScript((l) => { try { localStorage.setItem('kairos.lang', l); } catch { /* ignore */ } }, lang);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource: the server responded with a status of (401|404)/.test(m.text())) errors.push('console ' + m.text().slice(0, 120)); });
    await page.goto(`${BASE}/demo`, { waitUntil: 'load' });
    await page.waitForURL((u) => !/\/(demo|login|welcome)/.test(u.pathname), { timeout: 40000 }).catch(() => bad(`${dname}/${lang}: demo login`));
    for (const r of ROUTES) {
      checks++;
      await page.goto(`${BASE}${r}`, { waitUntil: 'load' });
      await page.waitForTimeout(1500);
      const info = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, crash: !!document.body.innerText.match(/Something went wrong|Algo salió mal|Un problème est survenu|Cannot read/i), text: document.body.innerText.length }));
      if (info.over > 2) bad(`${dname}/${lang}${r}: horizontal overflow ${info.over}px`);
      if (info.crash) bad(`${dname}/${lang}${r}: error screen`);
      if (info.text < 80) bad(`${dname}/${lang}${r}: nearly empty page`);
    }
    // language really applied
    const body = await page.evaluate(() => document.body.innerText);
    if (dname === 'desktop' && !KEY_TEXT[lang].test(body)) bad(`desktop/${lang}: UI text not in ${lang}`);
    if (errors.length) bad(`${dname}/${lang}: ${[...new Set(errors)].slice(0, 3).join(' | ')}`);
    await ctx.close();
    console.log(`ok   ${dname}/${lang}`);
  }
}

// PWA
const ctx = await browser.newContext({ ...devices.desktop });
const p = await ctx.newPage();
await p.goto(`${BASE}/welcome`, { waitUntil: 'load' }); await p.waitForTimeout(4000);
const pwa = await p.evaluate(async () => {
  const m = await fetch('/manifest.webmanifest').then((r) => r.json());
  const reg = await navigator.serviceWorker.getRegistration();
  const icons = await Promise.all(m.icons.filter((i) => i.type === 'image/png').map((i) => fetch(i.src).then((r) => r.ok)));
  const off = await fetch('/offline.html').then((r) => r.ok);
  return { name: m.name, display: m.display, start: m.start_url, icons: icons.every(Boolean), sw: reg?.active?.state, offline: off, apple: !!document.querySelector('link[rel=apple-touch-icon]') };
});
checks++;
if (pwa.name !== 'Kairos' || pwa.display !== 'standalone' || !pwa.icons || pwa.sw !== 'activated' || !pwa.offline || !pwa.apple) bad('PWA ' + JSON.stringify(pwa)); else console.log('ok   PWA', JSON.stringify(pwa));
// offline navigation falls back to the cached shell / offline page
await ctx.setOffline(true);
await p.goto(`${BASE}/tickets`, { waitUntil: 'load' }).catch(() => {});
const offText = await p.evaluate(() => document.body.innerText.slice(0, 120)).catch(() => '');
checks++;
if (offText.length < 5) bad('offline: nothing rendered'); else console.log('ok   offline fallback:', JSON.stringify(offText.slice(0, 60)));
await ctx.close();
await browser.close();
console.log(`${checks} checks, ${fails} failure(s)`);
process.exit(fails ? 1 : 0);
