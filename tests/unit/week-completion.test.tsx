import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

/**
 * A week column's completion toggle must write against the day the ROW is drawn
 * for, not the globally selected day.
 *
 * TaskRow already takes a `date` prop (week-buckets / week-list / week-schedule
 * all pass their column's day) and already READS per-date state from it —
 * `taskDone`, `habitDoneOnDate`, `habitCount` and the skip state all derive from
 * `rowDate`. Only the WRITES still reached for the store's `selectedDate`, so
 * ticking Thursday's checkbox while Tuesday was selected marked Tuesday and left
 * Thursday's box empty. The skip write was fixed for #194; this is the same fix
 * for completion.
 *
 * Only per-date (recurring) completion is in scope: a one-off task carries a
 * scalar `status` with no date dimension, and must keep passing `undefined`.
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
  setItemSkip: vi.fn(async () => {}),
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

import { TaskRow, type RowItem } from '@/components/primitives/task-row';
import { usePlannerStore } from '@/lib/planner-store';
import * as db from '@/lib/db';
import type { HabitItem, Item, Task, TaskItem } from '@/lib/planner-types';

const USER = 'user-1';
/** Tuesday — the day the user has SELECTED. */
const SELECTED = '2026-07-14';
/** Thursday — the column the user actually clicks in. */
const ROW_DAY = '2026-07-16';

const asDate = (ymd: string) => new Date(`${ymd}T12:00:00Z`);

const store = () => usePlannerStore.getState();
const taskById = (id: string) => store().items.find((i) => i.id === id) as TaskItem;
const habitById = (id: string) => store().items.find((i) => i.id === id) as HabitItem;

const fixtures = (): Item[] => [
  {
    type: 'task',
    id: 'daily-task',
    title: 'Water the plants',
    status: 'pending',
    isScheduled: false,
    timeBucket: 'anytime',
    order: 0,
    startDate: '2026-07-01',
    repeatFrequency: 'daily',
    completedDates: [],
    skippedDates: [],
  },
  {
    type: 'task',
    id: 'one-shot',
    title: 'File taxes',
    status: 'pending',
    isScheduled: false,
    timeBucket: 'anytime',
    order: 1,
    startDate: SELECTED,
    completedDates: [],
    skippedDates: [],
  },
  {
    type: 'habit',
    id: 'habit-1',
    title: 'Stretch',
    project: 'Wellness',
    streak: 2,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
  },
  {
    type: 'habit',
    id: 'habit-3x',
    title: 'Drink water',
    project: 'Wellness',
    streak: 0,
    status: 'pending',
    timesPerDay: 3,
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
  },
];

/**
 * jsdom ships no matchMedia, and TaskRow's useIsMobile calls it on mount.
 * Stubbed here rather than in tests/unit/setup.ts so no other suite's
 * environment changes underneath it. Always "desktop": the hover control
 * cluster (skip, stepper) is what these assertions click.
 */
beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
});
afterEach(() => vi.unstubAllGlobals());

beforeEach(async () => {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(fixtures());
  await store().initializeStore(USER);
  usePlannerStore.setState({ selectedDate: asDate(SELECTED), userTimezone: 'UTC' });
});

afterEach(cleanup);

/**
 * TaskRow takes its item as a PROP, so a wrapper that subscribes to the store
 * is what makes the row re-render after a write — same as the real views, which
 * feed it out of useDayItems. Without it the row would keep painting the
 * pre-click snapshot and the "did the box I ticked fill in" assertion below
 * would be vacuous.
 */
function LiveRow({ id, date }: { id: string; date?: Date }) {
  const item = usePlannerStore((s) => s.items.find((i) => i.id === id))!;
  const row: RowItem =
    item.type === 'habit'
      ? { itemType: 'habit', item: item as unknown as HabitItem }
      : { itemType: 'task', item: item as unknown as Task };
  return <TaskRow row={row} date={date} />;
}

/** Renders one row for a given column day; omit `date` for the day views. */
const renderRow = (id: string, date?: Date) => render(<LiveRow id={id} date={date} />);

const complete = () => fireEvent.click(screen.getByTestId('item-complete-button'));

describe('recurring task completion in a week column', () => {
  it('completes the row date, not the selected date', () => {
    renderRow('daily-task', asDate(ROW_DAY));
    complete();

    expect(taskById('daily-task').completedDates).toEqual([ROW_DAY]);
    expect(taskById('daily-task').completedDates).not.toContain(SELECTED);
    expect(db.setItemCompletion).toHaveBeenCalledWith('daily-task', 'task', ROW_DAY, true);
  });

  it('un-completes the row date too', () => {
    renderRow('daily-task', asDate(ROW_DAY));
    complete();
    complete();

    expect(taskById('daily-task').completedDates).toEqual([]);
    expect(db.setItemCompletion).toHaveBeenLastCalledWith('daily-task', 'task', ROW_DAY, false);
  });

  it('renders the checkbox from the same date it writes', () => {
    // The read side was always right; this pins the two together, because the
    // bug was visible precisely as "the box I ticked did not fill in".
    renderRow('daily-task', asDate(ROW_DAY));
    expect(screen.getByTestId('item-card')).toHaveAttribute('data-completed', 'false');
    complete();
    expect(screen.getByTestId('item-card')).toHaveAttribute('data-completed', 'true');
  });

  it('still uses the selected date when the row has no date of its own', () => {
    renderRow('daily-task');
    complete();
    expect(taskById('daily-task').completedDates).toEqual([SELECTED]);
  });
});

describe('habit completion in a week column', () => {
  it('completes the row date', () => {
    renderRow('habit-1', asDate(ROW_DAY));
    complete();

    const habit = habitById('habit-1');
    expect(habit.completedDates).toEqual([ROW_DAY]);
    expect(habit.completedDates).not.toContain(SELECTED);
    expect(db.setItemCompletion).toHaveBeenCalledWith('habit-1', 'habit', ROW_DAY, true);
  });

  it('counts a multi-count habit against the row date', () => {
    renderRow('habit-3x', asDate(ROW_DAY));
    complete(); // 1 of 3 — a count, not a completion

    const habit = habitById('habit-3x');
    expect(habit.dailyCounts?.[ROW_DAY]).toBe(1);
    expect(habit.dailyCounts?.[SELECTED]).toBeUndefined();
    expect(habit.completedDates).toEqual([]);
  });

  it('steps a multi-count habit down against the row date', () => {
    renderRow('habit-3x', asDate(ROW_DAY));
    complete();
    fireEvent.click(screen.getByTestId('item-stepper-dec'));

    expect(habitById('habit-3x').dailyCounts?.[ROW_DAY]).toBe(0);
    expect(habitById('habit-3x').dailyCounts?.[SELECTED]).toBeUndefined();
  });
});

describe('one-off tasks are unaffected — they have no per-date dimension', () => {
  it('sets the scalar status and writes no completion date', () => {
    renderRow('one-shot', asDate(ROW_DAY));
    complete();

    const task = taskById('one-shot');
    expect(task.status).toBe('completed');
    expect(task.completedDates ?? []).toEqual([]);
    expect(db.setItemCompletion).not.toHaveBeenCalled();
    expect(db.updateItem).toHaveBeenCalledWith('one-shot', 'task', { status: 'completed' });
  });
});

describe('skip (already fixed for #194) stays on the row date', () => {
  it('skips the column day, not the selected day', () => {
    renderRow('daily-task', asDate(ROW_DAY));
    fireEvent.click(screen.getByTestId('item-skip-button'));

    expect(taskById('daily-task').skippedDates).toEqual([ROW_DAY]);
    expect(db.setItemSkip).toHaveBeenCalledWith('daily-task', 'task', ROW_DAY, true);
  });
});
