import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

/**
 * Where finished rows sink, surface by surface — mounted, not reimplemented.
 *
 * The predicate itself is covered by completed-sinks.test.ts. What only a mount
 * can show is the SCOPING, which is the whole difficulty of this change:
 *
 *  - Day × Buckets hands over its untimed rows ONLY. Its timed spine carries
 *    `scheduled:{bucket}:before|after:{type}:{id}` drop zones and `inferDropTime`
 *    resolves those as ±30 min from that row's own time, so a completed row
 *    sinking through the spine would make "drop above this row" assign a time on
 *    the far side of the row the pointer was above.
 *  - The week surfaces resolve completion at the COLUMN's date, not at the
 *    store's `selectedDate`. A recurring row completed on Thursday must sink in
 *    Thursday's column and nowhere else.
 *  - The braindump has no date at all, so only its one-shot rows move.
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
  restoreItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  fetchRoutines: vi.fn(async () => []),
  fetchPrograms: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import { Braindump } from '@/components/sidebar/braindump';
import { DayList } from '@/components/views/day-list';
import { WeekList } from '@/components/views/week-list';
import { DayBuckets } from '@/components/views/day-buckets';
import { WeekBuckets } from '@/components/views/week-buckets';
import { DaySchedule } from '@/components/views/day-schedule';
import { WeekSchedule } from '@/components/views/week-schedule';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import { toDateStr } from '@/lib/recurrence';
import type { HabitItem, Task } from '@/lib/planner-types';
import { enableGoalsAndOrganize } from './support/extensions';

const TZ = 'UTC';
/** A Thursday; the default week runs Sun 2026-08-09 → Sat 2026-08-15. */
const THURSDAY = '2026-08-13';
const FRIDAY = '2026-08-14';
const THURSDAY_DATE = new Date(`${THURSDAY}T12:00:00Z`);

const task = (over: Partial<Task>): Task =>
  ({
    status: 'pending',
    isScheduled: true,
    order: 0,
    startDate: THURSDAY,
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

function seedStore(over: Record<string, unknown>) {
  // One case here groups by Goal, which rides an extension that ships off.
  enableGoalsAndOrganize();
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: TZ,
    selectedDate: THURSDAY_DATE,
    weekStartDay: 'sunday',
    navDirection: null,
    tasks: [],
    habits: [],
    items: [] as never,
    projects: [
      { id: 'p1', name: 'Work', emoji: '💼' },
      { id: 'p2', name: 'Home', emoji: '🏠' },
    ],
    routines: [],
    programs: [],
    goals: [],
    // Completed rows have to be PRESENT before they can be positioned — both
    // of the app's existing controls hide them outright.
    showCompletedTasks: true,
    showPausedOnGrid: true,
    showCurrentTimeIndicator: false,
    ...over,
  });
  useViewStore.setState({
    canvasGroupBy: 'none',
    canvasSortBy: 'default',
    canvasFilters: EMPTY_VIEW_FILTERS,
    braindumpGroupBy: 'none',
    braindumpSortBy: 'default',
    braindumpFilters: EMPTY_VIEW_FILTERS,
    typeFilter: 'all',
    collapsedBuckets: [],
    bucketStyle: 'spine',
  });
}

const mount = (ui: React.ReactElement) => render(<DndContext>{ui}</DndContext>);

/** Row titles under `root`, in DOM order. */
const rowTitles = (root: ParentNode, names: RegExp): string[] =>
  [...root.querySelectorAll('[data-testid="item-card"]')]
    .map((el) => el.textContent ?? '')
    .map((text) => text.match(names)?.[0] ?? '')
    .filter(Boolean);

const NAMES = /Alpha|Bravo|Charlie|Delta|Nine|Ten|Eleven|Stretch|Journal/;

/** One droppable's subtree, by its contract id. */
function droppable(dndId: string): HTMLElement {
  const root = document.querySelector(`[data-dnd-id="${CSS.escape(dndId)}"]`);
  if (!root) throw new Error(`no droppable ${dndId} in the DOM`);
  return root as HTMLElement;
}

afterEach(cleanup);

/* ── Braindump ──────────────────────────────────────────────────────────────*/

describe('Braindump', () => {
  beforeEach(() => {
    const rows = [
      task({ id: 'a', title: 'Alpha', status: 'completed', isScheduled: false, timeBucket: undefined }),
      task({ id: 'b', title: 'Bravo', isScheduled: false, timeBucket: undefined }),
      task({ id: 'c', title: 'Charlie', status: 'completed', isScheduled: false, timeBucket: undefined }),
      task({ id: 'd', title: 'Delta', isScheduled: false, timeBucket: undefined }),
    ];
    seedStore({ tasks: rows, items: rows });
  });

  it('sinks finished rows and keeps the capture order inside each half', () => {
    mount(<Braindump />);

    expect(rowTitles(screen.getByTestId('braindump'), NAMES)).toEqual([
      'Bravo',
      'Delta',
      'Alpha',
      'Charlie',
    ]);
  });

  it('leaves a RECURRING row alone — the surface has no date to resolve it at', () => {
    // A recurring row in the braindump renders with no completion mark at all
    // (TaskRow's `suppressCompletedLook`, issue #181), because the list has no
    // date column of its own. Sinking it would move a row that shows no reason
    // to have moved.
    //
    // Marked done on BOTH plausible substitutes for the null — the real today
    // (which the braindump's own suppression pass resolves at) and the store's
    // selectedDate — so neither can quietly slip in and still pass.
    const recurring = task({
      id: 'r',
      title: 'Alpha',
      isScheduled: false,
      timeBucket: undefined,
      repeatFrequency: 'daily',
      completedDates: [THURSDAY, toDateStr(new Date(), TZ)],
    } as Partial<Task>);
    const plain = task({ id: 'p', title: 'Bravo', isScheduled: false, timeBucket: undefined });
    seedStore({ tasks: [recurring, plain], items: [recurring, plain] });

    mount(<Braindump />);

    expect(rowTitles(screen.getByTestId('braindump'), NAMES)).toEqual(['Alpha', 'Bravo']);
  });
});

/* ── Day × List ─────────────────────────────────────────────────────────────*/

describe('Day × List', () => {
  it('sinks finished rows inside each group', () => {
    const rows = [
      task({ id: 'a', title: 'Alpha', status: 'completed' }),
      task({ id: 'b', title: 'Bravo' }),
      task({ id: 'c', title: 'Charlie', status: 'completed' }),
      task({ id: 'd', title: 'Delta' }),
    ];
    seedStore({ tasks: rows, items: rows });

    mount(<DayList />);

    expect(rowTitles(document, NAMES)).toEqual(['Bravo', 'Delta', 'Alpha', 'Charlie']);
  });

  it('sinks a habit ticked TODAY without touching one ticked another day', () => {
    // The date-aware case, on a real surface. Both habits carry a completion;
    // only Thursday's belongs to the rendered day.
    const habits = [
      habit({ id: 'today', title: 'Stretch', completedDates: [THURSDAY] }),
      habit({ id: 'tomorrow', title: 'Journal', completedDates: [FRIDAY] }),
    ];
    seedStore({ habits, items: habits });

    mount(<DayList />);

    expect(rowTitles(document, NAMES)).toEqual(['Journal', 'Stretch']);
  });
});

/* ── Week × List ────────────────────────────────────────────────────────────*/

describe('Week × List', () => {
  it('resolves completion per DAY SECTION, not at the selected date', () => {
    // A daily habit ticked on Thursday only. Thursday's section sinks it under
    // the pending one; Friday's must leave it exactly where the derivation put
    // it. Resolving all seven columns at `selectedDate` sinks it in both.
    const habits = [
      habit({ id: 'stretch', title: 'Stretch', completedDates: [THURSDAY] }),
      habit({ id: 'journal', title: 'Journal' }),
    ];
    seedStore({ habits, items: habits });

    mount(<WeekList />);

    const sections = [...document.querySelectorAll('section')].filter((s) =>
      /Stretch/.test(s.textContent ?? '')
    );
    // Sun–Wed carry no completion, Thursday does, Fri/Sat do not — seven
    // sections, all holding both habits, and only one reordered.
    expect(sections).toHaveLength(7);
    const thursday = sections.find((s) => /August 13/.test(s.querySelector('button')?.title ?? ''))!;
    const friday = sections.find((s) => /August 14/.test(s.querySelector('button')?.title ?? ''))!;

    expect(rowTitles(thursday, NAMES)).toEqual(['Journal', 'Stretch']);
    expect(rowTitles(friday, NAMES)).toEqual(['Stretch', 'Journal']);
  });
});

/* ── Day × Buckets ──────────────────────────────────────────────────────────*/

describe('Day × Buckets', () => {
  it('sinks finished UNTIMED rows and leaves the timed spine in time order', () => {
    // Nine is completed and Eleven is not. If the sink reached the spine, Nine
    // would land under Eleven — and "drop above Eleven" would then assign
    // 08:30, half an hour before the row the pointer was nowhere near.
    const tasks = [
      task({ id: 'a', title: 'Alpha', status: 'completed' }),
      task({ id: 'b', title: 'Bravo' }),
      task({ id: 'nine', title: 'Nine', startTime: '09:00', status: 'completed' }),
      task({ id: 'ten', title: 'Ten', startTime: '10:00' }),
      task({ id: 'eleven', title: 'Eleven', startTime: '11:00' }),
    ];
    seedStore({ tasks, items: tasks });

    mount(<DayBuckets activeId={null} />);

    const card = document.querySelector('[data-dnd-bucket="morning"]') as HTMLElement;
    // Untimed section sunk; spine untouched, still 09:00 → 10:00 → 11:00.
    expect(rowTitles(card, NAMES)).toEqual(['Bravo', 'Alpha', 'Nine', 'Ten', 'Eleven']);
    // And the sunk row really is inside the untimed droppable, not merely
    // ahead of the spine in document order.
    expect(rowTitles(droppable('unscheduled:morning'), NAMES)).toEqual(['Bravo', 'Alpha']);
  });

  it('sinks inside each GROUP, without moving the sections', () => {
    // Grouping owns the outer order (lib/grouping.ts, rule 1): the group map is
    // filled by walking the rows, so sinking the flat list first would make the
    // HEADINGS move. Work's completed row must drop within Work.
    // Work's completed row leads the list, and Home's row sits between Work's
    // two. Sink the FLAT list first and Charlie becomes the first row the group
    // map meets, so the headings come back ['Home', 'Work'].
    const tasks = [
      task({ id: 'a', title: 'Alpha', project: 'Work', status: 'completed' }),
      task({ id: 'c', title: 'Charlie', project: 'Home' }),
      task({ id: 'b', title: 'Bravo', project: 'Work' }),
    ];
    seedStore({ tasks, items: tasks });
    useViewStore.setState({ canvasGroupBy: 'project' });

    mount(<DayBuckets activeId={null} />);

    const card = document.querySelector('[data-dnd-bucket="morning"]') as HTMLElement;
    const headings = [...card.querySelectorAll('button[aria-expanded]')]
      .filter((el) => el.className.includes('group/heading'))
      .map((el) => el.textContent?.trim());

    expect(headings).toEqual(['Work', 'Home']);
    expect(rowTitles(card, NAMES)).toEqual(['Bravo', 'Alpha', 'Charlie']);
  });
});

/* ── Week × Buckets ─────────────────────────────────────────────────────────*/

describe('Week × Buckets', () => {
  it('sinks the whole cell — there is no spine to protect', () => {
    // Unlike Day × Buckets: the cell is one `week:{date}:{bucket}` droppable
    // with no per-row drop zones, so a timed row may move too.
    const tasks = [
      task({ id: 'nine', title: 'Nine', startTime: '09:00', status: 'completed' }),
      task({ id: 'ten', title: 'Ten', startTime: '10:00' }),
    ];
    seedStore({ tasks, items: tasks });

    mount(<WeekBuckets activeId={null} />);

    expect(rowTitles(droppable(`week:${THURSDAY}:morning`), NAMES)).toEqual(['Ten', 'Nine']);
  });

  it('resolves completion per COLUMN', () => {
    const habits = [
      habit({ id: 'stretch', title: 'Stretch', completedDates: [THURSDAY] }),
      habit({ id: 'journal', title: 'Journal' }),
    ];
    seedStore({ habits, items: habits });

    mount(<WeekBuckets activeId={null} />);

    expect(rowTitles(droppable(`week:${THURSDAY}:morning`), NAMES)).toEqual(['Journal', 'Stretch']);
    expect(rowTitles(droppable(`week:${FRIDAY}:morning`), NAMES)).toEqual(['Stretch', 'Journal']);
  });

  it('sinks inside each GROUP, without moving the sections', () => {
    // The grouped branch is a SECOND call site with its own argument, not a
    // reuse of the flat one: it applies the sink per group and on the unsunk
    // rows, because `groupRows` takes its section order from whichever group
    // owns the first row it walks (lib/grouping.ts, rule 1). Sink the flat list
    // first and Charlie leads, so the headings come back ['Home', 'Work'].
    //
    // The Day × Buckets counterpart of this test guards the same rule for that
    // view; without this one, dropping the sink from the week's grouped map
    // leaves the whole suite green.
    const tasks = [
      task({ id: 'a', title: 'Alpha', project: 'Work', status: 'completed' }),
      task({ id: 'c', title: 'Charlie', project: 'Home' }),
      task({ id: 'b', title: 'Bravo', project: 'Work' }),
    ];
    seedStore({ tasks, items: tasks });
    useViewStore.setState({ canvasGroupBy: 'project' });

    mount(<WeekBuckets activeId={null} />);

    const cell = droppable(`week:${THURSDAY}:morning`);
    const headings = [...cell.querySelectorAll('button[aria-expanded]')]
      .filter((el) => el.className.includes('group/heading'))
      .map((el) => el.textContent?.trim());

    expect(headings).toEqual(['Work', 'Home']);
    expect(rowTitles(cell, NAMES)).toEqual(['Bravo', 'Alpha', 'Charlie']);
  });
});

/* ── the two existing controls still win ────────────────────────────────────*/

/* ── the sink against the group-by that landed beside it ────────────────────*/

describe('sinking composes with GROUP BY GOAL', () => {
  /**
   * These two shipped as separate branches that touched the same five call
   * sites, and the merge resolved by hand. Goal is the group-by worth pinning
   * against the sink because it is the only MANY-TO-MANY one: an item serving
   * two goals lands in the first that claims it, in store order, and the
   * claim is made while walking the goals — not while walking the rows.
   *
   * So the failure mode is specific. Sink the flat list before grouping and
   * the claim order is untouched (unlike project, where the headings move) —
   * what moves instead is nothing, and the bug hides. Sink per group and the
   * rows fall correctly inside a section the claim already fixed. The test
   * asserts BOTH halves: the claim, and the position within it.
   */
  const goal = (id: string, name: string, memberIds: string[]) => ({
    id,
    name,
    state: 'active' as const,
    memberIds,
    milestoneIds: [],
    checkinIds: [],
  });

  it('sinks inside each goal section, and the claim still decides the section', () => {
    // Charlie serves BOTH goals; Chinese is first in store order, so Chinese
    // claims it. Alpha (Chinese) is finished and must fall to Chinese's foot
    // without Chinese and Fitness trading places.
    const tasks = [
      task({ id: 'a', title: 'Alpha', status: 'completed' }),
      task({ id: 'c', title: 'Charlie' }),
      task({ id: 'b', title: 'Bravo' }),
    ];
    seedStore({
      tasks,
      items: tasks,
      goals: [goal('g-cn', 'Learn Chinese', ['a', 'c']), goal('g-fit', 'Get Fit', ['c', 'b'])],
    });
    useViewStore.setState({ canvasGroupBy: 'goal' });

    mount(<DayBuckets activeId={null} />);

    const card = document.querySelector('[data-dnd-bucket="morning"]') as HTMLElement;
    const headings = [...card.querySelectorAll('button[aria-expanded]')]
      .filter((el) => el.className.includes('group/heading'))
      .map((el) => el.textContent?.trim());

    expect(headings).toEqual(['Learn Chinese', 'Get Fit']);
    // Chinese holds Charlie then Alpha (sunk); Fitness holds only Bravo,
    // because Charlie was already claimed.
    expect(rowTitles(card, NAMES)).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('sinks inside "No goal" too — a goal heading is not what makes rows sink', () => {
    // The aspire kind suppresses nothing and carries no gate, so there is no
    // per-section switch that could be doing this. The loose bucket gets the
    // same pass as a claimed one.
    const tasks = [
      task({ id: 'a', title: 'Alpha', status: 'completed' }),
      task({ id: 'b', title: 'Bravo' }),
    ];
    seedStore({ tasks, items: tasks, goals: [goal('g-cn', 'Learn Chinese', [])] });
    useViewStore.setState({ canvasGroupBy: 'goal' });

    mount(<DayBuckets activeId={null} />);

    const card = document.querySelector('[data-dnd-bucket="morning"]') as HTMLElement;
    expect(rowTitles(card, NAMES)).toEqual(['Bravo', 'Alpha']);
  });
});

describe('the sink is always on, and composes with the controls that hide', () => {
  it('has nothing to move once showCompletedTasks removes the rows', () => {
    // Why this is not a fourth setting: `showCompletedTasks` and the Display
    // menu's hideFinished already decide whether finished rows are there at
    // all, so the sink only ever acts for a user who asked to keep seeing them.
    const tasks = [
      task({ id: 'a', title: 'Alpha', status: 'completed' }),
      task({ id: 'b', title: 'Bravo' }),
    ];
    seedStore({ tasks, items: tasks, showCompletedTasks: false });

    mount(<DayList />);

    expect(rowTitles(document, NAMES)).toEqual(['Bravo']);
  });

  it('also has nothing to move under the Display menu\'s Hide finished', () => {
    const habits = [
      habit({ id: 'stretch', title: 'Stretch', completedDates: [THURSDAY] }),
      habit({ id: 'journal', title: 'Journal' }),
    ];
    seedStore({ habits, items: habits });
    useViewStore.setState({ canvasFilters: { ...EMPTY_VIEW_FILTERS, hideFinished: true } });

    mount(<DayList />);

    expect(rowTitles(document, NAMES)).toEqual(['Journal']);
  });
});

/* ── Day × Schedule / Week × Schedule ───────────────────────────────────────*/

describe('Schedule', () => {
  it('Day × Schedule sinks finished rows in the Anytime strip only', () => {
    const tasks = [
      task({ id: 'a', title: 'Alpha', status: 'completed', timeBucket: 'anytime' }),
      task({ id: 'b', title: 'Bravo', timeBucket: 'anytime' }),
      task({ id: 'nine', title: 'Nine', startTime: '09:00', status: 'completed' }),
      task({ id: 'ten', title: 'Ten', startTime: '10:00' }),
    ];
    seedStore({ tasks, items: tasks });

    mount(<DaySchedule activeId={null} />);

    expect(rowTitles(droppable('unscheduled:anytime'), NAMES)).toEqual(['Bravo', 'Alpha']);
  });

  it('Day × Schedule renders an empty Anytime strip while dragging', () => {
    const tasks = [task({ id: 'nine', title: 'Nine', startTime: '09:00' })];
    seedStore({ tasks, items: tasks });

    mount(<DaySchedule activeId="nine" />);

    expect(droppable('unscheduled:anytime').textContent).toMatch(/Drop here/);
  });

  it('Week × Schedule sinks per column, at that column\'s date', () => {
    const habits = [
      habit({ id: 'stretch', title: 'Stretch', timeBucket: 'anytime', completedDates: [THURSDAY] }),
      habit({ id: 'journal', title: 'Journal', timeBucket: 'anytime' }),
    ];
    seedStore({ habits, items: habits });

    mount(<WeekSchedule activeId={null} />);

    expect(rowTitles(droppable(`week:${THURSDAY}:anytime`), NAMES)).toEqual(['Journal', 'Stretch']);
    expect(rowTitles(droppable(`week:${FRIDAY}:anytime`), NAMES)).toEqual(['Stretch', 'Journal']);
  });
});
