import { test, expect } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import {
  getAccessToken,
  createTestTask,
  cleanupTestData,
  fetchTestTask,
  testTitle,
} from './helpers/api';
import { getTodayStr } from './helpers/dates';
import { reloadApp, itemCard } from './helpers/app';

/**
 * The docked edit panel (memory/plans/item-surface-growth.md Phase 7) and the
 * notes field. What these pin that nothing else does:
 *  · notes round-trips through the UI to the agent API — the column existed in
 *    the schema, the mappers and the Beacon context from the start, but had no
 *    surface until now and therefore no coverage at all;
 *  · the panel AUTOSAVES, so a write must land without anyone pressing Save;
 *  · the panel is NON-MODAL — the canvas behind it stays operable, which is the
 *    entire reason it stopped being a dialog;
 *  · clicking another item RETARGETS the one panel rather than stacking a
 *    second one;
 *  · a click on EMPTY space closes it and lets go of the selection — and flushes
 *    the edit on the way out (lib/click-away.ts).
 */

const openPanelFor = async (page: import('@playwright/test').Page, id: string, title: string) => {
  await itemCard(page, id).getByText(title, { exact: true }).click();
  const panel = page.getByTestId('item-dialog');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-mode', 'edit');
  return panel;
};

/**
 * Click the desktop shell's own gutter — the root's padding left of the
 * sidebar, which is inside the click-away scope and under nothing else. Checked
 * rather than assumed, so a layout change fails here and not as a mystery
 * "panel still visible".
 */
const clickEmptySpace = async (
  page: import('@playwright/test').Page,
  opts: { modifiers?: Array<'Meta' | 'Shift' | 'Control'> } = {}
) => {
  const at = { x: 5, y: 400 };
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return !!el?.closest('[data-click-away-scope]') && !el.closest('[data-item-id],button');
  }, at);
  expect(hit, 'the gutter point is no longer bare click-away space').toBe(true);
  await page.mouse.move(at.x, at.y);
  for (const m of opts.modifiers ?? []) await page.keyboard.down(m);
  await page.mouse.down();
  await page.mouse.up();
  for (const m of opts.modifiers ?? []) await page.keyboard.up(m);
};

test.describe('Item panel', () => {
  test.beforeEach(async ({ page }) => {
    await loginTestUser(page);
  });

  test('notes typed in the panel autosave and reach the agent API', async ({ page }) => {
    const accessToken = await getAccessToken(page);
    const taskTitle = testTitle('notes-task');
    const taskId = await createTestTask(page, accessToken, {
      title: taskTitle,
      startDate: getTodayStr(),
      isScheduled: true,
      timeBucket: 'morning',
    });
    const noteText = 'Bring the Q3 numbers and the revised deck.';

    try {
      await reloadApp(page);
      await expect(itemCard(page, taskId)).toBeVisible({ timeout: 10_000 });

      const panel = await openPanelFor(page, taskId, taskTitle);
      await panel.getByTestId('item-dialog-notes').fill(noteText);

      // Assert the edit registered BEFORE relying on it: if the draft dropped
      // the input, the panel would sit at 'idle' and the only symptom would be
      // the API poll below timing out for reasons it can't distinguish.
      await expect(panel.getByTestId('item-dialog-notes')).toHaveValue(noteText);
      await expect(panel).toHaveAttribute('data-autosave', 'pending');

      // No Save button is pressed anywhere in this test — blurring the field is
      // what commits, and data-autosave reports when the panel is settled.
      await panel.getByTestId('item-dialog-title-input').click();
      await expect(panel).toHaveAttribute('data-autosave', 'idle', { timeout: 10_000 });

      await expect
        .poll(async () => (await fetchTestTask(page, taskId))?.notes, { timeout: 15_000 })
        .toBe(noteText);

      // And it survives a reload into the same field.
      await reloadApp(page);
      await expect(itemCard(page, taskId)).toBeVisible({ timeout: 10_000 });
      const reopened = await openPanelFor(page, taskId, taskTitle);
      await expect(reopened.getByTestId('item-dialog-notes')).toHaveValue(noteText);
    } finally {
      await cleanupTestData(page, accessToken, [taskId]);
    }
  });

  test('the panel is non-modal: the canvas behind it stays operable', async ({ page }) => {
    const accessToken = await getAccessToken(page);
    const taskTitle = testTitle('non-modal-task');
    const taskId = await createTestTask(page, accessToken, {
      title: taskTitle,
      startDate: getTodayStr(),
      isScheduled: true,
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      await expect(itemCard(page, taskId)).toBeVisible({ timeout: 10_000 });
      const panel = await openPanelFor(page, taskId, taskTitle);

      // A modal would have trapped this behind an overlay. The date header is
      // the cheapest proof that the app underneath still takes input.
      const before = await page.getByTestId('header-date').getAttribute('data-date');
      await page.getByTestId('header-next').click();
      await expect(page.getByTestId('header-date')).not.toHaveAttribute('data-date', before ?? '');

      // Nothing stacked a second dialog role onto the page either.
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(panel).toBeVisible();

      // Clearing drops the close-X; "Done" flushes pending writes and closes.
      await panel.getByTestId('item-dialog-submit').click();
      await expect(page.getByTestId('item-dialog')).toHaveCount(0);
    } finally {
      await cleanupTestData(page, accessToken, [taskId]);
    }
  });

  test('clicking another item retargets the one panel', async ({ page }) => {
    const accessToken = await getAccessToken(page);
    const firstTitle = testTitle('panel-first');
    const secondTitle = testTitle('panel-second');
    const today = getTodayStr();
    const firstId = await createTestTask(page, accessToken, {
      title: firstTitle,
      startDate: today,
      isScheduled: true,
      timeBucket: 'morning',
    });
    const secondId = await createTestTask(page, accessToken, {
      title: secondTitle,
      startDate: today,
      isScheduled: true,
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      await expect(itemCard(page, firstId)).toBeVisible({ timeout: 10_000 });

      const panel = await openPanelFor(page, firstId, firstTitle);
      await expect(panel.getByTestId('item-dialog-title-input')).toHaveValue(firstTitle);

      // The second click must swap the panel's target, not open another surface.
      await itemCard(page, secondId).getByText(secondTitle, { exact: true }).click();
      await expect(page.getByTestId('item-dialog')).toHaveCount(1);
      await expect(page.getByTestId('item-dialog').getByTestId('item-dialog-title-input')).toHaveValue(
        secondTitle
      );
    } finally {
      await cleanupTestData(page, accessToken, [firstId, secondId]);
    }
  });

  test('a click on empty space closes the panel, drops the selection, and keeps the edit', async ({
    page,
  }) => {
    const accessToken = await getAccessToken(page);
    const taskTitle = testTitle('click-away');
    const renamed = `${taskTitle} renamed`;
    const taskId = await createTestTask(page, accessToken, {
      title: taskTitle,
      startDate: getTodayStr(),
      isScheduled: true,
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      await expect(itemCard(page, taskId)).toBeVisible({ timeout: 10_000 });
      const panel = await openPanelFor(page, taskId, taskTitle);
      await expect(itemCard(page, taskId)).toHaveAttribute('data-selected', 'true');

      // Clicks INSIDE the panel and on the row itself are not click-away.
      await panel.getByTestId('item-dialog-notes').click();
      await itemCard(page, taskId).getByText(taskTitle, { exact: true }).click();
      await expect(panel).toBeVisible();

      // Type, then click away before the debounce can fire: the panel must
      // flush on its way out rather than leave the write to its unmount grace.
      await panel.getByTestId('item-dialog-title-input').fill(renamed);
      await expect(panel).toHaveAttribute('data-autosave', 'pending');
      await clickEmptySpace(page);

      await expect(page.getByTestId('item-dialog')).toHaveCount(0);
      await expect(itemCard(page, taskId)).toHaveAttribute('data-selected', 'false');
      await expect
        .poll(async () => (await fetchTestTask(page, taskId))?.title, { timeout: 15_000 })
        .toBe(renamed);
    } finally {
      await cleanupTestData(page, accessToken, [taskId]);
    }
  });

  test('closing the panel with Done lets go of the row it opened', async ({ page }) => {
    const accessToken = await getAccessToken(page);
    const taskTitle = testTitle('done-deselect');
    const taskId = await createTestTask(page, accessToken, {
      title: taskTitle,
      startDate: getTodayStr(),
      isScheduled: true,
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      await expect(itemCard(page, taskId)).toBeVisible({ timeout: 10_000 });
      const panel = await openPanelFor(page, taskId, taskTitle);
      await expect(itemCard(page, taskId)).toHaveAttribute('data-selected', 'true');

      await panel.getByTestId('item-dialog-submit').click();
      await expect(page.getByTestId('item-dialog')).toHaveCount(0);
      await expect(itemCard(page, taskId)).toHaveAttribute('data-selected', 'false');
    } finally {
      await cleanupTestData(page, accessToken, [taskId]);
    }
  });

  test('a click on empty space clears a multi-selection, a modifier click does not', async ({
    page,
  }) => {
    const accessToken = await getAccessToken(page);
    const today = getTodayStr();
    const titles = [testTitle('multi-a'), testTitle('multi-b')];
    const ids = await Promise.all(
      titles.map((title) =>
        createTestTask(page, accessToken, { title, startDate: today, isScheduled: true, timeBucket: 'morning' })
      )
    );
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

    try {
      await reloadApp(page);
      for (const id of ids) await expect(itemCard(page, id)).toBeVisible({ timeout: 10_000 });
      for (const [i, id] of ids.entries()) {
        await itemCard(page, id).getByText(titles[i], { exact: true }).click({ modifiers: [mod] });
      }
      await expect(page.getByTestId('bulk-action-bar')).toBeVisible();

      // A mis-aimed ⌘-click while building the selection must not wipe it.
      await clickEmptySpace(page, { modifiers: [mod] });
      await expect(page.getByTestId('bulk-action-bar')).toBeVisible();

      await clickEmptySpace(page);
      await expect(page.getByTestId('bulk-action-bar')).toHaveCount(0);
      for (const id of ids) await expect(itemCard(page, id)).toHaveAttribute('data-selected', 'false');
    } finally {
      await cleanupTestData(page, accessToken, ids);
    }
  });
});
