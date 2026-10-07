// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { called, eqOf, fakeService, op, type FakeQuery, type FakeResult } from './helpers/fake-service';
import { loadUserContext } from '@/lib/recipes/server/context';
import { runRecipeOnServer } from '@/lib/recipes/server/run';
import { STAKE_EXTENSION_SLUGS } from '@/lib/recipes/stake-rule';
import { EXT_BEEMINDER } from '@/lib/extension-registry';
import { MOD_RUN_SUMMARY_MAX_BYTES } from '@/lib/recipes/limits';
import type { RecipeManifest } from '@/lib/mods/schema';
import type { RunSummary } from '@/lib/recipes/runs';

/**
 * One recipe run on the server (lib/recipes/server/run.ts), against a stub
 * service client: the rate limit, then the claim, then each write step through
 * the phone's own write path, re-read with the user scope and re-gated for the
 * real today and the stake lock; screen steps counted, the cap, the run log
 * and its Revert ops. The service role bypasses RLS, so every statement names
 * the user itself.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MOD = '33333333-3333-4333-8333-333333333333';
const HABIT = '44444444-4444-4444-8444-444444444444';
const SERIES = '55555555-5555-4555-8555-555555555555';
const ONE_OFF = '66666666-6666-4666-8666-666666666666';
const FOREIGN = '77777777-7777-4777-8777-777777777777';
const TODAY = '2026-10-07';
const NOW = new Date('2026-10-07T15:00:00Z');
const TZ = 'UTC';

const base = {
  user_id: USER,
  parent_item_id: null,
  start_time: null,
  in_project_block: null,
  paused_at: null,
  paused_until: null,
  daily_counts: {},
  current_day_count: 0,
  streak: 0,
  order: 0,
  deleted_at: null,
};
const habitRow = () => ({
  ...base,
  id: HABIT,
  type: 'habit',
  title: 'Run',
  status: 'pending',
  repeat_frequency: 'daily',
  completed_dates: [] as string[],
  skipped_dates: [] as string[],
  start_date: null as string | null,
  time_bucket: 'morning',
});
const seriesRow = () => ({
  ...habitRow(),
  id: SERIES,
  type: 'task',
  title: 'Stretch',
  start_date: '2026-10-01',
  time_bucket: 'afternoon',
});
const oneOffRow = () => ({
  ...habitRow(),
  id: ONE_OFF,
  type: 'task',
  title: 'Call the bank',
  repeat_frequency: null,
  start_date: TODAY as string | null,
  time_bucket: 'anytime',
});

let rows: Record<string, Record<string, unknown>>;
let claims: Set<string>;
let minuteRuns: number;
let dayRuns: number;
let extensions: FakeResult;
let projects: unknown[];
let itemTypes: unknown[];
let sequence: string[];

function respond(q: FakeQuery): FakeResult {
  const kind = op(q);
  sequence.push(`${q.table}:${kind}`);
  switch (q.table) {
    case 'mod_runs': {
      if (kind === 'upsert') {
        const key = (called(q, 'upsert')[0][0] as { claim_key: string }).claim_key;
        if (claims.has(key)) return { data: [], error: null };
        claims.add(key);
        return { data: [{ id: 1 }], error: null };
      }
      if (kind === 'insert') return { data: null, error: null };
      return { data: null, error: null, count: eqOf(q, 'summary->>day') ? dayRuns : minuteRuns };
    }
    case 'user_mods':
      return { data: null, error: null };
    case 'user_extensions':
      return extensions;
    case 'projects':
      return { data: projects, error: null };
    case 'item_types':
      return { data: itemTypes, error: null };
    case 'routines':
    case 'seasons':
    case 'routine_items':
    case 'season_items':
    case 'season_routines':
    case 'item_events':
      return { data: [], error: null };
    case 'items_windowed':
    case 'items': {
      if (kind === 'update' || kind === 'insert') return { data: null, error: null };
      const select = called(q, 'select')[0];
      if ((select?.[1] as { head?: boolean } | undefined)?.head) return { data: null, error: null, count: 4 };
      const row = rows[eqOf(q, 'id') as string];
      const mine = row && row.user_id === eqOf(q, 'user_id') ? row : null;
      const contains = called(q, 'contains')[0];
      if (contains) {
        const [, [date]] = contains as [string, string[]];
        return { data: mine && (mine.completed_dates as string[]).includes(date) ? { id: mine.id } : null, error: null };
      }
      return { data: mine, error: null };
    }
  }
  return { data: null, error: { code: 'XX000', message: `unexpected ${q.table}` } };
}

let fake: ReturnType<typeof fakeService>;

beforeEach(() => {
  rows = {
    [HABIT]: habitRow(),
    [SERIES]: seriesRow(),
    [ONE_OFF]: oneOffRow(),
    [FOREIGN]: { ...oneOffRow(), id: FOREIGN, user_id: OTHER },
  };
  claims = new Set();
  minuteRuns = 0;
  dayRuns = 0;
  extensions = { data: [], error: null };
  projects = [];
  itemTypes = [];
  sequence = [];
  fake = fakeService(respond);
  fake.rpc.mockImplementation(async (name: string) => {
    sequence.push(`rpc:${name}`);
    return { data: null, error: null };
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const recipe = (steps: unknown[], on = 'item.completed'): RecipeManifest =>
  ({ version: 1, trigger: on === 'time' ? { on, at: '07:30' } : { on }, filters: {}, steps }) as RecipeManifest;

async function run(m: RecipeManifest, trigger: { on: string; itemId?: string } = { on: 'item.completed' }, key = 'k') {
  const ctx = await loadUserContext(fake.service, USER, TZ, NOW, TODAY);
  const notes: string[] = [];
  const out = await runRecipeOnServer(ctx, { id: MOD }, m, trigger, key, notes);
  const log = fake.queries.find((q) => q.table === 'mod_runs' && op(q) === 'insert');
  const summary = log ? ((called(log, 'insert')[0][0] as { summary: RunSummary }).summary) : undefined;
  return { out, notes, log, summary };
}

const writes = () => sequence.filter((s) => /^rpc:|^items:(update|insert)/.test(s));

describe('scope', () => {
  it('names the user on every statement against items, runs, mods and extensions', async () => {
    await run(
      recipe([
        { do: 'complete', item: { id: HABIT } },
        { do: 'skip', item: { id: SERIES } },
        { do: 'reschedule', item: { id: ONE_OFF }, inDays: 2 },
        { do: 'create', type: 'task', title: 'Plan' },
      ])
    );
    const scoped = fake.queries.filter((q) =>
      ['items', 'items_windowed', 'mod_runs', 'user_mods', 'user_extensions', 'projects', 'item_types'].includes(q.table)
    );
    expect(scoped.length).toBeGreaterThan(10);
    for (const q of scoped) {
      const kind = op(q);
      if (kind === 'insert' || kind === 'upsert') {
        const payload = called(q, kind)[0][0] as { user_id: string };
        expect(payload.user_id, `${q.table} ${kind}`).toBe(USER);
      } else {
        expect(eqOf(q, 'user_id'), `${q.table} ${kind}`).toBe(USER);
      }
    }
  });

  it('refuses an item of another user named in the manifest, and writes nothing', async () => {
    const { summary } = await run(recipe([{ do: 'complete', item: { id: FOREIGN } }]));
    expect(summary?.steps).toEqual(['refuse:no-item']);
    expect(writes()).toEqual([]);
  });
});

describe('claim, then act', () => {
  it('claims before the first write, and logs `<key>:done` after the last', async () => {
    await run(recipe([{ do: 'complete', item: { id: HABIT } }]), { on: 'item.completed' }, 'item:x');
    const claim = sequence.indexOf('mod_runs:upsert');
    const firstWrite = sequence.findIndex((s) => /^rpc:|^items:(update|insert)/.test(s));
    const logged = sequence.indexOf('mod_runs:insert');
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(claim).toBeLessThan(firstWrite);
    expect(logged).toBeGreaterThan(firstWrite);
    const log = fake.queries.find((q) => q.table === 'mod_runs' && op(q) === 'insert')!;
    expect((called(log, 'insert')[0][0] as { claim_key: string }).claim_key).toBe('item:x:done');
  });

  it('a claim already taken (an at-least-once re-delivery) writes nothing and logs nothing', async () => {
    claims.add('item:x');
    const { out, log } = await run(recipe([{ do: 'complete', item: { id: HABIT } }]), { on: 'item.completed' }, 'item:x');
    expect(out).toEqual({ ran: false, why: 'claim-lost' });
    expect(writes()).toEqual([]);
    expect(log).toBeUndefined();
  });
});

describe('each step re-checks its gate for the real today', () => {
  it('completes a habit through the RPC and the status snapshot, scoped to the user', async () => {
    const { summary } = await run(recipe([{ do: 'complete', item: { id: HABIT } }]));
    expect(summary?.steps).toEqual(['done']);
    expect(fake.rpc).toHaveBeenCalledWith('set_item_completion', {
      item_id: HABIT,
      item_type: 'habit',
      date_str: TODAY,
      completed: true,
      adjust_streak: true,
    });
    const update = fake.queries.find((q) => q.table === 'items' && op(q) === 'update')!;
    expect(eqOf(update, 'user_id')).toBe(USER);
  });

  it.each([
    ['complete on a day already done', { [HABIT]: { completed_dates: [TODAY] } }, { do: 'complete', item: { id: HABIT } }],
    ['complete on a day it does not fall on', { [HABIT]: { repeat_frequency: 'custom', repeat_days: [0] } }, { do: 'complete', item: { id: HABIT } }],
    ['skip on a day already skipped', { [SERIES]: { skipped_dates: [TODAY] } }, { do: 'skip', item: { id: SERIES } }],
    ['reschedule of finished work', { [ONE_OFF]: { status: 'completed' } }, { do: 'reschedule', item: { id: ONE_OFF }, inDays: 1 }],
    ['skip of a one-off', {}, { do: 'skip', item: { id: ONE_OFF } }],
  ])('%s is skipped, and nothing is written', async (_, over, step) => {
    for (const [id, patch] of Object.entries(over)) rows[id] = { ...rows[id], ...patch };
    const { summary } = await run(recipe([step]));
    expect(summary?.steps).toEqual(['skip:ineligible']);
    expect(summary?.skipped).toBe(1);
    expect(writes()).toEqual([]);
  });

  it('a verb only the browser runs is skipped with a note, on an item trigger', async () => {
    const { summary } = await run(recipe([{ do: 'pause', item: 'trigger' }]), { on: 'item.completed', itemId: HABIT });
    expect(summary?.steps).toEqual(['skip:browser-only']);
    expect(writes()).toEqual([]);
  });

  it('acts on the item that started it', async () => {
    const { summary } = await run(recipe([{ do: 'skip', item: 'trigger' }]), { on: 'item.completed', itemId: SERIES });
    expect(summary?.steps).toEqual(['done']);
    expect(fake.rpc).toHaveBeenCalledWith('set_item_skip', expect.objectContaining({ item_id: SERIES, date_str: TODAY, skipped: true }));
  });
});

describe('the stake lock', () => {
  const on = (config: Record<string, unknown> = {}) => ({
    data: [{ slug: EXT_BEEMINDER, enabled: true, config }],
    error: null,
  });

  it('holds the lock to an extension on the stakes shelf', () => {
    expect(STAKE_EXTENSION_SLUGS).toContain(EXT_BEEMINDER);
  });

  it('with an adapter on: no verb on a stake-eligible habit, no item titled after a goal', async () => {
    extensions = on({ goals: 'Morning pages: pages' });
    const { summary } = await run(
      recipe([
        { do: 'complete', item: { id: HABIT } },
        { do: 'create', type: 'task', title: 'morning pages' },
        { do: 'create', type: 'task', title: 'Something else' },
        { do: 'complete', item: { id: ONE_OFF } },
      ])
    );
    expect(summary?.steps).toEqual(['refuse:stake', 'refuse:stake', 'done', 'done']);
    expect(fake.rpc).not.toHaveBeenCalledWith('set_item_completion', expect.objectContaining({ item_id: HABIT }));
  });

  it('a failed extensions read holds the lock, and no create gets through', async () => {
    extensions = { data: null, error: { code: 'XX000', message: 'down' } };
    const { summary } = await run(
      recipe([
        { do: 'complete', item: { id: HABIT } },
        { do: 'create', type: 'task', title: 'Anything' },
      ])
    );
    expect(summary?.steps).toEqual(['refuse:stake', 'refuse:stake']);
  });

  it('no extensions table is every adapter at its default, off', async () => {
    extensions = { data: null, error: { code: '42P01', message: 'missing' } };
    const { summary } = await run(recipe([{ do: 'complete', item: { id: HABIT } }]));
    expect(summary?.steps).toEqual(['done']);
  });
});

describe('create', () => {
  it('adds the store’s braindump task, with its order, silently', async () => {
    const { summary } = await run(recipe([{ do: 'create', type: 'task', title: 'Plan', bucket: 'morning' }]));
    expect(summary?.steps).toEqual(['done']);
    const insert = fake.queries.find((q) => q.table === 'items' && op(q) === 'insert')!;
    expect(called(insert, 'insert')[0][0]).toEqual(
      expect.objectContaining({ user_id: USER, type: 'task', title: 'Plan', status: 'pending', time_bucket: 'morning', is_scheduled: true, start_date: TODAY, order: 4 })
    );
  });

  it('never a habit, and never an unknown project', async () => {
    const { summary } = await run(
      recipe([
        { do: 'create', type: 'habit', title: 'New habit' },
        { do: 'create', type: 'task', title: 'Filed', project: 'Nowhere' },
      ])
    );
    expect(summary?.steps).toEqual(['refuse:type', 'refuse:no-project']);
    expect(writes()).toEqual([]);
  });

  it('a custom type of the user’s, by its slug', async () => {
    itemTypes = [{ id: 'x', user_id: USER, name: 'errand', label: 'Errand', label_plural: 'Errands' }];
    const { summary } = await run(recipe([{ do: 'create', type: 'errand', title: 'Post office' }]));
    expect(summary?.steps).toEqual(['done']);
    const insert = fake.queries.find((q) => q.table === 'items' && op(q) === 'insert')!;
    expect((called(insert, 'insert')[0][0] as { type: string }).type).toBe('errand');
  });
});

describe('the run', () => {
  it('counts screen steps, which the server cannot run', async () => {
    const { summary } = await run(
      recipe([
        { do: 'complete', item: { id: HABIT } },
        { do: 'toast', text: 'Nice' },
        { do: 'organize' },
      ])
    );
    expect(summary).toEqual(
      expect.objectContaining({ kind: 'run', server: true, day: TODAY, trigger: 'item.completed', did: 1, of: 1, ui: 2 })
    );
  });

  it('stops at 25 writes and says so', async () => {
    const steps = Array.from({ length: 27 }, (_, i) => ({ do: 'create', type: 'task', title: `T${i}` }));
    const { summary } = await run(recipe(steps));
    expect(summary?.did).toBe(25);
    expect(summary?.stopped).toBe(2);
    expect(summary?.steps.slice(-2)).toEqual(['stop:cap', 'stop:cap']);
    expect(fake.queries.filter((q) => q.table === 'items' && op(q) === 'insert')).toHaveLength(25);
  });

  it('past the tick’s deadline the rest stop, and the claimed run still logs its result and Revert', async () => {
    const ctx = await loadUserContext(fake.service, USER, TZ, NOW, TODAY);
    let clock = 1_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    fake.rpc.mockImplementation(async (name: string) => {
      sequence.push(`rpc:${name}`);
      clock = 2_000; // the first write runs the clock past the deadline
      return { data: null, error: null };
    });
    const m = recipe([
      { do: 'complete', item: { id: HABIT } },
      { do: 'create', type: 'task', title: 'Plan' },
      { do: 'create', type: 'task', title: 'Pack' },
    ]);
    const out = await runRecipeOnServer(ctx, { id: MOD }, m, { on: 'item.completed' }, 'k', [], { deadlineMs: 1_500 });
    now.mockRestore();
    expect(out.ran).toBe(true);
    const log = fake.queries.find((q) => q.table === 'mod_runs' && op(q) === 'insert')!;
    const summary = (called(log, 'insert')[0][0] as { summary: RunSummary }).summary;
    expect(summary.steps).toEqual(['done', 'stop:deadline', 'stop:deadline']);
    expect(summary).toEqual(expect.objectContaining({ did: 1, of: 3, stopped: 2, undo: [['uncomplete', HABIT, TODAY]] }));
    expect(fake.queries.filter((q) => q.table === 'items' && op(q) === 'insert')).toHaveLength(0);
  });

  it('records each write’s inverse for Revert, newest first', async () => {
    const { summary } = await run(
      recipe([
        { do: 'complete', item: { id: HABIT } },
        { do: 'complete', item: { id: ONE_OFF } },
        { do: 'skip', item: { id: SERIES } },
        { do: 'reschedule', item: { id: ONE_OFF }, inDays: 2 },
        { do: 'create', type: 'task', title: 'Plan' },
      ])
    );
    const created = (called(fake.queries.find((q) => q.table === 'items' && op(q) === 'insert')!, 'insert')[0][0] as { id: string }).id;
    expect(summary?.undo).toEqual([
      ['delete', created],
      ['move', ONE_OFF, TODAY, '2026-10-09'],
      ['unskip', SERIES, TODAY],
      ['uncomplete', ONE_OFF, null],
      ['uncomplete', HABIT, TODAY],
    ]);
  });

  it('keeps the log line inside 061’s 4096 bytes, dropping Revert first', async () => {
    const steps = Array.from({ length: 600 }, (_, i) => ({ do: 'create', type: 'task', title: `T${i}` }));
    const { summary } = await run(recipe(steps));
    expect(summary?.undo).toBeUndefined();
    expect(summary?.revertable).toBe(false);
    // As 061's CHECK measures it: jsonb's text, a space after every `:` and `,`.
    const jsonbText = JSON.stringify(summary).replace(/("(?:[^"\\]|\\.)*")|([:,])/g, (m, str) => str ?? `${m} `);
    expect(new TextEncoder().encode(jsonbText).length).toBeLessThanOrEqual(MOD_RUN_SUMMARY_MAX_BYTES);
    expect(summary?.did).toBe(25);
  });

  it('a step that throws is refused, and the next still runs', async () => {
    fake.rpc.mockImplementationOnce(async () => {
      throw new Error('rpc down');
    });
    const { summary } = await run(
      recipe([
        { do: 'complete', item: { id: HABIT } },
        { do: 'create', type: 'task', title: 'Plan' },
      ])
    );
    expect(summary?.steps).toEqual(['refuse:error', 'done']);
  });

  it('raises nothing and reads no recipe: a server write starts no other recipe', async () => {
    await run(recipe([{ do: 'complete', item: { id: HABIT } }, { do: 'create', type: 'task', title: 'Plan' }]));
    expect(fake.queries.filter((q) => q.table === 'user_mods')).toEqual([]);
  });
});

describe('the rate limit', () => {
  it.each([
    ['minute', () => (minuteRuns = 10), 'It ran more than 10 times in a minute.'],
    ['day', () => (dayRuns = 100), 'It ran more than 100 times today.'],
  ])('over the %s limit: switched off with the reason, nothing claimed or written', async (_, set, why) => {
    set();
    const { out, notes } = await run(recipe([{ do: 'complete', item: { id: HABIT } }]));
    expect(out).toEqual({ ran: false, why: 'rate' });
    const off = fake.queries.find((q) => q.table === 'user_mods' && op(q) === 'update')!;
    expect(called(off, 'update')[0][0]).toEqual({ enabled: false, disabled_reason: why });
    expect(eqOf(off, 'id')).toBe(MOD);
    expect(eqOf(off, 'user_id')).toBe(USER);
    expect(sequence).not.toContain('mod_runs:upsert');
    expect(writes()).toEqual([]);
    expect(notes.join(' ')).toContain('switched off');
  });

  it('counts results only, the day as the user’s own', async () => {
    await run(recipe([{ do: 'complete', item: { id: HABIT } }]));
    const counts = fake.queries.filter((q) => q.table === 'mod_runs' && op(q) === 'select');
    expect(counts).toHaveLength(2);
    for (const q of counts) {
      expect(eqOf(q, 'summary->>kind')).toBe('run');
      expect(eqOf(q, 'mod_id')).toBe(MOD);
    }
    expect(eqOf(counts[1], 'summary->>day')).toBe(TODAY);
  });
});
