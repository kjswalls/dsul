import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

/**
 * The item sheet's writes, shared with the iPhone.
 *
 * tests/unit/day-fixtures.test.ts pins what the phone's sheet ASKS (the verb
 * gates and labels); this pins what three of its verbs DO. Each case drives the
 * REAL planner store — `setItemSkipped`, `moveTaskToDate`, `setItemPaused` —
 * over one item, with the db layer mocked (the skip.test.ts harness) and the
 * clock pinned, and records two things to tests/fixtures/day/verb-writes.json:
 *
 *  - the optimistic end state of the item, which DsulCore's VerbWrites.swift
 *    (`skipping`, `moving`, `pausing`) must reproduce, and
 *  - the database calls the store made, in order, which /api/app/items/:id's
 *    `skip`, `move` and `pause` intents mirror server-side.
 *
 * `gate` is the store's own refusal (isSkippable / task-like / isPausable): a
 * case with `gate: false` writes nothing and leaves the item alone. The phone
 * never reaches the store's refusal — its verb gates refuse first — so the
 * Swift side checks only the cases with `gate: true`.
 *
 * In `updates`, a key present with `null` is a column the store cleared (it
 * wrote `undefined`, which lib/db.ts sends as SQL NULL); an absent key is a
 * column left alone.
 *
 * Regenerate with:
 *
 *   UPDATE_FIXTURES=1 pnpm test tests/unit/verb-writes-fixtures.test.ts
 *
 * Never hand-edit the JSON: the inputs live here.
 */

type DbCall =
  | { fn: 'setItemCompletion'; id: string; type: string; date: string; completed: boolean }
  | { fn: 'setItemSkip'; id: string; type: string; date: string; skipped: boolean }
  | { fn: 'updateItem'; id: string; type: string; updates: Record<string, unknown> };

// The mock factory runs while the imports below are still resolving, before
// any module-level const exists, so the log it writes to is hoisted with it.
const log = vi.hoisted(() => ({ calls: [] as DbCall[] }));

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  /** A JSON-safe copy that keeps a cleared column as an explicit null. */
  const written = (updates: Record<string, unknown>): Record<string, unknown> =>
    JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, v ?? null]))));
  return {
    ...actual,
    fetchItems: vi.fn(async () => []),
    fetchProjects: vi.fn(async () => []),
    fetchItemTypes: vi.fn(async () => []),
    createItem: vi.fn(async () => {}),
    updateItem: vi.fn(async (id: string, type: string, updates: Record<string, unknown>) => {
      log.calls.push({ fn: 'updateItem', id, type, updates: written(updates) });
    }),
    deleteItem: vi.fn(async () => {}),
    restoreItem: vi.fn(async () => {}),
    setItemCompletion: vi.fn(async (id: string, type: string, date: string, completed: boolean) => {
      log.calls.push({ fn: 'setItemCompletion', id, type, date, completed });
    }),
    setItemSkip: vi.fn(async (id: string, type: string, date: string, skipped: boolean) => {
      log.calls.push({ fn: 'setItemSkip', id, type, date, skipped });
    }),
    createProject: vi.fn(async () => {}),
    updateProject: vi.fn(async () => {}),
    deleteProject: vi.fn(async () => {}),
    restoreProject: vi.fn(async () => {}),
    fetchRoutines: vi.fn(async () => []),
    createRoutine: vi.fn(async () => {}),
    updateRoutine: vi.fn(async () => {}),
    deleteRoutine: vi.fn(async () => {}),
    restoreRoutine: vi.fn(async () => {}),
    fetchSeasons: vi.fn(async () => []),
    createSeason: vi.fn(async () => {}),
    updateSeason: vi.fn(async () => {}),
    deleteSeason: vi.fn(async () => {}),
    restoreSeason: vi.fn(async () => {}),
    fetchGoals: vi.fn(async () => []),
    // No RPC: the per-table fallback, started synchronously (the fetchers above).
    loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
    createGoal: vi.fn(async () => {}),
    updateGoal: vi.fn(async () => {}),
    deleteGoal: vi.fn(async () => {}),
    restoreGoal: vi.fn(async () => {}),
  };
});
vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import { usePlannerStore } from '@/lib/planner-store';
import * as db from '@/lib/db';
import { resolvePauseWrite } from '@/lib/active';
import { isPausable, isSkippable } from '@/lib/item-registry';
import { isTaskLike } from '@/lib/item-verbs';
import { toDateStr } from '@/lib/recurrence';
import type { Item } from '@/lib/planner-types';

const FILE = path.resolve(__dirname, '../fixtures/day/verb-writes.json');
const USER = 'user-1';

// ── Builders (day-fixtures.test.ts's, with ids of their own) ─────────────────

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const task = (n: number, title: string, over: Record<string, unknown> = {}): Item =>
  ({ type: 'task', id: uid(n), title, status: 'pending', isScheduled: true, order: 0, ...over }) as Item;

const custom = (n: number, customType: string, title: string, over: Record<string, unknown> = {}): Item =>
  ({
    type: 'custom',
    customType,
    id: uid(n),
    title,
    status: 'pending',
    isScheduled: true,
    order: 0,
    ...over,
  }) as Item;

const habit = (n: number, title: string, over: Record<string, unknown> = {}): Item =>
  ({
    type: 'habit',
    id: uid(n),
    title,
    streak: 0,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
    ...over,
  }) as Item;

// ── Running one case ─────────────────────────────────────────────────────────

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
/** 11:00 on Friday 2 October in New York. */
const NOW = '2026-10-02T15:00:00.000Z';
const D = '2026-10-02';

type Outcome = { item: Item; calls: DbCall[] };
type Clock = { now: string; timeZone: string; todayStr: string };

const store = () => usePlannerStore.getState();

const clockOf = (opts: { now?: string; timeZone?: string } = {}): Clock => {
  const now = opts.now ?? NOW;
  const timeZone = opts.timeZone ?? NY;
  return { now, timeZone, todayStr: toDateStr(new Date(now), timeZone) };
};

/**
 * A fresh store holding only `item`, at `clock`, then `act` — the item as the
 * store leaves it, and every write it sent, in order. Nothing in an act is
 * awaited: the store writes optimistically and fires its db calls in the same
 * tick, so the log is complete when `act` returns.
 */
async function run(item: Item, clock: Clock, act: () => void): Promise<Outcome> {
  vi.setSystemTime(new Date(clock.now));
  store().clearStore();
  vi.mocked(db.fetchItems).mockResolvedValue([structuredClone(item)]);
  await store().initializeStore(USER);
  usePlannerStore.setState({ selectedDate: new Date(clock.now), userTimezone: clock.timeZone });
  log.calls.length = 0;
  act();
  const after = store().items.find((i) => i.id === item.id);
  if (!after) throw new Error(`${item.title}: the store lost the item`);
  return { item: JSON.parse(JSON.stringify(after)), calls: log.calls.splice(0) };
}

/**
 * The acting day as a Date, which the store resolves in the user's zone: noon
 * UTC is still that day everywhere from Honolulu to Tokyo.
 */
const dayAt = (dateStr: string) => new Date(`${dateStr}T12:00:00Z`);

type SkipCase = Clock & {
  name: string;
  item: Item;
  date: string;
  skipped: boolean;
  gate: boolean;
  expected: Outcome;
};
type MoveCase = Clock & { name: string; item: Item; date: string; gate: boolean; expected: Outcome };
type PauseCase = Clock & {
  name: string;
  item: Item;
  paused: boolean;
  /** The resume day a pause is given; null for an open-ended pause, and always for a resume. */
  pausedUntil: string | null;
  gate: boolean;
  expected: Outcome;
};
type VerbWrites = { skip: SkipCase[]; move: MoveCase[]; pause: PauseCase[] };

async function skip(name: string, item: Item, date: string, skipped: boolean): Promise<SkipCase> {
  const clock = clockOf();
  const expected = await run(item, clock, () => store().setItemSkipped(item.id, skipped, dayAt(date)));
  return { name, ...clock, item, date, skipped, gate: isSkippable(item), expected };
}

async function move(name: string, item: Item, date: string): Promise<MoveCase> {
  const clock = clockOf();
  const expected = await run(item, clock, () => store().moveTaskToDate(item.id, date));
  return { name, ...clock, item, date, gate: isTaskLike(item), expected };
}

async function pause(
  name: string,
  item: Item,
  paused: boolean,
  pausedUntil: string | null = null,
  at: { now?: string; timeZone?: string } = {}
): Promise<PauseCase> {
  const clock = clockOf(at);
  const expected = await run(item, clock, () => store().setItemPaused(item.id, paused, pausedUntil ?? undefined));
  return { name, ...clock, item, paused, pausedUntil, gate: isPausable(item), expected };
}

// ── The cases ────────────────────────────────────────────────────────────────

async function build(): Promise<VerbWrites> {
  const PAST = '2026-09-30';
  const PAUSED = '2026-09-20T15:00:00Z';
  const stretch = (over: Record<string, unknown> = {}) => habit(901, 'stretch', { streak: 2, ...over });
  const counted = (over: Record<string, unknown> = {}) => habit(902, 'water x3', { timesPerDay: 3, ...over });
  const daily = (over: Record<string, unknown> = {}) =>
    task(910, 'water plants', { repeatFrequency: 'daily', startDate: '2026-09-01', timeBucket: 'morning', ...over });
  const oneOff = (over: Record<string, unknown> = {}) =>
    task(920, 'buy milk', { startDate: D, timeBucket: 'morning', ...over });
  const errand = (over: Record<string, unknown> = {}) =>
    custom(930, 'errand', 'post office', { startDate: D, timeBucket: 'afternoon', ...over });
  const weekdayErrand = (over: Record<string, unknown> = {}) =>
    errand({ repeatFrequency: 'weekdays', startDate: '2026-09-01', ...over });

  // Sequential, never Promise.all: every case resets the one store.
  const skips: SkipCase[] = [];
  for (const args of [
    // A habit goes through toggleHabitStatus('skipped' | 'pending'): the day's
    // completion is cleared either way, the skip moves only when it changes.
    ['habit skip on an open day', stretch(), D, true],
    ['habit skip on a done day takes the completion and a streak day', stretch({ completedDates: [D], streak: 3, status: 'done' }), D, true],
    ['habit skip on a day already skipped', stretch({ skippedDates: [D], status: 'skipped' }), D, true],
    ['habit skip on a day both skipped and completed', stretch({ skippedDates: [D], completedDates: [D], streak: 3 }), D, true],
    ['habit unskip', stretch({ skippedDates: [D], status: 'skipped' }), D, false],
    ['habit unskip on a day both skipped and completed', stretch({ skippedDates: [D], completedDates: [D], streak: 3, status: 'skipped' }), D, false],
    ['habit unskip on a day not skipped still clears its completion', stretch({ completedDates: [D], streak: 3, status: 'done' }), D, false],
    ['habit skip on a past day', stretch({ completedDates: [PAST], streak: 1 }), PAST, true],
    ['counted habit skip keeps its tally', counted({ dailyCounts: { [D]: 2 }, currentDayCount: 2 }), D, true],
    ['counted habit skip with no stored day count', counted({ dailyCounts: { [D]: 1 } }), D, true],
    ['counted habit skip on a done day', counted({ dailyCounts: { [D]: 3 }, completedDates: [D], currentDayCount: 3, streak: 5, status: 'done' }), D, true],
    // A task-like item moves skippedDates alone and never writes status.
    ['recurring task skip', daily(), D, true],
    ['recurring task done, then skipped', daily({ completedDates: ['2026-10-01', D] }), D, true],
    ['recurring task unskip', daily({ skippedDates: [D] }), D, false],
    ['recurring task skip on a day already skipped writes nothing', daily({ skippedDates: [D] }), D, true],
    ['recurring task unskip on a day not skipped writes nothing', daily(), D, false],
    ['recurring task unskip leaves a completion alone', daily({ skippedDates: [D], completedDates: [D] }), D, false],
    ['recurring task skip on a past day', daily({ completedDates: [PAST] }), PAST, true],
    ['custom recurring skip', weekdayErrand(), D, true],
    ['custom recurring done, then skipped', weekdayErrand({ completedDates: [D] }), D, true],
    ['custom recurring unskip', weekdayErrand({ skippedDates: [D] }), D, false],
    ['a one-off is not skippable', oneOff(), D, true],
    ['repeat none is not skippable', oneOff({ repeatFrequency: 'none' }), D, true],
  ] as [string, Item, string, boolean][]) {
    skips.push(await skip(...args));
  }

  const moves: MoveCase[] = [];
  for (const args of [
    ['one-off to tomorrow keeps its bucket', oneOff(), '2026-10-03'],
    ['a missing bucket lands in anytime', oneOff({ timeBucket: undefined }), '2026-10-03'],
    ['start time, duration and the scheduled flag are kept', oneOff({ timeBucket: 'afternoon', startTime: '14:00', duration: 45 }), '2026-10-05'],
    ['an undated task gets a day and anytime', oneOff({ startDate: undefined, timeBucket: undefined, isScheduled: false }), D],
    ['an overdue one-off comes to today', oneOff({ startDate: '2026-09-28' }), D],
    ['custom one-off', errand(), '2026-10-03'],
    // Reschedule takes a series (lib/row-moves.ts canReschedule): the picked
    // day becomes its start, and the rest of the row is kept.
    ['a recurring task rescheduled starts its series there', daily(), '2026-10-05'],
    ['a habit is not moved', stretch(), '2026-10-03'],
  ] as [string, Item, string][]) {
    moves.push(await move(...args));
  }

  const pauses: PauseCase[] = [];
  for (const args of [
    ['pause a habit', stretch(), true],
    ['pause a habit until next week', stretch(), true, '2026-10-09'],
    ['pause a one-off', oneOff(), true],
    ['pause a custom item until a day', errand(), true, '2026-10-05'],
    ['pause a recurring task', daily(), true],
    ['pausing after a pause ended restamps it and clears the end', stretch({ pausedAt: '2026-09-01T12:00:00Z', pausedUntil: '2026-09-20' }), true],
    ['pausing what is already paused writes nothing', stretch({ pausedAt: PAUSED }), true],
    ['resume', stretch({ pausedAt: PAUSED }), false],
    ['resume a pause with an end date', stretch({ pausedAt: PAUSED, pausedUntil: '2026-10-09' }), false],
    ['resume a paused one-off', oneOff({ pausedAt: PAUSED }), false],
    ['resuming what is live writes nothing', stretch(), false],
    ['resuming after the pause already ended writes nothing', stretch({ pausedAt: PAUSED, pausedUntil: '2026-10-01' }), false],
    ['a subtask is not pausable', oneOff({ parentItemId: uid(999) }), true],
    // 05:30 UTC on the 3rd is 22:30 on the 2nd in Los Angeles.
    ['resume late in the evening reads today in the user zone', stretch({ pausedAt: PAUSED }), false, null, { now: '2026-10-03T05:30:00.000Z', timeZone: LA }],
    // 16:00 UTC on the 2nd is already the 3rd in Tokyo.
    ['pause stamps the instant, whatever the zone', stretch(), true, null, { now: '2026-10-02T16:00:00.000Z', timeZone: 'Asia/Tokyo' }],
  ] as Parameters<typeof pause>[]) {
    pauses.push(await pause(...args));
  }

  return { skip: skips, move: moves, pause: pauses };
}

// ── Writing and checking ─────────────────────────────────────────────────────

const serialize = (f: unknown) => JSON.stringify(f, null, 2) + '\n';

describe('verb writes shared with DsulCore', () => {
  let generated: VerbWrites;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    generated = await build();
    if (process.env.UPDATE_FIXTURES) {
      mkdirSync(path.dirname(FILE), { recursive: true });
      writeFileSync(FILE, serialize(generated));
    }
  });
  afterAll(() => vi.useRealTimers());

  it('verb-writes.json exists', () => {
    expect(existsSync(FILE), `missing ${FILE}; run with UPDATE_FIXTURES=1`).toBe(true);
  });

  it('verb-writes.json has cases with unique names', () => {
    for (const list of [generated.skip, generated.move, generated.pause]) {
      expect(list.length).toBeGreaterThan(0);
      const names = list.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('verb-writes.json is what the store does today', () => {
    // On drift: if the store change is intended, regenerate with
    // UPDATE_FIXTURES=1 and make the same change in VerbWrites.swift and in
    // /api/app/items/:id.
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(JSON.parse(serialize(generated)));
  });

  it('a refused case writes nothing and changes nothing', () => {
    for (const c of [...generated.skip, ...generated.move, ...generated.pause]) {
      if (c.gate) continue;
      expect(c.expected.calls, c.name).toEqual([]);
      expect(c.expected.item, c.name).toEqual(JSON.parse(JSON.stringify(c.item)));
    }
  });

  it('the cases reach every write the three verbs make', () => {
    const fns = (list: { expected: Outcome }[]) => new Set(list.flatMap((c) => c.expected.calls.map((call) => call.fn)));
    expect(fns(generated.skip)).toEqual(new Set(['setItemCompletion', 'setItemSkip', 'updateItem']));
    expect(fns(generated.move)).toEqual(new Set(['updateItem']));
    expect(fns(generated.pause)).toEqual(new Set(['updateItem']));
    for (const list of [generated.skip, generated.move, generated.pause]) {
      expect(new Set(list.map((c) => c.gate))).toEqual(new Set([true, false]));
    }
    // Skip and pause also have the store's "already so": allowed, and silent.
    for (const list of [generated.skip, generated.pause]) {
      expect(list.some((c) => c.gate && c.expected.calls.length === 0)).toBe(true);
    }
    // A task-like skip never writes status: the task words are an external contract.
    for (const c of generated.skip) {
      if (c.item.type === 'habit') continue;
      expect(c.expected.calls.some((call) => call.fn === 'updateItem'), c.name).toBe(false);
      expect(c.expected.item.status, c.name).toBe(c.item.status);
    }
  });

  it('the store pauses exactly as resolvePauseWrite says, for every case the sheet can send', () => {
    // The phone builds its pause from lib/active.ts resolvePauseWrite (the
    // server's rule); the web store derives its own. Every case here is one the
    // sheet can send, and on each the two agree.
    for (const c of generated.pause) {
      if (!c.gate) continue;
      const req = { paused: c.paused, pausedUntil: c.pausedUntil ?? undefined };
      const r = resolvePauseWrite(c.item, req, c.todayStr, c.now, c.timeZone);
      if ('reason' in r) throw new Error(`${c.name}: ${r.reason}`);
      expect(c.expected.item, c.name).toEqual(JSON.parse(JSON.stringify({ ...c.item, ...r.patch })));
    }
  });
});
