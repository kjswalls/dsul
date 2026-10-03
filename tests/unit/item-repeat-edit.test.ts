import { describe, it, expect, vi } from 'vitest';

/**
 * The web's repeat writes: the item dialog's two mappers, and the panel's save
 * (commitEdit) through the real store, with the goal role a repeat can take
 * back in the same gesture.
 *
 * Written against the dialog as it stood before lib/item-edit.ts took over its
 * three repeat keys (repeatPatch), and kept unedited across that move. The
 * mapper cases compare `Object.entries`, so a key written as undefined and a
 * key left out are told apart: lib/db.ts writes the one as NULL and leaves the
 * other alone. The commitEdit cases name the exact db.updateItem payloads, the
 * history labels and receipts, the goal writes, and what one undo puts back.
 * That is what the iPhone's `repeat` action restates (lib/item-edit.ts
 * repeatEditPatch, then lib/goal-roles.ts on the server), so a change here is a
 * change to what the phone must write.
 *
 * item-time-edit.test.ts's harness: the db layer mocked, the REAL store and
 * its history subscriber driven, with goals loaded through fetchGoals.
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
import {
  DRAFT_KEYS,
  commitEdit,
  draftFromItem,
  habitUpdatesFromDraft,
  taskUpdatesFromDraft,
  type ItemDraft,
} from '@/components/planner/item-dialog';
import type { RepeatFrequency } from '@dsul/types';
import type { Goal, Item } from '@/lib/planner-types';

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

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'g1',
  name: 'Learn Chinese',
  state: 'active',
  memberIds: [],
  milestoneIds: [],
  checkinIds: [],
  ...over,
});

const store = () => usePlannerStore.getState();
const item = (id: string) => store().items.find((i) => i.id === id)!;

async function load(items: Item[], goals: Goal[] = []) {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(structuredClone(items));
  vi.mocked(db.fetchGoals).mockResolvedValue(structuredClone(goals));
  await store().initializeStore(USER);
  // View state, not history state: sets the day the verbs resolve against.
  usePlannerStore.setState({ selectedDate: new Date(`${TODAY}T12:00:00Z`), userTimezone: 'UTC' });
  vi.mocked(db.updateItem).mockClear();
  vi.mocked(db.updateGoal).mockClear();
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

const TASK_FREQUENCIES: RepeatFrequency[] = ['none', 'daily', 'weekdays', 'weekends', 'monthly', 'custom'];
const HABIT_FREQUENCIES: RepeatFrequency[] = ['daily', 'weekdays', 'weekends', 'monthly', 'custom'];

/** A draft as the panel seeds it, with days and a day of the month held whatever the frequency. */
const taskDraft = (f: RepeatFrequency): ItemDraft => ({
  ...draftFromItem(task('t', 'Groceries', { startDate: TODAY, timeBucket: 'anytime' })),
  repeatFrequency: f,
  repeatDays: [1, 3],
  repeatMonthDay: 15,
});
const habitDraft = (f: RepeatFrequency): ItemDraft => ({
  ...draftFromItem(habit('h', 'Meds')),
  repeatFrequency: f,
  repeatDays: [1, 3],
  repeatMonthDay: 15,
});

describe('the mappers write the three repeat keys together', () => {
  it.each(TASK_FREQUENCIES)('a task at %s: all three keys, the days only for custom, the day only for monthly', (f) => {
    const expected = [
      ['repeatFrequency', f === 'none' ? undefined : f],
      ['repeatDays', f === 'custom' ? [1, 3] : undefined],
      ['repeatMonthDay', f === 'monthly' ? 15 : undefined],
    ];
    for (const key of ['repeatFrequency', 'repeatDays', 'repeatMonthDay']) {
      expect(Object.entries(taskUpdatesFromDraft(taskDraft(f), [key]))).toEqual(expected);
    }
  });

  it.each(HABIT_FREQUENCIES)('a habit at %s: its frequency as given, then the same two', (f) => {
    const expected = [
      ['repeatFrequency', f],
      ['repeatDays', f === 'custom' ? [1, 3] : undefined],
      ['repeatMonthDay', f === 'monthly' ? 15 : undefined],
    ];
    for (const key of ['repeatFrequency', 'repeatDays', 'repeatMonthDay']) {
      expect(Object.entries(habitUpdatesFromDraft(habitDraft(f), [key]))).toEqual(expected);
    }
  });

  it('a whole-item save keeps the three keys where they sit', () => {
    expect(Object.keys(taskUpdatesFromDraft(taskDraft('custom'), DRAFT_KEYS))).toEqual([
      'title',
      'notes',
      'priority',
      'project',
      'startDate',
      'duration',
      'startTime',
      'repeatFrequency',
      'repeatDays',
      'repeatMonthDay',
      'reminderTime',
      'reminderAnchor',
    ]);
    expect(Object.keys(habitUpdatesFromDraft(habitDraft('custom'), DRAFT_KEYS))).toEqual([
      'title',
      'notes',
      'project',
      'timesPerDay',
      'startTime',
      'duration',
      'repeatFrequency',
      'repeatDays',
      'repeatMonthDay',
      'reminderTime',
      'reminderAnchor',
    ]);
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

describe('commitEdit’s repeat on the real store', () => {
  it('a one-off made Weekdays: one write of the three keys, one Edit entry, no goal write', async () => {
    await load([task('t', 'Groceries', { startDate: TODAY, timeBucket: 'anytime' })]);
    const before = structuredClone(item('t'));
    const { keys, writes, labels } = save('t', { repeatFrequency: 'weekdays' });
    expect(keys).toEqual(['repeatFrequency']);
    expect(writes).toHaveLength(1);
    expect(writes[0].slice(0, 2)).toEqual(['t', 'task']);
    expect(Object.entries(writes[0][2])).toEqual([
      ['repeatFrequency', 'weekdays'],
      ['repeatDays', undefined],
      ['repeatMonthDay', undefined],
    ]);
    expect(labels).toEqual(['Edit task: Groceries']);
    expect(db.updateGoal).not.toHaveBeenCalled();
    undoAll(1);
    expect(item('t')).toEqual(before);
  });

  it('a habit made Custom days: one write of the three keys', async () => {
    await load([habit('h', 'Meds')]);
    const { keys, writes, labels } = save('h', { repeatFrequency: 'custom', repeatDays: [0, 3] });
    expect(keys).toEqual(['repeatFrequency', 'repeatDays']);
    expect(writes).toHaveLength(1);
    expect(writes[0].slice(0, 2)).toEqual(['h', 'habit']);
    expect(Object.entries(writes[0][2])).toEqual([
      ['repeatFrequency', 'custom'],
      ['repeatDays', [0, 3]],
      ['repeatMonthDay', undefined],
    ]);
    expect(labels).toEqual(['Edit habit: Meds']);
    expect(db.updateGoal).not.toHaveBeenCalled();
  });

  it('a check-in made No repeat: the role taken back in the same entry, with its receipt, and one undo', async () => {
    await load(
      [task('t', 'Weekly review', { startDate: '2026-09-27', timeBucket: 'anytime', repeatFrequency: 'custom', repeatDays: [0] })],
      [goal({ checkinIds: ['t'] })],
    );
    const before = structuredClone(item('t'));
    const goalsBefore = structuredClone(store().goals);
    const { writes, entries } = save('t', { repeatFrequency: 'none' });
    expect(writes).toHaveLength(1);
    expect(Object.entries(writes[0][2])).toEqual([
      ['repeatFrequency', undefined],
      ['repeatDays', undefined],
      ['repeatMonthDay', undefined],
    ]);
    expect(entries.map((e) => e.label)).toEqual(['Role changed: Weekly review']);
    expect(entries[0].receipt).toBe(
      'No longer a check-in of your Learn Chinese goal: it no longer repeats, and a check-in is a rhythm.',
    );
    expect(store().goals[0]).toMatchObject({ checkinIds: [], memberIds: ['t'], milestoneIds: [] });
    expect(vi.mocked(db.updateGoal).mock.calls).toEqual([
      [USER, 'g1', { memberIds: ['t'], milestoneIds: [], checkinIds: [] }],
    ]);
    undoAll(1);
    expect(item('t')).toEqual(before);
    expect(store().goals).toEqual(goalsBefore);
  });

  it('a milestone made Daily: the same, with the milestone’s receipt', async () => {
    await load(
      [task('t', 'Sit HSK 3', { startDate: '2026-12-05', timeBucket: 'anytime' })],
      [goal({ milestoneIds: ['t'] })],
    );
    const before = structuredClone(item('t'));
    const goalsBefore = structuredClone(store().goals);
    const { writes, entries } = save('t', { repeatFrequency: 'daily' });
    expect(writes).toHaveLength(1);
    expect(Object.entries(writes[0][2])).toEqual([
      ['repeatFrequency', 'daily'],
      ['repeatDays', undefined],
      ['repeatMonthDay', undefined],
    ]);
    expect(entries.map((e) => e.label)).toEqual(['Role changed: Sit HSK 3']);
    expect(entries[0].receipt).toBe(
      'No longer a milestone of your Learn Chinese goal: it repeats now, and a repeating item never finishes.',
    );
    expect(store().goals[0]).toMatchObject({ milestoneIds: [], memberIds: ['t'], checkinIds: [] });
    expect(vi.mocked(db.updateGoal).mock.calls).toEqual([
      [USER, 'g1', { memberIds: ['t'], milestoneIds: [], checkinIds: [] }],
    ]);
    undoAll(1);
    expect(item('t')).toEqual(before);
    expect(store().goals).toEqual(goalsBefore);
  });

  it('a check-in made Weekdays still repeats: an Edit entry, and the role kept', async () => {
    await load(
      [task('t', 'Weekly review', { startDate: '2026-09-27', timeBucket: 'anytime', repeatFrequency: 'custom', repeatDays: [0] })],
      [goal({ checkinIds: ['t'] })],
    );
    const goalsBefore = structuredClone(store().goals);
    const { writes, labels } = save('t', { repeatFrequency: 'weekdays' });
    expect(writes).toHaveLength(1);
    expect(Object.entries(writes[0][2])).toEqual([
      ['repeatFrequency', 'weekdays'],
      ['repeatDays', undefined],
      ['repeatMonthDay', undefined],
    ]);
    expect(labels).toEqual(['Edit task: Weekly review']);
    expect(store().goals).toEqual(goalsBefore);
    expect(db.updateGoal).not.toHaveBeenCalled();
  });
});
