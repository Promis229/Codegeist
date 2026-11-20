// Checks that the installed PWA still opens without a network (cached app shell, or the offline page).
import { chromium } from 'playwright-core';

const BASE = process.env.APP_URL ?? 'https://kairos-web-pi-lilac.vercel.app';
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/welcome`, { waitUntil: 'load' });
await page.waitForTimeout(3000);
await page.reload({ waitUntil: 'load' }); // first reload: the worker now controls the page
await page.waitForTimeout(2500);
const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
const cached = await page.evaluate(async () => { const out = []; for (const k of await caches.keys()) out.push(k + ':' + (await (await caches.open(k)).keys()).length); return out; });
console.log('controlled:', controlled, 'caches:', cached.join(' '));
await ctx.setOffline(true);
for (const path of ['/tickets', '/welcome']) {
  const r = await page.goto(`${BASE}${path}`, { waitUntil: 'load' }).catch((e) => ({ err: e.message.split('\n')[0] }));
  await page.waitForTimeout(1500);
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 90)).catch(() => '');
  console.log(path, r && r.err ? 'NAV ERROR ' + r.err : 'status ' + (r && r.status ? r.status() : 'sw'), '|', JSON.stringify(text));
}
await browser.close();
