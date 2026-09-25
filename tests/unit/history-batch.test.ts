import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * batchHistory — several single verbs folded into ONE history entry, so the
 * omnibar's multi-select run is one ⌘Z and one undo strip, not N of each.
 *
 * Same harness as undo-redo-store.test.ts: the db layer is mocked and the REAL
 * store (with its module-level history subscriber) is driven, because what is
 * under test is exactly the subscriber's view of a batch.
 */

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    fetchItems: vi.fn(async () => []),
    fetchProjects: vi.fn(async () => []),
    fetchItemTypes: vi.fn(async () => []),
    fetchRoutines: vi.fn(async () => []),
    fetchPrograms: vi.fn(async () => []),
    fetchGoals: vi.fn(async () => []),
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

import { batchHistory, getActionLog, usePlannerStore } from '@/lib/planner-store';
import { celebrateCompletion } from '@/lib/completion-confetti';
import * as db from '@/lib/db';
import { toast } from 'sonner';
import type { Goal, Item, Program, Routine } from '@/lib/planner-types';

const USER = 'user-1';
const TODAY = '2026-03-10';

const task = (id: string, over: Partial<Item> = {}): Item =>
  ({
    type: 'task',
    id,
    title: `Task ${id}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    skippedDates: [],
    ...over,
  }) as Item;

const habit = (id: string, over: Partial<Item> = {}): Item =>
  ({
    type: 'habit',
    id,
    title: `Habit ${id}`,
    project: 'Wellness',
    streak: 2,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
    ...over,
  }) as Item;

const recurring = (id: string): Item =>
  task(id, { title: `Review ${id}`, repeatFrequency: 'daily', startDate: '2026-03-01' });

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'G',
  name: 'Learn Chinese',
  state: 'active',
  memberIds: [],
  milestoneIds: [],
  checkinIds: [],
  ...over,
});

const store = () => usePlannerStore.getState();
const item = (id: string) => store().items.find((i) => i.id === id)!;
const toastCalls = () => vi.mocked(toast).mock.calls as unknown as [string, Record<string, unknown>?][];

async function load(
  items: Item[],
  extra: { goals?: Goal[]; programs?: Program[]; routines?: Routine[] } = {},
) {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(items);
  vi.mocked(db.fetchGoals).mockResolvedValue(extra.goals ?? []);
  vi.mocked(db.fetchPrograms).mockResolvedValue(extra.programs ?? []);
  vi.mocked(db.fetchRoutines).mockResolvedValue(extra.routines ?? []);
  await store().initializeStore(USER);
  // View state, not history state: sets the day the verbs resolve against.
  usePlannerStore.setState({ selectedDate: new Date(`${TODAY}T12:00:00Z`), userTimezone: 'UTC' });
  vi.mocked(toast).mockClear();
}

const setPriorities = (ids: string[]) => () => {
  for (const id of ids) store().updateTask(id, { priority: 'high' });
};

describe('batchHistory: one entry', () => {
  beforeEach(() => load([task('t1'), task('t2'), task('t3')]));

  it('folds three verbs into one entry that carries the batch size', () => {
    const before = store().historyIndex;
    const entries = getActionLog().length;
    batchHistory('Set priority: High · 3 items', 3, setPriorities(['t1', 't2', 't3']));

    expect(getActionLog()).toHaveLength(entries + 1);
    expect(getActionLog()[0]).toMatchObject({ label: 'Set priority: High · 3 items', batch: 3 });
    expect(store().historyIndex).toBe(before + 1);
    expect(store().canUndo).toBe(true);
  });

  it('one undo reverts all of it, and one redo reapplies it', () => {
    batchHistory('Set priority: High · 3 items', 3, setPriorities(['t1', 't2', 't3']));
    store().undo();
    expect(['t1', 't2', 't3'].map((id) => (item(id) as { priority?: string }).priority)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    store().redo();
    expect(['t1', 't2', 't3'].map((id) => (item(id) as { priority?: string }).priority)).toEqual([
      'high',
      'high',
      'high',
    ]);
  });

  it('records nothing for a batch that changed nothing, and leaks no label', () => {
    const entries = getActionLog().length;
    batchHistory('Nothing · 2 items', 2, () => {});
    expect(getActionLog()).toHaveLength(entries);

    store().updateTask('t1', { priority: 'low' });
    expect(getActionLog()[0].label).toMatch(/^Edit task:/);
    expect(getActionLog()[0].batch).toBeUndefined();
  });

  it('records what a throw left applied as one entry, then rethrows', () => {
    const entries = getActionLog().length;
    expect(() =>
      batchHistory('Set priority: High · 3 items', 3, () => {
        store().updateTask('t1', { priority: 'high' });
        store().updateTask('t2', { priority: 'high' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(getActionLog()).toHaveLength(entries + 1);

    store().undo();
    expect((item('t1') as { priority?: string }).priority).toBeUndefined();
    expect((item('t2') as { priority?: string }).priority).toBeUndefined();

    // The subscriber is live again: the next action is its own entry.
    store().updateTask('t3', { priority: 'low' });
    expect(getActionLog()[0].label).toMatch(/^Edit task:/);
  });

  it('a batch nested in a batch is one entry, under the outer label', () => {
    const entries = getActionLog().length;
    batchHistory('Outer', 2, () => {
      store().updateTask('t1', { priority: 'high' });
      batchHistory('Inner', 1, () => store().updateTask('t2', { priority: 'high' }));
    });
    expect(getActionLog()).toHaveLength(entries + 1);
    expect(getActionLog()[0].label).toBe('Outer');
  });
});

describe('batchHistory: quiet completion effects', () => {
  it('completes 2 habits and a one-off, celebrating once', async () => {
    await load([habit('h1'), habit('h2'), task('t1')]);
    batchHistory(
      'Complete items (3)',
      3,
      () => {
        store().toggleHabitStatus('h1', 'done');
        store().toggleHabitStatus('h2', 'done');
        store().toggleTaskStatus('t1', 'completed');
      },
      { quiet: true },
    );
    expect(item('h1')).toMatchObject({ streak: 3, completedDates: [TODAY] });
    expect(item('h2')).toMatchObject({ streak: 3, completedDates: [TODAY] });
    expect(item('t1').status).toBe('completed');
    expect(db.setItemCompletion).toHaveBeenCalledTimes(2);
    expect(celebrateCompletion).toHaveBeenCalledTimes(1);
  });

  it('celebrates a batch of habits alone', async () => {
    // The gate is "something completed", not "something was deferred" — a
    // habit that is nobody's check-in defers nothing, and must still count.
    await load([habit('h1'), habit('h2')]);
    batchHistory(
      'Complete items (2)',
      2,
      () => {
        store().toggleHabitStatus('h1', 'done');
        store().toggleHabitStatus('h2', 'done');
      },
      { quiet: true },
    );
    expect(celebrateCompletion).toHaveBeenCalledTimes(1);
  });

  it('a quiet batch inside a loud one still fires once, with no per-item offers', async () => {
    await load([recurring('c1'), recurring('c2')], {
      goals: [goal({ checkinIds: ['c1', 'c2'] })],
    });
    batchHistory('Outer', 2, () => {
      batchHistory(
        'Complete items (2)',
        2,
        () => {
          store().toggleTaskStatus('c1', 'completed');
          store().toggleTaskStatus('c2', 'completed');
        },
        { quiet: true },
      );
    });
    expect(celebrateCompletion).toHaveBeenCalledTimes(1);
    const checkins = toastCalls().filter(([title]) => title.startsWith('Checked in on'));
    expect(checkins).toHaveLength(1);
    expect(checkins[0][1]?.description).toBe('Anything worth remembering about these?');
  });

  it('offers achievement once per goal, however many milestones closed', async () => {
    await load([task('s1'), task('s2'), task('s3')], {
      goals: [goal({ milestoneIds: ['s1', 's2', 's3'] })],
    });
    batchHistory(
      'Complete items (3)',
      3,
      () => ['s1', 's2', 's3'].forEach((id) => store().toggleTaskStatus(id, 'completed')),
      { quiet: true },
    );
    const offers = toastCalls().filter(([, opts]) => opts?.id === 'achieve:G');
    expect(offers).toHaveLength(1);
  });

  it('raises ONE check-in summary whose note reaches every pair and goal', async () => {
    const spy = vi.spyOn(window, 'prompt').mockReturnValue('steady');
    await load([recurring('c1'), recurring('c2')], {
      goals: [
        goal({ id: 'g1', name: 'Chinese', checkinIds: ['c1', 'c2'] }),
        goal({ id: 'g2', name: 'Reading', checkinIds: ['c2'] }),
      ],
    });
    batchHistory(
      'Complete items (2)',
      2,
      () => ['c1', 'c2'].forEach((id) => store().toggleTaskStatus(id, 'completed')),
      { quiet: true },
    );
    const checkins = toastCalls().filter(([title]) => title.startsWith('Checked in on'));
    expect(checkins).toHaveLength(1);
    expect(checkins[0][0]).toBe('Checked in on Chinese +1');

    (checkins[0][1]?.action as { onClick: () => void }).onClick();
    const written = vi.mocked(db.recordCheckin).mock.calls.map((c) => `${c[0]}:${c[2]}:${c[3]}`);
    expect(written.sort()).toEqual([`c1:g1:${TODAY}`, `c2:g1:${TODAY}`, `c2:g2:${TODAY}`]);
    spy.mockRestore();
  });

  it('a single check-in in a batch gets the ordinary offer', async () => {
    await load([recurring('c1'), task('t1')], { goals: [goal({ checkinIds: ['c1'] })] });
    batchHistory(
      'Complete items (2)',
      2,
      () => {
        store().toggleTaskStatus('c1', 'completed');
        store().toggleTaskStatus('t1', 'completed');
      },
      { quiet: true },
    );
    const checkins = toastCalls().filter(([title]) => title.startsWith('Checked in on'));
    expect(checkins).toHaveLength(1);
    expect(checkins[0][1]?.description).toBe('Anything worth remembering about this one?');
  });
});

describe('batchHistory: landing receipts', () => {
  const paused: Program = {
    id: 'p1',
    name: 'Summer',
    state: 'paused',
    itemIds: ['t1', 't2', 't3'],
    routineIds: [],
  };

  const snooze = () =>
    batchHistory('Snooze to tomorrow · 3 items', 3, () => {
      for (const id of ['t1', 't2', 't3']) store().updateTask(id, { startDate: '2026-03-11' });
    });

  it('says one shared reason once', async () => {
    await load([task('t1'), task('t2'), task('t3')], { programs: [paused] });
    snooze();
    expect(getActionLog()[0].receipt).toBe('Hidden with your Summer program');
  });

  it('counts when the reasons differ', async () => {
    await load([task('t1'), task('t2'), task('t3')], {
      programs: [{ ...paused, itemIds: ['t1', 't2'] }],
      routines: [
        { id: 'r1', name: 'Mornings', itemIds: ['t3'], pausedAt: '2026-03-01T00:00:00.000Z' },
      ],
    });
    snooze();
    expect(getActionLog()[0].receipt).toBe('3 of these are hidden where they landed');
  });
});
