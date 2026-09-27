import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

/**
 * Issue #187 — the EOD ✕ must not send a RECURRING task to the sidebar.
 *
 * The ✕ has always meant unscheduleTask(), which clears startDate / timeBucket /
 * startTime / isScheduled. For a one-off task that is exactly right: back to the
 * Braindump. For a recurring one, startDate is the recurrence ANCHOR, so the
 * same call deletes the series off the calendar instead of dismissing tonight's
 * occurrence — a task repeating every Tuesday would vanish from every future
 * Tuesday because it wasn't done on one of them.
 *
 * These drive the real planner store (db mocked, exactly as
 * tests/unit/undo-redo-store.test.ts does) through the real component, because
 * the regression lives in the wiring between the two: the branch is a one-liner,
 * and every previous version of this bug was a correct predicate called from the
 * wrong place.
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

import { EODReview } from '@/components/ai/eod-review';
import { usePlannerStore } from '@/lib/planner-store';
import { useEODStore } from '@/lib/eod-store';
import * as db from '@/lib/db';
import type { Item, TaskItem } from '@/lib/planner-types';

const USER = 'user-1';

/** A fixed "today" so the component's own todayStr() is deterministic. */
const TODAY = '2026-07-14'; // a Tuesday — the issue's own example day

const store = () => usePlannerStore.getState();
/**
 * Narrowed to TaskItem: every fixture here is task-shaped, and the bare `Item`
 * union carries HabitItem, which has no startDate/isScheduled to assert on.
 */
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
    startDate: TODAY,
    ...over,
  } as Item;
}

const fixtures = (): Item[] => [
  baseTask({ id: 'one-off' }),
  // Repeats every Tuesday. TODAY is a Tuesday, so it lands in the EOD pending
  // list via shouldShowOnDate rather than via a startDate match.
  baseTask({ id: 'weekly-tue', repeatFrequency: 'custom', repeatDays: [2] }),
  baseTask({ id: 'daily', repeatFrequency: 'daily' }),
];

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // Noon UTC keeps the date the same under any tz the runner happens to use.
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

/**
 * fireEvent, not userEvent: @testing-library/user-event is not a dependency of
 * this repo, and every gesture under test here is a plain click on a plain
 * button. fireEvent already wraps in act().
 */
const click = (testId: string) => fireEvent.click(screen.getByTestId(testId));

const dismiss = (id: string) => click(`eod-dismiss-btn-${id}`);

describe('EOD dismiss — one-off tasks (unchanged behaviour)', () => {
  it('unschedules the task and clears its date, i.e. back to the Braindump', () => {
    render(<EODReview />);
    dismiss('one-off');

    const task = itemById('one-off');
    expect(task.startDate).toBeUndefined();
    expect(task.isScheduled).toBe(false);
    expect(task.timeBucket).toBeUndefined();
    expect(db.updateItem).toHaveBeenCalledWith(
      'one-off',
      'task',
      expect.objectContaining({ startDate: undefined, isScheduled: false })
    );
  });

  it('shows the sidebar receipt, and undo puts the date back', () => {
    render(<EODReview />);
    dismiss('one-off');
    expect(screen.getByTestId('eod-undo-btn-one-off')).toHaveTextContent('Moved to sidebar');

    click('eod-undo-btn-one-off');
    expect(itemById('one-off').startDate).toBe(TODAY);
    // Controls are back, receipt is gone.
    expect(screen.getByTestId('eod-dismiss-btn-one-off')).toBeInTheDocument();
    expect(screen.queryByTestId('eod-undo-btn-one-off')).not.toBeInTheDocument();
  });
});

describe('EOD dismiss — recurring tasks (issue #187)', () => {
  it.each(['weekly-tue', 'daily'])('leaves %s completely untouched', (id) => {
    render(<EODReview />);
    const before = itemById(id);
    dismiss(id);

    // Field-for-field: nothing the ✕ used to write may have moved.
    expect(itemById(id)).toEqual(before);
    expect(itemById(id).startDate).toBe(TODAY);
  });

  it('writes nothing to the database and pushes nothing onto the undo stack', () => {
    render(<EODReview />);
    expect(store().canUndo).toBe(false);
    dismiss('weekly-tue');

    expect(db.updateItem).not.toHaveBeenCalled();
    // A no-op must not cost the user their real undo history.
    expect(store().canUndo).toBe(false);
  });

  it('does NOT record the dismissal as a scalar status or a completedDates entry', () => {
    render(<EODReview />);
    dismiss('daily');

    // Recurring completion is per-date state; a dismissal is neither a
    // completion nor a cancellation of the series.
    expect(itemById('daily').status).toBe('pending');
    expect(itemById('daily').completedDates ?? []).toEqual([]);
  });

  it('still resolves the row for the session, with its own honest receipt', () => {
    render(<EODReview />);
    dismiss('weekly-tue');

    const receipt = screen.getByTestId('eod-undo-btn-weekly-tue');
    expect(receipt).toHaveTextContent('Left for next time');
    expect(receipt).not.toHaveTextContent('sidebar');
    // The row stops asking to be triaged again in this sitting.
    expect(screen.queryByTestId('eod-dismiss-btn-weekly-tue')).not.toBeInTheDocument();
    expect(screen.queryByTestId('eod-tomorrow-btn-weekly-tue')).not.toBeInTheDocument();
  });

  it('undo restores the controls without writing anything', () => {
    render(<EODReview />);
    dismiss('weekly-tue');
    const after = itemById('weekly-tue');

    click('eod-undo-btn-weekly-tue');
    expect(screen.getByTestId('eod-dismiss-btn-weekly-tue')).toBeInTheDocument();
    expect(itemById('weekly-tue')).toEqual(after);
    expect(db.updateItem).not.toHaveBeenCalled();
    expect(store().canUndo).toBe(false);
  });

  it('leaves its neighbours alone — dismissing one row is not a bulk verb', () => {
    render(<EODReview />);
    dismiss('weekly-tue');

    expect(itemById('daily').startDate).toBe(TODAY);
    expect(itemById('one-off').startDate).toBe(TODAY);
    expect(screen.getByTestId('eod-dismiss-btn-one-off')).toBeInTheDocument();
  });
});
