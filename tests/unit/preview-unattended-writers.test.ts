import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

/**
 * The writers nobody presses stay shut through the look-only preview.
 *
 * The auto-age sweep, completion filing and the first-run seed act on what the
 * planner holds, unattended. While it holds the LAST session's rows (the
 * preview, lib/planner-snapshot.ts) any of them would decide on a cache: the
 * sweep would unschedule cached rows, filing would date them, the seed would
 * judge the account from them. They stay shut with no edit of their own only
 * because `isLoading` stays true for the whole preview (design D1), so this
 * pins it: a future gate on `usePlannerVisible()` or on `items.length` would
 * open them, and every other unit test would still pass.
 *
 * A real preview, applied by initializeStore with the snapshot read mocked;
 * the hooks themselves, rendered; then the landing, where each runs as usual.
 */

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
import { readPlannerSnapshot, type PlannerSnapshotData } from '@/lib/planner-snapshot';
import { usePlannerStore } from '@/lib/planner-store';
import { useMorningStore } from '@/lib/morning-store';
import { useOverdueSweep } from '@/hooks/use-overdue-sweep';
import { useCompletionFiling } from '@/hooks/use-completion-filing';
import { runFirstRunSeed, type SeedDeps } from '@/lib/seed-containers';
import { toDateStr } from '@/lib/recurrence';
import type { Item } from '@/lib/planner-types';

const A = 'user-a';
const TZ = 'UTC';
const daysAgo = (n: number) => toDateStr(new Date(Date.now() - n * 86_400_000), TZ);

/** Past due by sixty days: the sweep's to unschedule once loaded. */
const stale = (): Item =>
  ({
    type: 'task', id: 't-stale', title: 'Long overdue', status: 'pending', isScheduled: true,
    startDate: daysAgo(60), timeBucket: 'morning', order: 0, completedDates: [],
  }) as Item;
/** Finished three days ago, still in the braindump: filing's to date once loaded. */
const finished = (): Item =>
  ({ type: 'task', id: 't-done', title: 'Done already', status: 'completed', isScheduled: false, order: 1, completedDates: [] }) as Item;

const rows = () => ({ items: [stale(), finished()], projects: [], itemTypes: [], routines: [], seasons: [], goals: [] });
const CACHED = (): PlannerSnapshotData => ({
  ...rows(),
  itemTypesAvailable: true,
  collectionsAvailable: true,
  goalsAvailable: true,
});

const store = () => usePlannerStore.getState();
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function seedDeps(): SeedDeps & { markSeeded: ReturnType<typeof vi.fn>; commit: ReturnType<typeof vi.fn> } {
  return {
    hasSeeded: vi.fn(async () => false),
    markSeeded: vi.fn(async () => {}),
    trashedNames: vi.fn(async () => ({ projects: [] })),
    snapshot: () => store(),
    commit: vi.fn((plan, forUserId) => store().seedStarterContainers(plan, forUserId)),
  };
}

let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  store().clearStore();
  pendingLoads.length = 0;
  vi.clearAllMocks();
  vi.mocked(readPlannerSnapshot).mockImplementation(async () => CACHED());
  vi.mocked(db.fetchCompletedAt).mockImplementation(
    async () => new Map([['t-done', new Date(Date.now() - 3 * 86_400_000).toISOString()]])
  );
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
  useMorningStore.setState({
    morningCheckEnabled: true,
    morningAutoAgeEnabled: true,
    morningAutoAgeDays: 30,
    settingsHydratedUserId: A,
    morningAutoAgeLastRunByUser: {},
  });
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  cleanup();
  while (pendingLoads.length) pendingLoads.shift()!.resolve(rows());
  await flush();
  consoleWarn.mockRestore();
});

/**
 * Account A previewing its cached planner, with its settings and zone already
 * hydrated. The load comes back WRAPPED: an async function returning the bare
 * promise would make the caller's await wait for the landing.
 */
async function previewing(): Promise<{ loading: Promise<void> }> {
  store().identifyUser(A);
  const loading = store().initializeStore(A, { preview: () => true });
  usePlannerStore.setState({ userTimezone: TZ });
  await flush();
  expect(store().isPreview).toBe(true);
  expect(store().isLoading).toBe(true);
  return { loading };
}

describe('unattended writers while the planner is a look-only preview', () => {
  it('the auto-age sweep and completion filing do nothing until fresh data lands, then run', async () => {
    const { loading } = await previewing();
    renderHook(() => {
      useOverdueSweep();
      useCompletionFiling();
    });
    await act(flush);

    // The cached rows are exactly what each would act on, and neither did.
    expect(store().items.find((i) => i.id === 't-stale')).toMatchObject({ startDate: daysAgo(60) });
    expect(useMorningStore.getState().getAutoAgeLastRunDate(A)).toBeFalsy();
    expect(vi.mocked(db.fetchCompletedAt)).not.toHaveBeenCalled();
    expect(vi.mocked(db.updateItem)).not.toHaveBeenCalled();
    expect(store().canUndo).toBe(false);

    await act(async () => {
      pendingLoads.shift()!.resolve(rows());
      await loading;
      await flush();
    });

    // Landed: the same rows, now fresh, and both run as they always have.
    expect(store().isPreview).toBe(false);
    expect(store().items.find((i) => i.id === 't-stale')).not.toHaveProperty('startDate', daysAgo(60));
    expect(useMorningStore.getState().getAutoAgeLastRunDate(A)).toBe(toDateStr(new Date(), TZ));
    expect(vi.mocked(db.fetchCompletedAt)).toHaveBeenCalledWith(['t-done']);
  });

  it('the first-run seed reads the preview as a load still in flight, then decides on the landing', async () => {
    const { loading } = await previewing();

    const during = seedDeps();
    expect(await runFirstRunSeed(A, during)).toBe('none');
    expect(during.commit).not.toHaveBeenCalled();
    expect(during.markSeeded).not.toHaveBeenCalled();
    // And the commit refuses on its own, should anything reach it.
    expect(store().seedStarterContainers({ reason: 'new-account', projects: [{ name: 'Work', emoji: '' }] }, A)).toBe(
      'refused'
    );
    expect(vi.mocked(db.createProject)).not.toHaveBeenCalled();

    pendingLoads.shift()!.resolve(rows());
    await loading;
    await flush();

    const after = seedDeps();
    // Items, no containers, nothing named: adopt nothing, and latch.
    expect(await runFirstRunSeed(A, after)).toBe('adopt');
    expect(after.commit).toHaveBeenCalledTimes(1);
    expect(after.markSeeded).toHaveBeenCalledWith(A);
  });
});
