import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Same harness as skip.test.ts / undo-redo-store.test.ts: the db layer is
// mocked and the REAL Zustand store is driven, so these assert both the
// optimistic state and the writes that leave for Supabase. Pausing is the
// feature whose whole promise is "nothing else moves", so the writes matter as
// much as the state.

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    fetchItems: vi.fn(async () => []),
    fetchProjects: vi.fn(async () => []),
    fetchItemTypes: vi.fn(async () => []),
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
  };
});
vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import { usePlannerStore } from '@/lib/planner-store';
import { updatesToRow } from '@/lib/db';
import * as db from '@/lib/db';
import { isPausable, isCollectible, ITEM_TYPES, buildCustomTypeConfig } from '@/lib/item-registry';
import { isPausedOn, isOpenLoopSuppressedOn, inactiveItemIdsOn } from '@/lib/active';
import { releasedOn, clearReleased } from '@/lib/sweep-grace';
import { toDateStr } from '@/lib/recurrence';
import { format } from 'date-fns';
import type { Item } from '@/lib/planner-types';

const USER = 'user-1';
const TODAY = '2026-03-10';
const ctx = { userTimezone: 'UTC' };

const fixtures = (): Item[] => [
  {
    type: 'task', id: 'one-shot', title: 'File taxes', status: 'pending',
    isScheduled: false, order: 0, startDate: '2026-03-01',
    completedDates: [], skippedDates: [],
  },
  {
    type: 'task', id: 'parent', title: 'Parent', status: 'pending',
    isScheduled: false, order: 1, completedDates: [], skippedDates: [],
  },
  {
    type: 'task', id: 'subtask', title: 'Child', status: 'pending',
    isScheduled: false, order: 2, parentItemId: 'parent',
    completedDates: [], skippedDates: [],
  },
  {
    type: 'habit', id: 'habit-1', title: 'Stretch', project: 'Wellness',
    streak: 7, status: 'pending', completedDates: ['2026-03-09'], skippedDates: [],
    dailyCounts: {}, repeatFrequency: 'daily',
  },
];

const store = () => usePlannerStore.getState();
const itemById = (id: string) => store().items.find((i) => i.id === id)!;

beforeEach(async () => {
  // A pause stamps wall-clock now, and the resolver's LOWER bound then compares
  // that stamp against the queried day — so a fixture "today" in the past would
  // read as "the pause hasn't started yet" and nothing would suppress. Pin the
  // clock instead of dating the fixtures relative to the real one. Only Date is
  // faked: faking timers too would stall initializeStore's awaits.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));

  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(fixtures());
  await store().initializeStore(USER);
  usePlannerStore.setState({
    selectedDate: new Date(`${TODAY}T12:00:00Z`),
    userTimezone: 'UTC',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pausable is a registry capability', () => {
  it('declares every built-in type pausable and collectible', () => {
    expect(ITEM_TYPES.task.pausable).toBe(true);
    expect(ITEM_TYPES.habit.pausable).toBe(true);
    const custom = buildCustomTypeConfig({ name: 'goal', label: 'Goal', labelPlural: 'Goals' });
    expect(custom.pausable).toBe(true);
    expect(custom.collectible).toBe(true);
  });

  // The deliberate difference from isSkippable, which ANDs with recurrence: a
  // skip answers one occurrence and needs another to exist; a pause answers a
  // stretch of time and applies just as well to a single dated task.
  it('does NOT require recurrence, unlike isSkippable', () => {
    expect(isPausable(itemById('one-shot'))).toBe(true);
  });

  it('excludes subtasks, which have no independent presence to suppress', () => {
    expect(isPausable(itemById('subtask'))).toBe(false);
    expect(isCollectible(itemById('subtask'))).toBe(false);
    expect(isPausable(itemById('parent'))).toBe(true);
  });
});

describe('setItemPaused', () => {
  it('pauses an item and writes ONLY the pause columns', () => {
    store().setItemPaused('habit-1', true);

    const habit = itemById('habit-1');
    expect(habit.pausedAt).toBeTruthy();
    expect(isPausedOn(habit, TODAY, 'UTC')).toBe(true);

    expect(db.updateItem).toHaveBeenCalledTimes(1);
    const [id, type, updates] = vi.mocked(db.updateItem).mock.calls[0];
    expect(id).toBe('habit-1');
    expect(type).toBe('habit');
    expect(Object.keys(updates).sort()).toEqual(['pausedAt', 'pausedUntil']);
  });

  // The whole promise of the feature. Streaks only move inside the completion
  // RPC and nothing decays one on a missed day, so a pause that touches nothing
  // preserves the streak for free — but only if it really touches nothing.
  it('never moves streak, status, or completion history', () => {
    const before = itemById('habit-1');
    store().setItemPaused('habit-1', true);
    const after = itemById('habit-1');

    expect(after.streak).toBe(before.streak);
    expect(after.status).toBe(before.status);
    expect(after.completedDates).toEqual(before.completedDates);
    expect(after.skippedDates).toEqual(before.skippedDates);
    expect(db.setItemCompletion).not.toHaveBeenCalled();
  });

  // An item with no timeBucket is invisible in day views, so a pause that
  // disturbed scheduling would strand the item on resume.
  it('never moves scheduling fields', () => {
    const before = itemById('one-shot');
    store().setItemPaused('one-shot', true);
    const after = itemById('one-shot');

    expect(after.startDate).toBe(before.startDate);
    expect(after.timeBucket).toBe(before.timeBucket);
    expect(after.isScheduled).toBe(before.isScheduled);
    expect(after.repeatFrequency).toBe(before.repeatFrequency);
  });

  it('records an exclusive resume date when given one', () => {
    store().setItemPaused('habit-1', true, '2026-04-01');
    const habit = itemById('habit-1');
    expect(habit.pausedUntil).toBe('2026-04-01');
    expect(isPausedOn(habit, '2026-03-31', 'UTC')).toBe(true);
    expect(isPausedOn(habit, '2026-04-01', 'UTC')).toBe(false);
  });

  // Clearing pausedAt would erase the interval the auto-age sweep's resume
  // grace is computed from — a returning user's whole backlog would become
  // sweepable the next morning.
  it('resume records pausedUntil = today rather than clearing the pair', () => {
    store().setItemPaused('habit-1', true);
    store().setItemPaused('habit-1', false);

    const habit = itemById('habit-1');
    expect(habit.pausedAt).toBeTruthy();
    expect(habit.pausedUntil).toBe(TODAY);
    expect(isPausedOn(habit, TODAY, 'UTC')).toBe(false);
  });

  // Regression: this used to resolve through resolveDateStr(), which reads the
  // navigable selectedDate — so browsing next month and hitting Resume wrote a
  // resume date a month out and the item stayed paused (and Pause while parked
  // on a past day mis-answered "is it already paused?"). Pausing is dateless:
  // it resolves at today, always.
  it('resolves at TODAY even when the user is parked on another date', () => {
    usePlannerStore.setState({ selectedDate: new Date('2026-06-15T12:00:00Z') });

    store().setItemPaused('habit-1', true);
    expect(isPausedOn(itemById('habit-1'), TODAY, 'UTC')).toBe(true);

    store().setItemPaused('habit-1', false);
    expect(itemById('habit-1').pausedUntil).toBe(TODAY);
    expect(isPausedOn(itemById('habit-1'), TODAY, 'UTC')).toBe(false);
  });

  it('is intent-based: repeating the current state writes nothing', () => {
    store().setItemPaused('habit-1', false);
    expect(db.updateItem).not.toHaveBeenCalled();

    store().setItemPaused('habit-1', true);
    vi.mocked(db.updateItem).mockClear();
    store().setItemPaused('habit-1', true);
    expect(db.updateItem).not.toHaveBeenCalled();
  });

  it('no-ops on a subtask', () => {
    store().setItemPaused('subtask', true);
    expect(itemById('subtask').pausedAt).toBeUndefined();
    expect(db.updateItem).not.toHaveBeenCalled();
  });

  it('no-ops on an id the store does not have', () => {
    store().setItemPaused('ghost', true);
    expect(db.updateItem).not.toHaveBeenCalled();
  });

  it('undo restores the pre-pause state', () => {
    store().setItemPaused('habit-1', true);
    expect(itemById('habit-1').pausedAt).toBeTruthy();
    store().undo();
    expect(itemById('habit-1').pausedAt).toBeUndefined();
  });
});

describe('pausing feeds the resolver end to end', () => {
  it('a paused item becomes a suppressed open loop', () => {
    expect(inactiveItemIdsOn(store().items, TODAY, ctx).size).toBe(0);
    store().setItemPaused('habit-1', true);
    expect(inactiveItemIdsOn(store().items, TODAY, ctx)).toEqual(new Set(['habit-1']));
  });

  // Locked decision 4, through the real store: hide open loops, never history.
  it('keeps a day that was already marked before the pause', () => {
    store().toggleHabitStatus('habit-1', 'done');
    store().setItemPaused('habit-1', true);

    const habit = itemById('habit-1');
    expect(isOpenLoopSuppressedOn(habit, TODAY, ctx)).toBe(false);
    expect(inactiveItemIdsOn(store().items, TODAY, ctx).size).toBe(0);
  });

  it('never suppresses dates before the pause began', () => {
    store().setItemPaused('habit-1', true);
    expect(inactiveItemIdsOn(store().items, '2026-03-01', ctx).size).toBe(0);
  });

  it('stops suppressing once the resume date arrives', () => {
    store().setItemPaused('habit-1', true, '2026-03-20');
    expect(inactiveItemIdsOn(store().items, '2026-03-19', ctx).size).toBe(1);
    expect(inactiveItemIdsOn(store().items, '2026-03-20', ctx).size).toBe(0);
  });
});

describe('the update allowlists persist the pause columns', () => {
  // The seam db-allowlists catches generically. Without these entries the
  // store's own write maps to an empty row and updateItem early-returns, so a
  // pause would be optimistic-only and silently undo itself on reload.
  it('maps both fields for tasks and habits', () => {
    expect(updatesToRow('task', { pausedAt: 'x', pausedUntil: TODAY }))
      .toEqual({ paused_at: 'x', paused_until: TODAY });
    expect(updatesToRow('habit', { pausedAt: 'x', pausedUntil: TODAY }))
      .toEqual({ paused_at: 'x', paused_until: TODAY });
  });
});

describe('"pause until" boundaries', () => {
  // Both of these were shipped wrong and caught in review. The picker offered
  // today (react-day-picker's `before` matcher disables only STRICTLY earlier
  // days), and it converted the picked day with toDateStr(tz), which re-reads a
  // browser-local midnight in the stored zone. The UI fixes live in the dialog;
  // these pin the semantics the UI has to honour, so a future "simplification"
  // back to either form fails here rather than in a user's week.

  it('a resume date of today is a no-op interval — which is why the picker forbids it', () => {
    store().setItemPaused('habit-1', true, TODAY);
    // The write happens (nothing downstream rejects it) but reads back as live,
    // so offering this day would be a visibly dead gesture.
    expect(isPausedOn(itemById('habit-1'), TODAY, 'UTC')).toBe(false);
  });

  it('a resume date of tomorrow suppresses today and releases on the day itself', () => {
    const TOMORROW = '2026-03-11';
    store().setItemPaused('habit-1', true, TOMORROW);
    expect(isPausedOn(itemById('habit-1'), TODAY, 'UTC')).toBe(true);
    // Exclusive upper bound: live again ON the chosen day, not after it.
    expect(isPausedOn(itemById('habit-1'), TOMORROW, 'UTC')).toBe(false);
  });

  it('the picked day is stored as its own calendar literal, not re-read through a zone', () => {
    // The dialog's conversion, both ways, for a browser east of the stored zone.
    // A user in Auckland whose settings still say New York picks Sep 1.
    const picked = new Date(2026, 8, 1); // local midnight, whatever the runner's zone
    expect(format(picked, 'yyyy-MM-dd')).toBe('2026-09-01');
    // Whereas routing an instant through a western zone can land the day before.
    expect(toDateStr(new Date('2026-09-01T00:00:00+12:00'), 'America/New_York'))
      .toBe('2026-08-31');
  });
});

describe('routines in the store', () => {
  const routineOf = (id: string) => store().routines.find((r) => r.id === id)!;

  it('adds a routine and returns its id', () => {
    const id = store().addRoutine({ name: 'Morning', itemIds: [] });
    expect(routineOf(id).name).toBe('Morning');
    expect(db.createRoutine).toHaveBeenCalledTimes(1);
  });

  it('pausing a routine suppresses its members, and resuming restores them', () => {
    const id = store().addRoutine({ name: 'Morning', itemIds: ['habit-1'] });

    store().setRoutinePaused(id, true);
    expect(isPausedOn(routineOf(id), TODAY, 'UTC')).toBe(true);
    expect(inactiveItemIdsOn(store().items, TODAY, { ...ctx, routines: store().routines }))
      .toEqual(new Set(['habit-1']));

    store().setRoutinePaused(id, false);
    expect(inactiveItemIdsOn(store().items, TODAY, { ...ctx, routines: store().routines }).size)
      .toBe(0);
  });

  it('resume normalizes pausedUntil to today rather than clearing the pair', () => {
    const id = store().addRoutine({ name: 'Morning', itemIds: [] });
    store().setRoutinePaused(id, true);
    store().setRoutinePaused(id, false);
    // The interval has to survive on the row — the sweep's container grace
    // reads it to decide whether members just came back.
    expect(routineOf(id).pausedAt).toBeTruthy();
    expect(routineOf(id).pausedUntil).toBe(TODAY);
  });

  it('is idempotent — pausing an already-paused routine writes nothing', () => {
    const id = store().addRoutine({ name: 'Morning', itemIds: [] });
    store().setRoutinePaused(id, true);
    vi.clearAllMocks();
    store().setRoutinePaused(id, true);
    expect(db.updateRoutine).not.toHaveBeenCalled();
  });

  /**
   * The third argument, which was accepted and then silently dropped.
   *
   * The idempotence guard above used to be the FIRST line of the action, so it
   * also swallowed the one request that is not a no-op: a resume date on a pause
   * that is already running. And a resume date can only be chosen while
   * something is paused — so `pausedUntil` was unreachable from the UI
   * altogether, and the Organize console shipped a picker that wrote nothing.
   * The action now resolves through active.ts's resolvePauseWrite.
   */
  it('honours a resume date on a pause that is already running', () => {
    const id = store().addRoutine({ name: 'Morning', itemIds: [] });
    store().setRoutinePaused(id, true);
    const pausedAt = routineOf(id).pausedAt;

    store().setRoutinePaused(id, true, '2026-09-01');
    expect(routineOf(id).pausedUntil).toBe('2026-09-01');
    // The lower bound must NOT move. Restamping it would drag the start of the
    // interval forward and un-hide every day in between.
    expect(routineOf(id).pausedAt).toBe(pausedAt);
    expect(db.updateRoutine).toHaveBeenLastCalledWith('user-1', id, {
      pausedUntil: '2026-09-01',
    });
  });

  it('clears a resume date on null, and ignores undefined', () => {
    const id = store().addRoutine({ name: 'Morning', itemIds: [] });
    store().setRoutinePaused(id, true, '2026-09-01');

    // undefined is "I did not say" — what the bare toggles pass, and what keeps
    // them idempotent. It must not be read as a clear.
    vi.clearAllMocks();
    store().setRoutinePaused(id, true);
    expect(routineOf(id).pausedUntil).toBe('2026-09-01');
    expect(db.updateRoutine).not.toHaveBeenCalled();

    // null is the console's ✕.
    store().setRoutinePaused(id, true, null);
    expect(routineOf(id).pausedUntil).toBeUndefined();
    // db.ts keys on `'pausedUntil' in updates`, so the key must be PRESENT for
    // paused_until to reach the row as null.
    const [, , patch] = vi.mocked(db.updateRoutine).mock.calls.at(-1)!;
    expect('pausedUntil' in patch).toBe(true);
  });

  it('refuses a resume date that is already in the past', () => {
    // resolvePauseWrite returns a reason rather than a patch: a pause that ends
    // before it starts is indistinguishable from one that failed to apply.
    const id = store().addRoutine({ name: 'Morning', itemIds: [] });
    vi.clearAllMocks();
    store().setRoutinePaused(id, true, '2020-01-01');
    expect(routineOf(id).pausedAt).toBeUndefined();
    expect(db.updateRoutine).not.toHaveBeenCalled();
  });

  it('pausing a routine NEVER touches its members', () => {
    const id = store().addRoutine({ name: 'Morning', itemIds: ['habit-1'] });
    const before = JSON.stringify(itemById('habit-1'));
    store().setRoutinePaused(id, true);
    expect(JSON.stringify(itemById('habit-1'))).toBe(before);
    // Specifically: the streak and the per-date marks are untouched, which is
    // the whole promise of pausing rather than deleting.
    expect(itemById('habit-1').streak).toBe(7);
    expect(itemById('habit-1').completedDates).toEqual(['2026-03-09']);
  });

  it('a paused routine leaves NON-members alone', () => {
    const id = store().addRoutine({ name: 'Morning', itemIds: ['habit-1'] });
    store().setRoutinePaused(id, true);
    const inactive = inactiveItemIdsOn(store().items, TODAY, { ...ctx, routines: store().routines });
    expect(inactive.has('one-shot')).toBe(false);
  });
});

describe('create-with-membership is one gesture', () => {
  it('lands the item and its join rows in a single history entry', () => {
    const id = store().addRoutine({ name: 'Morning', itemIds: [] });
    const before = store().actionLog.length;

    store().addTask({ title: 'New task' }, { routineIds: [id] });

    const created = store().items.find((i) => i.title === 'New task')!;
    expect(store().routines.find((r) => r.id === id)!.itemIds).toContain(created.id);
    // One entry, so one Cmd+Z reverses the whole add rather than half of it.
    expect(store().actionLog.length).toBe(before + 1);
  });

  it('omitting memberships changes nothing about the add', () => {
    const id = store().addRoutine({ name: 'Morning', itemIds: [] });
    store().addTask({ title: 'Loner' });
    expect(store().routines.find((r) => r.id === id)!.itemIds).toEqual([]);
  });

  it('works for habits too', () => {
    const id = store().addRoutine({ name: 'Morning', itemIds: [] });
    store().addHabit({ title: 'New habit', project: 'Wellness', repeatFrequency: 'daily' });
    expect(store().routines.find((r) => r.id === id)!.itemIds).toEqual([]);

    store().addHabit(
      { title: 'Joined habit', project: 'Wellness', repeatFrequency: 'daily' },
      { routineIds: [id] },
    );
    const created = store().items.find((i) => i.title === 'Joined habit')!;
    expect(store().routines.find((r) => r.id === id)!.itemIds).toEqual([created.id]);
  });
});

/**
 * Release grace (plan decision 9, the arm that stored data cannot answer).
 *
 * The sweep's other grace arms read a date off a row: an item's or a routine's
 * `pausedUntil`, a season's `startsOn` or `updatedAt`. Deleting a container —
 * or pulling a member out of one — releases items with no such record anywhere,
 * because the row it would have been read from is exactly what was removed. The
 * item then reappears carrying every day of age it accrued while hidden, and
 * the next morning's sweep unschedules it.
 */
describe('container edits record the suppressions they end', () => {
  beforeEach(() => clearReleased());

  const pausedRoutineHolding = (...itemIds: string[]) =>
    store().addRoutine({
      name: 'Morning',
      itemIds,
      pausedAt: new Date(`${TODAY}T00:00:00Z`).toISOString(),
    });

  it('deleting a paused routine graces the members it was hiding', () => {
    const id = pausedRoutineHolding('habit-1');
    // Prove it was actually hidden first, or the assertion below could pass
    // for an item that was never at risk.
    const hidden = inactiveItemIdsOn(store().items, TODAY, { ...ctx, routines: store().routines });
    expect(hidden.has('habit-1')).toBe(true);

    store().removeRoutine(id);

    expect(releasedOn('habit-1')).toBe(TODAY);
  });

  it('deleting a LIVE routine graces nobody — nothing was hidden', () => {
    const id = store().addRoutine({ name: 'Morning', itemIds: ['habit-1'] });
    store().removeRoutine(id);
    expect(releasedOn('habit-1')).toBeUndefined();
  });

  it('removing an item from a paused routine graces that item only', () => {
    const id = pausedRoutineHolding('habit-1', 'one-shot');
    store().updateRoutine(id, { itemIds: ['one-shot'] });

    expect(releasedOn('habit-1')).toBe(TODAY);
    // Still held, still hidden — gracing it would switch the sweep off for
    // work that has not come back.
    expect(releasedOn('one-shot')).toBeUndefined();
  });

  it('a rename records nothing', () => {
    const id = pausedRoutineHolding('habit-1');
    store().updateRoutine(id, { name: 'Evening' });
    expect(releasedOn('habit-1')).toBeUndefined();
  });

  // The disjunctive path rule means membership can be removed WITHOUT the item
  // becoming visible. Gracing there would be wrong in the unsafe direction.
  it('does not grace an item that is still hidden by another path', () => {
    const a = pausedRoutineHolding('habit-1');
    pausedRoutineHolding('habit-1');
    store().removeRoutine(a);
    expect(releasedOn('habit-1')).toBeUndefined();
  });

  it('deleting a paused SEASON graces its members too', () => {
    const id = store().addSeason({
      name: 'Summer',
      state: 'paused',
      itemIds: ['habit-1'],
      routineIds: [],
    });
    store().removeSeason(id);
    expect(releasedOn('habit-1')).toBe(TODAY);
  });

  // item -> routine -> season: pulling the ROUTINE out of the season hands
  // the answer back to the routine, which is live, so the members return.
  it('graces members released by detaching a routine from a season', () => {
    const routineId = store().addRoutine({ name: 'Morning', itemIds: ['habit-1'] });
    const seasonId = store().addSeason({
      name: 'Summer',
      state: 'paused',
      itemIds: [],
      routineIds: [routineId],
    });
    expect(releasedOn('habit-1')).toBeUndefined();

    store().updateSeason(seasonId, { routineIds: [] });
    expect(releasedOn('habit-1')).toBe(TODAY);
  });

  it('graces members released by moving an auto range to cover today', () => {
    const id = store().addSeason({
      name: 'Term',
      state: 'auto',
      startsOn: '2026-06-01',
      itemIds: ['habit-1'],
      routineIds: [],
    });
    expect(releasedOn('habit-1')).toBeUndefined();

    store().updateSeason(id, { startsOn: '2026-01-01' });
    expect(releasedOn('habit-1')).toBe(TODAY);
  });

  // Only open loops can ever be swept, so anything else in the diff would be
  // granting grace to work that was never at risk.
  it('ignores an item that carries a mark today', () => {
    usePlannerStore.setState({
      items: store().items.map((i) =>
        i.id === 'habit-1' ? { ...i, completedDates: [TODAY] } : i
      ),
    });
    const id = pausedRoutineHolding('habit-1');
    store().removeRoutine(id);
    expect(releasedOn('habit-1')).toBeUndefined();
  });
});
