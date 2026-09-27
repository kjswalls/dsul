import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * setItemsCollected — the membership half of the bulk verbs (#205 / Phase 5).
 *
 * The reason it is one store action rather than N calls to updateRoutine is the
 * undo contract every other bulk verb holds: one gesture, one set(), one
 * history entry. Twelve calls would cost twelve Cmd+Z to reverse.
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

import { usePlannerStore, getActionLog } from '@/lib/planner-store';
import * as db from '@/lib/db';
import type { Item, Season, Routine } from '@/lib/planner-types';

const USER = 'user-1';

const task = (id: string, over: Partial<Item> = {}): Item =>
  ({
    type: 'task',
    id,
    title: `Task ${id}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
    ...over,
  }) as Item;

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: 'r1',
  name: 'Mornings',
  itemIds: [],
  ...over,
});

const season = (over: Partial<Season> = {}): Season => ({
  id: 'p1',
  name: 'Summer',
  state: 'active',
  itemIds: [],
  routineIds: [],
  ...over,
});

function seed(over: { items?: Item[]; routines?: Routine[]; seasons?: Season[] } = {}) {
  usePlannerStore.setState({
    userId: USER,
    userTimezone: 'UTC',
    items: over.items ?? [task('a'), task('b'), task('c')],
    routines: over.routines ?? [routine()],
    seasons: over.seasons ?? [season()],
    collectionsAvailable: true,
  });
}

const collected = () => usePlannerStore.getState().setItemsCollected;
const routineIds = () => usePlannerStore.getState().routines[0].itemIds;
const seasonIds = () => usePlannerStore.getState().seasons[0].itemIds;

describe('setItemsCollected', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
  });

  it('adds a whole selection to a routine in one write', () => {
    collected()(['a', 'b'], 'routine', 'r1', true);
    expect(routineIds()).toEqual(['a', 'b']);
    expect(db.updateRoutine).toHaveBeenCalledTimes(1);
    expect(db.updateRoutine).toHaveBeenCalledWith(USER, 'r1', { itemIds: ['a', 'b'] });
  });

  it('is one undo entry, not one per item', () => {
    // The whole reason this is a store action. Twelve calls to updateRoutine
    // would be twelve history entries and twelve Cmd+Z to reverse.
    const before = getActionLog().length;
    collected()(['a', 'b', 'c'], 'routine', 'r1', true);
    expect(getActionLog().length).toBe(before + 1);
    expect(getActionLog()[0].label).toBe('Add to Mornings: 3 items');
  });

  it('does not duplicate members that were already in', () => {
    seed({ routines: [routine({ itemIds: ['a'] })] });
    collected()(['a', 'b'], 'routine', 'r1', true);
    expect(routineIds()).toEqual(['a', 'b']);
  });

  it('removes only the selection, leaving other members alone', () => {
    seed({ routines: [routine({ itemIds: ['a', 'b', 'c'] })] });
    collected()(['a', 'c'], 'routine', 'r1', false);
    expect(routineIds()).toEqual(['b']);
  });

  it('writes nothing at all when the request is already satisfied', () => {
    // Not merely idempotent in the data — it must not push a history entry
    // either, or an undo appears for a write that never happened.
    seed({ routines: [routine({ itemIds: ['a', 'b'] })] });
    const before = getActionLog().length;
    collected()(['a', 'b'], 'routine', 'r1', true);
    expect(getActionLog().length).toBe(before);
    expect(db.updateRoutine).not.toHaveBeenCalled();
  });

  it('routes seasons to the season table', () => {
    collected()(['a'], 'season', 'p1', true);
    expect(seasonIds()).toEqual(['a']);
    expect(db.updateSeason).toHaveBeenCalledWith(USER, 'p1', { itemIds: ['a'] });
    expect(db.updateRoutine).not.toHaveBeenCalled();
  });

  it('collects the eligible subset and skips subtasks', () => {
    // Registry rule, not a type check: a subtask surfaces only inside its
    // parent, so collecting one produces membership the user cannot see.
    seed({ items: [task('a'), task('sub', { parentItemId: 'a' }), task('c')] });
    collected()(['a', 'sub', 'c'], 'routine', 'r1', true);
    expect(routineIds()).toEqual(['a', 'c']);
  });

  it('does nothing when the selection is entirely ineligible', () => {
    seed({ items: [task('a'), task('sub', { parentItemId: 'a' })] });
    const before = getActionLog().length;
    collected()(['sub'], 'routine', 'r1', true);
    expect(routineIds()).toEqual([]);
    expect(getActionLog().length).toBe(before);
  });

  it('ignores an unknown container rather than inventing one', () => {
    const before = getActionLog().length;
    collected()(['a'], 'routine', 'nope', true);
    expect(getActionLog().length).toBe(before);
    expect(db.updateRoutine).not.toHaveBeenCalled();
  });
});

describe('setItemsCollected — the receipt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('warns when collecting into a container that is currently off', () => {
    // Decision 11: the move is allowed — that is what collecting into a paused
    // season means — but never silently. Without this the items simply vanish
    // from the grid the moment the menu closes.
    seed({ seasons: [season({ state: 'paused' })] });
    collected()(['a', 'b'], 'season', 'p1', true);
    expect(getActionLog()[0].receipt).toBe('Hidden with your Summer season');
  });

  it('stays quiet when the container is live', () => {
    seed({ seasons: [season({ state: 'active' })] });
    collected()(['a', 'b'], 'season', 'p1', true);
    expect(getActionLog()[0].receipt).toBeUndefined();
  });

  it('resolves against the PROSPECTIVE membership, not the current one', () => {
    // The subtle one. Every other landingReceipt caller moves an item's date
    // while the containers hold still, so asking before the write gives the
    // same answer. Here it is the containers that move: asked against current
    // state the items are not yet members, nothing is suppressed, and the
    // receipt would never fire on the one action that most needs it.
    seed({ seasons: [season({ state: 'paused', itemIds: [] })] });
    expect(usePlannerStore.getState().seasons[0].itemIds).toEqual([]);
    collected()(['a'], 'season', 'p1', true);
    expect(getActionLog()[0].receipt).toBeTruthy();
  });

  it('carries no receipt when releasing — the items become visible, not hidden', () => {
    seed({ seasons: [season({ state: 'paused', itemIds: ['a', 'b'] })] });
    collected()(['a'], 'season', 'p1', false);
    expect(getActionLog()[0].label).toBe('Remove from Summer: 1 item');
    expect(getActionLog()[0].receipt).toBeUndefined();
  });
});
