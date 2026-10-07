import { test, expect } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { TEST_TITLE_PREFIX } from './helpers/env';
import {
  createTestTask,
  cleanupTestData,
  cleanupByTitlePrefix,
  fetchTestTask,
  testTitle,
} from './helpers/api';
import { getTodayStr } from './helpers/dates';
import { dragTo, dragItemToBucket, pressPoint } from './helpers/dnd';
import { reloadApp, itemCard, bucket } from './helpers/app';

/**
 * ACCEPTANCE GATE for the droppable-ID contract in lib/dnd/CONTRACT.md.
 *
 * The stable hooks these assert against:
 *   [data-dnd-bucket="{bucket}"]   bucket section container
 *   [data-dnd-id="{id}"]           every contract droppable, by its id
 *   [data-dnd-over="true"]         that droppable currently reporting hover
 *
 * Views may restyle and restructure freely but MUST keep these attributes on the
 * equivalent droppables. Do not change the id grammar without updating CONTRACT.md
 * and this spec together.
 *
 * `data-dnd-over` is new and load-bearing: it is what lets a drag wait for the app
 * to confirm the drop target instead of sleeping. See helpers/dnd.ts, which also
 * records why geometry aiming alone cannot be made reliable here.
 */
test.describe('Drag and drop flows', { tag: '@exclusive-dnd' }, () => {
  // Serial, on a CLEARED board.
  //
  // These are the geometry-sensitive tests. closestCenter resolves drops by
  // comparing rect CENTRES, and which zones exist at all is data-dependent:
  // scheduled:{bucket}:empty only renders when the bucket has no timed items, and
  // the height of unscheduled:{bucket} depends on how many untimed rows sit in it.
  // So leftovers from other specs silently move every centre on the board and a
  // drop lands one zone off. Sweeping the suite-prefixed fixtures first makes the
  // geometry a function of this test alone.
  //
  // THE SWEEP IS BARE ON PURPOSE, and it is the one place in the suite where that
  // is correct: this file needs an EMPTY board, not merely its own rows gone, so
  // a per-spec prefix would not buy it anything. What made it destructive was
  // running CONCURRENTLY with specs whose fixtures it was deleting. It no longer
  // does — the `@exclusive-dnd` tag puts this file in its own project, which
  // `dependencies` sequences after every other project has finished (see
  // playwright.config.ts). Nothing else is running when this sweep fires.
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await loginTestUser(page);
    await cleanupByTitlePrefix(page, TEST_TITLE_PREFIX);
    await reloadApp(page);
  });

  test('dragging a task to a neighbouring bucket reassigns it and persists', async ({ page }) => {
    const taskId = await createTestTask(page, {
      title: testTitle('dnd_bucket'),
      startDate: getTodayStr(),
      isScheduled: true,
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      await expect(itemCard(page, taskId)).toBeVisible();
      await expect(itemCard(page, taskId)).toHaveAttribute('data-bucket', 'morning');

      await dragItemToBucket(page, taskId, 'afternoon');

      await expect(itemCard(page, taskId)).toHaveAttribute('data-bucket', 'afternoon');
      await expect(bucket(page, 'afternoon').locator(`[data-item-id="${taskId}"]`)).toHaveCount(1);
      await expect(bucket(page, 'morning').locator(`[data-item-id="${taskId}"]`)).toHaveCount(0);

      // Persisted, not just optimistic.
      await reloadApp(page);
      await expect(itemCard(page, taskId)).toHaveAttribute('data-bucket', 'afternoon');
      const persisted = await fetchTestTask(page, taskId);
      expect(persisted?.timeBucket).toBe('afternoon');
    } finally {
      await cleanupTestData(page, [taskId]);
    }
  });

  test('dropping a task on a timed zone schedules it with a time', async ({ page }) => {
    // The two bucket droppables differ in what they WRITE, not in where the row
    // lands: unscheduled:{bucket} leaves startTime empty, scheduled:{bucket}:empty
    // fills it from inferDropTime. Invisible in the list, so it needs asserting.
    const taskId = await createTestTask(page, {
      title: testTitle('dnd_timed'),
      startDate: getTodayStr(),
      isScheduled: true,
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      await expect(itemCard(page, taskId)).toHaveAttribute('data-start-time', '');

      await dragItemToBucket(page, taskId, 'afternoon', 'timed');

      await expect(itemCard(page, taskId)).toHaveAttribute('data-bucket', 'afternoon');
      await expect(itemCard(page, taskId)).toHaveAttribute('data-start-time', /^\d{2}:\d{2}$/);

      const persisted = await fetchTestTask(page, taskId);
      expect(persisted?.startTime).toMatch(/^\d{2}:\d{2}$/);
      expect(persisted?.timeBucket).toBe('afternoon');
    } finally {
      await cleanupTestData(page, [taskId]);
    }
  });

  test('dragging a task to the braindump unschedules it', async ({ page }) => {
    const taskId = await createTestTask(page, {
      title: testTitle('dnd_unschedule'),
      startDate: getTodayStr(),
      isScheduled: true,
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      await expect(itemCard(page, taskId)).toBeVisible();

      await dragTo(page, itemCard(page, taskId), page.locator('[data-dnd-id="sidebar"]'), {
        scrollHint: page.getByTestId('braindump'),
      });

      await expect(bucket(page, 'morning').locator(`[data-item-id="${taskId}"]`)).toHaveCount(0);
      await expect(
        page.getByTestId('braindump').locator(`[data-item-id="${taskId}"]`)
      ).toHaveCount(1);

      // Same race as the scheduling drag below — poll the row before reloading,
      // or the reload can abort the unscheduling PATCH and re-read a task that
      // is still scheduled.
      await expect
        .poll(async () => (await fetchTestTask(page, taskId))?.isScheduled)
        .toBe(false);

      await reloadApp(page);
      const persisted = await fetchTestTask(page, taskId);
      expect(persisted?.isScheduled).toBe(false);
    } finally {
      await cleanupTestData(page, [taskId]);
    }
  });

  test('dragging a braindump task into a bucket schedules it there', async ({ page }) => {
    const taskId = await createTestTask(page, {
      title: testTitle('dnd_schedule'),
      isScheduled: false,
    });

    try {
      await reloadApp(page);
      await expect(
        page.getByTestId('braindump').locator(`[data-item-id="${taskId}"]`)
      ).toHaveCount(1);

      await dragItemToBucket(page, taskId, 'morning');

      await expect(bucket(page, 'morning').locator(`[data-item-id="${taskId}"]`)).toHaveCount(1);
      await expect(
        page.getByTestId('braindump').locator(`[data-item-id="${taskId}"]`)
      ).toHaveCount(0);

      // The two assertions above prove the OPTIMISTIC render — dnd-kit's drop
      // handler calls updateItem, which sets the store and fires its PATCH
      // fire-and-forget (`.catch(console.error)`). Reloading straight after can
      // abort that request in flight, and the reload then re-reads the row the
      // drag never changed. Poll the stored value first, so the reload below is
      // proving durability rather than racing the write that creates it.
      await expect
        .poll(async () => (await fetchTestTask(page, taskId))?.isScheduled)
        .toBe(true);

      await reloadApp(page);
      const persisted = await fetchTestTask(page, taskId);
      expect(persisted?.isScheduled).toBe(true);
      expect(persisted?.timeBucket).toBe('morning');
      expect(persisted?.startDate).toBe(getTodayStr());
    } finally {
      await cleanupTestData(page, [taskId]);
    }
  });

  test('every contract droppable exists and reports its own hover state', async ({ page }) => {
    // Guards the DOM markers themselves, which CONTRACT.md nominates as the change
    // gate. Three contract droppables used to emit no attribute at all, so a drop
    // could silently resolve to one of them and no test could tell — and because
    // collision is closestCenter, that near-miss is the likely failure, not a rare
    // one.
    const taskId = await createTestTask(page, {
      title: testTitle('dnd_contract'),
      startDate: getTodayStr(),
      isScheduled: true,
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      const row = itemCard(page, taskId);
      await row.scrollIntoViewIfNeeded();
      const at = await pressPoint(row);

      // Start a drag so the drag-only droppables mount, then inventory them.
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      try {
        await page.mouse.move(at.x + 12, at.y, { steps: 3 });
        // Morning's own untimed section exists without a drag (it holds this
        // row), so wait on one that only a live drag mounts.
        await expect(page.locator('[data-dnd-id="unscheduled:evening"]')).toBeAttached();

        const ids = await page
          .locator('[data-dnd-id]')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-dnd-id')));

        for (const b of ['anytime', 'morning', 'afternoon', 'evening']) {
          expect(ids, `bare bucket droppable "${b}" missing`).toContain(b);
          expect(ids, `unscheduled:${b} missing`).toContain(`unscheduled:${b}`);
        }
        expect(ids, 'sidebar droppable missing').toContain('sidebar');

        // Every droppable must carry the hover marker, or a drag cannot wait on it.
        const withoutOver = await page
          .locator('[data-dnd-id]:not([data-dnd-over])')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-dnd-id')));
        expect(withoutOver, 'droppables missing data-dnd-over').toEqual([]);
      } finally {
        await page.mouse.up();
      }
    } finally {
      await cleanupTestData(page, [taskId]);
    }
  });
});
