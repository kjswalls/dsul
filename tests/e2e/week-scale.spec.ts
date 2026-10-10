import { test, expect, type Locator, type Page } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { reloadApp, setLayout, setScope } from './helpers/app';

/** Positions on the day-count ladder — see WEEK_DAY_STOPS in lib/week-columns.
 *  An upper bound on the rung ladder too, which is a subset of it. */
const WEEK_STOP_COUNT = 6;

/**
 * The week scale control — the slider that sets how wide a day column is.
 *
 * The arithmetic is unit-tested (tests/unit/week-columns.test.ts), because CI
 * runs `test:unit` on every push and e2e only on pull requests. What only
 * a browser can confirm is here: that the derived number reaches the DOM, that
 * all seven columns move together, that the choice persists, and that the canvas
 * really does give up its 1100px cap in week scope while staying aligned with
 * the header row.
 *
 * VIEWPORT. The Playwright default (1280×720) leaves an 836px scrollport, where
 * every stop from seven days down to four lands on the 140px floor — so a step
 * there is a legitimate no-op and asserting on it would be asserting on the
 * window size. These tests run at 1700×900 (a 1256px scrollport), where all six
 * stops resolve to distinct widths. The one test that cares about small canvases
 * says so locally.
 */

test.use({ viewport: { width: 1700, height: 900 } });

async function columnWidths(page: Page): Promise<number[]> {
  return page
    .locator('[data-testid="week-column"]')
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
}

function scaleOf(page: Page) {
  const root = page.getByTestId('week-scale');
  return {
    root,
    wider: root.getByRole('button', { name: 'Wider day columns' }),
    narrower: root.getByRole('button', { name: 'Narrower day columns' }),
  };
}

/**
 * Step until the scale reads `target`.
 *
 * Not a fixed click count: the starting stop is DERIVED from the canvas, so
 * "five clicks" is only ever correct from one end of the ladder. And a step
 * button disables at its end, which `.click()` waits on rather than failing — an
 * overshoot surfaces as a 60s timeout in whatever assertion comes next.
 *
 * Each click waits for its own effect to land before the next read. Probing
 * `isEnabled()` instead is racy: straight after a click the DOM can still be the
 * pre-update one, so the button reads enabled, and the click issued against that
 * stale read then blocks on a button that has since disabled.
 */
async function driveTo(root: Locator, button: Locator, target: string): Promise<void> {
  for (let i = 0; i < WEEK_STOP_COUNT; i++) {
    const now = await root.getAttribute('data-days');
    if (now === target) return;
    await button.click();
    await expect(root).not.toHaveAttribute('data-days', now!);
  }
  await expect(root).toHaveAttribute('data-days', target);
}

/** Left edges of every canvas-container in the body panel. */
function canvasLefts(page: Page): Promise<number[]> {
  return page
    .locator('main .canvas-container')
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
}

test.describe('week scale', () => {
  test.beforeEach(async ({ page }) => {
    await loginTestUser(page);
  });

  test('appears only in the week views that have day columns', async ({ page }) => {
    await setScope(page, 'Day');
    await expect(page.getByTestId('week-scale')).toHaveCount(0);

    await setScope(page, 'Week');
    await setLayout(page, 'Schedule');
    await expect(page.getByTestId('week-scale')).toBeVisible();

    await setLayout(page, 'Buckets');
    await expect(page.getByTestId('week-scale')).toBeVisible();

    // Week × List is a stack of rows — there is nothing to scale.
    await setLayout(page, 'List');
    await expect(page.getByTestId('week-scale')).toHaveCount(0);
  });

  test('opens at the stop nearest the target column width', async ({ page }) => {
    await setScope(page, 'Week');
    await setLayout(page, 'Schedule');

    // Nothing stored, so the default is derived: at this 1256px scrollport the
    // ladder gives 152/179/216/273/366/480, and 273 is nearest 287.
    await expect(scaleOf(page).root).toHaveAttribute('data-days', '4');
    expect(await columnWidths(page)).toEqual(Array(7).fill(273));

    // …and it re-derives rather than sticking, because it is still unchosen:
    // 1476px gives 184/216/260/328/…, where 260 wins.
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect(scaleOf(page).root).toHaveAttribute('data-days', '5');
    expect(await columnWidths(page)).toEqual(Array(7).fill(260));
  });

  test('a chosen width stops re-deriving and survives a resize', async ({ page }) => {
    await setScope(page, 'Week');
    await setLayout(page, 'Schedule');
    const { root, wider } = scaleOf(page);

    await wider.click();
    await expect(root).toHaveAttribute('data-days', '3');

    // The same resize that moved the default above must now change nothing.
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect(root).toHaveAttribute('data-days', '3');
  });

  test('widens every column together, and narrows them back', async ({ page }) => {
    await setScope(page, 'Week');
    await setLayout(page, 'Schedule');

    const { root, wider, narrower } = scaleOf(page);
    // Non-null: the control is mounted, and it always publishes a resolved count.
    const start = (await root.getAttribute('data-days'))!;

    const before = await columnWidths(page);
    expect(before).toHaveLength(7);

    await wider.click();
    await expect(root).toHaveAttribute('data-days', String(Number(start) - 1));
    const after = await columnWidths(page);
    for (let i = 0; i < 7; i++) expect(after[i]).toBeGreaterThan(before[i]);

    // Every column lands on one width — except one that grew to clear the
    // channel floor for an overlapping pair, which week does by contract (see
    // minColPx in components/views/week-schedule.tsx). So: the target, or wider.
    const target = Math.min(...after);
    for (const w of after) expect(w).toBeGreaterThanOrEqual(target);

    await narrower.click();
    await expect(root).toHaveAttribute('data-days', start);
    expect(await columnWidths(page)).toEqual(before);
  });

  test('scales week × buckets from the same control', async ({ page }) => {
    await setScope(page, 'Week');
    await setLayout(page, 'Buckets');

    const { root, narrower } = scaleOf(page);
    // Buckets has no gutter and a wider gap, so its ladder differs — but the
    // target is the same, and 277px at four days is what comes nearest. Schedule
    // opens at 273 on this same canvas: switching layout must not change the
    // density, which is the point of deriving both from one target.
    await expect(root).toHaveAttribute('data-col-px', '277');
    await expect(root).toHaveAttribute('data-days', '4');
    await expect(root).toHaveAttribute('data-fits', 'true');
    expect(await columnWidths(page)).toEqual(Array(7).fill(277));

    // One notch narrower is a DIFFERENT width. It did not used to be: buckets
    // floored at 240 and this scrollport resolved seven, six and five days all to
    // exactly that, so the first half of the slider's travel was a no-op.
    await narrower.click();
    await expect(root).toHaveAttribute('data-col-px', '216');
    expect(await columnWidths(page)).toEqual(Array(7).fill(216));

    // Two notches in, the floor takes over and the grid starts scrolling — which
    // the control reports rather than showing a width that isn't on screen. The
    // stored count jumps 5 → 7 rather than 5 → 6: at this canvas six and seven
    // days both render at the floor, so they are ONE rung and one click of travel
    // (see weekRungs). The width is what the control reads out, and it moved.
    await narrower.click();
    await expect(root).toHaveAttribute('data-col-px', '200');
    await expect(root).toHaveAttribute('data-days', '7');
    await expect(root).toHaveAttribute('data-fits', 'false');
    expect(await columnWidths(page)).toEqual(Array(7).fill(200));

    // …and that is the end of the ladder, because there is no narrower width to
    // reach. The button says so rather than accepting clicks that do nothing.
    await expect(narrower).toBeDisabled();
  });

  test('reads out the column width, not a day count', async ({ page }) => {
    await setScope(page, 'Week');
    await setLayout(page, 'Schedule');

    const { root, wider } = scaleOf(page);
    // The readout is the one number in the control, and it is a width: "5 days"
    // was a claim about the canvas that the view breaks whenever a stop is clamped
    // — it read five while six and a half columns were on screen. A width is
    // measurable off the screen at any moment.
    await expect(root).toHaveAttribute('data-col-px', '273');
    await expect(root).toContainText('273px');
    await expect(root).not.toContainText('days');

    await wider.click();
    await expect(root).toContainText('366px');

    // Days survive in the hover explanation, where the qualification can travel
    // with them.
    await expect(root.locator('[title]').last()).toHaveAttribute(
      'title',
      /366px per column, 3 days across the canvas/
    );
  });

  test('the choice survives a reload', async ({ page }) => {
    await setScope(page, 'Week');
    await setLayout(page, 'Schedule');
    const { root, wider } = scaleOf(page);
    await wider.click();
    await expect(root).toHaveAttribute('data-days', '3');

    await reloadApp(page);
    // waitForAppReady only proves a canvas view mounted, not WHICH one, and the
    // control does not exist outside week scope — so wait for the view marker
    // first or this races the store rehydrating under parallel workers.
    await expect(page.getByTestId('view-root')).toHaveAttribute('data-view-scope', 'week', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('week-scale')).toHaveAttribute('data-days', '3', {
      timeout: 10_000,
    });
  });

  test('stops at both ends of the ladder', async ({ page }) => {
    await setScope(page, 'Week');
    await setLayout(page, 'Schedule');
    const { root, wider, narrower } = scaleOf(page);

    await driveTo(root, narrower, '7');
    await expect(narrower).toBeDisabled();
    await expect(wider).toBeEnabled();

    await driveTo(root, wider, '2');
    await expect(wider).toBeDisabled();
    await expect(narrower).toBeEnabled();
  });

  test('⌘+ and ⌘− step the scale, and ⌘0 resets it', async ({ page }) => {
    await setScope(page, 'Week');
    await setLayout(page, 'Schedule');
    const { root } = scaleOf(page);

    // Stepping from the derived default must not jump: the command has no DOM
    // to measure, so it resolves against the canvas the view last recorded.
    await expect(root).toHaveAttribute('data-days', '4');

    // Ctrl folds to the same 'mod' token Cmd does — see lib/commands/keys.ts.
    await page.keyboard.press('Control+=');
    await expect(root).toHaveAttribute('data-days', '3');
    await page.keyboard.press('Control+=');
    await expect(root).toHaveAttribute('data-days', '2');
    await page.keyboard.press('Control+-');
    await expect(root).toHaveAttribute('data-days', '3');

    // ⌘0 clears the choice rather than writing a count, so it lands back on the
    // derived default — and resumes re-deriving.
    await page.keyboard.press('Control+0');
    await expect(root).toHaveAttribute('data-days', '4');
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect(root).toHaveAttribute('data-days', '5');
  });

  test('⌘ + wheel over the grid steps the scale', async ({ page }) => {
    await setScope(page, 'Week');
    await setLayout(page, 'Schedule');
    const { root } = scaleOf(page);

    const grid = page.locator('[data-tour="timeline"] [data-slot="scroll-area-viewport"]');
    const box = (await grid.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    await expect(root).toHaveAttribute('data-days', '4');
    await page.keyboard.down('Control');
    // Up is zoom-in is wider, matching every other canvas.
    await page.mouse.wheel(0, -60);
    await expect(root).toHaveAttribute('data-days', '3');
    await page.mouse.wheel(0, 60);
    await expect(root).toHaveAttribute('data-days', '4');
    await page.keyboard.up('Control');

    // Without the modifier it is an ordinary scroll and must not touch the scale.
    await page.mouse.wheel(0, -180);
    await expect(root).toHaveAttribute('data-days', '4');
  });

  test('the hour gutter stays pinned across the whole scroll range', async ({ page }) => {
    await setScope(page, 'Week');
    await setLayout(page, 'Schedule');

    // Widest stop, so the scroll range is long. Under the old 1100px cap the
    // gutter came unstuck at scrollLeft > containerLeft + 1000 — i.e. exactly
    // once the columns were wide enough to need it.
    await driveTo(scaleOf(page).root, scaleOf(page).wider, '2');

    const probe = await page
      .locator('[data-tour="timeline"] [data-slot="scroll-area-viewport"]')
      .evaluate(async (vp: HTMLElement) => {
        const gutter = vp.querySelector('[data-testid="week-hour-gutter"]') as HTMLElement;
        const vpLeft = vp.getBoundingClientRect().left;
        const max = vp.scrollWidth - vp.clientWidth;
        const xs: number[] = [];
        let columnOnTop = false;
        for (const target of [0, 400, 1200, Math.floor(max / 2), max]) {
          vp.scrollLeft = target;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const box = gutter.getBoundingClientRect();
          xs.push(Math.round(box.left - vpLeft));
          // Whatever paints in the middle of the hour-label column must be the
          // gutter, never a column that has scrolled beneath it.
          const hit = document.elementFromPoint(box.left + 40, box.top + 260);
          if (hit?.closest('[data-testid="week-column"]')) columnOnTop = true;
        }
        vp.scrollLeft = 0;
        return { max, xs, columnOnTop };
      });

    expect(probe.max).toBeGreaterThan(1200);
    expect(probe.xs).toEqual([0, 0, 0, 0, 0]);
    expect(probe.columnOnTop).toBe(false);
  });

  test('the gutter returns to its pin after a week navigation', async ({ page }) => {
    await setScope(page, 'Week');
    await setLayout(page, 'Schedule');
    await driveTo(scaleOf(page).root, scaleOf(page).wider, '2');

    const viewport = page.locator('[data-tour="timeline"] [data-slot="scroll-area-viewport"]');
    await viewport.evaluate((el: HTMLElement) => {
      el.scrollLeft = 600;
    });

    // The nav slide animates translateX on the row, which carries the sticky
    // gutter with it for 400ms. It has no fill-mode, so it must land back on 0.
    await page.getByTestId('header-next').click();
    await page.waitForTimeout(700);

    const x = await viewport.evaluate((vp: HTMLElement) => {
      const gutter = vp.querySelector('[data-testid="week-hour-gutter"]') as HTMLElement;
      return Math.round(gutter.getBoundingClientRect().left - vp.getBoundingClientRect().left);
    });
    expect(x).toBe(0);
  });

  test('the week grid drops the 1100px canvas cap, and the header row goes with it', async ({
    page,
  }) => {
    await setScope(page, 'Day');
    const dayLefts = await canvasLefts(page);
    const dayWidth = await page
      .locator('[data-tour="timeline"] .canvas-container')
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(dayWidth).toBeLessThanOrEqual(1100);
    // Capped or not, the shared left edge is the contract canvas-container
    // exists for: header capsule, past-due bar and body view all agree.
    expect(new Set(dayLefts).size).toBe(1);

    await setScope(page, 'Week');
    await setLayout(page, 'Schedule');

    const weekWidth = await page
      .locator('[data-tour="timeline"] .canvas-container')
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(weekWidth).toBeGreaterThan(1100);
    expect(new Set(await canvasLefts(page)).size).toBe(1);

    // …and at the seven-day stop the whole week now fits, which under the cap it
    // could not do at ANY window width: seven columns needed 1104px inside a
    // 1036px content box. (The derived default is a wider stop than that, and
    // scrolling is the correct behaviour there — hence driving to the end first
    // rather than asserting against whatever the default happens to be.)
    await driveTo(scaleOf(page).root, scaleOf(page).narrower, '7');
    const scrolls = await page
      .locator('[data-tour="timeline"] [data-slot="scroll-area-viewport"]')
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrolls).toBe(false);
  });
});
