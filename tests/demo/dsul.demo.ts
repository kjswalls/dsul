import { LAYOUT_STORAGE_KEY } from '../../lib/layout-themes';
import { gotoApp, reloadApp } from '../e2e/helpers/app';
import { seedBraindump, seedDay, strike, type Cast } from './cast';
import { centre, closeUp, expect, glideClick, glideTo, hold, roll, test } from './stage';

/**
 * dsul's "something to show on screen" beats, from the series' raw material
 * (video-notes/what-im-working-on-raw-material.md, section 1). One test per
 * clip; the clip is named after the test.
 */

const cast: Cast = { taskIds: [], habitIds: [] };
test.afterEach(async ({ request }) => {
  await strike(request, cast);
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sign-in headlines', async ({ page }) => {
    await closeUp(page, 2);
    const headline = page.getByRole('heading', { level: 1 }).last();
    for (let i = 0; i < 6; i++) {
      await page.goto('/login');
      await expect(headline).toBeVisible();
      await centre(headline);
      roll(page);
      await hold(page, 1800);
    }
  });

  test('wordmark flavors', async ({ page }) => {
    await closeUp(page, 2.5);
    await page.goto('/login');
    const mark = page.getByRole('img', { name: 'dsul, do stuff unlimited' });
    await expect(mark).toBeVisible();
    await centre(mark);
    roll(page);
    await hold(page, 800);
    // Each hover opens the mark in a fresh flavor (lib/wordmark-flavors.ts).
    for (let i = 0; i < 5; i++) {
      await glideTo(page, mark, 20);
      await hold(page, 1600);
      await page.mouse.move(960, 900, { steps: 15 });
      await hold(page, 900);
    }
  });
});

test('power mode shuffle', async ({ page }) => {
  await seedBraindump(page, cast);
  await gotoApp(page);
  const start = page.getByTestId('do-stuff-start').locator('visible=true').first();
  await expect(start).toBeVisible();
  roll(page);
  await hold(page, 1500);

  await glideClick(page, start);
  const stop = page.getByTestId('do-stuff-stop').locator('visible=true').first();
  await expect(stop).toBeVisible();
  // The shuffle into lanes, then a slow look down them.
  await hold(page, 2500);
  const lanes = page.locator('[data-testid^="do-stuff-lane-"]:not([data-testid="do-stuff-lane-note"])');
  for (const lane of await lanes.locator('visible=true').all()) {
    await glideTo(page, lane.locator(':scope > *').first(), 25);
    await hold(page, 900);
  }
  await hold(page, 1500);
  await glideClick(page, stop);
  await hold(page, 1500);
});

test('layouts', async ({ page }) => {
  await seedDay(page, cast);
  await seedBraindump(page, cast);
  await gotoApp(page);
  roll(page);
  await hold(page, 2000);
  for (const layout of ['console', 'notebook', 'notepad-retro', 'writer', 'classic']) {
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [LAYOUT_STORAGE_KEY, layout]);
    await reloadApp(page);
    await expect(page.locator('[data-layout]').first()).toBeVisible();
    await hold(page, 2800);
  }
});
