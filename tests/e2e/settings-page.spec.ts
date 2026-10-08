import { test, expect, type Page } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { resetUserSettings } from './helpers/api';

/**
 * The settings ROUTE, driven through its own UI.
 *
 * This is the coverage the old dialog could never have. tests/e2e/settings.spec.ts
 * records the reason twice: "the dialog has sectioned navigation whose selects
 * are not mounted until their section is chosen", which forced every settings
 * assertion in the suite to go through the REST API or a palette command
 * instead. On a route every control of the active pane is mounted, each one
 * carries a stable `data-setting`, and the pane itself is a URL — so the real
 * user path is finally reachable.
 */

/** The page owns its own readiness signal — waitForAppReady is for the planner. */
async function gotoSettings(page: Page, pane = 'day'): Promise<void> {
  await page.goto(`/settings/${pane}`);
  await expect(page.getByTestId('settings-page')).toBeVisible({ timeout: 20_000 });
  // The hydration gate renders a placeholder until settings arrive from
  // Supabase; the search field only exists on the settled surface.
  await expect(page.getByTestId('settings-search')).toBeVisible({ timeout: 20_000 });
}

function row(page: Page, id: string) {
  return page.locator(`[data-setting-row="${id}"]`);
}

test.describe('Settings page', () => {
  // Serial: these mutate columns on the SHARED test user.
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await loginTestUser(page);
  });

  test.afterEach(async ({ page }) => {
    await resetUserSettings(page);
  });

  test('every control of the active pane is mounted at once', async ({ page }) => {
    // The precise thing the dialog could not do, and the reason search can
    // filter the surface in place rather than routing to it.
    await gotoSettings(page, 'look');

    await expect(row(page, 'look.theme')).toBeVisible();
    await expect(row(page, 'look.typeface')).toBeVisible();
    await expect(row(page, 'look.buckets')).toBeVisible();
    await expect(row(page, 'look.showCompleted')).toBeVisible();
    await expect(row(page, 'look.animations')).toBeVisible();

    // Advanced rows are behind their disclosure, not rendered-and-hidden.
    await expect(row(page, 'look.markStyle')).toHaveCount(0);
    await page.getByRole('button', { name: /^Advanced/ }).click();
    await expect(row(page, 'look.markStyle')).toBeVisible();
  });

  test('the rail navigates by URL and each pane is deep-linkable', async ({ page }) => {
    await gotoSettings(page, 'day');
    await expect(row(page, 'day.weekStart')).toBeVisible();

    await page.getByRole('button', { name: 'Rituals' }).click();
    await expect(page).toHaveURL(/\/settings\/rituals/);
    await expect(row(page, 'rituals.morningCheck')).toBeVisible();

    // …and arriving directly works the same way.
    await gotoSettings(page, 'ai');
    await expect(row(page, 'beacon.provider')).toBeVisible();
    // The AI pane opens with the model connection, above its rows.
    await expect(page.getByTestId('model-connection-panel')).toBeVisible();
  });

  test('the AI pane lives at /settings/ai and keeps that address; /settings/beacon still opens it', async ({
    page,
  }) => {
    // Read-only: nothing here connects, so the real gate is safe to ask.
    const sections = page.getByRole('navigation', { name: 'Settings sections' });
    const aiRow = sections.getByRole('button', { name: 'AI', exact: true });

    // The address every link in the app uses: the pane, under the name it wears.
    await gotoSettings(page, 'ai');
    await expect(page.getByTestId('model-connection-panel')).toBeVisible();
    await expect(row(page, 'beacon.provider')).toBeVisible();
    await expect(aiRow).toHaveAttribute('aria-current', 'true');
    await expect(page).toHaveURL(/\/settings\/ai$/);

    // The rail goes there by the same name, never by the pane's id.
    await sections.getByRole('button', { name: 'Rituals', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/rituals$/);
    await aiRow.click();
    await expect(page).toHaveURL(/\/settings\/ai$/);
    await expect(page.getByTestId('model-connection-panel')).toBeVisible();

    // A deep link to one of its rows, sent to the wrong pane, routes itself
    // to the alias too (and the row strips its ?focus= once it has arrived).
    await page.goto('/settings/day?focus=beacon.provider');
    await expect(row(page, 'beacon.provider')).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/settings\/ai$/);

    // The old address is kept, for links already out there.
    await gotoSettings(page, 'beacon');
    await expect(page.getByTestId('model-connection-panel')).toBeVisible();
    await expect(page).toHaveURL(/\/settings\/beacon$/);
  });

  test('search filters across panes, counts out loud, and keeps rows live', async ({ page }) => {
    await gotoSettings(page, 'day');

    // A value label, not a label — "Sunday" appears nowhere in "Week starts on".
    await page.getByTestId('settings-search').fill('sunday');
    await expect(row(page, 'day.weekStart')).toBeVisible({ timeout: 5_000 });
    // The count is what makes a one-result answer read as complete.
    await expect(page.getByTestId('settings-status')).toContainText(/setting/, { timeout: 5_000 });

    // The vocabulary of annoyance, reaching a different pane entirely.
    await page.getByTestId('settings-search').fill('pile up');
    await expect(row(page, 'rituals.autoAge')).toBeVisible({ timeout: 5_000 });
    await expect(row(page, 'day.weekStart')).toHaveCount(0);

    // Escape clears the query before it leaves the page.
    await page.getByTestId('settings-search').press('Escape');
    await expect(page).toHaveURL(/\/settings\/day/);
    await expect(row(page, 'day.weekStart')).toBeVisible({ timeout: 5_000 });
  });

  test('search reaches configuration that deliberately lives elsewhere', async ({ page }) => {
    // The mechanism that lets the rail stay at six panes.
    await gotoSettings(page, 'day');
    await page.getByTestId('settings-search').fill('season');
    await expect(page.getByText('Seasons', { exact: true })).toBeVisible({ timeout: 5_000 });
  });

  test('a query that means nothing here says so, and offers a way on', async ({ page }) => {
    await gotoSettings(page, 'day');
    await page.getByTestId('settings-search').fill('quiet hours');
    await expect(page.getByText(/No settings match/)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: 'Search advanced too' })).toBeVisible();
  });

  test('a toggle written through the real UI survives a reload', async ({ page }) => {
    await gotoSettings(page, 'look');

    const toggle = page.locator('[data-setting="show_completed_tasks"]');
    await expect(toggle).toHaveAttribute('data-state', 'checked');
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'unchecked');

    // The debounce is 500ms and the route flushes on unmount; a reload is the
    // harsher path — it has to have landed in Supabase already.
    await page.waitForTimeout(1_200);
    await page.reload();
    await expect(page.getByTestId('settings-search')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-setting="show_completed_tasks"]')).toHaveAttribute(
      'data-state',
      'unchecked'
    );
  });

  test('a changed row can be reset to its default from the row itself', async ({ page }) => {
    await gotoSettings(page, 'look');

    const toggle = page.locator('[data-setting="show_completed_tasks"]');
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'unchecked');

    const target = row(page, 'look.showCompleted');
    await target.hover();
    // The label names the STATE as well as the action, because the lime
    // modified bar is a pseudo-element and invisible to assistive tech.
    await target.getByRole('button', { name: /changed from its default/ }).click();
    await expect(toggle).toHaveAttribute('data-state', 'checked');
    await expect(page.getByTestId('settings-notice')).toContainText(/reset to/i);
  });

  test('the page scrolls on a desktop viewport (issue #92)', async ({ page }) => {
    // The old dialog could not scroll on desktop and the assertion was skipped.
    // The pane scrolls the DOCUMENT — no inner overflow box, no <ScrollArea> —
    // so this is now just "is the page taller than the window, and does it move".
    await page.setViewportSize({ width: 1280, height: 700 });
    await gotoSettings(page, 'look');
    await page.getByRole('button', { name: /^Advanced/ }).click();
    await expect(row(page, 'look.sidebarHover')).toBeAttached();

    // The Look pane opens with its previews, so the Advanced rows sit well
    // below the fold: wheel until the last one shows.
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, 600);
          return row(page, 'look.sidebarHover').evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= window.innerHeight;
          });
        },
        { timeout: 10_000 }
      )
      .toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  test('changing the theme applies in place — no navigation, no reload', async ({ page }) => {
    // The complaint this guards: the theme control "reloads the app". It never
    // navigated; it repainted every colour in one frame because next-themes'
    // disableTransitionOnChange stripped all transitions, which looks identical
    // to a load. Assert both halves — that nothing navigates, and that the
    // easing window actually opens.
    await gotoSettings(page, 'look');

    let navigations = 0;
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) navigations++;
    });
    await page.evaluate(() => {
      (window as unknown as { __alive: boolean }).__alive = true;
    });

    // Settings → Look draws Mode as two previews: tapping the dark one keeps
    // dsul dark. Playwright's browser reports a light device, so this changes
    // what shows.
    await page.getByTestId('look-pin-dark').click();
    await expect(page.getByTestId('look-pin-dark')).toHaveAttribute('aria-pressed', 'true');

    await expect
      .poll(async () => page.evaluate(() => document.documentElement.className), {
        timeout: 5_000,
      })
      .toContain('dark');

    // A real reload would have destroyed the window object.
    expect(await page.evaluate(() => (window as unknown as { __alive?: boolean }).__alive)).toBe(
      true
    );
    expect(navigations, 'theme change must not navigate').toBe(0);
    // Let the debounced save land before afterEach puts Mode back.
    await page.waitForTimeout(1_200);
  });

  test('the breadcrumb returns to the planner', async ({ page }) => {
    await gotoSettings(page, 'day');
    await page.getByRole('link', { name: 'dsul' }).click();
    await expect(page.getByTestId('view-root')).toBeAttached({ timeout: 20_000 });
  });
});
