import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The loading skeleton: the canvas (both routers, every scope × layout) and
 * the braindump list show PlannerSkeleton until there is something to show,
 * and the real view once there is — the fresh load, or the look-only preview
 * of the last session (lib/planner-snapshot.ts) painted while it is in flight.
 *
 * What is locked here, and why each one:
 *  - The skeleton shows iff nothing is VISIBLE (lib/planner-ready.ts: settled
 *    or previewing). This was "the skeleton and `data-loaded="false"` are one
 *    state" until the preview split them on purpose (instant planner, design
 *    §11.1): a previewed view is mounted with `data-loaded="false"`.
 *  - `data-loaded` is FRESH only. e2e waits on it; a persistence spec must
 *    never pass by reading this browser's cache back.
 *  - `data-preview` marks the look-only state, and the real view under it is
 *    inert. Preview → fresh keeps the SAME element tree (the settle's FLIP
 *    animates rows in place), so the swap remounts nothing.
 *  - A failed load is settled: the view (and its Retry notice) shows, not bars
 *    that imply progress which is never coming — with no `data-preview`, even
 *    when a preview was showing before it failed.
 *  - The week COLUMN skeletons flip `data-wide` with the views they stand in
 *    for, so every canvas-container keeps the shared left edge — and nothing
 *    carries the week recede's hooks, so the hover dim cannot reach it.
 *  - No accent anywhere (CLAUDE.md's lime rule), and the motion lives outside
 *    the recede region's transition count with both motion vetoes spelled out.
 */

// The views themselves are stubbed: this file is about the swap, and each
// stub is present only when its router decided there was something to show.
vi.mock('@/components/views/week-buckets', () => ({
  WeekBuckets: () => <div data-testid="view-stub">week-buckets</div>,
}));
vi.mock('@/components/views/week-list', () => ({
  WeekList: () => <div data-testid="view-stub">week-list</div>,
}));
vi.mock('@/components/views/week-schedule', () => ({
  WeekSchedule: () => <div data-testid="view-stub">week-schedule</div>,
}));
vi.mock('@/components/views/day-buckets', () => ({
  DayBuckets: () => <div data-testid="view-stub">day-buckets</div>,
}));
vi.mock('@/components/views/day-list', () => ({
  DayList: () => <div data-testid="view-stub">day-list</div>,
}));
vi.mock('@/components/views/day-schedule', () => ({
  DaySchedule: () => <div data-testid="view-stub">day-schedule</div>,
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

// RelayField (the braindump's empty-state backdrop) reads prefers-reduced-motion.
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

import { ViewRouter } from '@/components/views/view-router';
import { MobileViewRouter } from '@/components/mobile/mobile-view-router';
import { Braindump } from '@/components/sidebar/braindump';
import { PlannerSkeleton, type SkeletonVariant } from '@/components/primitives/planner-skeleton';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore, type ViewLayout, type ViewScope } from '@/lib/view-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import { useMorningStore } from '@/lib/morning-store';
import { toDateStr } from '@/lib/recurrence';
import type { Item } from '@/lib/planner-types';

afterEach(() => {
  cleanup();
  usePlannerStore.getState().clearStore();
});

/**
 * Every state the store's writers leave the readiness fields in, with what it
 * reads as: [name, state, settled (data-loaded), visible (the view, no skeleton)].
 * Previewing is the one row where the two differ — deliberately (design §11.1).
 */
const ready = { error: null, loadFailedUserId: null, isPreview: false };
const STATES: [string, Record<string, unknown>, boolean, boolean][] = [
  ['pre-init', { ...ready, userId: null, isLoading: false }, false, false],
  ['identifying', { ...ready, userId: 'u1', isLoading: true }, false, false],
  ['loading (retry)', { ...ready, userId: 'u1', isLoading: true }, false, false],
  ['previewing', { ...ready, userId: 'u1', isLoading: true, isPreview: true }, false, true],
  ['settled', { ...ready, userId: 'u1', isLoading: false }, true, true],
  ['failed', { ...ready, userId: 'u1', isLoading: false, error: 'boom', loadFailedUserId: 'u1' }, true, true],
];

const DESKTOP: [ViewScope, ViewLayout][] = [
  ['day', 'buckets'],
  ['day', 'list'],
  ['day', 'schedule'],
  ['week', 'buckets'],
  ['week', 'list'],
  ['week', 'schedule'],
];
const MOBILE: ViewLayout[] = ['buckets', 'list', 'schedule'];

const skeleton = () => screen.queryByTestId('planner-skeleton');
const viewRoot = () => screen.getByTestId('view-root');

/** The marker's whole readiness reading, per state. */
function expectReadiness(name: string, settled: boolean, visible: boolean, previewing: boolean) {
  const root = viewRoot();
  expect(!!skeleton(), name).toBe(!visible);
  expect(root.dataset.loaded, name).toBe(settled ? 'true' : 'false');
  expect(!!screen.queryByTestId('view-stub'), name).toBe(visible);
  expect(root.dataset.preview, name).toBe(previewing ? 'true' : undefined);
  expect(root.hasAttribute('inert'), name).toBe(previewing);
  expect(root.dataset.settleScope, name).toBe('canvas');
}

describe('the canvas swaps skeleton ⇄ view on one predicate', () => {
  for (const [scope, layout] of DESKTOP) {
    it(`desktop ${scope} × ${layout}`, () => {
      useViewStore.setState({ scope, layout });
      for (const [name, state, settled, visible] of STATES) {
        usePlannerStore.setState(state);
        render(<ViewRouter />);
        expectReadiness(name, settled, visible, !!state.isPreview);
        if (!visible) {
          expect(skeleton()!.dataset.skeletonVariant).toBe(layout);
          expect(skeleton()!.dataset.skeletonScope).toBe(scope);
        }
        cleanup();
      }
    });
  }

  for (const layout of MOBILE) {
    it(`mobile day × ${layout}`, () => {
      useViewStore.setState({ scope: 'day', layout });
      for (const [name, state, settled, visible] of STATES) {
        usePlannerStore.setState(state);
        render(<MobileViewRouter />);
        expectReadiness(name, settled, visible, !!state.isPreview);
        cleanup();
      }
    });
  }

  it('shows no skeleton over a failed load', () => {
    useViewStore.setState({ scope: 'day', layout: 'list' });
    usePlannerStore.setState({ userId: 'u1', isLoading: false, error: 'boom', loadFailedUserId: 'u1' });
    render(<ViewRouter />);
    expect(skeleton()).toBeNull();
    expect(screen.getByTestId('view-stub')).toBeInTheDocument();
  });

  it('mounts the view on the pending → settled edge', () => {
    useViewStore.setState({ scope: 'week', layout: 'schedule' });
    usePlannerStore.setState({ userId: 'u1', isLoading: true });
    render(<ViewRouter />);
    expect(skeleton()).not.toBeNull();
    act(() => usePlannerStore.setState({ isLoading: false }));
    expect(skeleton()).toBeNull();
    expect(screen.getByTestId('view-stub')).toHaveTextContent('week-schedule');
  });
});

/**
 * The look-only preview, through both routers. The store's own edges are what
 * planner-preview-store.test.ts pins (the cached slices and `isPreview` land in
 * one set(), and the landing clears it in the same set() as the fresh slices);
 * these drive the routers through the same field transitions.
 */
const ROUTERS = [
  ['desktop', () => <ViewRouter />],
  ['mobile', () => <MobileViewRouter />],
] as const;

describe('the look-only preview mounts the real view', () => {
  const previewing = { userId: 'u1', isLoading: true, isPreview: true, error: null, loadFailedUserId: null };

  for (const [shell, ui] of ROUTERS) {
    describe(shell, () => {
      it('mounts the real view, inert, marked preview and NOT loaded', () => {
        useViewStore.setState({ scope: 'day', layout: 'list' });
        usePlannerStore.setState(previewing);
        render(ui());
        const root = viewRoot();
        expect(screen.getByTestId('view-stub')).toHaveTextContent('day-list');
        expect(root.dataset.loaded).toBe('false');
        expect(root.dataset.preview).toBe('true');
        expect(root).toHaveAttribute('inert');
        // The view sits INSIDE the inert root, so nothing in it takes a pointer.
        expect(screen.getByTestId('view-stub').closest('[inert]')).toBe(root);
      });

      it('shows no skeleton while previewing — not even beside the view', () => {
        useViewStore.setState({ scope: 'day', layout: 'schedule' });
        usePlannerStore.setState(previewing);
        render(ui());
        expect(skeleton()).toBeNull();
        expect(screen.getAllByTestId('view-stub')).toHaveLength(1);
      });

      it('keeps the SAME view element from preview to fresh', () => {
        useViewStore.setState({ scope: 'day', layout: 'buckets' });
        // The cold-load order: identifying (bars), then the cache paints.
        usePlannerStore.setState({ ...previewing, isPreview: false });
        render(ui());
        expect(skeleton()).not.toBeNull();
        act(() => usePlannerStore.setState({ isPreview: true }));
        const root = viewRoot();
        const view = screen.getByTestId('view-stub');

        // The landing: fresh slices, isPreview and isLoading cleared together.
        act(() => usePlannerStore.setState({ isLoading: false, isPreview: false }));
        expect(viewRoot()).toBe(root);
        expect(screen.getByTestId('view-stub')).toBe(view);
        expect(root.dataset.loaded).toBe('true');
        expect(root.dataset.preview).toBeUndefined();
        expect(root).not.toHaveAttribute('inert');
        expect(skeleton()).toBeNull();
      });

      it('a failed load after a preview shows the view, settled, with no data-preview', () => {
        useViewStore.setState({ scope: 'day', layout: 'list' });
        usePlannerStore.setState(previewing);
        render(ui());
        // The failure drop (design D5): the cache leaves in the same set() as
        // the error, so the view stands over today's failed-load state.
        act(() =>
          usePlannerStore.setState({ isLoading: false, isPreview: false, error: 'boom', loadFailedUserId: 'u1' })
        );
        const root = viewRoot();
        expect(skeleton()).toBeNull();
        expect(screen.getByTestId('view-stub')).toBeInTheDocument();
        expect(root.dataset.preview).toBeUndefined();
        expect(root).not.toHaveAttribute('inert');
        // Failed counts as settled (lib/planner-ready.ts), exactly as before.
        expect(root.dataset.loaded).toBe('true');
      });
    });
  }
});

describe('geometry: wide where the views are wide, never a recede hook', () => {
  for (const [scope, layout] of DESKTOP) {
    const wide = scope === 'week' && layout !== 'list';
    it(`${scope} × ${layout} ${wide ? 'is' : 'is not'} wide`, () => {
      useViewStore.setState({ scope, layout });
      usePlannerStore.setState({ userId: 'u1', isLoading: true });
      const { container } = render(<ViewRouter />);
      expect(skeleton()!.dataset.wide).toBe(wide ? 'true' : undefined);
      expect(skeleton()!.className).toContain('canvas-container');
      expect(container.querySelectorAll('[data-week-col],[data-week-cols]')).toHaveLength(0);
    });
  }

  it('mobile never goes wide', () => {
    useViewStore.setState({ scope: 'day', layout: 'buckets' });
    usePlannerStore.setState({ userId: 'u1', isLoading: true });
    render(<MobileViewRouter />);
    expect(skeleton()!.dataset.wide).toBeUndefined();
  });
});

describe('no accent in any variant', () => {
  // Wider than week-column-hover's `paintsAccent`: no lime, no success, no
  // priority, no accent ramp — the skeleton has no business with any colour.
  const COLOURED = /accent|lime|success|priority|primary/;
  const CASES: [SkeletonVariant, ViewScope][] = [
    ['list', 'day'],
    ['list', 'week'],
    ['buckets', 'day'],
    ['buckets', 'week'],
    ['schedule', 'day'],
    ['schedule', 'week'],
    ['braindump', 'day'],
  ];
  for (const [variant, scope] of CASES) {
    it(`${variant} × ${scope}`, () => {
      const { container } = render(<PlannerSkeleton variant={variant} scope={scope} wide />);
      const els = [...container.querySelectorAll('*')] as HTMLElement[];
      // Guard the guard: a skeleton that stopped drawing bars passes vacuously.
      expect(els.filter((el) => /bg-surface-3/.test(el.className)).length).toBeGreaterThan(3);
      const offenders = els.filter(
        (el) =>
          COLOURED.test(el.getAttribute('class') ?? '') ||
          COLOURED.test(el.getAttribute('style') ?? '')
      );
      expect(offenders.map((el) => el.className)).toEqual([]);
    });
  }
});

describe('accessibility', () => {
  it('is a status with distinct names for the canvas and the braindump', () => {
    render(
      <>
        <PlannerSkeleton variant="list" scope="day" />
        <PlannerSkeleton variant="braindump" />
      </>
    );
    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(2);
    const names = statuses.map((s) => s.textContent);
    expect(names[0]).not.toBe(names[1]);
    for (const s of statuses) {
      expect(s).toHaveAttribute('aria-busy', 'true');
      expect(s.querySelector('[data-skeleton-bars]')).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('names the week as the week', () => {
    render(<PlannerSkeleton variant="buckets" scope="week" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading your week…');
  });
});

describe('the skeleton CSS', () => {
  const src = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
  const start = src.indexOf('@keyframes planner-skeleton-in');
  // The block runs to the next top-of-file section banner.
  const block = src.slice(start, src.indexOf('/* ──', start));

  it('sits outside the week recede region', () => {
    expect(start).toBeGreaterThan(src.indexOf('@layer base {'));
    expect(start).toBeGreaterThan(src.indexOf('--day-recede:'));
  });

  it('declares no transition', () => {
    expect(block.length).toBeGreaterThan(100);
    expect(block).not.toMatch(/^\s*transition[a-z-]*\s*:/m);
  });

  it('spells out both motion vetoes, dropping the breathe', () => {
    const media = block.slice(block.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(media).toMatch(/\.planner-skeleton \[data-skeleton-bars\]\s*\{\s*animation:\s*none;/);
    expect(block).toMatch(
      /\[data-reduce-motion='true'\] \.planner-skeleton \[data-skeleton-bars\]\s*\{\s*animation:\s*none;/
    );
    expect(block).toMatch(/\[data-reduce-motion='true'\] \.planner-skeleton\s*\{/);
  });

  it('holds the 250ms delay so warm loads never flash bars', () => {
    expect(block).toMatch(/\.planner-skeleton\s*\{\s*animation:\s*planner-skeleton-in [^;]* 250ms both;/);
  });
});

// ── The braindump list, real component ─────────────────────────────────────

const task = (id: string) =>
  ({
    type: 'task',
    id,
    title: `Task ${id}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
  }) as unknown as Item;

function seed(items: Item[], state: Record<string, unknown> = {}) {
  usePlannerStore.setState({
    userId: 'user-1',
    isLoading: false,
    error: null,
    userTimezone: 'UTC',
    items,
    tasks: items as never,
    habits: [],
    projects: [],
    routines: [],
    seasons: [],
    goals: [],
    ...state,
  });
  useViewStore.setState({
    braindumpGroupBy: 'none',
    braindumpSortBy: 'default',
    braindumpFilters: EMPTY_VIEW_FILTERS,
  });
}

const renderBraindump = () =>
  render(
    <DndContext>
      <Braindump />
    </DndContext>
  );

const poem = () => screen.queryByText(/A clear head/);

describe('braindump list', () => {
  it('shows bars, not the empty-state poem, while pending', () => {
    seed([], { isLoading: true });
    renderBraindump();
    expect(skeleton()).not.toBeNull();
    expect(skeleton()!.dataset.skeletonVariant).toBe('braindump');
    expect(poem()).toBeNull();
  });

  it('shows the poem, not bars, once settled and empty', () => {
    seed([]);
    renderBraindump();
    expect(skeleton()).toBeNull();
    expect(poem()).not.toBeNull();
  });

  it('keeps the poem beside a failed load', () => {
    seed([], { error: 'boom', loadFailedUserId: 'user-1' });
    renderBraindump();
    expect(skeleton()).toBeNull();
    expect(poem()).not.toBeNull();
  });

  it('swaps the bars for rows when the load lands', () => {
    seed([task('a'), task('b')], { isLoading: true });
    renderBraindump();
    expect(skeleton()).not.toBeNull();
    expect(screen.queryByText('Task a')).toBeNull();
    act(() => usePlannerStore.setState({ isLoading: false }));
    expect(skeleton()).toBeNull();
    expect(screen.getByText('Task a')).toBeInTheDocument();
  });
});

/**
 * Parity with the canvas routers for the look-only preview: the braindump
 * shows the cached rows (no bars), the rows refuse pointer and focus, and the
 * two things a person can still do while it syncs — capture into the quick-add
 * and dismiss the sweep receipt — stay live.
 */
describe('braindump list while previewing', () => {
  const previewing = { isLoading: true, isPreview: true };
  const paused = {
    type: 'habit',
    id: 'h-paused',
    title: 'Paused habit',
    status: 'pending',
    repeatFrequency: 'daily',
    timeBucket: 'morning',
    completedDates: [],
    skippedDates: [],
    pausedAt: '2020-01-01T00:00:00Z',
  } as unknown as Item;

  afterEach(() => useMorningStore.setState({ morningAutoAgeReceiptByUser: {} }));

  it('renders the cached rows, not bars and not the poem', () => {
    seed([task('a'), task('b')], previewing);
    renderBraindump();
    expect(skeleton()).toBeNull();
    expect(poem()).toBeNull();
    expect(screen.getByText('Task a')).toBeInTheDocument();
    expect(screen.getByText('Task b')).toBeInTheDocument();
  });

  it('makes the list body and the paused strip inert, and nothing else', () => {
    seed([task('a'), paused], { ...previewing, habits: [paused] as never, tasks: [task('a')] as never });
    renderBraindump();
    const section = screen.getByTestId('braindump');
    expect(section.dataset.settleScope).toBe('braindump');
    expect(section).not.toHaveAttribute('inert');

    expect(screen.getByText('Task a').closest('[inert]')).not.toBeNull();
    const strip = screen.getByTestId('braindump-paused-section');
    expect(strip.closest('[inert]')).not.toBeNull();
    // Its settle frame sits on the strip's own box, not the boxless wrapper.
    expect(strip.dataset.settleKey).toBe('braindump:paused');
    expect(strip.dataset.settleRole).toBe('frame');

    // Exactly those two: the header, the receipt slot and the quick-add are live.
    expect(section.querySelectorAll('[inert]')).toHaveLength(2);
    const quickAdd = screen.getByTestId('braindump-quick-add');
    expect(quickAdd.closest('[inert]')).toBeNull();
    expect(quickAdd.dataset.settleKey).toBe('braindump:quickadd');
    expect(quickAdd.dataset.settleRole).toBe('frame');
  });

  it('keeps the sweep receipt live — its ✕ always works', () => {
    seed([task('a')], previewing);
    useMorningStore.setState({
      morningAutoAgeReceiptByUser: {
        'user-1': {
          date: toDateStr(new Date(), 'UTC'),
          items: [{ id: 'i1', title: 'Swim', isScheduled: true, startDate: '2026-08-20' }],
        },
      },
    });
    renderBraindump();
    const receipt = screen.getByTestId('in-place-notice');
    expect(receipt).toHaveAttribute('data-notice-id', 'auto-age-receipt');
    expect(receipt.closest('[inert]')).toBeNull();
  });

  it('keeps the count hidden — it is the fresh load that counts', () => {
    seed([task('a'), task('b')], previewing);
    renderBraindump();
    expect(screen.queryByTestId('braindump-count')).toBeNull();
    act(() => usePlannerStore.setState({ isLoading: false, isPreview: false }));
    expect(screen.getByTestId('braindump-count')).toBeInTheDocument();
  });

  it('lifts inert on landing without remounting the rows', () => {
    seed([task('a')], previewing);
    renderBraindump();
    const row = screen.getByText('Task a');
    act(() => usePlannerStore.setState({ isLoading: false, isPreview: false }));
    expect(screen.getByText('Task a')).toBe(row);
    expect(row.closest('[inert]')).toBeNull();
  });
});
