import { chromium } from '/home/claude/dsul/node_modules/.pnpm/playwright@1.59.1/node_modules/playwright/index.mjs';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 2000, height: 1000 }, deviceScaleFactor: 2 });
await p.goto('file://' + process.cwd() + '/boards.html'); await p.evaluate(() => document.fonts.ready);
for (const id of await p.$$eval('.phone', (els) => els.map((e) => e.id))) await p.locator('#' + id).screenshot({ path: `shots/${id}.png`, omitBackground: true });
for (const id of ['b1','b2','b3','b4','b5']) await p.locator('#' + id).screenshot({ path: `shots/${id}.png` });
await b.close();
