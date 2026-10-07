import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Navigating, waiting, and locating — the vocabulary the specs share.
 *
 * Two patterns this replaces:
 *
 * `await page.goto('/'); await page.waitForURL('/')` — the second call is a
 * no-op, because goto already resolved on that URL. It waits for nothing, so
 * every following assertion raced hydration and the store's first data load. The
 * same dead pair followed every page.reload() in the suite.
 *
 * Silent auth failure — the app rendered `<AppShell/>` unconditionally,
 * supabase-provider skipped store init without a session, and locally
 * NEXT_PUBLIC_DISABLE_AUTH=true short-circuited proxy.ts entirely. So a broken
 * session produced a fully-rendered EMPTY planner and ~49 tests failed 10s later
 * on "element not found" instead of once, loudly, on auth. A page with no
 * session now leaves for /login (proxy.ts, and the provider when the gate is
 * off), but a cookie the decoder throws on still leaves the shell up on its
 * skeleton (helpers/session.ts), so the readiness contract below still asserts
 * auth itself.
 */

/** Go to the app and wait until it is genuinely usable. */
export async function gotoApp(page: Page): Promise<void> {
  await page.goto('/');
  await waitForAppReady(page);
}

/** Reload and wait until the app is usable again. */
export async function reloadApp(page: Page): Promise<void> {
  await page.reload();
  await waitForAppReady(page);
}

/**
 * The readiness contract: a canvas view is mounted and the session produced a
 * signed-in shell. Asserting auth here means a session regression fails with
 * "user menu not visible" rather than as a mystery timeout in whatever assertion
 * happened to run first.
 */
export async function waitForAppReady(page: Page): Promise<void> {
  await expect(page.getByTestId('view-root')).toBeAttached({ timeout: 20_000 });

  /**
   * Wait for HYDRATION, not just paint.
   *
   * The server markup contains rows whose React handlers are not attached yet, so
   * a click can land on a real, visible, stable button and do nothing at all —
   * which surfaced as `data-completed` staying "false" through a 10s assertion,
   * intermittently, in whichever test clicked soonest after a reload.
   *
   * `header-date` is the app's own mount signal: both shells render `data-date`
   * from a `mounted` state that only flips in an effect, so a non-empty value
   * proves the client took over.
   */
  await expect(
    page.getByTestId('header-date').first(),
    'app never hydrated — header date stayed at its pre-mount placeholder'
  ).toHaveAttribute('data-date', /^\d{4}-\d{2}-\d{2}$/, { timeout: 20_000 });

  await expect(
    page.getByRole('button', { name: 'User menu' }),
    'app rendered but no signed-in user — the injected session did not take'
  ).toBeVisible({ timeout: 20_000 });

  /**
   * …and the planner store's INITIAL FETCH has landed.
   *
   * Hydration is not enough, and the difference is destructive rather than
   * merely slow. `initializeStore` replaces `projects` and
   * `items` wholesale when it resolves, so anything written in the window
   * between mount and that resolve is silently discarded. A test that acted on
   * "the page is interactive" could create a project, watch the row and its
   * detail pane appear, and then find the list back at "No projects yet." — the
   * failure reads as a broken create, not as a race, and it lands on whichever
   * spec happens to interact soonest after a reload.
   *
   * That is exactly how organize.spec.ts failed on its first ever run: the one
   * test in the file that did not do a second reload first.
   */
  await expect(
    page.getByTestId('view-root').first(),
    'planner data never arrived — the store never finished its initial fetch'
  ).toHaveAttribute('data-loaded', 'true', { timeout: 20_000 });

  /**
   * …and the cached → fresh SETTLE is over.
   *
   * Every reload in this suite now paints this browser's copy of the last
   * session first (lib/planner-snapshot.ts), look-only, and the fresh landing
   * glides each moved row from where the preview drew it to where the fresh
   * data puts it (lib/settle.ts). `data-loaded="true"` arrives at the START of
   * that glide, so a click straight after it can be aimed at a row still in
   * flight — or, where nothing held the old geometry (reduced motion, a scope
   * too changed to follow), land inside the 250ms landing shield, which
   * swallows pointer activations on purpose so a click meant for a preview row
   * never ticks the fresh row now under the cursor. Either way the click is
   * lost, and the test fails on whatever it asserted next.
   *
   * `<html data-planner-settling>` is up while the settle has something to
   * animate or a shield is running, and comes down once both are over. A
   * landing that changed nothing raises nothing: it still watches a couple of
   * frames for follow-up commits, and raises it only if one of them moves
   * something. A first visit (no snapshot) never sets it, so this passes at
   * once there.
   */
  await expect(
    page.locator('html'),
    'the cached → fresh settle (or its landing shield) never finished'
  ).not.toHaveAttribute('data-planner-settling', { timeout: 5_000 });

  /**
   * …and no full-screen scrim is still eating clicks.
   *
   * components/onboarding/onboarding-tour.tsx renders a `fixed inset-0 z-[100]`
   * overlay, and lib/user-profile.ts reads `data?.onboarding_completed ?? false`
   * — so between first paint and the profile arriving, the app believes nobody
   * has onboarded and puts the tour up. global-setup.ts marks the test user
   * onboarded, so it always comes back down; the window is just wide enough
   * under parallel load for the first click to land on the backdrop instead of
   * the control.
   *
   * That surfaces as "<div class=…backdrop-blur-sm> intercepts pointer events"
   * inside whatever helper clicked first, which reads as a bug in the feature
   * under test rather than a readiness problem. Hence: here, once.
   */
  await expect(
    page.locator('div.fixed.inset-0.z-\\[100\\]'),
    'the onboarding tour scrim never went away — is the test user onboarded?'
  ).toHaveCount(0, { timeout: 20_000 });
}

/* ── items ─────────────────────────────────────────────────────────────── */

/**
 * An item's row, by id.
 *
 * Prefer this over `.filter({ hasText: title })`: a title filter breaks on
 * truncation/line-clamp changes and cannot disambiguate the same item rendered
 * twice. `.first()` because the schedule views render a block AND the row.
 */
export function itemCard(page: Page, itemId: string): Locator {
  return page.locator(`[data-testid="item-card"][data-item-id="${itemId}"]`).first();
}

/** An item's row scoped to a container (a bucket, the braindump, a week column). */
export function itemCardIn(scope: Locator, itemId: string): Locator {
  return scope.locator(`[data-testid="item-card"][data-item-id="${itemId}"]`).first();
}

export function completeButton(page: Page, itemId: string): Locator {
  return itemCard(page, itemId).getByTestId('item-complete-button');
}

export function bucket(page: Page, name: string): Locator {
  return page.locator(`[data-dnd-bucket="${name}"]`);
}

/**
 * Assert an item's completion state.
 *
 * Reads `data-completed` rather than a Tailwind class. undo-redo.spec used to
 * assert `toHaveClass(/bg-primary/)` on the checkbox — exactly the coupling that
 * a restyle breaks, and the reason completion needed a real DOM signal.
 */
export async function expectCompleted(
  page: Page,
  itemId: string,
  completed: boolean
): Promise<void> {
  await expect(itemCard(page, itemId)).toHaveAttribute(
    'data-completed',
    completed ? 'true' : 'false'
  );
}

/** Toggle an item's completion and wait for the row to report the new state. */
export async function toggleComplete(
  page: Page,
  itemId: string,
  expected: boolean
): Promise<void> {
  await completeButton(page, itemId).click();
  await expectCompleted(page, itemId, expected);
}

/* ── view + date navigation ────────────────────────────────────────────── */

export async function setScope(page: Page, option: 'Day' | 'Week'): Promise<void> {
  await page.getByRole('button', { name: 'Scope', exact: true }).click();
  await page.getByRole('menuitem', { name: option }).click();
  await expect(page.getByTestId('view-root')).toHaveAttribute(
    'data-view-scope',
    option.toLowerCase()
  );
}

export async function setLayout(
  page: Page,
  option: 'Buckets' | 'List' | 'Schedule'
): Promise<void> {
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await page.getByRole('menuitem', { name: option }).click();
  await expect(page.getByTestId('view-root')).toHaveAttribute(
    'data-view-layout',
    option.toLowerCase()
  );
}

/** The date the canvas is currently showing, as "YYYY-MM-DD". */
export async function currentDateStr(page: Page): Promise<string> {
  return (await page.getByTestId('header-date').first().getAttribute('data-date')) ?? '';
}

/**
 * Navigate the canvas to a calendar date.
 *
 * Asserts EXACT equality on `data-date`. The helper this replaces asserted a
 * formatted string through an unanchored regex, so `new RegExp('Friday, August
 * 1')` matched a header reading 'Fri, Aug 15' — a 14-day overshoot passed as
 * success. It also looked for the date inside a `<header>`, which on desktop
 * contains no date at all, so it timed out and took ten tests with it.
 *
 * The two shells offer different controls, and this picks whichever is on the
 * page rather than asking the viewport:
 *
 * - DESKTOP steps one day per chevron click. Requires day scope (the seeded
 *   default): under week scope a chevron steps seven days, which is how the old
 *   helper could overshoot in the first place.
 * - MOBILE has no chevrons — the redesigned header is a week strip, so a day
 *   inside the shown week is one tap, and anything further out goes through the
 *   calendar popover, which is also the only route a real user has for a jump
 *   of more than a week.
 */
export async function navigateToDate(page: Page, targetDateStr: string): Promise<void> {
  await expect(page.getByTestId('view-root')).toHaveAttribute('data-view-scope', 'day');

  const header = page.getByTestId('header-date').first();
  await expect(header).toHaveAttribute('data-date', /\d{4}-\d{2}-\d{2}/);

  const from = await currentDateStr(page);
  const days = Math.round(
    (Date.parse(`${targetDateStr}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000
  );
  if (days === 0) return;

  const stepper = page.getByTestId(days > 0 ? 'header-next' : 'header-prev');
  if (await stepper.count()) {
    for (let i = 0; i < Math.abs(days); i++) await stepper.click();
  } else {
    await pickDateOnMobile(page, targetDateStr);
  }

  await expect(
    header,
    `navigateToDate: wanted ${targetDateStr}, ${days} day(s) from ${from}`
  ).toHaveAttribute('data-date', targetDateStr);
}

/**
 * The mobile route to a date: the week strip's own cell if the date is in the
 * week on screen, the calendar popover otherwise.
 *
 * Both are controls a thumb can reach — nothing here is mounted for the tests'
 * benefit. The popover is driven the way a person drives it: page to the target
 * month with the picker's own arrows, then tap the day. react-day-picker's own
 * grid cells carry `data-day="yyyy-MM-dd"`, which is why this addresses a day by
 * date rather than by its aria-label — that label is a locale-formatted `PPPP`
 * with "Today, " and ", selected" glued on either side.
 */
async function pickDateOnMobile(page: Page, targetDateStr: string): Promise<void> {
  const cell = page.locator(`[data-testid="week-day"][data-date="${targetDateStr}"]`);
  if (await cell.count()) {
    await cell.first().click();
    return;
  }

  const [fromY, fromM] = (await currentDateStr(page)).split('-').map(Number);
  const [toY, toM] = targetDateStr.split('-').map(Number);
  // Calendar months, not elapsed time: the picker opens on the cursor's month
  // (`defaultMonth={selectedDate}` in mobile-header.tsx), so this is exactly how
  // many arrow taps separate the two grids.
  const months = (toY - fromY) * 12 + (toM - fromM);

  await page.getByTestId('header-date').first().click();
  const arrow = page.getByRole('button', {
    name: months > 0 ? 'Go to the Next Month' : 'Go to the Previous Month',
  });
  for (let i = 0; i < Math.abs(months); i++) await arrow.click();

  await page.locator(`[data-day="${targetDateStr}"] button`).first().click();
}

/* ── mobile surfaces ───────────────────────────────────────────────────── */

/** The three surfaces the phone shell can show. */
export type MobileTabName = 'braindump' | 'today' | 'chat';

/**
 * Switch the mobile shell's surface.
 *
 * Was one click on the bottom tab bar. That bar is retired — the dock carries a
 * single mode card showing the CURRENT surface's glyph, and the three
 * `[data-tour="tab-*"]` handles moved onto the entries of the sheet it opens. So
 * this is two interactions now, and the entry only exists while the sheet is
 * open; every @mobile spec that used to click a tab goes through here rather
 * than each one re-deriving the sequence.
 *
 * Returns early when the surface is already showing: the sheet has no entry for
 * "stay put", and opening it to pick the row you are already on would leave the
 * drawer's own close animation racing the next assertion.
 */
export async function switchMobileTab(page: Page, tab: MobileTabName): Promise<void> {
  const card = page.getByTestId('mobile-mode-card');
  await expect(
    card,
    'no mobile mode card — is this running in the mobile project?'
  ).toBeVisible({ timeout: 10_000 });
  if ((await card.getAttribute('data-surface')) === tab) return;

  await card.click();
  const entry = page.locator(`[data-tour="tab-${tab}"]`);
  await expect(entry, `the mode switcher sheet never offered "${tab}"`).toBeVisible({
    timeout: 5_000,
  });
  await entry.click();

  // Both halves matter. The sheet unmounting is what frees the next click from
  // the drawer's overlay; `data-surface` is what proves the pick actually moved
  // the shell rather than merely dismissing the sheet.
  await expect(entry).toHaveCount(0);
  await expect(card).toHaveAttribute('data-surface', tab);
}

/* ── omnibar / commands ────────────────────────────────────────────────── */

// The dock and the ⌘K launcher render the SAME <Omnibar>, so they share every
// testid. Scope by data-omnibar-variant so a locator is unambiguous even when
// the launcher is open over the dock.
//
// NOT getByLabel('Omnibar'): cmdk gives this input role="combobox" and
// Playwright's label engine does not resolve aria-label on it — verified 0
// matches while [aria-label="Omnibar"] matched 1. That single locator was the
// whole of the omnibar spec's 60s timeouts.
export function omnibar(page: Page): Locator {
  return page.locator('[data-omnibar-variant="dock"] [data-testid="omnibar-input"]');
}

export function omnibarPanel(page: Page): Locator {
  return page.locator('[data-omnibar-variant="dock"] [data-testid="omnibar-panel"]');
}

/** The summoned ⌘K launcher's input and its command/results panel. */
export function launcherInput(page: Page): Locator {
  return page.locator('[data-omnibar-variant="launcher"] [data-testid="omnibar-input"]');
}

export function launcherPanel(page: Page): Locator {
  return page.locator('[data-omnibar-variant="launcher"] [data-testid="omnibar-panel"]');
}

/**
 * Run a palette command by id.
 *
 * Commands are addressed by `data-command-id`, not row copy: labels collide with
 * their own group headings ('Settings' is both), so a text match resolves by
 * scoring accident and becomes a strict-mode violation as soon as keywords move.
 */
export async function runCommand(
  page: Page,
  commandId: string,
  options: { query?: string; arg?: string } = {}
): Promise<void> {
  const input = omnibar(page);
  await input.click();
  // A bare '/' lists everything, which both truncates and duplicates: a
  // recently-used command appears in the Recents group AND its own group, so the
  // id matches twice and strict mode throws. Narrow with the command's alias, and
  // take the first match.
  await input.fill(options.query ?? '/');

  const selector = options.arg
    ? `[data-command-id="${commandId}"][data-arg="${options.arg}"]`
    : `[data-command-id="${commandId}"]`;
  const row = omnibarPanel(page).locator(selector).first();

  await expect(
    row,
    `no palette row for command "${commandId}"${options.arg ? ` arg "${options.arg}"` : ''} ` +
      `with query "${options.query ?? '/'}"`
  ).toBeVisible({ timeout: 5_000 });
  await row.click();
}

/**
 * Run a palette command that takes an ENTITY argument, e.g. items.pause.
 *
 * Two interactions, not one — which is why runCommand's `arg` option cannot do
 * it. `arg` addresses a row that already exists in the main list, and that only
 * happens for FLATTENED ENUM options (lib/commands/match.ts). An entity command
 * has exactly one row until it is clicked; clicking it CHIPS the command, and
 * only then does the picker render its item rows.
 *
 * `pick` is REQUIRED, and it is the whole reason this helper is careful: the
 * chip clears the query, and the picker then slices the eligible set down to
 * PICKER_LIMIT ordered by proximity to today (lib/commands/entities.ts). On the
 * shared e2e user — which accumulates rows from every other spec — a fixture is
 * very unlikely to survive that slice. Typing narrows the candidate set the way
 * a real user would, and makes the assertion about THIS item rather than about
 * how many items happen to exist.
 */
export async function runEntityCommand(
  page: Page,
  commandId: string,
  entityId: string,
  pick: string,
  options: { query?: string } = {}
): Promise<void> {
  const input = omnibar(page);
  await input.click();
  await input.fill(options.query ?? '/');

  const commandRow = omnibarPanel(page).locator(`[data-command-id="${commandId}"]`).first();
  await expect(
    commandRow,
    `no palette row for command "${commandId}" with query "${options.query ?? '/'}"`
  ).toBeVisible({ timeout: 5_000 });
  await commandRow.click();

  // Chipping clears the query (omnibar's runCommand), so this types into an
  // empty picker rather than appending to the command alias.
  await input.fill(pick);

  const entityRow = omnibarPanel(page)
    .locator(`[data-command-id="${commandId}"][data-arg="${entityId}"]`)
    .first();
  await expect(
    entityRow,
    `command "${commandId}" was chipped and its picker filtered by "${pick}", but no row for ` +
      `entity "${entityId}" — either the item is not eligible for this command, or the filter ` +
      `does not match its title`
  ).toBeVisible({ timeout: 5_000 });
  await entityRow.click();
}
