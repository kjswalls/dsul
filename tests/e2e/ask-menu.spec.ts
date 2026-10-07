import { test, expect, type Page } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { createTestTask, cleanupByTitlePrefix, fetchTestTask, specScope } from './helpers/api';
import { getTodayStr } from './helpers/dates';
import { reloadApp, itemCard } from './helpers/app';
import {
  askBox,
  cleanupConversations,
  gateAnswered,
  rail,
  stubChatReply,
  stubConnectedModel,
  turnSaved,
} from './helpers/ai';

/**
 * "AI ▸" on the item's right-click menu (components/planner/item-context-menu.tsx,
 * the asks declared in lib/item-asks.ts and run by lib/open-chat.ts, and the
 * hand-off to the agent in lib/agent-handoff.ts), end to end
 * on the desktop: the stubbed model answers (helpers/ai.ts), the item's
 * conversation is saved through the real routes, and a plan card is answered by
 * a stubbed /api/ai/propose.
 *
 * What only a browser can show: the menu closing must not take the caret back
 * from the item's box (Radix restores focus to the row once its exit animation
 * ends), and each answer must land where it is seen.
 */

const scope = specScope('ask-menu');

/**
 * Right-click the row and open the AI submenu; returns the submenu.
 *
 * A real right click: it focuses the row (focusable, for dnd-kit), which is
 * where Radix hands focus back when the menu closes, and its release never
 * chooses a row of the menu it opened, even one shifted up under the pointer
 * (components/ui/context-menu.tsx; context-menu-release.spec.ts).
 */
async function openAskMenu(page: Page, id: string, title: string) {
  await itemCard(page, id).getByText(title, { exact: true }).click({ button: 'right' });
  const menu = page.getByTestId('item-context-menu');
  await expect(menu).toBeVisible();
  await menu.getByTestId('item-menu-ask').click();
  const asks = page.getByTestId('item-menu-ask-content');
  await expect(asks).toBeVisible();
  return asks;
}

test.describe('Ask AI on the item menu', () => {
  test.beforeEach(async ({ page }) => {
    // Before the first load: the gate is asked once, at sign-in.
    await stubConnectedModel(page);
    const answered = gateAnswered(page);
    await loginTestUser(page);
    await answered;
  });

  test('"Ask about this…" opens the item with its box focused, and the menu closing keeps it there', async ({
    page,
  }) => {
    const title = scope.title('ask');
    const id = await createTestTask(page, {
      title,
      startDate: getTodayStr(),
      isScheduled: true,
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      const asks = await openAskMenu(page, id, title);
      await expect(asks.getByTestId('item-menu-ask-ask')).toHaveText('Ask about this…');
      await expect(asks.getByTestId('item-menu-ask-start')).toHaveText('Help me start');
      await asks.getByTestId('item-menu-ask-ask').click();

      const panel = rail(page).getByTestId('item-dialog');
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId('item-dialog-title-input')).toHaveValue(title);
      // The menu is gone (its exit animation, and Radix's focus return, done)…
      await expect(page.getByTestId('item-context-menu')).toHaveCount(0);
      // …and the caret is still in the item's box, not back on the row.
      await expect(askBox(panel)).toBeFocused();
    } finally {
      await cleanupByTitlePrefix(page, title);
    }
  });

  test('closing the item an ask opened hands focus back to the row the menu came from', async ({ page }) => {
    const title = scope.title('back');
    const id = await createTestTask(page, {
      title,
      startDate: getTodayStr(),
      isScheduled: true,
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      const asks = await openAskMenu(page, id, title);
      await asks.getByTestId('item-menu-ask-ask').click();
      const panel = rail(page).getByTestId('item-dialog');
      await expect(page.getByTestId('item-context-menu')).toHaveCount(0);
      await expect(askBox(panel)).toBeFocused();

      // Escape in the empty box closes the item; the row, not <body>, has focus.
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('item-dialog')).toHaveCount(0);
      await expect(itemCard(page, id)).toBeFocused();
    } finally {
      await cleanupByTitlePrefix(page, title);
    }
  });

  test('"Help me start" asks in the item\'s conversation and saves it there', async ({ page }) => {
    const title = scope.title('start');
    const id = await createTestTask(page, {
      title,
      startDate: getTodayStr(),
      isScheduled: true,
      timeBucket: 'morning',
    });
    await stubChatReply(page, 'Open the drawer and find the warranty.');

    try {
      await reloadApp(page);
      const asks = await openAskMenu(page, id, title);
      const saved = turnSaved(page);
      await asks.getByTestId('item-menu-ask-start').click();

      const panel = rail(page).getByTestId('item-dialog');
      await expect(panel.getByTestId('item-dialog-title-input')).toHaveValue(title);
      const conversation = panel.getByTestId('item-conversation');
      await expect(conversation.locator('[data-message-role="user"]')).toContainText('Help me get started on this');
      await expect(conversation.locator('[data-message-role="assistant"]')).toContainText(
        'Open the drawer and find the warranty.'
      );
      expect((await saved).ok()).toBe(true);

      // The next open of the menu knows the item has a conversation now.
      await expect(page.getByTestId('item-context-menu')).toHaveCount(0);
      const again = await openAskMenu(page, id, title);
      await expect(again.getByTestId('item-menu-ask-ask')).toHaveText('Continue conversation');
      await page.keyboard.press('Escape');
    } finally {
      await cleanupConversations(page, title);
      await cleanupByTitlePrefix(page, title);
    }
  });

  test('"Find a time for this" answers with a plan card on Ask home, and Accept sets the time', async ({
    page,
  }) => {
    const title = scope.title('time');
    const today = getTodayStr();
    const id = await createTestTask(page, {
      title,
      startDate: today,
      isScheduled: true,
      timeBucket: 'morning',
    });
    let asked: { prompt?: string; mode?: string } | null = null;
    await page.route('**/api/ai/propose', async (route) => {
      asked = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          proposal: {
            id: 'p1',
            summary: 'A slot after lunch',
            operations: [{ kind: 'update', itemId: id, startDate: today, startTime: '14:00' }],
            createdAt: '2026-10-01T00:00:00.000Z',
          },
        }),
      });
    });

    try {
      await reloadApp(page);
      const asks = await openAskMenu(page, id, title);
      await asks.getByTestId('item-menu-ask-findTime').click();

      // Ask home, summoned, carries the card.
      const home = rail(page).locator('[data-ask-home]');
      await expect(home).toBeVisible();
      const card = home.getByTestId('proposal-card');
      await expect(card).toContainText('A slot after lunch');
      expect(asked).toMatchObject({ mode: 'plan' });
      expect(asked!.prompt).toContain(`[${id}]`);
      expect(asked!.prompt).toContain(`on ${today}`);

      await card.getByTestId('proposal-accept').click();
      await expect.poll(async () => (await fetchTestTask(page, id))?.startTime).toBe('14:00');
    } finally {
      await cleanupByTitlePrefix(page, title);
    }
  });
});

test.describe('Handing an item to the agent from its menu', () => {
  test.beforeEach(async ({ page }) => {
    // A model AND a paired OpenClaw agent: the hand-off asks `canDelegate`.
    await stubConnectedModel(page, { agent: true });
    const answered = gateAnswered(page);
    await loginTestUser(page);
    await answered;
  });

  test('"Hand off to OpenClaw" queues it with an Undo, and "Take back" undoes the hand-off', async ({ page }) => {
    const title = scope.title('handoff');
    const id = await createTestTask(page, {
      title,
      startDate: getTodayStr(),
      isScheduled: true,
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      const asks = await openAskMenu(page, id, title);
      await expect(page.getByTestId('item-menu-ask')).toHaveText('AI');
      await expect(asks.getByTestId('item-menu-takeback')).toHaveCount(0);
      await asks.getByTestId('item-menu-handoff').click();

      // Nothing opens: the menu closes onto the row, and the strip says what happened.
      await expect(page.getByTestId('item-context-menu')).toHaveCount(0);
      await expect(page.getByTestId('item-dialog')).toHaveCount(0);
      await expect(itemCard(page, id)).toBeFocused();
      await expect(page.getByTestId('undo-strip')).toContainText(`Hand off to OpenClaw: ${title}`);
      await expect
        .poll(async () => {
          const task = await fetchTestTask(page, id);
          return [task?.assignee, task?.aiStatus];
        })
        .toEqual(['openclaw', 'queued']);

      // Handed off, the row offers the way back, with where the agent is.
      const again = await openAskMenu(page, id, title);
      await expect(again.getByTestId('item-menu-handoff')).toHaveCount(0);
      const back = again.getByTestId('item-menu-takeback');
      await expect(back).toContainText('Take back from OpenClaw');
      await expect(back).toContainText('Queued');
      await back.click();
      await expect(page.getByTestId('undo-strip')).toContainText(`Take back from OpenClaw: ${title}`);
      await expect
        .poll(async () => (await fetchTestTask(page, id))?.assignee ?? null)
        .toBeNull();
    } finally {
      await cleanupByTitlePrefix(page, title);
    }
  });
});
