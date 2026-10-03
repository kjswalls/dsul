import { describe, it, expect, vi } from 'vitest';

/**
 * The web's schedule writes: the store's schedule actions, and the item
 * panel's save (commitEdit) that calls them, pinned call for call.
 *
 * Written against the store as it stood before lib/item-edit.ts took over
 * their patches (scheduleTaskPatch, UNSCHEDULE_TASK_PATCH, scheduleHabitPatch)
 * and commitEdit's second pass (planTimeEdit), and kept unedited across that
 * move: each case names the exact db.updateItem payloads, in order and key for
 * key, the history labels they leave, and how many undos put the item back.
 * That is what the iPhone's `time` action restates (lib/item-edit.ts
 * timeEditPatch), so a change here is a change to what the phone must write.
 *
 * history-batch.test.ts's harness: the db layer mocked, the REAL store and its
 * history subscriber driven. A history entry is saved only when a call changed
 * the items' JSON, so a call that repeats what the item holds reaches
 * db.updateItem and leaves no entry.
 */

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    fetchItems: vi.fn(async () => []),
    fetchProjects: vi.fn(async () => []),
    fetchItemTypes: vi.fn(async () => []),
    fetchRoutines: vi.fn(async () => []),
    fetchSeasons: vi.fn(async () => []),
    fetchGoals: vi.fn(async () => []),
    // No RPC: the per-table fallback, started synchronously (the fetchers above).
    loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
    createItem: vi.fn(async () => {}),
    updateItem: vi.fn(async () => {}),
    deleteItem: vi.fn(async () => {}),
    restoreItem: vi.fn(async () => {}),
    setItemCompletion: vi.fn(async () => {}),
    setItemSkip: vi.fn(async () => {}),
    updateGoal: vi.fn(async () => {}),
    recordCheckin: vi.fn(),
  };
});
vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/completion-confetti', () => ({ celebrateCompletion: vi.fn() }));

import { getActionLog, usePlannerStore, type ActionLogEntry } from '@/lib/planner-store';
import * as db from '@/lib/db';
import { DRAFT_KEYS, commitEdit, draftFromItem, type ItemDraft } from '@/components/planner/item-dialog';
import type { Item } from '@/lib/planner-types';

const USER = 'user-1';
const TODAY = '2026-10-01';

const task = (id: string, title: string, over: Record<string, unknown> = {}): Item =>
  ({ type: 'task', id, title, status: 'pending', isScheduled: true, order: 0, ...over }) as Item;

const habit = (id: string, title: string, over: Record<string, unknown> = {}): Item =>
  ({
    type: 'habit',
    id,
    title,
    streak: 0,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
    ...over,
  }) as Item;

/** A task in a project block: its own slot remembered, to come back to on release. */
const block = (id: string) =>
  task(id, 'Review PRs', {
    startDate: TODAY,
    timeBucket: 'morning',
    inProjectBlock: true,
    previousStartTime: '14:00',
    previousStartDate: '2026-09-30',
  });

const store = () => usePlannerStore.getState();
const item = (id: string) => store().items.find((i) => i.id === id)!;

async function load(items: Item[]) {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(structuredClone(items));
  await store().initializeStore(USER);
  // View state, not history state: sets the day the verbs resolve against.
  usePlannerStore.setState({ selectedDate: new Date(`${TODAY}T12:00:00Z`), userTimezone: 'UTC' });
  vi.mocked(db.updateItem).mockClear();
}

type Write = [id: string, type: string, payload: Record<string, unknown>];

/**
 * Every db.updateItem call `act` made, in order, and the history entries it
 * added, oldest first.
 */
function record(act: () => void): { writes: Write[]; entries: ActionLogEntry[]; labels: string[] } {
  const before = getActionLog().length;
  vi.mocked(db.updateItem).mockClear();
  act();
  const writes = vi.mocked(db.updateItem).mock.calls.map(
    ([id, type, payload]) => [id, type, payload as Record<string, unknown>] as Write,
  );
  const entries = getActionLog()
    .slice(0, getActionLog().length - before)
    .reverse();
  return { writes, entries, labels: entries.map((e) => e.label) };
}

/** Undo `n` times; the item is then as it was before the act. */
function undoAll(n: number) {
  for (let k = 0; k < n; k++) store().undo();
}

describe('the store’s schedule actions', () => {
  it('scheduleTask: scheduled, the bucket auto-corrected, and out of the project block', async () => {
    await load([block('t')]);
    const before = structuredClone(item('t'));
    const { writes, labels } = record(() => store().scheduleTask('t', 'morning', '15:00'));
    expect(writes).toHaveLength(1);
    const [id, type, payload] = writes[0];
    expect([id, type]).toEqual(['t', 'task']);
    expect(Object.keys(payload)).toEqual([
      'isScheduled',
      'timeBucket',
      'startTime',
      'inProjectBlock',
      'previousStartTime',
      'previousStartDate',
    ]);
    expect(payload).toEqual({
      isScheduled: true,
      timeBucket: 'afternoon',
      startTime: '15:00',
      inProjectBlock: false,
      previousStartTime: undefined,
      previousStartDate: undefined,
    });
    expect(labels).toEqual(['Schedule task: Review PRs']);
    expect(item('t')).toMatchObject({ timeBucket: 'afternoon', startTime: '15:00', inProjectBlock: false });
    undoAll(1);
    expect(item('t')).toEqual(before);
  });

  it('scheduleTask with a date: the same, and the date last', async () => {
    await load([block('t')]);
    const { writes } = record(() => store().scheduleTask('t', 'morning', '15:00', '2026-10-02'));
    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0][2])).toEqual([
      'isScheduled',
      'timeBucket',
      'startTime',
      'inProjectBlock',
      'previousStartTime',
      'previousStartDate',
      'startDate',
    ]);
    expect(writes[0][2]).toEqual({
      isScheduled: true,
      timeBucket: 'afternoon',
      startTime: '15:00',
      inProjectBlock: false,
      previousStartTime: undefined,
      previousStartDate: undefined,
      startDate: '2026-10-02',
    });
  });

  it('unscheduleTask: back to the braindump, the four keys, undone whole', async () => {
    await load([task('t', 'Call the bank', { startDate: TODAY, timeBucket: 'morning', startTime: '09:00' })]);
    const before = structuredClone(item('t'));
    const { writes, labels } = record(() => store().unscheduleTask('t'));
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe('t');
    expect(Object.keys(writes[0][2])).toEqual(['isScheduled', 'timeBucket', 'startTime', 'startDate']);
    expect(writes[0][2]).toEqual({
      isScheduled: false,
      timeBucket: undefined,
      startTime: undefined,
      startDate: undefined,
    });
    expect(labels).toEqual(['Unschedule task: Call the bank']);
    undoAll(1);
    expect(item('t')).toEqual(before);
  });

  it('unscheduleTasks: the same four keys for each, one entry, one undo', async () => {
    await load([
      task('a', 'Call the bank', { startDate: TODAY, timeBucket: 'morning', startTime: '09:00' }),
      task('b', 'Groceries', { startDate: TODAY, timeBucket: 'anytime' }),
    ]);
    const before = structuredClone(store().items);
    const { writes, labels } = record(() => store().unscheduleTasks(['a', 'b']));
    expect(writes.map(([id]) => id)).toEqual(['a', 'b']);
    for (const [, type, payload] of writes) {
      expect(type).toBe('task');
      expect(Object.keys(payload)).toEqual(['isScheduled', 'timeBucket', 'startTime', 'startDate']);
      expect(payload).toEqual({ isScheduled: false, timeBucket: undefined, startTime: undefined, startDate: undefined });
    }
    expect(labels).toEqual(['Unschedule task: 2 items']);
    undoAll(1);
    expect(store().items).toEqual(before);
  });

  it('scheduleHabit: the bucket auto-corrected to the time', async () => {
    await load([habit('h', 'Meds', { timeBucket: 'morning' })]);
    const before = structuredClone(item('h'));
    const { writes, labels } = record(() => store().scheduleHabit('h', 'evening', '09:00'));
    expect(writes).toHaveLength(1);
    expect(writes[0].slice(0, 2)).toEqual(['h', 'habit']);
    expect(Object.keys(writes[0][2])).toEqual(['timeBucket', 'startTime']);
    expect(writes[0][2]).toEqual({ timeBucket: 'morning', startTime: '09:00' });
    expect(labels).toEqual(['Schedule habit: Meds']);
    undoAll(1);
    expect(item('h')).toEqual(before);
  });

  it('updateTask: a new time files the task in its part of day, and leaves Anytime alone', async () => {
    await load([
      task('m', 'Standup', { startDate: TODAY, timeBucket: 'morning', startTime: '10:00' }),
      task('a', 'Groceries', { startDate: TODAY, timeBucket: 'anytime' }),
    ]);
    const morning = record(() => store().updateTask('m', { startTime: '15:00' }));
    expect(morning.writes).toEqual([['m', 'task', { startTime: '15:00', timeBucket: 'afternoon' }]]);
    expect(Object.keys(morning.writes[0][2])).toEqual(['startTime', 'timeBucket']);
    expect(morning.labels).toEqual(['Edit task: Standup']);

    const anytime = record(() => store().updateTask('a', { startTime: '15:00' }));
    expect(anytime.writes).toEqual([['a', 'task', { startTime: '15:00' }]]);
    expect(Object.keys(anytime.writes[0][2])).toEqual(['startTime']);
    expect(anytime.labels).toEqual(['Edit task: Groceries']);
  });
});

/**
 * The item panel's save, as scheduleSave and flush call it: the draft seeded
 * from the item (draftFromItem), `change` applied as the chip applies it, the
 * DRAFT_KEYS that moved from the seed, then commitEdit with them.
 */
function save(id: string, change: Partial<ItemDraft>) {
  const live = item(id);
  const prev = draftFromItem(live);
  const next: ItemDraft = { ...prev, ...change };
  const keys = DRAFT_KEYS.filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
  return { keys, ...record(() => commitEdit(live, next, keys)) };
}

/** scheduleTask's whole patch, for `bucket` and `time`. */
const scheduled = (bucket: string, time?: string) => ({
  isScheduled: true,
  timeBucket: bucket,
  startTime: time,
  inProjectBlock: false,
  previousStartTime: undefined,
  previousStartDate: undefined,
});

describe('commitEdit on the real store', () => {
  it('a new time in its own part of day: the mapper, then setTime, one entry', async () => {
    await load([task('t', 'Draft Q4 roadmap', { startDate: TODAY, timeBucket: 'morning', startTime: '09:00' })]);
    const before = structuredClone(item('t'));
    const { keys, writes, labels } = save('t', { startTime: '10:30' });
    expect(keys).toEqual(['startTime']);
    expect(writes).toEqual([
      ['t', 'task', { startTime: '10:30' }],
      ['t', 'task', { startTime: '10:30' }],
    ]);
    // The second repeats the first, so it changes nothing and saves no entry.
    expect(labels).toEqual(['Edit task: Draft Q4 roadmap']);
    undoAll(1);
    expect(item('t')).toEqual(before);
  });

  it('a new part of day alone: one scheduleTask, nothing from the mapper', async () => {
    await load([task('t', 'Draft Q4 roadmap', { startDate: TODAY, timeBucket: 'morning' })]);
    const before = structuredClone(item('t'));
    const { writes, labels } = save('t', { timeBucket: 'afternoon' });
    expect(writes).toEqual([['t', 'task', scheduled('afternoon')]]);
    expect(Object.keys(writes[0][2])).toEqual(Object.keys(scheduled('afternoon')));
    expect(labels).toEqual(['Schedule task: Draft Q4 roadmap']);
    undoAll(1);
    expect(item('t')).toEqual(before);
  });

  it('a new part of day and a time: the mapper auto-corrected, then scheduleTask, two entries', async () => {
    await load([task('t', 'Gym', { startDate: TODAY, timeBucket: 'morning', startTime: '09:00' })]);
    const before = structuredClone(item('t'));
    const { keys, writes, labels } = save('t', { timeBucket: 'evening', startTime: '19:00' });
    expect(keys).toEqual(['timeBucket', 'startTime']);
    expect(writes).toEqual([
      ['t', 'task', { startTime: '19:00', timeBucket: 'evening' }],
      ['t', 'task', scheduled('evening', '19:00')],
    ]);
    // scheduleTask adds inProjectBlock: false, which the item lacked: a change.
    expect(labels).toEqual(['Edit task: Gym', 'Schedule task: Gym']);
    undoAll(2);
    expect(item('t')).toEqual(before);
  });

  it('a date on an undated braindump task: the date, then scheduleTask at Anytime', async () => {
    await load([task('t', 'Call the bank', { isScheduled: false })]);
    const before = structuredClone(item('t'));
    const { keys, writes, entries } = save('t', { startDate: new Date(2026, 9, 1) });
    expect(keys).toEqual(['startDate']);
    expect(writes).toEqual([
      ['t', 'task', { startDate: TODAY }],
      ['t', 'task', scheduled('anytime')],
    ]);
    expect(entries.map((e) => e.label)).toEqual(['Edit task: Call the bank', 'Schedule task: Call the bank']);
    // An ordinary day hides nothing, so neither carries a landing receipt.
    expect(entries.map((e) => e.receipt)).toEqual([undefined, undefined]);
    undoAll(2);
    expect(item('t')).toEqual(before);
  });

  it('a date cleared: the date, then the four-key unschedule', async () => {
    await load([task('t', 'Call the bank', { startDate: TODAY, timeBucket: 'morning' })]);
    const before = structuredClone(item('t'));
    const { writes, labels } = save('t', { startDate: undefined });
    expect(writes).toEqual([
      ['t', 'task', { startDate: undefined }],
      ['t', 'task', { isScheduled: false, timeBucket: undefined, startTime: undefined, startDate: undefined }],
    ]);
    expect(Object.keys(writes[0][2])).toEqual(['startDate']);
    expect(Object.keys(writes[1][2])).toEqual(['isScheduled', 'timeBucket', 'startTime', 'startDate']);
    expect(labels).toEqual(['Edit task: Call the bank', 'Unschedule task: Call the bank']);
    undoAll(2);
    expect(item('t')).toEqual(before);
  });

  it('a habit’s part of day is one scheduleHabit, and No specific bucket one updateHabit', async () => {
    await load([habit('h', 'Stretch', { timeBucket: 'morning' })]);
    const before = structuredClone(item('h'));
    const evening = save('h', { timeBucket: 'evening' });
    expect(evening.writes).toEqual([['h', 'habit', { timeBucket: 'evening', startTime: undefined }]]);
    expect(Object.keys(evening.writes[0][2])).toEqual(['timeBucket', 'startTime']);
    expect(evening.labels).toEqual(['Schedule habit: Stretch']);
    undoAll(1);
    expect(item('h')).toEqual(before);

    // Fresh, so the undo above leaves no redo for this entry to cut.
    await load([habit('h', 'Stretch', { timeBucket: 'morning' })]);
    // The row sets both, as the web's "No specific bucket" does; the time was already ''.
    const none = save('h', { timeBucket: 'none', startTime: '' });
    expect(none.keys).toEqual(['timeBucket']);
    expect(none.writes).toEqual([['h', 'habit', { timeBucket: undefined, startTime: undefined }]]);
    expect(Object.keys(none.writes[0][2])).toEqual(['timeBucket', 'startTime']);
    expect(none.labels).toEqual(['Edit habit: Stretch']);
    undoAll(1);
    expect(item('h')).toEqual(before);
  });

  it('a length alone: the duration, and no schedule call', async () => {
    await load([
      task('t', 'Review PRs', { startDate: TODAY, timeBucket: 'afternoon', startTime: '13:30', duration: 60 }),
    ]);
    const { keys, writes, labels } = save('t', { duration: '90' });
    expect(keys).toEqual(['duration']);
    expect(writes).toEqual([['t', 'task', { duration: 90 }]]);
    expect(labels).toEqual(['Edit task: Review PRs']);
  });

  describe('in a project block', () => {
    it('a new part of day releases it, in one scheduleTask, and one undo puts it back', async () => {
      await load([block('t')]);
      const before = structuredClone(item('t'));
      const { writes, labels } = save('t', { timeBucket: 'afternoon' });
      expect(writes).toEqual([['t', 'task', scheduled('afternoon')]]);
      expect(labels).toEqual(['Schedule task: Review PRs']);
      expect(item('t')).toMatchObject({ inProjectBlock: false, timeBucket: 'afternoon' });
      expect(item('t')).not.toHaveProperty('previousStartTime', '14:00');
      undoAll(1);
      expect(item('t')).toEqual(before);
    });

    it('a new time in the same part of day keeps it: two calls, one entry', async () => {
      await load([block('t')]);
      const before = structuredClone(item('t'));
      const { writes, labels } = save('t', { startTime: '09:30' });
      expect(writes).toEqual([
        ['t', 'task', { startTime: '09:30' }],
        ['t', 'task', { startTime: '09:30' }],
      ]);
      expect(labels).toEqual(['Edit task: Review PRs']);
      expect(item('t')).toMatchObject({
        inProjectBlock: true,
        previousStartTime: '14:00',
        previousStartDate: '2026-09-30',
      });
      undoAll(1);
      expect(item('t')).toEqual(before);
    });

    it('a new time across parts of day keeps it too, filed by the time', async () => {
      await load([block('t')]);
      const { writes, labels } = save('t', { startTime: '15:00' });
      expect(writes).toEqual([
        ['t', 'task', { startTime: '15:00', timeBucket: 'afternoon' }],
        ['t', 'task', { startTime: '15:00' }],
      ]);
      expect(labels).toEqual(['Edit task: Review PRs']);
      expect(item('t')).toMatchObject({ inProjectBlock: true, timeBucket: 'afternoon', startTime: '15:00' });
    });
  });

  it('a draft equal to its seed writes nothing and saves no entry', async () => {
    await load([block('t')]);
    const { keys, writes, labels } = save('t', {});
    expect(keys).toEqual([]);
    expect(writes).toEqual([]);
    expect(labels).toEqual([]);
  });
});
