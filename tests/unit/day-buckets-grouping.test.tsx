import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

/**
 * Grouping on Day × Buckets, tested through the RENDERED card.
 *
 * Two things need a mount rather than a call. The first is that this view
 * honoured `=== 'project'` and nothing else, so a props-level test of the core
 * says nothing about whether the card asks it. The second is the constraint that
 * decides the whole shape of Phase 5a: the timed spine must not be partitioned,
 * because `inferDropTime` resolves `scheduled:{bucket}:before|after:{type}:{id}`
 * as ±30 min from THAT row's own time. Only the DOM can show that it wasn't.
 */

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
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver;
  }
});

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  createItem: vi.fn(async () => {}),
  updateItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import { DayBuckets } from '@/components/views/day-buckets';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import type { GroupBy, HabitItem, Task } from '@/lib/planner-types';

const TZ = 'UTC';
const DATE_STR = '2026-08-13';
const DATE = new Date('2026-08-13T12:00:00Z');

const task = (over: Partial<Task>): Task =>
  ({
    status: 'pending',
    isScheduled: true,
    order: 0,
    startDate: DATE_STR,
    timeBucket: 'morning',
    ...over,
  }) as Task;

const habit = (over: Partial<HabitItem>): HabitItem =>
  ({
    project: 'Health',
    streak: 0,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    repeatFrequency: 'daily',
    timeBucket: 'morning',
    ...over,
  }) as HabitItem;

/**
 * One untimed habit and two untimed tasks in two projects, plus THREE TIMED
 * tasks whose time order is the reverse of their project grouping — so a card
 * that grouped its spine would visibly reorder it.
 */
const tasks: Task[] = [
  task({ id: 'u-work', title: 'Untimed work', project: 'Work' }),
  task({ id: 'u-home', title: 'Untimed home', project: 'Home' }),
  task({ id: 'nine', title: 'Nine', startTime: '09:00', project: 'Home' }),
  task({ id: 'ten', title: 'Ten', startTime: '10:00', project: 'Work' }),
  task({ id: 'eleven', title: 'Eleven', startTime: '11:00', project: 'Home' }),
];
const habits: HabitItem[] = [habit({ id: 'stretch', title: 'Stretch', project: 'Health' })];

function seed(canvasGroupBy: GroupBy) {
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: TZ,
    selectedDate: DATE,
    navDirection: null,
    tasks,
    habits,
    items: [...tasks, ...habits] as never,
    // ONE container list since 039 — 'Health' used to be a habit group, and
    // the habit that names it is now an ordinary member of a project.
    projects: [
      { id: 'p1', name: 'Work', emoji: '💼' },
      { id: 'p2', name: 'Home', emoji: '🏠' },
      { id: 'g1', name: 'Health', emoji: '💚' },
    ],
    routines: [],
    seasons: [],
    showCompletedTasks: true,
    showPausedOnGrid: true,
  });
  useViewStore.setState({
    canvasGroupBy,
    canvasSortBy: 'default',
    canvasFilters: EMPTY_VIEW_FILTERS,
    typeFilter: 'all',
    collapsedBuckets: [],
    bucketStyle: 'spine',
  });
}

const renderBuckets = () =>
  render(
    <DndContext>
      <DayBuckets activeId={null} />
    </DndContext>
  );

/** The Morning card — the only bucket these fixtures use. */
const morning = () => document.querySelector('[data-dnd-bucket="morning"]') as HTMLElement;

/**
 * GroupSection headings inside the card, in render order.
 *
 * Matched on `group/heading` rather than on `button[aria-expanded]` alone,
 * because BucketCard's own collapse toggle carries that attribute too and would
 * read "Morning" at the front of every answer.
 */
const headings = (root: HTMLElement) =>
  [...root.querySelectorAll('button[aria-expanded]')]
    .filter((el) => el.className.includes('group/heading'))
    .map((el) => el.textContent?.trim());

/** Row titles inside the card, in DOM order. */
const rowOrder = (root: HTMLElement) =>
  within(root)
    .getAllByText(/^(Untimed work|Untimed home|Nine|Ten|Eleven|Stretch)$/)
    .map((el) => el.textContent);

afterEach(cleanup);
beforeEach(() => seed('none'));

describe('Day × Buckets grouping', () => {
  it('renders HABITS then TASKS when nothing is grouped', () => {
    renderBuckets();
    expect(headings(morning())).toEqual(['Habits', 'Tasks']);
  });

  it('sections the untimed rows by container, habits included', () => {
    // Not "Habits" + the tasks' projects, which is what this card did before:
    // the habit answers the container axis with its GROUP.
    seed('project');
    renderBuckets();

    // First-encounter order, which for these rows is habit-then-tasks: Health
    // (the habit), Work (the first untimed task), Home (the second).
    expect(headings(morning())).toEqual(['Health', 'Work', 'Home']);
  });

  it('leaves the TIMED spine in time order, ungrouped, and renders it once', () => {
    // The constraint the whole phase is shaped around. Nine/Eleven are in Home
    // and Ten is in Work, so any partition of the spine would pull Eleven up
    // beside Nine — and then "drop above Eleven" would assign 08:30.
    //
    // The WHOLE sequence, not its tail: the first version of this asserted
    // `slice(-3)` and survived a mutation that handed the timed rows to the
    // grouping pass, because that renders them in the groups AND leaves the
    // spine below intact. Six rows, this order, once each.
    seed('project');
    renderBuckets();

    expect(rowOrder(morning())).toEqual([
      'Stretch',
      'Untimed work',
      'Untimed home',
      'Nine',
      'Ten',
      'Eleven',
    ]);
  });

  it('honours Priority, which used to render identically to None here', () => {
    seed('priority');
    renderBuckets();

    // Both untimed tasks and the habit carry no priority, so they land in one
    // section — the pass-through rule's companion, not a "Habits" hoist.
    expect(headings(morning())).toEqual(['No priority']);
    expect(rowOrder(morning()).slice(0, 3)).toEqual(['Stretch', 'Untimed work', 'Untimed home']);
  });

  it('falls back to the default look for the one value it cannot honour', () => {
    // Time bucket inside a bucket card is one section holding the whole card.
    // groupBySupport says so; this is the card agreeing.
    seed('bucket');
    renderBuckets();

    expect(headings(morning())).toEqual(['Habits', 'Tasks']);
  });
});
