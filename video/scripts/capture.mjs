// Captures the real application (stills and short screen recordings) for the demo video.
// Usage: CHROME=<chrome-headless-shell> APP_URL=http://localhost:8080 node scripts/capture.mjs [only-step-name]
// Writes go through the LOCAL stack so the public demo workspace is never polluted.
import { chromium } from 'playwright-core';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

const BASE = process.env.APP_URL ?? 'http://localhost:8080';
const SHOTS = new URL('../public/shots/', import.meta.url).pathname;
const CLIPS = new URL('../public/clips/', import.meta.url).pathname;
const TMP = '/tmp/kairos-clip/';
const ONLY = process.argv[2];
mkdirSync(SHOTS, { recursive: true }); mkdirSync(CLIPS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox', '--force-color-profile=srgb'] });
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const CLIPBOX = { width: 1440, height: 900 };
const MOBILE = { viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const TABLET = { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

async function context(opts, { lang = 'en', theme = 'dark', video = false } = {}) {
  const c = await browser.newContext({ ...opts, ...(video ? { deviceScaleFactor: opts.isMobile ? 2 : 1 } : {}), colorScheme: theme, reducedMotion: 'no-preference' });
  await c.addInitScript(([l, t]) => { try { localStorage.setItem('kairos.lang', l); localStorage.setItem('kairos.theme', t); } catch { /* ignore */ } }, [lang, theme]);
  if (video) {
    const np = c.newPage.bind(c);
    c.newPage = async () => { const p = await np(); c._rec = await startRec(c, p); return p; };
  }
  return c;
}
async function startRec(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async (e) => { frames.push({ data: e.data, ts: e.metadata.timestamp }); await cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {}); });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
  return { cdp, frames };
}
async function demo(page) {
  await page.goto(`${BASE}/demo`, { waitUntil: 'load' });
  await page.waitForURL((u) => !/\/(demo|login|welcome)/.test(u.pathname), { timeout: 30000 });
  await sleep(1800);
}
async function login(page, email, password = 'Kairos-Demo-2026!') {
  await page.goto(`${BASE}/login`, { waitUntil: 'load' });
  await page.locator('input[type=email]').first().fill(email);
  await page.locator('input[type=password]').first().fill(password);
  await page.locator('button[type=submit]').first().click();
}
const shot = (page, name, { full = false } = {}) => page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: full });
async function go(page, path, wait = 2200) { await page.goto(`${BASE}${path}`, { waitUntil: 'load' }); await sleep(wait); }
async function endClip(page, ctx, name) {
  await sleep(600);
  const { cdp, frames } = ctx._rec;
  await cdp.send('Page.stopScreencast').catch(() => {});
  rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true });
  let list = '';
  frames.forEach((f, i) => {
    const n = String(i).padStart(5, '0');
    writeFileSync(`${TMP}f${n}.jpg`, Buffer.from(f.data, 'base64'));
    const next = frames[i + 1]?.ts ?? f.ts + 0.1;
    list += `file 'f${n}.jpg'\nduration ${Math.max(0.01, next - f.ts).toFixed(4)}\n`;
  });
  list += `file 'f${String(frames.length - 1).padStart(5, '0')}.jpg'\n`;
  writeFileSync(`${TMP}list.txt`, list);
  await ctx.close();
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', `${TMP}list.txt`, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', `${CLIPS}${name}.mp4`]);
  rmSync(TMP, { recursive: true, force: true });
  console.log(`     ${name}: ${frames.length} frames`);
}
async function slowType(page, locator, text, delay = 70) { await locator.click(); await locator.pressSequentially(text, { delay }); }
async function glide(page, y0, y1, ms) {
  const steps = Math.round(ms / 40);
  for (let i = 0; i <= steps; i++) { const t = i / steps; const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; await page.evaluate((y) => window.scrollTo(0, y), y0 + (y1 - y0) * e); await sleep(40); }
}

const steps = {
  async stills() {
    const c = await context(DESKTOP); const p = await c.newPage();
    // public pages
    await go(p, '/welcome', 2500); await shot(p, 'landing-0');
    for (const [i, y] of [[1, 900], [2, 1800], [3, 2700], [4, 3600], [5, 4500], [6, 5400], [7, 6300]]) { await p.evaluate((v) => window.scrollTo(0, v), y); await sleep(900); await shot(p, `landing-${i}`); }
    await go(p, '/login', 1500); await shot(p, 'login');
    await go(p, '/register', 1500); await shot(p, 'register');
    await demo(p);
    for (const [name, path] of [['dashboard', '/'], ['tickets', '/tickets'], ['copilot', '/copilot'], ['intelligence', '/intelligence'], ['knowledge', '/knowledge'], ['messages', '/messages'], ['customers', '/customers'], ['team', '/team'], ['automation', '/automation'], ['integrations', '/integrations'], ['settings', '/settings']]) {
      await go(p, path, 3000); await shot(p, name);
      if (['dashboard', 'intelligence', 'settings'].includes(name)) { await p.evaluate(() => window.scrollTo(0, 900)); await sleep(900); await shot(p, `${name}-2`); }
    }
    await c.close();
  },
  async ticket() {
    const c = await context(DESKTOP); const p = await c.newPage();
    await demo(p); await go(p, '/tickets', 2800);
    await p.getByText(/ACM-\d+/).locator('visible=true').first().click(); await sleep(3800); await shot(p, 'ticket');
    await p.evaluate(() => window.scrollTo(0, 800)); await sleep(900); await shot(p, 'ticket-2');
    await c.close();
  },
  async abstain() {
    const c = await context(DESKTOP); const p = await c.newPage();
    await login(p, 'nina@acme.test'); await sleep(3500); await go(p, '/copilot', 1800);
    await p.locator('textarea').first().fill('What is the weather in Paris tomorrow?');
    await p.getByRole('button', { name: /find an answer/i }).click(); await sleep(7000); await shot(p, 'copilot-abstain');
    await p.locator('textarea').first().fill('My customer cannot log in to his account');
    await p.getByRole('button', { name: /find an answer/i }).click(); await sleep(9000); await shot(p, 'copilot-answer');
    await p.evaluate(() => window.scrollTo(0, 450)); await sleep(900); await shot(p, 'copilot-answer-2');
    await c.close();
  },
  async owner() {
    // Admin-only pages (integrations, API keys, audit log) need the organization owner.
    const c = await context(DESKTOP); const p = await c.newPage();
    await login(p, 'demo@kairos.dev'); await sleep(3500);
    await go(p, '/integrations', 3000); await shot(p, 'integrations');
    await go(p, '/settings', 3000); await shot(p, 'settings');
    await p.evaluate(() => window.scrollTo(0, 1100)); await sleep(1000); await shot(p, 'settings-2');
    await c.close();
  },
  async light() {
    const c = await context(DESKTOP, { theme: 'light' }); const p = await c.newPage();
    await go(p, '/welcome', 2500); await shot(p, 'landing-light');
    await demo(p); await go(p, '/', 3000); await shot(p, 'dashboard-light'); await go(p, '/tickets', 2500); await shot(p, 'tickets-light');
    await c.close();
  },
  async languages() {
    for (const lang of ['fr', 'es', 'en']) {
      const c = await context(DESKTOP, { lang }); const p = await c.newPage();
      await demo(p); await go(p, '/', 3000); await shot(p, `dashboard-${lang}`); await go(p, '/messages', 3000); await shot(p, `messages-${lang}`);
      await c.close();
    }
  },
  async mobile() {
    const c = await context(MOBILE); const p = await c.newPage();
    await go(p, '/welcome', 2500); await shot(p, 'm-landing');
    await demo(p);
    for (const [name, path] of [['m-dashboard', '/'], ['m-tickets', '/tickets'], ['m-copilot', '/copilot'], ['m-messages', '/messages'], ['m-knowledge', '/knowledge'], ['m-intelligence', '/intelligence']]) { await go(p, path, 2800); await shot(p, name); }
    await go(p, '/', 2200); await p.locator('button[aria-label]').first().click().catch(() => {}); await sleep(900); await shot(p, 'm-menu');
    await c.close();
    const t = await context(TABLET); const q = await t.newPage();
    await demo(q); await go(q, '/', 3000); await shot(q, 't-dashboard'); await go(q, '/tickets', 2500); await shot(q, 't-tickets');
    await t.close();
  },
  async clipLanding() {
    const c = await context(DESKTOP, { video: true }); const p = await c.newPage();
    await go(p, '/welcome', 3500);
    const h = await p.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    await glide(p, 0, Math.min(h, 5200), 12000); await sleep(800);
    await endClip(p, c, 'landing');
  },
  async clipCopilot() {
    const c = await context(DESKTOP, { video: true }); const p = await c.newPage();
    await login(p, 'nina@acme.test'); await sleep(3500); await go(p, '/copilot', 1800);
    await slowType(p, p.locator('textarea').first(), 'My customer cannot log in to his account', 55);
    await sleep(500); await p.getByRole('button', { name: /find an answer/i }).click();
    await sleep(6500);
    await p.evaluate(() => window.scrollTo(0, 420)); await sleep(2500);
    await endClip(p, c, 'copilot');
  },
  async clipSearch() {
    const c = await context(DESKTOP, { video: true }); const p = await c.newPage();
    await demo(p); await go(p, '/', 1500);
    const s = p.locator('input[type=search]').first();
    await slowType(p, s, 'paiement', 110); await sleep(2200);
    await s.fill(''); await sleep(500); await slowType(p, s, 'incid', 110); await sleep(2200);
    await s.fill(''); await sleep(400); await slowType(p, s, 'sofia', 110); await sleep(2400);
    await endClip(p, c, 'search');
  },
  async clipChat() {
    const c = await context(DESKTOP, { video: true }); const p = await c.newPage();
    await demo(p); await go(p, '/messages', 2500);
    await p.getByText('incidents', { exact: false }).first().click().catch(() => {}); await sleep(1800);
    const msgs = p.locator('[class*="bubble"], [data-msg], article, li').filter({ hasText: /Spike in payment|Same symptom|grouping/ });
    const target = msgs.first();
    await target.click({ button: 'right' }).catch(() => {}); await sleep(1500);
    await p.getByRole('menuitem', { name: /reply/i }).first().click().catch(() => {}); await sleep(800);
    const box = p.locator('textarea').last();
    await slowType(p, box, 'On it: I am attaching the 502 logs now.', 45); await sleep(600);
    await p.keyboard.press('Enter'); await sleep(2500);
    await endClip(p, c, 'chat');
  },
  async clipMobile() {
    const c = await context(MOBILE, { video: true }); const p = await c.newPage();
    await demo(p); await go(p, '/', 2500);
    await glide(p, 0, 700, 3000); await sleep(500); await glide(p, 700, 0, 1200);
    await p.locator('button[aria-label]').first().click().catch(() => {}); await sleep(1800);
    await p.keyboard.press('Escape').catch(() => {}); await go(p, '/copilot', 2500);
    await go(p, '/messages', 2500);
    await endClip(p, c, 'mobile');
  },
  async clipLang() {
    const c = await context(DESKTOP, { video: true, size: CLIPBOX, lang: 'fr' }); const p = await c.newPage();
    await demo(p); await go(p, '/messages', 3200);
    for (const code of ['EN', 'ES', 'FR', 'EN']) { await p.getByRole('button', { name: new RegExp(`^${code}$`) }).first().click().catch(() => {}); await sleep(2600); }
    await endClip(p, c, 'language');
  },
  async clipTheme() {
    const c = await context(DESKTOP, { video: true, size: CLIPBOX, theme: 'dark' }); const p = await c.newPage();
    await go(p, '/welcome', 3000);
    for (let i = 0; i < 2; i++) { await p.locator('button[aria-label="Switch theme"]').first().click().catch(() => {}); await sleep(2600); }
    await endClip(p, c, 'theme');
  },
  async twofa() {
    // Throw-away use of a seeded agent account, restored by re-seeding afterwards (see the video README).
    const c = await context(DESKTOP); const p = await c.newPage();
    await login(p, 'chen@kairos.dev'); await sleep(2500);
    await go(p, '/settings', 2500);
    await p.getByRole('button', { name: /^turn on$/i }).first().click(); await sleep(1500);
    const secret = (await p.locator('code').first().innerText()).replace(/\s/g, '');
    await shot(p, 'twofa-setup');
    const totp = (s) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const ch of s.toUpperCase()) bits += A.indexOf(ch).toString(2).padStart(5, '0'); const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2))); const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000))); const h = createHmac('sha1', key).update(ctr).digest(); const o = h[19] & 15; return String(((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6).padStart(6, '0'); };
    await p.locator('input[inputmode="numeric"], input[autocomplete="one-time-code"]').first().fill(totp(secret));
    await p.getByRole('button', { name: /confirm|activate|turn on|enable/i }).last().click(); await sleep(2000);
    await shot(p, 'twofa-codes');
    await c.close();
    const c2 = await context(DESKTOP); const q = await c2.newPage();
    await login(q, 'chen@kairos.dev'); await sleep(2500); await shot(q, 'twofa-login');
    await q.locator('input').first().fill(totp(secret)); await sleep(500);
    await c2.close();
  },
};

const order = ['stills', 'ticket', 'abstain', 'owner', 'light', 'languages', 'mobile', 'clipLanding', 'clipCopilot', 'clipSearch', 'clipChat', 'clipMobile', 'clipLang', 'clipTheme', 'twofa'];
for (const name of order) {
  if (ONLY && ONLY !== name) continue;
  const t0 = Date.now();
  try { await steps[name](); console.log(`ok   ${name} (${Math.round((Date.now() - t0) / 1000)}s)`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}: ${String(e.message).split('\n')[0]}`); }
}
await browser.close();
if (failures.length) console.log('failed steps:', failures.join(', '));
