import { test, expect } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { reloadApp, itemCardIn, runCommand } from './helpers/app';
import {
  createTestHabit,
  cleanupTestData,
  cleanupByTitlePrefix,
  cleanupTestCollections,
  specScope,
} from './helpers/api';

/**
 * Programs (memory/plans/programs-routines.md, Phase 3).
 *
 * The contract under test is the layer above routines: a program switches whole
 * sets of work on and off without touching the work itself, and every place it
 * hides something says where it went. Three things are worth an end-to-end run
 * rather than a unit test, because all three cross the store/DB/render boundary:
 *
 *   1. Turning a program off actually removes its members from the grid, and
 *      turning it back on returns them — through the DB, not optimistic state.
 *   2. The hidden work is reachable, and the braindump names the PROGRAM as the
 *      cause rather than leaving twelve rows under one "Paused" heading.
 *   3. Attaching a routine to a program that is off confirms first. That is the
 *      one membership write in the app with a non-obvious consequence, and a
 *      silent version of it looks exactly like a bug.
 *
 * Serial, because every test here creates containers on a SHARED test user and
 * the manager's list is not scoped to the running spec.
 *
 * Serial is file-scoped, though, and this file is no longer the only one that
 * sweeps — so its names and its cleanup live under a prefix it owns, for ITEMS
 * as well as containers. Sweeping the bare TEST_TITLE_PREFIX from two files
 * hard-DELETEs the other's rows mid-test under `fullyParallel` + 4 workers.
 */
const scope = specScope('prog');

test.describe('programs', () => {
  // Longer than the 60s default because every test here drives the manager
  // through several open/edit/close round trips against a dev server, and each
  // one is a palette invocation plus a Radix modal transition. Alone each test
  // lands around 30s; in sequence they cross the default and fail as timeouts
  // that say nothing about programs.
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await loginTestUser(page);
    await cleanupByTitlePrefix(page, scope.prefix);
    await cleanupTestCollections(scope.prefix);
    await reloadApp(page);
  });

  test.afterEach(async () => {
    await cleanupTestCollections(scope.prefix);
  });

  /** The grid, scoped — an unscoped item-card locator also matches the Paused section. */
  const timeline = (page: import('@playwright/test').Page) =>
    page.locator('[data-tour="timeline"]');

  const pausedSection = (page: import('@playwright/test').Page) =>
    page.getByTestId('braindump-paused-section');

  async function openManager(page: import('@playwright/test').Page, tab: 'routines' | 'programs') {
    // Through the palette: the manager is deliberately NOT in the braindump
    // header (that row is width-critical at the 280px minimum), so this and the
    // item chips' "Manage…" rows are the only ways in.
    //
    // Narrowed by the command's own alias rather than a bare '/'. Phase 3 adds
    // up to two dynamic commands PER PROGRAM, so once a test has created a
    // couple the unfiltered list truncates before it reaches this row — which
    // is a real property of the palette, not a test artefact.
    await runCommand(page, 'app.collections', { query: '/routines' });
    await page.getByRole('tab', { name: tab === 'programs' ? 'Programs' : 'Routines' }).click();
  }

  /**
   * Close the manager and PROVE it closed.
   *
   * One Escape is reliably NOT enough, and the reason is worth writing down
   * because it cost an hour: opening the manager through the palette leaves the
   * omnibar's own dismissable layer mounted underneath it, so the first Escape
   * closes the palette and the second closes the dialog. Nothing to do with
   * programs — it is how every palette-opened dialog behaves.
   *
   * Firing one Escape and moving on leaves an overlay over the whole app, and
   * every later step then fails against that overlay rather than against the
   * app, which reads as a completely unrelated bug. So: press until it is
   * actually gone, and assert that it went.
   */
  async function closeManager(page: import('@playwright/test').Page) {
    // A confirm dialog holds the top of the layer stack until its exit
    // animation finishes; an Escape aimed at the manager would be eaten by it.
    await expect(page.locator('[data-slot="alert-dialog-overlay"]')).toHaveCount(0);
    const overlay = page.locator('[data-slot="dialog-overlay"]');
    for (let i = 0; i < 4 && (await overlay.count()) > 0; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }
    await expect(overlay).toHaveCount(0);
  }

  /** Create a container in the manager's new-row and return its id. */
  async function createContainer(
    page: import('@playwright/test').Page,
    kind: 'routine' | 'program',
    name: string
  ): Promise<string> {
    // Creation starts from the list head and opens a form in the detail pane.
    await page.getByTestId(`${kind}-new`).click();
    await page.getByTestId(`${kind}-new-name`).fill(name);
    await page.getByTestId(`${kind}-add`).click();
    // Adding selects the new row, so the detail pane names it — which is also
    // how we learn the id the store minted.
    const detail = page.getByTestId(`${kind}-detail`);
    await expect(detail).toBeVisible();
    const id = await detail.getAttribute(`data-${kind}-id`);
    expect(id).toBeTruthy();
    return id!;
  }

  async function addItemToOpenContainer(
    page: import('@playwright/test').Page,
    kind: 'routine' | 'program',
    title: string
  ) {
    // Opened only if it is closed: the picker stays open across adds (Phase 5d),
    // so this helper has to be safe to call twice against one container.
    const opener = page.getByTestId(`${kind}-member-add`);
    if (await opener.isVisible()) await opener.click();
    await page.getByTestId(`${kind}-member-search`).fill(title);
    await page.getByTestId(`${kind}-member-candidate`).first().click();
    await expect(page.getByTestId(`${kind}-member`)).toHaveCount(1);
  }

  test('turning a program off hides its members; turning it on brings them back', async ({
    page,
  }) => {
    const title = scope.title('member');
    const habitId = await createTestHabit(page, { title, timeBucket: 'morning', streak: 5 });
    try {
      await reloadApp(page);
      // Baseline first — otherwise "not on the grid" could pass for any reason.
      await expect(itemCardIn(timeline(page), habitId)).toHaveCount(1);

      await openManager(page, 'programs');
      await createContainer(page, 'program', scope.title('Summer'));
      await addItemToOpenContainer(page, 'program', title);

      // A new program is born 'auto' with no range, which resolves to
      // always-on, so it wears no state pill — only the exception is labelled.
      // Asserted in here rather than by closing and re-opening: each manager
      // round trip costs several seconds, and this proves the same thing.
      await expect(page.getByTestId('program-state-pill')).toHaveCount(0);
      await page.getByTestId('program-state-chip').click();
      await page.getByTestId('program-state-paused').click();
      await expect(page.getByTestId('program-state-pill')).toHaveCount(1);
      await closeManager(page);

      await expect(itemCardIn(timeline(page), habitId)).toHaveCount(0);

      // It survives a reload — the state write reached the DB rather than
      // living in optimistic state.
      await reloadApp(page);
      await expect(itemCardIn(timeline(page), habitId)).toHaveCount(0);

      // …and it is reachable, named by the program that hid it.
      await page.getByTestId('braindump-paused-toggle').click();
      await expect(itemCardIn(pausedSection(page), habitId)).toHaveCount(1);

      await openManager(page, 'programs');
      await page.getByTestId('program-row').first().click();
      await page.getByTestId('program-state-chip').click();
      await page.getByTestId('program-state-active').click();
      await closeManager(page);

      await expect(itemCardIn(timeline(page), habitId)).toHaveCount(1);
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });

  /**
   * The path that carries the design: item → routine → program. The item joins
   * nothing but the routine, and a program two levels up decides whether it
   * shows.
   */
  test('a program reaches items through a routine it holds', async ({ page }) => {
    const title = scope.title('indirect');
    const habitId = await createTestHabit(page, { title, timeBucket: 'morning' });
    try {
      await reloadApp(page);
      await expect(itemCardIn(timeline(page), habitId)).toHaveCount(1);

      await openManager(page, 'routines');
      await createContainer(page, 'routine', scope.title('Morning'));
      await addItemToOpenContainer(page, 'routine', title);
      await closeManager(page);

      // The routine is standalone and unpaused, so nothing has changed yet.
      await expect(itemCardIn(timeline(page), habitId)).toHaveCount(1);

      await openManager(page, 'programs');
      await createContainer(page, 'program', scope.title('Term'));
      await page.getByTestId('program-state-chip').click();
      await page.getByTestId('program-state-paused').click();

      // Attaching a LIVE standalone routine to a program that is off is the
      // discontinuity decision 3 accepts and the manager announces. The confirm
      // is the feature: without it five items vanish with no explanation.
      await page.getByTestId('program-routine-add').click();
      await page.getByTestId('program-routine-candidate').first().click();
      await page.getByTestId('program-routine-attach-confirm').click();
      await expect(page.getByTestId('program-routine-member')).toHaveCount(1);

      await closeManager(page);
      await expect(itemCardIn(timeline(page), habitId)).toHaveCount(0);

      // Detaching hands the answer back to the routine, which is live.
      await openManager(page, 'programs');
      await page.getByTestId('program-row').first().click();
      await page.getByTestId('program-routine-remove').click();
      await closeManager(page);
      await expect(itemCardIn(timeline(page), habitId)).toHaveCount(1);
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });

  /**
   * The disjunctive rule, end to end (locked decision 3). It is the property
   * that makes a second membership safe to add, so it is worth proving in the
   * real app rather than only in the resolver's table.
   */
  test('a second live path keeps an item on the grid', async ({ page }) => {
    const title = scope.title('union');
    const habitId = await createTestHabit(page, { title, timeBucket: 'morning' });
    try {
      await reloadApp(page);
      // Baseline, and load-bearing as a WAIT: waitForAppReady returns on
      // hydration, which can beat the items fetch. Without this the manager's
      // member search opens against an empty store, finds no candidate, and
      // the test hangs on a locator that will never appear — a failure that
      // hides on a warm server and shows up only in a full-suite run.
      await expect(itemCardIn(timeline(page), habitId)).toHaveCount(1);

      await openManager(page, 'programs');
      const offName = scope.title('Off');
      await createContainer(page, 'program', offName);
      await addItemToOpenContainer(page, 'program', title);
      await page.getByTestId('program-state-chip').click();
      await page.getByTestId('program-state-paused').click();
      await closeManager(page);
      await expect(itemCardIn(timeline(page), habitId)).toHaveCount(0);

      await openManager(page, 'programs');
      await createContainer(page, 'program', scope.title('On'));
      await addItemToOpenContainer(page, 'program', title);
      await closeManager(page);

      // One live path is enough — the paused program is still holding it.
      await expect(itemCardIn(timeline(page), habitId)).toHaveCount(1);
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });
});
