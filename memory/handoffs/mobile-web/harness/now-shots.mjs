import { chromium } from '/home/claude/dsul/node_modules/.pnpm/playwright@1.59.1/node_modules/playwright/index.mjs';
import { serve } from './serve.mjs';
import fs from 'node:fs';
const DIR = process.env.DIR; fs.mkdirSync(DIR, { recursive: true });
const { server, origin } = await serve('cur');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const JOBS = [
  ['now-buckets', 'shell=phone&layout=buckets'],
  ['now-list', 'shell=phone&layout=list&s=1'],
  ['now-schedule', 'shell=phone&layout=schedule'],
  ['now-braindump', 'shell=phone&tab=braindump'],
  ['now-switcher', 'shell=phone&layout=buckets', async (p) => { await p.getByRole('button', { name: /switch|surface|mode|today/i }).last().click().catch(()=>{}); }],
];
for (const [name, q, act] of JOBS) for (const dark of [false, true]) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: dark ? 'dark' : 'light' });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${origin}/?${q}${dark ? '&dark=1' : ''}`);
  await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(900);
  if (act) { await act(page); await page.waitForTimeout(700); }
  await page.screenshot({ path: `${DIR}/${name}${dark ? '-dark' : ''}.png` });
  if (errs.length) console.log(name, errs.slice(0, 2));
  await page.close();
}
await browser.close(); server.close();
