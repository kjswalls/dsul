import { test, expect } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { createTestTask, cleanupByTitlePrefix, specScope } from './helpers/api';
import { getTodayStr } from './helpers/dates';
import { reloadApp, itemCard, switchMobileTab } from './helpers/app';
import { gateAnswered, stubConnectedModel } from './helpers/ai';

/**
 * Ask on the phone: the third surface, named "Ask" whoever answers, holds its
 * own stack (components/mobile/ask-tab.tsx). What this pins that the unit
 * suite cannot: the real shell, the real mode sheet, and the openEditFor
 * interception, which pushes an item opened FROM Ask inline over it, while the
 * same item opened from Today still gets the drawer, because the interceptor
 * lives exactly as long as the Ask tab is mounted.
 *
 * The item is opened from Needs you rather than from "With AI activity":
 * that list is capped at five rows across the account, and conversations
 * other specs save beside this one could push the row out of it. A blocked
 * item is the one thing here that only this test makes.
 *
 * The swipe that pops a view stays in ask-tab.test.tsx: there is no e2e
 * touch helper, and the shell's swipe handler does not track a mouse.
 */

const scope = specScope('ask-mobile');

test.describe('Ask on the phone @mobile', () => {
  test.beforeEach(async ({ page }) => {
    // Before the first load: the gate is asked once, at sign-in, and the
    // mode sheet lists Ask only once something can answer.
    await stubConnectedModel(page);
    const answered = gateAnswered(page);
    await loginTestUser(page);
    await answered;
  });

  test('Ask is the third surface: History pushes and pops, an item from Ask opens inline, from Today in the drawer', async ({
    page,
  }) => {
    const title = scope.title('blocked');
    const id = await createTestTask(page, {
      title,
      startDate: getTodayStr(),
      isScheduled: true,
      timeBucket: 'morning',
      assignee: 'openclaw',
      aiStatus: 'blocked',
      aiResult: 'Tue 3pm or Thu 10am?',
    });

    try {
      const answered = gateAnswered(page);
      await reloadApp(page);
      await answered;

      // 1. The mode sheet offers "Ask", and the card names it once there.
      const card = page.getByTestId('mobile-mode-card');
      await card.click();
      const option = page.getByTestId('mode-option-chat');
      await expect(option).toContainText('Ask');
      await option.click();
      await expect(option).toHaveCount(0);
      await expect(card).toHaveAttribute('data-surface', 'chat');
      await expect(card).toHaveAttribute('aria-label', 'Surface: Ask. Change surface.');
      const tab = page.locator('[data-ask-tab]');
      const home = tab.locator('[data-ask-home]');
      await expect(home).toBeVisible();

      // 2. History pushes over home, and the visible ‹ pops it.
      await tab.getByTestId('ask-history').click();
      await expect(tab.locator('[data-ask-history]')).toBeVisible();
      await tab.getByRole('button', { name: 'Back to Ask' }).click();
      await expect(tab.locator('[data-ask-history]')).toHaveCount(0);
      await expect(home).toBeVisible();

      // 3. The item, from its Needs-you card: pushed inline over Ask, never a
      //    drawer, with the dock's box now about the item. Three cards show
      //    before "Show N more", and the account is shared.
      const waiting = tab.locator(`[data-testid="needs-you-card"][data-item-id="${id}"]`);
      const more = tab.getByTestId('needs-you-more');
      if (await more.isVisible()) await more.click();
      await waiting.getByTestId('needs-you-title').click();
      const inline = tab.getByTestId('ask-item');
      await expect(inline.getByTestId('item-dialog')).toBeVisible();
      await expect(inline.getByTestId('item-dialog-title-input')).toHaveValue(title);
      await expect(page.getByTestId('item-dialog')).toHaveCount(1);
      await expect(page.getByTestId('item-dialog')).not.toHaveAttribute('role', 'dialog');
      await expect(page.getByTestId('chat-dock-input')).toHaveAttribute(
        'placeholder',
        'Ask about this item…'
      );
      await tab.getByRole('button', { name: 'Back to Ask' }).click();
      await expect(inline).toHaveCount(0);
      await expect(home).toBeVisible();

      // 4. The same item from Today: Ask is not mounted there, so nothing
      //    intercepts, and it opens in the drawer as it always has.
      await switchMobileTab(page, 'today');
      await expect(tab).toHaveCount(0);
      await itemCard(page, id).getByText(title, { exact: true }).click();
      const drawer = page.getByTestId('item-dialog');
      await expect(drawer).toBeVisible();
      await expect(drawer).toHaveAttribute('role', 'dialog');
      await expect(drawer.getByTestId('item-dialog-title-input')).toHaveValue(title);
    } finally {
      await cleanupByTitlePrefix(page, title);
    }
  });
});
