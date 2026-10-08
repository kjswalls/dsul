import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * An item whose INSERT waited before leaving (a subtask added while its
 * parent's insert is still out: items_parent_item_id_fkey) must not be
 * overtaken by the writes made to it in that window. Sent first, a tick, an
 * edit or a delete matches zero rows and is lost, and the insert then writes
 * the row as it was. An insert that left at once keeps the timing it always
 * had: its writes still leave in the same tick.
 *
 * The real store on a landed planner, with each database call logged in the
 * order it is sent.
 */

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const pendingLoads: Deferred<unknown>[] = [];

vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/db');
  const mocked: Record<string, unknown> = { ...actual };
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value !== 'function' || name === 'itemDbType') continue;
    mocked[name] = vi.fn(async () => (name.startsWith('fetch') ? [] : undefined));
  }
  mocked.loadPlannerData = vi.fn(() => {
    const d = deferred<unknown>();
    pendingLoads.push(d);
    return d.promise;
  });
  return mocked;
});
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/planner-snapshot', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/planner-snapshot');
  return { ...actual, readPlannerSnapshot: vi.fn(async () => null), markPreviewPending: vi.fn() };
});

import * as db from '@/lib/db';
import { usePlannerStore } from '@/lib/planner-store';
import { __resetHeldCapturesForTests } from '@/lib/held-captures';
import type { Item } from '@/lib/planner-types';

const A = 'user-a';
const store = () => usePlannerStore.getState();
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** Every database call, in the order sent, with ids replaced by titles. */
const log: string[] = [];
const titles = new Map<string, string>();
const name = (id: string) => titles.get(id) ?? id;

let parentInsert: Deferred<void>;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  store().clearStore();
  __resetHeldCapturesForTests();
  pendingLoads.length = 0;
  log.length = 0;
  titles.clear();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  store().identifyUser(A);
  const loading = store().initializeStore(A);
  pendingLoads.shift()!.resolve({ items: [], projects: [], itemTypes: [], routines: [], seasons: [], goals: [] });
  await loading;
  await flush();

  parentInsert = deferred<void>();
  vi.mocked(db.createItem).mockImplementation(async (_userId, item: Item) => {
    titles.set(item.id, item.title);
    log.push(`insert ${item.title}`);
    // The parent's insert is slow: a mobile link, or a cold database.
    if (item.title === 'Parent') return parentInsert.promise;
  });
  vi.mocked(db.createItems).mockImplementation(async (_userId, items: Item[]) => {
    for (const item of items) titles.set(item.id, item.title);
    log.push(`insert ${items.map((i) => i.title).join(' + ')}`);
  });
  vi.mocked(db.updateItem).mockImplementation(async (id: string, _type: string, patch: Record<string, unknown>) => {
    log.push(`update ${name(id)} ${JSON.stringify(patch)}`);
  });
  vi.mocked(db.deleteItem).mockImplementation(async (id: string) => {
    log.push(`delete ${name(id)}`);
  });
  vi.mocked(db.setItemCompletion).mockImplementation(async (id: string, _type: string, date: string, done: boolean) => {
    log.push(`${done ? 'complete' : 'uncomplete'} ${name(id)} ${date}`);
  });
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('writes to an item whose insert waited on its parent\'s', () => {
  it('sends a tick and a delete of a new subtask after its insert, not before', async () => {
    const parentId = store().addTask({ title: 'Parent' });
    const subId = store().addTask({ title: 'Sub', parentItemId: parentId });
    titles.set(subId, 'Sub');
    // The subtask panel's checkbox, then its X, both before the parent's insert answers.
    store().toggleTaskStatus(subId);
    store().deleteTask(subId);
    await flush();
    // Before: ['insert Parent', 'update Sub …', 'delete Sub'], and then the
    // insert wrote Sub live and pending.
    expect(log).toEqual(['insert Parent']);

    parentInsert.resolve();
    await flush();
    expect(log).toEqual(['insert Parent', 'insert Sub', 'update Sub {"status":"completed"}', 'delete Sub']);
  });

  it('deletes a new subtask with its parent only after the subtask\'s insert', async () => {
    const parentId = store().addTask({ title: 'Parent' });
    const subId = store().addTask({ title: 'Sub', parentItemId: parentId });
    titles.set(subId, 'Sub');
    store().deleteTask(parentId);
    await flush();
    expect(log).toEqual(['insert Parent', 'delete Parent']);

    parentInsert.resolve();
    await flush();
    // Before: 'delete Sub' went out ahead of 'insert Sub', leaving a live
    // subtask under a parent in the bin.
    expect(log).toEqual(['insert Parent', 'delete Parent', 'insert Sub', 'delete Sub']);
  });

  it('ticks a recurring subtask after its insert', async () => {
    const parentId = store().addTask({ title: 'Parent' });
    const subId = store().addTask({ title: 'Sub', parentItemId: parentId, repeatFrequency: 'daily' });
    titles.set(subId, 'Sub');
    store().toggleTaskStatus(subId, undefined, new Date('2026-10-07T12:00:00'));
    await flush();
    expect(log).toEqual(['insert Parent']);

    parentInsert.resolve();
    await flush();
    expect(log).toEqual(['insert Parent', 'insert Sub', 'complete Sub 2026-10-07']);
  });

  it('sends subtasks added while their parent\'s insert is out in the order added', async () => {
    const parentId = store().addTask({ title: 'Parent' });
    const first = deferred<void>();
    const insert = vi.mocked(db.createItem).getMockImplementation()!;
    vi.mocked(db.createItem).mockImplementation(async (userId, item: Item) => {
      await insert(userId, item);
      if (item.title === 'First') return first.promise;
    });
    store().addTask({ title: 'First', parentItemId: parentId });
    store().addTask({ title: 'Second', parentItemId: parentId });
    parentInsert.resolve();
    await flush();
    // They share an order, so created_at sorts them: before, both left in one tick.
    expect(log).toEqual(['insert Parent', 'insert First']);

    first.resolve();
    await flush();
    expect(log).toEqual(['insert Parent', 'insert First', 'insert Second']);
  });

  it('sends a write at once when the insert left at once, as it always did', async () => {
    const id = store().addTask({ title: 'Ordinary' });
    store().toggleTaskStatus(id);
    // Same tick, no wait on the insert's answer.
    expect(log).toEqual(['insert Ordinary', 'update Ordinary {"status":"completed"}']);
  });
});

describe('a subtask paste while its parent\'s insert is out', () => {
  it('waits for the parent\'s insert, and a tick on a pasted row waits for the paste\'s', async () => {
    const parentId = store().addTask({ title: 'Parent' });
    store().addTasksBulk('task', [
      { title: 'S1', parentItemId: parentId },
      { title: 'S2', parentItemId: parentId },
    ]);
    const s1 = store().items.find((i) => i.title === 'S1')!.id;
    titles.set(s1, 'S1');
    store().toggleTaskStatus(s1);
    await flush();
    // Before: the paste's one insert left at once and failed the parent key
    // (23503) whole, while the planner kept showing both rows.
    expect(log).toEqual(['insert Parent']);

    parentInsert.resolve();
    await flush();
    expect(log).toEqual(['insert Parent', 'insert S1 + S2', 'update S1 {"status":"completed"}']);
  });

  it('is undone only after its insert has landed', async () => {
    const parentId = store().addTask({ title: 'Parent' });
    store().addTasksBulk('task', [
      { title: 'S1', parentItemId: parentId },
      { title: 'S2', parentItemId: parentId },
    ]);
    store().undo();
    await flush();
    expect(log).toEqual(['insert Parent']);

    parentInsert.resolve();
    await flush();
    expect(log).toEqual(['insert Parent', 'insert S1 + S2', 'delete S1', 'delete S2']);
  });
});
