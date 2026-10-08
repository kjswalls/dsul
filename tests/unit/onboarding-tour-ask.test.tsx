import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The tour's words about AI (components/onboarding/onboarding-tour.tsx).
 *
 * Ask starts closed (sidebar-store ASK_OPEN_DEFAULT). With something
 * answering, the tour shows it for desktop sub-step C and puts it back when it
 * ends, so step 4 is where a new user learns the ways back to it:
 *
 *  - 3C, with AI: "Ask", what it is for, and the shell asked to show it.
 *  - 4, with AI on the desktop: the Ask button (once Ask is closed: it hides
 *    while Ask shows, as it does beside this card), the chord AS BOUND
 *    (through chordLabel, never typed; a rebinding reads right) and `?` in
 *    the dock. On the phone: the bar below, with no chord to press.
 *  - The phone's mode step names the third surface "Ask".
 *
 * With nothing connected and the gate inviting, 3C is the dock, and step 4 is
 * the invitation (F01, F02): the unlit key spotlit (the mode card on the
 * phone), what AI could do, two previews from the real planner and hour that
 * name the task step 2 added, and three ways out. Set up AI opens setup with
 * no toast; Not now ends with a toast that says where it waits; No AI, thanks
 * says so in the undo strip. No Settings button anywhere. A replay with AI
 * off says it stays off. Anything else the gate says (unknown, unavailable, a
 * key that needs fixing) has no step 4: 3's last card reads "Got it →".
 *
 * Step 4 is a dialog: its title takes focus, and Tab moves among its own
 * buttons, never finishing the tour or walking into the page behind.
 */

vi.mock('@/lib/user-profile', () => ({ setOnboardingComplete: vi.fn(async () => {}) }));
vi.mock('canvas-confetti', () => ({ default: vi.fn() }));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
const toastMock = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), message: vi.fn(), dismiss: vi.fn(), custom: vi.fn() })
);
vi.mock('sonner', () => ({ toast: toastMock }));
const chooseNoAI = vi.hoisted(() => vi.fn<(o?: { phone?: boolean }) => Promise<void>>(async () => {}));
vi.mock('@/lib/no-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/no-ai')>()),
  chooseNoAI,
}));

import {
  OnboardingTour,
  tourAIStep,
  tourSpotlightSelector,
  TOUR_AI_BODY,
  TOUR_AI_CAPTION,
  TOUR_AI_OFF_BODY,
  TOUR_AI_PHONE_LINE,
  TOUR_DONE_TITLE,
  TOUR_LATER_DESKTOP,
  TOUR_LATER_PHONE,
  TOUR_REPLAY_TIP,
} from '@/components/onboarding/onboarding-tour';
import { chordLabel } from '@/lib/commands/keys';
import { DEFAULT_SHORTCUTS, useKeyboardShortcutsStore } from '@/lib/keyboard-shortcuts-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { projectItems, usePlannerStore } from '@/lib/planner-store';
import { railModeNow, tourHideAsk, tourShowAsk, useRailStore } from '@/lib/rail-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { setOnboardingComplete } from '@/lib/user-profile';
import {
  seedAI,
  capsFor,
  AI_HIDDEN,
  CONNECTED_MODEL,
  KEY_TURNED_DOWN,
  NOTHING_CONNECTED,
  OPENCLAW_PLUGIN,
  type SeedAI,
} from './helpers/ai-fixtures';

const DEFAULT_ASK_KEYS = DEFAULT_SHORTCUTS.find((b) => b.id === 'toggle_right_sidebar')!.keys;
/** 19:30 UTC: evening, so the openers look back at today and ahead to tomorrow (the frames' pair). */
const EVENING = Date.parse('2026-10-07T19:30:00.000Z');
/** 09:00 UTC: morning, so they plan today. */
const MORNING = Date.parse('2026-10-07T09:00:00.000Z');

const completeMock = vi.mocked(setOnboardingComplete);

let cleanupAI: (() => void) | null = null;
const width = window.innerWidth;

function setWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: px });
}

/** Re-seed the gate mid-test, as a status read landing would. */
function reseed(seed?: SeedAI) {
  act(() => {
    cleanupAI?.();
    cleanupAI = seedAI(seed);
  });
}

/**
 * The tour as AppShell mounts it: Ask shown and put back through the tour
 * pair (a summon that never persists, then a park), spied on so the calls can
 * be counted. The tab spy writes nothing: only what the tour's own exits write
 * reaches the stores.
 */
function renderTour(seed?: SeedAI) {
  cleanupAI = seedAI(seed);
  const onExpandChat = vi.fn(() => tourShowAsk());
  const onCollapseChat = vi.fn(() => tourHideAsk());
  const onSetActiveTab = vi.fn<(tab: string) => void>();
  const onComplete = vi.fn();
  render(
    <OnboardingTour
      userId="u1"
      onComplete={onComplete}
      onExpandChat={onExpandChat}
      onCollapseChat={onCollapseChat}
      onSetActiveTab={onSetActiveTab}
    />
  );
  return { onExpandChat, onCollapseChat, onSetActiveTab, onComplete };
}

/** Welcome → skip the first task → step 3's first card. */
function toStep3() {
  fireEvent.click(screen.getByRole('button', { name: /Let.s go/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
}

const next = () => fireEvent.click(screen.getByRole('button', { name: /^Next/ }));

/** Step 3's cards to step 4: three on the desktop, two on the phone. */
function toStep4(phone = false) {
  toStep3();
  next();
  if (!phone) next();
  next();
}

const card = () => screen.getByTestId('tour-ai-card');
const inCard = (name: string | RegExp) => within(card()).getByRole('button', { name });
const tab = (target: Element = document.activeElement ?? document.body, shiftKey = false) =>
  fireEvent.keyDown(target, { key: 'Tab', shiftKey });

/** The tour's last await settled: AppShell would unmount it now. */
async function finished(onComplete: ReturnType<typeof vi.fn>) {
  await vi.waitFor(() => expect(onComplete).toHaveBeenCalled());
  expect(completeMock).toHaveBeenCalledTimes(1);
  expect(completeMock).toHaveBeenCalledWith('u1');
  expect(completeMock.mock.invocationCallOrder[0]).toBeLessThan(onComplete.mock.invocationCallOrder[0]);
}

beforeEach(() => {
  setWidth(1280);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EVENING);
  usePlannerStore.setState({ ...projectItems([]), userTimezone: 'UTC' });
  completeMock.mockClear();
  completeMock.mockImplementation(async () => {});
  toastMock.success.mockClear();
  toastMock.error.mockClear();
  chooseNoAI.mockClear();
});

afterEach(() => {
  cleanup();
  cleanupAI?.();
  cleanupAI = null;
  vi.useRealTimers();
  useKeyboardShortcutsStore.setState({ overrides: {} });
  useRailStore.setState({ summoned: false });
  useMobileNavStore.setState({ activeTab: 'today' });
  usePlannerStore.setState({ ...projectItems([]), userTimezone: null });
  setWidth(width);
});

describe('the desktop tour, with AI', () => {
  it('shows Ask for 3C, then names every way back to it at step 4', () => {
    const { onExpandChat } = renderTour(CONNECTED_MODEL);
    toStep3();
    next(); // B
    next(); // C
    expect(screen.getByText('Ask', { selector: 'p' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Ask anything here, or open an item to talk about it. It knows your tasks, habits and projects.'
      )
    ).toBeInTheDocument();
    expect(onExpandChat).toHaveBeenCalled();

    next(); // 4
    expect(screen.getByRole('dialog', { name: 'Your AI is ready' })).toBe(card());
    expect(card()).toHaveAttribute('data-tour-ai', 'ready');
    // Nothing to set up: the card's one way out is "Got it".
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    expect(screen.getByRole('button', { name: /Got it/ })).toBeInTheDocument();
    expect(chordLabel(DEFAULT_ASK_KEYS, false)).toBe('Ctrl+J');
    expect(
      screen.getByText(
        `When Ask is closed, open it with the Ask button at the end of the date row or ${chordLabel(DEFAULT_ASK_KEYS, false)}, or type ? in the dock, to ask about your day.`
      )
    ).toBeInTheDocument();
    // The ⌘↵ / Ctrl↵ hint is gone: ? in the dock is the way to ask from there.
    expect(screen.queryByText(/Ctrl↵|⌘↵/)).toBeNull();
  });

  it('names the chord as the user has it bound', () => {
    useKeyboardShortcutsStore.setState({ overrides: { toggle_right_sidebar: ['meta', 'shift', 'k'] } });
    renderTour(CONNECTED_MODEL);
    toStep3();
    next();
    next();
    next();
    expect(
      screen.getByText(
        'When Ask is closed, open it with the Ask button at the end of the date row or Ctrl+Shift+K, or type ? in the dock, to ask about your day.'
      )
    ).toBeInTheDocument();
  });

  it('ends on Got it with the replay tip, Ask put back', async () => {
    const { onCollapseChat, onComplete } = renderTour(CONNECTED_MODEL);
    toStep4();
    expect(useRailStore.getState().summoned).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Got it →' }));
    expect(screen.queryByTestId('tour-ai-card')).toBeNull();
    expect(onCollapseChat).toHaveBeenCalled();
    expect(useRailStore.getState().summoned).toBe(false);
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledWith(TOUR_DONE_TITLE, { description: TOUR_REPLAY_TIP, duration: 5000 });
    expect(TOUR_REPLAY_TIP).toBe('Tip: replay this tour anytime from Settings.');
    await finished(onComplete);
  });
});

describe('the desktop tour, with nothing connected: the invitation', () => {
  it('points 3C at the dock, then invites, with no word of Ask and no Settings', () => {
    const { onExpandChat } = renderTour(NOTHING_CONNECTED);
    toStep3();
    next();
    next();
    expect(screen.getByText('Your dock')).toBeInTheDocument();
    expect(onExpandChat).not.toHaveBeenCalled();
    // There is a step 4 to go to.
    expect(screen.getByRole('button', { name: 'Next →' })).toBeInTheDocument();
    next();

    const dialog = screen.getByRole('dialog', { name: 'AI, if you want it' });
    expect(dialog).toBe(card());
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('data-tour-ai', 'invite');
    expect(dialog).toHaveAccessibleDescription(TOUR_AI_BODY);
    expect(TOUR_AI_BODY).toBe(
      'AI can plan the day with you, break big tasks into steps, and answer questions about your plan. You always decide.'
    );
    expect(screen.getByText(TOUR_AI_BODY)).toBeInTheDocument();

    // The well: the heading (uppercased by CSS), the two evening rows with no
    // example (step 2 was skipped), and the caption.
    const well = screen.getByTestId('tour-previews');
    expect(within(well).getByRole('heading', { name: 'What you could ask now' })).toBeInTheDocument();
    expect(well).toHaveAccessibleName('What you could ask now');
    const rows = well.querySelectorAll('li[data-preview]');
    expect([...rows].map((r) => r.getAttribute('data-preview'))).toEqual(['plan-tomorrow', 'review']);
    expect(rows[0]).toHaveTextContent('“Plan tomorrow”Drafts tomorrow from your braindump.');
    expect(rows[1]).toHaveTextContent("“Review today”Looks back at today with you, and what you'd carry into tomorrow.");
    expect(within(well).getByText(TOUR_AI_CAPTION)).toBeInTheDocument();
    expect(TOUR_AI_CAPTION).toBe('Built from your planner. Each becomes one click once AI is connected.');
    // Its own handles, never the setup column's.
    expect(screen.queryByTestId('setup-previews')).toBeNull();
    expect(document.querySelector('[data-setup-previews-heading]')).toBeNull();

    // Three ways out and Back, nothing else.
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Set up AI',
      'Not now',
      'No AI, thanks',
      'Back',
    ]);
    expect(screen.queryByRole('button', { name: /Got it/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    // The phone's line is the phone's.
    expect(screen.queryByText(TOUR_AI_PHONE_LINE)).toBeNull();
    expect(screen.queryByText(/Ask button|Ctrl\+J/)).toBeNull();
  });

  it('draws the well in the sunken grey, not the card it sits on', () => {
    renderTour(NOTHING_CONNECTED);
    toStep4();
    const well = screen.getByTestId('tour-previews');
    expect(well).toHaveClass('bg-surface-3');
    expect(well).not.toHaveClass('bg-surface-2');
    // On grey, muted ink reads at about 2.6:1: the words take secondary ink
    // (F01), and the glyphs the deeper amber.
    for (const row of well.querySelectorAll('li[data-preview]')) {
      const [, description] = row.querySelectorAll('p');
      expect(description).toHaveClass('text-secondary-foreground');
      expect(description).not.toHaveClass('text-muted-foreground');
      expect(row.querySelector('svg')).toHaveClass('text-sunrise-glyph');
    }
    expect(within(well).getByText(TOUR_AI_CAPTION)).toHaveClass('text-sm', 'text-secondary-foreground');
  });

  it('caps the card itself, so its words scroll and its buttons stay', () => {
    renderTour(NOTHING_CONNECTED);
    toStep4();
    // No key is rendered here, so nothing is measured: the card's static place.
    expect(card().style.maxHeight).toBe('calc(100vh - 6rem)');
    expect(card()).toHaveClass('flex', 'flex-col', 'w-80');
    const content = card().querySelector('[data-tour-ai-content]');
    expect(content).toHaveClass('min-h-0', 'overflow-y-auto');
    expect(content).toContainElement(screen.getByRole('heading', { name: 'AI, if you want it' }));
    expect(content).toContainElement(screen.getByTestId('tour-previews'));
    // The buttons are outside the scrolling part.
    expect(content).not.toContainElement(inCard('Set up AI'));
    expect(inCard('Set up AI').closest('.shrink-0')).not.toBeNull();
    // Nothing else holds a cap.
    expect([...document.querySelectorAll<HTMLElement>('[style]')].filter((e) => e.style.maxHeight)).toEqual([card()]);
    const wrapper = card().parentElement!;
    expect(wrapper).toHaveClass('right-6', 'top-20');
  });

  describe('under the key', () => {
    let key: HTMLButtonElement;
    beforeEach(() => {
      key = document.createElement('button');
      key.setAttribute('data-tour', 'ask-key');
      document.body.appendChild(key);
    });
    afterEach(() => key.remove());

    it('treats a key measured at 0x0 (its slot hidden) as no key: a full scrim and the static place', () => {
      renderTour(NOTHING_CONNECTED);
      toStep4();
      expect(document.querySelector('div[style*="9999px"]')).toBeNull();
      expect(card().parentElement).toHaveClass('right-6', 'top-20');
      expect(card().style.maxHeight).toBe('calc(100vh - 6rem)');
    });

    it("sits under the key, right edges aligned, capped at the room below", () => {
      key.getBoundingClientRect = () =>
        ({ left: 1100, right: 1240, top: 12, bottom: 52, width: 140, height: 40, x: 1100, y: 12 }) as DOMRect;
      renderTour(NOTHING_CONNECTED);
      toStep4();
      expect(document.querySelector('div[style*="9999px"]')).not.toBeNull();
      const wrapper = card().parentElement!;
      expect(wrapper).not.toHaveClass('right-6');
      // Anchored by its right edge (the cutout's: 1240 + 8), never a left
      // worked out from a width a larger font would change.
      expect(wrapper.style.right).toBe(`${window.innerWidth - 1248}px`);
      expect(wrapper.style.left).toBe('');
      expect(wrapper.style.top).toBe('72px');
      expect(card().style.maxHeight).toBe(`${window.innerHeight - 72 - 16}px`);
      expect(card()).toHaveClass('max-w-[calc(100vw-2rem)]');
    });
  });

  it('never fades the lime button or dot through the wrapper, and keeps one tour root', () => {
    renderTour(NOTHING_CONNECTED);
    toStep4();
    const wrapper = card().parentElement!;
    expect(wrapper.className).toMatch(/zoom-in-95/);
    expect(wrapper.className).not.toMatch(/fade-in/);
    // tests/e2e/helpers/app.ts waits on exactly these classes to know the tour is gone.
    expect(document.querySelectorAll('div.fixed.inset-0.z-\\[100\\]')).toHaveLength(1);
  });

  it('names the task step 2 added', async () => {
    renderTour(NOTHING_CONNECTED);
    fireEvent.click(screen.getByRole('button', { name: /Let.s go/ }));
    fireEvent.change(screen.getByPlaceholderText(/Walk the dog/), { target: { value: 'Call the dentist' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add task →' }));
    await screen.findByText('Your tasks & habits', undefined, { timeout: 2000 });
    next();
    next();
    next();
    expect(screen.getByText('Drafts tomorrow from your braindump, like “Call the dentist”.')).toBeInTheDocument();
  });

  it('names nothing when the task was typed and then skipped', () => {
    renderTour(NOTHING_CONNECTED);
    fireEvent.click(screen.getByRole('button', { name: /Let.s go/ }));
    fireEvent.change(screen.getByPlaceholderText(/Walk the dog/), { target: { value: 'Call the dentist' } });
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    next();
    next();
    next();
    expect(screen.getByText('Drafts tomorrow from your braindump.')).toBeInTheDocument();
    expect(screen.queryByText(/Call the dentist/)).toBeNull();
    expect(usePlannerStore.getState().items).toHaveLength(0);
  });

  it("offers the morning's pair before 16:00", () => {
    vi.setSystemTime(MORNING);
    renderTour(NOTHING_CONNECTED);
    toStep4();
    const rows = screen.getByTestId('tour-previews').querySelectorAll('li[data-preview]');
    expect([...rows].map((r) => r.getAttribute('data-preview'))).toEqual(['plan', 'reflect']);
    expect(rows[0]).toHaveTextContent('“Plan my day”Drafts today from your braindump.');
  });

  it('Set up AI: the tour goes and the setup column opens, for this session only, with no toast', async () => {
    const askOpen = useSidebarStore.getState().askOpen;
    const { onCollapseChat, onSetActiveTab, onComplete } = renderTour(NOTHING_CONNECTED);
    toStep4();
    // Something summoned the rail while the card showed: the park is for this.
    act(() => tourShowAsk());
    onCollapseChat.mockClear();
    fireEvent.click(inCard('Set up AI'));
    expect(screen.queryByTestId('tour-ai-card')).toBeNull();
    // Ask was put back first (a park clears `summoned`), and setup's summon
    // came after it, so the rail ends summoned in setup.
    expect(onCollapseChat).toHaveBeenCalledTimes(1);
    expect(useRailStore.getState().summoned).toBe(true);
    expect(railModeNow()).toBe('setup');
    expect(useSidebarStore.getState().askOpen).toBe(askOpen);
    expect(onSetActiveTab).not.toHaveBeenCalled();
    await finished(onComplete);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('Not now: the tour goes with a toast that says where AI waits', async () => {
    const { onSetActiveTab, onComplete } = renderTour(NOTHING_CONNECTED);
    toStep4();
    fireEvent.click(inCard('Not now'));
    expect(screen.queryByTestId('tour-ai-card')).toBeNull();
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledWith("You're all set. One thing at a time.", {
      description: 'Set up AI waits at the top right whenever you want it.',
      duration: 5000,
    });
    expect(TOUR_LATER_DESKTOP).toBe('Set up AI waits at the top right whenever you want it.');
    expect(useRailStore.getState().summoned).toBe(false);
    expect(onSetActiveTab).toHaveBeenLastCalledWith('braindump');
    await finished(onComplete);
    expect(chooseNoAI).not.toHaveBeenCalled();
  });

  it('No AI, thanks: the account says no, the undo strip says so, and no toast', async () => {
    const { onComplete } = renderTour(NOTHING_CONNECTED);
    toStep4();
    fireEvent.click(inCard('No AI, thanks'));
    expect(screen.queryByTestId('tour-ai-card')).toBeNull();
    expect(chooseNoAI).toHaveBeenCalledTimes(1);
    expect(chooseNoAI).toHaveBeenCalledWith({});
    await finished(onComplete);
    // Said before the one await, so the card never redraws as "AI stays off" first.
    expect(chooseNoAI.mock.invocationCallOrder[0]).toBeLessThan(completeMock.mock.invocationCallOrder[0]);
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(useRailStore.getState().summoned).toBe(false);
  });

  it('Back goes to the dock card', () => {
    renderTour(NOTHING_CONNECTED);
    toStep4();
    fireEvent.click(inCard('Back'));
    expect(screen.queryByTestId('tour-ai-card')).toBeNull();
    expect(screen.getByText('Your dock')).toBeInTheDocument();
  });

  it('focuses the title on arrival, and Tab moves among its buttons without ending the tour', () => {
    const { onComplete } = renderTour(NOTHING_CONNECTED);
    toStep4();
    const title = screen.getByRole('heading', { name: 'AI, if you want it' });
    expect(document.activeElement).toBe(title);

    expect(tab()).toBe(false); // defaultPrevented: focus stays in the card
    expect(document.activeElement).toBe(inCard('Set up AI'));
    tab();
    expect(document.activeElement).toBe(inCard('Not now'));
    tab();
    expect(document.activeElement).toBe(inCard('No AI, thanks'));
    tab();
    expect(document.activeElement).toBe(inCard('Back'));
    tab(); // wraps
    expect(document.activeElement).toBe(inCard('Set up AI'));
    tab(undefined, true); // and back the other way
    expect(document.activeElement).toBe(inCard('Back'));
    tab(undefined, true);
    expect(document.activeElement).toBe(inCard('No AI, thanks'));

    // From the title, Shift+Tab goes to the last button.
    act(() => title.focus());
    tab(undefined, true);
    expect(document.activeElement).toBe(inCard('Back'));
    // From anywhere outside the card, Tab comes back to its first.
    act(() => (document.activeElement as HTMLElement).blur());
    tab(document.body);
    expect(document.activeElement).toBe(inCard('Set up AI'));

    expect(card()).toBeInTheDocument();
    expect(completeMock).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('gives Tab back to the page once the tour has gone', async () => {
    let release: () => void = () => {};
    completeMock.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const { onComplete } = renderTour(NOTHING_CONNECTED);
    toStep4();
    fireEvent.click(inCard('Set up AI'));
    // The write is still in flight and the shell has not unmounted the tour.
    expect(onComplete).not.toHaveBeenCalled();
    expect(tab(document.body)).toBe(true);
    act(() => release());
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it('keeps the card it arrived with while the gate reads unknown for a moment', () => {
    renderTour(NOTHING_CONNECTED);
    toStep4();
    reseed(); // a re-read in flight: unknown
    expect(card()).toHaveAttribute('data-tour-ai', 'invite');
    expect(screen.getByRole('dialog', { name: 'AI, if you want it' })).toBeInTheDocument();
    expect(completeMock).not.toHaveBeenCalled();
    // A real answer redraws it: connected in another tab.
    reseed(CONNECTED_MODEL);
    expect(screen.getByRole('dialog', { name: 'Your AI is ready' })).toBe(card());
    expect(card()).toHaveAttribute('data-tour-ai', 'ready');
  });

  it('Set up AI with the gate no longer offering it: nothing opens, Braindump, no toast', async () => {
    const { onSetActiveTab, onComplete } = renderTour(NOTHING_CONNECTED);
    toStep4();
    reseed(); // unknown: the card holds, but setup is not on offer
    expect(card()).toHaveAttribute('data-tour-ai', 'invite');
    fireEvent.click(inCard('Set up AI'));
    expect(screen.queryByTestId('tour-ai-card')).toBeNull();
    expect(useRailStore.getState().summoned).toBe(false);
    expect(onSetActiveTab).toHaveBeenLastCalledWith('braindump');
    await finished(onComplete);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('opens nothing once it has ended, whatever the gate says while the write is in flight', async () => {
    let release: () => void = () => {};
    completeMock.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const { onExpandChat, onComplete } = renderTour();
    toStep3();
    next();
    next();
    fireEvent.click(screen.getByRole('button', { name: 'Got it →' }));
    // Something answers before the shell unmounts the tour.
    reseed(CONNECTED_MODEL);
    expect(onExpandChat).not.toHaveBeenCalled();
    expect(useRailStore.getState().summoned).toBe(false);
    act(() => release());
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it("names the launcher's chord as the user has it bound", () => {
    renderTour(NOTHING_CONNECTED);
    toStep3();
    next();
    next();
    expect(screen.getByText('Add, search and run commands from here. Ctrl+K works anywhere.')).toBeInTheDocument();

    cleanup();
    cleanupAI?.();
    useKeyboardShortcutsStore.setState({ overrides: { system_search: ['meta', 'shift', 'p'] } });
    renderTour(NOTHING_CONNECTED);
    toStep3();
    next();
    next();
    expect(
      screen.getByText('Add, search and run commands from here. Ctrl+Shift+P works anywhere.')
    ).toBeInTheDocument();
  });
});

describe('the phone tour', () => {
  beforeEach(() => setWidth(390));

  it('names the third surface Ask, and step 4 points at the bar below', () => {
    renderTour(CONNECTED_MODEL);
    toStep3();
    expect(
      screen.getByText('The mode button in the dock is how you move between Braindump, Today and Ask.')
    ).toBeInTheDocument();
    next(); // B
    next(); // 4
    expect(screen.getByText('Type in the bar below to ask about your day.')).toBeInTheDocument();
    expect(screen.queryByText(/Ctrl|⌘|Ask button/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  });

  it('with nothing connected, step 4 invites, and says where it waits later', () => {
    renderTour(NOTHING_CONNECTED);
    toStep4(true);
    expect(screen.getByRole('dialog', { name: 'AI, if you want it' })).toBe(card());
    expect(screen.getByText(TOUR_AI_PHONE_LINE)).toBeInTheDocument();
    expect(TOUR_AI_PHONE_LINE).toBe('Later, it waits under the mode button.');
    // Under the previews, in the part that scrolls.
    expect(card().querySelector('[data-tour-ai-content]')).toContainElement(screen.getByText(TOUR_AI_PHONE_LINE));
    expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Set up AI',
      'Not now',
      'No AI, thanks',
      'Back',
    ]);
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    expect(screen.queryByText(/Ctrl|⌘/)).toBeNull();
    // Full width above the dock, never the desktop's 320px, capped below the
    // top of the screen (past the notch or the desktop app's drag band).
    expect(card()).not.toHaveClass('w-80');
    expect(card().style.maxHeight).toBe(
      'calc(100dvh - var(--toast-bottom, 96px) - max(env(safe-area-inset-top, 0px), env(titlebar-area-height, 0px)) - 16px)'
    );
    expect(card().parentElement!.style.maxHeight).toBe('');
    expect(card().parentElement).toHaveClass('left-4', 'right-4');
    expect(card().parentElement!.className).not.toMatch(/fade-in/);
  });

  it('with no AI, names only Braindump and Today', () => {
    renderTour(NOTHING_CONNECTED);
    toStep3();
    expect(
      screen.getByText('The mode button in the dock is how you move between Braindump and Today.')
    ).toBeInTheDocument();
  });

  it('Set up AI shows the Ask tab, whose page is setup, and summons nothing', async () => {
    const { onSetActiveTab, onComplete } = renderTour(NOTHING_CONNECTED);
    toStep4(true);
    fireEvent.click(inCard('Set up AI'));
    expect(screen.queryByTestId('tour-ai-card')).toBeNull();
    expect(useMobileNavStore.getState().activeTab).toBe('chat');
    expect(useRailStore.getState().summoned).toBe(false);
    // The tour left Today for the step it was on, never Braindump on the way out.
    expect(onSetActiveTab).toHaveBeenLastCalledWith('today');
    await finished(onComplete);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("Not now's toast names the mode button", async () => {
    const { onSetActiveTab, onComplete } = renderTour(NOTHING_CONNECTED);
    toStep4(true);
    fireEvent.click(inCard('Not now'));
    expect(toastMock.success).toHaveBeenCalledWith(TOUR_DONE_TITLE, {
      description: 'Set up AI waits under the mode button whenever you want it.',
      duration: 5000,
    });
    expect(TOUR_LATER_PHONE).toBe('Set up AI waits under the mode button whenever you want it.');
    expect(onSetActiveTab).toHaveBeenLastCalledWith('braindump');
    expect(useMobileNavStore.getState().activeTab).toBe('today');
    expect(useRailStore.getState().summoned).toBe(false);
    await finished(onComplete);
  });

  it('Set up AI with the gate no longer offering it stays off the Ask tab, on Braindump', async () => {
    const { onSetActiveTab, onComplete } = renderTour(NOTHING_CONNECTED);
    toStep4(true);
    reseed();
    fireEvent.click(inCard('Set up AI'));
    expect(useMobileNavStore.getState().activeTab).toBe('today');
    expect(onSetActiveTab).toHaveBeenLastCalledWith('braindump');
    expect(useRailStore.getState().summoned).toBe(false);
    await finished(onComplete);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("No AI, thanks is the phone's, with no toast", async () => {
    const { onComplete } = renderTour(NOTHING_CONNECTED);
    toStep4(true);
    fireEvent.click(inCard('No AI, thanks'));
    expect(chooseNoAI).toHaveBeenCalledWith({ phone: true });
    expect(toastMock.success).not.toHaveBeenCalled();
    await finished(onComplete);
  });
});

describe('a replay with AI off', () => {
  it('says AI stays off, with only Got it, and the replay tip after', async () => {
    const { onComplete } = renderTour(AI_HIDDEN);
    toStep3();
    next();
    next();
    expect(screen.getByText('Your dock')).toBeInTheDocument();
    next();
    expect(screen.getByRole('dialog', { name: 'AI stays off' })).toBe(card());
    expect(card()).toHaveAttribute('data-tour-ai', 'off');
    expect(card()).toHaveAccessibleDescription(TOUR_AI_OFF_BODY);
    expect(screen.getByText('You turned AI off, so dsul won’t bring it up. You can turn it back on in Settings → AI.')).toBeInTheDocument();
    expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Back', 'Got it →']);
    expect(screen.queryByTestId('tour-previews')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'AI stays off' }));
    // Tab stays among its two buttons.
    tab();
    expect(document.activeElement).toBe(inCard('Back'));
    tab();
    expect(document.activeElement).toBe(inCard('Got it →'));
    tab();
    expect(document.activeElement).toBe(inCard('Back'));
    expect(card().parentElement!.className).not.toMatch(/fade-in/);

    fireEvent.click(inCard('Got it →'));
    expect(toastMock.success).toHaveBeenCalledWith(TOUR_DONE_TITLE, { description: TOUR_REPLAY_TIP, duration: 5000 });
    await finished(onComplete);
  });

  it('on the phone too, with no line about the mode button', () => {
    setWidth(390);
    renderTour(AI_HIDDEN);
    toStep4(true);
    expect(screen.getByRole('dialog', { name: 'AI stays off' })).toBeInTheDocument();
    expect(screen.queryByText(TOUR_AI_PHONE_LINE)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set up AI' })).toBeNull();
  });
});

describe('no step 4 while the gate cannot say an invitation is right', () => {
  it.each<[string, SeedAI | undefined]>([
    ['the gate has not answered', undefined],
    ['a saved key needs fixing', KEY_TURNED_DOWN],
    ['AI is not available', { ...NOTHING_CONNECTED, available: false }],
    ['chat is Off on this device', { ...NOTHING_CONNECTED, choice: 'none' }],
    ["the account's answer is unread", { ...NOTHING_CONNECTED, aiHidden: null }],
  ])('%s: the dock card is the last, and Got it ends the tour', async (_label, seed) => {
    const { onComplete } = renderTour(seed);
    toStep3();
    next();
    next();
    expect(screen.getByText('Your dock')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Next/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Got it →' }));
    expect(screen.queryByTestId('tour-ai-card')).toBeNull();
    expect(screen.queryByText('Your dock')).toBeNull();
    expect(toastMock.success).toHaveBeenCalledWith(TOUR_DONE_TITLE, { description: TOUR_REPLAY_TIP, duration: 5000 });
    await finished(onComplete);
  });

  it("on the phone, the second card's Got it ends it", async () => {
    setWidth(390);
    const { onComplete } = renderTour();
    toStep3();
    next(); // B
    fireEvent.click(screen.getByRole('button', { name: 'Got it →' }));
    expect(screen.queryByTestId('tour-ai-card')).toBeNull();
    await finished(onComplete);
  });

  it('ends once however often Tab is pressed while the write is in flight', async () => {
    let release: () => void = () => {};
    completeMock.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const { onComplete } = renderTour();
    toStep3();
    next();
    next();
    expect(screen.getByRole('button', { name: 'Got it →' })).toBeInTheDocument();
    // Tab is still "Next" on step 3: here, the end.
    expect(tab(document.body)).toBe(false);
    expect(tab(document.body)).toBe(true);
    act(() => release());
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('the rules, pure', () => {
  it('reads step 4 off the gate: ready, invite, off, or none at all', () => {
    expect(tourAIStep({ canChat: true, askInvite: false, aiHidden: false })).toBe('ready');
    expect(tourAIStep({ canChat: false, askInvite: true, aiHidden: false })).toBe('invite');
    expect(tourAIStep({ canChat: false, askInvite: false, aiHidden: true })).toBe('off');
    expect(tourAIStep({ canChat: false, askInvite: false, aiHidden: false })).toBeNull();

    expect(tourAIStep(capsFor(CONNECTED_MODEL))).toBe('ready');
    expect(tourAIStep(capsFor(OPENCLAW_PLUGIN))).toBe('ready');
    expect(tourAIStep(capsFor(NOTHING_CONNECTED))).toBe('invite');
    expect(tourAIStep(capsFor(AI_HIDDEN))).toBe('off');
    expect(tourAIStep(capsFor({ ...CONNECTED_MODEL, aiHidden: true }))).toBe('off');
    expect(tourAIStep(capsFor())).toBeNull();
    expect(tourAIStep(capsFor({ phase: 'error' }))).toBeNull();
    expect(tourAIStep(capsFor(KEY_TURNED_DOWN))).toBeNull();
    expect(tourAIStep(capsFor({ ...NOTHING_CONNECTED, available: false }))).toBeNull();
    expect(tourAIStep(capsFor({ ...NOTHING_CONNECTED, choice: 'none' }))).toBeNull();
    expect(tourAIStep(capsFor({ ...NOTHING_CONNECTED, aiHidden: null }))).toBeNull();
    // An OpenClaw agent key answers no chat, and is connected, so nothing invites.
    expect(tourAIStep(capsFor({ ...NOTHING_CONNECTED, openclaw: { agent: true } }))).toBeNull();
  });

  it('spotlights the unlit key while inviting on the desktop, the mode card on the phone', () => {
    const at4 = { step: 4 as const, desktopSubStep: 'C' as const, mobileSubStep: 'B' as const, canChat: false };
    expect(tourSpotlightSelector({ ...at4, isMobile: false, aiStep: 'invite' })).toBe('[data-tour="ask-key"]');
    expect(tourSpotlightSelector({ ...at4, isMobile: true, aiStep: 'invite' })).toBe('[data-tour="mode-card"]');
    expect(tourSpotlightSelector({ ...at4, isMobile: false, aiStep: 'off' })).toBe('[data-tour="dock"]');
    expect(tourSpotlightSelector({ ...at4, isMobile: true, aiStep: 'off' })).toBe('[data-tour="mode-card"]');
    expect(tourSpotlightSelector({ ...at4, canChat: true, isMobile: false, aiStep: 'ready' })).toBe(
      '[data-tour="right-sidebar"]'
    );
    expect(tourSpotlightSelector({ ...at4, canChat: true, isMobile: true, aiStep: 'ready' })).toBe(
      '[data-tour="mode-card"]'
    );
  });

  it("keeps step 3's targets", () => {
    const at3 = { step: 3 as const, mobileSubStep: 'A' as const, isMobile: false, aiStep: null };
    expect(tourSpotlightSelector({ ...at3, desktopSubStep: 'A', canChat: false })).toBe('[data-tour="left-sidebar"]');
    expect(tourSpotlightSelector({ ...at3, desktopSubStep: 'B', canChat: false })).toBe('[data-tour="timeline"]');
    expect(tourSpotlightSelector({ ...at3, desktopSubStep: 'C', canChat: true })).toBe('[data-tour="right-sidebar"]');
    expect(tourSpotlightSelector({ ...at3, desktopSubStep: 'C', canChat: false })).toBe('[data-tour="dock"]');
    expect(tourSpotlightSelector({ ...at3, desktopSubStep: 'A', canChat: false, isMobile: true })).toBe(
      '[data-tour="mode-card"]'
    );
    expect(
      tourSpotlightSelector({ ...at3, desktopSubStep: 'A', mobileSubStep: 'B', canChat: false, isMobile: true })
    ).toBe('[data-tour="mode-card"]');
    expect(tourSpotlightSelector({ ...at3, step: 1, desktopSubStep: 'A', canChat: false })).toBeNull();
    expect(tourSpotlightSelector({ ...at3, step: 2, desktopSubStep: 'A', canChat: false })).toBeNull();
  });
});

describe('its copy', () => {
  // The whole file, comments and all, as the setup column's files are
  // (ask-setup.test.tsx): no em dash anywhere, and never a name for the AI.
  it('has no em dashes and never names the AI', () => {
    const src = readFileSync(join(process.cwd(), 'components/onboarding/onboarding-tour.tsx'), 'utf8');
    expect(src).not.toMatch(/—/);
    expect(src).not.toMatch(/\bBeacon\b/);
  });
});
