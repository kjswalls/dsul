import { test, expect } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import {
  getAccessToken,
  createTestTask,
  cleanupTestData,
  cleanupByTitlePrefix,
  testTitle,
  apiKey,
} from './helpers/api';
import { getTodayStr } from './helpers/dates';
import { BASE_URL } from './helpers/env';
import {
  reloadApp,
  itemCard,
  expectCompleted,
  completeButton,
   
   
} from './helpers/app';

/**
 * Redesign safety net: the core daily loop must survive every phase of the
 * redesign branch. Keep selectors role/text-based so restyles don't break them;
 * structural selectors used here are documented in lib/dnd/CONTRACT.md.
 */
test.describe('Smoke: core daily loop', () => {
  test.beforeEach(async ({ page }) => {
    await loginTestUser(page);
  });

  test('app loads with the day view visible', async ({ page }) => {
    await expect(page.getByRole('main')).toBeVisible({ timeout: 10_000 });
    // Time-of-day buckets are the heart of the day view.
    await expect(page.locator('[data-dnd-bucket="morning"]')).toBeVisible();
    await expect(page.locator('[data-dnd-bucket="afternoon"]')).toBeVisible();
  });

  test('add a task through the UI, complete it, and have that survive a reload', async ({
    page,
  }) => {
    // This test used to click complete, reload, and END — no assertion after the
    // reload, despite a comment claiming completion survived it. It passed whether
    // or not completion worked, whether or not the write landed, and even if the
    // row vanished. It also never deleted the task it created, leaking a row into
    // the shared braindump on every run.
    const title = testTitle('smoke');

    try {
      await page.getByTestId('braindump').getByRole('button', { name: 'Add task' }).click();
      const dialog = page.getByTestId('item-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('data-mode', 'add');
      await dialog.getByTestId('item-dialog-title-input').fill(title);
      await dialog.getByTestId('item-dialog-submit').click();

      // Resolve the id the app assigned, so every assertion below is id-based.
      let created: { id: string } | null = null;
      await expect
        .poll(
          async () => {
            const res = await page.request.get(`${BASE_URL}/api/agent/context`, {
              headers: { Authorization: `Bearer ${apiKey()}` },
            });
            const body = await res.json();
            created = (body.tasks ?? []).find((x: { title: string }) => x.title === title) ?? null;
            return created?.id ?? null;
          },
          { message: `task "${title}" was never persisted`, timeout: 10_000 }
        )
        .not.toBeNull();
      const id = created!.id;

      await expect(itemCard(page, id)).toBeVisible({ timeout: 10_000 });
      await expectCompleted(page, id, false);

      await completeButton(page, id).click();
      await expectCompleted(page, id, true);

      // The actual claim: it is STILL completed after a reload.
      await reloadApp(page);
      await expectCompleted(page, id, true);
    } finally {
      await cleanupByTitlePrefix(page, title);
    }
  });

  test('the planner loads in one load_planner request, not the per-table fan-out', async ({
    page,
  }) => {
    // The guard against the silent fallback. loadPlannerData reads a 42P01 as
    // "050 not applied" and latches onto the ten-request path with nothing but
    // a console.warn — so a later migration that renames a relation load_planner
    // reads, and forgets to re-create it, would fail no unit test. The local
    // stack replays 050, so here the RPC must be the path actually taken.
    const rpc: string[] = [];
    const perTable: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (req.method() === 'POST' && url.includes('/rest/v1/rpc/load_planner')) rpc.push(url);
      if (
        req.method() === 'GET' &&
        (/\/rest\/v1\/(items_windowed|routine_items|season_items|goal_items)\?/.test(url) ||
          // The planner's projects read. fetchTrashedNames also reads projects,
          // for TRASHED rows (`deleted_at=not.is.null`), and is not the load.
          (/\/rest\/v1\/projects\?/.test(url) && url.includes('deleted_at=is.null')))
      ) {
        perTable.push(url);
      }
    });

    await reloadApp(page);
    await expect.poll(() => rpc.length, { timeout: 10_000 }).toBe(1);
    expect(perTable).toEqual([]);
  });

  test('day/week toggle switches views', async ({ page }) => {
    // Scope is a dropdown selector: open it, then pick the option.
    const pickScope = async (option: string) => {
      await page.getByRole('button', { name: 'Scope', exact: true }).click();
      await page.getByRole('menuitem', { name: option }).click();
    };
    await expect(page.locator('[data-dnd-bucket="morning"]')).toBeVisible({ timeout: 10_000 });
    await pickScope('Week');
    // The day-view bucket sections unmount in week view.
    await expect(page.locator('[data-dnd-bucket="morning"]')).toHaveCount(0, { timeout: 5_000 });
    await pickScope('Day');
    await expect(page.locator('[data-dnd-bucket="morning"]')).toBeVisible({ timeout: 5_000 });
  });

  test('AI chat surface opens', async ({ page }) => {
    // Chat has no persistent bar — it's summoned from the omnibar (⌘Enter = Ask Beacon).
    const omnibar = page.locator('[data-tour="omnibar"] input');
    await omnibar.click();
    await omnibar.fill('plan my day');
    await omnibar.press('ControlOrMeta+Enter');
    // The chat surface exposes a message input once open.
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 5_000 });
  });

  test('scheduled task appears in its bucket', async ({ page }) => {
    const accessToken = await getAccessToken(page);
    const title = testTitle('smoke-bucket');
    const taskId = await createTestTask(page, accessToken, {
      title,
      startDate: getTodayStr(),
      isScheduled: true,
      timeBucket: 'morning',
    });

    try {
      await reloadApp(page);
      await expect(
        page.locator('[data-dnd-bucket="morning"]').getByText(title).first()
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await cleanupTestData(page, accessToken, [taskId]);
    }
  });
});
