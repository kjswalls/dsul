import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

/**
 * The EOD review's DATE controls must not touch a recurring task.
 *
 * `updateTask(id, { startDate })` rewrites the recurrence ANCHOR, so "move this
 * to tomorrow" on a task that repeats every Tuesday does not move tonight's
 * occurrence — it moves the whole series onto Wednesdays. planner-store's bulk
 * carry says so in as many words ("Callers are responsible for excluding
 * recurring items"); this component was a caller that didn't.
 *
 * There is no per-occurrence date override in the data model, so the fix is not
 * a smarter move: the recurring row is offered "Skip today" instead, through
 * the same setItemSkipped machinery shipped for #194. Sibling of
 * tests/unit/eod-dismiss.test.tsx (#187) and set up identically — real store,
 * real component, db mocked, fixed clock — because the regression lives in the
 * wiring, not in the predicate.
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
  // No RPC: the per-table fallback, started synchronously (the fetchers above).
  loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import { EODReview } from '@/components/ai/eod-review';
import { usePlannerStore } from '@/lib/planner-store';
import { useEODStore } from '@/lib/eod-store';
import * as db from '@/lib/db';
import type { Item, TaskItem } from '@/lib/planner-types';

const USER = 'user-1';
const TODAY = '2026-07-14'; // a Tuesday
const TOMORROW = '2026-07-15';

const store = () => usePlannerStore.getState();
const itemById = (id: string) => store().items.find((i) => i.id === id) as TaskItem;

function baseTask(over: Partial<Item> & { id: string }): Item {
  return {
    type: 'task',
    title: over.id,
    status: 'pending',
    isScheduled: false,
    timeBucket: 'anytime',
    order: 0,
    completedDates: [],
    skippedDates: [],
    startDate: TODAY,
    ...over,
  } as Item;
}

const fixtures = (): Item[] => [
  baseTask({ id: 'one-off' }),
  baseTask({ id: 'weekly-tue', repeatFrequency: 'custom', repeatDays: [2] }),
  baseTask({ id: 'daily', repeatFrequency: 'daily' }),
];

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(fixtures());
  await store().initializeStore(USER);
  usePlannerStore.setState({ userTimezone: 'UTC' });
  useEODStore.setState({ isOpen: true });
});

afterEach(() => {
  cleanup();
  useEODStore.setState({ isOpen: false });
  vi.useRealTimers();
});

const click = (testId: string) => fireEvent.click(screen.getByTestId(testId));
const absent = (testId: string) => expect(screen.queryByTestId(testId)).not.toBeInTheDocument();

describe('EOD date controls — one-off tasks (unchanged behaviour)', () => {
  it('offers Tomorrow and the date picker, and moves the task', () => {
    render(<EODReview />);
    expect(screen.getByTestId('eod-datepicker-btn-one-off')).toBeInTheDocument();
    click('eod-tomorrow-btn-one-off');

    expect(itemById('one-off').startDate).toBe(TOMORROW);
    expect(db.updateItem).toHaveBeenCalledWith(
      'one-off',
      'task',
      expect.objectContaining({ startDate: TOMORROW })
    );
    expect(screen.getByTestId('eod-undo-btn-one-off')).toHaveTextContent('Moved to tomorrow');
  });

  it('undo puts the original date back', () => {
    render(<EODReview />);
    click('eod-tomorrow-btn-one-off');
    click('eod-undo-btn-one-off');
    expect(itemById('one-off').startDate).toBe(TODAY);
  });
});

describe('EOD date controls — recurring tasks are not offered them', () => {
  it.each(['weekly-tue', 'daily'])('hides Tomorrow and the date picker on %s', (id) => {
    render(<EODReview />);
    // The row is present and triageable — it just cannot be re-dated.
    expect(screen.getByTestId(`eod-task-row-${id}`)).toBeInTheDocument();
    absent(`eod-tomorrow-btn-${id}`);
    absent(`eod-datepicker-btn-${id}`);
    // The ✕ (issue #187's "Left for next time") stays.
    expect(screen.getByTestId(`eod-dismiss-btn-${id}`)).toBeInTheDocument();
  });

  it('offers Skip today in their place', () => {
    render(<EODReview />);
    expect(screen.getByTestId('eod-skip-btn-daily')).toHaveTextContent('Skip today');
    // …and never on a one-off task, which has no occurrence to skip.
    absent('eod-skip-btn-one-off');
  });
});

describe('EOD Skip today', () => {
  it('records the skip per date and leaves the series alone', () => {
    render(<EODReview />);
    const before = itemById('daily');
    click('eod-skip-btn-daily');

    const after = itemById('daily');
    expect(after.skippedDates).toEqual([TODAY]);
    // The anchor is untouched: this is one occurrence, not a reschedule.
    expect(after.startDate).toBe(before.startDate);
    expect(after.repeatFrequency).toBe('daily');
    // Scalar status is not the skip channel for a task — 'skipped' is not even
    // in the task vocabulary the OpenClaw plugin safeParses.
    expect(after.status).toBe('pending');
    expect(after.completedDates ?? []).toEqual([]);
  });

  it('persists through the skip machinery, not a hand-written status or date', () => {
    render(<EODReview />);
    click('eod-skip-btn-daily');

    // The skip persists as a per-date intent (migration 029), not as an
    // absolute skippedDates array through the update allowlist.
    expect(db.setItemSkip).toHaveBeenCalledWith('daily', 'task', TODAY, true);
    const writes = vi.mocked(db.updateItem).mock.calls;
    expect(writes.every(([, , u]) => !('startDate' in u) && !('status' in u))).toBe(true);
    expect(writes.every(([, , u]) => !('skippedDates' in u))).toBe(true);
  });

  it('shows a non-shaming receipt, and undo unskips the day', () => {
    render(<EODReview />);
    click('eod-skip-btn-daily');

    const receipt = screen.getByTestId('eod-undo-btn-daily');
    expect(receipt).toHaveTextContent('Skipped today');
    expect(receipt.textContent).not.toMatch(/missed|failed|behind/i);
    absent('eod-skip-btn-daily');

    click('eod-undo-btn-daily');
    expect(itemById('daily').skippedDates).toEqual([]);
    expect(screen.getByTestId('eod-skip-btn-daily')).toBeInTheDocument();
  });

  it('clears the skip if the row is then marked done', () => {
    render(<EODReview />);
    click('eod-skip-btn-daily');
    // The done circle — scoped to this row, since every pending row has one.
    fireEvent.click(within(screen.getByTestId('eod-task-row-daily')).getByTitle('Mark as done'));

    const after = itemById('daily');
    expect(after.skippedDates).toEqual([]);
    expect(after.completedDates).toEqual(['2026-07-14']);
  });

  it('leaves its neighbours alone — one row at a time', () => {
    render(<EODReview />);
    click('eod-skip-btn-daily');

    expect(itemById('weekly-tue').skippedDates ?? []).toEqual([]);
    expect(itemById('one-off').startDate).toBe(TODAY);
  });
});

describe('EOD "Move all to tomorrow" excludes recurring tasks', () => {
  it('carries only the one-off rows', () => {
    render(<EODReview />);
    click('eod-move-all-btn');

    expect(itemById('one-off').startDate).toBe(TOMORROW);
    expect(itemById('daily').startDate).toBe(TODAY);
    expect(itemById('weekly-tue').startDate).toBe(TODAY);
    expect(db.updateItem).toHaveBeenCalledTimes(1);
  });

  it('does not mark the recurring rows as actioned', () => {
    render(<EODReview />);
    click('eod-move-all-btn');

    // No receipt claiming a move that never happened; the row keeps its own
    // controls and can still be skipped or left.
    absent('eod-undo-btn-daily');
    expect(screen.getByTestId('eod-skip-btn-daily')).toBeInTheDocument();
    expect(screen.getByTestId('eod-dismiss-btn-daily')).toBeInTheDocument();
  });

  it('hides the bulk button when every remaining row is recurring', () => {
    render(<EODReview />);
    expect(screen.getByTestId('eod-move-all-btn')).toBeInTheDocument();
    click('eod-tomorrow-btn-one-off');
    // Two recurring rows are still unactioned, but the verb would refuse both,
    // so offering it would be an empty gesture.
    absent('eod-move-all-btn');
  });
});
