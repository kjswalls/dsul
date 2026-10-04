import { test, expect, type Locator, type Page } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { createTestTask, cleanupByTitlePrefix, fetchTestTask, specScope } from './helpers/api';
import { getTodayStr, getTomorrowStr } from './helpers/dates';
import { reloadApp, itemCard } from './helpers/app';

/**
 * Letting go of the right button must not choose a row of the menu it opened
 * (components/ui/context-menu.tsx, the opening-release guard).
 *
 * Chromium on Linux and macOS fires `contextmenu` on the button's DOWN. The item
 * menu is taller than the room under a low row, so Radix shifts it up to fit,
 * and its slide-in carries it over the pointer: the release then lands on a
 * row, and Radix selects a row released over without a press on it. Only a
 * browser can show that, and only with the real button, so these tests click
 * for real (ask-menu.spec.ts dispatches `contextmenu` instead, which never
 * holds a button down).
 */

const scope = specScope('ctxrelease');

/** The row the release is aimed at: one that writes, so a wrong select shows. */
const TARGET = 'item-menu-next-day';

const menuOf = (page: Page) => page.getByTestId('item-context-menu');

/** Resolves once the menu's open animation (and any child's) has finished. */
async function settled(menu: Locator) {
  await menu.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
}

/** Where a real click on the row lands: Playwright's own aim, the centre of the title. */
async function aimAt(title: Locator) {
  const box = await title.boundingBox();
  if (!box) throw new Error('the row is not on screen');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Opens the menu at `at` WITHOUT a button held (no press, so nothing to
 * release) and measures it. A MouseEvent built in the page, because
 * Playwright's dispatchEvent does not know `contextmenu` is a mouse event and
 * sends a bare Event with no coordinates, which opens the menu at (0, 0).
 */
async function measureMenu(page: Page, title: Locator, at: { x: number; y: number }) {
  await title.evaluate(
    (el, { x, y }) =>
      el.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y })
      ),
    at
  );
  const menu = menuOf(page);
  await expect(menu).toBeVisible();
  await settled(menu);
  const panel = (await menu.boundingBox())!;
  const row = (await menu.getByTestId(TARGET).boundingBox())!;
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  return { panel, row };
}

/**
 * Sizes the viewport so the menu, shifted up to sit on the viewport's floor,
 * has TARGET at the pointer's height — the shape the bug was seen in. Asserts
 * the shape rather than assuming it, so a layout change fails here, loudly,
 * instead of letting the release miss the menu and the test pass on nothing.
 */
async function putTargetUnderPointer(page: Page, title: Locator) {
  const at = await aimAt(title);
  const { panel, row } = await measureMenu(page, title, at);
  // Taller than the room on either side of the pointer: it can neither open
  // down from the row nor flip up from it, so Radix shifts it onto the floor.
  expect(panel.height, 'the menu fits above the row; it would flip clear of the pointer').toBeGreaterThan(at.y);
  const { width, height } = page.viewportSize()!;
  await page.setViewportSize({ width, height: Math.round(height - (row.y + row.height / 2 - at.y)) });

  const now = await aimAt(title);
  const { row: aimed } = await measureMenu(page, title, now);
  expect(now.y, `${TARGET} is not at the pointer's height`).toBeGreaterThan(aimed.y);
  expect(now.y, `${TARGET} is not at the pointer's height`).toBeLessThan(aimed.y + aimed.height);
  return now;
}

/** Notes which menu row each pointerup lands on, before React (or the guard) sees it. */
async function recordReleases(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __releases: (string | null)[] };
    w.__releases = [];
    document.addEventListener(
      'pointerup',
      (e) => {
        const row = (e.target as Element).closest?.('[role="menuitem"]');
        w.__releases.push(row?.getAttribute('data-testid') ?? null);
      },
      true
    );
  });
  return () => page.evaluate(() => (window as unknown as { __releases: (string | null)[] }).__releases);
}

test.describe('the right-click that opens a menu', () => {
  test.beforeEach(async ({ page }) => {
    await loginTestUser(page);
  });

  test('releasing the right button over the shifted menu selects nothing; a left click on the row still does', async ({
    page,
  }) => {
    const title = scope.title('low');
    const today = getTodayStr();
    const id = await createTestTask(page, { title, startDate: today, isScheduled: true, timeBucket: 'evening' });

    try {
      await reloadApp(page);
      const text = itemCard(page, id).getByText(title, { exact: true });
      await expect(text).toBeVisible();
      const at = await putTargetUnderPointer(page, text);
      const releases = await recordReleases(page);
      const menu = menuOf(page);

      // 1. A real right click, as the report had it: press and release in place.
      await text.click({ button: 'right' });
      // It reached "Move to tomorrow" (else this proves nothing)…
      expect(await releases(), 'the release never landed on the menu').toEqual([TARGET]);
      // …and chose nothing: still open, still today.
      await expect(menu).toBeVisible();
      await settled(menu);
      await expect(menu).toBeVisible();
      await expect(itemCard(page, id)).toBeVisible();
      expect((await fetchTestTask(page, id))?.startDate).toBe(today);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);

      // 2. The same click with the hand drifting a few pixels while it is down,
      //    which lands the release inside the menu however fast the slide-in ran.
      await page.mouse.move(at.x, at.y);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(at.x + 5, at.y);
      await page.mouse.up({ button: 'right' });
      expect((await releases()).at(-1), 'the release never landed on the menu').toBe(TARGET);
      await expect(menu).toBeVisible();
      await settled(menu);
      await expect(menu).toBeVisible();
      expect((await fetchTestTask(page, id))?.startDate).toBe(today);

      // 3. A deliberate left click on the row is untouched.
      await menu.getByTestId(TARGET).click();
      await expect(menu).toHaveCount(0);
      await expect.poll(async () => (await fetchTestTask(page, id))?.startDate).toBe(getTomorrowStr());
    } finally {
      await cleanupByTitlePrefix(page, title);
    }
  });
});
