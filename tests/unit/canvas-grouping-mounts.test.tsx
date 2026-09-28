import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

/**
 * The three canvas mounts Phase 5a wired to `groupBySupport` and left untested:
 * Week × Buckets, Day × Schedule and Week × Schedule.
 *
 * Found by the Phase 5a adversarial review, which mutation-proved the gap —
 * gating `week-buckets.tsx` to `false &&` left the whole suite green. That is
 * precisely the bug this phase exists to fix (a surface silently ignoring the
 * Display menu), and Phase 5b rewrites both Schedules, so landing lanes on an
 * unpinned mount would repeat the Phase 3 failure verbatim.
 *
 * One case per mount, deliberately shallow: does the surface ASK, and does the
 * answer reach the DOM. What each grouping value returns is `grouping.test.ts`'s
 * job; where the sections may go is `day-buckets-grouping.test.tsx`'s.
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
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
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

import { WeekBuckets } from '@/components/views/week-buckets';
import { DaySchedule } from '@/components/views/day-schedule';
import { WeekSchedule } from '@/components/views/week-schedule';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import type { GroupBy, Task } from '@/lib/planner-types';

const TZ = 'UTC';
/** A Thursday; the default week runs Sun 2026-08-09 → Sat 2026-08-15. */
const DATE_STR = '2026-08-13';
const DATE = new Date(`${DATE_STR}T12:00:00Z`);

const task = (over: Partial<Task>): Task =>
  ({
    status: 'pending',
    isScheduled: true,
    order: 0,
    startDate: DATE_STR,
    timeBucket: 'morning',
    ...over,
  }) as Task;

/**
 * Two UNTIMED tasks in two projects. Untimed on purpose: it is the only row kind
 * all three surfaces group — the Schedules only section their Anytime strip, and
 * the Day card only its untimed section.
 */
const tasks: Task[] = [
  task({ id: 'w', title: 'Work thing', project: 'Work' }),
  task({ id: 'h', title: 'Home thing', project: 'Home' }),
];

function seed(canvasGroupBy: GroupBy) {
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: TZ,
    selectedDate: DATE,
    weekStartDay: 'sunday',
    navDirection: null,
    tasks,
    habits: [],
    items: tasks as never,
    projects: [
      { id: 'p1', name: 'Work', emoji: '💼' },
      { id: 'p2', name: 'Home', emoji: '🏠' },
    ],
    routines: [],
    seasons: [],
    showCompletedTasks: true,
    showPausedOnGrid: true,
    showCurrentTimeIndicator: false,
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

const mount = (ui: React.ReactElement) => render(<DndContext>{ui}</DndContext>);

/**
 * GroupSection headings, and only those.
 *
 * Matched on `group/heading` rather than on `button[aria-expanded]`, because
 * BucketCard's own collapse toggle carries that attribute too — it is what makes
 * a week cell answer ['Morning'] before any grouping happens.
 */
const sectionHeadings = (root: ParentNode): string[] =>
  [...root.querySelectorAll('button[aria-expanded]')]
    .filter((el) => el.className.includes('group/heading'))
    .map((el) => el.textContent?.trim() ?? '');

/** Section headings inside one droppable, by its contract id. */
function headingsIn(dndId: string): string[] {
  const root = document.querySelector(`[data-dnd-id="${CSS.escape(dndId)}"]`);
  if (!root) throw new Error(`no droppable ${dndId} in the DOM`);
  return sectionHeadings(root);
}

afterEach(cleanup);
beforeEach(() => seed('none'));

describe('Week × Buckets asks for grouping', () => {
  it('renders a flat cell when nothing is grouped', () => {
    mount(<WeekBuckets activeId={null} />);
    expect(headingsIn(`week:${DATE_STR}:morning`)).toEqual([]);
  });

  it('sections the cell by container', () => {
    seed('project');
    mount(<WeekBuckets activeId={null} />);
    expect(headingsIn(`week:${DATE_STR}:morning`)).toEqual(['Work', 'Home']);
  });
});

describe('Day × Schedule asks for grouping, in the Anytime strip', () => {
  it('renders a flat strip when nothing is grouped', () => {
    mount(<DaySchedule activeId={null} />);
    // The strip's own "Anytime" heading, and nothing under it.
    expect(headingsIn('unscheduled:anytime')).toEqual(['Anytime']);
  });

  it('replaces its own heading with the group headings', () => {
    // Not nested under "Anytime". Two headings deep read as a stutter, and as a
    // literal "Anytime › Anytime" when grouping by time bucket — which the
    // Phase 5a review caught. The strip is already identified by its position
    // and by being the drop target.
    seed('project');
    mount(<DaySchedule activeId={null} />);
    expect(headingsIn('unscheduled:anytime')).toEqual(['Work', 'Home']);
  });

  it('leaves the timed grid alone', () => {
    // Nothing outside the strip gains a section. If 5b's lanes ever regress into
    // headings on the grid, this is what says so.
    seed('project');
    mount(<DaySchedule activeId={null} />);
    expect(sectionHeadings(document)).toEqual(headingsIn('unscheduled:anytime'));
  });
});

describe('Week × Schedule asks for grouping, per column strip', () => {
  it('renders a flat strip when nothing is grouped', () => {
    mount(<WeekSchedule activeId={null} />);
    expect(headingsIn(`week:${DATE_STR}:anytime`)).toEqual([]);
  });

  it('sections each column strip independently', () => {
    seed('project');
    mount(<WeekSchedule activeId={null} />);

    expect(headingsIn(`week:${DATE_STR}:anytime`)).toEqual(['Work', 'Home']);
    // A day holding nothing contributes no heading — seven columns, one
    // partition each, not one partition across the week.
    expect(headingsIn('week:2026-08-14:anytime')).toEqual([]);
  });
});

describe('the row survives the trip', () => {
  it('renders each row exactly once on every surface', () => {
    // A grouping bug that duplicates rows reads as "two checkboxes for one
    // obligation" — the failure the routine branch is shaped to avoid — and a
    // heading assertion alone would not see it.
    seed('project');
    for (const ui of [
      <WeekBuckets key="wb" activeId={null} />,
      <DaySchedule key="ds" activeId={null} />,
      <WeekSchedule key="ws" activeId={null} />,
    ]) {
      const { container } = mount(ui);
      expect(within(container).getAllByText('Work thing')).toHaveLength(1);
      expect(within(container).getAllByText('Home thing')).toHaveLength(1);
      cleanup();
    }
  });
});
