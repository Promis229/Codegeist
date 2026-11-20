import { createRequire } from 'node:module';
const require = createRequire('/home/promis/Codegeist/video/package.json');
const { chromium } = require('playwright-core');
const exe = process.env.CHROME || '/home/promis/G-WEB-500-COT-5-1-dashboard-9/video/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell';
const b = await chromium.launch({ executablePath: exe });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
for (const n of [1, 2]) {
  await p.goto(`file:///home/promis/Codegeist/video/youtube/thumb-${n}.html`);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(500);
  await p.screenshot({ path: `/home/promis/Codegeist/video/youtube/thumbnail-${n}.png` });
}
await b.close();
