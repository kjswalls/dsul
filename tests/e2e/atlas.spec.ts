import { test, expect } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { reloadApp, runCommand, setScope, waitForAppReady } from './helpers/app';
import { cleanupByTitlePrefix, cleanupTestLabels, createTestTask, specScope } from './helpers/api';

/**
 * Atlas: the third scope, desktop only. A project shows as a card with its
 * next step; a row's right-click is the item menu. A card dragged on Your map
 * stays where it was put across a reload (PR1b: the account path, since the
 * local stack applies migration 087; the per-device fallback is unit-tested).
 * PR1c: a double-clicked card grows into the focus sheet, whose rows open in
 * the rail, and Escape closes the sheet before the item; Organize's "Open
 * Atlas" door switches the scope. PR2: keys 1 to 4 switch layouts without
 * touching an open item, and a card dragged into Momentum's Resting column
 * is pinned there across a reload. PR3: Ctrl+wheel past 50% swaps the cards
 * for the Relay grid canvas, panning the board off screen shows the minimap
 * and M pins it, and the Look pane has the Bloom or Dusk row.
 *
 * Under its own prefix, swept by name like organize.spec.ts (projects are not
 * items, so the title sweep would miss them).
 */
const scope = specScope('atlas');

test.describe('atlas', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await loginTestUser(page);
    await cleanupTestLabels(scope.prefix);
    await reloadApp(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanupTestLabels(scope.prefix);
    await cleanupByTitlePrefix(page, scope.prefix);
  });

  /** A project made in Organize (the agent API files by name, it makes no row). */
  async function createProject(page: import('@playwright/test').Page, name: string): Promise<string> {
    await runCommand(page, 'app.categories', { query: '/projects' });
    await page.getByRole('tab', { name: 'Projects' }).click();
    await page.getByTestId('project-new').click();
    await page.getByTestId('project-new-name').fill(name);
    await page.getByTestId('project-add').click();
    const detail = page.getByTestId('project-detail');
    await expect(detail).toBeVisible();
    const id = (await detail.getAttribute('data-project-id'))!;
    const overlay = page.locator('[data-slot="dialog-overlay"], [data-slot="drawer-overlay"]');
    for (let i = 0; i < 4 && (await overlay.count()) > 0; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }
    await expect(overlay).toHaveCount(0);
    return id;
  }

  test('switches to Atlas through the Scope menu, and a card shows its next step', async ({ page }) => {
    const name = scope.title('Launch');
    const projectId = await createProject(page, name);
    const taskId = await createTestTask(page, { title: scope.title('Write the brief'), project: name });
    await reloadApp(page);

    await setScope(page, 'Atlas');
    const card = page.locator(`[data-atlas-card="project:${projectId}"]`);
    await expect(card).toBeVisible();
    const row = card.locator(`[data-testid="atlas-row"][data-item-id="${taskId}"]`);
    await expect(row).toBeVisible();

    // Right-click on the row is the item's menu, not the card's.
    await row.click({ button: 'right' });
    await expect(page.getByTestId('item-context-menu')).toBeVisible();
    await expect(page.getByTestId('container-context-menu')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The card's header is the card's menu, with Center here.
    await card.getByTestId('atlas-card-header').click({ button: 'right' });
    await expect(page.getByTestId('container-context-menu')).toBeVisible();
    await expect(page.getByTestId('container-menu-center')).toBeVisible();
    await page.keyboard.press('Escape');

    // A click on the row opens the item in the rail.
    await row.click();
    await expect(page.getByTestId('item-dialog')).toBeVisible();

    // Back to Day.
    await setScope(page, 'Day');
  });

  test('a dragged card stays where it was put after a reload', async ({ page }) => {
    const name = scope.title('Placed');
    const projectId = await createProject(page, name);
    await reloadApp(page);

    const isPlaceWrite = (r: import('@playwright/test').Response, needle: string) =>
      r.url().includes('/rest/v1/atlas_positions') &&
      r.request().method() === 'POST' &&
      (r.request().postData() ?? '').includes(needle);

    // Opening Atlas seeds the new card's place and writes it once.
    const seeded = page.waitForResponse((r) => isPlaceWrite(r, projectId));
    await setScope(page, 'Atlas');
    const card = page.locator(`[data-atlas-card="project:${projectId}"]`);
    await expect(card).toBeVisible();
    expect((await seeded).ok()).toBe(true);
    await card.scrollIntoViewIfNeeded();
    const before = await card.evaluate((el) => (el as HTMLElement).style.transform);

    // Drag by the footer (rows and controls never start a drag).
    const box = (await card.getByTestId('atlas-card-footer').boundingBox())!;
    const from = { x: box.x + 8, y: box.y + box.height / 2 };
    const dropped = page.waitForResponse((r) => isPlaceWrite(r, projectId));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + i * 15, from.y + i * 10);
    await page.mouse.up();
    expect((await dropped).ok()).toBe(true);
    const after = await card.evaluate((el) => (el as HTMLElement).style.transform);
    expect(after).not.toBe(before);

    // Atlas is remembered on this device, so the reload opens on it.
    await reloadApp(page);
    const again = page.locator(`[data-atlas-card="project:${projectId}"]`);
    await expect(again).toBeVisible();
    await expect.poll(() => again.evaluate((el) => (el as HTMLElement).style.transform)).toBe(after);

    await setScope(page, 'Day');
  });

  test('a double-clicked card grows into the focus sheet, and Escape closes it before the item', async ({ page }) => {
    const name = scope.title('Focus');
    const projectId = await createProject(page, name);
    const firstId = await createTestTask(page, { title: scope.title('First step'), project: name });
    const laterId = await createTestTask(page, { title: scope.title('Later step'), project: name });
    await reloadApp(page);

    await setScope(page, 'Atlas');
    const card = page.locator(`[data-atlas-card="project:${projectId}"]`);
    await expect(card).toBeVisible();
    await card.getByTestId('atlas-card-footer').dblclick();

    const sheet = page.getByTestId('atlas-focus-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('data-phase', 'open');
    await expect(sheet.getByTestId('atlas-sheet-back')).toHaveText('‹ Atlas');
    const rowIds = await sheet
      .locator('[data-testid="atlas-row"]')
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.itemId));
    expect(rowIds).toEqual(expect.arrayContaining([firstId, laterId]));

    // A row opens the item in the rail; the sheet stays.
    await sheet.locator(`[data-testid="atlas-row"][data-item-id="${laterId}"]`).click();
    await expect(page.getByTestId('item-dialog')).toBeVisible();
    await expect(sheet).toBeVisible();

    // Escape from the sheet closes the sheet only, and focus returns to the card.
    await sheet.focus();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('item-dialog')).toBeVisible();
    await expect(card).toBeFocused();

    // Enter on the focused card opens it again; Done closes it.
    await page.keyboard.press('Enter');
    await expect(sheet).toBeVisible();
    await sheet.getByTestId('atlas-sheet-done-button').click();
    await expect(sheet).toHaveCount(0);

    await setScope(page, 'Day');
  });

  test("Organize's Open Atlas door closes the console and opens Atlas", async ({ page }) => {
    await setScope(page, 'Day');
    await runCommand(page, 'app.categories', { query: '/projects' });
    await expect(page.getByTestId('organize-console')).toBeVisible();
    await page.getByTestId('organize-open-atlas').click();
    await expect(page.getByTestId('organize-console')).toHaveCount(0);
    await expect(page.getByTestId('atlas-view')).toBeVisible();
    await setScope(page, 'Day');
  });

  test('keys switch layouts, and a card dragged into Resting stays pinned after a reload', async ({ page }) => {
    const name = scope.title('Pinned');
    const projectId = await createProject(page, name);
    const taskId = await createTestTask(page, { title: scope.title('Some step'), project: name });
    await reloadApp(page);

    await setScope(page, 'Atlas');
    const view = page.getByTestId('atlas-view');
    const card = page.locator(`[data-atlas-card="project:${projectId}"]`);
    await expect(card).toBeVisible();

    // An open item stays open across a layout switch (a layout is a lens).
    await card.locator(`[data-testid="atlas-row"][data-item-id="${taskId}"]`).click();
    await expect(page.getByTestId('item-dialog')).toBeVisible();
    await view.focus();
    await page.keyboard.press('2');
    await expect(view).toHaveAttribute('data-atlas-layout', 'momentum');
    await expect(page.locator('[data-lane-kind="band"]')).toHaveCount(3);
    await expect(page.getByTestId('item-dialog')).toBeVisible();
    await page.keyboard.press('4');
    await expect(view).toHaveAttribute('data-atlas-layout', 'timeline');
    await page.keyboard.press('2');
    await expect(view).toHaveAttribute('data-atlas-layout', 'momentum');

    // Pin it to Resting from the card's menu. The pointer drag that pins is
    // covered by the view tests: here the shared test account can hold enough
    // cards that a Fit lands in the far zoom (below 50%), where cards give way
    // to the Relay grid, so a drag by the footer can't be relied on.
    const resting = page.locator('[data-atlas-lane="resting"]');
    await expect(resting).toHaveCount(1);
    const saved = page.waitForResponse(
      (r) => r.url().includes('/rest/v1/atlas_positions') && r.request().method() !== 'GET',
      { timeout: 15_000 }
    );
    await card.getByTestId('atlas-card-header').dispatchEvent('contextmenu', { button: 2, clientX: 240, clientY: 240 });
    await expect(page.getByTestId('container-context-menu')).toBeVisible();
    await page.getByTestId('container-menu-pin-resting').click();
    await expect(card).toHaveAttribute('data-pinned', 'true');
    expect((await saved).ok()).toBe(true);
    await expect(card.getByTestId('atlas-unpin')).toBeVisible();

    // The layout and the pin are both remembered.
    await reloadApp(page);
    const again = page.locator(`[data-atlas-card="project:${projectId}"]`);
    await expect(page.getByTestId('atlas-view')).toHaveAttribute('data-atlas-layout', 'momentum');
    await expect(again).toHaveAttribute('data-pinned', 'true');

    // Unpin hands it back; then home to Your map.
    await again.getByTestId('atlas-unpin').click();
    await expect(again).not.toHaveAttribute('data-pinned', 'true');
    await page.getByTestId('atlas-view').focus();
    await page.keyboard.press('1');
    await expect(page.getByTestId('atlas-view')).toHaveAttribute('data-atlas-layout', 'map');
    await setScope(page, 'Day');
  });

  test('zooming far out draws the Relay grid, and the minimap shows and pins', async ({ page }) => {
    const name = scope.title('Far');
    const projectId = await createProject(page, name);
    await createTestTask(page, { title: scope.title('A step'), project: name });
    await reloadApp(page);

    await setScope(page, 'Atlas');
    const view = page.getByTestId('atlas-view');
    const card = page.locator(`[data-atlas-card="project:${projectId}"]`);
    await expect(card).toBeVisible();

    // Ctrl+wheel zooms at the pointer; past 50% the cards give way to the canvas.
    const box = (await view.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Control');
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 120);
    await page.keyboard.up('Control');
    await expect(page.getByTestId('atlas-far-canvas')).toBeVisible();
    await expect(page.locator('[data-atlas-card]')).toHaveCount(0);
    await expect(page.locator(`[data-atlas-far-cluster="project:${projectId}"]`)).toHaveCount(1);
    await expect(page.getByTestId('atlas-zoom')).toHaveText('12%');

    // Pan the board off screen: the minimap shows while moving, M pins it.
    await page.mouse.wheel(4000, 0);
    const minimap = page.getByTestId('atlas-minimap');
    await expect(minimap).toHaveAttribute('data-shown', 'true');
    await view.focus();
    await page.keyboard.press('m');
    await expect(minimap).toHaveAttribute('data-pinned', 'true');
    await page.waitForTimeout(1800);
    await expect(minimap).toHaveAttribute('data-shown', 'true');
    await page.keyboard.press('m');
    await expect(minimap).not.toHaveAttribute('data-pinned', 'true');

    // The Look pane has the far zoom's pick, on the desktop.
    await page.goto('/settings/look');
    await expect(page.locator('[data-setting-row="look.atlasFar"]').first()).toBeVisible();
    await page.goto('/');
    await waitForAppReady(page);
    await setScope(page, 'Day');
  });

  test('the phone shows no Atlas, even with Atlas left on this device', async ({ page }) => {
    await setScope(page, 'Atlas');
    await page.setViewportSize({ width: 390, height: 844 });
    await reloadApp(page);
    // The phone's router hardcodes its scope and has no Scope menu, so assert
    // what could actually leak: the Atlas tree itself, a card, or an "Atlas"
    // tab or menu row anywhere on the page.
    await expect(page.getByTestId('view-root')).toBeVisible();
    await expect(page.getByTestId('atlas-view')).toHaveCount(0);
    await expect(page.locator('[data-atlas-card]')).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Atlas' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Atlas' })).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await reloadApp(page);
    await setScope(page, 'Day');
  });
});
