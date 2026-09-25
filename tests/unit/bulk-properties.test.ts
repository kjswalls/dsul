import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The bulk PROPERTY verbs behind the multiselect bar's Edit menu —
 * setItemsPriority, setItemsProject, setItemsReminder, setItemsGoal.
 *
 * Same contract as every bulk verb (see bulk-collect.test.ts): one gesture, one
 * set(), one history entry, one ⌘/Ctrl+Z. Two things on top of it are specific
 * to these, and each is pinned per verb below:
 *  · the eligible subset is the REGISTRY's answer (lib/bulk-edit.ts), never a
 *    task-vs-habit check, and a custom type writes under its own slug;
 *  · items already in the requested state are dropped before anything happens,
 *    so the label's count is the number of writes, and a request that changes
 *    nothing leaves no history entry at all.
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
  setItemSkip: vi.fn(async () => {}),
  createProject: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  deleteProject: vi.fn(async () => {}),
  restoreProject: vi.fn(async () => {}),
  fetchRoutines: vi.fn(async () => []),
  createRoutine: vi.fn(async () => {}),
  updateRoutine: vi.fn(async () => {}),
  deleteRoutine: vi.fn(async () => {}),
  restoreRoutine: vi.fn(async () => {}),
  fetchPrograms: vi.fn(async () => []),
  createProgram: vi.fn(async () => {}),
  updateProgram: vi.fn(async () => {}),
  deleteProgram: vi.fn(async () => {}),
  restoreProgram: vi.fn(async () => {}),
  fetchGoals: vi.fn(async () => []),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import { usePlannerStore, getActionLog } from '@/lib/planner-store';
import * as db from '@/lib/db';
import type { Goal, Item, Project, TaskItem } from '@/lib/planner-types';

const USER = 'user-1';
const store = () => usePlannerStore.getState();
const byId = (id: string) => store().items.find((i) => i.id === id) as Item & Record<string, unknown>;

const task = (id: string, over: Partial<TaskItem> = {}): Item =>
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

const habit = (id: string, over: Record<string, unknown> = {}): Item =>
  ({
    type: 'habit',
    id,
    title: `Habit ${id}`,
    status: 'pending',
    repeatFrequency: 'daily',
    completedDates: [],
    skippedDates: [],
    streak: 0,
    project: 'Health',
    projectId: 'p-health',
    ...over,
  }) as unknown as Item;

// Unhydrated slug: getItemTypeConfig is total, so it resolves to the custom
// template (task-shaped fields, project container, remindable, collectible).
const errand = (id: string, over: Record<string, unknown> = {}): Item =>
  ({
    type: 'custom',
    customType: 'errand',
    id,
    title: `Errand ${id}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    skippedDates: [],
    ...over,
  }) as unknown as Item;

const PROJECTS: Project[] = [
  { id: 'p-work', name: 'Work', emoji: '' },
  { id: 'p-health', name: 'Health', emoji: '' },
];

const goal = (over: Partial<Goal> = {}): Goal =>
  ({
    id: 'g1',
    name: 'Run a marathon',
    state: 'active',
    memberIds: [],
    milestoneIds: [],
    checkinIds: [],
    ...over,
  }) as Goal;

function seed(items: Item[], goals: Goal[] = [goal()]) {
  usePlannerStore.setState({
    userId: USER,
    userTimezone: 'UTC',
    items,
    projects: PROJECTS,
    routines: [],
    programs: [],
    goals,
    itemTypes: [],
  });
}

const updateCalls = () => vi.mocked(db.updateItem).mock.calls;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('setItemsPriority', () => {
  it('writes every eligible item in one history entry', () => {
    seed([task('a'), task('b'), task('c', { priority: 'low' })]);
    const before = getActionLog().length;
    store().setItemsPriority(['a', 'b', 'c'], 'high');
    expect(getActionLog().length).toBe(before + 1);
    expect(getActionLog()[0].label).toBe('Set priority: High · 3 items');
    expect(['a', 'b', 'c'].map((id) => byId(id).priority)).toEqual(['high', 'high', 'high']);
    expect(updateCalls()).toHaveLength(3);
    expect(db.updateItem).toHaveBeenCalledWith('a', 'task', { priority: 'high' });
  });

  it('skips habits (no priority field) and cancelled items — registry, not type', () => {
    seed([task('a'), habit('h'), task('x', { status: 'cancelled' })]);
    store().setItemsPriority(['a', 'h', 'x'], 'medium');
    expect(getActionLog()[0].label).toBe('Set priority: Medium · 1 item');
    expect(updateCalls().map((c) => c[0])).toEqual(['a']);
    expect(byId('x').priority).toBeUndefined();
  });

  it('drops items already at the value from the write and the count', () => {
    seed([task('a', { priority: 'high' }), task('b')]);
    store().setItemsPriority(['a', 'b'], 'high');
    expect(getActionLog()[0].label).toBe('Set priority: High · 1 item');
    expect(updateCalls().map((c) => c[0])).toEqual(['b']);
  });

  it('is a true no-op when nothing changes — no entry, no writes', () => {
    seed([task('a', { priority: 'high' }), habit('h')]);
    const before = getActionLog().length;
    store().setItemsPriority(['a', 'h'], 'high');
    expect(getActionLog().length).toBe(before);
    expect(db.updateItem).not.toHaveBeenCalled();
  });

  it('clears with an explicit undefined and says so', () => {
    seed([task('a', { priority: 'high' }), task('b', { priority: 'low' })]);
    store().setItemsPriority(['a', 'b'], undefined);
    expect(getActionLog()[0].label).toBe('Clear priority · 2 items');
    const patch = updateCalls()[0][2];
    expect('priority' in patch).toBe(true);
    expect((patch as { priority?: string }).priority).toBeUndefined();
  });

  it('writes a custom type under its own slug', () => {
    seed([errand('e')]);
    store().setItemsPriority(['e'], 'low');
    expect(db.updateItem).toHaveBeenCalledWith('e', 'errand', { priority: 'low' });
  });

  it('one undo restores every item', () => {
    seed([task('a'), task('b', { priority: 'low' })]);
    store().setItemsPriority(['a', 'b'], 'high');
    vi.clearAllMocks();
    store().undo();
    expect(byId('a').priority).toBeUndefined();
    expect(byId('b').priority).toBe('low');
    // The persistence half: undo re-syncs the restored values to the DB.
    expect(db.updateItem).toHaveBeenCalledWith('b', 'task', { priority: 'low' });
    expect(updateCalls().map((c) => c[0]).sort()).toEqual(['a', 'b']);
  });
});

describe('setItemsProject', () => {
  it('resolves the project id once, case-folded, and files every item', () => {
    seed([task('a'), habit('h'), errand('e')]);
    const before = getActionLog().length;
    store().setItemsProject(['a', 'h', 'e'], 'work');
    expect(getActionLog().length).toBe(before + 1);
    expect(getActionLog()[0].label).toBe('Set project: work · 3 items');
    for (const id of ['a', 'h', 'e']) {
      expect(byId(id).project).toBe('work');
      expect(byId(id).projectId).toBe('p-work');
    }
    expect(db.updateItem).toHaveBeenCalledWith('h', 'habit', { project: 'work', projectId: 'p-work' });
    expect(db.updateItem).toHaveBeenCalledWith('e', 'errand', { project: 'work', projectId: 'p-work' });
  });

  it('skips items already filed there by folded name AND id', () => {
    seed([task('a', { project: 'WORK', projectId: 'p-work' }), task('b')]);
    store().setItemsProject(['a', 'b'], 'Work');
    expect(getActionLog()[0].label).toBe('Set project: Work · 1 item');
    expect(updateCalls().map((c) => c[0])).toEqual(['b']);
  });

  it('still writes a folded name match whose id is stale — it repairs the link', () => {
    seed([task('a', { project: 'Work' })]);
    store().setItemsProject(['a'], 'Work');
    expect(db.updateItem).toHaveBeenCalledWith('a', 'task', { project: 'Work', projectId: 'p-work' });
  });

  it('clearing skips types whose container is required', () => {
    seed([task('a', { project: 'Work', projectId: 'p-work' }), habit('h')]);
    store().setItemsProject(['a', 'h'], undefined);
    expect(getActionLog()[0].label).toBe('Clear project · 1 item');
    expect(updateCalls().map((c) => c[0])).toEqual(['a']);
    expect(byId('h').project).toBe('Health');
    expect(byId('a').project).toBeUndefined();
    expect(byId('a').projectId).toBeUndefined();
  });

  it('releases an item parked in its old project block', () => {
    // Left parked, it would sit in a block it no longer belongs to and render
    // in no block at all — gone from the day.
    seed([
      task('a', {
        project: 'Health',
        projectId: 'p-health',
        inProjectBlock: true,
        startDate: '2026-09-25',
        previousStartTime: '09:00',
        previousStartDate: '2026-09-24',
      }),
    ]);
    store().setItemsProject(['a'], 'Work');
    const a = byId('a');
    expect(a.inProjectBlock).toBe(false);
    expect(a.startTime).toBe('09:00');
    expect(a.startDate).toBe('2026-09-24');
    expect(a.previousStartTime).toBeUndefined();
    expect(a.previousStartDate).toBeUndefined();
    expect(updateCalls()[0][2]).toMatchObject({ inProjectBlock: false, startTime: '09:00' });

    // Undo parks it again — locally and in the DB.
    vi.clearAllMocks();
    store().undo();
    expect(byId('a').inProjectBlock).toBe(true);
    expect(db.updateItem).toHaveBeenCalledWith(
      'a',
      'task',
      expect.objectContaining({
        project: 'Health',
        projectId: 'p-health',
        inProjectBlock: true,
        previousStartTime: '09:00',
        previousStartDate: '2026-09-24',
      }),
    );
  });

  it('clearing the project releases a parked item too', () => {
    seed([
      task('a', {
        project: 'Health',
        projectId: 'p-health',
        inProjectBlock: true,
        previousStartTime: '09:00',
        previousStartDate: '2026-09-24',
      }),
    ]);
    store().setItemsProject(['a'], undefined);
    const a = byId('a');
    expect(a.project).toBeUndefined();
    expect(a.inProjectBlock).toBe(false);
    expect(a.startTime).toBe('09:00');
    expect(a.startDate).toBe('2026-09-24');
  });

  it('a same-name link repair leaves a parked item in its block', () => {
    // Same project, stale id: the block it is parked in is still its own.
    seed([task('a', { project: 'work', inProjectBlock: true, previousStartTime: '09:00' })]);
    store().setItemsProject(['a'], 'Work');
    expect(byId('a').inProjectBlock).toBe(true);
    expect(db.updateItem).toHaveBeenCalledWith('a', 'task', { project: 'Work', projectId: 'p-work' });
  });

  it('is a true no-op when nothing changes', () => {
    seed([task('a', { project: 'Work', projectId: 'p-work' }), habit('h')]);
    const before = getActionLog().length;
    store().setItemsProject(['a'], 'Work');
    store().setItemsProject(['h'], undefined);
    expect(getActionLog().length).toBe(before);
    expect(db.updateItem).not.toHaveBeenCalled();
  });

  it('one undo restores every item', () => {
    seed([task('a'), habit('h')]);
    store().setItemsProject(['a', 'h'], 'Work');
    store().undo();
    expect(byId('a').project).toBeUndefined();
    expect(byId('h').project).toBe('Health');
    expect(byId('h').projectId).toBe('p-health');
  });
});

describe('setItemsReminder', () => {
  it('sets the time and keeps each item its own anchor', () => {
    seed([task('a', { reminderAnchor: 'after coffee' }), habit('h')]);
    const before = getActionLog().length;
    store().setItemsReminder(['a', 'h'], '08:00');
    expect(getActionLog().length).toBe(before + 1);
    expect(getActionLog()[0].label).toBe('Set reminder: 08:00 · 2 items');
    expect(byId('a').reminderTime).toBe('08:00');
    expect(byId('a').reminderAnchor).toBe('after coffee');
    expect(db.updateItem).toHaveBeenCalledWith('a', 'task', { reminderTime: '08:00' });
    expect(db.updateItem).toHaveBeenCalledWith('h', 'habit', { reminderTime: '08:00' });
  });

  it('clearing clears both halves', () => {
    seed([task('a', { reminderTime: '08:00', reminderAnchor: 'after coffee' }), task('b')]);
    store().setItemsReminder(['a', 'b'], undefined);
    expect(getActionLog()[0].label).toBe('Clear reminder · 1 item');
    expect(byId('a').reminderTime).toBeUndefined();
    expect(byId('a').reminderAnchor).toBeUndefined();
    const patch = updateCalls()[0][2];
    expect(Object.keys(patch).sort()).toEqual(['reminderAnchor', 'reminderTime']);
  });

  it('clearing still writes an orphaned anchor, and skips an item with neither half', () => {
    seed([task('a', { reminderAnchor: 'after coffee' }), task('b')]);
    store().setItemsReminder(['a', 'b'], undefined);
    expect(getActionLog()[0].label).toBe('Clear reminder · 1 item');
    expect(updateCalls().map((c) => c[0])).toEqual(['a']);
    expect(byId('a').reminderAnchor).toBeUndefined();
  });

  it('skips non-remindable items (subtasks) and items already at the time', () => {
    seed([task('a'), task('sub', { parentItemId: 'a' }), task('c', { reminderTime: '08:00' })]);
    store().setItemsReminder(['a', 'sub', 'c'], '08:00');
    expect(getActionLog()[0].label).toBe('Set reminder: 08:00 · 1 item');
    expect(updateCalls().map((c) => c[0])).toEqual(['a']);
    expect(byId('sub').reminderTime).toBeUndefined();
  });

  it('is a true no-op when nothing changes', () => {
    seed([task('a', { reminderTime: '08:00' }), task('b')]);
    const before = getActionLog().length;
    store().setItemsReminder(['a'], '08:00');
    store().setItemsReminder(['b'], undefined);
    expect(getActionLog().length).toBe(before);
    expect(db.updateItem).not.toHaveBeenCalled();
  });

  it('writes a custom type under its own slug', () => {
    seed([errand('e')]);
    store().setItemsReminder(['e'], '07:30');
    expect(db.updateItem).toHaveBeenCalledWith('e', 'errand', { reminderTime: '07:30' });
  });

  it('one undo restores every item', () => {
    seed([task('a', { reminderTime: '06:00' }), habit('h')]);
    store().setItemsReminder(['a', 'h'], '08:00');
    vi.clearAllMocks();
    store().undo();
    expect(db.updateItem).toHaveBeenCalledWith('a', 'task', { reminderTime: '06:00' });
    expect(byId('a').reminderTime).toBe('06:00');
    expect(byId('h').reminderTime).toBeUndefined();
  });
});

describe('setItemsGoal', () => {
  const goalNow = () => store().goals[0];

  it('adds the selection as plain members in one goal write', () => {
    seed([task('a'), habit('h'), errand('e')]);
    const before = getActionLog().length;
    store().setItemsGoal(['a', 'h', 'e'], 'g1', true);
    expect(getActionLog().length).toBe(before + 1);
    expect(getActionLog()[0].label).toBe('Add to Run a marathon: 3 items');
    expect(goalNow().memberIds).toEqual(['a', 'h', 'e']);
    expect(db.updateGoal).toHaveBeenCalledTimes(1);
    expect(db.updateGoal).toHaveBeenCalledWith(USER, 'g1', { memberIds: ['a', 'h', 'e'] });
  });

  it('skips items the goal already holds in ANY role, and subtasks', () => {
    seed(
      [task('m'), task('c'), task('x'), task('sub', { parentItemId: 'x' })],
      [goal({ milestoneIds: ['m'], checkinIds: ['c'] })],
    );
    store().setItemsGoal(['m', 'c', 'x', 'sub'], 'g1', true);
    expect(getActionLog()[0].label).toBe('Add to Run a marathon: 1 item');
    expect(goalNow().memberIds).toEqual(['x']);
    expect(goalNow().milestoneIds).toEqual(['m']);
    expect(goalNow().checkinIds).toEqual(['c']);
  });

  it('removing strips all three role arrays', () => {
    seed(
      [task('a'), task('m'), task('c'), task('keep')],
      [goal({ memberIds: ['a', 'keep'], milestoneIds: ['m'], checkinIds: ['c'] })],
    );
    store().setItemsGoal(['a', 'm', 'c'], 'g1', false);
    expect(getActionLog()[0].label).toBe('Remove from Run a marathon: 3 items');
    expect(goalNow().memberIds).toEqual(['keep']);
    expect(goalNow().milestoneIds).toEqual([]);
    expect(goalNow().checkinIds).toEqual([]);
    expect(db.updateGoal).toHaveBeenCalledWith(USER, 'g1', {
      memberIds: ['keep'],
      milestoneIds: [],
      checkinIds: [],
    });
  });

  it('is a true no-op when nothing changes', () => {
    seed([task('a'), task('b')], [goal({ milestoneIds: ['a'] })]);
    const before = getActionLog().length;
    store().setItemsGoal(['a'], 'g1', true);
    store().setItemsGoal(['b'], 'g1', false);
    store().setItemsGoal(['a'], 'nope', true);
    expect(getActionLog().length).toBe(before);
    expect(db.updateGoal).not.toHaveBeenCalled();
  });

  it('signed out, it updates locally and writes nothing', () => {
    seed([task('a')]);
    usePlannerStore.setState({ userId: null });
    store().setItemsGoal(['a'], 'g1', true);
    expect(goalNow().memberIds).toEqual(['a']);
    expect(db.updateGoal).not.toHaveBeenCalled();
  });

  it('one undo restores the goal', () => {
    seed([task('a'), task('m')], [goal({ milestoneIds: ['m'] })]);
    store().setItemsGoal(['a', 'm'], 'g1', false);
    vi.clearAllMocks();
    store().undo();
    expect(goalNow().milestoneIds).toEqual(['m']);
    expect(db.updateGoal).toHaveBeenCalledWith(USER, 'g1', { milestoneIds: ['m'] });
    store().setItemsGoal(['a'], 'g1', true);
    store().undo();
    expect(goalNow().memberIds).toEqual([]);
  });
});
