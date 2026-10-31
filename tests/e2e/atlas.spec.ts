import { test, expect, type Locator, type Page } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { reloadApp, runCommand, setScope, waitForAppReady } from './helpers/app';
import {
  cleanupByTitlePrefix,
  cleanupTestCollections,
  cleanupTestLabels,
  createTestRoutine,
  createTestTask,
  specScope,
} from './helpers/api';

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
 * and M pins it, and the Look pane has the Bloom or Dusk row. PR4: a
 * braindump row dropped on a card files it there (it stays in the braindump)
 * and Undo takes it back; a row dragged from one routine's card to another's
 * moves it, as one undo. Round 2: a click on a far cluster flies in and
 * plays the handoff as a flourish that lets go, and Ctrl+wheel mid-flight
 * takes it back. Walk Atlas stands on one card at a time from the palette,
 * puts a step on Today through the verb, and Escape takes the camera back.
 *
 * Under its own prefix, swept by name like organize.spec.ts (projects are not
 * items, so the title sweep would miss them).
 */
const scope = specScope('atlas');

/**
 * Drag `source` onto an Atlas card, at a point on the card that is painted on
 * top. Cards on "Your map" can overlap (the suite shares one account, so other
 * tests' cards sit where they were left), and Atlas gives a drop to the card the
 * pointer is ON, so the shared dragTo, which aims at the target's centre and
 * only corrects vertically, can land on a neighbour.
 */
async function dragOntoCard(page: Page, source: Locator, card: Locator) {
  const key = await card.getAttribute('data-atlas-card');
  const spot = await card.evaluate((el) => {
    const r = el.getBoundingClientRect();
    for (let fy = 0.15; fy < 0.95; fy += 0.1) {
      for (let fx = 0.2; fx < 0.9; fx += 0.15) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (document.elementFromPoint(x, y)?.closest('[data-atlas-card]') === el) return { x, y };
      }
    }
    return null;
  });
  expect(spot, `no part of card ${key} is on top`).not.toBeNull();
  const from = await source.boundingBox();
  if (!from || !spot) throw new Error('drag: source has no box');
  const press = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  try {
    for (const dx of [3, 6, 14]) await page.mouse.move(press.x + dx, press.y, { steps: 2 });
    await page.mouse.move(spot.x, spot.y, { steps: 12 });
    await expect(card.getByTestId('atlas-card-drop')).toHaveAttribute('data-dnd-over', 'true');
  } finally {
    await page.mouse.up();
  }
}

/**
 * Zoom in about the middle of `cards` until the board is at least 70%. A Fit on
 * the suite's crowded shared board can land under 60%, where the cards fold
 * flat into the far zoom's handoff and their rows are no longer something to
 * pick up.
 */
async function zoomToRows(page: Page, ...cards: Locator[]) {
  for (let i = 0; i < 12; i++) {
    const pct = parseInt((await page.getByTestId('atlas-zoom').textContent()) ?? '', 10);
    if (pct >= 70) break;
    const boxes = (await Promise.all(cards.map((c) => c.boundingBox()))).filter((b) => b !== null);
    if (boxes.length === 0) break;
    const x = boxes.reduce((a, b) => a + b.x + b.width / 2, 0) / boxes.length;
    const y = boxes.reduce((a, b) => a + b.y + b.height / 2, 0) / boxes.length;
    await page.mouse.move(x, y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(700);
}

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
    // Picking Dusk shows at once (the page's look tick once left it out, so
    // the chip kept saying Bloom), and Bloom puts it back.
    const farChip = page.getByTestId('setting-look.atlasFar').first();
    await farChip.click();
    // By value inside the open picker: the Look pane also has a dark theme named Dusk.
    const pick = (v: string) => page.locator(`[data-radix-popper-content-wrapper] button[data-value="${v}"]`);
    await pick('dusk').click();
    await expect(farChip).toContainText('Dusk');
    await farChip.click();
    await pick('bloom').click();
    await expect(farChip).toContainText('Bloom');
    await page.goto('/');
    await waitForAppReady(page);
    await setScope(page, 'Day');
  });

  test('a click on a far cluster flies in with the handoff, which lets go, and Ctrl+wheel takes it back', async ({ page }) => {
    const name = scope.title('Fly');
    const projectId = await createProject(page, name);
    await createTestTask(page, { title: scope.title('Fly step'), project: name });
    await reloadApp(page);

    await setScope(page, 'Atlas');
    const view = page.getByTestId('atlas-view');
    const world = page.getByTestId('atlas-world');
    const overlay = page.getByTestId('atlas-handoff-canvas');
    const card = page.locator(`[data-atlas-card="project:${projectId}"]`);
    await expect(card).toBeVisible();
    // Cards only, above the band: no fold, no overlay.
    await expect(world).not.toHaveAttribute('data-handoff', 'true');
    await expect(overlay).toHaveCount(0);

    const zoomOut = async () => {
      const box = (await view.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.down('Control');
      for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 120);
      await page.keyboard.up('Control');
      await expect(page.locator('[data-atlas-card]')).toHaveCount(0);
    };

    // Far out (below 50%): the constellation alone, and no overlay there either.
    await zoomOut();
    await expect(overlay).toHaveCount(0);
    const cluster = page.locator(`[data-atlas-far-cluster="project:${projectId}"]`);
    await expect(cluster).toHaveCount(1);

    // The click flies in and plays the handoff as a flourish: the fold and the
    // overlay are up while the card assembles, then both let go (the whole
    // fly-in is under a second), and the card is whole at 100%.
    await cluster.click();
    await expect(world).toHaveAttribute('data-handoff', 'true', { timeout: 2_000 });
    await expect(card).toBeVisible({ timeout: 2_000 });
    await expect(world).not.toHaveAttribute('data-handoff', 'true', { timeout: 3_000 });
    await expect(overlay).toHaveCount(0);
    await expect(page.getByTestId('atlas-zoom')).toHaveText('100%');
    await expect(card).not.toHaveAttribute('style', /--atlas-fold-x/);

    // Again, and Ctrl+wheel in mid-flight takes the camera at once: the
    // flourish ends with it, so nothing stays folded at a zoom above the band.
    await zoomOut();
    await page.locator(`[data-atlas-far-cluster="project:${projectId}"]`).click();
    await expect(world).toHaveAttribute('data-handoff', 'true', { timeout: 2_000 });
    const box = (await view.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Control');
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await expect(card).toBeVisible();
    await expect(world).not.toHaveAttribute('data-handoff', 'true', { timeout: 1_000 });
    await expect(overlay).toHaveCount(0);
    await expect(page.getByTestId('atlas-zoom')).not.toHaveText('100%');
    await setScope(page, 'Day');
  });

  test('a braindump row dropped on a card files it there, and Undo takes it back', async ({ page }) => {
    const name = scope.title('Filing');
    const projectId = await createProject(page, name);
    await createTestTask(page, { title: scope.title('Already in'), project: name });
    const looseId = await createTestTask(page, { title: scope.title('Loose end') });
    await reloadApp(page);

    await setScope(page, 'Atlas');
    const card = page.locator(`[data-atlas-card="project:${projectId}"]`);
    await expect(card).toBeVisible();
    await page.getByRole('button', { name: 'Fit every card on screen' }).click();
    const count = card.getByTestId('atlas-count');
    await expect(count).toHaveText('0 of 1');
    // Every card is a droppable with the contract's markers (lib/dnd/CONTRACT.md).
    await expect(card.locator(`[data-dnd-id="atlas:project:${projectId}"]`)).toHaveAttribute('data-dnd-over', 'false');
    await expect(page.locator('[data-dnd-id]:not([data-dnd-over])')).toHaveCount(0);

    const source = page.getByTestId('braindump').locator(`[data-testid="item-card"][data-item-id="${looseId}"]`);
    await expect(source).toBeVisible();
    await dragOntoCard(page, source, card);

    // Filed: the card counts it, and it is still in the braindump (no day yet).
    await expect(count).toHaveText('0 of 2');
    await expect(source).toBeVisible();

    // One undo takes it back.
    await page.getByTestId('atlas-view').focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(count).toHaveText('0 of 1');
    await setScope(page, 'Day');
  });

  test('a row dragged from one routine card to another moves it, as one undo', async ({ page }) => {
    const stepId = await createTestTask(page, { title: scope.title('Stretch') });
    const fromId = await createTestRoutine(page, { name: scope.title('Morning'), itemIds: [stepId] });
    const toId = await createTestRoutine(page, { name: scope.title('Evening') });
    try {
      await reloadApp(page);
      await setScope(page, 'Atlas');
      const from = page.locator(`[data-atlas-card="routine:${fromId}"]`);
      const to = page.locator(`[data-atlas-card="routine:${toId}"]`);
      await expect(from).toBeVisible();
      await expect(to).toBeVisible();
      await page.getByRole('button', { name: 'Fit every card on screen' }).click();
      await page.waitForTimeout(700);
      await zoomToRows(page, from, to);

      const row = from.locator(`[data-testid="atlas-row"][data-item-id="${stepId}"]`);
      await expect(row).toBeVisible();
      await dragOntoCard(page, row, to);

      await expect(to.locator(`[data-testid="atlas-row"][data-item-id="${stepId}"]`)).toBeVisible();
      await expect(from.locator(`[data-item-id="${stepId}"]`)).toHaveCount(0);

      // Off one and onto the other is a single entry: one undo puts it back.
      await page.getByTestId('atlas-view').focus();
      await page.keyboard.press('ControlOrMeta+z');
      await expect(from.locator(`[data-testid="atlas-row"][data-item-id="${stepId}"]`)).toBeVisible();
      await expect(to.locator(`[data-item-id="${stepId}"]`)).toHaveCount(0);
      await setScope(page, 'Day');
    } finally {
      await cleanupTestCollections(scope.prefix);
    }
  });

  test('Walk Atlas stands on one card at a time, puts a step on Today, and Escape takes the camera back', async ({ page }) => {
    const name = scope.title('Walk');
    const projectId = await createProject(page, name);
    const stepTitle = scope.title('Walk step');
    const taskId = await createTestTask(page, { title: stepTitle, project: name });
    await reloadApp(page);

    await setScope(page, 'Atlas');
    const key = `project:${projectId}`;
    await expect(page.locator(`[data-atlas-card="${key}"]`)).toBeVisible();
    const world = page.getByTestId('atlas-world');
    const before = await world.evaluate((el) => (el as HTMLElement).style.transform);

    // From the palette (no default key). The toolbar's Walk says it is on.
    await runCommand(page, 'atlas.walk', { query: '/Walk Atlas' });
    const walk = page.getByTestId('atlas-walk');
    await expect(walk).toBeVisible();
    await expect(page.getByTestId('atlas-walk-button')).toHaveAttribute('aria-pressed', 'true');
    await expect(walk.getByTestId('atlas-walk-next')).toBeFocused();
    await expect(page.getByTestId('atlas-walk-veil')).toHaveAttribute('data-up', 'true');

    // Step with the arrow key until the walk stands on our card (the suite
    // shares one account, so other tests' cards are on the map too). The walk
    // says how many cards it holds ("1 of N"), so the loop is bounded by that,
    // never by a guess at how full the account is.
    const total = Number((await walk.getByTestId('atlas-walk-step').textContent())?.match(/of (\d+)/)?.[1] ?? '0');
    expect(total).toBeGreaterThan(0);
    for (let i = 0; i < total && (await walk.getAttribute('data-walk-card')) !== key; i++) {
      await page.keyboard.press('ArrowRight');
    }
    await expect(walk).toHaveAttribute('data-walk-card', key);
    await expect(walk.getByTestId('atlas-walk-question')).toHaveText('Still the right next step?');
    await expect(walk.getByTestId('atlas-walk-detail')).toContainText(stepTitle);
    // The card in the cut-out is live and never dimmed: it is on top at its
    // centre. Polled, because the camera flies to it (and the hole slides)
    // after the walk names it; the poll reports what IS on top when it is not.
    const card = page.locator(`[data-atlas-card="${key}"]`);
    await expect
      .poll(() =>
        card.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (hit?.closest('[data-atlas-card]') === el) return 'card';
          const id = hit?.closest('[data-testid]')?.getAttribute('data-testid') ?? hit?.tagName ?? 'nothing';
          return `${id} at ${Math.round(r.left + r.width / 2)},${Math.round(r.top + r.height / 2)}`;
        }),
      )
      .toBe('card');

    // Put on Today is the reschedule verb; it goes once it has run.
    await walk.getByTestId('atlas-walk-today').click();
    await expect(walk.getByTestId('atlas-walk-today')).toHaveCount(0);
    await expect(card.locator(`[data-testid="atlas-row"][data-item-id="${taskId}"]`)).toBeVisible();

    // Escape ends it and the camera goes back where it was.
    await page.keyboard.press('Escape');
    await expect(walk).toHaveCount(0);
    await expect(page.getByTestId('atlas-walk-button')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => world.evaluate((el) => (el as HTMLElement).style.transform)).toBe(before);

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
