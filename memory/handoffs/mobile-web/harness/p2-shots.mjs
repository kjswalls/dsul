import { chromium } from '/home/claude/dsul/node_modules/.pnpm/playwright@1.59.1/node_modules/playwright/index.mjs';
import { serve } from './serve.mjs';
import fs from 'node:fs';
const DIR = process.env.DIR; fs.mkdirSync(DIR, { recursive: true });
const { server, origin } = await serve('p2');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const JOBS = [
  ['schedule-comfy', 'layout=schedule'], ['schedule-compact', 'layout=schedule&density=compact'],
  ['buckets-comfy', 'layout=buckets'], ['buckets-compact', 'layout=buckets&density=compact'],
  ['list-comfy', 'layout=list&s=1'], ['list-compact', 'layout=list&s=1&density=compact'],
  ['schedule-compact-dark', 'layout=schedule&density=compact&dark=1', true], ['buckets-compact-dark', 'layout=buckets&density=compact&dark=1', true],
  ['sheet', 'layout=schedule&sheet=1&dark=1', true],
];
for (const [name, q, dark] of JOBS) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: dark ? 'dark' : 'light' });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${origin}/?shell=phone&${q}`);
  await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(1000);
  await page.screenshot({ path: `${DIR}/${name}.png` });
  if (errs.length) console.log(name, errs.slice(0, 2));
  await page.close();
}
await browser.close(); server.close();
