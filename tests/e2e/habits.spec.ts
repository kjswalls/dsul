import { test, expect } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { TEST_TITLE_PREFIX } from './helpers/env';
import {
  createTestHabit,
  cleanupTestData,
  cleanupByTitlePrefix,
  fetchTestHabit,
  fetchTestItem,
  testTitle,
} from './helpers/api';
import {
  reloadApp,
  itemCard,
  completeButton,
  expectCompleted,
  bucket,
  navigateToDate,
} from './helpers/app';
import { dragTo, dragItemToBucket } from './helpers/dnd';
import { getTodayStr, getDateStr } from './helpers/dates';

/**
 * Habits: completing, un-completing, skipping, counting, streaks, and moving
 * them by drag.
 *
 * This is the app's least-covered core surface. Before this file the only habit
 * coverage was two cases inside recurring.spec.ts, both of which failed at their
 * first navigation. Every assertion here reads `data-*` state rather than
 * Tailwind classes so the file survives the redesign.
 *
 * Habit facts these tests encode (see memory/plans/unified-items.md):
 *  - Completion is per-DATE in `completedDates`; the scalar `status` is only a
 *    denormalised "last toggle" snapshot.
 *  - Streak is an opaque stored counter, +1/−1 per toggle, owned server-side by
 *    the set_item_completion RPC. Resetting it must NOT touch completedDates.
 *  - Habits are un-anchored: they render on every matching day, with no start
 *    date to gate them.
 */
test.describe('Habits', { tag: '@exclusive-habits' }, () => {
  // Serial, on a CLEARED board.
  //
  // Three tests here drag (bucket, timed, and the braindump no-op), and
  // closestCenter resolves drops by comparing rect CENTRES: which zones exist at
  // all is data-dependent — scheduled:{bucket}:empty only renders when the bucket
  // has no timed items, and the height of unscheduled:{bucket} depends on how
  // many untimed rows sit in it. So leftovers from other specs silently move
  // every centre on the board and a drop lands one zone off.
  //
  // The bare sweep is therefore correct here for the same reason it is in
  // dnd.spec — an empty board is the requirement, not a clean prefix — and safe
  // for the same reason: `@exclusive-habits` puts this file in its own project,
  // sequenced by `dependencies` after every other project INCLUDING dnd, so
  // nothing is running concurrently when it fires. The two of them would
  // otherwise delete each other, which a per-file `mode: 'serial'` cannot
  // prevent.
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await loginTestUser(page);
    await cleanupByTitlePrefix(page, TEST_TITLE_PREFIX);
    await reloadApp(page);
  });

  test('completing a habit marks it done, bumps the streak, and persists', async ({ page }) => {
    const title = testTitle('habit_complete');
    const habitId = await createTestHabit(page, { title, timeBucket: 'morning', streak: 4 });

    try {
      await reloadApp(page);

      const row = itemCard(page, habitId);
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute('data-item-kind', 'habit');
      await expectCompleted(page, habitId, false);
      await expect(row.getByTestId('item-streak')).toHaveText('4');

      await completeButton(page, habitId).click();

      await expectCompleted(page, habitId, true);
      await expect(row.getByTestId('item-streak')).toHaveText('5');

      // Survives a reload — this is the assertion the old smoke test omitted,
      // which let it pass whether or not completion persisted at all.
      await reloadApp(page);
      await expectCompleted(page, habitId, true);
      await expect(itemCard(page, habitId).getByTestId('item-streak')).toHaveText('5');

      // And the DB agrees, not just the rehydrated store.
      const persisted = await fetchTestHabit(page, habitId);
      expect(persisted?.completedDates).toContain(getTodayStr());
      expect(persisted?.streak).toBe(5);
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });

  test('un-completing a habit clears the date and decrements the streak', async ({ page }) => {
    const title = testTitle('habit_undo');
    const habitId = await createTestHabit(page, { title, timeBucket: 'morning', streak: 2 });

    try {
      await reloadApp(page);

      await completeButton(page, habitId).click();
      await expectCompleted(page, habitId, true);
      await expect(itemCard(page, habitId).getByTestId('item-streak')).toHaveText('3');

      // Click again — the undo path.
      await completeButton(page, habitId).click();
      await expectCompleted(page, habitId, false);
      await expect(itemCard(page, habitId).getByTestId('item-streak')).toHaveText('2');

      await reloadApp(page);
      await expectCompleted(page, habitId, false);

      const persisted = await fetchTestHabit(page, habitId);
      expect(persisted?.completedDates).not.toContain(getTodayStr());
      expect(persisted?.streak).toBe(2);
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });

  test('streak never goes below zero when un-completing at zero', async ({ page }) => {
    // greatest(0, streak - 1) in the RPC, mirrored optimistically by the store.
    const habitId = await createTestHabit(page, {
      title: testTitle('habit_zero'),
      timeBucket: 'morning',
      streak: 0,
    });

    try {
      await reloadApp(page);
      await completeButton(page, habitId).click();
      await expectCompleted(page, habitId, true);
      await completeButton(page, habitId).click();
      await expectCompleted(page, habitId, false);

      const persisted = await fetchTestHabit(page, habitId);
      expect(persisted?.streak).toBe(0);
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });

  test('completing a habit on one day leaves other days untouched', async ({ page }) => {
    // Per-date completion: the whole reason completedDates exists.
    const habitId = await createTestHabit(page, {
      title: testTitle('habit_perdate'),
      timeBucket: 'morning',
    });
    const tomorrow = getDateStr(1);

    try {
      await reloadApp(page);
      await completeButton(page, habitId).click();
      await expectCompleted(page, habitId, true);

      await navigateToDate(page, tomorrow);
      // Un-anchored: the habit renders tomorrow too, but undone there.
      await expect(itemCard(page, habitId)).toBeVisible();
      await expectCompleted(page, habitId, false);

      await navigateToDate(page, getTodayStr());
      await expectCompleted(page, habitId, true);

      const persisted = await fetchTestHabit(page, habitId);
      expect(persisted?.completedDates).toEqual([getTodayStr()]);
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });

  test('skipping a habit swaps the row for the skipped strip, and unskip restores it', async ({
    page,
  }) => {
    const habitId = await createTestHabit(page, {
      title: testTitle('habit_skip'),
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);

      const row = itemCard(page, habitId);
      await expect(row).toHaveAttribute('data-row-variant', 'default');

      // The skip control only reveals on hover, so hover the row first.
      await row.hover();
      await row.getByTestId('item-skip-button').click();

      // A skipped habit is a different DOM shape: no complete button, no rail.
      const skipped = itemCard(page, habitId);
      await expect(skipped).toHaveAttribute('data-row-variant', 'skipped');
      await expect(skipped.getByTestId('item-complete-button')).toHaveCount(0);

      await reloadApp(page);
      await expect(itemCard(page, habitId)).toHaveAttribute('data-row-variant', 'skipped');

      await itemCard(page, habitId).getByTestId('item-unskip-button').click();
      await expect(itemCard(page, habitId)).toHaveAttribute('data-row-variant', 'default');
      await expectCompleted(page, habitId, false);

      const persisted = await fetchTestHabit(page, habitId);
      expect(persisted?.skippedDates ?? []).not.toContain(getTodayStr());
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });

  test('a multi-count habit steps up and down and completes at target', async ({ page }) => {
    const habitId = await createTestHabit(page, {
      title: testTitle('habit_count'),
      timeBucket: 'morning',
      timesPerDay: 3,
    });

    try {
      await reloadApp(page);

      const row = itemCard(page, habitId);
      const count = row.getByTestId('item-count');
      await expect(count).toHaveText('0/3');
      await expectCompleted(page, habitId, false);

      // The checkbox counts up on a multi-count habit rather than completing it.
      await completeButton(page, habitId).click();
      await expect(itemCard(page, habitId).getByTestId('item-count')).toHaveText('1/3');
      await expectCompleted(page, habitId, false);

      // Stepper down, then up to target.
      //
      // Each step is asserted before the next click. The controls are
      // opacity-0 + pointer-events-none until the row is hovered, and every
      // click re-renders the row — so firing clicks back to back races the
      // re-render and drops one.
      const step = async (dir: 'inc' | 'dec', expectCount: string) => {
        const row = itemCard(page, habitId);
        await row.hover();
        const control = row.getByTestId(`item-stepper-${dir}`);
        await expect(control).toBeVisible();
        await control.click();
        await expect(itemCard(page, habitId).getByTestId('item-count')).toHaveText(expectCount);
      };

      // Count UP through the checkbox, not the stepper: the stepper is
      // opacity-0 + pointer-events-none until the row is hovered, and every click
      // re-renders the row — so each extra hover-dependent interaction is another
      // chance to race the reveal. The checkbox is always present and increments a
      // multi-count habit, so it does the same job with none of that risk. The
      // stepper is still exercised, for the one thing only it can do: counting down.
      await step('dec', '0/3');

      await completeButton(page, habitId).click();
      await expect(itemCard(page, habitId).getByTestId('item-count')).toHaveText('1/3');
      await completeButton(page, habitId).click();
      await expect(itemCard(page, habitId).getByTestId('item-count')).toHaveText('2/3');
      await completeButton(page, habitId).click();
      await expect(itemCard(page, habitId).getByTestId('item-count')).toHaveText('3/3');

      await expectCompleted(page, habitId, true);

      await reloadApp(page);
      await expectCompleted(page, habitId, true);
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });

  test('resetting a streak zeroes the counter but keeps completion history', async ({ page }) => {
    // Locked invariant (memory/plans/unified-items.md): resetHabitStreak sends
    // { streak: 0 } ONLY — completedDates and dailyCounts are history, not
    // counters, and must survive.
    const title = testTitle('habit_reset');
    const habitId = await createTestHabit(page, { title, timeBucket: 'morning', streak: 9 });

    try {
      await reloadApp(page);
      await completeButton(page, habitId).click();
      await expectCompleted(page, habitId, true);

      // Open the item dialog from the row, then the overflow menu. Clicking the
      // title (not the row centre) keeps the click off the rail, whose controls
      // stopPropagation and would swallow it.
      await itemCard(page, habitId).getByText(title, { exact: true }).click();
      const dialog = page.getByTestId('item-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('data-mode', 'edit');

      await dialog.getByTestId('item-dialog-more').click();
      await page.getByTestId('item-dialog-reset-streak').click();
      await page.getByTestId('reset-streak-confirm-accept').click();

      const persisted = await fetchTestHabit(page, habitId);
      expect(persisted?.streak).toBe(0);
      // The point of the test: history survived.
      expect(persisted?.completedDates).toContain(getTodayStr());
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });

  test('dragging a habit to another bucket reassigns it and persists', async ({ page }) => {
    const habitId = await createTestHabit(page, {
      title: testTitle('habit_drag'),
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      await expect(itemCard(page, habitId)).toBeVisible();
      await expect(itemCard(page, habitId)).toHaveAttribute('data-bucket', 'morning');

      // Afternoon, not evening: an ADJACENT bucket needs no autoscroll. See the
      // KNOWN LIMIT note in helpers/dnd.ts — a drag across a scroll boundary is
      // not deterministically drivable, and the store action here is identical
      // either way, so the extra distance would buy flakiness and no coverage.
      await dragItemToBucket(page, habitId, 'afternoon');

      await expect(itemCard(page, habitId)).toHaveAttribute('data-bucket', 'afternoon');
      await expect(bucket(page, 'afternoon').locator(`[data-item-id="${habitId}"]`)).toHaveCount(1);
      await expect(bucket(page, 'morning').locator(`[data-item-id="${habitId}"]`)).toHaveCount(0);

      await reloadApp(page);
      await expect(itemCard(page, habitId)).toHaveAttribute('data-bucket', 'afternoon');

      const persisted = await fetchTestHabit(page, habitId);
      expect(persisted?.timeBucket).toBe('afternoon');
      // The untimed zone must NOT set a time — the timed-zone test asserts the
      // inverse, and assignHabitToBucket explicitly clears startTime.
      expect(persisted?.startTime ?? null).toBeNull();
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });

  test('dropping a habit on a timed zone gives it a start time', async ({ page }) => {
    // unscheduled:{bucket} → assignHabitToBucket (clears startTime);
    // scheduled:{bucket}:empty → scheduleHabit with an inferred time.
    const habitId = await createTestHabit(page, {
      title: testTitle('habit_timed'),
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      await expect(itemCard(page, habitId)).toHaveAttribute('data-start-time', '');

      await dragItemToBucket(page, habitId, 'afternoon', 'timed');

      await expect(itemCard(page, habitId)).toHaveAttribute('data-bucket', 'afternoon');
      await expect(itemCard(page, habitId)).toHaveAttribute('data-start-time', /^\d{2}:\d{2}$/);

      const persisted = await fetchTestHabit(page, habitId);
      expect(persisted?.startTime).toMatch(/^\d{2}:\d{2}$/);
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });

  test('dragging a habit to the braindump pauses it', async ({ page }) => {
    // A habit on the canvas recurs and has no day to take away, so a drop on
    // the braindump pauses it (lib/dnd/handle-drag-end.ts, `pause-item`). It used
    // to be a no-op, and this test still asserted that while the drag tail sat
    // unrun behind the red front of the suite. What must hold either way: the
    // habit keeps its bucket and is never unscheduled into the braindump list.
    const habitId = await createTestHabit(page, {
      title: testTitle('habit_pausedrop'),
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      await expect(itemCard(page, habitId)).toHaveAttribute('data-bucket', 'morning');

      // The braindump reports hover, so the drag genuinely lands there.
      await dragTo(
        page,
        itemCard(page, habitId),
        page.locator('[data-dnd-id="sidebar"]'),
        { scrollHint: page.getByTestId('braindump') }
      );

      // Off the grid, into nothing but the braindump's Paused section.
      await expect(page.locator(`[data-tour="timeline"] [data-item-id="${habitId}"]`)).toHaveCount(0);

      const stored = await fetchTestItem(page, habitId);
      expect(stored).not.toBeNull();
      expect(stored!.pausedAt).toBeTruthy();
      expect(stored!.timeBucket).toBe('morning');
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });
});
