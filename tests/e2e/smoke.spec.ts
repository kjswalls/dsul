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
  omnibar,
  omnibarPanel,
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

  test('an account with no AI connected is offered none, and ⌘Enter files nothing', async ({
    page,
  }) => {
    // The e2e account has no model connection and no OpenClaw chat transport
    // (an agent key, but no gateway and no registered chat URL), so the real
    // GET /api/ai/connection answers "nothing can answer". Waited on across a
    // reload so what is asserted is the gate's ANSWER, not the fail-closed
    // moment before it (which would pass for the wrong reason).
    const answered = page.waitForResponse(
      (r) => r.url().includes('/api/ai/connection') && r.request().method() === 'GET'
    );
    await reloadApp(page);
    await answered;

    const title = testTitle('smoke-noai');
    const bar = omnibar(page);
    try {
      // The hint row renders only while the bar is EMPTY, so the hint is checked
      // before anything is typed. `commands` sits in the same row, so its
      // presence proves the row is up and an absent `? chat` is the gate.
      await bar.click();
      await expect(omnibarPanel(page)).toBeVisible();
      await expect(omnibarPanel(page).getByText('commands', { exact: true })).toBeVisible();
      await expect(omnibarPanel(page).getByText('? chat')).toHaveCount(0);

      await bar.fill(title);
      // The panel has rows for the text (add, search), so an absent Ask row is
      // the gate rather than an empty panel.
      await expect(omnibarPanel(page).getByTestId('omnibar-add-row')).toContainText(title);
      await expect(omnibarPanel(page).getByText(/Ask (AI|OpenClaw)/)).toHaveCount(0);

      // ⌘Enter is consumed and does nothing: no chat opens, and it does NOT fall
      // through to the dock's Enter, which would file the text as a task.
      await bar.press('ControlOrMeta+Enter');
      await expect(bar).toHaveValue(title);
      await expect(page.getByRole('button', { name: 'Toggle AI assistant' })).toHaveCount(0);
      await expect(page.getByPlaceholder('Ask anything…')).toHaveCount(0);

      // Nothing was filed. Held for a beat first: a fall-through write is a
      // network round trip, and the claim is that it never happens.
      await page.waitForTimeout(1_500);
      const res = await page.request.get(`${BASE_URL}/api/agent/context`, {
        headers: { Authorization: `Bearer ${apiKey()}` },
      });
      // A failed read (bad key, 5xx) has no `items` and would pass the check
      // below without looking, so the read itself must succeed first.
      expect(res.ok()).toBe(true);
      const body = await res.json();
      expect(Array.isArray(body.items)).toBe(true);
      const filed = body.items.filter((i: { title?: string }) => i.title === title);
      expect(filed).toEqual([]);
    } finally {
      await cleanupByTitlePrefix(page, title);
    }
  });

  test('with a model connected, ⌘Enter opens chat and the reply renders', async ({ page }) => {
    // Never a real provider: the gate's answer and the chat stream are both
    // stubbed in the browser. Installed BEFORE the navigation that reads them —
    // the gate is read once, at sign-in.
    await page.route('**/api/ai/connection', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          available: true,
          model: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            baseUrl: null,
            authMethod: 'key',
            status: 'ok',
            problem: null,
            checkedAt: '2026-10-01T00:00:00.000Z',
          },
          openclaw: { gateway: false, pluginChat: false, agent: false, agentId: null },
        }),
      })
    );
    await page.route('**/api/chat', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Cache-Control': 'no-store' },
        body: 'data: {"content":"hi"}\n\ndata: [DONE]\n\n',
      })
    );
    // Waited on across the reload: while the gate is still unknown the omnibar
    // consumes ⌘Enter and does nothing, so a press that beats the stub's answer
    // would be swallowed.
    const answered = page.waitForResponse(
      (r) => r.url().includes('/api/ai/connection') && r.request().method() === 'GET'
    );
    await reloadApp(page);
    await answered;

    // Chat has no persistent bar: it is summoned from the omnibar (⌘Enter = Ask AI).
    const bar = omnibar(page);
    await bar.click();
    await bar.fill('plan my day');
    // The Ask row is the gate's answer reaching the omnibar, not just the
    // response arriving: ⌘Enter is only pressed once it is there. `first()`
    // because a matching `/chat` command row may sit beside it, gated the same.
    await expect(omnibarPanel(page).getByText(/Ask AI/).first()).toBeVisible();
    await bar.press('ControlOrMeta+Enter');

    const chat = page
      .locator('section')
      .filter({ has: page.getByRole('button', { name: 'Toggle AI assistant' }) });
    await expect(chat).toBeVisible({ timeout: 5_000 });
    await expect(chat.getByText('hi', { exact: true })).toBeVisible({ timeout: 5_000 });
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
