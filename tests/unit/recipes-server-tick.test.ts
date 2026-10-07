// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { called, eqOf, fakeService, op, type FakeQuery, type FakeResult } from './helpers/fake-service';
import { runItemEventRecipes, runRecipeTick } from '@/lib/recipes/server';

/**
 * The two ways the server starts a recipe (lib/recipes/server/): the timed
 * tier of the cron tick, and an item event from a phone or reminder tick. One
 * user's failure never costs another's run, the tick's deadline stops new
 * runs, an at-least-once re-delivery runs once, and a switched-off recipe or
 * a user with none does nothing.
 */

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const R1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const R2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
/** 07:30 in New York (EDT). */
const NOW = new Date('2026-10-07T11:30:00Z');

const timed = (id: string, user: string, at = '07:30', extra: Record<string, unknown> = {}) => ({
  id,
  user_id: user,
  kind: 'recipe',
  enabled: true,
  manifest: { version: 1, trigger: { on: 'time', at }, filters: {}, steps: [{ do: 'create', type: 'task', title: 'Plan the day' }], ...extra },
});

let mods: Record<string, unknown>[];
let settings: { user_id: string; timezone: string | null }[];
let claims: Set<string>;
let failProjectsFor: string | null;
let item: Record<string, unknown> | null;

function respond(q: FakeQuery): FakeResult {
  const kind = op(q);
  const user = eqOf(q, 'user_id') as string | undefined;
  switch (q.table) {
    case 'user_mods': {
      if (kind === 'update') return { data: null, error: null };
      const rows = user ? mods.filter((m) => m.user_id === user) : mods;
      return { data: rows.filter((m) => m.enabled), error: null };
    }
    case 'user_settings': {
      if (user) return { data: settings.find((s) => s.user_id === user) ?? null, error: null };
      return { data: settings.filter((s) => s.timezone !== null), error: null };
    }
    case 'mod_runs': {
      if (kind === 'upsert') {
        const { mod_id, claim_key } = called(q, 'upsert')[0][0] as { mod_id: string; claim_key: string };
        const key = `${mod_id}|${claim_key}`;
        if (claims.has(key)) return { data: [], error: null };
        claims.add(key);
        return { data: [{ id: 1 }], error: null };
      }
      if (kind === 'insert') return { data: null, error: null };
      return { data: null, error: null, count: 0 };
    }
    case 'projects':
      return user === failProjectsFor ? { data: null, error: { code: 'XX000', message: 'projects down' } } : { data: [], error: null };
    case 'items_windowed':
    case 'items': {
      if (kind === 'insert' || kind === 'update') return { data: null, error: null };
      const select = called(q, 'select')[0];
      if ((select?.[1] as { head?: boolean } | undefined)?.head) return { data: null, error: null, count: 0 };
      return { data: item && item.user_id === user ? item : null, error: null };
    }
    default:
      return { data: [], error: null };
  }
}

let fake: ReturnType<typeof fakeService>;
const creates = () => fake.queries.filter((q) => q.table === 'items' && op(q) === 'insert').map((q) => called(q, 'insert')[0][0] as { user_id: string });

beforeEach(() => {
  mods = [timed(R1, U1), timed(R2, U2)];
  settings = [
    { user_id: U1, timezone: 'America/New_York' },
    { user_id: U2, timezone: 'America/New_York' },
  ];
  claims = new Set();
  failProjectsFor = null;
  item = null;
  fake = fakeService(respond);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('runRecipeTick', () => {
  it('asks for switched-on timed recipes with the three filters 062’s index is built on', async () => {
    await runRecipeTick(fake.service, { now: NOW });
    const q = fake.queries.find((x) => x.table === 'user_mods')!;
    expect(called(q, 'eq')).toEqual([
      ['kind', 'recipe'],
      ['enabled', true],
      ['manifest->trigger->>on', 'time'],
    ]);
    expect(called(q, 'select')[0][0]).not.toMatch(/source|store/);
  });

  it('runs each due recipe once, for its own user, claimed by day and time', async () => {
    const out = await runRecipeTick(fake.service, { now: NOW });
    expect(out).toEqual({ users: 2, runs: 2, notes: [] });
    expect(creates().map((c) => c.user_id).sort()).toEqual([U1, U2].sort());
    expect([...claims].sort()).toEqual([`${R1}|time:2026-10-07:07:30`, `${R2}|time:2026-10-07:07:30`].sort());
  });

  it('an at-least-once re-delivery of the same tick runs nothing more', async () => {
    await runRecipeTick(fake.service, { now: NOW });
    await runRecipeTick(fake.service, { now: new Date(NOW.getTime() + 5 * 60_000) });
    expect(creates()).toHaveLength(2);
  });

  it('runs nothing out of its window, or on a weekday it is not set for', async () => {
    mods = [timed(R1, U1, '09:00'), timed(R2, U2, '07:30', { filters: { weekdays: [0] } })];
    const out = await runRecipeTick(fake.service, { now: NOW });
    expect(out.runs).toBe(0);
    expect(creates()).toEqual([]);
  });

  it('one user’s failure is a note, and the next user still runs', async () => {
    failProjectsFor = U1;
    const out = await runRecipeTick(fake.service, { now: NOW });
    expect(out.runs).toBe(1);
    expect(creates().map((c) => c.user_id)).toEqual([U2]);
    expect(out.notes.join(' ')).toContain(U1);
  });

  it('a user with no time zone is not asked', async () => {
    settings = [{ user_id: U2, timezone: 'America/New_York' }];
    const out = await runRecipeTick(fake.service, { now: NOW });
    expect(out).toEqual({ users: 1, runs: 1, notes: [] });
  });

  it('starts no run past the deadline; the next tick in the window has it', async () => {
    const out = await runRecipeTick(fake.service, { now: NOW, deadlineMs: Date.now() - 1 });
    expect(out.runs).toBe(0);
    expect(claims.size).toBe(0);
    expect(out.notes.length).toBeGreaterThan(0);
    const later = await runRecipeTick(fake.service, { now: new Date(NOW.getTime() + 5 * 60_000) });
    expect(later.runs).toBe(2);
  });

  it('a recipe whose steps the server cannot run, or whose manifest is not one, is passed over', async () => {
    mods = [
      timed(R1, U1, '07:30', { steps: [{ do: 'toast', text: 'hi' }] }),
      { ...timed(R2, U2), manifest: { nonsense: true } },
    ];
    const out = await runRecipeTick(fake.service, { now: NOW });
    expect(out.runs).toBe(0);
    expect(claims.size).toBe(0);
  });

  it('nothing switched on, nothing done; no table, no noise', async () => {
    mods = [];
    expect(await runRecipeTick(fake.service, { now: NOW })).toEqual({ users: 0, runs: 0, notes: [] });
    const missing = fakeService((q) => (q.table === 'user_mods' ? { data: null, error: { code: '42P01' } } : { data: [] }));
    expect(await runRecipeTick(missing.service, { now: NOW })).toEqual({ users: 0, runs: 0, notes: [] });
  });

  it('never throws', async () => {
    const broken = fakeService(() => {
      throw new Error('boom');
    });
    const out = await runRecipeTick(broken.service, { now: NOW });
    expect(out.runs).toBe(0);
    expect(out.notes).toHaveLength(1);
  });
});

describe('runItemEventRecipes (a phone or reminder tick)', () => {
  const onTick = (steps: unknown[] = [{ do: 'create', type: 'task', title: 'Stretch' }], filters = {}) => ({
    id: R1,
    user_id: U1,
    kind: 'recipe',
    enabled: true,
    manifest: { version: 1, trigger: { on: 'item.completed' }, filters, steps },
  });
  const habit = (completed: string[]) => ({
    id: ITEM,
    user_id: U1,
    type: 'habit',
    title: 'Run',
    status: 'done',
    repeat_frequency: 'daily',
    completed_dates: completed,
    skipped_dates: [],
    deleted_at: null,
  });
  const event = { kind: 'item.completed' as const, itemId: ITEM, type: 'habit', date: '2026-10-07' };

  it('runs the matching recipe once per item, date and trigger, scoped to the user', async () => {
    mods = [onTick()];
    item = habit(['2026-10-07']);
    expect((await runItemEventRecipes(fake.service, U1, event, NOW)).runs).toBe(1);
    expect((await runItemEventRecipes(fake.service, U1, event, NOW)).runs).toBe(0);
    expect([...claims]).toEqual([`${R1}|item:item.completed:${ITEM}:2026-10-07`]);
    const read = fake.queries.find((q) => q.table === 'user_mods')!;
    expect(eqOf(read, 'user_id')).toBe(U1);
  });

  it('runs nothing when the event no longer holds (unticked again on another device)', async () => {
    mods = [onTick()];
    item = habit([]);
    expect((await runItemEventRecipes(fake.service, U1, event, NOW)).runs).toBe(0);
    expect(claims.size).toBe(0);
  });

  it('runs nothing for another trigger, a filter that fails, or a switched-off recipe', async () => {
    item = habit(['2026-10-07']);
    mods = [{ ...onTick(), manifest: { ...onTick().manifest, trigger: { on: 'item.skipped' } } }];
    expect((await runItemEventRecipes(fake.service, U1, event, NOW)).runs).toBe(0);
    mods = [onTick(undefined, { types: ['task'] })];
    expect((await runItemEventRecipes(fake.service, U1, event, NOW)).runs).toBe(0);
    mods = [{ ...onTick(), enabled: false }];
    expect((await runItemEventRecipes(fake.service, U1, event, NOW)).runs).toBe(0);
    expect(claims.size).toBe(0);
  });

  it('waits for a time zone, and says so', async () => {
    mods = [onTick()];
    item = habit(['2026-10-07']);
    settings = [{ user_id: U1, timezone: null }];
    const out = await runItemEventRecipes(fake.service, U1, event, NOW);
    expect(out.runs).toBe(0);
    expect(out.notes.join(' ')).toContain('time zone');
  });

  it('never throws', async () => {
    const broken = fakeService(() => {
      throw new Error('boom');
    });
    const out = await runItemEventRecipes(broken.service, U1, event, NOW);
    expect(out.runs).toBe(0);
  });
});
