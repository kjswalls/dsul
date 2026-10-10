import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * The web's project writes: the bulk Move to project (setItemsProject), the
 * item panel's save (commitEdit) through the real store, and updateTask's
 * bucket auto-correct that a time edit passes through.
 *
 * Written against the store and the dialog as they stood before lib/item-edit.ts
 * took over setItemsProject's rule (projectRefilePatch), and kept unedited
 * across that move. One expectation then changed on purpose (Q6 of the 2f
 * brief): the dialog's project change takes a parked task out of its old
 * project's block, as the bulk path does, and the last block shows that its
 * write is the bulk path's (edit-writes.json) wherever both write. Each case compares `Object.entries` of the one
 * db.updateItem payload, so the key order is pinned as well as the keys: a key
 * written as undefined and a key left out are told apart, since lib/db.ts
 * writes the one as NULL and leaves the other alone. That is what the
 * iPhone's `project` action restates on the server, so a change here is a
 * change to what the phone must write.
 *
 * item-repeat-edit.test.ts's harness: the db layer mocked, the REAL store and
 * its history subscriber driven, with projects loaded through fetchProjects.
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
    // No RPC: the per-table fallback, started synchronously (the fetchers above).
    loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
    createItem: vi.fn(async () => {}),
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

import { getActionLog, usePlannerStore, type ActionLogEntry } from '@/lib/planner-store';
import * as db from '@/lib/db';
import { DRAFT_KEYS, commitEdit, draftFromItem, type ItemDraft } from '@/components/planner/item-dialog';
import type { Item, Project } from '@/lib/planner-types';

const USER = 'user-1';
const TODAY = '2026-10-01';

const task = (id: string, title: string, over: Record<string, unknown> = {}): Item =>
  ({ type: 'task', id, title, status: 'pending', isScheduled: true, order: 0, ...over }) as Item;

const habit = (id: string, title: string, over: Record<string, unknown> = {}): Item =>
  ({
    type: 'habit',
    id,
    title,
    streak: 0,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
    ...over,
  }) as Item;

const project = (id: string, name: string): Project => ({ id, name }) as Project;
const PROJECTS = [project('p-work', 'Work'), project('p-health', 'Health')];

/**
 * A task parked in Health's block (moveTasksToProjectBlock): the block's day
 * and part of day, no time of its own, and its own slot stashed.
 */
const parked = (id: string) =>
  task(id, 'Review PRs', {
    project: 'Health',
    projectId: 'p-health',
    startDate: TODAY,
    timeBucket: 'morning',
    inProjectBlock: true,
    previousStartTime: '14:00',
    previousStartDate: '2026-09-30',
  });

/** The release moveTaskOutOfProjectBlock writes, in its order. */
const RELEASE = [
  ['inProjectBlock', false],
  ['startTime', '14:00'],
  ['startDate', '2026-09-30'],
  ['previousStartTime', undefined],
  ['previousStartDate', undefined],
];

const store = () => usePlannerStore.getState();
const item = (id: string) => store().items.find((i) => i.id === id)!;

async function load(items: Item[], projects: Project[] = PROJECTS) {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(structuredClone(items));
  vi.mocked(db.fetchProjects).mockResolvedValue(structuredClone(projects));
  await store().initializeStore(USER);
  // View state, not history state: sets the day the verbs resolve against.
  usePlannerStore.setState({ selectedDate: new Date(`${TODAY}T12:00:00Z`), userTimezone: 'UTC' });
  vi.mocked(db.updateItem).mockClear();
}

type Write = [id: string, type: string, payload: Record<string, unknown>];

/**
 * Every db.updateItem call `act` made, in order, and the history entries it
 * added, oldest first.
 */
function record(act: () => void): { writes: Write[]; entries: ActionLogEntry[]; labels: string[] } {
  const before = getActionLog().length;
  vi.mocked(db.updateItem).mockClear();
  act();
  const writes = vi.mocked(db.updateItem).mock.calls.map(
    ([id, type, payload]) => [id, type, payload as Record<string, unknown>] as Write,
  );
  const entries = getActionLog()
    .slice(0, getActionLog().length - before)
    .reverse();
  return { writes, entries, labels: entries.map((e) => e.label) };
}

/** Undo `n` times; the item is then as it was before the act. */
function undoAll(n: number) {
  for (let k = 0; k < n; k++) store().undo();
}

/**
 * The item panel's save, as scheduleSave and flush call it: the draft seeded
 * from the item (draftFromItem), `change` applied as the chip applies it, the
 * DRAFT_KEYS that moved from the seed, then commitEdit with them. A pick of the
 * name already shown moves no key, and saves nothing.
 */
function save(id: string, change: Partial<ItemDraft>) {
  const live = item(id);
  const prev = draftFromItem(live);
  const next: ItemDraft = { ...prev, ...change };
  const keys = DRAFT_KEYS.filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
  return { keys, ...record(() => commitEdit(live, next, keys)) };
}

/** The modal's whole save: the same draft, committed with every DRAFT_KEY. */
function saveAll(id: string, change: Partial<ItemDraft>) {
  const live = item(id);
  const next: ItemDraft = { ...draftFromItem(live), ...change };
  return record(() => commitEdit(live, next, DRAFT_KEYS));
}

describe('setItemsProject’s patch, key by key', () => {
  it('a task moved from Health to Work: the name, then the id', async () => {
    await load([task('t', 'Groceries', { project: 'Health', projectId: 'p-health', startDate: TODAY, timeBucket: 'anytime' })]);
    const { writes, labels } = record(() => store().setItemsProject(['t'], 'Work'));
    expect(writes).toHaveLength(1);
    expect(writes[0].slice(0, 2)).toEqual(['t', 'task']);
    expect(Object.entries(writes[0][2])).toEqual([
      ['project', 'Work'],
      ['projectId', 'p-work'],
    ]);
    expect(labels).toEqual(['Set project: Work · 1 item']);
  });

  it('a parked task moved to Work: the name, the id, then the release', async () => {
    await load([parked('t')]);
    const { writes } = record(() => store().setItemsProject(['t'], 'Work'));
    expect(writes).toHaveLength(1);
    expect(Object.entries(writes[0][2])).toEqual([['project', 'Work'], ['projectId', 'p-work'], ...RELEASE]);
  });

  it('the same parked task cleared: both undefined, then the release', async () => {
    await load([parked('t')]);
    const { writes, labels } = record(() => store().setItemsProject(['t'], undefined));
    expect(writes).toHaveLength(1);
    expect(Object.entries(writes[0][2])).toEqual([['project', undefined], ['projectId', undefined], ...RELEASE]);
    expect(labels).toEqual(['Clear project · 1 item']);
  });
});

describe('commitEdit’s project on the real store', () => {
  it('a task in Health moved to Work: one write, one Edit entry, one undo', async () => {
    await load([task('t', 'Groceries', { project: 'Health', projectId: 'p-health', startDate: TODAY, timeBucket: 'anytime' })]);
    const before = structuredClone(item('t'));
    const { keys, writes, labels } = save('t', { container: 'Work' });
    expect(keys).toEqual(['container']);
    expect(writes).toHaveLength(1);
    expect(writes[0].slice(0, 2)).toEqual(['t', 'task']);
    expect(Object.entries(writes[0][2])).toEqual([
      ['project', 'Work'],
      ['projectId', 'p-work'],
    ]);
    expect(labels).toEqual(['Edit task: Groceries']);
    expect(item('t')).toMatchObject({ project: 'Work', projectId: 'p-work' });
    undoAll(1);
    expect(item('t')).toEqual(before);
    expect(item('t')).toMatchObject({ project: 'Health', projectId: 'p-health' });
  });

  it('a habit cleared: the name and the id both undefined', async () => {
    await load([habit('h', 'Water the plants', { project: 'Health', projectId: 'p-health' })]);
    const { keys, writes, labels } = save('h', { container: 'none' });
    expect(keys).toEqual(['container']);
    expect(writes).toHaveLength(1);
    expect(writes[0].slice(0, 2)).toEqual(['h', 'habit']);
    expect(Object.entries(writes[0][2])).toEqual([
      ['project', undefined],
      ['projectId', undefined],
    ]);
    expect(labels).toEqual(['Edit habit: Water the plants']);
  });

  it('the parked task moved to Work: out of the block, in the same write, and one undo parks it again', async () => {
    // Q6: the dialog releases it as the bulk Move to project does (projectBlockRelease). The keys
    // in the order updateTask leaves them: the release merged after the mapper's `project`, then
    // the id updateTask resolves. No timeBucket: the release keeps the block's part of day.
    await load([parked('t')]);
    const before = structuredClone(item('t'));
    const { keys, writes, labels } = save('t', { container: 'Work' });
    expect(keys).toEqual(['container']);
    expect(writes).toHaveLength(1);
    expect(Object.entries(writes[0][2])).toEqual([['project', 'Work'], ...RELEASE, ['projectId', 'p-work']]);
    expect(labels).toEqual(['Edit task: Review PRs']);
    const released = {
      project: 'Work',
      projectId: 'p-work',
      inProjectBlock: false,
      startTime: '14:00',
      startDate: '2026-09-30',
      timeBucket: 'morning',
    };
    expect(item('t')).toMatchObject(released);
    expect((item('t') as { previousStartTime?: string }).previousStartTime).toBeUndefined();
    expect((item('t') as { previousStartDate?: string }).previousStartDate).toBeUndefined();
    undoAll(1);
    expect(item('t')).toEqual(before);

    // The modal's whole save releases it the same way: its day and time are the live item's, so
    // the stash wins over them. (It also writes every other draft key, a default length among
    // them, as it always has.)
    await load([parked('t')]);
    const all = saveAll('t', { container: 'Work' });
    expect(all.writes).toHaveLength(1);
    expect(all.writes[0][2]).not.toHaveProperty('timeBucket');
    expect(all.labels).toEqual(['Edit task: Review PRs']);
    expect(item('t')).toMatchObject(released);
    expect((item('t') as { previousStartTime?: string }).previousStartTime).toBeUndefined();
    expect((item('t') as { previousStartDate?: string }).previousStartDate).toBeUndefined();
  });

  it('a day this save moved itself wins over the stash', async () => {
    await load([parked('t')]);
    const { writes } = saveAll('t', { container: 'Work', startDate: new Date(2026, 9, 5) });
    expect(writes[0][2]).toMatchObject({ inProjectBlock: false, startTime: '14:00', startDate: '2026-10-05' });
    expect(item('t')).toMatchObject({ inProjectBlock: false, startTime: '14:00', startDate: '2026-10-05' });
  });

  it('a time this save set itself wins over the stash, and is filed where it falls, in one entry', async () => {
    // Only the stash's own time keeps the block's part of day. A time the save set is
    // auto-corrected in the first write, as before the release, so the second pass (setTime)
    // moves nothing and the save stays one history entry and one undo. 14:00 is the stash's
    // value, set by the user all the same: it is filed where it falls too, in the one entry.
    for (const time of ['14:00', '15:00']) {
      for (const commit of [save, saveAll]) {
        await load([parked('t')]);
        const before = structuredClone(item('t'));
        const { writes, labels } = commit('t', { container: 'Work', startTime: time });
        expect(writes[0][2]).toMatchObject({ inProjectBlock: false, startTime: time, timeBucket: 'afternoon' });
        // The second pass's write restates the time and files nothing anew.
        expect(writes.slice(1).map((w) => Object.entries(w[2]))).toEqual([[['startTime', time]]]);
        expect(labels).toEqual(['Edit task: Review PRs']);
        expect(item('t')).toMatchObject({
          project: 'Work',
          inProjectBlock: false,
          startTime: time,
          startDate: '2026-09-30',
          timeBucket: 'afternoon',
        });
        undoAll(1);
        expect(item('t')).toEqual(before);
      }
    }
  });
});

describe('updateTask’s bucket auto-correct', () => {
  it('a new time under another part of day files the task there', async () => {
    await load([task('t', 'Groceries', { startDate: TODAY, timeBucket: 'morning', startTime: '09:00' })]);
    const { writes } = record(() => store().updateTask('t', { startTime: '14:00' }));
    expect(writes).toHaveLength(1);
    expect(Object.entries(writes[0][2])).toEqual([
      ['startTime', '14:00'],
      ['timeBucket', 'afternoon'],
    ]);
    expect(item('t')).toMatchObject({ startTime: '14:00', timeBucket: 'afternoon' });
  });

  it('a release keeps the part of day it has, as the bulk path writes it', async () => {
    await load([parked('t')]);
    const { writes } = record(() => store().updateTask('t', { inProjectBlock: false, startTime: '14:00' }));
    expect(writes).toHaveLength(1);
    expect(Object.entries(writes[0][2])).toEqual([
      ['inProjectBlock', false],
      ['startTime', '14:00'],
    ]);
    expect(item('t')).toMatchObject({ startTime: '14:00', timeBucket: 'morning' });
  });

  it('a release with a time other than the stash’s files that time where it falls', async () => {
    await load([parked('t')]);
    const { writes } = record(() => store().updateTask('t', { inProjectBlock: false, startTime: '15:00' }));
    expect(Object.entries(writes[0][2])).toEqual([
      ['inProjectBlock', false],
      ['startTime', '15:00'],
      ['timeBucket', 'afternoon'],
    ]);
  });

  it('a release whose caller names the part of day files even the stash’s time where it falls', async () => {
    // The item dialog's mark for a time its save set itself: the live part of day beside it.
    await load([parked('t')]);
    const { writes } = record(() =>
      store().updateTask('t', { inProjectBlock: false, startTime: '14:00', timeBucket: 'morning' }),
    );
    expect(Object.entries(writes[0][2])).toEqual([
      ['inProjectBlock', false],
      ['startTime', '14:00'],
      ['timeBucket', 'afternoon'],
    ]);
  });
});

type FixtureCase = {
  name: string;
  item: Item;
  edit: { action: string; projectId?: string | null };
  refusal: string | null;
  updates: Record<string, unknown> | null;
  after: Item | null;
};
const EDIT_WRITES = JSON.parse(
  readFileSync(path.resolve(__dirname, '../fixtures/day/edit-writes.json'), 'utf8'),
) as { projects: { id: string; name: string }[]; cases: FixtureCase[] };

/** As the fixture holds a payload: a key written as undefined is a null. */
const asWritten = (updates: Record<string, unknown>) =>
  JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, v ?? null]))));

describe('the dialog writes what the bulk path writes', () => {
  /**
   * The dialog's draft holds the project's name alone, so a pick that leaves the name where it
   * was marks nothing changed and writes nothing (2f leaves that rule alone), where the bulk path
   * also repairs a stale or missing projectId. An unfiled habit seeds the draft's 'none', so No
   * project there is no change to the dialog either.
   */
  const DIALOG_NO_OP = [
    'project-same-name-stale-id',
    'project-text-only-relink',
    'project-habit-clear-unfiled',
    'project-same-name-in-block',
  ];
  const written = EDIT_WRITES.cases.filter(
    (c) => c.edit.action === 'project' && c.refusal === null && Object.keys(c.updates!).length > 0,
  );

  it('has project cases that wrote, the four no-ops among them', () => {
    expect(written.length).toBeGreaterThan(DIALOG_NO_OP.length);
    expect(written.map((c) => c.name)).toEqual(expect.arrayContaining(DIALOG_NO_OP));
  });

  for (const c of written) {
    it(c.name, async () => {
      await load([c.item], EDIT_WRITES.projects.map(({ id, name }) => project(id, name)));
      const target = EDIT_WRITES.projects.find((p) => p.id === c.edit.projectId);
      const { writes, entries } = save(c.item.id, { container: target?.name ?? 'none' });
      if (DIALOG_NO_OP.includes(c.name)) {
        expect(writes).toEqual([]);
        expect(entries).toEqual([]);
        return;
      }
      expect(writes).toHaveLength(1);
      expect(asWritten(writes[0][2])).toEqual(c.updates);
      expect(entries).toHaveLength(1);
      expect(JSON.parse(JSON.stringify(item(c.item.id)))).toEqual(c.after);
    });
  }
});
