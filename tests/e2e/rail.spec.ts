import { test, expect, type Page } from '@playwright/test';
import { loginTestUser } from './helpers/auth';
import { createTestTask, cleanupByTitlePrefix, specScope } from './helpers/api';
import { getTodayStr } from './helpers/dates';
import { BASE_URL } from './helpers/env';
import {
  reloadApp,
  itemCard,
  launcherInput,
  launcherPanel,
  omnibar,
  omnibarPanel,
} from './helpers/app';
import {
  askBox,
  askButton,
  cleanupConversations,
  conversationWritten,
  gateAnswered,
  pasteInto,
  rail,
  stubChatReply,
  stubAIGate,
  stubConnectedModel,
  STUB_BAD_KEY,
  STUB_GOOD_KEY,
  turnSaved,
  uniqueWord,
  unlitKey,
} from './helpers/ai';

/**
 * Ask in the right rail (memory/plans/ai-vision.md, step 2a), end to end on
 * the desktop: the stubbed model answers (helpers/ai.ts), and everything Ask
 * keeps is saved through the REAL conversations routes into the local stack.
 *
 * Ask STARTS CLOSED (sidebar-store ASK_OPEN_DEFAULT), and every test here
 * starts in a fresh context, so each one opens it the way a user would: the
 * Ask button, Ctrl+J, `?` in the dock, or an item's Back.
 *
 * Under fullyParallel these tests run beside each other on one account, and
 * History lists all of their conversations. So every lookup is by a title
 * token one test owns, and every cleanup deletes only that test's rows (never
 * the spec's whole prefix, which would delete a sibling's mid-flight).
 *
 * Ctrl+J is pressed as `ControlOrMeta+j`: the binding is `mod+J`, Ctrl on
 * Linux and Windows (Kirby's) and ⌘ on a Mac, and the label is chordLabel's.
 */

const scope = specScope('rail');

/** Open an item from its row on the grid, as a click does. */
async function openFromGrid(page: Page, id: string, title: string) {
  await itemCard(page, id).getByText(title, { exact: true }).click();
  const panel = rail(page).getByTestId('item-dialog');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('item-dialog-title-input')).toHaveValue(title);
  return panel;
}

test.describe('Ask in the right rail', () => {
  test.beforeEach(async ({ page }) => {
    // Before the first load: the gate is asked once, at sign-in.
    await stubConnectedModel(page);
    const answered = gateAnswered(page);
    await loginTestUser(page);
    await answered;
  });

  test('opens closed, asks, saves, and History finds, renames, stars and deletes it', async ({
    page,
  }) => {
    const token = scope.title('ask');
    const question = `${token} what should I focus on?`;
    const word = uniqueWord('zephyr');
    const renamed = `${token} renamed`;
    await stubChatReply(page, `Start with the ${word} draft, then lunch.`);
    const column = rail(page);

    try {
      // 1. Closed, with the Ask button showing. The button opens Ask home:
      //    the greeting, the heading, and its box, focused.
      await expect(askButton(page)).toBeVisible();
      await expect(column.locator('[data-ask-home]')).toHaveCount(0);
      await askButton(page).click();
      const home = column.locator('[data-ask-home]');
      await expect(home).toBeVisible();
      await expect(home.locator('[data-ask-greeting="home"]')).toHaveText(
        /^(Morning|Afternoon|Evening)(, \S+)?\.$/
      );
      await expect(column.locator('[data-ask-heading]')).toHaveText('Ask');
      await expect(askButton(page)).toBeHidden();
      await expect(askBox(column)).toBeFocused();

      // 2. Ask from the box: the conversation is pushed over home, the
      //    question and the stubbed reply show, and the turn is saved once.
      const saved = turnSaved(page);
      await askBox(column).fill(question);
      await askBox(column).press('Enter');
      const conversation = column.locator('[data-ask-conversation]');
      await expect(conversation).toBeVisible();
      await expect(column.getByRole('button', { name: 'Back to Ask' })).toBeVisible();
      await expect(conversation.locator('[data-message-role="user"]')).toContainText(question);
      await expect(conversation.locator('[data-message-role="assistant"]')).toContainText(word);
      const id = await conversation.getAttribute('data-ask-conversation');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const save = await saved;
      expect(save.ok()).toBe(true);
      expect(new URL(save.url()).pathname).toBe(`/api/ai/conversations/${id}/turns`);
      // Saved, so its title is now the ⌄ menu (Rename, Star, Delete).
      await expect(column.getByTestId('conversation-title-menu')).toContainText(token);

      // 3. A reload keeps Ask open (askOpen is persisted) at home, and
      //    History lists the conversation with nothing changed.
      await reloadApp(page);
      await expect(home).toBeVisible();
      await expect(askButton(page)).toBeHidden();
      await column.getByTestId('ask-history').click();
      await expect(column.locator('[data-ask-history]')).toBeVisible();
      const row = column.getByTestId('history-row').filter({ hasText: token });
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId('history-second-line')).toHaveText('No changes');

      // 4. Search finds it by a word only the saved reply contains.
      await column.getByTestId('history-search').fill(word);
      await expect(column.getByTestId('history-search-status')).toHaveText('1 result');
      const hit = column
        .locator('[data-history-group="results"]')
        .getByTestId('history-row')
        .filter({ hasText: token });
      await expect(hit).toHaveCount(1);
      await expect(hit.getByTestId('history-second-line')).toContainText(word);

      // 5. Rename, then Star: each a PATCH the server accepts.
      await hit.click();
      await expect(conversation).toHaveAttribute('data-ask-conversation', id!);
      await column.getByTestId('conversation-title-menu').click();
      await page.getByTestId('conversation-rename').click();
      const field = column.getByTestId('conversation-rename-input');
      await expect(field).toBeFocused();
      const renaming = conversationWritten(page, 'PATCH', id!);
      await field.fill(renamed);
      await field.press('Enter');
      expect((await renaming).ok()).toBe(true);
      await expect(column.getByTestId('conversation-title-menu')).toContainText(renamed);

      await column.getByTestId('conversation-title-menu').click();
      await expect(page.getByTestId('conversation-star')).toHaveText('Star');
      const starring = conversationWritten(page, 'PATCH', id!);
      await page.getByTestId('conversation-star').click();
      expect((await starring).ok()).toBe(true);

      // Back to History, the search cleared: it moved to Starred.
      await column.getByRole('button', { name: 'Back to History' }).click();
      await column.getByTestId('history-search').fill('');
      const starred = column
        .locator('[data-history-group="starred"]')
        .getByTestId('history-row')
        .filter({ hasText: renamed });
      await expect(starred).toHaveCount(1);

      // Delete, through the confirm: gone from History at once, and still
      // gone after a reload, because the server deleted it.
      await starred.click();
      await column.getByTestId('conversation-title-menu').click();
      await page.getByTestId('conversation-delete').click();
      const deleting = conversationWritten(page, 'DELETE', id!);
      await page.getByTestId('conversation-delete-confirm').click();
      expect((await deleting).ok()).toBe(true);
      await expect(column.locator('[data-ask-history]')).toBeVisible();
      await expect(column.getByTestId('history-row').filter({ hasText: token })).toHaveCount(0);

      await reloadApp(page);
      await column.getByTestId('ask-history').click();
      await expect(column.locator('[data-ask-history]')).toBeVisible();
      await expect(column.getByTestId('history-loading')).toHaveCount(0);
      await expect(column.getByTestId('history-row').filter({ hasText: token })).toHaveCount(0);
      const gone = await page.request.get(`${BASE_URL}/api/ai/conversations/${id}`);
      expect(gone.status()).toBe(404);
    } finally {
      await cleanupConversations(page, token);
    }
  });

  test('an item from the grid wears the rail header: Back to Ask, ✕, and no Done', async ({
    page,
  }) => {
    const title = scope.title('item');
    const id = await createTestTask(page, {
      title,
      startDate: getTodayStr(),
      isScheduled: true,
      timeBucket: 'morning',
    });
    const column = rail(page);

    try {
      await reloadApp(page);
      const panel = await openFromGrid(page, id, title);
      await expect(column.getByRole('button', { name: 'Back to Ask' })).toBeVisible();
      await expect(column.getByTestId('item-dialog-close')).toBeVisible();
      await expect(page.getByTestId('item-dialog-submit')).toHaveCount(0);
      await expect(panel.getByPlaceholder('Ask about this item…')).toBeVisible();

      // Back closes the item and shows Ask home beneath it.
      await column.getByRole('button', { name: 'Back to Ask' }).click();
      await expect(page.getByTestId('item-dialog')).toHaveCount(0);
      await expect(column.locator('[data-ask-home]')).toBeVisible();

      // ✕ over an item closes the item and the rail with it.
      await openFromGrid(page, id, title);
      await column.getByTestId('item-dialog-close').click();
      await expect(page.getByTestId('item-dialog')).toHaveCount(0);
      await expect(column.locator('[data-ask-home]')).toBeHidden();
      await expect(askButton(page)).toBeVisible();
    } finally {
      await cleanupByTitlePrefix(page, title);
    }
  });

  test('Ctrl+J closes Ask and opens it again, and either way it stays as left', async ({
    page,
  }) => {
    const column = rail(page);
    const home = column.locator('[data-ask-home]');

    await askButton(page).click();
    await expect(home).toBeVisible();
    await expect(askBox(column)).toBeFocused();

    // Closed from inside, focus goes back to the button that opened it.
    await page.keyboard.press('ControlOrMeta+j');
    await expect(home).toBeHidden();
    await expect(askButton(page)).toBeFocused();

    // Opened again, with the box focused.
    await page.keyboard.press('ControlOrMeta+j');
    await expect(home).toBeVisible();
    await expect(askBox(column)).toBeFocused();

    // Open stays open across a reload; closed stays closed.
    await reloadApp(page);
    await expect(home).toBeVisible();
    await page.keyboard.press('ControlOrMeta+j');
    await expect(home).toBeHidden();
    await reloadApp(page);
    await expect(askButton(page)).toBeVisible();
    await expect(home).toHaveCount(0);
  });

  test('? in the dock over an open item asks about it, and Back returns to the item', async ({
    page,
  }) => {
    const title = scope.title('over');
    const token = scope.title('ask-over');
    const id = await createTestTask(page, {
      title,
      startDate: getTodayStr(),
      isScheduled: true,
      timeBucket: 'morning',
    });
    await stubChatReply(page, 'Yes, start there.');
    const column = rail(page);

    try {
      await reloadApp(page);
      await openFromGrid(page, id, title);

      // Classic's docked omnibar, with the item still open beside it.
      const bar = omnibar(page);
      await bar.click();
      await bar.fill(`? ${token} is this the right first step?`);
      // `?` leaves one row, "Ask AI". Clicked, not Entered, as omnibar.spec
      // does: which row cmdk has selected is a test of cmdk, not of ours.
      const askRow = omnibarPanel(page).getByText(/Ask AI/).first();
      await expect(askRow).toBeVisible();
      const saved = turnSaved(page);
      await askRow.click();

      // The item gives way to a new conversation, whose Back names the item.
      await expect(page.getByTestId('item-dialog')).toHaveCount(0);
      const conversation = column.locator('[data-ask-conversation]');
      await expect(conversation.locator('[data-message-role="user"]')).toContainText(token);
      await expect(conversation.locator('[data-message-role="assistant"]')).toContainText(
        'Yes, start there.'
      );
      expect((await saved).ok()).toBe(true);

      await column.getByRole('button', { name: `Back to ${title}` }).click();
      const panel = column.getByTestId('item-dialog');
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId('item-dialog-title-input')).toHaveValue(title);
    } finally {
      await cleanupConversations(page, token);
      await cleanupByTitlePrefix(page, title);
    }
  });

  // Notepad is the one layout that bands the row (DayTabs above, StatusBar
  // below) and draws the column flat, so Ask must sit between the bands with
  // the seam, and its overlay must be paper, not see-through. Set through
  // localStorage only, as layouts.spec.ts does: the Settings row would write
  // the shared user's layout and rearrange every parallel spec.
  for (const style of ['notepad', 'notepad-markdown', 'notepad-retro'] as const) {
    test(`${style}: Ask docks between the tabs and the status bar, and overlays opaque at 1100`, async ({
      page,
    }) => {
      const column = rail(page);
      const home = column.locator('[data-ask-home]');
      await page.evaluate((value) => localStorage.setItem('dsul-layout', value), style);
      const answered = gateAnswered(page);
      await reloadApp(page);
      await answered;
      await expect(page.locator('[data-layout]')).toHaveAttribute('data-layout', style);
      // The gate's response landing is not the store having taken it: the
      // button mounts once Ask answers, so Ctrl+J waits for it.
      await expect(page.locator('[data-ask-opener]')).toBeAttached();

      // 1280: docked, in the middle row, with the flat column's 1px seam.
      await page.keyboard.press('ControlOrMeta+j');
      await expect(home).toBeVisible();
      await expect(column).toHaveAttribute('data-rail-docked', '');
      await expect(column).toHaveCSS('border-left-width', '1px');
      const tabs = (await page.getByTestId('day-tabs').boundingBox())!;
      const status = (await page.getByTestId('status-bar').boundingBox())!;
      const docked = (await column.boundingBox())!;
      expect(docked.y).toBeGreaterThanOrEqual(tabs.y + tabs.height - 1);
      expect(docked.y + docked.height).toBeLessThanOrEqual(status.y + 1);
      // The bands span the whole window, over the column too.
      expect(tabs.x + tabs.width).toBeGreaterThanOrEqual(docked.x + docked.width - 1);
      expect(status.x + status.width).toBeGreaterThanOrEqual(docked.x + docked.width - 1);
      await expect(page.locator('main[inert]')).toHaveCount(0);

      // 1100: narrowing past the edge parks it, and the planner stays usable.
      await page.setViewportSize({ width: 1100, height: 720 });
      await expect(home).toBeHidden();
      await expect(page.locator('main[inert]')).toHaveCount(0);

      // Ctrl+J there summons it as an opaque card over an inert planner.
      await page.keyboard.press('ControlOrMeta+j');
      await expect(home).toBeVisible();
      await expect(column).not.toHaveAttribute('data-rail-docked', '');
      await expect
        .poll(() => column.evaluate((el) => getComputedStyle(el).backgroundColor))
        .not.toBe('rgba(0, 0, 0, 0)');
      await expect(page.locator('main[inert]')).toHaveCount(1);

      // Escape from its empty box parks it, and gives the planner back.
      await expect(askBox(column)).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(home).toBeHidden();
      await expect(page.locator('main[inert]')).toHaveCount(0);
    });
  }
});

/**
 * The same key and column while nothing answers (memory/plans/ai-vision.md,
 * AI setup PR 3 and 4): unlit, it reads "Set up AI" (or "Fix AI" for a saved
 * model that stopped working) and opens the setup column, which says what AI
 * could do here, takes a key right there, and offers "No AI, thanks". A key
 * that works turns the column into Ask, which says so once ("It works.").
 *
 * Two more doors open it (AI setup PR 5): `?` in the dock, which keeps the
 * question typed after it and sends it once AI is connected, and Ctrl+K's
 * "Set up AI". A kept question goes only where the consent line said, so a
 * sure paste waits in the box for Connect and ask.
 *
 * The gate is stubbed statefully (helpers/ai.ts `stubAIGate`): the e2e
 * account is shared by every parallel spec, so neither "No AI, thanks" nor a
 * connect may reach the real route, and a reload must still see what they
 * wrote. The keys pasted here are the stub's (`STUB_GOOD_KEY`,
 * `STUB_BAD_KEY`), answered by prefix, never by a provider.
 */
test.describe('Set up AI in the right rail', () => {
  async function signInWith(page: Page, o: Parameters<typeof stubAIGate>[1] = {}) {
    // Before the first load: the gate is asked once, at sign-in.
    const gate = await stubAIGate(page, o);
    const answered = gateAnswered(page);
    await loginTestUser(page);
    await answered;
    return gate;
  }

  test('nothing connected: the unlit key opens the setup column, and Ctrl+J, ✕ and a reload close it', async ({
    page,
  }) => {
    await signInWith(page);
    const key = unlitKey(page);
    const column = rail(page);
    const setup = column.locator('[data-ask-setup]');

    // Unlit and named for what it opens; there is no Ask, and nothing is open.
    await expect(key).toBeVisible();
    await expect(key).toHaveAccessibleName('Set up AI');
    await expect(askButton(page)).toHaveCount(0);
    await expect(setup).toHaveCount(0);

    // The key opens the setup column, never Ask, and focus goes to its heading.
    await key.click();
    await expect(setup).toBeVisible();
    await expect(setup).toHaveAttribute('data-ask-setup', 'invite');
    await expect(setup.locator('[data-ask-heading]')).toBeFocused();
    await expect(key).toBeHidden();
    await expect(column.locator('[data-ask-home]')).toHaveCount(0);
    await expect(askBox(column)).toHaveCount(0);
    // The way in is here, not a trip to Settings: Google's free key, pasted in.
    await expect(setup.getByTestId('connect-ai')).toBeVisible();
    await expect(setup.getByTestId('connect-key-card').getByLabel('Your Gemini key')).toBeVisible();
    // Nothing in the column is lime: its buttons are outline or quiet.
    await expect(setup.locator('.bg-primary, [data-slot="button-key"]')).toHaveCount(0);
    await expect(setup.locator('[data-ask-setup-foot]')).toContainText(
      'AI is optional. dsul works fully without it.'
    );

    // Ctrl+J from inside closes it and hands focus back to the key; again opens it.
    await page.keyboard.press('ControlOrMeta+j');
    await expect(setup).toBeHidden();
    await expect(key).toBeFocused();
    await page.keyboard.press('ControlOrMeta+j');
    await expect(setup).toBeVisible();

    // ✕ closes it too.
    await column.getByTestId('setup-close').click();
    await expect(setup).toBeHidden();
    await expect(key).toBeFocused();

    // Never kept open: a reload starts with the key, the column closed.
    await page.keyboard.press('ControlOrMeta+j');
    await expect(setup).toBeVisible();
    const answered = gateAnswered(page);
    await reloadApp(page);
    await answered;
    await expect(key).toBeVisible();
    await expect(setup).toHaveCount(0);
  });

  test('No AI, thanks puts the key away for the account, and Undo brings it back', async ({
    page,
  }) => {
    const gate = await signInWith(page);
    const key = unlitKey(page);
    const setup = rail(page).locator('[data-ask-setup]');
    const strip = page.getByTestId('undo-strip');
    const undo = strip.getByRole('button', { name: 'Undo' });

    await key.click();
    await setup.getByTestId('no-ai-thanks').click();

    // Said in prose in the strip, focus on its Undo; the column and the key go.
    await expect(strip).toContainText('AI is off. dsul won’t bring it up again.');
    await expect(undo).toBeFocused();
    await expect(setup).toHaveCount(0);
    await expect(page.locator('[data-ask-opener]')).toHaveCount(0);
    await expect.poll(() => gate.patches).toEqual([{ hidden: true }]);

    // Undo: the key is back, unlit, with focus on it, and the account says so.
    await undo.click();
    await expect(strip).toHaveCount(0);
    await expect(key).toBeVisible();
    await expect(key).toBeFocused();
    await expect.poll(() => gate.patches).toEqual([{ hidden: true }, { hidden: false }]);

    // Said again and left: it holds across a reload, and Ctrl+J offers nothing.
    await key.click();
    await setup.getByTestId('no-ai-thanks').click();
    await expect.poll(() => gate.hidden()).toBe(true);
    const answered = gateAnswered(page);
    await reloadApp(page);
    await answered;
    // The planner is up and the gate has answered; the key never comes.
    await expect(page.getByTestId('view-root')).toBeVisible();
    await expect(page.locator('[data-ask-opener]')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+j');
    await expect(setup).toHaveCount(0);
    await expect(rail(page).locator('[data-ask-home]')).toHaveCount(0);

    // Once the strip has gone, Settings → AI is the way back: the card says
    // AI is off, and the Use AI switch above it turns it back on.
    await page.goto(`${BASE_URL}/settings/ai`);
    const off = page.getByTestId('mcp-ai-off');
    await expect(off).toContainText('AI is off');
    await expect(off).toContainText('turn it back on above');
    await page
      .locator('[data-setting-row="beacon.useAi"]')
      .getByRole('switch', { name: 'Use AI in dsul' })
      .click();
    await expect(off).toHaveCount(0);
    await expect.poll(() => gate.hidden()).toBe(false);
    await loginTestUser(page);
    await expect(key).toBeVisible();
  });

  test('a saved key its provider turned down: the key reads Fix AI, and says what is wrong', async ({
    page,
  }) => {
    const gate = await signInWith(page, { model: 'failing' });
    const key = unlitKey(page);
    const setup = rail(page).locator('[data-ask-setup]');

    await expect(key).toHaveAccessibleName('Fix AI');
    await key.click();
    await expect(setup).toHaveAttribute('data-ask-setup', 'fix');
    const fix = setup.getByTestId('setup-fix');
    await expect(fix).toContainText('Google stopped accepting your key');
    // A new key goes in right here; Settings → AI is for everything else.
    await expect(fix.getByLabel('New Gemini key')).toHaveAttribute('data-testid', 'fix-key');
    await expect(fix).toContainText('Your old key is replaced only once this one works.');
    await expect(
      setup.getByTestId('fix-caption').getByRole('link', { name: 'Settings → AI' })
    ).toHaveAttribute('href', '/settings/ai');
    await expect(setup.getByTestId('setup-previews')).toHaveCount(0);

    // A fresh check that finds the key still turned down says so.
    await fix.getByTestId('setup-recheck').click();
    await expect(fix.getByTestId('fix-status')).toHaveText(
      'Google still turns it down. A new key above fixes it.'
    );
    expect(gate.patches).toEqual([{ recheck: true }]);
    expect(gate.connects).toEqual([]);
  });

  test('a key pasted in the column: a refused one stays and says why, a good one turns the column into Ask', async ({
    page,
  }) => {
    const gate = await signInWith(page);
    const column = rail(page);
    const setup = column.locator('[data-ask-setup]');
    const home = column.locator('[data-ask-home]');

    await unlitKey(page).click();
    await expect(setup).toHaveAttribute('data-ask-setup', 'invite');
    const card = setup.getByTestId('connect-key-card');
    const field = card.getByTestId('connect-key');

    // A Google key is checked the moment it lands. Turned down, it stays in
    // the box (never in a value attribute), and the note says why.
    await pasteInto(field, STUB_BAD_KEY);
    const note = card.getByTestId('connect-note');
    await expect(note).toHaveAttribute('data-code', 'key_rejected');
    await expect(note.getByRole('alert')).toHaveText(
      'Google didn’t accept that key. It may be cut short, or it was deleted in AI Studio. It’s still in the box, so you can check it or paste a new one.'
    );
    await expect(field).toHaveValue(STUB_BAD_KEY);
    expect(await field.getAttribute('value')).toBeNull();
    await expect(setup).toBeVisible();
    await expect(home).toHaveCount(0);
    expect(gate.connects).toEqual([{ provider: 'gemini', accepted: false }]);

    // A good one replaces it, and the column becomes Ask, which says it works
    // and names the model.
    await pasteInto(field, STUB_GOOD_KEY);
    await expect(home).toBeVisible();
    await expect(setup).toBeHidden();
    const works = home.getByTestId('it-works');
    await expect(works.getByRole('heading', { name: 'It works.' })).toBeVisible();
    await expect(works.getByTestId('it-works-line')).toHaveText(
      'Google Gemini answered a test question. Ask will use Gemini Flash, Google’s quick everyday model.'
    );
    await expect(works.getByRole('link', { name: 'Settings → AI' })).toHaveAttribute('href', '/settings/ai');
    // Today's openers as live rows, standing in for the foot's chips meanwhile.
    const rows = works.getByTestId('it-works-openers').locator('[data-opener]');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeLessThanOrEqual(3);
    await expect(home.getByTestId('chat-openers')).toHaveCount(0);
    await expect(column.getByTestId('answerer-label')).toHaveText('Gemini Flash');
    expect(gate.connects).toEqual([
      { provider: 'gemini', accepted: false },
      { provider: 'gemini', accepted: true },
    ]);
    // Neither key is anywhere in the page.
    const html = await page.content();
    expect(html).not.toContain(STUB_GOOD_KEY);
    expect(html).not.toContain(STUB_BAD_KEY);

    // Said once: closing Ask spends it, and the key is lit Ask now.
    await page.keyboard.press('ControlOrMeta+j');
    await expect(home).toBeHidden();
    await expect(unlitKey(page)).toHaveCount(0);
    await expect(askButton(page)).toBeVisible();
    await page.keyboard.press('ControlOrMeta+j');
    await expect(home).toBeVisible();
    await expect(home.getByTestId('it-works')).toHaveCount(0);

    // The account kept the connection, and the card was memory: a reload
    // opens Ask as Ctrl+J left it, lit, with nothing more to say.
    const answered = gateAnswered(page);
    await reloadApp(page);
    await answered;
    await expect(home).toBeVisible();
    await expect(home.getByTestId('it-works')).toHaveCount(0);
    await expect(unlitKey(page)).toHaveCount(0);
    await expect(column.getByTestId('answerer-label')).toHaveText('Gemini Flash');
  });

  test('Fix AI takes a new key in place, and one that works lights Ask', async ({ page }) => {
    const gate = await signInWith(page, { model: 'failing' });
    const column = rail(page);
    const setup = column.locator('[data-ask-setup]');
    const home = column.locator('[data-ask-home]');

    await unlitKey(page).click();
    const fix = setup.getByTestId('setup-fix');
    const field = fix.getByTestId('fix-key');
    await expect(field).toBeVisible();

    // Turned down: the old connection is untouched, the new key stays in the box.
    await pasteInto(field, STUB_BAD_KEY);
    await expect(fix.getByTestId('fix-note')).toHaveAttribute('data-code', 'key_rejected');
    await expect(field).toHaveValue(STUB_BAD_KEY);
    await expect(setup).toHaveAttribute('data-ask-setup', 'fix');

    // Taken: the column becomes Ask. A fix is no first connection, so there
    // is no "It works." card to read.
    await pasteInto(field, STUB_GOOD_KEY);
    await expect(home).toBeVisible();
    await expect(setup).toBeHidden();
    await expect(home.getByTestId('it-works')).toHaveCount(0);
    await expect(column.getByTestId('answerer-label')).toHaveText('Gemini Flash');
    expect(gate.connects).toEqual([
      { provider: 'gemini', accepted: false },
      { provider: 'gemini', accepted: true },
    ]);
  });

  test('a question kept from ? in the dock waits through setup, and is sent once to the company the line named', async ({
    page,
  }) => {
    const gate = await signInWith(page);
    const token = scope.title('kept');
    const question = `${token} what should I do first`;
    const word = uniqueWord('kept');
    await stubChatReply(page, `Start with the ${word} list.`);
    const column = rail(page);
    const setup = column.locator('[data-ask-setup]');
    // Every send and every save this page makes, so a reload can prove it
    // asked nothing a second time.
    const chats: string[] = [];
    const saves: string[] = [];
    page.on('request', (req) => {
      if (req.method() !== 'POST') return;
      const path = new URL(req.url()).pathname;
      if (path === '/api/chat') chats.push(path);
      if (/^\/api\/ai\/conversations\/[0-9a-f-]{36}\/turns$/.test(path)) saves.push(path);
    });

    try {
      // `?` with nothing connected: one row, the door into setup, so Enter
      // can only open it (never file the question as a task).
      const bar = omnibar(page);
      await bar.click();
      await bar.fill(`? ${question}`);
      const door = omnibarPanel(page).locator('[data-value="action-setup"]');
      await expect(door).toHaveText(/Set up AI to ask this/);
      await expect(omnibarPanel(page).locator('[cmdk-item]')).toHaveCount(1);
      await expect(door).toHaveAttribute('data-selected', 'true');
      await bar.press('Enter');

      // The setup column, with the question in it instead of the previews.
      await expect(setup).toHaveAttribute('data-ask-setup', 'invite');
      await expect(bar).toHaveValue('');
      await expect(setup.getByTestId('setup-question-text')).toContainText(question);
      await expect(setup.getByTestId('setup-question')).toContainText(
        'It’s kept here, and sent once AI is connected.'
      );
      await expect(setup.getByTestId('setup-previews')).toHaveCount(0);

      // A sure paste fills the box and sends nothing: the line says where
      // Connect and ask will send the question, and describes the button.
      const card = setup.getByTestId('connect-key-card');
      const field = card.getByLabel('Your Gemini key');
      await pasteInto(field, STUB_GOOD_KEY);
      const submit = card.getByTestId('connect-submit');
      await expect(submit).toHaveText('Connect and ask');
      const line =
        'Connecting sends your question, and the parts of your plan it needs, from dsul’s server to Google.';
      await expect(card.getByTestId('connect-consent')).toHaveText(line);
      await expect(submit).toHaveAccessibleDescription(line);
      await expect(field).toHaveValue(STUB_GOOD_KEY);
      expect(await field.getAttribute('value')).toBeNull();
      await expect(card.getByTestId('connect-checking')).toHaveCount(0);
      expect(gate.connects).toEqual([]);
      expect(chats).toEqual([]);
      // Nothing in the column is lime, Connect and ask included.
      await expect(setup.locator('.bg-primary, [data-slot="button-key"]')).toHaveCount(0);

      // Connect and ask: the key is checked, the column becomes Ask, and the
      // question goes out as its first conversation, answered and saved.
      const saved = turnSaved(page);
      await submit.click();
      const conversation = column.locator('[data-ask-conversation]');
      await expect(conversation.locator('[data-message-role="user"]')).toContainText(question);
      await expect(conversation.locator('[data-message-role="assistant"]')).toContainText(word);
      expect((await saved).ok()).toBe(true);
      await expect(setup).toBeHidden();
      expect(gate.connects).toEqual([{ provider: 'gemini', accepted: true }]);
      expect(chats).toHaveLength(1);
      // Claimed, then sent: the tab no longer holds it, and the key is
      // nowhere in the page.
      expect(await page.evaluate(() => sessionStorage.getItem('dsul-ask-pending'))).toBeNull();
      expect(await page.content()).not.toContain(STUB_GOOD_KEY);

      // A reload asks nothing again. The watcher acts one macrotask after the
      // gate and the planner settle, both in by the time the key is lit, so
      // a short wait past that is the window a second send would land in.
      const answered = gateAnswered(page);
      await reloadApp(page);
      await answered;
      await expect(askButton(page)).toBeVisible();
      await page.waitForTimeout(500);
      expect(chats).toHaveLength(1);
      expect(saves).toHaveLength(1);
    } finally {
      await cleanupConversations(page, token);
    }
  });

  test('Ctrl+K: Set up AI leads the launcher’s actions and opens the setup column', async ({
    page,
  }) => {
    const gate = await signInWith(page);
    const setup = rail(page).locator('[data-ask-setup]');

    await page.keyboard.press('ControlOrMeta+k');
    await expect(launcherInput(page)).toBeFocused();
    // First in Actions, above Add task, so Enter at rest would open it too.
    const door = launcherPanel(page).locator('[data-command-id="ai.setup"]');
    await expect(door).toHaveCount(1);
    await expect(door).toContainText('Set up AI');
    await expect(door).toHaveAttribute('data-selected', 'true');
    const add = launcherPanel(page).getByTestId('omnibar-add-row');
    await expect(add).toBeVisible();
    expect((await door.boundingBox())!.y).toBeLessThan((await add.boundingBox())!.y);
    await expect(launcherPanel(page).locator('[data-command-id="ai.fix"]')).toHaveCount(0);

    await door.click();
    await expect(page.getByTestId('omni-launcher')).toHaveCount(0);
    await expect(setup).toBeVisible();
    await expect(setup).toHaveAttribute('data-ask-setup', 'invite');
    await expect(unlitKey(page)).toBeHidden();
    // Opened only: nothing kept, so no question block, and nothing sent.
    await expect(setup.getByTestId('connect-key-card')).toBeVisible();
    await expect(setup.getByTestId('setup-question')).toHaveCount(0);
    expect(gate.connects).toEqual([]);
  });
});
