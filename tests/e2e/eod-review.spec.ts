import { test, expect } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { getAccessToken, createTestTask, cleanupTestData, testTitle } from './helpers/api';
import { getTodayStr, getTomorrowStr } from './helpers/dates';
import { reloadApp, gotoApp, runCommand, navigateToDate, itemCard } from './helpers/app';

/**
 * Open the EOD review through the command palette.
 *
 * It used to be opened by `getByTitle('[DEV] Trigger EOD review')` — a button
 * deleted in commit 016a2aa, when the two [DEV] emoji triggers became real
 * commands ("The two [DEV] emoji triggers that used to sit on the right are gone:
 * 'Show overdue tasks' and 'Start end-of-day review' are real commands in the
 * palette now", components/shell/desktop-shell.tsx). That single dead selector
 * failed in a beforeEach-shaped helper and took 9 of this file's 10 tests with it.
 */
async function openEODReview(page: import('@playwright/test').Page) {
  await runCommand(page, 'rituals.eod');
  await expect(page.getByRole('dialog', { name: 'End of day' })).toBeVisible({ timeout: 10_000 });
}

test.describe('End of day (EOD) review modal', () => {
  test.beforeEach(async ({ page }) => {
    await loginTestUser(page);
  });

  test('EOD modal opens from the command palette', async ({ page }) => {
    await openEODReview(page);

    const dialog = page.getByRole('dialog', { name: 'End of day' });
    await expect(dialog).toBeVisible();

    // The dialog title should contain "End of day"
    await expect(dialog.getByRole('heading', { name: 'End of day' })).toBeVisible();

    // Close it
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('marking a task done inside EOD makes it undoable in place', async ({ page }) => {
    const TODAY = getTodayStr();
    const accessToken = await getAccessToken(page);

    // Create exactly one pending task for today.
    const taskTitle = testTitle('eod-complete');
    const taskId = await createTestTask(page, accessToken, {
      title: taskTitle,
      startDate: TODAY,
      isScheduled: true,
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);

      // Wait for the task to appear in the timeline, ensuring the store has loaded
      // before opening the EOD modal (the modal snapshots livePendingTasks on open).
      await expect(page.locator('[data-tour="timeline"]').getByText(taskTitle)).toBeVisible({ timeout: 10_000 });

      await openEODReview(page);
      const dialog = page.getByRole('dialog', { name: 'End of day' });

      // The task should be in the "Carrying forward" section as a pending task.
      await expect(dialog.getByText(taskTitle)).toBeVisible({ timeout: 5_000 });

      // Mark it done from its own row, addressed by id.
      //
      // The old selectors here were wrong three ways and are worth naming so they
      // do not come back: the section was called "Carrying forward" (it is "Still
      // on your list"), the completed section was "Wrapped up today" (it is "Done
      // today"), and — the substantive one — a task completed DURING the session is
      // deliberately EXCLUDED from the done section and stays in the pending list
      // with a filled circle so it can be un-done (`preExistingCompletedTasks`
      // filters out `justCompletedIds`, components/ai/eod-review.tsx). So the old
      // assertion could never pass: it asserted the opposite of the design.
      const row = dialog.getByTestId(`eod-task-row-${taskId}`);
      await expect(row).toBeVisible({ timeout: 5_000 });
      await row.getByTitle('Mark as done').click();

      // It stays in place and its circle button becomes the undo control — the
      // action pills (eod-undo-btn among them) are hidden once isDone, so that
      // testid is NOT the done-row affordance.
      await expect(row.getByTitle('Undo')).toBeVisible({ timeout: 5_000 });
      await expect(row.getByTitle('Mark as done')).toHaveCount(0);

      // Un-done again, back to the pills.
      await row.getByTitle('Undo').click();
      await expect(row.getByTitle('Mark as done')).toBeVisible({ timeout: 5_000 });
    } finally {
      await cleanupTestData(page, accessToken, [taskId]);
    }
  });

  test('rolling over a task from EOD moves it to tomorrow', async ({ page }) => {
    const TODAY = getTodayStr();
    const accessToken = await getAccessToken(page);
    const taskTitle = testTitle('eod-rollover');
    const taskId = await createTestTask(page, accessToken, {
      title: taskTitle,
      startDate: TODAY,
      isScheduled: true,
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);

      // Wait for the task to appear in the timeline before opening EOD modal.
      await expect(page.locator('[data-tour="timeline"]').getByText(taskTitle)).toBeVisible({ timeout: 10_000 });

      await openEODReview(page);
      const dialog = page.getByRole('dialog', { name: 'End of day' });

      // The task should appear in "Carrying forward".
      await expect(dialog.getByText(taskTitle)).toBeVisible({ timeout: 5_000 });

      // Click the "Tomorrow →" pill button for this task.
      await page.getByTestId(`eod-tomorrow-btn-${taskId}`).click();

      // Close the dialog
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();

      // Task should no longer appear in today's timeline after rollover.
      await expect(page.locator('[data-tour="timeline"]').getByText(taskTitle)).not.toBeVisible();

      // Navigate to tomorrow.
      const nextDayBtn = page.locator('button').filter({
        has: page.locator('svg.lucide-chevron-right'),
      }).first();
      await nextDayBtn.click();

      // The task should now appear on tomorrow's view (scope to timeline).
      await expect(page.locator('[data-tour="timeline"]').getByText(taskTitle)).toBeVisible({ timeout: 5_000 });
    } finally {
      // The task's startDate is now TOMORROW — cleanup still works by id.
      await cleanupTestData(page, accessToken, [taskId]);
    }
  });

  test('dismiss task clears scheduled date', async ({ page }) => {
    const TODAY = getTodayStr();
    const accessToken = await getAccessToken(page);
    const taskTitle = testTitle('eod-dismiss');
    const taskId = await createTestTask(page, accessToken, {
      title: taskTitle,
      startDate: TODAY,
      isScheduled: true,
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      await expect(page.locator('[data-tour="timeline"]').getByText(taskTitle)).toBeVisible({ timeout: 10_000 });

      await openEODReview(page);
      const dialog = page.getByRole('dialog', { name: 'End of day' });
      await expect(dialog.getByText(taskTitle)).toBeVisible({ timeout: 5_000 });

      // Click the ✕ dismiss button
      await page.getByTestId(`eod-dismiss-btn-${taskId}`).click();

      // Undo link should appear for the dismissed task, and pills should be gone
      await expect(page.getByTestId(`eod-undo-btn-${taskId}`)).toBeVisible({ timeout: 3_000 });
      await expect(page.getByTestId(`eod-dismiss-btn-${taskId}`)).not.toBeVisible();

      // Close dialog and confirm task is no longer on today's timeline
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-tour="timeline"]').getByText(taskTitle)).not.toBeVisible();
    } finally {
      await cleanupTestData(page, accessToken, [taskId]);
    }
  });

  test('date picker reschedules task to selected date', async ({ page }) => {
    const TODAY = getTodayStr();
    const TOMORROW = getTomorrowStr();
    const accessToken = await getAccessToken(page);
    const taskTitle = testTitle('eod-datepicker');
    const taskId = await createTestTask(page, accessToken, {
      title: taskTitle,
      startDate: TODAY,
      isScheduled: true,
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      await expect(page.locator('[data-tour="timeline"]').getByText(taskTitle)).toBeVisible({ timeout: 10_000 });

      await openEODReview(page);
      const dialog = page.getByRole('dialog', { name: 'End of day' });
      await expect(dialog.getByText(taskTitle)).toBeVisible({ timeout: 5_000 });

      // Click the 📅 date picker button (opens Popover on desktop)
      await page.getByTestId(`eod-datepicker-btn-${taskId}`).click();

      // Wait for the Calendar popover to be visible
      const popover = page.locator('[data-radix-popper-content-wrapper]');
      await expect(popover).toBeVisible({ timeout: 3_000 });

      // Select tomorrow from the calendar.
      //
      // react-day-picker v9 labels day buttons through date-fns "PPPP", i.e.
      // "Wednesday, July 29th, 2026" (and prefixes "Today, " for today) — see
      // labelDayButton in the package. The old locator built "July 29, 2026",
      // which is NOT a substring of that, so it matched nothing. Tolerate the
      // ordinal rather than hardcoding it.
      const [ty, tm, td] = TOMORROW.split('-').map(Number);
      const monthName = new Date(Date.UTC(ty, tm - 1, td, 12)).toLocaleDateString('en-US', {
        month: 'long',
        timeZone: 'UTC',
      });
      await popover
        .getByRole('button', { name: new RegExp(`${monthName} ${td}(st|nd|rd|th)?, ${ty}`) })
        .click();

      // Undo link should appear and pills gone
      await expect(page.getByTestId(`eod-undo-btn-${taskId}`)).toBeVisible({ timeout: 3_000 });

      // Close and navigate to tomorrow to verify the task is there
      await page.keyboard.press('Escape');
      await navigateToDate(page, TOMORROW);
      await expect(itemCard(page, taskId)).toBeVisible({ timeout: 5_000 });
    } finally {
      await cleanupTestData(page, accessToken, [taskId]);
    }
  });

  test('move all to tomorrow moves all unactioned pending tasks', async ({ page }) => {
    const TODAY = getTodayStr();
    const accessToken = await getAccessToken(page);
    const title1 = testTitle('eod-move-all-a');
    const title2 = testTitle('eod-move-all-b');
    const taskId1 = await createTestTask(page, accessToken, { title: title1, startDate: TODAY, isScheduled: true, timeBucket: 'morning' });
    const taskId2 = await createTestTask(page, accessToken, { title: title2, startDate: TODAY, isScheduled: true, timeBucket: 'morning' });

    try {
      await reloadApp(page);
      await expect(page.locator('[data-tour="timeline"]').getByText(title1)).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('[data-tour="timeline"]').getByText(title2)).toBeVisible({ timeout: 10_000 });

      await openEODReview(page);
      const dialog = page.getByRole('dialog', { name: 'End of day' });
      await expect(dialog.getByText(title1)).toBeVisible({ timeout: 5_000 });
      await expect(dialog.getByText(title2)).toBeVisible({ timeout: 5_000 });

      // Click "Move all to tomorrow"
      await page.getByTestId('eod-move-all-btn').click();

      // Both tasks should now show Undo
      await expect(page.getByTestId(`eod-undo-btn-${taskId1}`)).toBeVisible({ timeout: 3_000 });
      await expect(page.getByTestId(`eod-undo-btn-${taskId2}`)).toBeVisible({ timeout: 3_000 });

      // Close and navigate to tomorrow
      await page.keyboard.press('Escape');
      const nextDayBtn = page.locator('button').filter({ has: page.locator('svg.lucide-chevron-right') }).first();
      await nextDayBtn.click();
      await expect(page.locator('[data-tour="timeline"]').getByText(title1)).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('[data-tour="timeline"]').getByText(title2)).toBeVisible({ timeout: 5_000 });
    } finally {
      await cleanupTestData(page, accessToken, [taskId1, taskId2]);
    }
  });

  test('move all skips already actioned tasks', async ({ page }) => {
    const TODAY = getTodayStr();
    const accessToken = await getAccessToken(page);
    const title1 = testTitle('eod-skip-actioned-a');
    const title2 = testTitle('eod-skip-actioned-b');
    const taskId1 = await createTestTask(page, accessToken, { title: title1, startDate: TODAY, isScheduled: true, timeBucket: 'morning' });
    const taskId2 = await createTestTask(page, accessToken, { title: title2, startDate: TODAY, isScheduled: true, timeBucket: 'morning' });

    try {
      await reloadApp(page);
      await expect(page.locator('[data-tour="timeline"]').getByText(title1)).toBeVisible({ timeout: 10_000 });

      await openEODReview(page);
      const dialog = page.getByRole('dialog', { name: 'End of day' });
      await expect(dialog.getByText(title1)).toBeVisible({ timeout: 5_000 });

      // Manually action task1 via Tomorrow pill first
      await page.getByTestId(`eod-tomorrow-btn-${taskId1}`).click();
      await expect(page.getByTestId(`eod-undo-btn-${taskId1}`)).toBeVisible({ timeout: 3_000 });

      // Now click "Move all to tomorrow" — should only affect task2
      await page.getByTestId('eod-move-all-btn').click();

      // Both show Undo (task2 was just actioned, task1 already was)
      await expect(page.getByTestId(`eod-undo-btn-${taskId1}`)).toBeVisible({ timeout: 3_000 });
      await expect(page.getByTestId(`eod-undo-btn-${taskId2}`)).toBeVisible({ timeout: 3_000 });

      // Close and verify on tomorrow's view — both should be there (both end up on tomorrow)
      await page.keyboard.press('Escape');
      const nextDayBtn = page.locator('button').filter({ has: page.locator('svg.lucide-chevron-right') }).first();
      await nextDayBtn.click();
      await expect(page.locator('[data-tour="timeline"]').getByText(title1)).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('[data-tour="timeline"]').getByText(title2)).toBeVisible({ timeout: 5_000 });
    } finally {
      await cleanupTestData(page, accessToken, [taskId1, taskId2]);
    }
  });

  test('undo reschedule restores task to today', async ({ page }) => {
    const TODAY = getTodayStr();
    const accessToken = await getAccessToken(page);
    const taskTitle = testTitle('eod-undo');
    const taskId = await createTestTask(page, accessToken, {
      title: taskTitle,
      startDate: TODAY,
      isScheduled: true,
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      await expect(page.locator('[data-tour="timeline"]').getByText(taskTitle)).toBeVisible({ timeout: 10_000 });

      await openEODReview(page);
      const dialog = page.getByRole('dialog', { name: 'End of day' });
      await expect(dialog.getByText(taskTitle)).toBeVisible({ timeout: 5_000 });

      // Click Tomorrow pill
      await page.getByTestId(`eod-tomorrow-btn-${taskId}`).click();
      await expect(page.getByTestId(`eod-undo-btn-${taskId}`)).toBeVisible({ timeout: 3_000 });

      // Click Undo — pills should reappear
      await page.getByTestId(`eod-undo-btn-${taskId}`).click();
      await expect(page.getByTestId(`eod-tomorrow-btn-${taskId}`)).toBeVisible({ timeout: 3_000 });
      await expect(page.getByTestId(`eod-undo-btn-${taskId}`)).not.toBeVisible();

      // Close dialog — task should still be on today's timeline
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-tour="timeline"]').getByText(taskTitle)).toBeVisible({ timeout: 5_000 });
    } finally {
      await cleanupTestData(page, accessToken, [taskId]);
    }
  });

  // The link the review's push opens names the day it invites a review of
  // (lib/reminders/scan.ts), and lib/eod-link.ts opens the review carrying
  // it. tests/unit/eod-link.test.ts pins what the store is handed; this pins
  // that the app still reaches it from the address bar.
  test('deep link ?eod=<day> opens EOD modal', async ({ page }) => {
    await page.goto(`/?eod=${getTodayStr()}`);
    await expect(page.getByRole('dialog', { name: 'End of day' })).toBeVisible({ timeout: 8_000 });
  });

  // Pushes sent before 2026-10-06 said ?eod=1, and one can still be waiting in
  // a notification shade.
  test('deep link ?eod=1 opens EOD modal', async ({ page }) => {
    // Navigate directly to /?eod=1 after login — the deep link handler should open the modal
    await page.goto('/?eod=1');
    // The EOD review dialog should open automatically
    await expect(page.getByRole('dialog', { name: 'End of day' })).toBeVisible({ timeout: 8_000 });
  });

  test.describe('mobile viewport @mobile', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('Tomorrow pill is visible and clickable on mobile', async ({ page }) => {
      await loginTestUser(page);

      const TODAY = getTodayStr();
      const accessToken = await getAccessToken(page);
      const taskTitle = testTitle('eod-mobile');
      const taskId = await createTestTask(page, accessToken, {
        title: taskTitle,
        startDate: TODAY,
        isScheduled: false,
      });

      try {
        // Mobile has no DEV trigger button; open EOD via the bare ?eod=1 deep
        // link (lib/eod-link.ts). A push today opens ?eod=<day>, which takes
        // the same path and names its day as well.
        await page.goto('/?eod=1');
        await page.waitForLoadState('networkidle');

        const dialog = page.getByRole('dialog', { name: 'End of day' });
        await expect(dialog).toBeVisible({ timeout: 5_000 });
        await expect(dialog.getByText(taskTitle)).toBeVisible({ timeout: 5_000 });

        // The Tomorrow pill should be visible and clickable on mobile
        const tomorrowBtn = page.getByTestId(`eod-tomorrow-btn-${taskId}`);
        await expect(tomorrowBtn).toBeVisible({ timeout: 3_000 });
        await tomorrowBtn.click();

        // Undo link should appear confirming the action succeeded
        await expect(page.getByTestId(`eod-undo-btn-${taskId}`)).toBeVisible({ timeout: 3_000 });
      } finally {
        await cleanupTestData(page, accessToken, [taskId]);
      }
    });
  });
});
