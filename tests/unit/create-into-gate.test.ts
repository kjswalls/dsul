import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Creating an item straight into a GATE — the item dialog's Season (and
 * Routine) chip in ADD mode.
 *
 * Three things are under test and only the first is about plumbing:
 *
 *  1. The membership lands, and it lands in the shape a gate has: a join row on
 *     the container, many-to-many, never a column on the item
 *     (lib/container-registry.ts — seasons are a GATE, not a CLASSIFY kind).
 *  2. Adding one changes NOTHING about what activation means. A gate membership
 *     is an input to lib/active.ts's path algebra and nothing else; an item
 *     created into a season is as ACTIVE as one collected into it afterwards,
 *     and every other item answers exactly as it did. (Only activation — the
 *     two doors' receipts are not the same, and the create path's is the right
 *     one. See the plan addendum's follow-ups.)
 *  3. It does not happen silently. A season that is off on the item's landing
 *     date hides the new item the moment the dialog closes, which is the same
 *     consequence the bulk "Add to …" verb already announces — so the create
 *     path carries the same receipt.
 *
 * The one-gesture/one-history-entry half of (1) is covered for routines in
 * tests/unit/pause.test.ts ("create-with-membership is one gesture"); this file
 * is the season half and the receipt.
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
vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import { usePlannerStore, getActionLog } from '@/lib/planner-store';
import * as db from '@/lib/db';
import { isItemActiveOn } from '@/lib/active';
import { isToastWorthy } from '@/hooks/use-undo-toast';
import type { Goal, Item, Season, Routine } from '@/lib/planner-types';

const USER = 'user-1';
/** The system clock every test below runs at, in UTC. */
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

const season = (over: Partial<Season> = {}): Season => ({
  id: 'p1',
  name: 'Summer',
  state: 'active',
  itemIds: [],
  routineIds: [],
  ...over,
});

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: 'r1',
  name: 'Mornings',
  itemIds: [],
  ...over,
});

function seed(over: {
  items?: Item[];
  routines?: Routine[];
  seasons?: Season[];
  goals?: Goal[];
} = {}) {
  usePlannerStore.setState({
    userId: USER,
    userTimezone: 'UTC',
    items: over.items ?? [task('a')],
    routines: over.routines ?? [routine()],
    seasons: over.seasons ?? [season()],
    goals: over.goals ?? [],
    collectionsAvailable: true,
    goalsAvailable: true,
  });
}

const store = () => usePlannerStore.getState();
const created = (title: string): Item => store().items.find((i) => i.title === title)!;
const ctx = () => ({
  userTimezone: 'UTC',
  routines: store().routines,
  seasons: store().seasons,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 2, 10, 12, 0, 0)));
  seed();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the membership a season gets', () => {
  it('puts the new item in the season named, and only that one', () => {
    seed({ seasons: [season(), season({ id: 'p2', name: 'Term' })] });
    store().addTask({ title: 'Swim' }, { seasonIds: ['p1'] });

    const id = created('Swim').id;
    expect(store().seasons[0].itemIds).toEqual([id]);
    expect(store().seasons[1].itemIds).toEqual([]);
  });

  it('is many-to-many in both directions', () => {
    // A GATE is not a classifier: one item can sit in several seasons at once,
    // and a season holds many items. Neither direction is "the" answer, which
    // is exactly why this cannot be a column.
    seed({
      seasons: [season({ itemIds: ['a'] }), season({ id: 'p2', name: 'Term' })],
    });
    store().addTask({ title: 'Swim' }, { seasonIds: ['p1', 'p2'] });

    const id = created('Swim').id;
    expect(store().seasons[0].itemIds).toEqual(['a', id]);
    expect(store().seasons[1].itemIds).toEqual([id]);
  });

  it('writes nothing onto the item row', () => {
    // The seam container-registry.ts enforces with types: `itemField` is null
    // for a gate, so a season can never arrive as a property of the item. A
    // field here would also be dropped by db.ts's allowlist — saved-looking and
    // gone on reload.
    store().addTask({ title: 'Swim' }, { seasonIds: ['p1'] });
    const item = created('Swim') as unknown as Record<string, unknown>;
    expect(item).not.toHaveProperty('seasonIds');
    expect(item).not.toHaveProperty('seasonId');
    expect(item).not.toHaveProperty('season');
  });

  it('lands the item and its join rows in one history entry', () => {
    const before = getActionLog().length;
    store().addTask({ title: 'Swim' }, { seasonIds: ['p1'] });
    // One gesture, one Cmd+Z — the reason the add actions take memberships at
    // all instead of the dialog calling updateSeason afterwards.
    expect(getActionLog().length).toBe(before + 1);
    expect(store().seasons[0].itemIds).toEqual([created('Swim').id]);
  });

  it('writes the join row only after the item row exists', async () => {
    // season_items carries a composite FK to items, so a join insert that
    // lands first fails with 23503 and the membership is lost on reload while
    // the store still shows it.
    store().addTask({ title: 'Swim' }, { seasonIds: ['p1'] });
    await vi.waitFor(() => expect(db.updateSeason).toHaveBeenCalled());
    expect(db.updateSeason).toHaveBeenCalledWith(USER, 'p1', {
      itemIds: [created('Swim').id],
    });
    const createdAt = (db.createItem as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    const joinedAt = (db.updateSeason as unknown as { mock: { invocationCallOrder: number[] } })
      .mock.invocationCallOrder[0];
    expect(createdAt).toBeLessThan(joinedAt);
  });

  it('leaves the containers alone when no membership is asked for', () => {
    seed({ seasons: [season({ itemIds: ['a'] })] });
    store().addTask({ title: 'Swim' });
    expect(store().seasons[0].itemIds).toEqual(['a']);
    expect(db.updateSeason).not.toHaveBeenCalled();
  });

  it('reaches habits and custom types by the same door', () => {
    store().addHabit(
      { title: 'Stretch', project: 'Wellness', repeatFrequency: 'daily' },
      { seasonIds: ['p1'] },
    );
    expect(store().seasons[0].itemIds).toEqual([created('Stretch').id]);
  });
});

describe('activation means exactly what it meant before', () => {
  it('an item created into a live season is live', () => {
    store().addTask({ title: 'Swim', startDate: TODAY }, { seasonIds: ['p1'] });
    expect(isItemActiveOn(created('Swim'), TODAY, ctx())).toBe(true);
  });

  it('an item created into a season that is off is not', () => {
    // The whole reason this ticket is not a picker: joining a gate can switch
    // the item off on the surface it was created on. Correct, and announced —
    // see the receipt block below.
    seed({ seasons: [season({ state: 'paused' })] });
    store().addTask({ title: 'Swim', startDate: TODAY }, { seasonIds: ['p1'] });
    expect(isItemActiveOn(created('Swim'), TODAY, ctx())).toBe(false);
  });

  it('answers the same however the join row arrived', () => {
    // The invariant that says the create path added no new rule: whatever
    // membership means, it means it identically however the join row arrived.
    //
    // ACTIVATION only. This deliberately does NOT say the two doors are
    // equivalent — their receipts differ, and the create path is the correct
    // one: `newMemberReceipt` resolves at the item's own start date while
    // setItemsCollected resolves at today. See the plan addendum's follow-ups.
    for (const state of ['active', 'paused'] as const) {
      for (const date of ['2026-03-09', TODAY, '2026-03-11']) {
        seed({ seasons: [season({ state })] });
        store().addTask({ title: 'Direct', startDate: date }, { seasonIds: ['p1'] });
        const viaCreate = isItemActiveOn(created('Direct'), date, ctx());

        seed({ seasons: [season({ state })] });
        store().addTask({ title: 'Later', startDate: date });
        store().setItemsCollected([created('Later').id], 'season', 'p1', true);
        const viaCollect = isItemActiveOn(created('Later'), date, ctx());

        expect(viaCreate).toBe(viaCollect);
      }
    }
  });

  it('never changes the answer for any other item', () => {
    seed({ items: [task('a'), task('b')], seasons: [season({ state: 'paused' })] });
    const before = store().items.map((i) => isItemActiveOn(i, TODAY, ctx()));
    store().addTask({ title: 'Swim' }, { seasonIds: ['p1'] });
    const after = store()
      .items.filter((i) => i.title !== 'Swim')
      .map((i) => isItemActiveOn(i, TODAY, ctx()));
    expect(after).toEqual(before);
    // And membership is still what suppresses — a non-member stays live under
    // the very season that is hiding the new item.
    expect(after.every(Boolean)).toBe(true);
  });

  it('keeps paths disjunctive: a second gate is a reason to appear, never to vanish', () => {
    // The product rule in isItemActiveOn, asserted from the create path so that
    // "add a season" can never become "and it now needs every container on".
    seed({ seasons: [season({ state: 'paused' })], routines: [routine()] });
    store().addTask({ title: 'Swim' }, { seasonIds: ['p1'], routineIds: ['r1'] });
    expect(isItemActiveOn(created('Swim'), TODAY, ctx())).toBe(true);
  });

  it('leaves an item with no gate membership unconditionally live', () => {
    seed({ seasons: [season({ state: 'paused' })] });
    store().addTask({ title: 'Loner' });
    expect(isItemActiveOn(created('Loner'), TODAY, ctx())).toBe(true);
  });

  it('respects a season date range on the item\'s own date, not on today', () => {
    // `auto` is the state a date range answers in: the manual states apply
    // uniformly to every column and would short-circuit the range entirely.
    seed({
      seasons: [season({ state: 'auto', startsOn: '2026-03-01', endsOn: '2026-03-31' })],
    });
    store().addTask({ title: 'Swim', startDate: '2026-04-05' }, { seasonIds: ['p1'] });
    const item = created('Swim');
    expect(isItemActiveOn(item, '2026-04-05', ctx())).toBe(false);
    expect(isItemActiveOn(item, TODAY, ctx())).toBe(true);
  });
});

describe('the receipt', () => {
  it('warns when the season is off where the item lands', () => {
    // Decision 11, arriving by the create door: the write is allowed, the item
    // is simply not on the surface it was made on, and the bulk "Add to …"
    // path already says exactly this for the identical write.
    seed({ seasons: [season({ state: 'paused' })] });
    store().addTask({ title: 'Swim' }, { seasonIds: ['p1'] });
    expect(getActionLog()[0].label).toBe('Add task: Swim');
    expect(getActionLog()[0].receipt).toBe('Hidden with your Summer season');
  });

  it('stays quiet when the season is live', () => {
    store().addTask({ title: 'Swim' }, { seasonIds: ['p1'] });
    expect(getActionLog()[0].receipt).toBeUndefined();
  });

  it('stays quiet when no membership was asked for', () => {
    seed({ seasons: [season({ state: 'paused' })] });
    store().addTask({ title: 'Swim' });
    expect(getActionLog()[0].receipt).toBeUndefined();
  });

  it('resolves against the PROSPECTIVE membership, not the current one', () => {
    // The subtle one, and the reason a plain landingReceipt call would report
    // nothing: at the moment of asking, the item is not in `items` and the
    // season does not hold it. Both sides have to be asked about the world the
    // write is creating.
    seed({ seasons: [season({ state: 'paused', itemIds: [] })] });
    expect(store().seasons[0].itemIds).toEqual([]);
    store().addTask({ title: 'Swim' }, { seasonIds: ['p1'] });
    expect(getActionLog()[0].receipt).toBeTruthy();
  });

  it('answers at the item\'s landing date, not at today', () => {
    // A task made today FOR a Monday after the season ends is the case the
    // date parameter exists for; today is inside the range and would say the
    // opposite.
    seed({
      seasons: [season({ state: 'auto', startsOn: '2026-03-01', endsOn: '2026-03-31' })],
    });
    store().addTask({ title: 'Swim', startDate: '2026-04-05' }, { seasonIds: ['p1'] });
    expect(getActionLog()[0].receipt).toContain('Summer');
  });

  it('does not warn about a date the item is not landing on', () => {
    // The converse, which is what makes the one above a real assertion: the
    // season is off TODAY and the item is dated inside the range.
    seed({
      seasons: [season({ state: 'auto', startsOn: '2026-04-01', endsOn: '2026-04-30' })],
    });
    store().addTask({ title: 'Swim', startDate: '2026-04-05' }, { seasonIds: ['p1'] });
    expect(getActionLog()[0].receipt).toBeUndefined();
  });

  it('agrees with the resolver, in both directions', () => {
    // The receipt is a READOUT of isItemActiveOn, never a second opinion about
    // it — the failure lib/overdue.ts exists to warn about.
    for (const state of ['active', 'paused'] as const) {
      seed({ seasons: [season({ state })] });
      store().addTask({ title: 'Swim', startDate: TODAY }, { seasonIds: ['p1'] });
      const live = isItemActiveOn(created('Swim'), TODAY, ctx());
      expect(!!getActionLog()[0].receipt).toBe(!live);
    }
  });

  it('stays quiet for a goal, which suppresses nothing', () => {
    // ASPIRE, not GATE. A goal you are behind on is the last thing that should
    // quietly hide its work, so a goal-only add can never carry this receipt.
    seed({
      goals: [
        {
          id: 'g1',
          name: 'Swim 5k',
          state: 'active',
          memberIds: [],
          milestoneIds: [],
          checkinIds: [],
        } as unknown as Goal,
      ],
    });
    store().addTask({ title: 'Swim' }, { goalIds: ['g1'] });
    expect(store().goals[0].memberIds).toEqual([created('Swim').id]);
    expect(getActionLog()[0].receipt).toBeUndefined();
  });

  it('says the same thing about a routine, because a routine is the same role', () => {
    seed({ routines: [routine({ pausedAt: '2026-03-01T00:00:00.000Z' })] });
    store().addTask({ title: 'Swim' }, { routineIds: ['r1'] });
    expect(getActionLog()[0].receipt).toBe('Hidden with your Mornings routine');
  });

  it('rides habits too', () => {
    seed({ seasons: [season({ state: 'paused' })] });
    store().addHabit(
      { title: 'Stretch', project: 'Wellness', repeatFrequency: 'daily' },
      { seasonIds: ['p1'] },
    );
    expect(getActionLog()[0].receipt).toBe('Hidden with your Summer season');
  });

  it('resolves a habit at TODAY, since a habit has no landing date of its own', () => {
    // `paused` above would be satisfied by any date at all, which is the hole
    // this closes: swap addHabit's (absent) date argument for a far-future
    // constant and the test above still passes. An `auto` window is the only
    // state that can tell the days apart — decision 3, the same answer
    // assignHabitToBucket takes.
    seed({
      seasons: [season({ state: 'auto', startsOn: '2026-03-01', endsOn: '2026-03-31' })],
    });
    store().addHabit(
      { title: 'Stretch', project: 'Wellness', repeatFrequency: 'daily' },
      { seasonIds: ['p1'] },
    );
    // TODAY is inside the window, so nothing to say.
    expect(getActionLog()[0].receipt).toBeUndefined();

    // And the converse, so "quiet" above is a real answer and not a dead call:
    // a window that today sits outside of does produce the receipt.
    seed({
      seasons: [season({ state: 'auto', startsOn: '2026-04-01', endsOn: '2026-04-30' })],
    });
    store().addHabit(
      { title: 'Stretch', project: 'Wellness', repeatFrequency: 'daily' },
      { seasonIds: ['p1'] },
    );
    expect(getActionLog()[0].receipt).toContain('Summer');
  });

  it('rides custom types too, which reach the store by their own action', () => {
    // addItem is a third door, not a branch of addTask — it mints the row
    // itself and labels it off the type's config — so its receipt has to be
    // asserted on its own or a third of this feature is unpinned.
    seed({ seasons: [season({ state: 'paused' })] });
    usePlannerStore.setState({
      itemTypes: [{ id: 't1', name: 'errand', label: 'Errand', labelPlural: 'Errands' }],
    });
    store().addItem('errand', { title: 'Post office' }, { seasonIds: ['p1'] });

    expect(store().seasons[0].itemIds).toEqual([created('Post office').id]);
    expect(getActionLog()[0].label).toBe('Add errand: Post office');
    expect(getActionLog()[0].receipt).toBe('Hidden with your Summer season');
  });

  it('answers a custom type at ITS landing date, not at today', () => {
    seed({
      seasons: [season({ state: 'auto', startsOn: '2026-03-01', endsOn: '2026-03-31' })],
    });
    usePlannerStore.setState({
      itemTypes: [{ id: 't1', name: 'errand', label: 'Errand', labelPlural: 'Errands' }],
    });
    store().addItem('errand', { title: 'Post office', startDate: '2026-04-05' }, {
      seasonIds: ['p1'],
    });
    // Today is inside the window and would say the opposite.
    expect(getActionLog()[0].receipt).toContain('Summer');
  });

  it('stays quiet for a custom type created into a live season', () => {
    usePlannerStore.setState({
      itemTypes: [{ id: 't1', name: 'errand', label: 'Errand', labelPlural: 'Errands' }],
    });
    store().addItem('errand', { title: 'Post office' }, { seasonIds: ['p1'] });
    expect(getActionLog()[0].receipt).toBeUndefined();
  });
});

describe('the toast rule', () => {
  it('announces an ADD verb when it carries a receipt', () => {
    // `Add task:` is not, and should not be, in SIGNIFICANT_ACTIONS — every add
    // would toast. The receipt is the store's own statement that THIS write is
    // not visible where it was made, which is the condition the toast exists
    // for, so on the create path it is significance in itself.
    expect(isToastWorthy({ label: 'Add task: Swim' })).toBe(false);
    expect(isToastWorthy({ label: 'Add task: Swim', receipt: 'Hidden with your Summer season' }))
      .toBe(true);
    // The other two create doors, by the same prefix.
    expect(isToastWorthy({ label: 'Add habit: Stretch', receipt: 'Hidden with your Mornings routine' }))
      .toBe(true);
    expect(isToastWorthy({ label: 'Add errand: Post office', receipt: 'Paused' })).toBe(true);
  });

  it('says nothing about a receipted verb that is not an add', () => {
    // The other half of the rule, and the reason it is prefix-scoped. Every one
    // of these is an `Edit task:` in the store, and every one of them is noise:
    // a priority-only modal Save (updateTask tests key PRESENCE, not change), a
    // dozen EOD carry rows batched into one toast that names one of them, and
    // the triage/EOD undo paths, which would announce "hidden where it landed"
    // about a reversal. Widening this is the last step of fixing those.
    const receipt = 'Hidden with your Summer season';
    expect(isToastWorthy({ label: 'Edit task: Swim', receipt })).toBe(false);
    expect(isToastWorthy({ label: 'Edit task: Swim', receipt: 'Paused' })).toBe(false);
    expect(isToastWorthy({ label: 'Edit season: Summer', receipt })).toBe(false);
  });

  it('announces a picker batch by its flag, never by its label', () => {
    // batchHistory sets `batch`; one Undo on the strip reverts the lot.
    expect(isToastWorthy({ label: 'Set priority: High · 3 items', batch: 3 })).toBe(true);
    expect(isToastWorthy({ label: 'Complete items (3)', batch: 3 })).toBe(true);
    // A title that merely LOOKS like a batch label cannot spoof it.
    expect(isToastWorthy({ label: 'Edit task: Buy milk · 3 items' })).toBe(false);
    expect(isToastWorthy({ label: 'Edit task: Swim' })).toBe(false);
  });

  it('still announces the listed verbs with no receipt', () => {
    expect(isToastWorthy({ label: 'Add to Summer: 2 items' })).toBe(true);
    expect(isToastWorthy({ label: 'Delete task: Swim' })).toBe(true);
  });

  it('still says nothing about the quiet ones', () => {
    // The sweep in particular: it runs unattended and deliberately stands its
    // toast down (hooks/use-overdue-sweep.ts). It attaches no receipt, so this
    // rule must not resurrect it.
    expect(isToastWorthy({ label: 'Aged out: 4 items' })).toBe(false);
    expect(isToastWorthy({ label: 'Reorder tasks' })).toBe(false);
    expect(isToastWorthy({ label: 'Add task: Swim' })).toBe(false);
  });
});
