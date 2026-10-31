import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Filing by drag onto an Atlas card (design 4.2, lib/atlas-file.ts), against
 * the REAL planner store and its history subscriber: a braindump row files
 * into each kind through the bulk verbs, stays in the braindump, and one Undo
 * takes it back; a row moved between two routines is one undo; another kind
 * adds; a goal's milestone refuses the move; the registry decides who may
 * join; already there writes nothing.
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
    updateItem: vi.fn(async () => {}),
    updateGoal: vi.fn(async () => {}),
    updateRoutine: vi.fn(async () => {}),
    updateSeason: vi.fn(async () => {}),
    recordCheckin: vi.fn(),
  };
});
vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/completion-confetti', () => ({ celebrateCompletion: vi.fn() }));

import { getActionLog, usePlannerStore } from '@/lib/planner-store';
import * as db from '@/lib/db';
import { fileIntoContainer, planFiling, containerMemberIds } from '@/lib/atlas-file';
import { isToastWorthy } from '@/hooks/use-undo-toast';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import type { Goal, Item, Project, Routine, Season } from '@/lib/planner-types';
import { TODAY, goal, habit, project, routine, season, task } from './helpers/atlas-fixtures';

const USER = 'user-1';
const store = () => usePlannerStore.getState();

async function load(
  items: Item[],
  { projects = [], routines = [], seasons = [], goals = [] }: { projects?: Project[]; routines?: Routine[]; seasons?: Season[]; goals?: Goal[] } = {},
) {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(items);
  vi.mocked(db.fetchProjects).mockResolvedValue(projects);
  vi.mocked(db.fetchRoutines).mockResolvedValue(routines);
  vi.mocked(db.fetchSeasons).mockResolvedValue(seasons);
  vi.mocked(db.fetchGoals).mockResolvedValue(goals);
  await store().initializeStore(USER);
  usePlannerStore.setState({ selectedDate: new Date(`${TODAY}T12:00:00Z`), userTimezone: 'UTC' });
}

const lastAction = () => getActionLog()[0];
const itemOf = (id: string) => store().items.find((i) => i.id === id) as unknown as { project?: string; isScheduled?: boolean };
const WORK = project('Work');
const HOME = project('Home');

describe('a braindump row onto a card', () => {
  beforeEach(() =>
    load([task({ id: 'a', title: 'Call the bank' }), habit({ id: 'h', title: 'Stretch' })], {
      projects: [WORK],
      routines: [routine('r1', [])],
      seasons: [season('s1')],
      goals: [goal('g1')],
    }),
  );

  it('a project card sets the project, keeps it in the braindump, and one undo reverts', () => {
    const before = store().items.length;
    expect(fileIntoContainer(['a'], { kind: 'project', id: WORK.id })).toEqual({ wrote: true });
    expect(itemOf('a').project).toBe('Work');
    // Still unscheduled: braindump means no day, and filing gives none.
    expect(itemOf('a').isScheduled).toBeFalsy();
    expect(store().items.length).toBe(before);
    expect(lastAction().label).toBe(ATLAS_COPY.filedFromBraindump('Work'));
    expect(isToastWorthy(lastAction())).toBe(true);
    store().undo();
    expect(itemOf('a').project).toBeUndefined();
  });

  it('a routine card collects it', () => {
    fileIntoContainer(['a'], { kind: 'routine', id: 'r1' });
    expect(store().routines[0].itemIds).toEqual(['a']);
    store().undo();
    expect(store().routines[0].itemIds).toEqual([]);
  });

  it('a season card collects it', () => {
    fileIntoContainer(['h'], { kind: 'season', id: 's1' });
    expect(store().seasons[0].itemIds).toEqual(['h']);
  });

  it('a goal card adds a plain member', () => {
    fileIntoContainer(['a'], { kind: 'goal', id: 'g1' });
    expect(store().goals[0]).toMatchObject({ memberIds: ['a'], milestoneIds: [], checkinIds: [] });
  });

  it('a group files every member in one entry', () => {
    fileIntoContainer(['a', 'h'], { kind: 'routine', id: 'r1' });
    expect(store().routines[0].itemIds).toEqual(['a', 'h']);
    expect(lastAction().label).toBe(ATLAS_COPY.filedMany(2, 'r1'));
    store().undo();
    expect(store().routines[0].itemIds).toEqual([]);
  });

  it('already there writes nothing and arms no undo', () => {
    fileIntoContainer(['a'], { kind: 'routine', id: 'r1' });
    const entries = getActionLog().length;
    expect(fileIntoContainer(['a'], { kind: 'routine', id: 'r1' })).toEqual({ wrote: false });
    expect(getActionLog().length).toBe(entries);
  });

  it('writes nothing while the planner previews', () => {
    usePlannerStore.setState({ isPreview: true } as never);
    expect(fileIntoContainer(['a'], { kind: 'routine', id: 'r1' })).toEqual({ wrote: false });
    expect(store().routines[0].itemIds).toEqual([]);
    usePlannerStore.setState({ isPreview: false } as never);
  });
});

describe('a row moved between cards', () => {
  beforeEach(() =>
    load([task({ id: 'a', title: 'Warm up', project: 'Work' }), task({ id: 'm', title: 'Ship it' })], {
      projects: [WORK, HOME],
      routines: [routine('r1', ['a'], { name: 'Morning' }), routine('r2', [], { name: 'Evening' })],
      goals: [goal('g1', { memberIds: ['a'], milestoneIds: ['m'] }), goal('g2', { name: 'Run' })],
    }),
  );

  it('routine to routine moves it, as one undo', () => {
    const entries = getActionLog().length;
    const out = fileIntoContainer(['a'], { kind: 'routine', id: 'r2' }, { kind: 'routine', id: 'r1' });
    expect(out.wrote).toBe(true);
    expect(store().routines.find((r) => r.id === 'r1')!.itemIds).toEqual([]);
    expect(store().routines.find((r) => r.id === 'r2')!.itemIds).toEqual(['a']);
    expect(getActionLog().length).toBe(entries + 1);
    expect(lastAction().label).toBe(ATLAS_COPY.movedRow('Warm up', 'Evening'));
    store().undo();
    expect(store().routines.find((r) => r.id === 'r1')!.itemIds).toEqual(['a']);
    expect(store().routines.find((r) => r.id === 'r2')!.itemIds).toEqual([]);
  });

  it('project to project re-files (one classify value)', () => {
    fileIntoContainer(['a'], { kind: 'project', id: HOME.id }, { kind: 'project', id: WORK.id });
    expect(itemOf('a').project).toBe('Home');
    expect(lastAction().label).toBe(ATLAS_COPY.movedRow('Warm up', 'Home'));
  });

  it('goal to goal moves a plain member off the source and keeps its roles elsewhere', () => {
    fileIntoContainer(['a'], { kind: 'goal', id: 'g2' }, { kind: 'goal', id: 'g1' });
    expect(store().goals.find((g) => g.id === 'g1')).toMatchObject({ memberIds: [], milestoneIds: ['m'] });
    expect(store().goals.find((g) => g.id === 'g2')!.memberIds).toEqual(['a']);
  });

  it('a milestone refuses the move, with the reason', () => {
    const entries = getActionLog().length;
    expect(fileIntoContainer(['m'], { kind: 'goal', id: 'g2' }, { kind: 'goal', id: 'g1' })).toEqual({
      wrote: false,
      message: ATLAS_COPY.milestoneMoves,
    });
    expect(getActionLog().length).toBe(entries);
  });

  it('onto another kind it adds, and the source keeps it', () => {
    fileIntoContainer(['a'], { kind: 'goal', id: 'g2' }, { kind: 'routine', id: 'r1' });
    expect(store().routines.find((r) => r.id === 'r1')!.itemIds).toEqual(['a']);
    expect(store().goals.find((g) => g.id === 'g2')!.memberIds).toEqual(['a']);
  });

  it('onto its own card it is already there', () => {
    expect(fileIntoContainer(['a'], { kind: 'routine', id: 'r1' }, { kind: 'routine', id: 'r1' })).toEqual({ wrote: false });
  });
});

describe('planFiling: the registry decides who may join', () => {
  const state = (items: Item[]) => ({
    items,
    projects: [WORK],
    routines: [routine('r1', [])],
    seasons: [],
    goals: [goal('g1')],
  });

  it('a subtask can not be collected, and says why', () => {
    const plan = planFiling(state([task({ id: 'kid', parentItemId: 'a' } as Partial<Item> & { id: string })]), ['kid'], {
      kind: 'routine',
      id: 'r1',
    });
    expect(plan).toEqual({ kind: 'refused', message: ATLAS_COPY.subtaskStays });
  });

  it('a habit may join a project (every shipped type answers with one since 039)', () => {
    // Asked through the bulk verb's own predicate, so the answer follows the
    // registry, never a task-or-habit branch.
    const habitPlan = planFiling(state([habit({ id: 'h' })]), ['h'], { kind: 'project', id: WORK.id });
    expect(habitPlan.kind).toBe('file');
  });

  it('a project counts its members by folded name', () => {
    const s = state([task({ id: 'a', project: 'work' })]);
    expect(containerMemberIds(s, { kind: 'project', id: WORK.id }).has('a')).toBe(true);
    expect(planFiling(s, ['a'], { kind: 'project', id: WORK.id })).toEqual({ kind: 'already' });
  });

  it('a trashed container is nothing at all', () => {
    expect(planFiling(state([task({ id: 'a' })]), ['a'], { kind: 'routine', id: 'gone' })).toEqual({ kind: 'none' });
  });

  it('a scheduled item is filed without the braindump line', () => {
    const plan = planFiling(state([task({ id: 'a', isScheduled: true, timeBucket: 'morning' } as Partial<Item> & { id: string })]), ['a'], {
      kind: 'goal',
      id: 'g1',
    });
    expect(plan).toMatchObject({ kind: 'file', label: ATLAS_COPY.filed('g1') });
  });
});
