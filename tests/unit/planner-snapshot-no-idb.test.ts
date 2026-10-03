import { describe, it, expect } from 'vitest';

import {
  clearPlannerSnapshot,
  getSnapshotEpoch,
  markPreviewPending,
  purgePlannerSnapshotDb,
  readPlannerSnapshot,
  snapshotSupported,
  warmPlannerSnapshot,
  writePlannerSnapshot,
} from '@/lib/planner-snapshot';

/**
 * lib/planner-snapshot.ts where there is no IndexedDB at all — jsdom, and so
 * every other unit suite, plus browsers that withhold it. Deliberately WITHOUT
 * `fake-indexeddb/auto` (planner-snapshot.test.ts has it): this file is the
 * proof that importing the module, and every call into it, is inert here.
 */

const data = {
  items: [],
  projects: [],
  itemTypes: [],
  routines: [],
  seasons: [],
  goals: [],
  itemTypesAvailable: true,
  collectionsAvailable: true,
  goalsAvailable: true,
};

describe('with no IndexedDB', () => {
  it('really has none (a global setup that installed one would make this file vacuous)', () => {
    expect(typeof indexedDB).toBe('undefined');
    expect(snapshotSupported()).toBe(false);
  });

  it('read → null, write → false, and nothing throws or rejects', async () => {
    expect(() => warmPlannerSnapshot('user-a')).not.toThrow();
    await expect(readPlannerSnapshot('user-a')).resolves.toBeNull();
    await expect(writePlannerSnapshot('user-a', data, Date.now(), getSnapshotEpoch())).resolves.toBe(false);
    expect(() => purgePlannerSnapshotDb()).not.toThrow();
  });

  it('a clear is a no-op on disk but still bumps the epoch — the in-memory half of its contract', () => {
    const before = getSnapshotEpoch();
    expect(() => clearPlannerSnapshot()).not.toThrow();
    expect(getSnapshotEpoch()).toBe(before + 1);
  });

  it('the crash marker still works, since it is sessionStorage', async () => {
    markPreviewPending(true);
    expect(sessionStorage.getItem('dsul-preview-pending')).toBe('1');
    // Unsupported reads return before consuming it: there is nothing to purge.
    await expect(readPlannerSnapshot('user-a')).resolves.toBeNull();
    markPreviewPending(false);
    expect(sessionStorage.getItem('dsul-preview-pending')).toBeNull();
  });
});
