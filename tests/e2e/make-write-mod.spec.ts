import { test, expect, type Page } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { gateAnswered, stubConnectedModel } from './helpers/ai';
import { cleanupTestMods, fetchTestMod, specScope } from './helpers/api';

/**
 * MODS: "Write with AI" writes a mod (memory/plans/mods.md, build order 10).
 *
 * What only a real browser can say: that a drafted mod's code runs once in
 * the real sandbox before its card shows, that the card reads what that run
 * declared, that Install saves it switched off, and that Edit hands the draft
 * to the mod editor and Cancel comes back without a second call.
 *
 * Nothing leaves the machine: the gate is stubbed as a connected model
 * (helpers/ai.ts) and `/api/ai/make` is answered by `page.route` with canned
 * SSE frames, counted so a test can say how many calls were made.
 *
 * FAILURE POLICY, as mods-sandbox.spec.ts: an engine that cannot run the
 * sandbox must say "Mods can't run in this browser" on the Write box, never
 * relax the sandbox. Outside Chromium the test asserts that message and
 * stops; in Chromium the sandbox must work.
 *
 * Serial, under its own prefix: every test may write user_mods rows on the
 * shared test user.
 */
const scope = specScope('makemod');

/** A Water-shaped counter, changed enough that the reader does not take it for the prompt's example. */
const PAGES_SOURCE = `export const manifest = {
  version: 1,
  uses: ['storage', 'ui'],
  commands: [{ id: 'add-ten', label: 'Add ten pages', keywords: ['read', 'book'] }],
  panels: [{ id: 'pages', label: 'Pages', icon: 'BookOpen', card: true }],
};

async function pagesToday($) {
  const { date } = await $.today();
  const saved = await $.store.get({ key: 'pages' });
  return { date, count: saved && saved.date === date ? saved.count : 0 };
}

async function addTen($) {
  const { date, count } = await pagesToday($);
  await $.store.set({ key: 'pages', value: { date, count: count + 10 } });
  return count + 10;
}

export function register(on) {
  on('command', async ($, e) => {
    if (e.id !== 'add-ten') return;
    const count = await addTen($);
    await $.ui.toast({ text: count + ' pages today' });
  });

  on('ui.resolve', async ($, e) => {
    if (e.panelId !== 'pages') return;
    const { count } = await pagesToday($);
    return {
      type: 'stack',
      children: [
        { type: 'stat', value: String(count), label: 'Pages today' },
        { type: 'button', label: '+10', action: 'add', tone: 'accent' },
      ],
    };
  });

  on('ui.action', async ($, e) => {
    if (e.action === 'add') await addTen($);
  });
}
`;

/** No register: the sandbox refuses to load it. */
const NO_REGISTER_SOURCE = `export const manifest = { version: 1, uses: [], commands: [] };
`;

/** Answers every Make call with this reply, in two SSE frames, and counts the calls. */
async function stubMake(page: Page, reply: unknown): Promise<{ calls: () => number }> {
  let calls = 0;
  const text = JSON.stringify(reply);
  const half = Math.floor(text.length / 2);
  const body =
    [text.slice(0, half), text.slice(half)].map((c) => `data: ${JSON.stringify({ content: c })}\n\n`).join('') +
    'data: [DONE]\n\n';
  await page.route('**/api/ai/make', (route) => {
    calls += 1;
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'Cache-Control': 'no-store' },
      body,
    });
  });
  return { calls: () => calls };
}

/**
 * Opens Make with the Mod box, from a fresh load (the sandbox idle), and
 * waits for it to answer. Returns false when this engine cannot run the
 * sandbox, having asserted the Write box's message that says so.
 */
async function openModBox(page: Page): Promise<boolean> {
  const answered = gateAnswered(page);
  await page.goto('/settings/make?write=mod');
  await answered;
  await expect(page.getByTestId('make-write')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('make-write-kind')).toHaveValue('mod');
  await page.getByTestId('make-write-ask').fill('A card that counts the pages I read today, with a +10 button');

  // Write waits for the sandbox's answer; either it enables or the box says why.
  const sandbox = page.getByTestId('make-write-sandbox');
  const ready = page.locator('[data-testid="make-write-go"]:enabled');
  await expect(sandbox.or(ready)).toBeVisible({ timeout: 20_000 });
  if (await sandbox.isVisible()) {
    const text = (await sandbox.textContent()) ?? '';
    if (test.info().project.name !== 'chromium' && text.includes('can’t run in this browser')) return false;
    throw new Error(`the sandbox did not boot: ${text}`);
  }
  return true;
}

test.describe('Write with AI: a mod', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await cleanupTestMods(scope.prefix);
    await stubConnectedModel(page);
    await loginTestUser(page);
  });

  test.afterEach(async () => {
    await cleanupTestMods(scope.prefix);
  });

  test('a drafted mod is checked, read in words, and installs switched off', async ({ page }) => {
    const name = scope.title('Pages');
    const make = await stubMake(page, { kind: 'mod', name, source: PAGES_SOURCE });
    if (!(await openModBox(page))) return;
    await page.getByTestId('make-write-go').click();

    const card = page.getByTestId('make-draft');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveAttribute('data-make-draft-kind', 'mod');
    await expect(page.getByTestId('make-draft-name')).toHaveText(name);
    await expect(page.getByTestId('make-draft-uses')).toContainText('keep its own saved data');
    await expect(page.getByTestId('make-draft-panels')).toContainText('under the braindump');
    await expect(page.getByTestId('make-draft-problems')).toHaveCount(0);

    await page.getByTestId('make-draft-source-toggle').click();
    await expect(page.getByTestId('make-draft-source')).toContainText("id: 'add-ten'");

    await page.getByTestId('make-draft-install').click();
    await expect(page.getByTestId('make-write-notice')).toHaveText('Saved. It starts switched off.');
    await expect.poll(async () => (await fetchTestMod(name))?.enabled, { timeout: 10_000 }).toBe(false);
    await expect(page.getByRole('switch', { name })).not.toBeChecked();
    expect(make.calls()).toBe(1);
  });

  test('Edit opens the editor on the draft, and Cancel comes back with no second call', async ({ page }) => {
    const name = scope.title('Pages');
    const make = await stubMake(page, { kind: 'mod', name, source: PAGES_SOURCE });
    if (!(await openModBox(page))) return;
    await page.getByTestId('make-write-go').click();
    await expect(page.getByTestId('make-draft')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('make-draft-edit').click();
    await expect(page.getByTestId('mod-editor')).toBeVisible();
    await expect(page.getByTestId('mod-name')).toHaveValue(name);
    await expect(page.getByTestId('mod-source')).toHaveValue(PAGES_SOURCE);

    await page.getByTestId('mod-editor').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('make-draft-name')).toHaveText(name);
    expect(make.calls()).toBe(1);
    expect(await fetchTestMod(name)).toBeNull();
  });

  test('a draft that would not load says so, and Install is held', async ({ page }) => {
    const name = scope.title('Broken');
    await stubMake(page, { kind: 'mod', name, source: NO_REGISTER_SOURCE });
    if (!(await openModBox(page))) return;
    await page.getByTestId('make-write-go').click();

    await expect(page.getByTestId('make-draft')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('make-draft-problems')).toContainText('It would not load');
    await expect(page.getByTestId('make-draft-mod')).toHaveCount(0);
    await expect(page.getByTestId('make-draft-install')).toBeDisabled();
    await expect(page.getByTestId('make-draft-edit')).toBeEnabled();
  });
});
