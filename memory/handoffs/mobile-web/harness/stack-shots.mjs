// Screenshots of the Display shelf in its stacking states, on both rails and the phone, plus
// each shelf's measured size.
//   OUT=<build dir under this harness dir> DIR=<absolute shots dir> [ONLY=regex] [DARK=1] node stack-shots.mjs
// Writes DIR/<job>[-dark].png and DIR/measure[-dark].json.
import { chromium } from '/home/claude/dsul/node_modules/.pnpm/playwright@1.59.1/node_modules/playwright/index.mjs';
import { serve } from './serve.mjs';
import fs from 'node:fs';
const OUT = process.env.OUT ?? 'base-main';
const DIR = process.env.DIR ?? 'shots/stack';
const DARK = process.env.DARK === '1';
// LOOK=<theme slug>: stamps data-look-light (or data-look-dark with DARK=1) on <html>, as the app's boot script does.
const LOOK = process.env.LOOK ?? '';
const SUF = `${DARK ? '-dark' : ''}${LOOK ? '-' + LOOK : ''}`;
fs.mkdirSync(DIR, { recursive: true });
const { server, origin } = await serve(OUT);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const enc = (o) => encodeURIComponent(JSON.stringify(o));
const BD_THREE = enc({ braindumpGroupBy: 'project', braindumpFilters: { priorities: ['high'], containers: [], goals: [], hideFinished: true } });
const BD_ALL = enc({
  braindumpGroupBy: 'project', braindumpSortBy: 'priority',
  braindumpFilters: { priorities: ['high', 'medium'], containers: ['project:Work', 'project:Home'], goals: ['g1'], hideFinished: true },
});
const BD_STRESS = enc({
  braindumpGroupBy: 'project', braindumpSortBy: 'priority',
  braindumpFilters: { priorities: ['high', 'medium', 'low', 'none'], containers: ['project:Work', 'project:Home', 'project:Personal', 'project:Health', 'project:Wind-down'], goals: ['g1', 'g2'], hideFinished: true },
});
const CANVAS_STRESS = enc({
  typeFilter: 'tasks', canvasGroupBy: 'project', canvasSortBy: 'priority',
  canvasFilters: { priorities: ['high', 'medium', 'low', 'none'], containers: ['project:Work', 'project:Home', 'project:Personal', 'project:Health', 'project:Wind-down'], goals: ['g1', 'g2'], hideFinished: true },
});
// Canvas: s=1 one setting, s=2 two, s=7 three (group, type, hide finished), s=5 everything on.
// Braindump: three is group + one priority + hide finished; all is everything it has at once.
const JOBS = [
  { name: 'canvas-one', q: 'shell=desktop&scope=day&layout=list&s=1', w: 1440, h: 900, surface: 'canvas' },
  { name: 'canvas-two', q: 'shell=desktop&scope=day&layout=list&s=2', w: 1440, h: 900, surface: 'canvas' },
  { name: 'canvas-three', q: 'shell=desktop&scope=day&layout=list&s=7', w: 1440, h: 900, surface: 'canvas' },
  { name: 'canvas-all', q: 'shell=desktop&scope=day&layout=schedule&s=5', w: 1440, h: 900, surface: 'canvas' },
  { name: 'canvas-stress', q: `shell=desktop&scope=day&layout=schedule&st=${CANVAS_STRESS}`, w: 1440, h: 900, surface: 'canvas' },
  { name: 'bd406-three', q: `shell=desktop&scope=day&layout=list&sw=406&st=${BD_THREE}`, w: 1440, h: 900, surface: 'braindump' },
  { name: 'bd406-all', q: `shell=desktop&scope=day&layout=list&sw=406&st=${BD_ALL}`, w: 1440, h: 900, surface: 'braindump' },
  { name: 'bd280-three', q: `shell=desktop&scope=day&layout=list&sw=280&st=${BD_THREE}`, w: 1440, h: 900, surface: 'braindump' },
  { name: 'bd280-all', q: `shell=desktop&scope=day&layout=list&sw=280&st=${BD_ALL}`, w: 1440, h: 900, surface: 'braindump' },
  { name: 'bd280-stress', q: `shell=desktop&scope=day&layout=list&sw=280&st=${BD_STRESS}`, w: 1440, h: 900, surface: 'braindump' },
  { name: 'phone-three', q: 'shell=phone&scope=day&layout=list&s=7', w: 390, h: 844, phone: true, surface: 'canvas' },
  { name: 'phone-all', q: 'shell=phone&scope=day&layout=list&s=5', w: 390, h: 844, phone: true, surface: 'canvas' },
  { name: 'phonebd-all', q: `shell=phone&tab=braindump&st=${BD_ALL}`, w: 390, h: 844, phone: true, surface: 'braindump' },
];
const results = [];
for (const j of JOBS.filter((j) => !ONLY || ONLY.test(j.name))) {
  const page = await browser.newPage({ viewport: { width: j.w, height: j.h }, deviceScaleFactor: 2, hasTouch: !!j.phone, isMobile: !!j.phone, colorScheme: DARK ? 'dark' : 'light' });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(`${origin}/?${j.q}${DARK ? '&dark=1' : ''}`);
  if (LOOK) await page.evaluate(([attr, v]) => document.documentElement.setAttribute(attr, v), [DARK ? 'data-look-dark' : 'data-look-light', LOOK]);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(900);
  const box = await page.evaluate((surface) => {
    const shelf = [...document.querySelectorAll(`[data-testid="display-shelf-${surface}"]`)].find((el) => el.getBoundingClientRect().height > 0);
    if (!shelf) return null;
    const cap = shelf.parentElement.getBoundingClientRect();
    const s = shelf.getBoundingClientRect();
    return {
      capL: cap.left, capT: cap.top, capB: cap.bottom, capW: Math.round(cap.width * 10) / 10, capH: Math.round(cap.height * 10) / 10,
      shelfW: Math.round(s.width * 10) / 10, shelfH: Math.round(s.height * 10) / 10, fit: shelf.getAttribute('data-fit'),
      text: shelf.innerText.replace(/\s+/g, ' ').trim(),
    };
  }, j.surface);
  results.push({ name: j.name, ...box, errs });
  console.log(j.name.padEnd(14), box ? `shelf ${box.shelfW}x${box.shelfH} capsule ${box.capW}x${box.capH} fit=${box.fit}` : 'NO SHELF', errs.length ? 'ERR ' + errs.join(' | ').slice(0, 300) : '');
  if (!box) { await page.close(); continue; }
  let clip;
  if (j.phone) clip = { x: 0, y: 0, width: 390, height: Math.min(j.h, Math.ceil(box.capB + 110)) };
  else if (j.surface === 'canvas') clip = { x: Math.max(0, box.capL - 40), y: Math.max(0, box.capT - 24), width: 480, height: Math.ceil(box.capH + 24 + 90) };
  else clip = { x: Math.max(0, box.capL - 12), y: Math.max(0, box.capT - 12), width: Math.ceil(box.capW + 24), height: Math.ceil(box.capH + 12 + 120) };
  await page.screenshot({ path: `${DIR}/${j.name}${SUF}.png`, clip });
  await page.close();
}
fs.writeFileSync(`${DIR}/measure${SUF}.json`, JSON.stringify(results, null, 1));
await browser.close(); server.close();
