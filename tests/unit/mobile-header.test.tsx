import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

/**
 * The phone's top row (mobile web round 3) — the title that is the date
 * control, the Today key, and the layout capsule.
 *
 * Render-and-write tests for the same reason the display-menu ones are: the
 * risk here is in the WIRING. The title carries the machine-readable date
 * tests/e2e/helpers/app.ts navigates by, and the capsule has to both READ and
 * ADVANCE one store field, which a props-level test of an icon would pass with
 * either half wrong.
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
// The header renders UserProfileDropdown, which calls useRouter — outside a
// Next tree that throws "invariant expected app router to be mounted".
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { MobileHeader } from '@/components/mobile/mobile-header';
import { UserProfileDropdown } from '@/components/planner/user-profile-dropdown';
import { usePlannerStore } from '@/lib/planner-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { useViewStore } from '@/lib/view-store';
import {
  seedAI,
  AI_HIDDEN,
  CONNECTED_MODEL,
  KEY_TURNED_DOWN,
  NOTHING_CONNECTED,
  type SeedAI,
} from './helpers/ai-fixtures';

/** jsdom implements neither PointerEvent nor pointer capture; Radix needs both. */
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

/** Monday, 24 August 2026 — the artboard's date, in a Sun-start week 23…29. */
const MONDAY = new Date(2026, 7, 24);

const renderHeader = () =>
  render(<MobileHeader settingsHref="/settings/day" onOpenBugReport={() => {}} />);

beforeEach(() => {
  usePlannerStore.setState({ selectedDate: MONDAY, weekStartDay: 'sunday' });
  useViewStore.setState({ layout: 'buckets' });
  useMobileNavStore.setState({ activeTab: 'today' });
});
afterEach(cleanup);

describe('the title', () => {
  it('names the day and the layout, and carries the date for the e2e helpers', () => {
    renderHeader();
    const title = screen.getByTestId('header-date');
    expect(title).toHaveAttribute('data-date', '2026-08-24');
    expect(title).toHaveTextContent('Monday');
    expect(title).toHaveTextContent('Mon, Aug 24 · Buckets');
    // There is no week strip any more: the title is the date control.
    expect(screen.queryAllByTestId('week-day')).toHaveLength(0);
  });

  it('offers a Today key on another day, and none on today', () => {
    renderHeader();
    fireEvent.click(screen.getByTestId('header-today'));
    const now = usePlannerStore.getState().selectedDate;
    expect(now.toDateString()).toBe(new Date().toDateString());
    cleanup();
    renderHeader();
    expect(screen.queryByTestId('header-today')).toBeNull();
  });
});

describe('the view cycler', () => {
  it('reads the current layout and advances to the next one', () => {
    renderHeader();

    // The button IS the readout, so its label has to name where you are AND
    // where a tap goes; a picker's "Layout" said neither.
    const cycle = () => screen.getByTestId('mobile-view-cycle');
    expect(cycle()).toHaveAttribute('aria-label', 'View: Buckets. Tap for List, hold for more.');

    fireEvent.click(cycle());
    expect(useViewStore.getState().layout).toBe('list');

    fireEvent.click(cycle());
    expect(useViewStore.getState().layout).toBe('schedule');

    // …and round, rather than dead-ending on the last one.
    fireEvent.click(cycle());
    expect(useViewStore.getState().layout).toBe('buckets');
  });

  it('opens its menu on a right-click (or a hold) without stepping, and sets Compact rows', async () => {
    useViewStore.setState({ phoneDensity: 'comfortable' });
    renderHeader();
    const cycle = screen.getByTestId('mobile-view-cycle');
    fireEvent.contextMenu(cycle);
    const compact = await screen.findByTestId('mobile-density-compact');
    expect(useViewStore.getState().layout).toBe('buckets');
    fireEvent.click(compact);
    expect(useViewStore.getState().phoneDensity).toBe('compact');
  });

  // The chat tab is on screen only while the gate offers it: Ask while
  // something answers, the setup page or the fix home in its place while the
  // gate invites or offers the fix. Each brings its own capsule and the user
  // menu in it, so the header is the bare inset.
  it.each<[string, SeedAI]>([
    ['Ask', CONNECTED_MODEL],
    ['the setup page', NOTHING_CONNECTED],
    ['the fix home', KEY_TURNED_DOWN],
  ])('stays off the dateless tabs, which render no canvas for it to switch: %s', (_, s) => {
    const unseed = seedAI(s);
    try {
      useMobileNavStore.setState({ activeTab: 'chat' });
      renderHeader();

      expect(screen.queryByTestId('mobile-view-cycle')).toBeNull();
      expect(screen.queryByTestId('header-date')).toBeNull();
      expect(screen.queryByRole('button', { name: 'User menu' })).toBeNull();
    } finally {
      unseed();
    }
  });

  it.each<[string, SeedAI | undefined]>([
    ['the gate has not answered', undefined],
    ['the account has said No AI', AI_HIDDEN],
  ])('follows the tab the shell shows: a stored chat tab that is not offered is Today, card and all (%s)', (_, s) => {
    // The shell renders Today for it (shownMobileTab); a dateless header over
    // Today would leave the phone with no date and no user menu.
    const unseed = seedAI(s);
    try {
      useMobileNavStore.setState({ activeTab: 'chat' });
      renderHeader();

      expect(screen.getByTestId('mobile-view-cycle')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'User menu' })).toBeInTheDocument();
    } finally {
      unseed();
    }
  });
});

describe('the user menu', () => {
  it('carries the bug-report entry only where a handler is supplied', async () => {
    // The mobile header retired its standalone bug-report button into this
    // menu, and the menu is shared. An unconditional row would put a dead entry
    // in every other mount — hence the prop gate, asserted from both sides.
    render(<UserProfileDropdown settingsHref="/settings/day" />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'User menu' }), { button: 0 });
    expect(await screen.findByRole('menuitem', { name: /Settings/ })).toBeInTheDocument();
    expect(screen.queryByTestId('user-menu-bug-report')).toBeNull();

    cleanup();

    const onOpenBugReport = vi.fn();
    render(<UserProfileDropdown settingsHref="/settings/day" onOpenBugReport={onOpenBugReport} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'User menu' }), { button: 0 });
    fireEvent.click(await screen.findByTestId('user-menu-bug-report'));
    expect(onOpenBugReport).toHaveBeenCalledTimes(1);
  });

  it('reaches Settings through a real link, not a push', async () => {
    // This is the only route to Settings on either mobile tab, and the whole
    // reason it takes an href: opening the menu MOUNTS this row, and a mounted
    // <Link> is what prefetches the settings route chunk in production. An
    // imperative router.push renders an identical-looking menuitem that pays
    // that fetch at tap time instead — so the property has to be asserted on
    // the element, where the difference actually shows.
    render(<UserProfileDropdown settingsHref="/settings/day" />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'User menu' }), { button: 0 });

    const settings = await screen.findByRole('menuitem', { name: /Settings/ });
    expect(settings.tagName).toBe('A');
    expect(settings).toHaveAttribute('href', '/settings/day');
  });
});
