import { test, expect } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { reloadApp, runCommand, itemCard } from './helpers/app';
import {
  testTitle,
  createTestTask,
  createTestHabit,
  cleanupTestData,
  cleanupTestLabels,
  cleanupTestCollections,
  specScope,
  fetchTestItemTypePlural,
} from './helpers/api';

/**
 * The Organize console's LABEL half — projects, item types and habit groups
 * (memory/plans/organize-console.md, Phase 3).
 *
 * This half of the app has never had an end-to-end test, and until Phase 2 it
 * had no data-testid either: it was a 400px dialog of rows with a hover trash on
 * each, and `tests/` reached none of it. The routines/programs half is covered
 * by programs.spec.ts, which must keep passing unchanged.
 *
 * What is worth an end-to-end run rather than a unit test — everything here
 * crosses the store/DB/render boundary, which is where the unit tests stop:
 *
 *   1. A project's time block reaches the GRID. The dialog that used to own that
 *      form was absorbed into the detail pane and deleted, and its buffered
 *      Save became live patching — so the question "does the block still land"
 *      is a new question, not a regression check.
 *   2. Deleting a habit group MOVES its habits somewhere specific. The console
 *      promises a named destination in the confirm copy; the store computes it.
 *      Only a real delete proves the sentence and the write agree.
 *   3. A custom type survives a reload and reaches the add dialog, which is the
 *      only thing that makes an item type worth creating.
 *
 * Serial, and under its own container prefix: every test creates rows on the
 * SHARED test user and the console's lists are not scoped to the running spec.
 * Sweeping the bare TEST_TITLE_PREFIX from two files hard-DELETEs the other's
 * rows mid-test under `fullyParallel` + 4 workers.
 */
const scope = specScope('org');

test.describe('organize — projects, types and groups', () => {
  // Same reasoning as programs.spec.ts: each test drives the console through
  // several open/edit/close round trips against a dev server, and each one is a
  // palette invocation plus a Radix modal transition.
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await loginTestUser(page);
    // NOT cleanupByTitlePrefix(TEST_TITLE_PREFIX) — the header above says why
    // and the first full-suite run proved it: sweeping the BARE prefix
    // hard-deletes every other spec's fixtures mid-test under `fullyParallel`,
    // and they do the same to this one. This spec passed 7/7 alone and failed
    // in the parallel run for exactly that reason. globalSetup already sweeps
    // the bare prefix once, before anything is running.
    await cleanupTestLabels(scope.prefix);
    await reloadApp(page);
  });

  test.afterEach(async () => {
    await cleanupTestLabels(scope.prefix);
  });

  /**
   * Through the palette, by the command's own alias — the same route
   * programs.spec.ts uses, and for the same reason: an unfiltered list truncates
   * before it reaches the row once a few dynamic commands exist.
   *
   * `app.categories` keeps its id and its aliases through the rename (decision
   * 1), so this is stable across the Manage → Organize change.
   */
  async function openConsole(page: import('@playwright/test').Page, tab: string) {
    await runCommand(page, 'app.categories', { query: '/projects' });
    await page.getByRole('tab', { name: tab }).click();
  }

  /** Close and PROVE it closed — see programs.spec.ts's note on the two-Escape dance. */
  async function closeConsole(page: import('@playwright/test').Page) {
    await expect(page.locator('[data-slot="alert-dialog-overlay"]')).toHaveCount(0);
    const overlay = page.locator('[data-slot="dialog-overlay"], [data-slot="drawer-overlay"]');
    for (let i = 0; i < 4 && (await overlay.count()) > 0; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }
    await expect(overlay).toHaveCount(0);
  }

  async function createLabel(
    page: import('@playwright/test').Page,
    kind: 'project' | 'type',
    name: string
  ) {
    // Creation starts from the list head and opens a form in the detail pane.
    await page.getByTestId(`${kind}-new`).click();
    await page.getByTestId(`${kind}-new-name`).fill(name);
    await page.getByTestId(`${kind}-add`).click();
    // Creating selects the new row, so the detail pane names it — which is also
    // how we learn the id the store minted.
    const detail = page.getByTestId(`${kind}-detail`);
    await expect(detail).toBeVisible();
    return (await detail.getAttribute(`data-${kind}-id`))!;
  }

  /* ── projects ───────────────────────────────────────────────────────── */

  test('a project survives a reload and reports what it holds', async ({ page }) => {
    const title = testTitle('org-project');
    const taskId = await createTestTask(page, { title });
    const name = scope.title('Work');
    try {
      await reloadApp(page);
      await openConsole(page, 'Projects');
      const id = await createLabel(page, 'project', name);
      expect(id).toBeTruthy();
      await closeConsole(page);

      // Through the DB, not optimistic state: the create is fire-and-forget, so
      // a DOM assertion right after the click proves only that set() ran.
      await reloadApp(page);
      await openConsole(page, 'Projects');
      await expect(
        page.locator(`[data-testid="project-row"][data-project-id="${id}"]`)
      ).toBeVisible();
      await closeConsole(page);
    } finally {
      await cleanupTestData(page, [taskId], []);
    }
  });

  test('a project time block reaches the grid', async ({ page }) => {
    // The absorbed EditProjectDialog's whole purpose. lib/day-items.ts needs
    // startTime AND timeBucket AND repeatFrequency to render a block, and the
    // switch now has to write all three — a version that wrote two would leave
    // the control reading "on" with nothing on the canvas.
    const name = scope.title('Deep');
    try {
      await openConsole(page, 'Projects');
      await createLabel(page, 'project', name);

      await page.getByTestId('project-block-toggle').click();
      await expect(page.getByTestId('project-start-time')).toBeVisible();
      // Afternoon rather than morning, and a COUNT rather than a visibility
      // check: the schedule fits the day with an adaptive window, so a 05:00
      // block can legitimately sit outside the rendered hours and a visibility
      // assertion would be testing the window, not the write.
      await page.getByTestId('project-bucket-afternoon').click();
      await closeConsole(page);

      await reloadApp(page);
      await expect(page.getByTestId('project-block').filter({ hasText: name })).toHaveCount(1);
    } finally {
      await cleanupTestLabels(scope.prefix);
    }
  });

  test('deleting a project unfiles its items instead of deleting them', async ({ page }) => {
    // The delete copy promises exactly this, and "delete" otherwise reads as
    // subtraction. The item must still exist afterwards.
    //
    // THE TASK IS FILED UNDER THE PROJECT BEING DELETED, and that is the whole
    // test. With an unfiled fixture the confirm renders its "nothing is filed
    // under it" arm, removeProject's rewriting branch matches no rows, and the
    // closing assertion says only that an unrelated task exists — it would stay
    // green if the delete removed every item it owned, which is precisely what
    // the title claims to guard. `items.project` is free text with no FK, so a
    // task may name the project before the row exists.
    const title = testTitle('org-unfile');
    const name = scope.title('Temporary');
    const taskId = await createTestTask(page, { title, project: name });
    try {
      await reloadApp(page);
      await openConsole(page, 'Projects');
      await createLabel(page, 'project', name);
      await page.getByTestId('project-delete').click();
      // Reads the count out of the copy, which fails loudly if the association
      // ever breaks — the survival assertion below would not.
      await expect(page.getByTestId('confirm-dialog')).toContainText('Its 1 item stays');
      await page.getByTestId('category-delete-confirm').click();
      await closeConsole(page);

      // By id, not by title text: `item-card` is emitted from two render paths
      // in task-row.tsx, so a text filter can legitimately match twice.
      await expect(itemCard(page, taskId)).toHaveCount(1);
    } finally {
      await cleanupTestData(page, [taskId], []);
    }
  });

  /* ── item types ─────────────────────────────────────────────────────── */

  test('a reserved slug is refused OUT LOUD, not by a dead button', async ({ page }) => {
    // The dialog this replaced disabled the add button and explained nothing, so
    // the only way to learn the rule was to fail at it.
    await openConsole(page, 'Item types');
    // The form lives in the detail pane now; the list head opens it.
    await page.getByTestId('type-new').click();
    await page.getByTestId('type-new-name').fill('Task');
    await expect(page.getByTestId('type-new-problem')).toContainText('built-in name');
    await expect(page.getByTestId('type-add')).toBeDisabled();

    await page.getByTestId('type-new-name').fill(scope.title('Goal'));
    await expect(page.getByTestId('type-new-problem')).toHaveCount(0);
    await expect(page.getByTestId('type-add')).toBeEnabled();
    await closeConsole(page);
  });

  test('a custom type persists and its plural is editable', async ({ page }) => {
    // updateItemType has always accepted labelPlural; no UI ever offered it, so
    // an irregular plural could be created and never corrected.
    const name = scope.title('Quest');
    await openConsole(page, 'Item types');
    const id = await createLabel(page, 'type', name);

    await page.getByTestId('type-plural').fill(`${name}es`);
    await page.getByTestId('type-plural').press('Enter');

    // WAIT FOR THE ROW, not for the keystroke. `updateItemType` fires its PATCH
    // fire-and-forget (`.catch(console.error)`), so Enter proves only that the
    // optimistic store write ran; reloading on the strength of that aborts the
    // request still in flight. Without this the test read the CREATION default
    // `${name}s` back and failed — which it did, on the first full parallel run,
    // after passing 10/10 in isolation for a whole phase.
    await expect.poll(() => fetchTestItemTypePlural(id)).toBe(`${name}es`);

    await closeConsole(page);
    await reloadApp(page);
    await openConsole(page, 'Item types');
    await page.locator(`[data-testid="type-row"][data-type-id="${id}"]`).click();
    await expect(page.getByTestId('type-plural')).toHaveValue(`${name}es`);
    await closeConsole(page);
  });

  /* ── habit groups ───────────────────────────────────────────────────── */

  test('deleting a habit group moves its habits to the group the copy names', async ({ page }) => {
    // removeHabitGroup REASSIGNS rather than unassigns, and the old dialog's copy
    // claimed the opposite. The console names the destination; this proves the
    // sentence and the write agree.
    // THE HABIT GOES IN THE DOOMED CONTAINER. An empty one exercises the "nothing
    // moves" arm, where the destination clause never renders and the write
    // rewrites no rows — the test would then stay green with the reassignment
    // pointed anywhere, or removed.
    //
    // ONE CLASSIFY KIND since migration 039, so this drives the PROJECTS section
    // and the habit is an ordinary member of a project. What still makes it a
    // reassignment rather than an unfile is the registry's `containerRequired`.
    const title = testTitle('org-group');
    const doomed = scope.title('Doomed');
    const habitId = await createTestHabit(page, { title, timeBucket: 'morning', group: doomed });
    try {
      await reloadApp(page);
      await openConsole(page, 'Projects');
      // A DESTINATION HAS TO EXIST, and on this account none may. `unfiled` sends
      // a required-container member to `projects.find(p => p.id !== deleted)?.name
      // ?? 'Personal'`, so with no sibling the fallback fires and names a
      // container with no row — a real behaviour (covered in
      // tests/unit/container-ids.test.ts) but not the one this test is about.
      // Creating a sibling first makes the reassignment observable instead of
      // depending on whatever the shared account happens to hold.
      await createLabel(page, 'project', scope.title('Haven'));
      await createLabel(page, 'project', doomed);

      await page.getByTestId('project-delete').click();
      // Asserted on the confirm itself rather than by walking up from the button
      // with an xpath — the prompt is the surface the user actually reads, and
      // `confirm-dialog` is a stable id the shell owns. The tail is asserted
      // separately because labels.tsx appends it to BOTH arms, so on its own it
      // cannot tell the two apart.
      const copy = (await page.getByTestId('confirm-dialog').textContent())!;
      expect(copy).toContain('The habit moves to');
      expect(copy).toContain('⌘Z brings it back');
      const destination = /moves to “([^”]+)”/.exec(copy)?.[1];
      expect(destination).toBeTruthy();

      // The count the destination row shows, BEFORE the delete. Read in-session
      // and asserted in-session: the reassignment is deliberately store-only —
      // dbDeleteProject stamps deleted_at and `items.project` is free text with
      // no FK or trigger, so a reload would re-read the dead name and this
      // assertion would go red on correct code.
      const destRow = page
        .locator('[data-testid="project-row"]')
        .filter({ hasText: destination! })
        .first();
      // Asserted before reading, so a missing destination fails in 10s naming
      // the row it wanted, rather than hanging the whole test to its 120s
      // timeout inside textContent().
      await expect(destRow, `no row for the destination the copy named: ${destination}`)
        .toBeVisible();
      const before = Number(/(\d+)\s*$/.exec((await destRow.textContent())!)![1]);

      await page.getByTestId('category-delete-confirm').click();
      await expect(destRow).toContainText(String(before + 1));
      await closeConsole(page);

      // And nothing was deleted — a container delete never deletes work.
      await expect(itemCard(page, habitId)).toHaveCount(1);
    } finally {
      await cleanupTestData(page, [], [habitId]);
    }
  });

  /* ── the section filter ─────────────────────────────────────────────── */

  test('the filter narrows the current section and Escape clears it', async ({ page }) => {
    const keep = scope.title('Keeper');
    const other = scope.title('Zebra');
    try {
      await openConsole(page, 'Projects');
      await createLabel(page, 'project', keep);
      await createLabel(page, 'project', other);

      await page.getByTestId('project-filter').fill('Zebra');
      await expect(page.getByTestId('project-row')).toHaveCount(1);

      // Rung 1 of the Escape ladder: clear the query, and do NOT close the plate.
      await page.getByTestId('project-filter').press('Escape');
      await expect(page.getByTestId('project-filter')).toHaveValue('');
      await expect(page.getByTestId('organize-console')).toBeVisible();
      await closeConsole(page);
    } finally {
      await cleanupTestLabels(scope.prefix);
    }
  });

  /* ── the Trash (Phase 4) ────────────────────────────────────────────── */

  /**
   * EVERY ASSERTION HERE IS SCOPED TO ITS OWN FIXTURE, and that is not
   * fastidiousness. The shared e2e account's bin is NOT empty — it currently
   * holds around fourteen rows of accumulated residue that globalSetup's sweep
   * cannot see (it hard-deletes `items` titled `e2e_*` and never touches trashed
   * CONTAINERS), plus whatever another spec's afterEach soft-deleted a second
   * ago under `fullyParallel`. So: never a row count, never "the first row",
   * never an empty-state assertion. Always this test's own name.
   */
  function trashRow(page: import('@playwright/test').Page, kind: string, name: string) {
    return page
      .locator(`[data-testid="trash-row"][data-trash-kind="${kind}"]`)
      .filter({ hasText: name });
  }

  test('a deleted project reaches the Trash, comes back with its items, and ⌘Z re-deletes it', async ({
    page,
  }) => {
    // THE PHASE 4 GATE. Four claims, and each is a different way the feature
    // can look correct and not be:
    //   1. the row appears in the bin at all;
    //   2. restoring puts the CONTAINER back without a reload;
    //   3. restoring RE-FILES THE MEMBERS — the link survives the delete in the
    //      database on purpose (027), and a restore that ignored it returns a
    //      visibly empty project;
    //   4. ⌘Z re-deletes, which is decision 3's whole contract.
    //
    // THE ORDER OF THE FIXTURE IS THE TEST. The first version created the task
    // first, so `items.project` held the name while `project_id` stayed NULL —
    // the parked name-reference case — and claim 3 was not merely unasserted
    // but UNREACHABLE: with no id link there is nothing for the re-file to
    // reconnect. Creating the project first makes the agent-side create resolve
    // the name to a real id (lookupContainerId), which is the only way this
    // exercises the path it is named for.
    const title = testTitle('org-trash');
    const name = scope.title('Recoverable');
    let taskId = '';
    try {
      await openConsole(page, 'Projects');
      const projectId = await createLabel(page, 'project', name);
      await closeConsole(page);

      taskId = await createTestTask(page, { title, project: name });
      await reloadApp(page);
      await openConsole(page, 'Projects');
      await page.locator(`[data-testid="project-row"][data-project-id="${projectId}"]`).click();

      await page.getByTestId('project-delete').click();
      // The count proves the association before anything is deleted — it fails
      // loudly if the fixture ever stops linking.
      await expect(page.getByTestId('confirm-dialog')).toContainText('Its 1 item stays');
      await page.getByTestId('category-delete-confirm').click();

      // 1. In the bin, named, and labelled with its kind.
      await page.getByRole('tab', { name: 'Trash' }).click();
      const row = trashRow(page, 'project', name);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('Project');
      // The row says what comes back with it, before the click.
      await expect(row).toContainText('1 item refile');

      // 2. Back on the canvas without a reload.
      await row.getByTestId('trash-restore').click();
      await expect(row).toHaveCount(0);
      await page.getByRole('tab', { name: 'Projects' }).click();
      const projectRow = page.locator(
        `[data-testid="project-row"][data-project-id="${projectId}"]`
      );
      await expect(projectRow).toBeVisible();

      // 3. And it is not an empty shell. The row's count is computed live off
      // the store (`i.project === name`), so a 1 here is the member having been
      // re-filed in the same set() the container came back in — the delete had
      // cleared both halves.
      await expect(projectRow).toContainText('1');

      // 4. ⌘Z re-deletes. Pressed on the console, which claims the bare-key
      // space but never a modifier chord — see use-command-shortcuts' guard.
      await page.keyboard.press('ControlOrMeta+z');
      await expect(projectRow).toHaveCount(0);
      await closeConsole(page);
    } finally {
      await cleanupTestData(page, taskId ? [taskId] : [], []);
      await cleanupTestLabels(scope.prefix);
    }
  });

  test('a deleted routine keeps its membership through the Trash and back', async ({ page }) => {
    // The one that would pass while destroying data. `itemIds` is not a column —
    // only fetchRoutines produces it and it hard-filters deleted_at — so a
    // Trash restore that seats the routine with `itemIds: []` looks perfect: the
    // row is back on the canvas without a reload, exactly as the gate demands.
    // The next membership edit then hard-DELETEs every join row the soft delete
    // existed to preserve, with no soft delete to recover from.
    const title = testTitle('org-trash-member');
    const taskId = await createTestTask(page, { title });
    const name = scope.title('Ritual');
    try {
      await reloadApp(page);
      await runCommand(page, 'app.collections', { query: '/routines' });
      await page.getByRole('tab', { name: 'Routines' }).click();
      await page.getByTestId('routine-new').click();
      await page.getByTestId('routine-new-name').fill(name);
      await page.getByTestId('routine-add').click();
      await expect(page.getByTestId('routine-detail')).toBeVisible();

      // Same three steps programs.spec.ts:127-130 uses, so the two specs cannot
      // drift about what "add a member" means.
      await page.getByTestId('routine-member-add').click();
      await page.getByTestId('routine-member-search').fill(title);
      await page.getByTestId('routine-member-candidate').first().click();
      await expect(page.getByTestId('routine-member')).toHaveCount(1);

      await page.getByTestId('routine-more').click();
      await page.getByTestId('routine-delete').click();
      await page.getByTestId('confirm-dialog-confirm').click();

      await page.getByRole('tab', { name: 'Trash' }).click();
      const row = trashRow(page, 'routine', name);
      await expect(row).toHaveCount(1);
      await row.getByTestId('trash-restore').click();

      // The member is still there — in session, and after a reload, which is
      // what proves the join rows were never touched.
      await page.getByRole('tab', { name: 'Routines' }).click();
      await page.getByTestId('routine-row').filter({ hasText: name }).click();
      await expect(page.getByTestId('routine-member')).toHaveCount(1);
      await closeConsole(page);

      await reloadApp(page);
      await runCommand(page, 'app.collections', { query: '/routines' });
      await page.getByRole('tab', { name: 'Routines' }).click();
      await page.getByTestId('routine-row').filter({ hasText: name }).click();
      await expect(page.getByTestId('routine-member')).toHaveCount(1);
      await closeConsole(page);
    } finally {
      await cleanupTestData(page, [taskId], []);
      await cleanupTestCollections(scope.prefix);
    }
  });

  test('a name a trashed project still holds is refused OUT LOUD on the create row', async ({
    page,
  }) => {
    // A live bug before Phase 4, and the loudest half of it. The unique index
    // spans soft-deleted rows, but addProject de-dupes against the store, which
    // only ever loads live ones — so the insert 23505'd into console.error AFTER
    // the optimistic set(). The user got a project that opened, accepted a
    // colour and a whole time block, and evaporated on reload.
    const name = scope.title('Ghost');
    try {
      await openConsole(page, 'Projects');
      await createLabel(page, 'project', name);
      await page.getByTestId('project-delete').click();
      await page.getByTestId('category-delete-confirm').click();
      await closeConsole(page);

      // Reopened, so the trashed-name lookup runs fresh rather than off a list
      // fetched before the delete.
      await openConsole(page, 'Projects');
      await page.getByTestId('project-new').click();
      await page.getByTestId('project-new-name').fill(name);
      await expect(page.getByTestId('project-new-problem')).toContainText('Trash');
      await expect(page.getByTestId('project-add')).toBeDisabled();
      await closeConsole(page);
    } finally {
      await cleanupTestLabels(scope.prefix);
    }
  });
});
