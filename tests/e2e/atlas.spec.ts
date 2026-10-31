import { test, expect } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { reloadApp, runCommand, setScope } from './helpers/app';
import { cleanupByTitlePrefix, cleanupTestLabels, createTestTask, specScope } from './helpers/api';

/**
 * Atlas (design PR1a): the third scope, desktop only. A project shows as a
 * card with its next step; a row's right-click is the item menu. Positions are
 * memory-only until PR1b, so nothing here reloads to check a place.
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

  test('the phone shows no Atlas, even with Atlas left on this device', async ({ page }) => {
    await setScope(page, 'Atlas');
    await page.setViewportSize({ width: 390, height: 844 });
    await reloadApp(page);
    // The phone's router is day-only and has no Scope menu at all.
    await expect(page.getByTestId('view-root')).toHaveAttribute('data-view-scope', 'day');
    await expect(page.getByRole('menuitem', { name: 'Atlas' })).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await reloadApp(page);
    await setScope(page, 'Day');
  });
});
