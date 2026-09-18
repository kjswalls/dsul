import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

/**
 * The redesigned mobile header — the week strip and the view cycler.
 *
 * Both are render-and-write tests for the same reason the display-menu ones
 * are: the risk here is in the WIRING, not the arithmetic. The strip is the
 * phone's only date control now that the chevrons are gone, so "seven cells,
 * each addressable by the date it moves to" is a contract two e2e specs and
 * tests/e2e/helpers/app.ts navigate by; and the cycler is a button that has to
 * both READ and ADVANCE one store field, which a props-level test of an icon
 * would pass with either half wrong.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchPrograms: vi.fn(async () => []),
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

describe('the week strip', () => {
  it('is the calendar week around the cursor, one addressable cell per day', () => {
    renderHeader();

    // Seven, and the WEEK's seven — not a rolling window from the cursor. The
    // weekday initials have to stay in their columns as the cursor moves.
    expect(screen.getAllByTestId('week-day').map((c) => c.getAttribute('data-date'))).toEqual([
      '2026-08-23',
      '2026-08-24',
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
    ]);
  });

  it('follows the week-start preference rather than assuming Sunday', () => {
    usePlannerStore.setState({ weekStartDay: 'monday' });
    renderHeader();

    const dates = screen.getAllByTestId('week-day').map((c) => c.getAttribute('data-date'));
    expect(dates[0]).toBe('2026-08-24');
    expect(dates[6]).toBe('2026-08-30');
  });

  it('marks exactly the cursor, and moves it on tap', () => {
    renderHeader();

    const marked = screen
      .getAllByTestId('week-day')
      .filter((c) => c.getAttribute('data-selected') === 'true');
    expect(marked.map((c) => c.getAttribute('data-date'))).toEqual(['2026-08-24']);

    fireEvent.click(screen.getAllByTestId('week-day')[4]);
    expect(usePlannerStore.getState().selectedDate).toEqual(new Date(2026, 7, 27));
  });

  it('marks today as well as the cursor, so a paged-away week still says where now is', () => {
    // Pinned to a Wednesday inside the cursor's own Sun-start week: the mark
    // has to show while the cursor sits on some OTHER day, which is the one
    // case the artboard cannot arbitrate — there the selected day IS today.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-08-26T12:00:00Z'));
    try {
      renderHeader();

      const cells = screen.getAllByTestId('week-day');
      const cellFor = (date: string) =>
        cells.find((c) => c.getAttribute('data-date') === date)!;

      const today = cellFor('2026-08-26');
      expect(today).toHaveAttribute('data-selected', 'false');
      expect(today).toHaveAttribute('aria-label', 'Today, Wednesday, August 26');
      // Weight and ink, not a second badge — the lime underline stays the one
      // mark that means "selected".
      expect(within(today).getByText('26')).toHaveClass('font-semibold');
      expect(within(cellFor('2026-08-27')).getByText('27')).not.toHaveClass('font-semibold');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays off the dateless tabs, which have no cursor to show', () => {
    useMobileNavStore.setState({ activeTab: 'braindump' });
    renderHeader();

    expect(screen.queryAllByTestId('week-day')).toHaveLength(0);
    // The whole card goes, not only the strip: Braindump and Beacon each bring
    // their own header, and a date row stacked above one of those is a second
    // header offering a calendar for a surface that has no date.
    expect(screen.queryByTestId('header-date')).toBeNull();
  });
});

describe('the view cycler', () => {
  it('reads the current layout and advances to the next one', () => {
    renderHeader();

    // The button IS the readout, so its label has to name where you are AND
    // where a tap goes; a picker's "Layout" said neither.
    const cycle = () => screen.getByTestId('mobile-view-cycle');
    expect(cycle()).toHaveAttribute('aria-label', 'View: Buckets. Tap for List.');

    fireEvent.click(cycle());
    expect(useViewStore.getState().layout).toBe('list');

    fireEvent.click(cycle());
    expect(useViewStore.getState().layout).toBe('schedule');

    // …and round, rather than dead-ending on the last one.
    fireEvent.click(cycle());
    expect(useViewStore.getState().layout).toBe('buckets');
  });

  it('stays off the dateless tabs, which render no canvas for it to switch', () => {
    useMobileNavStore.setState({ activeTab: 'chat' });
    renderHeader();

    expect(screen.queryByTestId('mobile-view-cycle')).toBeNull();
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
