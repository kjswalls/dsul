import { test, expect, type Page } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { gotoApp, itemCard, runCommand } from './helpers/app';
import { cleanupByTitlePrefix, cleanupTestMods, createTestTask, fetchTestMod, specScope } from './helpers/api';
import { getTodayStr } from './helpers/dates';

/**
 * MODS: a mod's panels end to end (memory/plans/mods.md, build order 9).
 *
 * What only a real browser can say: that a tree the sandbox returns reaches
 * the braindump card through the frame (its RESULT_MAX), that a press on the
 * card's +1 runs the mod's `ui.action` and redraws, that the rail's 'mod'
 * mode opens from the header key at a docked and at an overlaid width and an
 * item covers it with "‹ Your mod · <name>", that a throwing panel shows its
 * error once and never retries on its own, that the phone opens the panel in
 * its sheet with nothing focused, and that `?safe-mode` shows none of it.
 *
 * Chromium only today, as mods-sandbox.spec.ts: outside Chromium the save
 * may end in "Mods can't run in this browser yet", and that is asserted
 * rather than skipped. Serial, under its own prefix: every test writes
 * user_mods rows on the shared test user, and the braindump has one card
 * slot (the earliest switched-on mod's).
 */
const scope = specScope('mods-panels');

async function gotoMake(page: Page): Promise<void> {
  await page.goto('/settings/make');
  await expect(page.getByTestId('make-pane')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('make-new-mod')).toBeVisible({ timeout: 20_000 });
}

/** Makes a mod in Make (the template when `source` is left out); false when this engine cannot run it. */
async function makeMod(page: Page, name: string, source?: string): Promise<boolean> {
  await gotoMake(page);
  await page.getByTestId('make-new-mod').click();
  await page.getByTestId('mod-name').fill(name);
  if (source !== undefined) await page.getByTestId('mod-source').fill(source);
  await page.getByTestId('mod-save').click();

  const saved = page.getByTestId('make-notice');
  const error = page.getByTestId('mod-editor-error');
  await expect(saved.or(error)).toBeVisible({ timeout: 20_000 });
  if (await error.isVisible()) {
    const text = (await error.textContent()) ?? '';
    if (test.info().project.name !== 'chromium' && text.includes('can’t run in this browser')) return false;
    throw new Error(`the mod did not save: ${text}`);
  }
  await expect(saved).toHaveText('Saved. It starts switched off.');
  return true;
}

/** Switches a mod on or off in Make and waits until the write has landed. */
async function setOn(page: Page, name: string, on: boolean): Promise<{ id: string; slug: string }> {
  const toggle = page.getByRole('switch', { name });
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click();
  await expect.poll(async () => (await fetchTestMod(name))?.enabled ?? !on, { timeout: 10_000 }).toBe(on);
  const row = await fetchTestMod(name);
  return { id: row!.id, slug: row!.slug };
}

const card = (page: Page) => page.getByTestId('mod-card');
const modRail = (page: Page) => page.locator('[data-mod-rail]');

/** A panel that throws every time it is drawn: a counted fault per draw. */
const THROWS = `export const manifest = {
  version: 1,
  uses: ['ui'],
  commands: [],
  panels: [{ id: 'broken', label: 'Broken', card: true }],
};
export function register(on) {
  on('ui.resolve', () => { throw new Error('nope'); });
}
`;

/** A panel showing one of the person's items, which needs items:read. */
const linksTo = (itemId: string) => `export const manifest = {
  version: 1,
  uses: ['ui', 'items:read'],
  commands: [],
  panels: [{ id: 'linked', label: 'Linked' }],
};
export function register(on) {
  on('ui.resolve', () => ({ type: 'list', children: [{ type: 'itemRef', id: '${itemId}' }] }));
}
`;

test.describe('Mod panels', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await cleanupTestMods(scope.prefix);
    await loginTestUser(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanupTestMods(scope.prefix);
    await cleanupByTitlePrefix(page, scope.prefix);
  });

  test('the card under the braindump draws, counts a +1, and keeps the mod on through a burst', async ({ page }) => {
    const name = scope.title('Water');
    if (!(await makeMod(page, name))) return;
    await setOn(page, name, true);

    await gotoApp(page);
    await expect(card(page)).toContainText(name, { timeout: 20_000 });
    await expect(card(page)).toContainText('Your mod');
    await expect(card(page)).toContainText('0 of 8', { timeout: 20_000 });

    // A press on a node shown less than 500ms ago is ignored, by design.
    await page.waitForTimeout(600);
    await card(page).getByRole('button', { name: '+1' }).click();
    await expect(card(page)).toContainText('1 of 8', { timeout: 15_000 });

    // The person's own presses are off the hook rate: a burst never switches it off.
    const plus = card(page).getByRole('button', { name: '+1' });
    for (let i = 0; i < 35; i++) await plus.click({ delay: 0 });
    await page.waitForTimeout(1_000);
    expect((await fetchTestMod(name))?.enabled).toBe(true);
  });

  test('the header key opens the rail, an item covers it, and ✕ closes the column without Ask', async ({ page }) => {
    const name = scope.title('Water');
    if (!(await makeMod(page, name))) return;
    await setOn(page, name, true);
    const itemId = await createTestTask(page, {
      title: scope.title('dentist'),
      startDate: getTodayStr(),
      isScheduled: true,
      timeBucket: 'morning',
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoApp(page);
    await page.getByRole('button', { name: 'Your mod panels' }).click();
    await expect(modRail(page)).toBeVisible();
    await expect(modRail(page).getByTestId('mod-surface-chrome')).toContainText(name);
    await expect(modRail(page).getByTestId('mod-surface-chrome')).toContainText('Your mod');
    // Docked: the planner stays usable beside it.
    await expect(page.locator('main')).not.toHaveAttribute('inert', '');

    // On the title's start, not the row's centre: with the mod rail docked the
    // canvas narrows, and the centre lands under the row's hover cluster,
    // which swallows the click so the item never opens.
    await itemCard(page, itemId).locator('[data-row-title]').first().click({ position: { x: 4, y: 6 } });
    const back = page.getByTestId('item-dialog').getByTestId('rail-back');
    await expect(back).toContainText(`Your mod · ${name}`);
    await expect(modRail(page)).toBeHidden();
    // The opener's click holds the rail header for RAIL_HEADER_HOLD_MS
    // (lib/rail-store.ts), and on a fast runner everything above lands inside
    // it, so a single click on ‹ could be swallowed. Retry the click until the
    // panel is back rather than racing the hold.
    await expect(async () => {
      if (await back.isVisible()) await back.click();
      await expect(modRail(page)).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });

    await modRail(page).getByTestId('mod-rail-close').click();
    await expect(modRail(page)).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator('[data-rail-view]')).toBeHidden();
  });

  test('narrow, it opens as an overlay, and a click on the canvas gives the planner back', async ({ page }) => {
    const name = scope.title('Water');
    if (!(await makeMod(page, name))) return;
    await setOn(page, name, true);

    await page.setViewportSize({ width: 1000, height: 800 });
    await gotoApp(page);
    await page.getByRole('button', { name: 'Your mod panels' }).click();
    await expect(modRail(page)).toBeVisible();
    await expect(page.locator('main')).toHaveAttribute('inert', '');
    await page.mouse.click(200, 600);
    await expect(modRail(page)).toBeHidden();
    await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  });

  test('a throwing panel shows its error once, retries only on Try again, and is switched off at the third fault', async ({
    page,
  }) => {
    const name = scope.title('Broken');
    if (!(await makeMod(page, name, THROWS))) return;
    const { id } = await setOn(page, name, true);

    await gotoApp(page);
    await expect(card(page)).toContainText('This mod hit an error', { timeout: 20_000 });
    // No automatic retries: the mod is still on after a while.
    await page.waitForTimeout(3_000);
    expect((await fetchTestMod(name))?.enabled).toBe(true);

    const retry = card(page).getByTestId('mod-surface-retry');
    await retry.click();
    await expect(retry).toBeVisible({ timeout: 10_000 });
    await retry.click();
    await expect.poll(async () => (await fetchTestMod(name))?.enabled, { timeout: 15_000 }).toBe(false);

    await gotoMake(page);
    await expect(page.locator(`[data-make-row="${id}"]`)).toContainText('Switched off');
  });

  test('?safe-mode shows no key, no card and no panel commands', async ({ page }) => {
    const name = scope.title('Water');
    if (!(await makeMod(page, name))) return;
    const { slug } = await setOn(page, name, true);

    await page.goto('/?safe-mode');
    await expect(page.locator('main')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Your mod panels' })).toHaveCount(0);
    await expect(card(page)).toHaveCount(0);
    const input = page.locator('[data-omnibar-variant="dock"] [data-testid="omnibar-input"]');
    await input.click();
    await input.fill('Open Water');
    await expect(page.locator(`[data-command-id="mod.${slug}.open.water"]`)).toHaveCount(0);
  });
});

test.describe('Mod panels on the phone @mobile', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await cleanupTestMods(scope.prefix);
    await loginTestUser(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanupTestMods(scope.prefix);
    await cleanupByTitlePrefix(page, scope.prefix);
  });

  test('⌘K opens the panel in the sheet with nothing focused, and an item row closes it for the drawer', async ({
    page,
  }) => {
    const itemTitle = scope.title('dentist');
    const itemId = await createTestTask(page, { title: itemTitle });
    const name = scope.title('Linked');
    if (!(await makeMod(page, name, linksTo(itemId)))) return;
    const { slug } = await setOn(page, name, true);

    await gotoApp(page);
    await runCommand(page, `mod.${slug}.open.linked`, { query: 'Open Linked' });
    const sheet = page.getByTestId('mod-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('mod-surface-chrome')).toContainText(name);
    await expect(sheet.getByTestId('mod-surface-chrome')).toContainText('Your mod');
    // Nothing inside took focus on open.
    expect(await sheet.evaluate((el) => el.contains(document.activeElement) && document.activeElement !== el)).toBe(false);

    const row = sheet.getByTestId('mod-item-ref');
    await expect(row).toContainText(itemTitle, { timeout: 20_000 });
    // A press on a node shown less than 500ms ago is ignored, by design.
    await page.waitForTimeout(600);
    await row.click();
    await expect(sheet).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByTestId('item-dialog')).toBeVisible();
  });
});
