import { test, expect, type Page, type Request } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { completeButton, expectCompleted, gotoApp, itemCard, waitForAppReady } from './helpers/app';
import {
  apiKey,
  cleanupByTitlePrefix,
  createTestTask,
  patchTestTask,
  specScope,
  testUserId,
} from './helpers/api';
import { getTodayStr } from './helpers/dates';
import { BASE_URL, STORAGE_STATE, TEST_TZ } from './helpers/env';
import { holdPlannerLoad, readSnapshot, snapshotKeys, waitForSnapshot } from './helpers/preview';

/**
 * THE INSTANT PLANNER — a reload paints this browser's copy of the last session
 * look-only while load_planner is in flight, then settles onto the fresh data.
 *
 * What only a real browser can show: that the cached copy reaches the screen
 * at all (IndexedDB, written by lib/planner-snapshot-writer.ts after a fresh
 * landing), that nothing on it can be acted on, that the fresh data replaces it
 * and the settle lets go of the page, and that the failure, sign-out and
 * reduced-motion edges leave the app exactly where it would be without a cache.
 * Each test holds the load (helpers/preview.ts) so the preview is on screen for
 * as long as the assertions need — unheld it is up for ~50–1700ms.
 *
 * Every Playwright test starts in a fresh browser context, so there is never a
 * snapshot from an earlier test: each one primes its own with a first load,
 * then waits for a record that holds its own fixture (content-aware — a record
 * written before the fixture existed cannot satisfy it).
 *
 * Under its OWN prefix, and parallel-safe: every test files its rows under a
 * per-test stem (`fixtures`) and cleans up only that stem, so no test's
 * cleanup can delete a sibling's rows mid-run. Nothing here writes
 * user_settings, so nothing leaks to other specs.
 */
const scope = specScope('instant');

/** A per-test title stem; every title the test makes starts with it, and so does its cleanup. */
function fixtures(label: string) {
  const stem = scope.title(label);
  return { stem, title: (name: string) => `${stem}_${name}` };
}

const viewRoot = (page: Page) => page.getByTestId('view-root');

/** Due today, morning — on the Day × Buckets canvas, where the preview is inert. */
async function createTodayTask(page: Page, title: string): Promise<string> {
  return createTestTask(page, {
    title,
    startDate: getTodayStr(),
    isScheduled: true,
    timeBucket: 'morning',
  });
}

/** First load of this context, then wait until the cache holds `itemId`. */
async function primeSnapshot(page: Page, itemId: string): Promise<void> {
  await loginTestUser(page);
  await expect(itemCard(page, itemId)).toBeVisible();
  await waitForSnapshot(
    page,
    (data) => data.items.some((item) => item.id === itemId),
    `the snapshot never picked up ${itemId} after a fresh load`
  );
}

/** A write that could tick, skip or edit an item: the things a preview must never send. */
function isItemWrite(request: Request): boolean {
  if (request.method() === 'GET' || request.method() === 'HEAD' || request.method() === 'OPTIONS') {
    return false;
  }
  return /\/rest\/v1\/(items\b|rpc\/(set_item_completion|set_item_skip|toggle_item_completed_date))/.test(
    request.url()
  );
}

/**
 * The test user's item rows matching a PostgREST `filter`, read straight from
 * the database (the service-key REST read fetchTestCollections uses). Not
 * through the agent API: that is a `next dev` route, and under four workers
 * its first hit has stalled for 25s+ or reset the connection outright — longer
 * than any poll here should wait — while the database answers in milliseconds.
 * Soft-deleted rows are included: a duplicate is a duplicate whatever became
 * of it.
 */
async function storedItems(filter: string): Promise<Array<{ id: string; status: string | null }>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SECRET_KEY!;
  const res = await fetch(`${url}/rest/v1/items?user_id=eq.${testUserId()}&${filter}&select=id,status`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`[storedItems] ${res.status} ${await res.text()}`);
  return (await res.json()) as Array<{ id: string; status: string | null }>;
}

/** How many rows titled `title` the test user holds. */
async function storedItemsTitled(title: string): Promise<number> {
  return (await storedItems(`title=eq.${encodeURIComponent(title)}`)).length;
}

/** The stored scalar `status` of item `id`, or null when there is no such row. */
async function storedItemStatus(id: string): Promise<string | null> {
  return (await storedItems(`id=eq.${encodeURIComponent(id)}`))[0]?.status ?? null;
}

/**
 * Records, once per frame, the most WAAPI animations alive at once inside a
 * settle scope — script-made ones only (the conductor's), so the app's CSS
 * transitions and keyframes (the sync line, hover washes) never count.
 */
async function installSettleAnimationRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __settleAnimMax: number };
    w.__settleAnimMax = 0;
    const tick = () => {
      try {
        const live = document.getAnimations().filter((anim) => {
          if (anim instanceof CSSAnimation || anim instanceof CSSTransition) return false;
          const target = (anim.effect as KeyframeEffect | null)?.target;
          return !!target && !!target.closest?.('[data-settle-scope]');
        }).length;
        if (live > w.__settleAnimMax) w.__settleAnimMax = live;
      } catch {
        /* a frame with nothing to read */
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const settleAnimMax = (page: Page) =>
  page.evaluate(() => (window as unknown as { __settleAnimMax: number }).__settleAnimMax);

test.describe('instant planner: the look-only preview and its settle', () => {
  // Each test is a full load, a snapshot write (2s debounce, then idle) and a
  // held reload, against one `next dev` shared by every worker: 15–46s
  // measured on a warm server with four workers. Same budget goals, seasons
  // and organize take.
  test.describe.configure({ timeout: 120_000 });

  /**
   * Compile, once per worker and outside any test's budget, every route these
   * tests reach. `next dev` builds a route on its first hit, and the hits here
   * come at the worst moment: right after a landing, when the app has just
   * asked for three API routes of its own, a spec PATCHes the agent API and
   * reloads — and that reload queues behind every compile in flight. On a
   * four-core runner with four workers starting this file at once, a held
   * reload measured 70–95s of pure compile, which is the dev server's cost,
   * not the feature's. The test bodies then time only the app.
   */
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const context = await browser.newContext({
      storageState: STORAGE_STATE,
      baseURL: BASE_URL,
      timezoneId: TEST_TZ,
    });
    try {
      const page = await context.newPage();
      await gotoApp(page);
      const auth = { Authorization: `Bearer ${apiKey()}` };
      // The app's own post-landing reads, then the agent routes these tests
      // call, then /login (spec 4). A 4xx still compiles the route.
      for (const path of ['/api/ai/connection', '/api/reminders/secrets', '/api/agent/gateway']) {
        await page.request.get(path, { timeout: 180_000 });
      }
      await page.request.get('/api/agent/context', { headers: auth, timeout: 180_000 });
      await page.request.patch('/api/agent/tasks/00000000-0000-0000-0000-000000000000', {
        headers: auth,
        data: {},
        timeout: 180_000,
      });
      // Without the session, which would be redirected away before it rendered.
      await fetch(`${BASE_URL}/login`, { signal: AbortSignal.timeout(180_000) });
    } finally {
      await context.close();
    }
  });

  test('reload paints the last session look-only, then settles onto fresh data', async ({
    page,
  }) => {
    const f = fixtures('reload');
    const alpha = f.title('alpha');
    const alphaEdited = f.title('alpha_edited');
    const beta = f.title('beta');
    const alphaId = await createTodayTask(page, alpha);
    let betaId = '';

    try {
      await installSettleAnimationRecorder(page);
      await primeSnapshot(page, alphaId);

      // Elsewhere, after this browser cached its copy: Alpha renamed, Beta new.
      await patchTestTask(page, alphaId, { title: alphaEdited });
      betaId = await createTodayTask(page, beta);

      const load = await holdPlannerLoad(page);
      await page.reload();
      await load.requested;

      // The cached copy, on screen, look-only — and never claiming to be loaded.
      const root = viewRoot(page);
      await expect(root).toHaveAttribute('data-preview', 'true');
      await expect(root).toHaveAttribute('data-loaded', 'false');
      await expect(itemCard(page, alphaId)).toContainText(alpha);
      await expect(itemCard(page, alphaId)).not.toContainText(alphaEdited);
      await expect(itemCard(page, betaId)).toHaveCount(0);
      await expect(page.getByTestId('planner-sync-line')).toBeVisible();

      // A click aimed at the cached row does nothing — and sends nothing.
      const writes: string[] = [];
      page.on('request', (request) => {
        if (isItemWrite(request)) writes.push(`${request.method()} ${request.url()}`);
      });
      const box = await completeButton(page, alphaId).boundingBox();
      expect(box, "Alpha's checkbox has no box on the preview").not.toBeNull();
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await expectCompleted(page, alphaId, false);

      // A create shortcut is unavailable, not deferred: no dialog now or later.
      await page.keyboard.press('n');
      await expect(page.getByTestId('item-dialog')).toHaveCount(0);

      load.release();
      await waitForAppReady(page);

      await expect(root).not.toHaveAttribute('data-preview');
      await expect(page.getByTestId('planner-sync-line')).toHaveCount(0);
      await expect(itemCard(page, alphaId)).toContainText(alphaEdited);
      await expect(itemCard(page, betaId)).toBeVisible();
      await expect(itemCard(page, betaId)).toContainText(beta);

      // The preview's click and keypress left no trace once the data was real.
      await expectCompleted(page, alphaId, false);
      await expect(page.getByTestId('item-dialog')).toHaveCount(0);
      expect(await storedItemStatus(alphaId)).toBe('pending');
      expect(writes, 'an item write left the look-only preview').toEqual([]);

      // The positive control for the reduced-motion test's zero: with motion
      // allowed, a renamed row and a new one DO settle through the conductor.
      expect(await settleAnimMax(page)).toBeGreaterThan(0);
    } finally {
      await cleanupByTitlePrefix(page, f.stem);
    }
  });

  test('a capture typed during the preview lands exactly once after sync', async ({ page }) => {
    const f = fixtures('capture');
    const anchorId = await createTodayTask(page, f.title('anchor'));
    const gamma = f.title('gamma');

    try {
      await primeSnapshot(page, anchorId);

      const load = await holdPlannerLoad(page);
      await page.reload();
      await load.requested;
      await expect(viewRoot(page)).toHaveAttribute('data-preview', 'true');
      await expect(itemCard(page, anchorId)).toBeVisible();

      const input = page.getByTestId('braindump-quick-add-input');
      await input.click();
      await input.fill(gamma);
      await input.press('Enter');

      // Taken, not lost: the field clears and says the capture is held.
      await expect(input).toHaveValue('');
      await expect(page.getByTestId('quick-add-held')).toBeVisible();
      await expect(page.getByTestId('item-card').filter({ hasText: gamma })).toHaveCount(0);

      load.release();
      await waitForAppReady(page);

      await expect(page.getByTestId('item-card').filter({ hasText: gamma })).toHaveCount(1);
      await expect(page.getByTestId('quick-add-held')).toHaveCount(0);
      await expect
        .poll(() => storedItemsTitled(gamma), {
          message: 'the held capture never reached the database',
          timeout: 10_000,
        })
        .toBe(1);
      // Exactly once, still, after the landing's follow-up commits have run.
      await expect(page.getByTestId('item-card').filter({ hasText: gamma })).toHaveCount(1);
      expect(await storedItemsTitled(gamma)).toBe(1);
    } finally {
      await cleanupByTitlePrefix(page, f.stem);
    }
  });

  test("a failed load drops the preview to today's failure state", async ({ page }) => {
    const f = fixtures('fail');
    const anchorTitle = f.title('anchor');
    const anchorId = await createTodayTask(page, anchorTitle);

    try {
      await primeSnapshot(page, anchorId);

      // A sweep receipt, seeded in this context's own localStorage so its
      // action is PRESENT to assert on: "Put back" restores from loaded rows,
      // so it reads "Syncing…" only while a load is in flight, has no verb
      // after a failure, and comes back once a load has actually succeeded.
      await page.evaluate(
        ({ userId, today, item }) => {
          const key = 'dsul-morning-store';
          const stored = JSON.parse(window.localStorage.getItem(key) ?? 'null') ?? {
            state: {},
            version: 1,
          };
          stored.state = {
            ...stored.state,
            morningAutoAgeReceiptByUser: { [userId]: { date: today, items: [item] } },
          };
          window.localStorage.setItem(key, JSON.stringify(stored));
        },
        {
          userId: testUserId(),
          today: getTodayStr(),
          item: {
            id: anchorId,
            title: anchorTitle,
            isScheduled: true,
            startDate: getTodayStr(),
            timeBucket: 'morning',
          },
        }
      );
      const receipt = page.locator('[data-notice-id="auto-age-receipt"]');

      const load = await holdPlannerLoad(page, { failWith: 500 });
      await page.reload();
      await load.requested;

      await expect(viewRoot(page)).toHaveAttribute('data-preview', 'true');
      await expect(itemCard(page, anchorId)).toBeVisible();
      await expect(receipt).toContainText('Syncing…');

      load.release();

      // Today's failure state, exactly: settled, empty, the Retry notice up —
      // and no trace of the cache.
      const root = viewRoot(page);
      await expect(root).toHaveAttribute('data-loaded', 'true');
      await expect(root).not.toHaveAttribute('data-preview');
      await expect(itemCard(page, anchorId)).toHaveCount(0);
      await expect(page.getByTestId('planner-sync-line')).toHaveCount(0);
      const syncError = page.locator('[data-notice-id="sync-error"]');
      await expect(syncError).toBeVisible();
      // Nothing is syncing after a failure, so no verb at all: the Retry beside it is the way on.
      await expect(receipt).toContainText('put aside this morning');
      await expect(receipt).not.toContainText('Syncing…');
      await expect(receipt).not.toContainText('Put back');

      await load.unroute();
      await syncError.getByRole('button', { name: /Retry/ }).click();
      await waitForAppReady(page);

      await expect(itemCard(page, anchorId)).toBeVisible();
      await expect(syncError).toHaveCount(0);
      await expect(receipt).toContainText('Put back');
    } finally {
      await cleanupByTitlePrefix(page, f.stem);
    }
  });

  test('sign-out leaves no snapshot behind', async ({ page }) => {
    const f = fixtures('signout');
    const anchorId = await createTodayTask(page, f.title('anchor'));

    try {
      await primeSnapshot(page, anchorId);
      const userId = testUserId();
      expect(await snapshotKeys(page)).toEqual(expect.arrayContaining([userId, `${userId}#base`]));

      // supabase-js signs out with scope GLOBAL, which revokes every session
      // the account holds — including the one every other worker's
      // storageState is running on. Answer the logout here instead: the
      // client clears its own session and fires SIGNED_OUT exactly as it
      // would on a 204 from the server, and the shared session survives.
      await page.route('**/auth/v1/logout**', (route) =>
        route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } })
      );

      await page.getByRole('button', { name: 'User menu' }).click();
      await page.getByRole('menuitem', { name: 'Sign out' }).click();
      await page.waitForURL('**/login');

      await expect
        .poll(() => snapshotKeys(page), {
          message: 'a snapshot (or its base) survived the sign-out',
          timeout: 10_000,
        })
        .toEqual([]);
      expect(await readSnapshot(page)).toBeNull();
    } finally {
      await cleanupByTitlePrefix(page, f.stem);
    }
  });

  test('reduced motion swaps instantly', async ({ page }) => {
    const f = fixtures('still');
    const anchor = f.title('anchor');
    const anchorEdited = f.title('anchor_edited');
    const anchorId = await createTodayTask(page, anchor);
    let addedId = '';

    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await installSettleAnimationRecorder(page);
      await primeSnapshot(page, anchorId);

      await patchTestTask(page, anchorId, { title: anchorEdited });
      addedId = await createTodayTask(page, f.title('added'));

      const load = await holdPlannerLoad(page);
      await page.reload();
      await load.requested;
      await expect(viewRoot(page)).toHaveAttribute('data-preview', 'true');
      await expect(itemCard(page, anchorId)).toContainText(anchor);
      await expect(itemCard(page, anchorId)).not.toContainText(anchorEdited);

      load.release();
      // The landing shield may raise data-planner-settling for 250ms; this
      // waits it out like any other settle.
      await waitForAppReady(page);

      await expect(itemCard(page, anchorId)).toContainText(anchorEdited);
      await expect(itemCard(page, addedId)).toBeVisible();
      expect(
        await settleAnimMax(page),
        'a settle animation ran under prefers-reduced-motion'
      ).toBe(0);
    } finally {
      await cleanupByTitlePrefix(page, f.stem);
    }
  });
});
