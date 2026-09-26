import { test, expect } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { reloadApp, itemCardIn, runEntityCommand, switchMobileTab } from './helpers/app';
import {
  createTestHabit,
  createTestTask,
  cleanupTestData,
  cleanupByTitlePrefix,
  fetchTestItem,
  setUserSetting,
  resetUserSettings,
  specScope,
} from './helpers/api';
import { getTodayStr, getDateStr } from './helpers/dates';

/**
 * Pausing (memory/plans/programs-routines.md, Phase 1).
 *
 * The contract under test is narrow but load-bearing: a paused item leaves
 * every surface that would ask something of you, keeps everything it had, and
 * stays reachable from exactly one place — the braindump's Paused section. The
 * last part is what separates "paused" from "lost".
 *
 * Serial, because two tests flip a user_settings flag on a SHARED test user.
 *
 * Under its own prefix: this file's assertions are all id-scoped, so it never
 * needed an empty board — only its own leftovers gone. Sweeping the bare
 * TEST_TITLE_PREFIX bought it nothing and hard-DELETEd every concurrent spec's
 * fixtures mid-test under `fullyParallel` + 4 workers.
 */
const scope = specScope('pause');

test.describe('pausing', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await loginTestUser(page);
    await cleanupByTitlePrefix(page, scope.prefix);
    await reloadApp(page);
  });

  test.afterEach(async ({ page }) => {
    await resetUserSettings(page);
  });

  /** The grid, scoped — an unscoped item-card locator would also match the Paused section. */
  const timeline = (page: import('@playwright/test').Page) =>
    page.locator('[data-tour="timeline"]');

  const pausedSection = (page: import('@playwright/test').Page) =>
    page.getByTestId('braindump-paused-section');

  async function openPausedSection(page: import('@playwright/test').Page) {
    // Collapsed by default, and GroupSection-style collapse UNMOUNTS children —
    // so without expanding, "present in Paused" fails and "absent everywhere"
    // passes for the wrong reason.
    await page.getByTestId('braindump-paused-toggle').click();
  }

  test('a paused habit leaves the grid, keeps its streak, and is reachable in Paused', async ({
    page,
  }) => {
    const title = scope.title('habit');
    const habitId = await createTestHabit(page, { title, timeBucket: 'morning', streak: 4 });
    try {
      await reloadApp(page);

      // Baseline: it is on the grid before anything happens.
      await expect(itemCardIn(timeline(page), habitId)).toHaveCount(1);

      // Pause through the UI the user actually has.
      await itemCardIn(timeline(page), habitId).click();
      await page.getByTestId('item-dialog-pause').click();

      await expect(itemCardIn(timeline(page), habitId)).toHaveCount(0);

      await openPausedSection(page);
      await expect(itemCardIn(pausedSection(page), habitId)).toHaveCount(1);

      // It survives a reload — the write reached the DB rather than living in
      // optimistic state (the exact failure a missing allowlist entry causes).
      await reloadApp(page);
      await expect(itemCardIn(timeline(page), habitId)).toHaveCount(0);

      // The whole promise: nothing else moved.
      const stored = await fetchTestItem(page, habitId);
      expect(stored).not.toBeNull();
      expect(stored!.streak).toBe(4);
      expect(stored!.pausedAt).toBeTruthy();
      expect(stored!.status).toBe('pending');
      expect(stored!.timeBucket).toBe('morning');
      expect(stored!.completedDates).toEqual([]);
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });

  test('resuming puts it back exactly where it was', async ({ page }) => {
    const title = scope.title('resume-habit');
    const habitId = await createTestHabit(page, { title, timeBucket: 'morning', streak: 2 });
    try {
      await reloadApp(page);
      await itemCardIn(timeline(page), habitId).click();
      await page.getByTestId('item-dialog-pause').click();
      await expect(itemCardIn(timeline(page), habitId)).toHaveCount(0);

      await openPausedSection(page);
      await itemCardIn(pausedSection(page), habitId).click();
      await page.getByTestId('item-dialog-resume').click();

      await expect(itemCardIn(timeline(page), habitId)).toHaveCount(1);

      const stored = await fetchTestItem(page, habitId);
      expect(stored!.streak).toBe(2);
      expect(stored!.timeBucket).toBe('morning');
      // Resume records the resume date rather than clearing the pair — that
      // interval is what the auto-age sweep's grace period reads.
      expect(stored!.pausedAt).toBeTruthy();
      expect(stored!.pausedUntil).toBe(getTodayStr());
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });

  /**
   * The history rule (locked decision 4). Getting this backwards is how pausing
   * silently rewrites the past, so it is worth a test of its own: a day that
   * was already answered keeps its row even though the item is paused.
   */
  test('a day already marked keeps its row after the item is paused', async ({ page }) => {
    const title = scope.title('marked');
    const habitId = await createTestHabit(page, {
      title,
      timeBucket: 'morning',
      streak: 1,
      completedDates: [getTodayStr()],
    });
    try {
      await reloadApp(page);
      await itemCardIn(timeline(page), habitId).click();
      await page.getByTestId('item-dialog-pause').click();

      // Still there: it is history now, not an open loop.
      await expect(itemCardIn(timeline(page), habitId)).toHaveCount(1);
      // And it is NOT offered as something to recover.
      await expect(pausedSection(page)).toHaveCount(0);
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });

  test('a paused task leaves the past-due bar', async ({ page }) => {
    // The bar is disabled in the seeded settings, so a naive assertion would
    // pass vacuously — prove it renders the item FIRST.
    await setUserSetting(page, { morning_check_enabled: true });
    const title = scope.title('overdue');
    const taskId = await createTestTask(page, { title, startDate: getDateStr(-3) });
    // An anchor, so the bar survives the pause. At count 0 with the tray shut,
    // `visible` goes false (morning-check.tsx) and the ENTIRE bar unmounts —
    // there would be nothing left to click, and the test would die on the
    // timeout rather than report anything about pausing.
    const anchorId = await createTestTask(page, {
      title: scope.title('anchor'),
      startDate: getDateStr(-2),
    });
    try {
      await reloadApp(page);
      // Prove the bar counts it before pausing, or the assertion below could
      // pass for any number of unrelated reasons.
      const bar = page.getByTestId('morning-bar');
      await expect(bar).toBeVisible();
      await bar.locator('button').first().click();
      // The tray ships a THIRD row shape (see task-row.tsx's header) — these
      // are `morning-row-<id>`, NOT item-card, and carry no data-item-id.
      await expect(page.getByTestId(`morning-row-${taskId}`)).toHaveCount(1);
      await page.keyboard.press('Escape');

      // Pause through the palette — the verb that reaches an item no view is
      // currently showing. Entity argument, so it is two interactions, and the
      // picker must be narrowed by title or the fixture falls outside
      // PICKER_LIMIT on the shared user.
      await runEntityCommand(page, 'items.pause', taskId, title, { query: '/pause' });

      await bar.locator('button').first().click();
      await expect(page.getByTestId(`morning-row-${taskId}`)).toHaveCount(0);
      // …and the bar still counts the work that was NOT paused, so the
      // assertion above cannot pass merely because the tray failed to open.
      await expect(page.getByTestId(`morning-row-${anchorId}`)).toHaveCount(1);
    } finally {
      await cleanupTestData(page, [taskId, anchorId], []);
    }
  });

  test('@mobile pause and resume from the action sheet', async ({ page }) => {
    const title = scope.title('mobile');
    const habitId = await createTestHabit(page, { title, timeBucket: 'morning', streak: 3 });
    try {
      await reloadApp(page);
      await switchMobileTab(page, 'today');

      const row = page.locator(`[data-testid="item-card"][data-item-id="${habitId}"]`).first();
      await row.locator('[data-testid="item-actions-button"]').click();
      await page.getByTestId('sheet-pause-button').click();
      await expect(row).toHaveCount(0);

      // Reachable on touch: the Braindump tab's Paused section, which is the
      // only place a paused row exists on mobile.
      await switchMobileTab(page, 'braindump');
      await openPausedSection(page);
      await expect(itemCardIn(pausedSection(page), habitId)).toHaveCount(1);

      const stored = await fetchTestItem(page, habitId);
      expect(stored!.streak).toBe(3);
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });
});
