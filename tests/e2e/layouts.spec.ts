import { test, expect } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { createTestTask, cleanupByTitlePrefix, testTitle } from './helpers/api';
import { getTodayStr } from './helpers/dates';
import { reloadApp, itemCard, expectCompleted, completeButton } from './helpers/app';

/**
 * Layouts (lib/layout-themes.ts) move, hide and add whole surfaces, and the
 * rule that makes that safe is that the pinned verbs survive every one of
 * them: capture, ticking, the braindump and the item panel. Console is set
 * through localStorage only — never the Settings row, which would write the
 * shared test user's user_settings.layout and rearrange every parallel spec.
 */
test.describe('Layouts: Console', () => {
  test.beforeEach(async ({ page }) => {
    await loginTestUser(page);
    await page.evaluate(() => localStorage.setItem('dsul-layout', 'console'));
    await reloadApp(page);
  });

  test('moves the braindump right, capture to the bottom, and adds the status line', async ({
    page,
  }) => {
    const shell = page.locator('[data-layout]');
    await expect(shell).toHaveAttribute('data-layout', 'console');
    await expect(shell).toHaveAttribute('data-layout-buckets', 'headings');

    await expect(page.getByTestId('status-line')).toBeVisible();
    await expect(page.getByTestId('braindump-pane').getByTestId('braindump')).toBeVisible();
    await expect(page.getByTestId('dock-bottom').locator('[data-tour="omnibar"] input')).toBeVisible();
    // The left column is gone, not merely collapsed.
    await expect(page.getByTestId('sidebar-column')).toHaveCount(0);

    // The status line's switch hides and shows the pane, like Ctrl+[.
    const toggle = page.getByTestId('status-line-braindump');
    await toggle.click();
    await expect(page.getByTestId('braindump-pane')).toHaveAttribute('inert', '');
    await toggle.click();
    await expect(page.getByTestId('braindump-pane')).not.toHaveAttribute('inert', '');
  });

  test('a text tick still completes the item, and the panel still opens', async ({ page }) => {
    const title = testTitle('console');
    try {
      const id = await createTestTask(page, {
        title,
        startDate: getTodayStr(),
        timeBucket: 'morning',
        isScheduled: true,
      });
      await reloadApp(page);
      await expect(itemCard(page, id)).toBeVisible({ timeout: 10_000 });
      await expect(completeButton(page, id)).toHaveAttribute('data-checked', 'false');

      await completeButton(page, id).click();
      await expectCompleted(page, id, true);
      await expect(completeButton(page, id)).toHaveAttribute('data-checked', 'true');

      await itemCard(page, id).getByText(title).click();
      await expect(page.getByTestId('item-dialog')).toBeVisible();
    } finally {
      await cleanupByTitlePrefix(page, title);
    }
  });
});
