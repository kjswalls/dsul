import { test, expect, type Page } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { reloadApp, runCommand, setLayout, setScope, waitForAppReady } from './helpers/app';
import {
  cleanupByTitlePrefix,
  cleanupTestGoals,
  fetchTestGoal,
  fetchTestGoalMembers,
  specScope,
} from './helpers/api';

/**
 * GOALS — the aspire container (memory/plans/long-term-goals.md).
 *
 * What is worth an end-to-end run rather than a unit test is everything that
 * crosses the store/DB/render boundary, which is exactly where this feature's
 * two shipped blockers lived and where the unit suite could not see them:
 *
 *   1. **A goal's surfaces actually respond.** The `/goal/[id]` Organize button
 *      shipped INERT — it armed a dialog mounted only in AppShell, which that
 *      route does not render — and 1375 green unit tests said nothing, because
 *      nothing about it is a pure function. One assertion here is the whole
 *      cost of never shipping that class of bug again.
 *   2. **An inline-created milestone is FINDABLE.** It shipped bucketed, which
 *      removed it from the braindump (the only list undated work lives in) and
 *      added it to no day column, so it existed on no planner surface at all.
 *      The store test asserted the field; only a rendered surface asserts the
 *      consequence.
 *   3. **A role survives the round trip as a ROLE.** The arrays are an app-side
 *      view of one join table, and every path that flattens them — a bin
 *      snapshot, a partial patch — silently turns milestones into plain
 *      members. Reading `goal_items` back is the only proof.
 *
 * Serial, and under its OWN prefix. Every test writes rows on the shared test
 * user, and sweeping the bare TEST_TITLE_PREFIX from two files hard-DELETEs the
 * other's fixtures mid-test under `fullyParallel` with 4 workers — the lesson
 * programs.spec.ts had to learn once.
 */
const scope = specScope('goal');

test.describe('goals', () => {
  // Each test drives the console through several open/edit/close round trips
  // against a dev server; each one is a palette invocation plus a Radix modal
  // transition. Same budget programs.spec.ts and organize.spec.ts take.
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await loginTestUser(page);
    await cleanupTestGoals(scope.prefix);
    await cleanupByTitlePrefix(page, scope.prefix);
    await reloadApp(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanupTestGoals(scope.prefix);
    await cleanupByTitlePrefix(page, scope.prefix);
  });

  /**
   * Through the palette by the command's own alias — the route every console
   * spec uses, because an unfiltered list truncates before it reaches the row
   * once a few dynamic commands exist.
   */
  async function openGoals(page: Page) {
    await runCommand(page, 'app.goals', { query: '/goals' });
    await expect(page.getByRole('tab', { name: 'Goals' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    // Fail in ten seconds with the real cause rather than in two minutes with
    // none. `goal-add` is disabled while `goalsAvailable` is false — exactly the
    // state of a database without migration 036 — and waitForAppReady's
    // `data-loaded` gate does not cover that flag, so the click below would
    // block on actionability for the whole describe timeout and take the other
    // cases down with it under `mode: 'serial'`.
    await expect(
      page.getByTestId('goals-unavailable'),
      'goals are unavailable on this account — is migration 036 applied?'
    ).toHaveCount(0);
  }

  /** Close, and PROVE it closed — see programs.spec.ts on the two-Escape dance. */
  async function closeConsole(page: Page) {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }

  async function createGoal(page: Page, name: string) {
    await openGoals(page);
    // Creation starts from the list head and opens a form in the detail pane.
    await page.getByTestId('goal-new').click();
    await page.getByTestId('goal-new-name').fill(name);
    await page.getByTestId('goal-add').click();
    // The store write is fire-and-forget, so wait for the ROW rather than
    // assuming the click landed.
    await expect(page.getByTestId('goal-row').filter({ hasText: name })).toBeVisible();
  }

  test('a goal is created, persists, and opens its own page', async ({ page }) => {
    const name = scope.title('chinese');
    await createGoal(page, name);

    // Poll the DATABASE before reloading: a reload on the strength of a DOM
    // assertion can abort the INSERT still in flight, and the failure then
    // surfaces several steps later as something else entirely.
    await expect.poll(async () => (await fetchTestGoal(scope.prefix))?.name).toBe(name);

    await page.getByTestId('goal-row').filter({ hasText: name }).click();
    await page.getByTestId('goal-open-page').click();

    await expect(page).toHaveURL(/\/goal\/[0-9a-f-]+$/);
    await expect(page.getByRole('heading', { name })).toBeVisible();
  });

  test('the goal page’s Organize button actually reaches the console', async ({ page }) => {
    // The Phase 2 blocker, pinned. It armed a dialog that this route does not
    // mount, so the click did nothing — and because ui-store is a module
    // singleton, the armed dialog then sprang open on the NEXT navigation.
    const name = scope.title('organize');
    await createGoal(page, name);
    await page.getByTestId('goal-row').filter({ hasText: name }).click();
    await page.getByTestId('goal-open-page').click();
    await expect(page).toHaveURL(/\/goal\//);

    await page.getByTestId('goal-page-organize').click();

    await expect(page).toHaveURL(/\/$|\/\?/);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Goals' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  test('an inline milestone is findable in the braindump, and stored AS a milestone', async ({
    page,
  }) => {
    const name = scope.title('milestones');
    const milestone = scope.title('hsk3');
    await createGoal(page, name);
    await page.getByTestId('goal-row').filter({ hasText: name }).click();

    await page.getByTestId('goal-new-milestone-new-name').fill(milestone);
    await page.getByTestId('goal-new-milestone-add').click();

    // Stored as a MILESTONE, not a plain member. The arrays are an app-side
    // view of one join table; only reading the table back proves the role.
    // POLLED, not awaited once: the goal was written by a fire-and-forget
    // `dbCreateGoal(...).catch(console.error)`, and three UI actions is not a
    // guarantee the round trip landed.
    await expect.poll(async () => (await fetchTestGoal(scope.prefix))?.name).toBe(name);
    const goal = (await fetchTestGoal(scope.prefix))!;
    await expect
      .poll(async () => {
        const rows = await fetchTestGoalMembers(goal!.id);
        return rows.find((r) => r.role === 'milestone') ? 'milestone' : rows[0]?.role ?? 'none';
      })
      .toBe('milestone');

    await closeConsole(page);

    // FINDABLE. It ships undated and unbucketed precisely so it lands here —
    // the first version bucketed it, which removed it from this list and added
    // it to no day column, leaving it visible on no planner surface at all.
    await expect(page.getByTestId('braindump').getByText(milestone)).toBeVisible();
  });

  test('completing the last dated milestone offers achievement without taking it', async ({
    page,
  }) => {
    const name = scope.title('celebrate');
    await createGoal(page, name);
    await page.getByTestId('goal-row').filter({ hasText: name }).click();

    const milestone = scope.title('exam');
    await page.getByTestId('goal-new-milestone-new-name').fill(milestone);
    await page.getByTestId('goal-new-milestone-add').click();
    await closeConsole(page);

    const row = page
      .getByTestId('braindump')
      .locator('[data-testid="item-card"]')
      .filter({ hasText: milestone });
    await expect(row).toBeVisible();
    await row.getByTestId('item-complete-button').click();

    // OFFERS. Achieving is a statement about a stretch of your life, and the
    // app must never make it for you.
    //
    // Asserted against the TOAST, not against `getByText(/milestone/i)`: the
    // row this test just created renders `<span class="sr-only">Milestone of
    // …</span>`, and `sr-only` keeps a 1x1 box, so that matcher was green
    // whether or not the offer ever appeared. Clicking the action IS the proof
    // the offer was made, so it comes before the DB read — a poll in between
    // can outlive the toast's 8s life and fail as "button not found", which
    // says nothing about goals.
    const offer = page
      .locator('[data-sonner-toast]')
      .filter({ hasText: name })
      .getByRole('button', { name: 'Mark achieved' });
    await expect(offer).toBeVisible();

    // Still active WHILE the offer stands — the "without taking it" half.
    expect((await fetchTestGoal(scope.prefix))?.state).toBe('active');

    await offer.click();
    await expect.poll(async () => (await fetchTestGoal(scope.prefix))?.state).toBe('achieved');
  });

  test('an ended goal names the work it leaves running', async ({ page }) => {
    // Decision 5's wind-down. An achieved goal stops appearing in chips and
    // lists, but its recurring members keep arriving forever with the reason
    // stripped away — and this is the last moment the connection is obvious.
    const name = scope.title('winddown');
    await createGoal(page, name);
    await page.getByTestId('goal-row').filter({ hasText: name }).click();

    const checkin = scope.title('review');
    await page.getByTestId('goal-new-checkin-new-name').fill(checkin);
    await page.getByTestId('goal-new-checkin-add').click();
    // `goal-checkin-member`, not `-member-row`: member-list renders each row as
    // `${testPrefix}-member`, and the `-row` suffix this asserted for existed
    // nowhere in the app. The first real run of this file caught it — static
    // review had passed over it three times.
    await expect(
      page.getByTestId('goal-checkin-member').filter({ hasText: checkin })
    ).toBeVisible();

    // Status is a chip now (2026-09-25); its options exist once it is open.
    await page.getByTestId('goal-state-chip').click();
    await page.getByTestId('goal-state-achieved').click();

    const windDown = page.getByTestId('goal-wind-down');
    await expect(windDown).toBeVisible();
    await expect(windDown.getByText(checkin)).toBeVisible();
    // It NAMES them and offers the verb; it never acts on the goal's behalf.
    await expect(windDown.getByTestId('goal-wind-down-delete')).toBeVisible();

    // And the promise itself: achieving touched nothing. The member is still
    // there and still a check-in — the goal writes to its members never.
    const goal = (await fetchTestGoal(scope.prefix))!;
    await expect
      .poll(async () => (await fetchTestGoalMembers(goal.id)).map((r) => r.role).sort())
      .toEqual(['checkin']);
  });

  test('a new check-in reaches the canvas, not just the goal', async ({ page }) => {
    // The Phase 3 blocker, pinned. It shipped bucketed-but-undated, and a
    // recurring TASK is gated by its anchor — deriveDayItems returns false on
    // `!startDate` before it ever reaches shouldShowOnDate — so it rendered on
    // no column, while the bucket also kept it out of the braindump. The
    // wind-down assertion in the test above passed the whole time, which is
    // exactly why this one exists: it asserts the CONSEQUENCE, not the field.
    const name = scope.title('oncanvas');
    const checkin = scope.title('sundayreview');
    await createGoal(page, name);
    await page.getByTestId('goal-row').filter({ hasText: name }).click();
    await page.getByTestId('goal-new-checkin-new-name').fill(checkin);
    await page.getByTestId('goal-new-checkin-add').click();
    await closeConsole(page);
    await waitForAppReady(page);

    // PIN THE CANVAS BEFORE WALKING IT. Both of these are per-user settings
    // shared by the whole suite, and view-matrix.spec mutates them — when it
    // fails partway through pickDisplay (it currently does) it leaves them
    // wherever it got to, so this test inherited a different canvas run to run.
    // Layout matters because `item-card` comes from task-row alone; the Schedule
    // layout renders `schedule-block`, so the row is on the page under a name
    // this locator cannot see. Scope matters because an arrow key steps SEVEN
    // days under Week, so the day walk below would stride straight past it.
    await setScope(page, 'Day');
    await setLayout(page, 'Buckets');
    // Seeded weekly-on-Sunday and anchored at today, so it renders on the next
    // Sunday at the latest. Walk forward rather than assuming today is one.
    // Bounded OUTSIDE the assertion. Inside expect.poll the callback re-runs
    // until the poll times out, pressing ArrowRight seven more times each pass —
    // so the walk never stopped at a week, and a pass could land on an
    // occurrence far outside the range the failure message claims to describe.
    let found = false;
    for (let i = 0; i < 7 && !found; i += 1) {
      found = await page.getByText(checkin).first().isVisible().catch(() => false);
      if (found) break;
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(150);
    }
    expect(found, 'the new check-in never appeared on any day of the coming week').toBe(true);
  });

  test('completing a check-in offers the note and the trip back', async ({ page }) => {
    // The plan's Verification gates name this case by name, and it is the one
    // the phase exists for: a check-in is completed where every recurring item
    // is, so the bridge has to come to the completion rather than wait on the
    // goal page. Without it Phase 3 is a recurring task with extra bookkeeping.
    const name = scope.title('bridge');
    const checkin = scope.title('weeklyreview');
    await createGoal(page, name);
    await page.getByTestId('goal-row').filter({ hasText: name }).click();
    await page.getByTestId('goal-new-checkin-new-name').fill(checkin);
    await page.getByTestId('goal-new-checkin-add').click();
    await closeConsole(page);
    await waitForAppReady(page);

    // PIN THE CANVAS BEFORE WALKING IT. Both of these are per-user settings
    // shared by the whole suite, and view-matrix.spec mutates them — when it
    // fails partway through pickDisplay (it currently does) it leaves them
    // wherever it got to, so this test inherited a different canvas run to run.
    // Layout matters because `item-card` comes from task-row alone; the Schedule
    // layout renders `schedule-block`, so the row is on the page under a name
    // this locator cannot see. Scope matters because an arrow key steps SEVEN
    // days under Week, so the day walk below would stride straight past it.
    await setScope(page, 'Day');
    await setLayout(page, 'Buckets');
    // Walk to the day it falls on — seeded weekly-on-Sunday, anchored today.
    let row = page.locator('[data-testid="item-card"]').filter({ hasText: checkin });
    for (let i = 0; i < 7 && !(await row.count()); i += 1) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(150);
      row = page.locator('[data-testid="item-card"]').filter({ hasText: checkin });
    }
    await expect(row.first(), 'the check-in never appeared on any day this week').toBeVisible();

    await row.first().getByTestId('item-complete-button').click();

    const toast = page.locator('[data-sonner-toast]').filter({ hasText: name });
    await expect(toast).toBeVisible();
    await expect(toast.getByRole('button', { name: 'Add a note' })).toBeVisible();
    await expect(toast.getByRole('button', { name: 'View goal' })).toBeVisible();
  });

  test('deleting a goal leaves its members alone', async ({ page }) => {
    // The promise the delete confirm makes, and the whole point of the aspire
    // role: the goal is the WHY layer, so removing it must not remove the work.
    const name = scope.title('delete');
    const milestone = scope.title('survivor');
    await createGoal(page, name);
    await page.getByTestId('goal-row').filter({ hasText: name }).click();
    await page.getByTestId('goal-new-milestone-new-name').fill(milestone);
    await page.getByTestId('goal-new-milestone-add').click();

    // Delete lives behind the pane's ⋯ menu (2026-09-25).
    await page.getByTestId('goal-more').click();
    await page.getByTestId('delete-goal').click();
    // By testid, not by label: confirm-dialog.tsx carries this id precisely
    // because the confirm LABEL is caller-supplied and "Delete" collides with
    // three other buttons in the app.
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-confirm').click();

    await expect.poll(async () => await fetchTestGoal(scope.prefix)).toBeNull();
    await closeConsole(page);

    // RELOADED. Without this the braindump being asserted is the same in-memory
    // items[] that removeGoal never touches by construction — so the test would
    // pass on optimistic state while the failure it exists to catch (a cascade
    // taking the members with the goal) lives entirely in the database.
    await reloadApp(page);
    await waitForAppReady(page);
    await expect(page.getByTestId('braindump').getByText(milestone)).toBeVisible();
  });
});
