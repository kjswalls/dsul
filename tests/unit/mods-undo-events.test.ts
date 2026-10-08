import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * ⌘Z's own event, for mods only (lib/mods/undo-events.ts and planner-store's
 * undo(), memory/plans/mods.md build order 8): what it reports, that it rides
 * its own bus so no recipe hears it, and that redo raises nothing.
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
    loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
    createItem: vi.fn(async () => {}),
    createItems: vi.fn(async () => {}),
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

import { batchHistory, usePlannerStore } from '@/lib/planner-store';
import {
  __resetModEventsForTests,
  subscribeModEvents,
  subscribeModOnlyEvents,
  type ModEvent,
  type ModOnlyEvent,
} from '@/lib/mod-events';
import { uncompletionsBetween } from '@/lib/mods/undo-events';
import * as db from '@/lib/db';
import type { Item } from '@/lib/planner-types';

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

const recurring = (id: string, over: Partial<Item> = {}): Item =>
  task(id, { repeatFrequency: 'daily', startDate: '2026-03-01', ...over });

describe('uncompletionsBetween', () => {
  it('reports each date a habit or recurring item lost', () => {
    const before = [habit('h', { completedDates: ['2026-03-09', TODAY] }), recurring('r', { completedDates: [TODAY] })];
    const after = [habit('h', { completedDates: ['2026-03-09'] }), recurring('r', { completedDates: [] })];
    expect(uncompletionsBetween(before, after, TODAY)).toEqual([
      { kind: 'item.uncompleted', origin: 'undo', itemId: 'h', date: TODAY, type: 'habit' },
      { kind: 'item.uncompleted', origin: 'undo', itemId: 'r', date: TODAY, type: 'task' },
    ]);
  });

  it('dates a one-off by its startDate, else today', () => {
    const before = [task('a', { status: 'completed', startDate: '2026-03-08' }), task('b', { status: 'completed' })];
    const after = [task('a'), task('b')];
    expect(uncompletionsBetween(before, after, TODAY).map((e) => [e.itemId, e.date])).toEqual([
      ['a', '2026-03-08'],
      ['b', TODAY],
    ]);
  });

  it('says nothing of an item the undo added or removed, or that stayed done', () => {
    expect(uncompletionsBetween([task('a', { status: 'completed' })], [], TODAY)).toEqual([]);
    expect(uncompletionsBetween([], [task('a')], TODAY)).toEqual([]);
    const done = task('a', { status: 'completed' });
    expect(uncompletionsBetween([done], [done], TODAY)).toEqual([]);
  });
});

describe('undo in the store', () => {
  const store = () => usePlannerStore.getState();
  let only: ModOnlyEvent[] = [];
  let events: ModEvent[] = [];

  async function load(items: Item[]) {
    store().clearStore();
    vi.mocked(db.fetchItems).mockResolvedValue(items);
    await store().initializeStore(USER);
    usePlannerStore.setState({ selectedDate: new Date(`${TODAY}T12:00:00Z`), userTimezone: 'UTC' });
    vi.runAllTimers();
    only = [];
    events = [];
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
    __resetModEventsForTests();
    subscribeModOnlyEvents((e) => void only.push(e));
    subscribeModEvents((e) => void events.push(e));
  });
  afterEach(() => vi.useRealTimers());

  it('undoing a tick raises one ModOnlyEvent with the undone label, and no ModEvent', async () => {
    await load([habit('h1'), task('t1')]);
    store().toggleHabitStatus('h1', 'done');
    vi.runAllTimers();
    expect(events.map((e) => e.kind)).toEqual(['item.completed']);
    events = [];

    store().undo();
    vi.runAllTimers();
    expect(events).toEqual([]);
    expect(only).toEqual([
      {
        kind: 'item.uncompleted',
        origin: 'undo',
        itemId: 'h1',
        date: TODAY,
        type: 'habit',
        undoneLabel: expect.stringMatching(/^Complete habit: /),
      },
    ]);
  });

  it('undoing a one-off tick dates it by its startDate', async () => {
    await load([task('t1', { startDate: '2026-03-08' })]);
    store().toggleTaskStatus('t1');
    vi.runAllTimers();
    store().undo();
    vi.runAllTimers();
    expect(only.map((e) => [e.itemId, e.date, e.type])).toEqual([['t1', '2026-03-08', 'task']]);
  });

  it('carries the label of a mod run it took back', async () => {
    await load([task('t1')]);
    batchHistory('Mod: Water · command Log', 1, () => store().toggleTaskStatus('t1'), { quiet: true });
    vi.runAllTimers();
    store().undo();
    vi.runAllTimers();
    expect(only.map((e) => e.undoneLabel)).toEqual(['Mod: Water · command Log']);
  });

  it('raises nothing for a ⌘Z the look-only preview refused, and the same ⌘Z after the landing does', async () => {
    // memory/plans/instant-planner.md: undo is refused while previewing (the
    // write barrier), and the refusal returns before the history is read, so a
    // mod never hears an uncompletion computed against cached rows.
    await load([habit('h1')]);
    store().toggleHabitStatus('h1', 'done');
    vi.runAllTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    usePlannerStore.setState({ isPreview: true });
    store().undo();
    vi.runAllTimers();
    expect(only).toEqual([]);
    expect(store().items.find((i) => i.id === 'h1')?.completedDates).toEqual([TODAY]);
    usePlannerStore.setState({ isPreview: false });
    warn.mockRestore();
    store().undo();
    vi.runAllTimers();
    expect(only.map((e) => [e.kind, e.itemId])).toEqual([['item.uncompleted', 'h1']]);
  });

  it('redo raises nothing, and an undo that took no completion away raises nothing', async () => {
    await load([task('t1')]);
    store().toggleTaskStatus('t1');
    vi.runAllTimers();
    store().undo();
    vi.runAllTimers();
    only = [];
    events = [];
    store().redo();
    vi.runAllTimers();
    expect(only).toEqual([]);
    expect(events).toEqual([]);

    store().updateTask('t1', { title: 'Renamed' });
    vi.runAllTimers();
    store().undo();
    vi.runAllTimers();
    expect(only).toEqual([]);
  });
});
