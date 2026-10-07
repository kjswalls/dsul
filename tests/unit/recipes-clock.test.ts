import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The recipe clock (lib/recipes/clock.ts, engine.ts runClock): parts of day
 * start at 05:00, 12:00 and 17:00; a clock run is claimed in mod_runs before
 * it acts, once per recipe per day (or part of day), and a claim another tab
 * or device holds runs nothing here.
 */

const sb = vi.hoisted(() => ({
  calls: [] as { table: string; op: string; args: unknown[] }[],
  claimData: [{ id: 1 }] as unknown[],
  /** When set, the next upsert answers this error instead. */
  claimError: null as null | { code?: string; message?: string },
}));

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      let upserting = false;
      for (const op of ['insert', 'upsert', 'update', 'select', 'eq']) {
        builder[op] = (...args: unknown[]) => {
          sb.calls.push({ table, op, args });
          if (op === 'upsert') upserting = true;
          return builder;
        };
      }
      builder.then = (resolve: (r: unknown) => unknown) =>
        Promise.resolve(
          upserting
            ? sb.claimError
              ? { data: null, error: sb.claimError }
              : { data: sb.claimData, error: null }
            : { data: null, error: null }
        ).then(resolve);
      return builder;
    },
  }),
}));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
  loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
  createItem: vi.fn(async () => {}),
}));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn(async () => {}) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { toast } from 'sonner';
import { usePlannerStore } from '@/lib/planner-store';
import { useModsStore } from '@/lib/mods-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { __resetRecipeEngineForTests, runClock } from '@/lib/recipes/engine';
import { bucketClaimKey, clockBucket, dayClaimKey, localDayAndTime } from '@/lib/recipes/clock';
import type { UserMod } from '@/lib/mods/schema';

const USER = '11111111-1111-4111-8111-111111111111';

function recipe(trigger: Record<string, unknown>, text: string): UserMod {
  return {
    id: crypto.randomUUID(),
    userId: USER,
    kind: 'recipe',
    slug: text.toLowerCase().replace(/[^a-z]+/g, '-'),
    name: text,
    enabled: true,
    manifest: { version: 1, trigger, filters: {}, steps: [{ do: 'toast', text }] },
    disabledReason: null,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
  };
}

const claims = () => sb.calls.filter((c) => c.table === 'mod_runs' && c.op === 'upsert').map((c) => c.args[0] as { claim_key: string });
const logs = () => sb.calls.filter((c) => c.table === 'mod_runs' && c.op === 'insert').map((c) => c.args[0] as { claim_key: string });
const toasts = () => vi.mocked(toast).mock.calls.map((c) => c[0]);

describe('clockBucket', () => {
  it.each([
    ['00:00', null],
    ['04:59', null],
    ['05:00', 'morning'],
    ['11:59', 'morning'],
    ['12:00', 'afternoon'],
    ['16:59', 'afternoon'],
    ['17:00', 'evening'],
    ['23:59', 'evening'],
  ])('%s is %s', (hhmm, bucket) => {
    expect(clockBucket(hhmm)).toBe(bucket);
  });

  it('reads the day and time in the zone, midnight as 00', () => {
    expect(localDayAndTime(new Date('2026-03-10T23:30:00Z'), 'Asia/Tokyo')).toEqual({ today: '2026-03-11', hhmm: '08:30' });
    expect(localDayAndTime(new Date('2026-03-10T00:00:00Z'), 'UTC').hhmm).toBe('00:00');
  });
});

describe('runClock', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-03-10T13:00:00Z'));
    __resetRecipeEngineForTests();
    usePlannerStore.getState().clearStore();
    await usePlannerStore.getState().initializeStore(USER);
    usePlannerStore.setState({ userTimezone: 'UTC' });
    useExtensionsStore.setState({ available: true, configsLoaded: true, enabled: {}, configs: {} });
    sb.calls = [];
    sb.claimData = [{ id: 1 }];
    sb.claimError = null;
    vi.mocked(toast).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  const seed = (...rows: UserMod[]) =>
    useModsStore.setState({ available: true, loaded: true, failed: false, hydratedUserId: USER, safeMode: false, rows });

  it('claims a new day once per recipe, runs it, and logs <key>:done', async () => {
    const r = recipe({ on: 'day.opened' }, 'Good day');
    seed(r);
    await runClock();
    expect(claims()).toEqual([expect.objectContaining({ user_id: USER, mod_id: r.id, claim_key: dayClaimKey('2026-03-10'), summary: { kind: 'claim' } })]);
    expect(toasts()).toEqual(['Good day']);
    expect(logs().map((l) => l.claim_key)).toEqual(['day:2026-03-10:done']);

    // A second tick in the same tab does not even try the claim again.
    await runClock();
    expect(claims()).toHaveLength(1);
    expect(toasts()).toEqual(['Good day']);

    // The next day is a new key.
    vi.setSystemTime(new Date('2026-03-11T06:00:00Z'));
    await runClock();
    expect(claims().map((c) => c.claim_key)).toEqual(['day:2026-03-10', 'day:2026-03-11']);
  });

  it('a claim that errors runs nothing, and is tried again next tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    seed(recipe({ on: 'day.opened' }, 'Good day'));
    sb.claimError = { code: '08006', message: 'offline' };
    await runClock();
    expect(claims()).toHaveLength(1);
    expect(toasts()).toEqual([]);

    sb.claimError = null;
    await runClock();
    expect(claims()).toHaveLength(2);
    expect(toasts()).toEqual(['Good day']);
    // Won now, so not tried a third time.
    await runClock();
    expect(claims()).toHaveLength(2);
    warn.mockRestore();
  });

  it('a missing mod_runs table is a lost claim, not a retry', async () => {
    seed(recipe({ on: 'day.opened' }, 'Good day'));
    sb.claimError = { code: '42P01' };
    await runClock();
    await runClock();
    expect(claims()).toHaveLength(1);
    expect(toasts()).toEqual([]);
  });

  it('a lost claim (another tab or device holds it) runs nothing', async () => {
    seed(recipe({ on: 'day.opened' }, 'Good day'));
    sb.claimData = [];
    await runClock();
    expect(claims()).toHaveLength(1);
    expect(toasts()).toEqual([]);
    expect(logs()).toEqual([]);
  });

  it('a part of day fires only in its own part', async () => {
    const evening = recipe({ on: 'bucket.changed', bucket: 'evening' }, 'Evening');
    const any = recipe({ on: 'bucket.changed' }, 'Any part');
    seed(evening, any);
    await runClock(); // 13:00, afternoon
    expect(toasts()).toEqual(['Any part']);
    expect(claims().map((c) => c.claim_key)).toEqual([bucketClaimKey('2026-03-10', 'afternoon')]);

    vi.setSystemTime(new Date('2026-03-10T17:05:00Z'));
    await runClock();
    expect(toasts()).toEqual(['Any part', 'Evening', 'Any part']);
  });

  it('before 05:00 there is no part of day', async () => {
    vi.setSystemTime(new Date('2026-03-10T03:00:00Z'));
    seed(recipe({ on: 'bucket.changed' }, 'Any part'));
    await runClock();
    expect(claims()).toEqual([]);
  });

  it('re-checks the switch after the claim', async () => {
    const r = recipe({ on: 'day.opened' }, 'Good day');
    seed(r);
    const pending = runClock();
    useModsStore.setState({ rows: [{ ...r, enabled: false }] });
    await pending;
    expect(claims()).toHaveLength(1);
    expect(toasts()).toEqual([]);
  });

  it('safe mode claims nothing', async () => {
    seed(recipe({ on: 'day.opened' }, 'Good day'));
    useModsStore.setState({ safeMode: true });
    await runClock();
    expect(claims()).toEqual([]);
  });

  it("event recipes are not the clock's", async () => {
    seed(recipe({ on: 'item.completed' }, 'Tick'), recipe({ on: 'command' }, 'Cmd'));
    await runClock();
    expect(claims()).toEqual([]);
  });
});
