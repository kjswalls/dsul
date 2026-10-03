import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

/**
 * The day on a narrow canvas: what keeps it whole beside a docked right rail,
 * where the braindump yields down to its 280px minimum and the day can be
 * ~380px wide (lib/sidebar-store.ts renderedSidebarWidth has the figures).
 *
 * Most of it is CSS keyed off <main>'s `canvas` size container, which jsdom
 * neither lays out nor evaluates, so it is pinned the way the rest of the
 * stylesheet is (week-column-hover.test.tsx): the rules as text, and the
 * hooks they key off as the attributes and classes the components render.
 * Each pin fails without its piece; rail-desktop.test.tsx pins the container
 * itself on <main> and the header row's wrap, and row-controls.test.tsx the
 * row's trailing rail. What it all does to the pixels was measured in
 * Chromium (step2/pr2/c2r2).
 *
 * Also here: the pieces of the narrow braindump a docked rail makes the
 * resting state, the dock's user card and the week scale.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  })),
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/extension-gates', async (orig) => ({
  ...(await orig<typeof import('@/lib/extension-gates')>()),
  useStreaksEnabled: () => true,
}));

import { HeaderCapsule, MASTHEAD_WIDE_DATE_CHARS } from '@/components/canvas/header-capsule';
import { WeekScale } from '@/components/canvas/week-scale';
import { UserCard } from '@/components/sidebar/user-card';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import type { Item } from '@/lib/planner-types';

beforeAll(() => {
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

/** Friday 2 October 2026: "today" for every case here. */
const TODAY = new Date(2026, 9, 2, 12);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
  usePlannerStore.setState({
    userId: 'user-1',
    isLoading: false,
    userTimezone: 'UTC',
    selectedDate: TODAY,
    items: [],
    projects: [],
    routines: [],
    seasons: [],
    goals: [],
  });
  useViewStore.setState({ scope: 'day', layout: 'buckets' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/* ── the stylesheet ──────────────────────────────────────────────────── */

const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');

/** The body of the first block that opens with `head` (balanced braces). */
function block(head: string): string {
  const start = css.indexOf(head);
  expect(start, head).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced block: ${head}`);
}

describe('app/globals.css on a narrow canvas', () => {
  it("lays the day views' scroller out as a block, in day scope only", () => {
    // Radix's display:table box grew to its widest row and every card lost
    // its right edge past the viewport.
    const rule = block("[data-view-scope='day'] > [data-slot='scroll-area'] > [data-slot='scroll-area-viewport'] > div");
    expect(rule).toMatch(/display:\s*block\s*!important/);
  });

  it('below a 450px canvas, sends the header labels to the screen reader and draws the short date', () => {
    const narrow = block('@container canvas (width < 450px)');
    const sr = narrow.slice(narrow.indexOf('[data-header-capsule] [data-narrow-sr]'));
    expect(sr).toMatch(/^\[data-header-capsule\] \[data-narrow-sr\]\s*\{[^}]*position:\s*absolute;[^}]*clip-path:\s*inset\(50%\)/);
    expect(narrow).toMatch(/\[data-header-capsule\] \[data-date-long\]\s*\{\s*display:\s*none;/);
    expect(narrow).toMatch(
      /\[data-header-capsule\] \[data-testid='header-date'\]::after\s*\{\s*content:\s*attr\(data-date-short\);/
    );
  });

  it("shortens only a wide date sooner in the masthead: below 520, the longest date's strict fit", () => {
    const masthead = block('@container canvas (width < 520px)');
    expect(masthead).toMatch(
      /\[data-layout-header='masthead'\] \[data-header-capsule\] \[data-date-wide\] \[data-date-long\]\s*\{\s*display:\s*none;/
    );
    expect(masthead).toMatch(
      /\[data-layout-header='masthead'\] \[data-header-capsule\] \[data-testid='header-date'\]\[data-date-wide\]::after\s*\{\s*content:\s*attr\(data-date-short\);/
    );
    // No flat masthead threshold left behind for every date.
    expect(css).not.toMatch(/@container canvas \(width < 530px\)/);
  });
});

/* ── the header capsule ──────────────────────────────────────────────── */

const date = () => screen.getByTestId('header-date');

describe('the header capsule on a narrow canvas', () => {
  it('marks what a narrow canvas sends to the screen reader: the pill labels, Display and Today', () => {
    usePlannerStore.setState({ selectedDate: new Date(2026, 8, 30, 12) });
    render(<HeaderCapsule />);
    const sr = Array.from(document.querySelectorAll('[data-header-capsule] [data-narrow-sr]')).map(
      (el) => el.textContent
    );
    expect(sr).toEqual(expect.arrayContaining(['Buckets', 'Day', 'Display', 'Today']));
  });

  it('carries the short date for CSS to draw, and keeps the long one as its text and its name', () => {
    usePlannerStore.setState({ selectedDate: new Date(2026, 8, 30, 12) });
    render(<HeaderCapsule />);
    expect(date()).toHaveAttribute('data-date-short', 'Wed, Sep 30');
    expect(date().querySelector('[data-date-long]')).toHaveTextContent(/^Wednesday, September 30$/);
    expect(date()).toHaveTextContent(/^Wednesday, September 30$/);
    // Named by the long form at every width: the short one is generated
    // content standing in for a display:none span, and would be the name.
    expect(date()).toHaveAttribute('aria-label', 'Wednesday, September 30');
    expect(screen.getByRole('button', { name: 'Wednesday, September 30' })).toBe(date());
  });

  it('marks a date the masthead shortens sooner by its length, and leaves the rest to the 450 rule', () => {
    // Measured over a year of dates in Chromium (header-capsule.tsx).
    expect(MASTHEAD_WIDE_DATE_CHARS).toBe(17);
    usePlannerStore.setState({ selectedDate: new Date(2026, 8, 30, 12) });
    const view = render(<HeaderCapsule />);
    expect('Wednesday, September 30'.length).toBeGreaterThan(MASTHEAD_WIDE_DATE_CHARS);
    expect(date()).toHaveAttribute('data-date-wide');
    view.unmount();

    // Friday, October 2 (17): whole on Notebook's 514px day at 1440; the
    // first 18-character date is past the 450 rule's fit, so it is wide.
    usePlannerStore.setState({ selectedDate: TODAY });
    render(<HeaderCapsule />);
    expect(date()).toHaveTextContent(/^Friday, October 2$/);
    expect(date()).not.toHaveAttribute('data-date-wide');
    act(() => usePlannerStore.setState({ selectedDate: new Date(2026, 10, 2, 12) }));
    expect(date()).toHaveTextContent(/^Monday, November 2$/);
    expect(date()).toHaveAttribute('data-date-wide');
  });
});

/* ── the week scale ──────────────────────────────────────────────────── */

describe('the week scale, disabled', () => {
  it('fades nothing through its root, and mutes the lime ring on its thumb instead', () => {
    // One rung (beside a docked rail at 1280), or not measured yet: disabled.
    useViewStore.setState({ scope: 'week', layout: 'buckets' });
    render(<WeekScale />);
    const root = document.querySelector('[data-slot="slider"]') as HTMLElement;
    expect(root).toHaveAttribute('data-disabled');
    // The shadcn default fades the whole slider, the lime thumb ring with it.
    expect(root.className).not.toMatch(/data-\[disabled\]:opacity-50/);
    expect(root).toHaveClass('data-[disabled]:opacity-100');
    expect(root).toHaveClass('[&_[data-slot=slider-thumb]]:data-[disabled]:border-muted-foreground/40');
    expect(document.querySelector('[data-slot="slider-thumb"]')).toHaveAttribute('data-disabled');
  });
});

/* ── the dock's user card ────────────────────────────────────────────── */

describe("the dock's user card on a narrow braindump", () => {
  it('keeps the streak badge whole and lets the session label truncate instead', () => {
    // 328px beside a docked rail at 1280, 280 below ~1232: the badge is
    // overflow-hidden, so without its own no-shrink it cut its flame and count.
    const habit = {
      type: 'habit',
      id: 'h1',
      title: 'Stretch',
      streak: 4,
      status: 'pending',
      completedDates: [],
      skippedDates: [],
      dailyCounts: {},
      repeatFrequency: 'daily',
    } as Item;
    // `habits` is the store's projection off `items`; seeded as both.
    usePlannerStore.setState({ items: [habit], habits: [habit] as never });
    render(<UserCard />);
    const badge = screen.getByTestId('user-streak');
    expect(badge).toHaveTextContent('4');
    expect(badge).toHaveClass('flex-shrink-0', 'overflow-hidden');
    const history = screen.getByTestId('user-history');
    expect(history).toHaveClass('min-w-0', 'shrink', 'ml-auto');
    // The session label ("Session start", or the last action's): the
    // history group's first button, ahead of undo and redo.
    const label = history.querySelector('button') as HTMLElement;
    expect(label).toHaveClass('min-w-0', 'shrink', 'truncate', 'max-w-[110px]');
  });
});
