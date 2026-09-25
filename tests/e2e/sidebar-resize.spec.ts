import { test, expect, type Page } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { reloadApp } from './helpers/app';
import { resetUserSettings, setUserSetting } from './helpers/api';

/**
 * The sidebar sash: drag the gutter between the braindump column and the body
 * panel to resize it.
 *
 * Worth an e2e rather than a unit test because the mechanism is deliberately
 * NOT React state. The width travels as the `--sidebar-w` custom property,
 * written straight to <html> on every animation frame so a drag doesn't
 * re-render the braindump list; only the release commits to the store. Nothing
 * in jsdom exercises that — the assertions below are on the laid-out box, which
 * is the only thing that proves the variable reached layout.
 */

// Mirrors lib/sidebar-store.ts. Restated rather than imported: a spec that
// imports the constants it asserts against can only ever confirm the app agrees
// with itself, and would go green if both moved together.
const DEFAULT_W = 406;
const MIN_W = 280;
const MAX_W = 720;

const column = (page: Page) => page.getByTestId('sidebar-column');
const sash = (page: Page) => page.getByTestId('sidebar-resize-handle');

/** The column's rendered width, rounded — sub-pixel layout is not the subject. */
async function columnWidth(page: Page): Promise<number> {
  const box = await column(page).boundingBox();
  if (!box) throw new Error('sidebar column has no box — is the desktop shell mounted?');
  return Math.round(box.width);
}

/**
 * Drag the sash by `dx`. Two intermediate moves, not one: the handle takes
 * pointer capture on the way down, and a single jump would pass whether or not
 * the move handler tracks a live pointer.
 */
/**
 * How far below the sash's midpoint to aim for "the bare track". The collapse
 * grip occupies the middle 40px, and Playwright's element-centre default lands
 * squarely on it — so every gesture that is not specifically about the grip has
 * to be offset, or the suite would only ever exercise the grip's code path and
 * plain track dragging would go untested.
 */
const TRACK_DY = 120;

/** Double-click the resize track, clear of the grip. */
async function dblclickTrack(page: Page): Promise<void> {
  const box = (await sash(page).boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2 + TRACK_DY);
}

async function dragSash(page: Page, dx: number): Promise<void> {
  const box = await sash(page).boundingBox();
  if (!box) throw new Error('resize sash is not rendered');
  const y = box.y + box.height / 2 + TRACK_DY; // bare track, not the grip
  const x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

test.describe('Sidebar resize', () => {
  test.beforeEach(async ({ page }) => {
    await loginTestUser(page);
    // Every context starts from globalSetup's storageState, which carries no
    // dsul-sidebar-settings record — so the column is at its default. Assert
    // it, because every width below is relative to this.
    await expect.poll(() => columnWidth(page)).toBe(DEFAULT_W);
  });

  test('dragging the sash resizes the column and the width survives a reload', async ({ page }) => {
    await dragSash(page, 120);

    // The drag wrote the CSS variable; this is the variable having reached layout.
    await expect.poll(() => columnWidth(page)).toBe(DEFAULT_W + 120);
    // ...and the release having committed to the store.
    await expect(sash(page)).toHaveAttribute('aria-valuenow', String(DEFAULT_W + 120));

    // The commit is persisted, and the mount-time effect republishes it. This is
    // the half that a "does the div get wider" test would miss entirely.
    await reloadApp(page);
    await expect.poll(() => columnWidth(page)).toBe(DEFAULT_W + 120);
  });

  test('dragging narrows the column too, and stops at the minimum', async ({ page }) => {
    await dragSash(page, -60);
    await expect.poll(() => columnWidth(page)).toBe(DEFAULT_W - 60);

    // Far past the floor. The column must stop dead at MIN rather than
    // collapsing — the sash goes with the column, so a zero-width one would be
    // unrecoverable without devtools.
    await dragSash(page, -600);
    await expect.poll(() => columnWidth(page)).toBe(MIN_W);
    await expect(sash(page)).toHaveAttribute('aria-valuenow', String(MIN_W));
  });

  test('the column stops at the maximum', async ({ page }) => {
    // 1280px viewport, so the viewport reserve (innerWidth - 520 = 760) is not
    // the binding constraint here — MAX_W is.
    await dragSash(page, 900);
    await expect.poll(() => columnWidth(page)).toBe(MAX_W);
  });

  test('double-clicking the track resets to the default width', async ({ page }) => {
    await dragSash(page, 150);
    await expect.poll(() => columnWidth(page)).toBe(DEFAULT_W + 150);

    // Aimed at the track, NOT the sash's centre — the collapse grip sits on the
    // midpoint and answers a click first. Playwright's bare .dblclick() targets
    // element centre, which is exactly the one spot this gesture cannot use.
    await dblclickTrack(page);
    await expect.poll(() => columnWidth(page)).toBe(DEFAULT_W);
    await expect(sash(page)).toHaveAttribute('aria-valuenow', String(DEFAULT_W));
  });

  test('the focused sash resizes from the keyboard', async ({ page }) => {
    await sash(page).focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => columnWidth(page)).toBe(DEFAULT_W + 16);

    // Shift takes the coarse step.
    await page.keyboard.press('Shift+ArrowLeft');
    await expect.poll(() => columnWidth(page)).toBe(DEFAULT_W + 16 - 48);

    await page.keyboard.press('End');
    await expect.poll(() => columnWidth(page)).toBe(MAX_W);
    await page.keyboard.press('Home');
    await expect.poll(() => columnWidth(page)).toBe(MIN_W);
  });

  /**
   * The tooltip is the ONLY place the reset and the arrow keys are written
   * down. A col-resize cursor communicates "drag" and nothing else, so if this
   * content goes missing those two affordances become undiscoverable rather
   * than merely undocumented — which is exactly the state this replaced.
   */
  test.describe('the sash documents itself', () => {
    const tip = (page: Page) => page.locator('[data-slot="tooltip-content"]').first();

    test('hovering names the reset and the arrow keys', async ({ page }) => {
      await sash(page).hover();
      await expect(tip(page)).toBeVisible();
      // "the track", not "the sash" — the copy has to name the zone, because
      // the grip owns the midpoint and swallows a double-click aimed there.
      await expect(tip(page)).toContainText('Double-click the track to reset');
      await expect(tip(page)).toContainText('Click the grip to collapse');
      await expect(tip(page)).toContainText('to nudge');
      // The current width doubles as the readout.
      await expect(tip(page)).toContainText(`${DEFAULT_W}px`);
      await expect(tip(page)).toContainText('default');
    });

    test('keyboard focus opens it, so the arrow keys announce themselves', async ({ page }) => {
      // The discoverability contract, and the reason the sash is a tab stop at
      // all: landing here with the keyboard has to TELL you the keys work.
      // Reached without the mouse, exactly as a keyboard user would.
      //
      // Blur first so the walk starts from a known place. Without it the count
      // depends on whatever the app last focused during load, and the loop can
      // run out of tabs before reaching the sash.
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Tab');
        const onSash = await page.evaluate(
          () => document.activeElement?.getAttribute('data-testid') === 'sidebar-resize-handle'
        );
        if (onSash) break;
      }
      await expect(sash(page)).toBeFocused();
      await expect(tip(page)).toBeVisible();
      await expect(tip(page)).toContainText('to nudge');
    });

    test('the readout follows the width and drops the default marker', async ({ page }) => {
      await dragSash(page, 100);
      // Radix suppresses a reopen until the pointer LEAVES the trigger, and a
      // drag ends with the pointer still on the sash (it moved with it). So
      // step away first — without this the hover below is a no-op and the
      // assertion is waiting on a tooltip that will never come back.
      await page.mouse.move(900, 400);
      await sash(page).hover();
      await expect(tip(page)).toContainText(`${DEFAULT_W + 100}px`);
      await expect(tip(page)).not.toContainText('default');
    });
  });

  /**
   * The collapse control moved out of the braindump header and onto the sash's
   * midpoint, so a press there is ambiguous: it could be reaching for the
   * button or grabbing the sash where a hand naturally lands. It is resolved on
   * RELEASE, by whether the column moved — which is the only reading available,
   * because the sash holds pointer capture and the browser's click therefore
   * never reaches the button.
   */
  test.describe('the collapse button on the sash', () => {
    const collapseBtn = (page: Page) => page.getByRole('button', { name: 'Collapse sidebar' });

    test('sits on the sash midpoint', async ({ page }) => {
      const grip = (await collapseBtn(page).boundingBox())!;
      const bar = (await sash(page).boundingBox())!;
      const gripCentre = grip.y + grip.height / 2;
      const barCentre = bar.y + bar.height / 2;
      expect(Math.abs(gripCentre - barCentre)).toBeLessThanOrEqual(1);
    });

    test('straddles the panel edge, clear of the braindump column', async ({ page }) => {
      await expect(collapseBtn(page)).toHaveCount(1);

      const grip = (await collapseBtn(page).boundingBox())!;
      const column = (await page.getByTestId('sidebar-column').boundingBox())!;
      const panel = (await page.locator('main').boundingBox())!;

      // Centred on the panel's left edge — the same line the collapsed-state
      // grip sits on, so the control does not appear to move between states.
      expect(Math.abs(grip.x + grip.width / 2 - panel.x)).toBeLessThanOrEqual(1);
      expect(grip.x).toBeLessThan(panel.x);
      expect(grip.x + grip.width).toBeGreaterThan(panel.x);

      // It may overhang the PANEL, never the braindump column: overhanging both
      // is what made the 22px chip read as debris wedged into the seam, and is
      // the thing this shape exists to avoid.
      expect(grip.x).toBeGreaterThanOrEqual(column.x + column.width);
      expect(grip.width).toBeLessThanOrEqual(12);
    });

    test('the track stays concentric with the grip', async ({ page }) => {
      // The hairline appears on hover and runs through the grip. Anchor the two
      // to different x and the grip reads as hanging off the line rather than
      // threaded onto it — invisible at rest, obvious the moment you hover.
      const bar = (await sash(page).boundingBox())!;
      await page.mouse.move(bar.x + bar.width / 2, bar.y + 300);
      const track = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="sidebar-resize-handle"] > span')!;
        const r = el.getBoundingClientRect();
        return r.x + r.width / 2;
      });
      const grip = (await collapseBtn(page).boundingBox())!;
      expect(Math.abs(track - (grip.x + grip.width / 2))).toBeLessThanOrEqual(1);
    });

    test('rests at full strength and answers a hover with colour', async ({ page }) => {
      // Opacity is spent — the grip is fully visible before you go looking for
      // it, which is the point, since it is the only mouse route to collapsing.
      // Feedback therefore has to arrive on another channel, and the assertion
      // has to be that SOMETHING changes rather than that opacity does.
      const style = async () =>
        page.evaluate(() => {
          const cs = getComputedStyle(document.querySelector('[data-sash-collapse]')!);
          return { opacity: cs.opacity, color: cs.color, shadow: cs.boxShadow };
        });

      await page.mouse.move(900, 500); // parked well clear of the sash
      const atRest = await style();
      expect(Number(atRest.opacity)).toBe(1);

      const bar = (await sash(page).boundingBox())!;
      await page.mouse.move(bar.x + bar.width / 2, bar.y + 300); // the track, not the grip
      await expect.poll(async () => (await style()).color).not.toBe(atRest.color);
      const hovered = await style();
      expect(Number(hovered.opacity)).toBe(1);
      expect(hovered.shadow).not.toBe(atRest.shadow);
    });

    test('a click on it collapses the column', async ({ page }) => {
      await collapseBtn(page).click();
      await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
      await expect(sash(page)).toHaveCount(0);
    });

    test('a DRAG from it resizes instead of collapsing', async ({ page }) => {
      // The regression that makes the button unusable-adjacent: if press-and-
      // drag on the button collapsed the sidebar, the middle of the sash would
      // be a trap rather than a grab point.
      const btn = (await collapseBtn(page).boundingBox())!;
      const y = btn.y + btn.height / 2;
      const x = btn.x + btn.width / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 90, y, { steps: 6 });
      await page.mouse.up();

      await expect(sash(page)).toBeVisible(); // i.e. did NOT collapse
      await expect.poll(() => columnWidth(page)).toBe(DEFAULT_W + 90);
    });
  });

  /**
   * Reopening is the collapse grip's mirror — same capsule, same gutter, same
   * vertical centre, chevron flipped — so that collapsing and reopening happen
   * at one fixed point rather than the control jumping to the panel's top-left
   * corner, which is where it used to live.
   */
  test.describe('the expand grip', () => {
    /** The 12px mark. Decorative — geometry assertions target this. */
    const expandGrip = (page: Page) => page.getByTestId('sidebar-expand-grip');
    /** The full-height hit area that actually carries the click and the focus. */
    const expandZone = (page: Page) => page.getByTestId('sidebar-expand-zone');

    test.beforeEach(async ({ page }) => {
      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      await expect(expandGrip(page)).toBeVisible();
      // Wait out the 300ms collapse ease before anything measures. <main> is
      // flex-1, so it slides left frame by frame as the column shrinks — read
      // the grip on one frame and the panel on the next and they disagree by
      // however much the column moved in between, which looks exactly like a
      // positioning bug and isn't one.
      await expect
        .poll(() =>
          page.evaluate(() =>
            Math.round(
              document.querySelector('[data-testid="sidebar-column"]')!.getBoundingClientRect().width
            )
          )
        )
        .toBe(0);
    });

    test('straddles the panel edge at the vertical centre', async ({ page }) => {
      const grip = (await expandGrip(page).boundingBox())!;
      const shell = page.viewportSize()!;
      const panel = (await page.locator('main').boundingBox())!;

      // Same height as its twin, so the control does not appear to jump when
      // the column folds.
      expect(Math.abs(grip.y + grip.height / 2 - shell.height / 2)).toBeLessThanOrEqual(2);

      // Deliberately ON the panel edge, not tucked in the gutter beside it:
      // half over the canvas is what gives it something to sit on and makes it
      // findable on an otherwise empty edge. This is the one place the two
      // grips are allowed to differ, so assert the overlap rather than merely
      // permitting it — "drifted back into the gutter" must fail here.
      expect(grip.x).toBeLessThan(panel.x);
      expect(grip.x + grip.width).toBeGreaterThan(panel.x);
      expect(Math.abs(grip.x + grip.width / 2 - panel.x)).toBeLessThanOrEqual(1);
      expect(grip.width).toBeLessThanOrEqual(12);
    });

    test('the hit zone runs the full height of the panel', async ({ page }) => {
      // The grip is a 12×32 mark; the target is the whole edge. Reopening
      // should be a throw of the mouse at that side, not a hunt for the mark.
      const zone = (await expandZone(page).boundingBox())!;
      const panel = (await page.locator('main').boundingBox())!;
      const grip = (await expandGrip(page).boundingBox())!;

      expect(zone.height).toBeGreaterThanOrEqual(panel.height);
      expect(zone.width).toBeGreaterThan(grip.width * 2);
      // Reaches the window edge, and overlaps the panel — but not so far in
      // that it starts eating clicks meant for the view. canvas-container's
      // padding puts real content 32px inside the panel once <main> stops
      // centring, so that is the hard ceiling.
      expect(zone.x).toBeLessThanOrEqual(0);
      expect(zone.x + zone.width).toBeGreaterThan(panel.x);
      expect(zone.x + zone.width - panel.x).toBeLessThanOrEqual(32);
    });

    test('a click anywhere down that edge expands, not just on the mark', async ({ page }) => {
      const zone = (await expandZone(page).boundingBox())!;
      // Near the bottom, far from the centred grip.
      await page.mouse.click(zone.x + zone.width / 2, zone.y + zone.height - 40);
      await expect(sash(page)).toBeVisible();
    });

    test('nothing outranks it on the pixels it overlaps', async ({ page }) => {
      // It sits over the panel's left edge, where the hover-peek strip used to
      // live. Whatever is layered there, the pointer has to find this zone or
      // the overlapping half is decoration.
      const zone = (await expandZone(page).boundingBox())!;
      const panel = (await page.locator('main').boundingBox())!;
      const hit = await page.evaluate(
        ([x, y]) =>
          document
            .elementFromPoint(x as number, y as number)
            ?.closest('[data-testid="sidebar-expand-zone"]') !== null,
        [panel.x + 2, zone.y + zone.height / 2] as const
      );
      expect(hit).toBe(true);
    });

    test('reopens the column at the width it was left at', async ({ page }) => {
      await expandGrip(page).click();
      await expect(sash(page)).toBeVisible();
      await expect.poll(() => columnWidth(page)).toBe(DEFAULT_W);
      await expect(expandGrip(page)).toHaveCount(0);
    });

    test('is reachable and operable from the keyboard', async ({ page }) => {
      // With the column gone, this is the ONLY tab stop that brings it back —
      // every other sidebar control is inside the collapsed, clipped column.
      // The zone is the focusable; the grip inside it is decorative.
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Tab');
        const onZone = await page.evaluate(
          () => document.activeElement?.getAttribute('data-testid') === 'sidebar-expand-zone'
        );
        if (onZone) break;
      }
      await expect(expandZone(page)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(sash(page)).toBeVisible();
    });
  });

  /**
   * Hover-peek used to be triggered by its own 12px strip inside <main>. The
   * expand zone covers those pixels and sits above them, so that strip could
   * only ever have gone dead — it was deleted and the zone fires the peek
   * itself. This is the test that the feature survived the move; nothing else
   * in the suite exercises it, and it is off by default so it would rot
   * silently.
   */
  test.describe('hover-peek, now triggered by the expand zone', () => {
    // Restore the shared user's columns even if the test fails part-way — this
    // one row is read by every other spec's fresh context.
    test.afterEach(async ({ page }) => {
      await resetUserSettings(page);
    });

    test('peeks the column open and holds it there', async ({ page }) => {
      // Set on the SERVER, not in localStorage. supabase-provider.tsx pushes
      // user_settings.left_sidebar_hover into this store ~1s after load, so a
      // seeded localStorage value is silently overwritten mid-test and the peek
      // dies on its own — which looks exactly like a hover bug and is not one.
      await setUserSetting(page, { left_sidebar_hover: true });
      await reloadApp(page);

      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      await expect.poll(() => columnWidth(page)).toBe(0);

      // Re-hover on each poll rather than hovering once and waiting. The
      // setting arrives asynchronously after load, and mouseenter only fires on
      // the way IN — hover a moment too early and the pointer is already parked
      // on the zone when the flag flips, so nothing ever triggers and the test
      // fails claiming the feature is dead.
      await expect
        .poll(
          async () => {
            await page.mouse.move(900, 400);
            await page.getByTestId('sidebar-expand-zone').hover();
            await page.waitForTimeout(600); // 150ms hover intent + the 300ms ease
            return columnWidth(page);
          },
          { timeout: 20_000 }
        )
        .toBe(DEFAULT_W);

      // ...and HOLDS under a stationary pointer, well past the settings push
      // above and past the column's 300ms ease. Polling alone cannot see a
      // panel that opens and then shuts itself: the width passes back through
      // DEFAULT_W on the way down.
      await page.waitForTimeout(1500);
      expect(await columnWidth(page)).toBe(DEFAULT_W);

      // Leaving for real still closes it.
      await page.mouse.move(900, 400);
      await expect.poll(() => columnWidth(page)).toBe(0);
    });

    /**
     * The bug this guards: the peek unmounted the expand grip, and the peeked
     * column covered its pixels, so there was no mouse route from a peek to a
     * docked column. The move to the pin is thrown in steps the instant the
     * peek starts, NOT after the column settles — a pointer that outruns the
     * column's 300ms ease used to land on <main> and shut the peek on the way.
     */
    test('the pin on the peeked edge docks the column open', async ({ page }) => {
      await setUserSetting(page, { left_sidebar_hover: true });
      await reloadApp(page);

      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      await expect.poll(() => columnWidth(page)).toBe(0);

      const pin = page.getByTestId('sidebar-peek-pin');
      // Same re-hover poll as above, for the same late settings push.
      await expect
        .poll(
          async () => {
            await page.mouse.move(900, 400);
            await page.getByTestId('sidebar-expand-zone').hover();
            await page.waitForTimeout(250); // past the 150ms hover intent
            return pin.count();
          },
          { timeout: 20_000 }
        )
        .toBe(1);

      // Straight at the pin's final spot, mid-ease. Its box is read from the
      // laid-out button, which is already at the column's final edge.
      const box = (await pin.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y, { steps: 10 });
      await expect(pin).toBeVisible();
      await page.mouse.click(x, y);

      // Docked. Collapse again with the pointer still parked where the pin
      // was — inside the wrapper, so no mouseleave has cleared the peek flag.
      // The column must close, not drop straight back into a peek.
      await page.waitForTimeout(400); // the column's 300ms ease
      expect(await columnWidth(page)).toBe(DEFAULT_W);
      await expect(page.getByTestId('sidebar-expand-zone')).toHaveCount(0);
      await expect(pin).toHaveCount(0);
      await page.keyboard.press('ControlOrMeta+BracketLeft');
      await page.waitForTimeout(600);
      expect(await columnWidth(page)).toBe(0);
      await expect(pin).toHaveCount(0);

      // Docked from there (by keyboard: a pointer on the edge would peek
      // first), it stays docked once the pointer leaves.
      await page.keyboard.press('ControlOrMeta+BracketLeft');
      await page.mouse.move(900, 400);
      await expect(sash(page)).toBeVisible();
      await page.waitForTimeout(600);
      expect(await columnWidth(page)).toBe(DEFAULT_W);

      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      await expect.poll(() => columnWidth(page)).toBe(0);
    });
    /**
     * The other half of the same bug: a peek that opened the instant the
     * pointer arrived swapped the expand zone out before a click could land,
     * so throwing the mouse at the edge and clicking only ever peeked.
     */
    test('a click on the edge still docks the column', async ({ page }) => {
      await setUserSetting(page, { left_sidebar_hover: true });
      await reloadApp(page);

      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      await expect.poll(() => columnWidth(page)).toBe(0);

      // Wait for the setting to land (a resting pointer peeks), then leave.
      await expect
        .poll(
          async () => {
            await page.mouse.move(900, 400);
            await page.getByTestId('sidebar-expand-zone').hover();
            await page.waitForTimeout(250);
            return page.getByTestId('sidebar-peek-pin').count();
          },
          { timeout: 20_000 }
        )
        .toBe(1);
      await page.mouse.move(900, 400);
      await expect.poll(() => columnWidth(page)).toBe(0);

      await page.getByTestId('sidebar-expand-zone').click();
      await page.mouse.move(900, 400);
      await expect(sash(page)).toBeVisible();
      await page.waitForTimeout(600);
      expect(await columnWidth(page)).toBe(DEFAULT_W);
    });
  });

  test('the sash is gone while the sidebar is collapsed', async ({ page }) => {
    // A sash pinned to a zero-width column would sit at the window's left edge,
    // on top of the expand affordance.
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    await expect(sash(page)).toHaveCount(0);

    // ...and comes back, at the width it was left at, when the column reopens.
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(sash(page)).toBeVisible();
    await expect.poll(() => columnWidth(page)).toBe(DEFAULT_W);
  });
});
