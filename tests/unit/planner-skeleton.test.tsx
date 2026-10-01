import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The loading skeleton: the canvas (both routers, every scope × layout) and
 * the braindump list show PlannerSkeleton while the planner's load is in
 * flight, and the real view once it has landed.
 *
 * What is locked here, and why each one:
 *  - The skeleton and `data-loaded="false"` are ONE state, read off one
 *    predicate (lib/planner-ready.ts). e2e waits on `data-loaded`; a skeleton
 *    that outlived it, or a view that mounted under it, would split them.
 *  - A failed load is settled: the view (and its Retry notice) shows, not bars
 *    that imply progress which is never coming.
 *  - The week COLUMN skeletons flip `data-wide` with the views they stand in
 *    for, so every canvas-container keeps the shared left edge — and nothing
 *    carries the week recede's hooks, so the hover dim cannot reach it.
 *  - No accent anywhere (CLAUDE.md's lime rule), and the motion lives outside
 *    the recede region's transition count with both motion vetoes spelled out.
 */

// The views themselves are stubbed: this file is about the swap, and each
// stub is present only when its router decided the planner had settled.
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
import type { Item } from '@/lib/planner-types';

afterEach(() => {
  cleanup();
  usePlannerStore.getState().clearStore();
});

/** Every state the store's writers leave the readiness fields in. */
const STATES: [string, Record<string, unknown>, boolean][] = [
  ['pre-init', { userId: null, isLoading: false, error: null, loadFailedUserId: null }, false],
  ['identifying', { userId: 'u1', isLoading: true, error: null, loadFailedUserId: null }, false],
  ['loading (retry)', { userId: 'u1', isLoading: true, error: null, loadFailedUserId: null }, false],
  ['settled', { userId: 'u1', isLoading: false, error: null, loadFailedUserId: null }, true],
  ['failed', { userId: 'u1', isLoading: false, error: 'boom', loadFailedUserId: 'u1' }, true],
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

describe('the canvas swaps skeleton ⇄ view on one predicate', () => {
  for (const [scope, layout] of DESKTOP) {
    it(`desktop ${scope} × ${layout}`, () => {
      useViewStore.setState({ scope, layout });
      for (const [name, state, settled] of STATES) {
        usePlannerStore.setState(state);
        render(<ViewRouter />);
        const loaded = viewRoot().dataset.loaded;
        expect(!!skeleton(), name).toBe(loaded === 'false');
        expect(loaded, name).toBe(settled ? 'true' : 'false');
        expect(!!screen.queryByTestId('view-stub'), name).toBe(settled);
        if (!settled) {
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
      for (const [name, state, settled] of STATES) {
        usePlannerStore.setState(state);
        render(<MobileViewRouter />);
        const loaded = viewRoot().dataset.loaded;
        expect(!!skeleton(), name).toBe(loaded === 'false');
        expect(loaded, name).toBe(settled ? 'true' : 'false');
        expect(!!screen.queryByTestId('view-stub'), name).toBe(settled);
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
