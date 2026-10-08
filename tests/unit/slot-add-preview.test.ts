import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Adding from the planner canvas (lib/slot-add.ts, #432) against the look-only
 * preview (memory/plans/instant-planner.md, "Main's features during the
 * preview"), through the REAL planner store.
 *
 * The canvas is `inert` while previewing, so no slot, add row or week-strip +
 * can be pressed; addAt is refused underneath all the same, because every
 * insert it makes is one of the store's own creates (addTask, addHabit,
 * addItem), which the write barrier refuses. Once the planner is real, those
 * creates are the store's insert chokepoint: the row is tracked in flight
 * like every other add (awaitItemCreates), so a write that must wait for it can.
 */

const created = vi.hoisted(() => ({ release: [] as Array<() => void> }));

vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/db');
  const mocked: Record<string, unknown> = { ...actual };
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value !== 'function' || name === 'itemDbType') continue;
    mocked[name] = vi.fn(async () => (name.startsWith('fetch') ? [] : undefined));
  }
  // An insert that lands only when the test says so.
  mocked.createItem = vi.fn(() => new Promise<void>((resolve) => created.release.push(resolve)));
  mocked.loadPlannerData = vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable());
  return mocked;
});
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import * as db from '@/lib/db';
import { awaitItemCreates, usePlannerStore } from '@/lib/planner-store';
import { hydrateCustomTypes } from '@/lib/item-registry';
import { addAt, type SlotTarget } from '@/lib/slot-add';
import { useUIStore } from '@/lib/ui-store';
import type { Item, ItemTypeDef } from '@/lib/planner-types';

const USER = 'user-1';
const DAY = '2026-10-08';
const ERRAND: ItemTypeDef = { id: 'type-errand', name: 'errand', label: 'Errand', labelPlural: 'Errands' };

const store = () => usePlannerStore.getState();
const grid: SlotTarget = { kind: 'grid', scope: `grid:day:${DAY}`, dateStr: DAY, startMin: 9 * 60, duration: 30 };
const row: SlotTarget = { kind: 'row', scope: `row:anytime:${DAY}`, dateStr: DAY, bucket: 'anytime' };

const cached = (): Item[] => [
  { type: 'task', id: 'cached-1', title: 'Cached', status: 'pending', isScheduled: false, order: 0, completedDates: [] } as Item,
];

const dbWrites = () =>
  Object.entries(db).filter(
    ([name, value]) => typeof value === 'function' && vi.isMockFunction(value) && !name.startsWith('fetch') && name !== 'loadPlannerData'
  ) as Array<[string, ReturnType<typeof vi.fn>]>;

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  store().clearStore();
  vi.mocked(db.fetchItemTypes).mockResolvedValueOnce([ERRAND]);
  store().identifyUser(USER);
  await store().initializeStore(USER);
  hydrateCustomTypes([ERRAND]);
  vi.clearAllMocks();
  created.release = [];
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  usePlannerStore.setState({ isPreview: false, isLoading: false });
  for (const release of created.release) release();
});

describe('a canvas add while the planner is the look-only preview', () => {
  it('makes nothing, of any type, and writes nothing', () => {
    usePlannerStore.setState({ isPreview: true, isLoading: true, items: cached() });
    const before = store();
    expect(addAt(grid, 'task', 'Call the bank')).toBeFalsy();
    expect(addAt(row, 'habit', 'Stretch')).toBeFalsy();
    expect(addAt(grid, 'errand', 'Post office')).toBeFalsy();
    // Not one set(): the state object is the very same reference.
    expect(store()).toBe(before);
    for (const [name, spy] of dbWrites()) expect(spy, name).not.toHaveBeenCalled();
    // ⇧↵ opens what was made; with nothing made, nothing is opened or deferred.
    expect(useUIStore.getState().activeDialog).toBeNull();
    expect(useUIStore.getState().deferredDialog).toBeNull();
  });
});

describe('a canvas add once the planner is real', () => {
  it.each([
    ['task', grid],
    ['habit', row],
    ['errand', grid],
  ] as const)('puts a %s on the store and tracks its insert in flight, as every add is', async (type, target) => {
    const id = addAt(target, type, `New ${type}`);
    expect(id).toBeTruthy();
    expect(store().items.some((i) => i.id === id)).toBe(true);
    expect(db.createItem).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.createItem).mock.calls[0][1]).toMatchObject({ id, title: `New ${type}` });

    // The store's create chokepoint (sendItemCreate): a write that must wait
    // for this insert finds it in flight until it lands.
    let landed = false;
    void awaitItemCreates([id!]).then(() => (landed = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(landed).toBe(false);
    created.release.shift()!();
    await vi.waitFor(() => expect(landed).toBe(true));
  });
});
