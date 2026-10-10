import { test, expect } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { createTestTask, cleanupByTitlePrefix, specScope } from './helpers/api';
import { getTodayStr } from './helpers/dates';
import { reloadApp, itemCard, omnibar, switchMobileTab } from './helpers/app';
import {
  gateAnswered,
  pasteInto,
  stubAIGate,
  stubConnectedModel,
  STUB_GOOD_KEY,
} from './helpers/ai';

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

/**
 * The same third surface while nothing answers (AI setup PR 5): the gate
 * offers to set AI up, so the sheet lists it as "Set up AI", marked
 * Optional, and the tab holds the setup page, the desktop column's pieces
 * laid out as a tab (components/mobile/setup-tab.tsx). It is not Ask: the
 * dock keeps its omnibar there. A key that works turns the tab into Ask in
 * place, home first, with "It works.".
 *
 * The gate is stubbed statefully (helpers/ai.ts `stubAIGate`), as rail.spec
 * does: a real connect would save a key to the shared e2e account.
 */
test.describe('Set up AI on the phone @mobile', () => {
  test('nothing connected: the sheet offers Set up AI, its page takes a key, and the tab becomes Ask', async ({
    page,
  }) => {
    const gate = await stubAIGate(page);
    const answered = gateAnswered(page);
    await loginTestUser(page);
    await answered;

    // 1. The sheet's third row is "Set up AI", with its quiet note.
    const card = page.getByTestId('mobile-mode-card');
    await card.click();
    const option = page.getByTestId('mode-option-chat');
    await expect(option).toContainText('Set up AI');
    await expect(option.locator('[data-mode-note]')).toHaveText('Optional');
    await option.click();
    await expect(option).toHaveCount(0);
    await expect(card).toHaveAttribute('data-surface', 'chat');
    await expect(card).toHaveAttribute('aria-label', 'Surface: Set up AI. Change surface.');

    // 2. The setup page, not Ask: the word in its capsule, the key card, the
    //    foot at the end, nothing lime, and the dock's omnibar, no composer.
    const setup = page.locator('[data-setup-tab="invite"]');
    await expect(setup).toBeVisible();
    await expect(setup.getByRole('heading', { name: 'Set up AI', exact: true, level: 2 })).toBeVisible();
    await expect(page.locator('[data-ask-tab]')).toHaveCount(0);
    await expect(setup.locator('[data-setup-foot]')).toContainText(
      'AI is optional. dsul works fully without it.'
    );
    await expect(setup.locator('.bg-primary, [data-slot="button-key"]')).toHaveCount(0);
    await expect(omnibar(page)).toBeVisible();
    await expect(page.getByTestId('chat-dock-input')).toHaveCount(0);

    // 3. A Google key is checked the moment it lands (no question is kept),
    //    and the tab becomes Ask home, which says it works.
    const field = setup.getByTestId('connect-key-card').getByLabel('Your Gemini key');
    await pasteInto(field, STUB_GOOD_KEY);
    const tab = page.locator('[data-ask-tab]');
    const home = tab.locator('[data-ask-home]');
    await expect(home).toBeVisible();
    await expect(setup).toHaveCount(0);
    await expect(home.getByTestId('it-works').getByRole('heading', { name: 'It works.' })).toBeVisible();
    await expect(card).toHaveAttribute('aria-label', 'Surface: Ask. Change surface.');
    // Ask's box replaces the omnibar, and the keyboard stays down over the card.
    const box = page.getByTestId('chat-dock-input');
    await expect(box).toBeVisible();
    await expect(box).not.toBeFocused();
    expect(gate.connects).toEqual([{ provider: 'gemini', accepted: true }]);
    expect(await page.content()).not.toContain(STUB_GOOD_KEY);
  });
});
