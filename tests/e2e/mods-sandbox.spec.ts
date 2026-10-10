import { test, expect, type Page } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { gotoApp, runCommand } from './helpers/app';
import { cleanupTestMods, fetchTestMod, fetchTestModFaults, specScope } from './helpers/api';

/**
 * MODS: the runtime end to end (memory/plans/mods.md, build order 8).
 *
 * What only a real browser can say: that the sandbox frame at
 * /mods/sandbox/<version> boots under its CSP, that a blob worker compiles
 * QuickJS there, that a mod saved in Make runs from ⌘K and its toast lands,
 * that nothing inside can reach the network, and that a mod that spins is
 * stopped and shows in Problems.
 *
 * FAILURE POLICY. If an engine cannot run the sandbox (the blob worker, the
 * module post or `worker-src` fails there), the result must be "Mods can't
 * run in this browser yet", never a relaxed sandbox: `allow-same-origin` is
 * never added. So outside Chromium the save may end in that message, and the
 * test asserts it rather than skipping silently. In Chromium the sandbox must
 * work. Only Chromium runs this today; playwright.config.ts has no Firefox or
 * WebKit project yet.
 *
 * Serial, under its own prefix: every test writes user_mods rows on the
 * shared test user, and a switched-on mod from one test would hear another's
 * commands.
 */
const scope = specScope('mods');

async function gotoMake(page: Page): Promise<void> {
  await page.goto('/settings/make');
  await expect(page.getByTestId('make-pane')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('make-new-mod')).toBeVisible({ timeout: 20_000 });
}

/**
 * Makes a mod in Make: the editor's template when `source` is left out.
 * Returns false when this engine cannot run the sandbox, having asserted the
 * message that says so.
 */
async function makeMod(page: Page, name: string, source?: string): Promise<boolean> {
  await gotoMake(page);
  await page.getByTestId('make-new-mod').click();
  await page.getByTestId('mod-name').fill(name);
  if (source !== undefined) await page.getByTestId('mod-source').fill(source);
  await page.getByTestId('mod-save').click();

  const saved = page.getByTestId('make-notice');
  const error = page.getByTestId('mod-editor-error');
  await expect(saved.or(error)).toBeVisible({ timeout: 20_000 });
  if (await error.isVisible()) {
    const text = (await error.textContent()) ?? '';
    if (test.info().project.name !== 'chromium' && text.includes('can’t run in this browser')) return false;
    throw new Error(`the mod did not save: ${text}`);
  }
  await expect(saved).toHaveText('Saved. It starts switched off.');
  return true;
}

/** Switches a mod on in Make and waits until the write has landed. */
async function switchOn(page: Page, name: string): Promise<{ id: string; slug: string }> {
  await page.getByRole('switch', { name }).click();
  await expect.poll(async () => (await fetchTestMod(name))?.enabled ?? false, { timeout: 10_000 }).toBe(true);
  const row = await fetchTestMod(name);
  return { id: row!.id, slug: row!.slug };
}

test.describe('Mods', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await cleanupTestMods(scope.prefix);
    await loginTestUser(page);
  });

  test.afterEach(async () => {
    await cleanupTestMods(scope.prefix);
  });

  test('the template saves in Make, runs from ⌘K and toasts the count', async ({ page }) => {
    const name = scope.title('Water');
    if (!(await makeMod(page, name))) return;
    const { slug } = await switchOn(page, name);

    await gotoApp(page);
    await runCommand(page, `mod.${slug}.add-glass`, { query: 'Add a glass' });
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: '1 of 8 glasses today' });
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(toast).toContainText(`Your mod: ${name}`);
  });

  test('nothing in the sandbox reaches the network', async ({ page }) => {
    const name = scope.title('Probe');
    const logs: string[] = [];
    page.on('console', (msg) => logs.push(msg.text()));
    const source = `export const manifest = { version: 1, uses: [], commands: [{ id: 'probe', label: 'Probe' }] };
export function register(on) {
  on('command', async ($) => {
    let f = 'blocked';
    try { if (typeof fetch === 'function') { await fetch('/'); f = 'reached'; } } catch (e) {}
    let i = 'blocked';
    try { await import('data:text/javascript,export default 1'); i = 'reached'; } catch (e) {}
    await $.log({ level: 'info', text: 'probe fetch ' + f + ' import ' + i });
  });
}
`;
    if (!(await makeMod(page, name, source))) return;
    const { slug } = await switchOn(page, name);

    await gotoApp(page);
    await runCommand(page, `mod.${slug}.probe`, { query: 'Probe' });
    // The mod's own view: its context has no fetch, and no import resolves.
    await expect
      .poll(() => logs.find((l) => l.includes('probe fetch')) ?? '', { timeout: 15_000 })
      .toContain('probe fetch blocked import blocked');

    // The frame's: its CSP (connect-src 'none') refuses a fetch outright.
    const frame = page.frames().find((f) => f.url().includes('/mods/sandbox/'));
    expect(frame, 'the sandbox frame is mounted while a mod runs').toBeTruthy();
    const fromFrame = await frame!.evaluate(async () => {
      try {
        await fetch('/');
        return 'reached';
      } catch {
        return 'blocked';
      }
    });
    expect(fromFrame).toBe('blocked');

    // The worker's, where the engine reports it: LOCKDOWN took fetch and
    // importScripts away, and the CSP refuses a dynamic import.
    const worker = page.workers().find((w) => w.url().startsWith('blob:'));
    if (worker) {
      // A string, so the test runner's transform cannot rewrite the import().
      const fromWorker = await worker.evaluate(`(async () => {
        let imported = 'blocked';
        try {
          await import('data:text/javascript,export default 1');
          imported = 'reached';
        } catch (e) {}
        return { fetch: typeof self.fetch, importScripts: typeof self.importScripts, imported };
      })()`);
      expect(fromWorker).toEqual({ fetch: 'undefined', importScripts: 'undefined', imported: 'blocked' });
    } else {
      test.info().annotations.push({ type: 'note', description: 'this engine does not report the frame’s worker' });
    }
  });

  test('a mod that spins is stopped, and Problems shows it', async ({ page }) => {
    const name = scope.title('Spin');
    const source = `export const manifest = { version: 1, uses: [], commands: [{ id: 'spin', label: 'Spin' }] };
export function register(on) {
  on('command', () => { while (true) {} });
}
`;
    if (!(await makeMod(page, name, source))) return;
    const { id, slug } = await switchOn(page, name);

    await gotoApp(page);
    await runCommand(page, `mod.${slug}.spin`, { query: 'Spin' });
    await expect
      .poll(async () => (await fetchTestModFaults(id)).map((f) => f.summary.code), { timeout: 15_000 })
      .toContain('cpu');

    await gotoMake(page);
    const row = page.locator(`[data-make-row="${id}"]`);
    await row.getByRole('button', { name: `Problems for ${name}` }).click();
    const problem = row.getByTestId('mod-problem').first();
    await expect(problem).toContainText('It used too much time');
    await expect(problem).toContainText('Your mod reported:');
  });
});
