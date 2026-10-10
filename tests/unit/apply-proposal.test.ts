import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same fully-mocked db layer as undo-redo-store.test.ts: these tests drive the
// real Zustand store, including the module-level history subscriber, so the
// one-set/one-undo contract is exercised for real rather than asserted about.

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchHabitGroups: vi.fn(async () => []),
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
  // The rename fan-out (migration 027) — updateProject/updateHabitGroup call it
  // whenever the name actually changes.
  renameContainerMembers: vi.fn(async () => {}),
  createHabitGroup: vi.fn(async () => {}),
  updateHabitGroup: vi.fn(async () => {}),
  deleteHabitGroup: vi.fn(async () => {}),
  restoreHabitGroup: vi.fn(async () => {}),
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

import { usePlannerStore } from '@/lib/planner-store';
import * as db from '@/lib/db';
import type { Item, Proposal, ProposalOperation } from '@/lib/planner-types';
import { addDays, format, subDays } from 'date-fns';
import { toDateStr } from '@/lib/recurrence';

const USER = 'user-1';
const store = () => usePlannerStore.getState();

const fixtures = (): Item[] => [
  {
    type: 'task',
    id: 'task-1',
    title: 'Email Dana',
    status: 'pending',
    isScheduled: false,
    order: 0,
    startDate: '2026-07-20',
    completedDates: [],
  },
  {
    type: 'task',
    id: 'task-2',
    title: 'Renew passport',
    status: 'pending',
    isScheduled: false,
    order: 1,
    startDate: '2026-07-22',
    completedDates: [],
  },
  {
    type: 'habit',
    id: 'habit-1',
    title: 'Stretch',
    group: 'Personal',
    streak: 3,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
  },
];

const proposalOf = (...operations: ProposalOperation[]): Proposal => ({
  id: 'p1',
  summary: 'A lighter Tuesday',
  createdAt: '2026-07-31T09:00:00.000Z',
  operations,
});

beforeEach(async () => {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(fixtures());
  await store().initializeStore(USER);
});

describe('applyProposal', () => {
  it('applies updates and creates together and reports the count', () => {
    const applied = store().applyProposal(
      proposalOf(
        { kind: 'update', itemId: 'task-1', startDate: '2026-08-06' },
        { kind: 'update', itemId: 'task-2', startDate: '2026-08-07', priority: 'high' },
        { kind: 'create', itemType: 'task', title: 'Book dentist', startDate: '2026-08-06' },
      ),
    );

    expect(applied).toBe(3);
    const byId = new Map(store().items.map((i) => [i.id, i]));
    expect(byId.get('task-1')).toMatchObject({ startDate: '2026-08-06' });
    expect(byId.get('task-2')).toMatchObject({ startDate: '2026-08-07', priority: 'high' });
    expect(store().tasks.some((t) => t.title === 'Book dentist')).toBe(true);
  });

  it('gives a dated item a bucket, so it shows on its day rather than in the Braindump', () => {
    store().applyProposal(
      proposalOf(
        { kind: 'update', itemId: 'task-1', startDate: '2026-08-06' },
        { kind: 'update', itemId: 'task-2', startDate: '2026-08-07', startTime: '15:00' },
        { kind: 'create', itemType: 'task', title: 'Call Mum', startDate: '2026-08-09' },
        { kind: 'create', itemType: 'task', title: 'Standup', startDate: '2026-08-10', startTime: '09:00' },
        { kind: 'create', itemType: 'task', title: 'Someday' },
      ),
    );
    const byTitle = new Map(store().items.map((i) => [i.title, i]));
    expect(byTitle.get('Email Dana')).toMatchObject({ startDate: '2026-08-06', timeBucket: 'anytime' });
    expect(byTitle.get('Renew passport')).toMatchObject({ startDate: '2026-08-07', timeBucket: 'afternoon' });
    expect(byTitle.get('Call Mum')).toMatchObject({ startDate: '2026-08-09', timeBucket: 'anytime', isScheduled: true });
    expect(byTitle.get('Standup')).toMatchObject({ timeBucket: 'morning', isScheduled: true });
    // No day, no bucket: the Braindump, as before.
    expect(byTitle.get('Someday')).toMatchObject({ isScheduled: false });
    expect(byTitle.get('Someday')).not.toHaveProperty('timeBucket', expect.anything());
  });

  it('is ONE undo for the whole plan', () => {
    store().applyProposal(
      proposalOf(
        { kind: 'update', itemId: 'task-1', startDate: '2026-08-06' },
        { kind: 'update', itemId: 'task-2', startDate: '2026-08-07' },
        { kind: 'create', itemType: 'task', title: 'Book dentist' },
      ),
    );
    expect(store().tasks).toHaveLength(3);

    store().undo();

    const byId = new Map(store().items.map((i) => [i.id, i]));
    expect(byId.get('task-1')).toMatchObject({ startDate: '2026-07-20' });
    expect(byId.get('task-2')).toMatchObject({ startDate: '2026-07-22' });
    expect(store().tasks).toHaveLength(2);
    // One gesture in, one gesture out — nothing left to undo.
    expect(store().canUndo).toBe(false);
  });

  it('undo removes created items from the db too, not just from memory', () => {
    store().applyProposal(proposalOf({ kind: 'create', itemType: 'task', title: 'Book dentist' }));
    const created = store().tasks.find((t) => t.title === 'Book dentist')!;

    store().undo();

    expect(db.deleteItem).toHaveBeenCalledWith(created.id, 'task');
  });

  it('labels the history entry with the proposal summary', () => {
    store().applyProposal(proposalOf({ kind: 'update', itemId: 'task-1', startDate: '2026-08-06' }));
    expect(store().actionLog[0].label).toBe('Accept plan: A lighter Tuesday');
  });

  it('persists creates and updates through the db layer', () => {
    store().applyProposal(
      proposalOf(
        { kind: 'update', itemId: 'task-1', startDate: '2026-08-06' },
        { kind: 'create', itemType: 'task', title: 'Book dentist' },
      ),
    );

    expect(db.updateItem).toHaveBeenCalledWith(
      'task-1',
      'task',
      expect.objectContaining({ startDate: '2026-08-06' }),
    );
    expect(db.createItem).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ title: 'Book dentist', type: 'task', status: 'pending' }),
    );
  });

  it('re-validates at the boundary: a stale operation is dropped, the rest applies', () => {
    // The card could have been rendered before the item was deleted.
    store().deleteTask('task-2');
    const applied = store().applyProposal(
      proposalOf(
        { kind: 'update', itemId: 'task-2', startDate: '2026-08-07' },
        { kind: 'update', itemId: 'task-1', startDate: '2026-08-06' },
      ),
    );
    expect(applied).toBe(1);
    expect(store().items.find((i) => i.id === 'task-1')).toMatchObject({
      startDate: '2026-08-06',
    });
  });

  it('applies nothing — and writes no history — when every operation is invalid', () => {
    const before = store().actionLog.length;
    const applied = store().applyProposal(
      proposalOf({ kind: 'update', itemId: 'ghost', title: 'x' }),
    );
    expect(applied).toBe(0);
    expect(store().actionLog).toHaveLength(before);
    expect(db.updateItem).not.toHaveBeenCalled();
  });

  it('gives consecutive creates distinct order values', () => {
    store().applyProposal(
      proposalOf(
        { kind: 'create', itemType: 'task', title: 'One' },
        { kind: 'create', itemType: 'task', title: 'Two' },
      ),
    );
    const orders = store()
      .tasks.filter((t) => t.title === 'One' || t.title === 'Two')
      .map((t) => t.order);
    expect(new Set(orders).size).toBe(2);
  });

  it('merges two operations targeting the same item into one patch', () => {
    store().applyProposal(
      proposalOf(
        { kind: 'update', itemId: 'task-1', startDate: '2026-08-06' },
        { kind: 'update', itemId: 'task-1', priority: 'high' },
      ),
    );
    expect(store().items.find((i) => i.id === 'task-1')).toMatchObject({
      startDate: '2026-08-06',
      priority: 'high',
    });
  });

  it('auto-corrects the bucket when a start time is proposed', () => {
    store().applyProposal(
      proposalOf({ kind: 'update', itemId: 'task-1', startTime: '14:00', timeBucket: 'morning' }),
    );
    expect(store().items.find((i) => i.id === 'task-1')).toMatchObject({
      timeBucket: 'afternoon',
    });
  });

  it('never writes a habit a task-shaped status', () => {
    const applied = store().applyProposal(
      proposalOf({ kind: 'update', itemId: 'habit-1', status: 'completed' }),
    );
    expect(applied).toBe(0);
    expect(store().habits[0].status).toBe('pending');
  });
});

describe('applyProposal — breakdown', () => {
  const stepsUnder = (parentItemId: string, ...titles: string[]) =>
    proposalOf(
      ...titles.map(
        (title) =>
          ({ kind: 'create', itemType: 'task', title, parentItemId }) as ProposalOperation
      )
    );

  it('creates the steps parented to the item', () => {
    const applied = store().applyProposal(
      stepsUnder('task-1', 'Draft the outline', 'Send it to Dana')
    );
    expect(applied).toBe(2);

    const children = store().items.filter(
      (i) => 'parentItemId' in i && i.parentItemId === 'task-1'
    );
    expect(children.map((c) => c.title)).toEqual(['Draft the outline', 'Send it to Dana']);
  });

  it('keeps the steps out of the grid', () => {
    // The tasks projection excludes subtasks, which is the whole reason they
    // may not be scheduled — nothing outside the parent's panel renders one.
    const before = store().tasks.length;
    store().applyProposal(stepsUnder('task-1', 'Draft the outline'));
    expect(store().tasks).toHaveLength(before);
  });

  it('persists the parent link', () => {
    store().applyProposal(stepsUnder('task-1', 'Draft the outline'));
    const created = vi.mocked(db.createItem).mock.calls.at(-1)?.[1] as { parentItemId?: string };
    expect(created.parentItemId).toBe('task-1');
  });

  it('undoes the whole breakdown in one step', () => {
    // Accepting a proposal is one gesture and must reverse like one — the same
    // contract every other batched verb holds.
    const before = store().items.length;
    store().applyProposal(stepsUnder('task-1', 'one', 'two', 'three'));
    expect(store().items).toHaveLength(before + 3);

    store().undo();
    expect(store().items).toHaveLength(before);
  });

  it('leaves ordinary creates unparented', () => {
    store().applyProposal(
      proposalOf({ kind: 'create', itemType: 'task', title: 'A normal task' } as ProposalOperation)
    );
    const created = store().items.find((i) => i.title === 'A normal task')!;
    expect('parentItemId' in created ? created.parentItemId : undefined).toBeUndefined();
  });

  it('refuses to nest, so a step of a step is never written', () => {
    store().applyProposal(stepsUnder('task-1', 'Draft the outline'));
    const child = store().items.find((i) => i.title === 'Draft the outline')!;

    const applied = store().applyProposal(stepsUnder(child.id, 'A sub-step'));
    expect(applied).toBe(0);
    expect(store().items.find((i) => i.title === 'A sub-step')).toBeUndefined();
  });
});

describe('the agent clock through the store', () => {
  /**
   * The store applies updates optimistically and NOTHING refetches for the rest
   * of the session — no realtime subscription, no polling, and initializeStore
   * early-returns on re-entry. So a stamp that existed only server-side left the
   * store holding the previous one, and the row went on reporting elapsed time
   * from the OLD state until a reload: answer a question asked six hours ago and
   * the row reads "6h" for a state six seconds old.
   */
  it('stamps the clock locally when the agent status changes', () => {
    store().updateTask('task-1', { aiStatus: 'working' });
    const item = store().items.find((i) => i.id === 'task-1')!;
    expect('aiStatusAt' in item ? item.aiStatusAt : undefined).toBeTypeOf('string');
  });

  it('sends the same stamp to the database, so the two agree', () => {
    store().updateTask('task-1', { aiStatus: 'working' });
    const local = store().items.find((i) => i.id === 'task-1') as { aiStatusAt?: string };
    const written = vi.mocked(db.updateItem).mock.calls.at(-1)?.[2] as { aiStatusAt?: string };
    expect(written.aiStatusAt).toBe(local.aiStatusAt);
  });

  it('leaves the clock alone for an edit that is not a status change', () => {
    store().updateTask('task-1', { aiStatus: 'working' });
    const first = (store().items.find((i) => i.id === 'task-1') as { aiStatusAt?: string })
      .aiStatusAt;

    store().updateTask('task-1', { title: 'Renamed while the agent works' });
    const after = (store().items.find((i) => i.id === 'task-1') as { aiStatusAt?: string })
      .aiStatusAt;
    // The whole reason this is not `items.updated_at`: a rename must not reset
    // the agent's clock.
    expect(after).toBe(first);
  });

  it('restores the original time on undo rather than dating it to the undo', () => {
    const original = '2026-07-01T06:00:00.000Z';
    store().updateTask('task-1', { aiStatus: 'blocked', aiStatusAt: original });
    store().updateTask('task-1', { aiStatus: 'queued' });

    store().undo();

    const item = store().items.find((i) => i.id === 'task-1') as {
      aiStatus?: string;
      aiStatusAt?: string;
    };
    expect(item.aiStatus).toBe('blocked');
    // Without this a question asked six hours ago reads "Needs you just now"
    // after an undo, with the real time unrecoverable.
    expect(item.aiStatusAt).toBe(original);
  });
});

describe('applyProposal — moving something back to the Braindump', () => {
  /**
   * The reason clearing waited for its own implementation: it is the UNSCHEDULE
   * verb, not a null write. Writing only the date would leave an item that is
   * `isScheduled` with a bucket and no day — placeable on no surface, and
   * reachable from nowhere but the Braindump it was never actually put in.
   */
  const clearDate = (itemId: string) =>
    proposalOf({ kind: 'update', itemId, startDate: null } as ProposalOperation);

  beforeEach(() => {
    store().updateTask('task-1', {
      startDate: '2026-07-20',
      startTime: '09:00',
      timeBucket: 'morning',
      isScheduled: true,
      priority: 'high',
    });
    vi.mocked(db.updateItem).mockClear();
  });

  const live = () => store().items.find((i) => i.id === 'task-1') as Record<string, unknown>;

  it('clears the whole scheduling set, exactly like unscheduleTask', () => {
    expect(store().applyProposal(clearDate('task-1'))).toBe(1);
    const item = live();
    expect(item.startDate).toBeUndefined();
    expect(item.startTime).toBeUndefined();
    expect(item.timeBucket).toBeUndefined();
    expect(item.isScheduled).toBe(false);
  });

  it('leaves everything it was not asked about alone', () => {
    store().applyProposal(clearDate('task-1'));
    expect(live().priority).toBe('high');
    expect(live().title).toBe('Email Dana');
  });

  it('persists the clears as present-and-undefined, which writes NULL', () => {
    // An ABSENT key means "leave alone" to updatesToRow; only a present one
    // clears. Dropping them would leave the database scheduled while the store
    // showed it in the Braindump.
    store().applyProposal(clearDate('task-1'));
    const written = vi.mocked(db.updateItem).mock.calls.at(-1)?.[2] as Record<string, unknown>;
    for (const key of ['startDate', 'startTime', 'timeBucket']) {
      expect(Object.keys(written)).toContain(key);
      expect(written[key]).toBeUndefined();
    }
    expect(written.isScheduled).toBe(false);
  });

  it('puts it back in one undo', () => {
    store().applyProposal(clearDate('task-1'));
    store().undo();
    const item = live();
    expect(item.startDate).toBe('2026-07-20');
    expect(item.timeBucket).toBe('morning');
    expect(item.isScheduled).toBe(true);
  });

  it('clears a time without touching the day it belongs to', () => {
    store().applyProposal(
      proposalOf({ kind: 'update', itemId: 'task-1', startTime: null } as ProposalOperation)
    );
    expect(live().startTime).toBeUndefined();
    expect(live().startDate).toBe('2026-07-20');
    // The auto-correct must not fire on a CLEARED time and invent a bucket.
    expect(live().timeBucket).toBe('morning');
  });

  it('clears a priority on its own', () => {
    store().applyProposal(
      proposalOf({ kind: 'update', itemId: 'task-1', priority: null } as ProposalOperation)
    );
    expect(live().priority).toBeUndefined();
    expect(live().startDate).toBe('2026-07-20');
  });

  it('keeps the clear when a LATER operation touches the same item', () => {
    /**
     * The clear used to be expanded per-operation and then merged
     * later-op-wins, so a second op put back what the first had removed:
     * `[{startDate: null}, {timeBucket: 'afternoon'}]` left an item with a
     * bucket and no day. The grid drops it (`!startDate`) and the Braindump
     * drops it too (`isScheduled || timeBucket`) — invisible everywhere, and
     * persisted. Exactly the unplaceable row this feature exists to avoid.
     */
    store().applyProposal(
      proposalOf(
        { kind: 'update', itemId: 'task-1', startDate: null } as ProposalOperation,
        { kind: 'update', itemId: 'task-1', timeBucket: 'afternoon' } as ProposalOperation
      )
    );
    const item = live();
    expect(item.startDate).toBeUndefined();
    expect(item.timeBucket).toBeUndefined();
    expect(item.isScheduled).toBe(false);
  });

  it('keeps it against a later op that would invent a bucket from a time', () => {
    // The startTime path runs autoCorrectBucket, which conjures a bucket out of
    // the clock — the same unplaceable row by a longer route.
    store().applyProposal(
      proposalOf(
        { kind: 'update', itemId: 'task-1', startDate: null } as ProposalOperation,
        { kind: 'update', itemId: 'task-1', startTime: '14:00' } as ProposalOperation
      )
    );
    const item = live();
    expect(item.startDate).toBeUndefined();
    expect(item.startTime).toBeUndefined();
    expect(item.timeBucket).toBeUndefined();
  });

  it('keeps it whichever order the operations arrive in', () => {
    store().applyProposal(
      proposalOf(
        { kind: 'update', itemId: 'task-1', timeBucket: 'afternoon' } as ProposalOperation,
        { kind: 'update', itemId: 'task-1', startDate: null } as ProposalOperation
      )
    );
    expect(live().timeBucket).toBeUndefined();
    expect(live().startDate).toBeUndefined();
  });

  it('lands the item somewhere the user can actually find it', () => {
    // The Braindump filter is `isScheduled || timeBucket` — both must be gone,
    // which is the whole reason the clear is a set of four fields.
    store().applyProposal(
      proposalOf(
        { kind: 'update', itemId: 'task-1', startDate: null } as ProposalOperation,
        { kind: 'update', itemId: 'task-1', timeBucket: 'afternoon' } as ProposalOperation
      )
    );
    const item = live();
    expect(Boolean(item.isScheduled || item.timeBucket)).toBe(false);
  });

  it('applies a clear and a move in the same plan without them fighting', () => {
    store().applyProposal(
      proposalOf(
        { kind: 'update', itemId: 'task-1', startDate: null } as ProposalOperation,
        { kind: 'update', itemId: 'task-2', startDate: '2026-08-06' } as ProposalOperation
      )
    );
    expect(live().startDate).toBeUndefined();
    expect(
      (store().items.find((i) => i.id === 'task-2') as Record<string, unknown>).startDate
    ).toBe('2026-08-06');
  });
});

describe('onAccepted: what the plan actually took', () => {
  /**
   * proposal-store counts an accepted card on the conversation that asked
   * (History's second line), and it must count what was APPLIED, after the
   * re-validation, not what the card offered.
   */
  it('hears the operations that survived re-validation, before the one set()', () => {
    const heard: ProposalOperation[][] = [];
    let itemsWhenHeard = -1;
    const applied = store().applyProposal(
      proposalOf(
        { kind: 'update', itemId: 'task-1', startDate: '2026-08-06' },
        { kind: 'update', itemId: 'gone-1', startDate: '2026-08-06' },
        { kind: 'create', itemType: 'task', title: 'Book dentist' }
      ),
      (accepted) => {
        heard.push(accepted);
        itemsWhenHeard = store().items.length;
      }
    );
    expect(applied).toBe(2);
    expect(heard).toHaveLength(1);
    expect(heard[0].map((op) => (op.kind === 'create' ? op.title : 'itemId' in op ? op.itemId : op.kind))).toEqual(['task-1', 'Book dentist']);
    // Called before the write: the planner still held the three fixtures.
    expect(itemsWhenHeard).toBe(3);
    expect(store().items).toHaveLength(4);
  });

  it('a tally that throws never costs the plan', () => {
    const applied = store().applyProposal(
      proposalOf({ kind: 'update', itemId: 'task-1', startDate: '2026-08-06' }),
      () => {
        throw new Error('tally failed');
      }
    );
    expect(applied).toBe(1);
    expect(store().items.find((i) => i.id === 'task-1')).toMatchObject({ startDate: '2026-08-06' });
    // Still one undo for the whole plan.
    store().undo();
    expect(store().items.find((i) => i.id === 'task-1')).toMatchObject({ startDate: '2026-07-20' });
  });

  it('is not called when nothing is taken', () => {
    const onAccepted = vi.fn();
    expect(store().applyProposal(proposalOf({ kind: 'update', itemId: 'gone-1', startDate: '2026-08-06' }), onAccepted)).toBe(0);
    expect(onAccepted).not.toHaveBeenCalled();
  });
});

describe('applyProposal: verbs (tick, skip, pause)', () => {
  const today = () => toDateStr(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  const habit = () => store().items.find((i) => i.id === 'habit-1') as Extract<Item, { type: 'habit' }>;

  it('ticks a habit through its own verb, so the streak moves as by hand', () => {
    expect(store().applyProposal(proposalOf({ kind: 'verb', verb: 'complete', itemId: 'habit-1' }))).toBe(1);
    expect(habit().completedDates).toContain(today());
    expect(habit().streak).toBe(4);
  });

  it('skips a habit ahead of time on the day given, not the selected one', () => {
    const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd');
    expect(store().applyProposal(proposalOf({ kind: 'verb', verb: 'skip', itemId: 'habit-1', date: tomorrow }))).toBe(1);
    expect(habit().skippedDates).toEqual([tomorrow]);
  });

  it('ticks a day already behind you, but never skips one (the row offers no skip there either)', () => {
    const yesterday = format(subDays(new Date(), 1), 'yyyy-MM-dd');
    expect(store().applyProposal(proposalOf({ kind: 'verb', verb: 'skip', itemId: 'habit-1', date: yesterday }))).toBe(0);
    expect(store().applyProposal(proposalOf({ kind: 'verb', verb: 'complete', itemId: 'habit-1', date: yesterday }))).toBe(1);
    expect(habit().completedDates).toEqual([yesterday]);
  });

  it('is still ONE undo when a card mixes a tick with a field write', () => {
    store().applyProposal(
      proposalOf(
        { kind: 'verb', verb: 'complete', itemId: 'habit-1' },
        { kind: 'update', itemId: 'task-1', startDate: '2026-08-06' },
      ),
    );
    expect(habit().completedDates).toContain(today());
    store().undo();
    expect(habit().completedDates).not.toContain(today());
    expect(habit().streak).toBe(3);
    expect(store().items.find((i) => i.id === 'task-1')).toMatchObject({ startDate: '2026-07-20' });
    expect(store().canUndo).toBe(false);
  });

  it('refuses a tick on a day still to come', () => {
    const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd');
    expect(store().applyProposal(proposalOf({ kind: 'verb', verb: 'complete', itemId: 'habit-1', date: tomorrow }))).toBe(0);
    expect(habit().completedDates).toHaveLength(0);
  });

  it('pauses a habit', () => {
    expect(store().applyProposal(proposalOf({ kind: 'verb', verb: 'pause', itemId: 'habit-1' }))).toBe(1);
    expect(habit()).toMatchObject({ pausedAt: expect.any(String) });
  });
});

describe('applyProposal: habits', () => {
  it('creates a habit with a fresh streak, on the day surfaces, filed in its project', () => {
    store().applyProposal(
      proposalOf({ kind: 'create', itemType: 'habit', title: 'Gym', repeatFrequency: 'custom', repeatDays: [1, 4] }),
    );
    const gym = store().items.find((i) => i.title === 'Gym');
    expect(gym).toMatchObject({
      type: 'habit',
      repeatFrequency: 'custom',
      repeatDays: [1, 4],
      streak: 0,
      completedDates: [],
      skippedDates: [],
      timeBucket: 'anytime',
    });
    expect(store().habits.map((h) => h.title)).toContain('Gym');
    expect(db.createItem).toHaveBeenCalledTimes(1);
    store().undo();
    expect(store().items.find((i) => i.title === 'Gym')).toBeUndefined();
  });

  it('pauses until the day given', () => {
    const until = format(addDays(new Date(), 7), 'yyyy-MM-dd');
    store().applyProposal(proposalOf({ kind: 'verb', verb: 'pause', itemId: 'habit-1', until }));
    expect(store().items.find((i) => i.id === 'habit-1')).toMatchObject({ pausedUntil: until });
  });
});

describe('applyProposal: containers', () => {
  it('makes a routine with its members in order, and one undo takes it back', () => {
    const applied = store().applyProposal(
      proposalOf({ kind: 'container', container: 'routine', name: 'Morning', usualTime: '07:00', itemIds: ['habit-1', 'task-1'] }),
    );
    expect(applied).toBe(1);
    expect(store().routines).toEqual([
      expect.objectContaining({ name: 'Morning', usualTime: '07:00', itemIds: ['habit-1', 'task-1'] }),
    ]);
    expect(db.createRoutine).toHaveBeenCalledTimes(1);
    store().undo();
    expect(store().routines).toEqual([]);
  });

  it('makes a project and files its items under it', () => {
    store().applyProposal(proposalOf({ kind: 'container', container: 'project', name: 'Admin', itemIds: ['task-2'] }));
    const project = store().projects.find((p) => p.name === 'Admin');
    expect(project).toBeDefined();
    expect(store().items.find((i) => i.id === 'task-2')).toMatchObject({ project: 'Admin', projectId: project!.id });
  });

  it('puts items into a season and a goal, and renames a goal, as one undo', () => {
    const season = store().addSeason({ name: 'Summer', state: 'auto', itemIds: [], routineIds: [] });
    const goal = store().addGoal({ name: 'Fit', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [] });
    store().applyProposal(
      proposalOf(
        { kind: 'membership', itemId: 'task-1', container: 'season', containerId: season },
        { kind: 'membership', itemId: 'habit-1', container: 'goal', containerId: goal },
        { kind: 'container', container: 'goal', containerId: goal, name: 'Get fit', why: 'Feel strong' },
      ),
    );
    expect(store().seasons.find((s) => s.id === season)?.itemIds).toEqual(['task-1']);
    expect(store().goals.find((g) => g.id === goal)).toMatchObject({ name: 'Get fit', why: 'Feel strong', memberIds: ['habit-1'] });
    store().undo();
    expect(store().seasons.find((s) => s.id === season)?.itemIds).toEqual([]);
    expect(store().goals.find((g) => g.id === goal)).toMatchObject({ name: 'Fit', memberIds: [] });
  });

  it('takes an item out of its project', () => {
    store().addProject('Admin', '');
    store().setItemsProject(['task-1'], 'Admin');
    const id = store().projects.find((p) => p.name === 'Admin')!.id;
    store().applyProposal(proposalOf({ kind: 'membership', itemId: 'task-1', container: 'project', containerId: id, member: false }));
    expect(store().items.find((i) => i.id === 'task-1')?.project).toBeUndefined();
  });

  it('refuses a second project of the same name', () => {
    store().addProject('Admin', '');
    expect(store().applyProposal(proposalOf({ kind: 'container', container: 'project', name: 'admin' }))).toBe(0);
    expect(store().projects.filter((p) => p.name.toLowerCase() === 'admin')).toHaveLength(1);
  });
});
