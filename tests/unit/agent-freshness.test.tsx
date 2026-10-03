import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/**
 * Freshness without realtime (hooks/use-agent-freshness.ts, planner-store
 * `mergeAgentStates`). An agent writes the agent columns from outside the
 * browser, so Ask home re-reads them, throttled, and folds them in. The fold
 * is the delicate half: it must be the server's news and never the user's
 * action, which means no undo entry, no write-back, and no way for a later
 * undo of something unrelated to quietly revert the agent's work.
 *
 * The db layer is fully mocked (undo-redo-store.test.ts's pattern), so the
 * real store and its history subscriber run, and every write is observed.
 */

const hoisted = vi.hoisted(() => ({ refreshIfStale: vi.fn() }));

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
vi.mock('@/lib/conversations-store', () => ({
  useConversationsStore: { getState: () => ({ refreshIfStale: hoisted.refreshIfStale }) },
}));

import { mergeAgentStates, usePlannerStore } from '@/lib/planner-store';
import {
  AGENT_FRESHNESS_MS,
  refreshAgentFreshness,
  resetAgentFreshness,
  useAgentFreshness,
} from '@/hooks/use-agent-freshness';
import * as db from '@/lib/db';
import type { AgentStateRow } from '@/lib/db';
import type { Item, TaskItem } from '@/lib/planner-types';
import { needsYou } from '@/lib/ask-home';

const USER = 'user-1';
const T0 = '2026-10-02T09:00:00.000Z';
const T1 = '2026-10-02T09:30:00.000Z';
/** Later than any stamp updateTask writes while this file runs. */
const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

const fixtures = (): Item[] => [
  {
    type: 'task',
    id: 'run',
    title: 'Gift for Ari',
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    assignee: 'openclaw',
    aiStatus: 'working',
    aiStatusAt: T0,
  } as Item,
  { type: 'task', id: 'plain', title: 'Water the plants', status: 'pending', isScheduled: false, order: 1, completedDates: [] },
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
const byId = (id: string) => store().items.find((i) => i.id === id) as TaskItem;
const row = (over: Partial<AgentStateRow> = {}): AgentStateRow => ({
  id: 'run',
  assignee: 'openclaw',
  aiStatus: 'blocked',
  aiResult: 'Which shop?',
  aiStatusAt: T1,
  ...over,
});
/** Every updateItem call that carried an agent column. */
const agentWrites = () =>
  vi
    .mocked(db.updateItem)
    .mock.calls.filter((c) => JSON.stringify(c).match(/aiStatus|aiResult|assignee/));

beforeEach(async () => {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(fixtures());
  await store().initializeStore(USER);
  resetAgentFreshness();
});

describe('mergeAgentStates', () => {
  it('applies a newer row, in one set, with no undo entry and no write', () => {
    const sets = vi.fn();
    const unsub = usePlannerStore.subscribe(sets);
    const { historyIndex, canUndo } = store();

    expect(mergeAgentStates([row()])).toBe(1);
    unsub();

    expect(byId('run')).toMatchObject({ aiStatus: 'blocked', aiResult: 'Which shop?', aiStatusAt: T1 });
    expect(sets).toHaveBeenCalledTimes(1);
    expect(store().historyIndex).toBe(historyIndex);
    expect(store().canUndo).toBe(canUndo);
    expect(db.updateItem).not.toHaveBeenCalled();
    // The projection follows: Needs you reads `items`, other views `tasks`.
    expect(store().tasks.find((t) => t.id === 'run')?.aiStatus).toBe('blocked');
  });

  it('ignores a row no newer than the item, with no stamp, or for nothing it holds', () => {
    expect(mergeAgentStates([row({ aiStatusAt: T0 })])).toBe(0);
    expect(mergeAgentStates([row({ aiStatusAt: '2026-10-02T08:00:00.000Z' })])).toBe(0);
    expect(mergeAgentStates([row({ aiStatusAt: null })])).toBe(0);
    expect(mergeAgentStates([row({ id: 'gone' })])).toBe(0);
    expect(mergeAgentStates([row({ id: 'habit-1' })])).toBe(0);
    expect(byId('run')).toMatchObject({ aiStatus: 'working', aiStatusAt: T0 });
  });

  it('takes a stamped row for an item that had none', () => {
    expect(mergeAgentStates([row({ id: 'plain', aiStatus: 'done', aiResult: 'Done.' })])).toBe(1);
    expect(byId('plain')).toMatchObject({ assignee: 'openclaw', aiStatus: 'done', aiResult: 'Done.' });
  });

  it('waits out a load in flight', () => {
    usePlannerStore.setState({ isLoading: true });
    expect(mergeAgentStates([row()])).toBe(0);
    usePlannerStore.setState({ isLoading: false });
  });

  it('survives an unrelated undo: nothing writes the old agent state back', () => {
    store().updateTask('plain', { title: 'Water the ferns' });
    mergeAgentStates([row()]);
    vi.mocked(db.updateItem).mockClear();

    store().undo();

    expect(byId('plain').title).toBe('Water the plants');
    expect(byId('run')).toMatchObject({ aiStatus: 'blocked', aiResult: 'Which shop?', aiStatusAt: T1 });
    expect(agentWrites()).toEqual([]);

    // And back again: redo restores the title and still leaves the run alone.
    store().redo();
    expect(byId('plain').title).toBe('Water the ferns');
    expect(byId('run').aiStatus).toBe('blocked');
    expect(agentWrites()).toEqual([]);
  });

  it("still lets the user undo their own delegation after the agent's news", () => {
    store().updateTask('plain', { assignee: 'openclaw', aiStatus: 'queued' });
    expect(byId('plain').aiStatus).toBe('queued');

    mergeAgentStates([row({ id: 'plain', aiStatus: 'working', aiResult: null, aiStatusAt: FUTURE })]);
    expect(byId('plain').aiStatus).toBe('working');

    store().undo();
    expect(byId('plain').assignee).toBeUndefined();
    expect(byId('plain').aiStatus).toBeUndefined();
  });
});

describe('refreshAgentFreshness', () => {
  const T = 1_000_000;

  it('reads at most once a minute, and folds what it reads', async () => {
    vi.mocked(db.fetchAgentStates).mockResolvedValue([row()]);
    await refreshAgentFreshness(T);
    expect(db.fetchAgentStates).toHaveBeenCalledTimes(1);
    expect(byId('run').aiStatus).toBe('blocked');

    await refreshAgentFreshness(T + AGENT_FRESHNESS_MS - 1);
    expect(db.fetchAgentStates).toHaveBeenCalledTimes(1);
    await refreshAgentFreshness(T + AGENT_FRESHNESS_MS);
    expect(db.fetchAgentStates).toHaveBeenCalledTimes(2);
  });

  it('takes an undelegation made on another device: the item leaves Needs you', async () => {
    vi.mocked(db.fetchAgentStates).mockResolvedValue([row()]);
    await refreshAgentFreshness(T);
    expect(needsYou(store().items).map((i) => i.id)).toEqual(['run']);

    // The Remove button's write, read back: no agent, no status, a newer stamp.
    const T2 = '2026-10-02T10:00:00.000Z';
    vi.mocked(db.fetchAgentStates).mockResolvedValue([row({ assignee: null, aiStatus: null, aiResult: null, aiStatusAt: T2 })]);
    await refreshAgentFreshness(T + AGENT_FRESHNESS_MS);
    expect(byId('run').assignee).toBeUndefined();
    expect(byId('run').aiStatus).toBeUndefined();
    expect(needsYou(store().items)).toEqual([]);
  });

  it('asks the conversation list to refresh when stale, every time', async () => {
    await refreshAgentFreshness(T);
    await refreshAgentFreshness(T + 1);
    expect(hoisted.refreshIfStale).toHaveBeenCalledTimes(2);
    expect(hoisted.refreshIfStale).toHaveBeenCalledWith(AGENT_FRESHNESS_MS);
  });

  it('drops a read that lands after the account changed', async () => {
    let land: (rows: AgentStateRow[]) => void = () => {};
    vi.mocked(db.fetchAgentStates).mockReturnValue(new Promise((r) => (land = r)));
    const done = refreshAgentFreshness(T);
    usePlannerStore.setState({ userId: 'someone-else' });
    land([row()]);
    await done;
    expect(byId('run').aiStatus).toBe('working');
  });

  it('asks for nothing signed out, and treats a failure as nothing new', async () => {
    usePlannerStore.setState({ userId: null });
    await refreshAgentFreshness(T);
    expect(db.fetchAgentStates).not.toHaveBeenCalled();

    usePlannerStore.setState({ userId: USER });
    vi.mocked(db.fetchAgentStates).mockRejectedValue(new Error('offline'));
    await expect(refreshAgentFreshness(T)).resolves.toBeUndefined();
    expect(byId('run').aiStatus).toBe('working');
  });
});

describe('useAgentFreshness', () => {
  afterEach(() => resetAgentFreshness());

  it('reads on showing, on focus and on the tab coming back, and not while hidden', () => {
    const { rerender, unmount } = renderHook(({ active }) => useAgentFreshness(active), {
      initialProps: { active: false },
    });
    window.dispatchEvent(new Event('focus'));
    expect(db.fetchAgentStates).not.toHaveBeenCalled();

    rerender({ active: true });
    expect(db.fetchAgentStates).toHaveBeenCalledTimes(1);

    // Throttled: a focus straight after asks for nothing.
    window.dispatchEvent(new Event('focus'));
    expect(db.fetchAgentStates).toHaveBeenCalledTimes(1);

    act(() => resetAgentFreshness());
    window.dispatchEvent(new Event('focus'));
    expect(db.fetchAgentStates).toHaveBeenCalledTimes(2);

    act(() => resetAgentFreshness());
    document.dispatchEvent(new Event('visibilitychange'));
    expect(db.fetchAgentStates).toHaveBeenCalledTimes(3);

    unmount();
    resetAgentFreshness();
    window.dispatchEvent(new Event('focus'));
    expect(db.fetchAgentStates).toHaveBeenCalledTimes(3);
  });
});
