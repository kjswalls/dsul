// One-line widths of each clause and value on the shelf, in px, measured in the real build.
import { chromium } from '/home/claude/dsul/node_modules/.pnpm/playwright@1.59.1/node_modules/playwright/index.mjs';
import { serve } from './serve.mjs';
const OUT = process.env.OUT ?? 'base-main';
const { server, origin } = await serve(OUT);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${origin}/?shell=desktop&scope=day&layout=schedule&s=5`);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(800);
const r = await page.evaluate(() => {
  const shelf = document.querySelector('[data-testid="display-shelf-canvas"]');
  shelf.dataset.fit = 'line';
  const w = (el) => Math.round(el.getBoundingClientRect().width * 10) / 10;
  const out = {};
  for (const c of shelf.querySelectorAll('[data-clause]')) {
    out[c.dataset.clause] = { clause: w(c), values: [...c.querySelectorAll('[data-value]')].map((v) => [v.textContent, w(v)]) };
  }
  const x = shelf.querySelector('[data-shelf-remove]');
  out.removeBtn = w(x);
  const lines = [...shelf.querySelectorAll('[data-line]')];
  out.oneLine = Math.round(lines[lines.length - 1].getBoundingClientRect().right - lines[0].getBoundingClientRect().left);
  const lab = shelf.querySelector('[data-clause="group"] [data-chip-label]');
  out.groupLabel = w(lab);
  // words alone
  const span = document.createElement('span');
  span.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:500 11px/18px var(--font-sans, Inter)';
  shelf.appendChild(span);
  const meas = {};
  for (const t of ['Grouped by Project', 'Project', 'Sorted by Priority', 'Priority', 'Showing Tasks', 'Tasks', 'Tasks only', 'Hide finished', 'High', 'Medium', 'Work', 'Home', 'Learn Chinese', 'By project', 'Priority first', 'No finished', 'Finished hidden', '+3', '3 filters', 'Clear', 'Reset']) {
    span.textContent = t; meas[t] = w(span);
  }
  out.words = meas;
  out.font = getComputedStyle(lab).font;
  return out;
});
console.log(JSON.stringify(r, null, 1));
await browser.close(); server.close();
