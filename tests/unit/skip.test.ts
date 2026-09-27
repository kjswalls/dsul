import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same harness as undo-redo-store.test.ts: the db layer is mocked and the real
// Zustand store is driven, so these assert both the optimistic state and the
// writes that leave for Supabase.

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
  };
});
vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import { usePlannerStore } from '@/lib/planner-store';
import { updatesToRow } from '@/lib/db';
import * as db from '@/lib/db';
import { isSkippable, ITEM_TYPES, buildCustomTypeConfig } from '@/lib/item-registry';
import { isSkippedOnDate } from '@/lib/recurrence';
import type { Item } from '@/lib/planner-types';

const USER = 'user-1';
const TODAY = '2026-03-10';

const fixtures = (): Item[] => [
  // Recurring task — the new case (#194).
  {
    type: 'task',
    id: 'daily-task',
    title: 'Water the plants',
    status: 'pending',
    isScheduled: false,
    order: 0,
    startDate: '2026-03-01',
    repeatFrequency: 'daily',
    completedDates: [],
    skippedDates: [],
  },
  // One-shot task — skipping is meaningless; there is one occurrence.
  {
    type: 'task',
    id: 'one-shot',
    title: 'File taxes',
    status: 'pending',
    isScheduled: false,
    order: 1,
    startDate: TODAY,
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
];

const store = () => usePlannerStore.getState();
const itemById = (id: string) => store().items.find((i) => i.id === id)!;

beforeEach(async () => {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(fixtures());
  await store().initializeStore(USER);
  usePlannerStore.setState({
    selectedDate: new Date(`${TODAY}T12:00:00Z`),
    userTimezone: 'UTC',
  });
});

describe('skippable is a registry capability, not a habit privilege', () => {
  it('declares every built-in type skippable', () => {
    expect(ITEM_TYPES.task.skippable).toBe(true);
    expect(ITEM_TYPES.habit.skippable).toBe(true);
    expect(buildCustomTypeConfig({ name: 'goal', label: 'Goal', labelPlural: 'Goals' }).skippable)
      .toBe(true);
  });

  it('only habits denormalize a skip into scalar status', () => {
    // 'skipped' is not in the task vocabulary and the OpenClaw plugin throws on
    // drift — a skipped task must be visible ONLY through skippedDates.
    expect(ITEM_TYPES.habit.skipStatus).toBe('skipped');
    expect(ITEM_TYPES.task.skipStatus).toBeNull();
    expect(ITEM_TYPES.task.allowedStatuses).not.toContain('skipped');
  });

  it('requires recurrence as well as the capability', () => {
    expect(isSkippable(itemById('daily-task'))).toBe(true);
    expect(isSkippable(itemById('habit-1'))).toBe(true);
    expect(isSkippable(itemById('one-shot'))).toBe(false);
  });
});

describe('setItemSkipped', () => {
  it('records a recurring task skip per date and leaves scalar status alone', () => {
    store().setItemSkipped('daily-task', true);

    const task = itemById('daily-task');
    expect(task.skippedDates).toEqual([TODAY]);
    expect(task.status).toBe('pending');
    expect(isSkippedOnDate(task, TODAY)).toBe(true);
    expect(isSkippedOnDate(task, '2026-03-11')).toBe(false);

    // Per-date intent (migration 029), never the recomputed array: a client
    // that wrote skippedDates whole would make its own copy the server truth.
    expect(db.setItemSkip).toHaveBeenCalledWith('daily-task', 'task', TODAY, true);
    expect(vi.mocked(db.updateItem).mock.calls.every(([, , u]) => !('skippedDates' in u))).toBe(true);
  });

  it('unskips the same date back off the list', () => {
    store().setItemSkipped('daily-task', true);
    store().setItemSkipped('daily-task', false);
    expect(itemById('daily-task').skippedDates).toEqual([]);
  });

  it('is intent-based: a repeat of the current state writes nothing', () => {
    store().setItemSkipped('daily-task', false);
    expect(db.setItemSkip).not.toHaveBeenCalled();

    store().setItemSkipped('daily-task', true);
    vi.mocked(db.setItemSkip).mockClear();
    store().setItemSkipped('daily-task', true);
    expect(db.setItemSkip).not.toHaveBeenCalled();
  });

  it('no-ops on a one-shot task', () => {
    store().setItemSkipped('one-shot', true);
    expect(itemById('one-shot').skippedDates).toEqual([]);
    expect(db.updateItem).not.toHaveBeenCalled();
    expect(db.setItemSkip).not.toHaveBeenCalled();
  });

  it('clears a completion recorded for the skipped date', () => {
    store().toggleTaskStatus('daily-task');
    expect(itemById('daily-task').completedDates).toEqual([TODAY]);

    store().setItemSkipped('daily-task', true);
    const task = itemById('daily-task');
    expect(task.completedDates).toEqual([]);
    expect(task.skippedDates).toEqual([TODAY]);
    // Completion is owned by the atomic RPC, never written as an absolute array.
    expect(db.setItemCompletion).toHaveBeenLastCalledWith('daily-task', 'task', TODAY, false);
    expect(vi.mocked(db.updateItem).mock.calls.every(([, , u]) => !('completedDates' in u))).toBe(true);
  });

  it('routes habits through the status toggle, so the snapshot status still moves', () => {
    store().setItemSkipped('habit-1', true);
    const habit = itemById('habit-1');
    expect(habit.skippedDates).toEqual([TODAY]);
    expect(habit.status).toBe('skipped');
  });

  it('undo restores the pre-skip dates', () => {
    store().setItemSkipped('daily-task', true);
    expect(itemById('daily-task').skippedDates).toEqual([TODAY]);
    store().undo();
    expect(itemById('daily-task').skippedDates).toEqual([]);
  });
});

describe('the task update allowlist refuses skippedDates', () => {
  // The inverse of what this block used to assert. skipped_dates no longer has
  // a column mapping: updateItem intercepts the field and replays it as
  // per-date intents, because an absolute write lets any writer holding a
  // partial copy of the array delete every date it never knew about — the
  // hazard that blocks windowing the arrays on read.
  //
  // The seam this originally guarded (a schema field that diffs but never
  // persists, silently dropping undo/redo of a skip) is covered instead by the
  // intent replay in planner-store's restore path — see the undo test above.
  it('maps skippedDates onto no column at all for tasks', () => {
    expect(updatesToRow('task', { skippedDates: [TODAY] })).toEqual({});
  });
});
