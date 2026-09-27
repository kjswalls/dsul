import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The project-block move verbs operate on TASK-LIKE items, not on `type ===
 * 'task'` exactly.
 *
 * Every affordance that reaches them reads the store's `tasks` PROJECTION,
 * which is `type !== 'habit' && !parentItemId` (planner-store `projectItems`).
 * So a custom item with a project renders project-block's "move to block"
 * button and arms its drop plate. The verbs used to resolve `type === 'task'`
 * and write `dbUpdateItem(id, 'task', …)` — and lib/db filters
 * `.eq('type', type)`, so that matched zero rows for a custom item. The result
 * was an affordance that was live on the way in and dead on arrival: no row
 * moved, no DB write, and the group drag still reported success and cleared the
 * selection.
 *
 * These pin the widened behaviour AND the db type that goes with it — widening
 * the lookup alone would still write against the wrong `type` column.
 *
 * `removeProject` is here too. It is a different verb but the same widening,
 * and it needs this file's store mocks; splitting it out would duplicate thirty
 * lines of them to say one thing.
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
import type { Item, Project } from '@/lib/planner-types';

const PROJECT: Project = {
  id: 'p-work',
  name: 'Work',
  emoji: '💼',
  // A block only exists when the project carries both — the verbs bail otherwise.
  startTime: '09:00',
  timeBucket: 'morning',
};

const item = (id: string, over: Partial<Item> = {}): Item =>
  ({
    type: 'task',
    id,
    title: `Item ${id}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
    project: 'Work',
    ...over,
  }) as Item;

/** A custom type travels under the closed envelope; items.type holds the slug. */
const goal = (id: string, over: Partial<Item> = {}): Item =>
  item(id, { type: 'custom', customType: 'goal', ...over } as Partial<Item>);

function seed(items: Item[]) {
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: 'UTC',
    selectedDate: new Date('2026-08-11T12:00:00Z'),
    items,
    projects: [PROJECT],
  });
}

const store = () => usePlannerStore.getState();

/**
 * The fields these assertions read live on the task-like branches only — the
 * habit branch has no `inProjectBlock` — so reading them off the raw union
 * needs narrowing at every call site. One view type instead.
 */
type TaskLikeView = {
  inProjectBlock?: boolean;
  startTime?: string;
  title: string;
  project?: string;
  group?: string;
};
const byId = (id: string) =>
  store().items.find((i) => i.id === id)! as unknown as TaskLikeView;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('moveTaskToProjectBlock', () => {
  it('moves a custom item, and writes it under its own db type', () => {
    seed([goal('g1')]);

    store().moveTaskToProjectBlock('g1');

    expect(byId('g1').inProjectBlock).toBe(true);
    // The db type is the slug, not 'task' — db.ts filters .eq('type', type),
    // so 'task' would match zero rows and the move would not persist.
    expect(db.updateItem).toHaveBeenCalledWith('g1', 'goal', expect.objectContaining({
      inProjectBlock: true,
      timeBucket: 'morning',
    }));
  });

  it('still moves a plain task, under type task', () => {
    seed([item('t1')]);

    store().moveTaskToProjectBlock('t1');

    expect(byId('t1').inProjectBlock).toBe(true);
    expect(db.updateItem).toHaveBeenCalledWith('t1', 'task', expect.anything());
  });

  it('does not touch a habit', () => {
    seed([{ ...item('h1'), type: 'habit', project: 'Health' } as Item]);

    store().moveTaskToProjectBlock('h1');

    expect(byId('h1').inProjectBlock).toBeUndefined();
    expect(db.updateItem).not.toHaveBeenCalled();
  });
});

describe('moveTasksToProjectBlock', () => {
  it('moves a mixed selection whole, rather than silently dropping the custom item', () => {
    seed([item('t1'), goal('g1')]);

    store().moveTasksToProjectBlock(['t1', 'g1']);

    expect(byId('t1').inProjectBlock).toBe(true);
    expect(byId('g1').inProjectBlock).toBe(true);
    expect(db.updateItem).toHaveBeenCalledWith('t1', 'task', expect.anything());
    expect(db.updateItem).toHaveBeenCalledWith('g1', 'goal', expect.anything());
  });

  it('resolves the block from a custom item when it is first in the selection', () => {
    // The project is read off whichever member the scan finds first. With the
    // old `type === 'task'` scan an all-custom selection found nobody and the
    // whole verb returned state unchanged.
    seed([goal('g1'), goal('g2')]);

    store().moveTasksToProjectBlock(['g1', 'g2']);

    expect(byId('g1').inProjectBlock).toBe(true);
    expect(byId('g2').inProjectBlock).toBe(true);
  });
});

describe('moveTaskOutOfProjectBlock', () => {
  it('restores a custom item, under its own db type', () => {
    seed([
      goal('g1', {
        inProjectBlock: true,
        previousStartTime: '14:00',
        previousStartDate: '2026-08-10',
      } as Partial<Item>),
    ]);

    store().moveTaskOutOfProjectBlock('g1');

    const restored = byId('g1');
    expect(restored.inProjectBlock).toBe(false);
    expect(restored.startTime).toBe('14:00');
    expect(db.updateItem).toHaveBeenCalledWith('g1', 'goal', expect.objectContaining({
      inProjectBlock: false,
    }));
  });

  it('names the item in the undo label instead of Unknown', () => {
    // The label is resolved BEFORE the set(), by a lookup that was also
    // 'task'-only — so a custom item produced "…: Unknown", and because the
    // guarded verb then returned state unchanged, no history entry consumed
    // that pending label: it stayed armed for the next unrelated action.
    seed([goal('g1', { title: 'Ship the thing', inProjectBlock: true } as Partial<Item>)]);
    const before = getActionLog().length;

    store().moveTaskOutOfProjectBlock('g1');

    expect(getActionLog().length).toBe(before + 1);
    expect(getActionLog()[0].label).toContain('Ship the thing');
  });
});

describe('removeProject clears the deleted name off every type that holds one', () => {
  it('reaches a custom item, not just a plain task', () => {
    seed([item('t1'), goal('g1')]);

    store().removeProject('p-work');

    expect(byId('t1').project).toBeUndefined();
    // The defect the widening fixes: under `type === 'task'` the custom item
    // kept `project: 'Work'` after the project row was gone. Every container
    // question then filed it under a project that no longer exists — the
    // filter offers no such option, so it becomes unreachable by container.
    expect(byId('g1').project).toBeUndefined();
    expect(store().projects).toHaveLength(0);
  });

  it('REASSIGNS a habit rather than unfiling it, because its container is required', () => {
    // The inverse of what this asserted before migration 039. A habit used to
    // answer with `group`, so `removeProject` skipped it outright; now there is
    // one CLASSIFY axis and the habit is an ordinary member — but one whose type
    // declares `containerRequired`, so it moves to the first surviving
    // container instead of being left with nothing. `unfiled` in planner-store
    // reads that capability rather than testing for a habit.
    seed([{ ...item('h1'), type: 'habit' } as Item]);

    store().removeProject('p-work');

    // No live container remains in this fixture, so the fallback name is the
    // honest answer — a text-only reference with no id, exactly the state 027
    // documents for most container references on the live database.
    expect(byId('h1').project).toBe('Personal');
  });

  it('leaves an item in a different project alone', () => {
    seed([goal('g1', { project: 'Side' } as Partial<Item>)]);

    store().removeProject('p-work');

    expect(byId('g1').project).toBe('Side');
  });
});
