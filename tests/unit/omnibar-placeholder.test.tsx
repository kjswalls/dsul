import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

/**
 * The RESTING copy of the two omnibar shells.
 *
 * One component renders both (components/sidebar/omnibar.tsx, `variant`), and
 * the placeholder is the only thing on screen saying what the bar can do before
 * anyone touches it — the hint row and the results panel are both behind focus.
 * So the resting string is a contract, not decoration, and it is the kind of
 * thing a later edit "tidies" without noticing it collapsed the two shells into
 * one voice.
 *
 * Four things are pinned here:
 *   • the dock advertises more than adding (its old line named only the add),
 *   • the dock's line is CONSTANT across the AI gate: it is on screen from the
 *     first paint, so it never names chat (that would be a promise made before
 *     the status has loaded, or words that change a second after load),
 *   • the launcher still leads with search and still spells out commands, and
 *     offers to ask only when something will answer,
 *   • the two are not the same string — the split between a resting capture bar
 *     and a summoned command surface is deliberate.
 *
 * Both shells are asserted through `data-omnibar-variant`, the same handle the
 * e2e helpers use, because both mount the same testid.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  })),
}));
// The omnibar's command context reaches for the router.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { Omnibar } from '@/components/sidebar/omnibar';
import { seedAI, CONNECTED_MODEL, NOTHING_CONNECTED, OPENCLAW_PLUGIN } from './helpers/ai-fixtures';

beforeAll(() => {
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

let unseed: (() => void) | null = null;
afterEach(() => {
  cleanup();
  unseed?.();
  unseed = null;
});

/** Scoped by variant, not by testid: both shells mount `omnibar-input`. */
const placeholderOf = (variant: 'dock' | 'launcher') =>
  document
    .querySelector(`[data-omnibar-variant="${variant}"] [data-testid="omnibar-input"]`)
    ?.getAttribute('placeholder') ?? '';

describe('the resting omnibar placeholder', () => {
  it('advertises more than adding in the dock, and stays inside the pill', () => {
    render(<Omnibar variant="dock" />);

    const placeholder = placeholderOf('dock');
    expect(placeholder).toBe('Add a task or search…');

    // Capture still leads — the dock is the resting capture bar, and the phone
    // strikes its relay on exactly this verb.
    expect(placeholder.toLowerCase().indexOf('add')).toBe(0);
    // …but it is not the only thing named. This is the regression the ticket
    // was: every mode but one invisible until focus.
    expect(placeholder).toMatch(/search/i);
    // And it never promises chat: the dock rests on screen before the AI
    // status has loaded, and for every account with nothing connected.
    expect(placeholder).not.toMatch(/\b(chat|ask|ai)\b/i);

    // A crude proxy for a width jsdom cannot measure. Note this cannot fail
    // independently — the exact match above already pins the string — so it is
    // documentation of the budget, not a second guard. The budget itself: 184px
    // of text column at 320pt (the tightest phone), at the app's 12px
    // --text-sm. 32 chars is about where that runs out.
    expect(placeholder.length).toBeLessThanOrEqual(32);
  });

  it('keeps the dock line identical whatever the AI gate says', () => {
    const seen = new Set<string>();
    for (const seed of [undefined, { phase: 'error' as const }, NOTHING_CONNECTED, CONNECTED_MODEL, OPENCLAW_PLUGIN]) {
      unseed = seedAI(seed);
      const { unmount } = render(<Omnibar variant="dock" />);
      seen.add(placeholderOf('dock'));
      unmount();
      unseed();
      unseed = null;
    }
    expect([...seen]).toEqual(['Add a task or search…']);
  });

  it('keeps the launcher a command surface, and offers to ask only when something answers', () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<Omnibar variant="launcher" />);

    const launcher = placeholderOf('launcher');
    expect(launcher).toBe('Search, add a task, run a command, or ask AI…');

    // The launcher is summoned to run things, so it leads with search and is the
    // shell that names commands at rest.
    expect(launcher).toMatch(/command/i);
  });

  it('names OpenClaw in the launcher when OpenClaw is who answers', () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    render(<Omnibar variant="launcher" />);
    expect(placeholderOf('launcher')).toBe('Search, add a task, run a command, or ask OpenClaw…');
  });

  it('drops the offer to ask from the launcher when nothing can answer', () => {
    unseed = seedAI(NOTHING_CONNECTED);
    render(<Omnibar variant="launcher" />);
    expect(placeholderOf('launcher')).toBe('Search, add a task, or run a command…');
  });

  it('never lets the two shells collapse onto one string', () => {
    // Both shells rendered in ONE test and compared to EACH OTHER. The previous
    // shape of this check compared the launcher against a hardcoded literal,
    // which meant the collapse it claimed to guard — the dock growing into the
    // launcher's line — would have passed it. Only an exact-match assertion
    // elsewhere caught that, transitively.
    const { unmount } = render(<Omnibar variant="dock" />);
    const dock = placeholderOf('dock');
    unmount();

    render(<Omnibar variant="launcher" />);
    const launcher = placeholderOf('launcher');

    expect(dock).not.toBe('');
    expect(launcher).not.toBe('');
    expect(dock).not.toBe(launcher);
  });

  it('survives focus, where the hint row takes over the advertising', () => {
    // Focus opens the panel and its + / commands / ? hint row, which is the more
    // specific advertisement — and, with something to answer, the one place
    // the dock names chat. The placeholder does not step aside for it: the
    // caret is in an empty field at that moment and a field that blanks itself
    // on focus is a field you have to remember the syntax for.
    unseed = seedAI(CONNECTED_MODEL);
    render(<Omnibar variant="dock" />);
    const input = screen.getByTestId('omnibar-input');

    fireEvent.focus(input);
    expect(screen.getByText(/\? chat/)).toBeInTheDocument();
    expect(input).toHaveAttribute('placeholder', 'Add a task or search…');
  });
});
