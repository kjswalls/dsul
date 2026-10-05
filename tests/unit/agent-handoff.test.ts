import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The right-click menu's hand-off (lib/agent-handoff.ts). Three things are
 * pinned here:
 *
 *  - the gates: `canHandOff` offers an item only when the agent would actually
 *    see it, and `canTakeBack` only while the agent holds it in a live state;
 *  - the writes: one undoable history entry each, named so the undo strip
 *    offers ⌘Z, through the real store (db fully mocked, undo-redo-store's
 *    pattern, so the history subscriber runs);
 *  - parity with the agent's own queue filter (lib/mcp/tools.ts
 *    `selectAssignedWork`): whatever the menu hands off, the queue serves, and
 *    what the menu refuses as finished or paused, the queue would not serve.
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
  changeItemType: vi.fn(async () => {}),
  restoreItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  createProject: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  deleteProject: vi.fn(async () => {}),
  restoreProject: vi.fn(async () => {}),
  renameContainerMembers: vi.fn(async () => {}),
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
  loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
  fetchAgentStates: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import {
  DELEGATE_ASSIGNEE,
  canHandOff,
  canTakeBack,
  delegateName,
  handOffItem,
  takeBackItem,
  type HandOffContext,
} from '@/lib/agent-handoff';
import { inactiveItemIdsOn, isOpenLoopOn, type ActivationContext } from '@/lib/active';
import { getItemTypeConfig } from '@/lib/item-registry';
import { selectAssignedWork } from '@/lib/mcp/tools';
import { usePlannerStore } from '@/lib/planner-store';
import { isToastWorthy } from '@/hooks/use-undo-toast';
import * as db from '@/lib/db';
import type { Item, Routine, Season, TaskItem } from '@/lib/planner-types';

const USER = 'user-1';
const TODAY = '2026-10-05'; // Monday
const NOW = `${TODAY}T12:00:00.000Z`;
const TZ = 'UTC';
const T0 = '2026-10-04T09:00:00.000Z';

const task = (over: Record<string, unknown> = {}): Item =>
  ({
    id: 't1',
    type: 'task',
    title: 'Book dentist',
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    ...over,
  }) as unknown as Item;

const habit = (over: Record<string, unknown> = {}): Item =>
  ({
    id: 'h1',
    type: 'habit',
    title: 'Stretch',
    status: 'pending',
    repeatFrequency: 'daily',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    streak: 0,
    ...over,
  }) as unknown as Item;

const custom = (over: Record<string, unknown> = {}): Item =>
  ({
    id: 'c1',
    type: 'custom',
    customType: 'errand',
    title: 'Pick up parcel',
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    ...over,
  }) as unknown as Item;

const on = (over: Partial<HandOffContext> = {}): HandOffContext => ({
  canDelegate: true,
  todayStr: TODAY,
  inactiveIds: new Set(),
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

describe('DELEGATE_ASSIGNEE / delegateName', () => {
  it('hands to openclaw, the only assignee the queue consumes, and calls it OpenClaw', () => {
    expect(DELEGATE_ASSIGNEE).toBe('openclaw');
    expect(delegateName()).toBe('OpenClaw');
  });
});

describe('canHandOff', () => {
  it('offers an open one-off task while an agent is paired', () => {
    expect(canHandOff(task(), on())).toBe(true);
  });

  it('offers nothing while the gate is off, whatever the item', () => {
    expect(canHandOff(task(), on({ canDelegate: false }))).toBe(false);
  });

  it('asks the registry, so a habit is never offered', () => {
    expect(getItemTypeConfig('habit').agentAssignable).toBe(false);
    expect(canHandOff(habit(), on())).toBe(false);
  });

  it('asks the registry, so a custom-type item is never offered', () => {
    // Unhydrated slug: the default template, which says no.
    expect(getItemTypeConfig('errand').agentAssignable).toBe(false);
    expect(canHandOff(custom(), on())).toBe(false);
  });

  it('refuses an item already assigned, to the agent or to anyone else', () => {
    expect(canHandOff(task({ assignee: 'openclaw', aiStatus: 'queued' }), on())).toBe(false);
    expect(canHandOff(task({ assignee: 'openclaw', aiStatus: 'done', aiResult: 'Booked' }), on())).toBe(false);
    expect(canHandOff(task({ assignee: 'beacon' }), on())).toBe(false);
    // An empty assignee is no assignee.
    expect(canHandOff(task({ assignee: '' }), on())).toBe(true);
  });

  it('refuses a repeating task, even on a day it is open', () => {
    const series = task({ startDate: '2026-10-01', repeatFrequency: 'daily' });
    expect(isOpenLoopOn(series, TODAY)).toBe(true);
    expect(canHandOff(series, on())).toBe(false);
    // repeatFrequency 'none' is not repeating.
    expect(canHandOff(task({ repeatFrequency: 'none' }), on())).toBe(true);
  });

  it('refuses a completed or cancelled one-off', () => {
    for (const status of ['completed', 'cancelled'] as const) {
      const done = task({ status });
      expect(isOpenLoopOn(done, TODAY)).toBe(false);
      expect(canHandOff(done, on())).toBe(false);
    }
  });

  it('refuses an item the caller knows is paused or switched off today', () => {
    expect(canHandOff(task(), on({ inactiveIds: new Set(['t1']) }))).toBe(false);
    // Only that item: another id in the set changes nothing.
    expect(canHandOff(task(), on({ inactiveIds: new Set(['other']) }))).toBe(true);
  });

  it('takes inactiveIds as computed by lib/active for an item-level pause', () => {
    const paused = task({ pausedAt: '2026-10-01T00:00:00.000Z', pausedUntil: '2026-10-10' });
    const inactiveIds = inactiveItemIdsOn([paused], TODAY, { userTimezone: TZ });
    expect(inactiveIds.has('t1')).toBe(true);
    expect(canHandOff(paused, on({ inactiveIds }))).toBe(false);

    // A pause that ends today (pausedUntil is exclusive) is over.
    const resumed = task({ pausedAt: '2026-10-01T00:00:00.000Z', pausedUntil: TODAY });
    const none = inactiveItemIdsOn([resumed], TODAY, { userTimezone: TZ });
    expect(none.has('t1')).toBe(false);
    expect(canHandOff(resumed, on({ inactiveIds: none }))).toBe(true);
  });

  it('a pending one-off is open whatever its date: undated, today, past or future', () => {
    // isOpenLoopOn reads a one-off's status alone, never its date, so the
    // hand-off is offered on all four; the date only decides where it draws.
    const cases = [
      task({ id: 'undated' }),
      task({ id: 'today', startDate: TODAY, isScheduled: true }),
      task({ id: 'past', startDate: '2026-09-20', isScheduled: true }),
      task({ id: 'future', startDate: '2026-11-01', isScheduled: true }),
    ];
    for (const item of cases) {
      expect(isOpenLoopOn(item, TODAY), item.id).toBe(true);
      expect(canHandOff(item, on()), item.id).toBe(true);
    }
  });
});

describe('canTakeBack', () => {
  it('while the agent holds it in a live state', () => {
    for (const aiStatus of ['queued', 'working', 'blocked', 'failed']) {
      expect(canTakeBack(task({ assignee: 'openclaw', aiStatus })), aiStatus).toBe(true);
    }
  });

  it('not once it is done: taking back would clear the report the panel keeps', () => {
    expect(canTakeBack(task({ assignee: 'openclaw', aiStatus: 'done', aiResult: 'Booked' }))).toBe(false);
  });

  it('not for a status outside the vocabulary, a prototype key included', () => {
    for (const aiStatus of ['paused', 'QUEUED', '', 'toString', 'hasOwnProperty']) {
      expect(canTakeBack(task({ assignee: 'openclaw', aiStatus })), aiStatus).toBe(false);
    }
  });

  it('not for an item nobody holds', () => {
    expect(canTakeBack(task())).toBe(false);
    expect(canTakeBack(task({ aiStatus: 'queued' }))).toBe(false);
    expect(canTakeBack(task({ assignee: '', aiStatus: 'queued' }))).toBe(false);
  });

  it('not for an assignment with no status yet (the queue still serves it as queued)', () => {
    // Real behaviour, pinned: hasAgentState wants a known status. The agent
    // API can write `assignee` alone, and selectAssignedWork treats a missing
    // aiStatus as queued, so such an item is in the agent's queue while the
    // menu offers neither a hand-off (it is assigned) nor a take-back.
    const assignedOnly = task({ assignee: 'openclaw' });
    expect(canTakeBack(assignedOnly)).toBe(false);
    expect(canHandOff(assignedOnly, on())).toBe(false);
    expect(
      selectAssignedWork({ items: [assignedOnly], fetchedAt: NOW, userTimezone: TZ }).assigned.map((i) => i.id)
    ).toEqual(['t1']);
  });

  it('never depends on the agent being paired, and holds for any assignee', () => {
    // No context argument at all: the gate is not consulted.
    expect(canTakeBack(task({ assignee: 'beacon', aiStatus: 'working' }))).toBe(true);
  });

  it('takes back a finished or paused item the agent still holds', () => {
    expect(canTakeBack(task({ assignee: 'openclaw', aiStatus: 'queued', status: 'completed' }))).toBe(true);
    expect(
      canTakeBack(task({ assignee: 'openclaw', aiStatus: 'blocked', pausedAt: '2026-10-01T00:00:00.000Z' }))
    ).toBe(true);
  });
});

/* ── The writes, through the real store ──────────────────────────────── */

const store = () => usePlannerStore.getState();
const byId = (id: string) => store().items.find((i) => i.id === id) as TaskItem;

const fixtures = (): Item[] => [
  task({ id: 'plain', title: 'Book dentist' }),
  task({
    id: 'run',
    title: 'Gift for Ari',
    order: 1,
    assignee: 'openclaw',
    aiStatus: 'blocked',
    aiResult: 'Which shop?',
    aiStatusAt: T0,
  }),
  task({ id: 'ai-held', title: 'Draft the email', order: 2, assignee: 'beacon', aiStatus: 'working', aiStatusAt: T0 }),
];

/** Every updateItem call for this id, as its updates object. */
const writesFor = (id: string) =>
  vi
    .mocked(db.updateItem)
    .mock.calls.filter((c) => c[0] === id)
    .map((c) => c.find((a) => a && typeof a === 'object' && !Array.isArray(a)) as Record<string, unknown>);

describe('handOffItem / takeBackItem', () => {
  beforeEach(async () => {
    store().clearStore();
    vi.clearAllMocks();
    vi.mocked(db.fetchItems).mockResolvedValue(fixtures());
    await store().initializeStore(USER);
  });

  it('hands off: assigned to openclaw, queued, stamped now, in one named entry', () => {
    const before = structuredClone(byId('plain'));
    const entries = store().actionLog.length;

    handOffItem(before as Item);

    expect(byId('plain')).toMatchObject({ assignee: 'openclaw', aiStatus: 'queued', aiStatusAt: NOW });
    expect(byId('plain').title).toBe('Book dentist');
    // The tasks projection follows.
    expect(store().tasks.find((t) => t.id === 'plain')?.aiStatus).toBe('queued');

    expect(store().actionLog).toHaveLength(entries + 1);
    const entry = store().actionLog[0];
    expect(entry.label).toBe('Hand off to OpenClaw: Book dentist');
    expect(isToastWorthy(entry)).toBe(true);
    expect(store().canUndo).toBe(true);

    expect(writesFor('plain')).toContainEqual(
      expect.objectContaining({ assignee: 'openclaw', aiStatus: 'queued', aiStatusAt: NOW })
    );

    // And the menu now offers the way back, not a second hand-off.
    expect(canTakeBack(byId('plain'))).toBe(true);
    expect(canHandOff(byId('plain'), on())).toBe(false);
  });

  it('one undo takes the hand-off back entirely', () => {
    const before = structuredClone(byId('plain'));
    handOffItem(before as Item);

    store().undo();

    expect(byId('plain')).toEqual(before);
    expect(byId('plain').assignee).toBeUndefined();
    expect(byId('plain').aiStatus).toBeUndefined();
    expect(byId('plain').aiStatusAt).toBeUndefined();
    expect(canHandOff(byId('plain'), on())).toBe(true);
  });

  it('takes back: assignment, status and report cleared, the clock moved, in one named entry', () => {
    const before = structuredClone(byId('run'));
    const entries = store().actionLog.length;

    takeBackItem(before as Item);

    const after = byId('run');
    expect(after.assignee).toBeUndefined();
    expect(after.aiStatus).toBeUndefined();
    expect(after.aiResult).toBeUndefined();
    // The status write moves the agent clock, so a late report is refused.
    expect(after.aiStatusAt).toBe(NOW);
    expect(after.title).toBe('Gift for Ari');

    expect(store().actionLog).toHaveLength(entries + 1);
    const entry = store().actionLog[0];
    expect(entry.label).toBe('Take back from OpenClaw: Gift for Ari');
    expect(isToastWorthy(entry)).toBe(true);

    const write = writesFor('run').at(-1)!;
    expect(write).toMatchObject({ aiStatusAt: NOW });
    // The clears are present as keys, which is how the db layer nulls them.
    for (const key of ['assignee', 'aiStatus', 'aiResult']) {
      expect(key in write, key).toBe(true);
      expect(write[key], key).toBeUndefined();
    }

    expect(canTakeBack(after)).toBe(false);
    expect(canHandOff(after, on())).toBe(true);
  });

  it('one undo puts the delegation back, its original stamp included', () => {
    const before = structuredClone(byId('run'));
    takeBackItem(before as Item);
    vi.mocked(db.updateItem).mockClear();

    store().undo();

    expect(byId('run')).toEqual(before);
    expect(byId('run')).toMatchObject({
      assignee: 'openclaw',
      aiStatus: 'blocked',
      aiResult: 'Which shop?',
      aiStatusAt: T0,
    });
    // The restore carries the old stamp to the db, not the moment of the undo.
    expect(writesFor('run')).toContainEqual(
      expect.objectContaining({ assignee: 'openclaw', aiStatus: 'blocked', aiStatusAt: T0 })
    );
  });

  it('names whoever held it: an item the AI held reads "Take back from AI"', () => {
    takeBackItem(byId('ai-held'));
    expect(store().actionLog[0].label).toBe('Take back from AI: Draft the email');
    expect(byId('ai-held').assignee).toBeUndefined();
  });

  it('hand off then take back is two entries, and two undos return to the start', () => {
    const before = structuredClone(byId('plain'));
    handOffItem(byId('plain'));
    takeBackItem(byId('plain'));
    expect(store().actionLog.slice(0, 2).map((a) => a.label)).toEqual([
      'Take back from OpenClaw: Book dentist',
      'Hand off to OpenClaw: Book dentist',
    ]);

    store().undo();
    expect(byId('plain')).toMatchObject({ assignee: 'openclaw', aiStatus: 'queued', aiStatusAt: NOW });
    store().undo();
    expect(byId('plain')).toEqual(before);
  });
});

/* ── Parity with the agent's own queue ───────────────────────────────── */

describe('parity with selectAssignedWork', () => {
  const routines = [
    { id: 'r-paused', name: 'Term time', itemIds: ['in-paused-routine'], pausedAt: '2026-10-01T00:00:00.000Z', pausedUntil: '2026-12-01' },
    { id: 'r-live', name: 'Mornings', itemIds: ['in-live-routine'] },
  ] as unknown as Routine[];
  const seasons = [
    { id: 's-off', name: 'Winter', state: 'paused', itemIds: ['in-off-season'], routineIds: [] },
    { id: 's-ended', name: 'Summer', state: 'auto', endsOn: '2026-10-04', itemIds: ['in-ended-season'], routineIds: [] },
    { id: 's-on', name: 'Autumn', state: 'auto', startsOn: '2026-09-01', itemIds: ['in-live-season'], routineIds: [] },
  ] as unknown as Season[];
  const activation: ActivationContext = { userTimezone: TZ, routines, seasons };

  /** Everything canHandOff should say yes to. */
  const offered = (): Item[] => [
    task({ id: 'undated', title: 'Undated' }),
    task({ id: 'today', title: 'Today', startDate: TODAY, isScheduled: true, order: 1 }),
    task({ id: 'past', title: 'Overdue', startDate: '2026-09-20', isScheduled: true, order: 2 }),
    task({ id: 'future', title: 'Next month', startDate: '2026-11-01', isScheduled: true, order: 3 }),
    task({ id: 'in-live-routine', title: 'Live routine', order: 4 }),
    task({ id: 'in-live-season', title: 'Live season', order: 5 }),
    task({ id: 'pause-over', title: 'Pause over', order: 6, pausedAt: '2026-10-01T00:00:00.000Z', pausedUntil: TODAY }),
  ];

  /** Refused for being finished or paused/switched off. */
  const finishedOrPaused = (): Item[] => [
    task({ id: 'completed', title: 'Done', status: 'completed' }),
    task({ id: 'cancelled', title: 'Dropped', status: 'cancelled' }),
    task({ id: 'paused', title: 'Paused', pausedAt: '2026-10-01T00:00:00.000Z', pausedUntil: '2026-10-10' }),
    task({ id: 'paused-open', title: 'Paused, no end', pausedAt: '2026-10-01T00:00:00.000Z' }),
    task({ id: 'in-paused-routine', title: 'Paused routine' }),
    task({ id: 'in-off-season', title: 'Off season' }),
    task({ id: 'in-ended-season', title: 'Ended season' }),
  ];

  /** Refused because the registry says the type is not the agent's. */
  const wrongType = (): Item[] => [habit({ id: 'habit' }), custom({ id: 'custom' })];

  const ctxFor = (items: Item[]): HandOffContext => ({
    canDelegate: true,
    todayStr: TODAY,
    inactiveIds: inactiveItemIdsOn(items, TODAY, activation),
  });

  const asHanded = (item: Item): Item =>
    ({ ...item, assignee: DELEGATE_ASSIGNEE, aiStatus: 'queued', aiStatusAt: NOW }) as unknown as Item;

  /** The same body /api/agent/context hands a worker. */
  const served = (items: Item[]) =>
    selectAssignedWork({ items, fetchedAt: NOW, userTimezone: TZ, routines, seasons }).assigned.map((i) => i.id);

  it('canHandOff sorts the fixtures as intended', () => {
    const all = [...offered(), ...finishedOrPaused(), ...wrongType()];
    const ctx = ctxFor(all);
    const yes = all.filter((i) => canHandOff(i, ctx)).map((i) => i.id);
    expect(yes.sort()).toEqual(offered().map((i) => i.id).sort());
  });

  it('everything the menu hands off (through the real write) is in the queue', async () => {
    store().clearStore();
    vi.clearAllMocks();
    vi.mocked(db.fetchItems).mockResolvedValue([...offered(), ...finishedOrPaused()]);
    await store().initializeStore(USER);

    const ctx = ctxFor(store().items);
    const handed: string[] = [];
    for (const item of store().items) {
      if (canHandOff(item, ctx)) {
        handOffItem(item);
        handed.push(item.id);
      }
    }
    expect(handed.sort()).toEqual(offered().map((i) => i.id).sort());

    expect(served(store().items).sort()).toEqual(handed.sort());
  });

  it('what it refuses as finished or paused, the queue would not serve either', () => {
    const items = finishedOrPaused();
    const ctx = ctxFor(items);
    for (const item of items) expect(canHandOff(item, ctx), item.id).toBe(false);
    // Hand them off anyway, as another surface could: the queue drops them all.
    expect(served(items.map(asHanded))).toEqual([]);
  });

  it('what it refuses for its type, the queue would not serve either', () => {
    const items = wrongType();
    const ctx = ctxFor(items);
    for (const item of items) expect(canHandOff(item, ctx), item.id).toBe(false);
    expect(served(items.map(asHanded))).toEqual([]);
  });

  it('is stricter than the queue on one count only: a repeating task', () => {
    // The queue would serve an open series (it has no recurrence rule), but an
    // item carries one agent status, so the menu does not offer it.
    const series = task({ id: 'series', startDate: '2026-10-01', repeatFrequency: 'daily' });
    expect(canHandOff(series, ctxFor([series]))).toBe(false);
    expect(served([asHanded(series)])).toEqual(['series']);
  });
});
