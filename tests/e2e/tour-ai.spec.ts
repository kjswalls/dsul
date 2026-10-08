import { test, expect, type Locator, type Page } from '@playwright/test';
import { gateAnswered, rail, stubAIGate, unlitKey, type GateStub } from './helpers/ai';

/**
 * The tour's last card while nothing is connected (AI setup PR 6,
 * components/onboarding/onboarding-tour.tsx): step 4 lights the unlit key on
 * the desktop and the dock's mode card on the phone, says what AI could do
 * with two things to ask built from the planner, and ends three ways. What
 * this pins that tests/unit/onboarding-tour-ask.test.tsx cannot: the real
 * shell under the card, where the card lands against the cutout, Tab in a
 * real browser, and what each exit leaves on screen.
 *
 * THE TOUR ON AN ACCOUNT THAT HAS ONBOARDED. global-setup.ts marks the shared
 * e2e user onboarded and every other spec relies on it, so this file never
 * writes that row. The one read that puts the tour up (lib/user-profile.ts
 * `isOnboardingComplete`, `select=onboarding_completed`) answers "not yet" for
 * this page alone, and the completion write each exit makes is answered here
 * and never sent. The gate is stubbed statefully (helpers/ai.ts `stubAIGate`),
 * so No AI, thanks writes nothing to the account either, and step 2 is
 * skipped, so no task is added.
 *
 * No gotoApp, reloadApp or waitForAppReady while the tour should be up: their
 * readiness check waits for exactly this scrim to go (helpers/app.ts). The load
 * is awaited here instead, on the planner's data, the gate's answer and step
 * 1's heading.
 *
 * Every control on the last card is found inside the card. Behind the scrim
 * the unlit key is a button named "Set up AI" too.
 */

const DONE_TITLE = "You're all set. One thing at a time.";
const AI_OFF = 'AI is off. dsul won’t bring it up again.';
const PHONE_LINE = 'Later, it waits under the mode button.';
const PHONE_LATER = 'Set up AI waits under the mode button whenever you want it.';

/** The tour's root, on every step: the same classes helpers/app.ts waits on. */
function tourRoot(page: Page): Locator {
  return page.locator('div.fixed.inset-0.z-\\[100\\]');
}

/**
 * The spotlight's cutout: the one element in the tour drawn with the scrim as
 * its giant shadow (SpotlightOverlay). There is none while the step has no
 * target it could measure; the plain scrim is drawn instead.
 */
function cutout(page: Page): Locator {
  return tourRoot(page).locator('div[style*="9999px"]');
}

/** `inner` lies wholly inside `outer`, give or take a pixel of rounding. */
async function expectInside(inner: Locator, outer: Locator): Promise<void> {
  await expect(async () => {
    const i = await inner.boundingBox();
    const o = await outer.boundingBox();
    expect(i).not.toBeNull();
    expect(o).not.toBeNull();
    expect(i!.x).toBeGreaterThanOrEqual(o!.x - 1);
    expect(i!.y).toBeGreaterThanOrEqual(o!.y - 1);
    expect(i!.x + i!.width).toBeLessThanOrEqual(o!.x + o!.width + 1);
    expect(i!.y + i!.height).toBeLessThanOrEqual(o!.y + o!.height + 1);
  }).toPass({ timeout: 5_000 });
}

/** A sonner toast by its title. */
function toast(page: Page, title: string): Locator {
  return page.locator('[data-sonner-toast]').filter({ hasText: title });
}

/**
 * Load the app with the tour up and the gate offering setup.
 *
 * `completions` lists every `onboarding_completed` value the app tried to
 * write, in order. All of them are answered here, so whatever the tour sends
 * never reaches the shared row; an exit that ends the tour properly sends
 * exactly one `true`.
 */
async function openTour(page: Page): Promise<{ gate: GateStub; completions: () => unknown[] }> {
  const completions: unknown[] = [];
  await page.route(
    (url) => url.pathname === '/rest/v1/user_settings',
    async (route) => {
      const req = route.request();
      // Cross-origin from the app, so the answer carries what the browser's
      // CORS check wants. Playwright answers the preflight itself.
      const headers = {
        'Access-Control-Allow-Origin': (await req.headerValue('origin')) ?? '*',
        'Access-Control-Allow-Credentials': 'true',
      };
      if (
        req.method() === 'GET' &&
        new URL(req.url()).searchParams.get('select') === 'onboarding_completed'
      ) {
        // An array: maybeSingle() reads a GET as rows and takes the one.
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers,
          body: JSON.stringify([{ onboarding_completed: false }]),
        });
      }
      let body: unknown = null;
      try {
        body = req.method() === 'GET' ? null : req.postDataJSON();
      } catch {
        body = null;
      }
      if (body && typeof body === 'object' && 'onboarding_completed' in body) {
        completions.push((body as { onboarding_completed: unknown }).onboarding_completed);
        return route.fulfill({ status: 201, headers, body: '' });
      }
      return route.fallback();
    }
  );
  const gate = await stubAIGate(page);
  const answered = gateAnswered(page);
  await page.goto('/');
  await expect(page.getByTestId('view-root').first()).toHaveAttribute('data-loaded', 'true', {
    timeout: 20_000,
  });
  await answered;
  await expect(page.getByRole('heading', { name: 'Welcome to dsul ⚡' })).toBeVisible({
    timeout: 20_000,
  });
  return { gate, completions: () => [...completions] };
}

/**
 * Steps 1 to 3 as a person clicks them, Skip at step 2, then the last card.
 * Step 3's last card reads "Next →" only while the gate invites ("Got it →"
 * ends the tour when it cannot say), so a gate that never answered fails here,
 * by name, rather than at a missing card.
 */
async function toTheLastCard(page: Page, o: { phone: boolean }): Promise<Locator> {
  const tour = tourRoot(page);
  await tour.getByRole('button', { name: "Let's go" }).click();
  await tour.getByRole('button', { name: 'Skip', exact: true }).click();

  const cards = o.phone
    ? ['Your tasks live here', 'Plan your day']
    : ['Your tasks & habits', 'Plan your day', 'Your dock'];
  for (const [i, title] of cards.entries()) {
    await expect(tour.getByText(title, { exact: true })).toBeVisible();
    const last = i === cards.length - 1;
    const next = tour.getByRole('button', { name: last ? 'Next →' : 'Next', exact: true });
    await expect(next, last ? 'step 3 ends the tour: did the gate answer?' : undefined).toBeVisible();
    await next.click();
  }

  const card = page.getByTestId('tour-ai-card');
  await expect(card).toHaveAttribute('data-tour-ai', 'invite');
  await expect(page.getByRole('dialog', { name: 'AI, if you want it' })).toBeVisible();
  await expect(card).toContainText(
    'AI can plan the day with you, break big tasks into steps, and answer questions about your plan. You always decide.'
  );
  // Two things to ask, from the real planner and hour, in the grey well.
  const previews = card.getByTestId('tour-previews');
  await expect(previews).toContainText('What you could ask now');
  await expect(previews.locator('li[data-preview]')).toHaveCount(2);
  await expect(previews).toContainText(
    'Built from your planner. Each becomes one click once AI is connected.'
  );
  // Three ways out and Back; nothing that finishes as a default.
  for (const name of ['Set up AI', 'Not now', 'No AI, thanks', 'Back']) {
    await expect(card.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(card.getByRole('button', { name: /Got it|Settings|^Next/ })).toHaveCount(0);
  return card;
}

test.describe('The tour’s last card, nothing connected', () => {
  test('lights the unlit key, keeps Tab on the card, and Set up AI opens the setup column with no toast', async ({
    page,
  }) => {
    const { gate, completions } = await openTour(page);
    const card = await toTheLastCard(page, { phone: false });
    const key = unlitKey(page);
    const setup = rail(page).locator('[data-ask-setup]');

    // Arriving puts focus on the title. Tab moves between the card's own
    // buttons and wraps, never into the page behind the scrim.
    const setUp = card.getByRole('button', { name: 'Set up AI', exact: true });
    await expect(card.getByRole('heading', { name: 'AI, if you want it' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(setUp).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(card.getByRole('button', { name: 'Back', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(setUp).toBeFocused();
    await expect(card.getByText(PHONE_LINE)).toHaveCount(0);

    // The spotlight is on the key, and the card hangs under it, right edges
    // together (F01).
    await expect(key).toHaveAttribute('data-tour', 'ask-key');
    await expect(cutout(page)).toHaveCount(1);
    await expectInside(key, cutout(page));
    await expect(async () => {
      const k = await key.boundingBox();
      const c = await card.boundingBox();
      expect(k, 'the key is not on screen').not.toBeNull();
      expect(c).not.toBeNull();
      expect(c!.y).toBeGreaterThanOrEqual(k!.y + k!.height);
      expect(Math.abs(c!.x + c!.width - (k!.x + k!.width))).toBeLessThanOrEqual(16);
    }).toPass({ timeout: 5_000 });

    // The cutout is sealed: a click on the key lands on the scrim, and setup
    // does not open under the tour.
    const k = (await key.boundingBox())!;
    await page.mouse.click(k.x + k.width / 2, k.y + k.height / 2);
    await expect(setup).toHaveCount(0);
    await expect(card).toBeVisible();

    // Set up AI: the tour goes, the setup column opens, and nothing toasts.
    await setUp.click();
    await expect(tourRoot(page)).toHaveCount(0);
    await expect(setup).toBeVisible();
    await expect(setup).toHaveAttribute('data-ask-setup', 'invite');
    await expect.poll(completions).toEqual([true]);
    await expect(toast(page, DONE_TITLE)).toHaveCount(0);
    expect(gate.patches).toEqual([]);
  });

  test('No AI, thanks ends the tour on the undo strip, with no toast', async ({ page }) => {
    const { gate, completions } = await openTour(page);
    const card = await toTheLastCard(page, { phone: false });

    await card.getByRole('button', { name: 'No AI, thanks', exact: true }).click();

    // Said in the strip with focus on its Undo, the key put away, and the
    // account's answer sent (to the stub, never the shared row).
    await expect(tourRoot(page)).toHaveCount(0);
    const strip = page.getByTestId('undo-strip');
    await expect(strip).toContainText(AI_OFF);
    await expect(strip.getByRole('button', { name: 'Undo' })).toBeFocused();
    await expect(page.locator('[data-ask-opener]')).toHaveCount(0);
    await expect.poll(() => gate.patches).toEqual([{ hidden: true }]);
    await expect.poll(completions).toEqual([true]);
    await expect(toast(page, DONE_TITLE)).toHaveCount(0);
  });
});

test.describe('The tour’s last card on the phone @mobile', () => {
  test('lights the mode card, says where setup waits, and Not now says it again', async ({
    page,
  }) => {
    const { gate, completions } = await openTour(page);
    const card = await toTheLastCard(page, { phone: true });
    const mode = page.getByTestId('mobile-mode-card');

    // On Today, with the mode button its last line names lit, and the card
    // above the dock.
    await expect(card).toContainText(PHONE_LINE);
    await expect(mode).toHaveAttribute('data-surface', 'today');
    await expect(mode).toHaveAttribute('data-tour', 'mode-card');
    await expect(cutout(page)).toHaveCount(1);
    await expectInside(mode, cutout(page));
    await expect(async () => {
      const m = await mode.boundingBox();
      const c = await card.boundingBox();
      expect(m).not.toBeNull();
      expect(c).not.toBeNull();
      expect(c!.y + c!.height).toBeLessThanOrEqual(m!.y);
    }).toPass({ timeout: 5_000 });

    await card.getByRole('button', { name: 'Not now', exact: true }).click();

    // The tour goes to Braindump, and the toast says where setup waits.
    await expect(tourRoot(page)).toHaveCount(0);
    const done = toast(page, DONE_TITLE);
    await expect(done).toBeVisible();
    await expect(done.locator('[data-description]')).toHaveText(PHONE_LATER);
    await expect(mode).toHaveAttribute('data-surface', 'braindump');
    await expect.poll(completions).toEqual([true]);
    expect(gate.patches).toEqual([]);
  });

  test('Set up AI opens the setup page on the Ask tab, with no toast', async ({ page }) => {
    const { gate, completions } = await openTour(page);
    const card = await toTheLastCard(page, { phone: true });

    await card.getByRole('button', { name: 'Set up AI', exact: true }).click();

    await expect(tourRoot(page)).toHaveCount(0);
    await expect(page.locator('[data-setup-tab="invite"]')).toBeVisible();
    await expect(page.getByTestId('mobile-mode-card')).toHaveAttribute('data-surface', 'chat');
    await expect.poll(completions).toEqual([true]);
    await expect(toast(page, DONE_TITLE)).toHaveCount(0);
    expect(gate.patches).toEqual([]);
  });
});
