import { describe, it, expect, vi, beforeEach } from 'vitest';

// planner-store's db layer is fully mocked: these tests drive the real
// Zustand store (including the module-level history subscriber) and assert
// both the restored state and the db sync calls undo/redo emits.

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
  // The rename fan-out (migration 027) — updateProject/updateHabitGroup call it
  // whenever the name actually changes.
  renameContainerMembers: vi.fn(async () => {}),
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

import { usePlannerStore } from '@/lib/planner-store';
import * as db from '@/lib/db';
import type { Item } from '@/lib/planner-types';

const USER = 'user-1';

const fixtures = (): Item[] => [
  {
    type: 'task',
    id: 'task-1',
    title: 'Write tests',
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
  },
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

beforeEach(async () => {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(fixtures());
  await store().initializeStore(USER);
});

describe('custom-type items (Phase 6 regression coverage)', () => {
  const customFixtures = (): Item[] => [
    ...fixtures(),
    {
      type: 'custom',
      customType: 'goal',
      id: 'goal-1',
      title: 'Run a 10k',
      status: 'pending',
      isScheduled: false,
      order: 0,
      completedDates: [],
    },
  ];

  beforeEach(async () => {
    store().clearStore();
    vi.clearAllMocks();
    vi.mocked(db.fetchItems).mockResolvedValue(customFixtures());
    await store().initializeStore(USER);
  });

  it('rides the task-like pipeline: tasks projection includes it, habits does not', () => {
    expect(store().tasks).toHaveLength(2);
    expect(store().habits).toHaveLength(1);
  });

  it('deleteTask resolves the DB slug, never the envelope discriminant', () => {
    store().deleteTask('goal-1');
    expect(db.deleteItem).toHaveBeenCalledWith('goal-1', 'goal');
  });

  it('undoing a custom-item delete restores via the DB slug (review blocker regression)', () => {
    store().deleteTask('goal-1');
    store().undo();
    expect(db.restoreItem).toHaveBeenCalledWith('goal-1', 'goal');
  });
});

describe('undo/redo store logic', () => {
  it('initial state has empty undo and redo stacks', () => {
    expect(store().canUndo).toBe(false);
    expect(store().canRedo).toBe(false);
    expect(store().tasks).toHaveLength(1);
    expect(store().habits).toHaveLength(1);
  });

  it('completing a task pushes a snapshot onto the undo stack', () => {
    store().toggleTaskStatus('task-1');
    expect(store().tasks[0].status).toBe('completed');
    expect(store().canUndo).toBe(true);
    expect(store().canRedo).toBe(false);
  });

  it('undo restores the previous task list snapshot', () => {
    store().toggleTaskStatus('task-1');
    store().undo();
    expect(store().tasks[0].status).toBe('pending');
    expect(store().canUndo).toBe(false);
    // and the db was patched back toward the restored snapshot
    expect(db.updateItem).toHaveBeenCalledWith('task-1', 'task', { status: 'pending' });
  });

  it('redo re-applies an undone change', () => {
    store().toggleTaskStatus('task-1');
    store().undo();
    store().redo();
    expect(store().tasks[0].status).toBe('completed');
    expect(store().canUndo).toBe(true);
    expect(store().canRedo).toBe(false);
  });

  it('new action after undo clears the redo stack', () => {
    store().toggleTaskStatus('task-1');
    store().undo();
    expect(store().canRedo).toBe(true);
    store().addTask({ title: 'Another' });
    expect(store().canRedo).toBe(false);
  });

  it('undo is a no-op when the stack is empty (no crash)', () => {
    expect(() => store().undo()).not.toThrow();
    expect(store().tasks).toHaveLength(1);
    expect(store().canUndo).toBe(false);
  });
});

describe('undo db sync (Phase 3 regression coverage)', () => {
  it('undoing a habit title edit persists the old title (pre-unification bug: habit sync was status-gated)', () => {
    store().updateHabit('habit-1', { title: 'Stretch more' });
    vi.clearAllMocks();
    store().undo();
    expect(db.updateItem).toHaveBeenCalledWith('habit-1', 'habit', { title: 'Stretch' });
  });

  it('undoing an added item soft-deletes it; redo restores it', () => {
    store().addTask({ title: 'Ephemeral' });
    const added = store().tasks.find((t) => t.title === 'Ephemeral')!;
    store().undo();
    expect(db.deleteItem).toHaveBeenCalledWith(added.id, 'task');
    store().redo();
    expect(db.restoreItem).toHaveBeenCalledWith(added.id, 'task');
  });

  it('undoing a habit completion replays per-date intents, never an absolute completedDates write', () => {
    store().toggleHabitStatus('habit-1', 'done');
    const today = [...store().habits[0].completedDates].pop()!;
    vi.clearAllMocks();
    store().undo();
    expect(db.setItemCompletion).toHaveBeenCalledWith('habit-1', 'habit', today, false, false);
    for (const call of vi.mocked(db.updateItem).mock.calls) {
      expect(Object.keys(call[2] as object)).not.toContain('completedDates');
    }
  });

  it('undoing a project rename patches the name back — it must NOT delete the row', () => {
    store().addProject('Deep Work', '📚');
    const project = store().projects.find((p) => p.name === 'Deep Work')!;
    store().updateProject(project.id, { name: 'Deeper Work' });
    vi.clearAllMocks();
    store().undo();
    expect(db.updateProject).toHaveBeenCalledWith(USER, project.id, { name: 'Deep Work' });
    expect(db.deleteProject).not.toHaveBeenCalled();
    expect(db.restoreProject).not.toHaveBeenCalled();
  });
});

describe('routines survive undo (Phase 2 review blocker regression)', () => {
  // saveToHistory hand-enumerates the snapshot fields, and `routines` was
  // missing from that list. Nothing failed loudly: applyHistoryState restored
  // the absent slice as [], and syncContainers reads "present in current,
  // absent in restored" as a DELETE — so a single Cmd+Z emptied the store's
  // routines AND soft-deleted every routine row in Supabase. The defensive
  // `?? []` I wrote in applyHistoryState is what turned a loud TypeError into
  // silent data loss, which is the real lesson.
  beforeEach(async () => {
    store().clearStore();
    vi.clearAllMocks();
    vi.mocked(db.fetchItems).mockResolvedValue(fixtures());
    vi.mocked(db.fetchRoutines).mockResolvedValue([
      { id: 'r1', name: 'Morning', itemIds: ['habit-1'] },
    ]);
    await store().initializeStore(USER);
  });

  // TWO mutations before the undo, deliberately. Undoing after ONE restores the
  // snapshot initializeStore pushed, which builds its object separately and DID
  // carry routines — so a single-mutation test passes with the bug still in
  // place. The defect lives in saveToHistory, and you only land on one of its
  // snapshots from the second mutation onward.
  it('an unrelated undo leaves routines untouched', () => {
    expect(store().routines).toHaveLength(1);
    store().toggleTaskStatus('task-1');
    store().updateTask('task-1', { title: 'Renamed' });
    store().undo();
    expect(store().routines).toHaveLength(1);
    expect(store().routines[0].itemIds).toEqual(['habit-1']);
  });

  it('an unrelated undo does NOT soft-delete the routine in the DB', () => {
    store().toggleTaskStatus('task-1');
    store().updateTask('task-1', { title: 'Renamed' });
    vi.clearAllMocks();
    store().undo();
    expect(db.deleteRoutine).not.toHaveBeenCalled();
  });

  it('undoing a routine rename restores the old name and writes it through', () => {
    store().updateRoutine('r1', { name: 'Evening' });
    expect(store().routines[0].name).toBe('Evening');
    store().undo();
    expect(store().routines[0].name).toBe('Morning');
    expect(db.updateRoutine).toHaveBeenCalledWith(
      USER, 'r1', expect.objectContaining({ name: 'Morning' }),
    );
  });

  it('undoing a routine delete restores it', () => {
    store().removeRoutine('r1');
    expect(store().routines).toHaveLength(0);
    store().undo();
    expect(store().routines).toHaveLength(1);
    expect(db.restoreRoutine).toHaveBeenCalledWith(USER, 'r1');
  });

  it('undoing a membership change reaches the join table', () => {
    store().updateRoutine('r1', { itemIds: ['habit-1', 'task-1'] });
    store().undo();
    expect(store().routines[0].itemIds).toEqual(['habit-1']);
    expect(db.updateRoutine).toHaveBeenCalledWith(
      USER, 'r1', expect.objectContaining({ itemIds: ['habit-1'] }),
    );
  });
});

describe('type switch (edit pane type chip)', () => {
  it('switches a habit to a task in place, keeping the id and history', async () => {
    store().changeItemType('habit-1', 'task');
    const item = store().items.find((i) => i.id === 'habit-1')!;
    expect(item.type).toBe('task');
    expect(store().habits).toHaveLength(0);
    expect(store().tasks.map((t) => t.id)).toContain('habit-1');
    await vi.waitFor(() => expect(db.changeItemType).toHaveBeenCalledWith(
      'habit-1', 'habit', expect.objectContaining({ type: 'task', repeatFrequency: 'daily' }), USER,
    ));
  });

  it('undo switches it back — it must NOT soft-delete the item', async () => {
    store().changeItemType('habit-1', 'task');
    await vi.waitFor(() => expect(db.changeItemType).toHaveBeenCalledTimes(1));
    vi.mocked(db.changeItemType).mockClear();
    store().undo();
    const item = store().items.find((i) => i.id === 'habit-1')!;
    expect(item.type).toBe('habit');
    expect(item).toMatchObject({ streak: 2, project: 'Wellness' });
    await vi.waitFor(() => expect(db.changeItemType).toHaveBeenCalledWith(
      'habit-1', 'task', expect.objectContaining({ type: 'habit', streak: 2 }), USER,
    ));
    expect(db.deleteItem).not.toHaveBeenCalled();
    expect(db.restoreItem).not.toHaveBeenCalled();
  });

  it('a one-off task becomes a habit with the repeat it was given', () => {
    store().changeItemType('task-1', 'habit', { repeat: 'weekdays' });
    const item = store().items.find((i) => i.id === 'task-1')!;
    expect(item).toMatchObject({ type: 'habit', repeatFrequency: 'weekdays', streak: 0, project: 'Personal' });
  });

  it('refuses a switch the item cannot take (a task with subtasks → habit)', async () => {
    store().clearStore();
    vi.mocked(db.fetchItems).mockResolvedValue([
      ...fixtures(),
      { type: 'task', id: 'sub-1', title: 'Step', status: 'pending', isScheduled: false, order: 1, completedDates: [], parentItemId: 'task-1' },
    ]);
    await store().initializeStore(USER);
    vi.mocked(db.changeItemType).mockClear();
    store().changeItemType('task-1', 'habit');
    await Promise.resolve();
    expect(store().items.find((i) => i.id === 'task-1')!.type).toBe('task');
    expect(db.changeItemType).not.toHaveBeenCalled();
  });

  it('an undo pressed before the switch lands waits for it (one switch at a time)', async () => {
    let land!: () => void;
    vi.mocked(db.changeItemType).mockImplementationOnce(() => new Promise<void>((r) => { land = r; }));
    store().changeItemType('habit-1', 'task');
    store().undo();
    await vi.waitFor(() => expect(db.changeItemType).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(db.changeItemType).toHaveBeenCalledTimes(1);
    land();
    await vi.waitFor(() => expect(db.changeItemType).toHaveBeenCalledTimes(2));
    expect(vi.mocked(db.changeItemType).mock.calls[1].slice(0, 2)).toEqual(['habit-1', 'task']);
  });
});
