import { test, expect, type Page } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { resetUserSettings } from './helpers/api';
import { gateAnswered, stubAIGate, type GateStub } from './helpers/ai';

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

/** Settings → AI's "Use AI in dsul" switch, drawn while something is connected or AI is off. */
function useAISwitch(page: Page) {
  return row(page, 'beacon.useAi').getByRole('switch', { name: 'Use AI in dsul' });
}

/**
 * Settings → AI against the stubbed gate (helpers/ai.ts `stubAIGate`). The
 * stub goes in before the load: the gate is asked at sign-in, and the pane
 * asks again as it mounts, so a route added later answers nothing. Every
 * write the pane makes (the switch, "No AI, thanks", Disconnect) is then
 * answered in the browser and never reaches the shared account, where a real
 * `ai_hidden = true` would take AI away from every parallel spec.
 */
async function gotoAIPane(page: Page, o: Parameters<typeof stubAIGate>[1]): Promise<GateStub> {
  const gate = await stubAIGate(page, o);
  const answered = gateAnswered(page);
  await gotoSettings(page, 'ai');
  await answered;
  return gate;
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
    await expect(row(page, 'beacon.useAi')).toBeVisible();
    // The AI pane opens with Use AI in dsul, and the connection under it.
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
    await expect(row(page, 'beacon.useAi')).toBeVisible();
    await expect(aiRow).toHaveAttribute('aria-current', 'true');
    await expect(page).toHaveURL(/\/settings\/ai$/);

    // The rail goes there by the same name, never by the pane's id.
    await sections.getByRole('button', { name: 'Rituals', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/rituals$/);
    await aiRow.click();
    await expect(page).toHaveURL(/\/settings\/ai$/);
    await expect(page.getByTestId('model-connection-panel')).toBeVisible();

    // A deep link to one of its rows, sent to the wrong pane, routes itself
    // to the alias too (and the row strips its ?focus= once it has arrived,
    // which for an AI row waits for the connection check to answer).
    await page.goto('/settings/day?focus=beacon.useAi');
    await expect(row(page, 'beacon.useAi')).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/settings\/ai$/);

    // The old address is kept, for links already out there.
    await gotoSettings(page, 'beacon');
    await expect(page.getByTestId('model-connection-panel')).toBeVisible();
    await expect(page).toHaveURL(/\/settings\/beacon$/);
  });

  test('on the real gate the shared account reads as a paired, pull-only OpenClaw', async ({
    page,
  }) => {
    // Read-only: nothing here is clicked, so the real gate is safe to ask.
    // Global setup seeds an agent key for the shared account, so the gate
    // answers "OpenClaw paired, no model": OpenClaw takes on tasks, and
    // nothing answers in chat. The answer arrives after a beat, and every
    // assertion here waits for it.
    await gotoSettings(page, 'ai');

    await expect(page.getByTestId('mcp-status')).toHaveText('Not set up');
    await expect(page.getByTestId('openclaw-status')).toHaveText('Paired');
    await expect(page.getByTestId('openclaw-copy')).toHaveText('OpenClaw takes on tasks you hand it.');
    // Something is connected, so the explainer is the one sentence, not the tiles.
    await expect(page.getByTestId('ai-explainer')).toHaveAttribute('data-form', 'sentence');
    await expect(useAISwitch(page)).toBeChecked();
    await expect(page.getByTestId('ai-device')).toBeVisible();
    // Ctrl+J does nothing for a pull-only account, so the sentence never offers it.
    // Asked only once the sentence is drawn from the gate's answer.
    await expect(page.getByTestId('ai-explainer-chord')).toHaveCount(0);
  });

  test('the Use AI switch turns AI off for the account and back on', async ({ page }) => {
    const gate = await gotoAIPane(page, { model: 'ok' });
    const panel = page.getByTestId('model-connection-panel');
    const off = page.getByTestId('mcp-ai-off');
    const toggle = useAISwitch(page);

    await expect(panel.getByTestId('mcp-status')).toHaveText('Working');
    await expect(toggle).toBeChecked();

    // Off: the AI-off card under the switch, and nothing of the connection below it.
    await toggle.click();
    await expect(off).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await expect(panel).toHaveCount(0);

    // On again: the card goes and the connection is back.
    await toggle.click();
    await expect(off).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(toggle).toBeChecked();
    await expect.poll(() => gate.patches).toEqual([{ hidden: true }, { hidden: false }]);
    expect(gate.hidden()).toBe(false);
  });

  test('AI off with a model connected: the card says so, and Disconnect deletes it', async ({
    page,
  }) => {
    const gate = await gotoAIPane(page, { model: 'ok', aiHidden: true });
    const off = page.getByTestId('mcp-ai-off');
    const connected = off.getByTestId('ai-off-connected');

    await expect(off).toBeVisible();
    await expect(useAISwitch(page)).not.toBeChecked();
    // Everything else in the pane is hidden while AI is off.
    await expect(page.getByTestId('ai-explainer')).toHaveCount(0);
    await expect(page.getByTestId('ai-openclaw')).toHaveCount(0);
    await expect(page.getByTestId('ai-device')).toHaveCount(0);
    await expect(page.getByTestId('model-connection-panel')).toHaveCount(0);

    await expect(connected).toContainText('Google Gemini is still connected');
    await connected.getByTestId('ai-off-disconnect').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('Disconnect Google Gemini?');
    await page.getByTestId('model-disconnect-confirm').click();

    // The row goes once the DELETE lands; the card stays, since AI is still off.
    await expect(connected).toHaveCount(0);
    await expect(off).toBeVisible();
    expect(gate.deletes()).toBe(1);
    expect(gate.model()).toBeNull();
    expect(gate.patches).toEqual([]);
    expect(gate.hidden()).toBe(true);
  });

  test('nothing connected: No AI, thanks turns into the switch, and the switch brings it back', async ({
    page,
  }) => {
    const gate = await gotoAIPane(page, { model: 'none' });
    const noAI = page.getByTestId('ai-no-ai-thanks');
    const toggle = useAISwitch(page);

    await expect(page.getByTestId('ai-explainer')).toHaveAttribute('data-form', 'tiles');
    await expect(page.getByTestId('mcp-status')).toHaveText('Not set up');
    await expect(noAI).toBeVisible();
    await expect(toggle).toHaveCount(0);
    await expect(page.getByTestId('ai-device')).toHaveCount(0);

    // The press hands focus to the control that replaced the button.
    await noAI.click();
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeFocused();
    await expect(page.getByTestId('mcp-ai-off')).toBeVisible();
    await expect.poll(() => gate.patches).toEqual([{ hidden: true }]);

    await toggle.click();
    await expect(noAI).toBeVisible();
    await expect(noAI).toBeFocused();
    await expect(page.getByTestId('mcp-ai-off')).toHaveCount(0);
    await expect.poll(() => gate.patches).toEqual([{ hidden: true }, { hidden: false }]);
  });

  test('a daily limit: the pill says when AI is back, with no Check again', async ({ page }) => {
    const gate = await gotoAIPane(page, { model: 'limited' });
    const panel = page.getByTestId('model-connection-panel');

    await expect(panel.getByTestId('mcp-status')).toHaveText(/^Daily limit · back at /);
    await expect(panel.getByTestId('mcp-limit-note')).toBeVisible();
    await expect(panel.getByTestId('mcp-disconnect')).toBeVisible();
    await expect(panel.getByTestId('mcp-recheck')).toHaveCount(0);
    expect(gate.patches).toEqual([]);
  });

  test('AI off with OpenClaw paired: the card names it, and offers no Unpair', async ({ page }) => {
    const gate = await gotoAIPane(page, { aiHidden: true, openclaw: 'paired' });
    const off = page.getByTestId('mcp-ai-off');
    const paired = off.getByTestId('ai-off-paired');

    await expect(paired).toContainText('atlas is still paired');
    await expect(paired).toContainText(
      'OpenClaw reads your planner through its own pairing, which this switch doesn’t touch.'
    );
    await expect(off.getByTestId('ai-off-connected')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /unpair/i })).toHaveCount(0);
    expect(gate.patches).toEqual([]);
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
