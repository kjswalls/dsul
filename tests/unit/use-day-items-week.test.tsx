import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

/**
 * The week pipeline resolves EVERY column at its own date, from ONE
 * implementation.
 *
 * Week × Schedule used to inline deriveDayItems itself, as a verbatim copy of
 * use-day-items' body — including the per-column `inactiveItemIds` block and its
 * comment. It had to: the shared hour range spans the union of all seven days,
 * so it needs every column resolved before it can size any of them, and a
 * singular hook cannot be called in a loop. The copy is now gone and the hook is
 * plural.
 *
 * These test the hook rather than the rendered grid because the grid's own
 * concerns (hour range, overlap, the boundary rail) are not what regressed —
 * the pipeline was. Two properties matter, and a careless re-fold breaks each in
 * a different direction:
 *
 *   1. Per-column DATE resolution. Hoisting `inactiveItemIdsOn` out of the loop
 *      is the obvious "optimisation", and it resolves all seven columns at
 *      whichever date built the set. That is the wrong-date bug the seasons
 *      work shipped twice.
 *   2. Filters reaching all seven. The point of one pipeline is that a rule
 *      added for the day views arrives here for free.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  createItemType: vi.fn(async () => {}),
  updateItemType: vi.fn(async () => {}),
  deleteItemType: vi.fn(async () => {}),
  createItem: vi.fn(async () => {}),
  updateItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  restoreItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  createProject: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  deleteProject: vi.fn(async () => {}),
  restoreProject: vi.fn(async () => {}),
  fetchRoutines: vi.fn(async () => []),
  createRoutine: vi.fn(async () => {}),
  updateRoutine: vi.fn(async () => {}),
  deleteRoutine: vi.fn(async () => {}),
  restoreRoutine: vi.fn(async () => {}),
  fetchSeasons: vi.fn(async () => []),
  createSeason: vi.fn(async () => {}),
  updateSeason: vi.fn(async () => {}),
  deleteSeason: vi.fn(async () => {}),
  restoreSeason: vi.fn(async () => {}),
  fetchGoals: vi.fn(async () => []),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import { useDayItems, useDayItemsForDates } from '@/hooks/use-day-items';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { EMPTY_VIEW_FILTERS, type ViewFilters } from '@/lib/filters';
import type { DayItems } from '@/lib/day-items';
import type { Goal, Item } from '@/lib/planner-types';
import { enableGoalsAndOrganize } from './support/extensions';

/** Mon 13th → Sun 19th July 2026. UTC throughout so dateStr is unambiguous. */
const WEEK = ['13', '14', '15', '16', '17', '18', '19'].map(
  (d) => new Date(`2026-07-${d}T12:00:00Z`)
);
const WED = 2;
const FRI = 4;

/**
 * A daily habit paused across the first half of the week.
 *
 * `pausedUntil` is EXCLUSIVE, so 07-16 is the first live day: suppressed Mon /
 * Tue / Wed, live Thu → Sun. A hoisted inactive-set collapses that split to
 * all-seven or none.
 */
const HABIT: Item = {
  type: 'habit',
  id: 'h-stretch',
  title: 'Stretch',
  project: 'Health',
  status: 'pending',
  streak: 0,
  completedDates: [],
  skippedDates: [],
  repeatFrequency: 'daily',
  timeBucket: 'morning',
  order: 0,
  isScheduled: false,
  pausedAt: '2026-07-01T09:00:00Z',
  pausedUntil: '2026-07-16',
} as unknown as Item;

const WED_TASK: Item = {
  type: 'task',
  id: 't-wed',
  title: 'Wednesday thing',
  status: 'pending',
  isScheduled: false,
  order: 0,
  startDate: '2026-07-15',
  timeBucket: 'morning',
  project: 'Work',
} as unknown as Item;

const FRI_TASK: Item = {
  type: 'task',
  id: 't-fri',
  title: 'Friday thing',
  status: 'pending',
  isScheduled: false,
  order: 0,
  startDate: '2026-07-17',
  timeBucket: 'morning',
  project: 'Side',
} as unknown as Item;

function seed(opts: { showPausedOnGrid?: boolean; filters?: ViewFilters; goals?: Goal[] } = {}) {
  const items = [HABIT, WED_TASK, FRI_TASK];
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: 'UTC',
    selectedDate: WEEK[WED],
    items,
    tasks: items.filter((i) => i.type !== 'habit') as never,
    habits: items.filter((i) => i.type === 'habit') as never,
    projects: [],
    routines: [],
    seasons: [],
    showCompletedTasks: true,
    showPausedOnGrid: opts.showPausedOnGrid ?? false,
    goals: opts.goals ?? [],
  });
  useViewStore.setState({
    typeFilter: 'all',
    canvasFilters: opts.filters ?? EMPTY_VIEW_FILTERS,
  });
}

/** Every id a column shows, across all buckets and both kinds. */
const idsOf = (d: DayItems): string[] => [
  ...Object.values(d.tasksByBucket).flat().map((t) => t.id),
  ...Object.values(d.habitsByBucket).flat().map((h) => h.id),
];

const week = () => renderHook(() => useDayItemsForDates(WEEK)).result.current;

// The GOAL clause below is the Goals extension's, and it ships off.
beforeEach(() => {
  enableGoalsAndOrganize();
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('useDayItemsForDates', () => {
  it('returns one result per date, each keyed to its own day', () => {
    seed();
    const days = week();

    expect(days).toHaveLength(7);
    expect(days[WED].tasksByBucket.morning.map((t) => t.id)).toEqual(['t-wed']);
    expect(days[FRI].tasksByBucket.morning.map((t) => t.id)).toEqual(['t-fri']);
    // Mon carries neither — a column resolved at the wrong date would leak one in.
    expect(days[0].tasksByBucket.morning).toEqual([]);
  });

  it('applies the pause per COLUMN, so the handoff lands mid-week', () => {
    seed();
    const shows = week().map((d) => idsOf(d).includes('h-stretch'));

    // Mon Tue Wed suppressed; Thu is the exclusive upper bound, so it is live.
    expect(shows).toEqual([false, false, false, true, true, true, true]);
  });

  it('shows the paused habit in every column when showPausedOnGrid is on', () => {
    // The preference drops the exclusion rather than emptying the set — the rows
    // re-ask the resolver at their own date to render greyed.
    seed({ showPausedOnGrid: true });

    expect(week().map((d) => idsOf(d).includes('h-stretch'))).toEqual(
      Array(7).fill(true)
    );
  });

  it('narrows every column by the canvas filters, not just the selected day', () => {
    seed({ filters: { ...EMPTY_VIEW_FILTERS, containers: ['project:Work'] } });
    const days = week();

    expect(days[WED].tasksByBucket.morning.map((t) => t.id)).toEqual(['t-wed']);
    // Friday's task is in a different project, so it goes — and so does the
    // habit, whose GROUP is not among the selected containers. Not because a
    // habit "has no project": Phase 1's rule resolves the container axis per
    // type, and Health is simply not Work.
    expect(days[FRI].tasksByBucket.morning).toEqual([]);
    expect(days.flatMap(idsOf)).toEqual(['t-wed']);
  });

  it('keeps a habit that answers the container axis like everything else', () => {
    // `project:`, not the retired `group:` prefix — 039. A stored blob still
    // holding the old one is rewritten by `normalizeFilters` on read.
    seed({ filters: { ...EMPTY_VIEW_FILTERS, containers: ['project:Health'] } });
    const days = week();

    // Live columns keep the habit; both tasks go (neither is in a group).
    expect(days.map((d) => idsOf(d))).toEqual([
      [], [], [], ['h-stretch'], ['h-stretch'], ['h-stretch'], ['h-stretch'],
    ]);
  });

  it('narrows every column by the GOAL clause, resolved once for the week', () => {
    // The wiring case: `deriveDayItems` cannot ask an item row about
    // `goal_items`, so the hook resolves the selection and hands one id set to
    // all seven columns. Membership is dateless, which is why one set is right
    // here where the pause exclusion above needs one per column.
    seed({
      filters: { ...EMPTY_VIEW_FILTERS, goals: ['g1'] },
      goals: [
        {
          id: 'g1',
          name: 'Learn Chinese',
          state: 'active',
          memberIds: ['h-stretch'],
          milestoneIds: ['t-fri'],
          checkinIds: [],
        },
      ],
    });
    const days = week();

    // The member habit and the MILESTONE task both survive; Wednesday's
    // unrelated task does not. A milestone's startDate is its target date, so
    // it shows on the day it is aimed at — Friday.
    expect(days[WED].tasksByBucket.morning).toEqual([]);
    expect(days[FRI].tasksByBucket.morning.map((t) => t.id)).toEqual(['t-fri']);
    expect(days.flatMap(idsOf).sort()).toEqual([
      'h-stretch', 'h-stretch', 'h-stretch', 'h-stretch', 't-fri',
    ]);
  });

  it('leaves every column whole when the selected goal has ENDED', () => {
    // Inert rather than empty — see lib/goals.ts. A blank week with a filter
    // naming a goal that is finished is the stale-ref failure all over again.
    seed({
      filters: { ...EMPTY_VIEW_FILTERS, goals: ['g1'] },
      goals: [
        {
          id: 'g1',
          name: 'Learn Chinese',
          state: 'achieved',
          memberIds: ['h-stretch'],
          milestoneIds: [],
          checkinIds: [],
        },
      ],
    });

    expect(week().flatMap(idsOf)).toContain('t-wed');
  });

  it('reuses the memo across renders, and re-derives when an instant moves', () => {
    // The key is getTime(), not array identity — so a fresh array of the same
    // instants must NOT re-derive. Every caller passes an array literal or a
    // mapped week, so without this the whole grid recomputes each render.
    seed();
    const { result, rerender } = renderHook(({ dates }) => useDayItemsForDates(dates), {
      initialProps: { dates: WEEK.map((d) => new Date(d)) },
    });
    const first = result.current;

    rerender({ dates: WEEK.map((d) => new Date(d)) });
    expect(result.current).toBe(first);

    rerender({ dates: WEEK.map((d) => new Date(d.getTime() + 7 * 86400_000)) });
    expect(result.current).not.toBe(first);
  });
});

describe('useDayItems', () => {
  it('is the one-element case, and defaults to the selected day', () => {
    seed();
    const one = renderHook(() => useDayItems()).result.current;

    // selectedDate is Wednesday.
    expect(one.tasksByBucket.morning.map((t) => t.id)).toEqual(['t-wed']);
  });

  it('agrees with the plural hook for the same date', () => {
    seed();
    const plural = week()[FRI];
    const single = renderHook(() => useDayItems(WEEK[FRI])).result.current;

    expect(idsOf(single)).toEqual(idsOf(plural));
    expect(single.totalCount).toBe(plural.totalCount);
  });
});
