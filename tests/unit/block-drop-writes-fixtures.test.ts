import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

/**
 * A block drop from the iPhone, as the server writes it (Week and blocks PR 8).
 *
 * The phone asks the shared rule (lib/block-moves.ts planBlockDrop, pinned by
 * tests/fixtures/day/block-moves.json) and turns its answer into one existing
 * item intent (design §5.5 and §6.2; memory/plans/ios-app.md, "Dropping a
 * block"):
 *
 *   place {date, startMin}   schedule {date, startTime}
 *   retime {startMin}        time {timeBucket: the hour's part of day, startTime}, never the date
 *   anytime {date: null}     time {timeBucket: 'anytime', startTime: null}
 *   braindump                unschedule
 *   pause                    nothing: refused on the phone in v1 (B15)
 *   anytime {date}           nothing: refused on the phone in v1 (B22)
 *   none, refused            nothing
 *
 * For every case in block-moves.json this sends that body through the REAL
 * route (POST /api/app/items/:id, app/api/app/items/[id]/route.ts), over the
 * row it would read, with the database mocked as tests/unit/app-item-write.test.ts
 * mocks it, and writes tests/fixtures/day/block-drop-writes.json:
 *
 *  - `name`: the block-moves.json case it answers (the join key, same order);
 *  - `write`: the body the phone sends, or null when it sends nothing;
 *  - `phoneRefusal`: the two answers the web takes and the phone refuses in
 *    v1, else null: 'pause' (B15), and 'another-day' (B22) for an Anytime
 *    answer that carries a day, which for a block is always another day's
 *    (a row with no date, which the grid never draws, answers so on any day);
 *  - `status` and `error`: the route's answer to `write` (null with no write);
 *  - `updates`: the columns the route wrote, camelCase, a cleared one as null,
 *    `{}` when it found the row already so (null with no write or a refusal);
 *  - `after`: the item as the route leaves it, an absent key left out, the
 *    end state the phone's optimistic step must draw (null likewise).
 *
 * The iPhone's hosted tests check the phone's body for each drop against
 * `write` and its optimistic step against `after`. The checks below pin what
 * the design promises of these writes: no drop the phone takes comes back
 * refused, a series' or a habit's move never writes a date, and each write
 * lands where the rule said it would.
 *
 * Regenerate after an intended change, block-moves.json first:
 *   UPDATE_FIXTURES=1 pnpm exec vitest run tests/unit/block-moves-fixtures.test.ts
 *   UPDATE_FIXTURES=1 pnpm exec vitest run tests/unit/block-drop-writes-fixtures.test.ts
 * A whole-suite UPDATE_FIXTURES=1 run writes the files in parallel, so this one
 * may be written from the block-moves.json it found before that file was; when
 * the case list changed, run it a second time. Never hand-edit the JSON.
 */

const USER = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
/** The goal a milestone case's item belongs to, as goal_items answers. */
const GOAL = '7a2d4c6e-8b1f-4e3a-9c5d-1f3b5d7e9a2c';

type Result = { data?: unknown; error?: unknown };
interface Query {
  table: string;
  calls: [string, unknown[]][];
}

const h = vi.hoisted(() => ({
  createClient: vi.fn(),
  notifyPlugins: vi.fn(),
  after: vi.fn(),
  reportLiveCompletion: vi.fn(),
  afterItemWrite: vi.fn(),
}));

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: h.createClient,
}));
vi.mock('@/lib/openclaw-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/openclaw-registry')>()),
  notifyPlugins: h.notifyPlugins,
}));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: h.after,
}));
vi.mock('@/lib/stakes/live', () => ({ reportLiveCompletion: h.reportLiveCompletion }));
vi.mock('@/lib/recipes/server', () => ({ afterItemWrite: h.afterItemWrite }));
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => ({ service: true }),
  resolveUserIdFromApiKey: vi.fn(),
}));

import { POST } from '@/app/api/app/items/[id]/route';
import {
  planBlockDrop,
  startTimeOf,
  type BlockDrop,
  type BlockItem,
  type BlockOrigin,
  type BlockTarget,
} from '@/lib/block-moves';
import { updatesToRow } from '@/lib/db';
import { itemTypeName } from '@/lib/item-registry';
import type { Item } from '@/lib/planner-types';
import { getBucketForTime } from '@/lib/time-bucket';

const MOVES = path.resolve(__dirname, '../fixtures/day/block-moves.json');
const FILE = path.resolve(__dirname, '../fixtures/day/block-drop-writes.json');

/** The app's camelCase item, as block-moves.json holds it: an absent key left out. */
type JsonItem = BlockItem & Record<string, unknown> & { title: string };
type DropCase = {
  name: string;
  item: JsonItem;
  from: BlockOrigin;
  target: BlockTarget;
  milestoneIds: string[] | null;
  expected: BlockDrop;
};
type Body = Record<string, unknown>;
type WriteCase = {
  name: string;
  write: Body | null;
  phoneRefusal: 'pause' | 'another-day' | null;
  status: number | null;
  error: string | null;
  updates: Record<string, unknown> | null;
  after: JsonItem | null;
};
type BlockDropWrites = { cases: WriteCase[] };

// ── The phone's mapping (design §5.5) ────────────────────────────────────────

function phoneWrite(drop: BlockDrop): Pick<WriteCase, 'write' | 'phoneRefusal'> {
  switch (drop.kind) {
    case 'place':
      return {
        write: { action: 'schedule', date: drop.date, startTime: startTimeOf(drop.startMin) },
        phoneRefusal: null,
      };
    case 'retime': {
      const startTime = startTimeOf(drop.startMin);
      return { write: { action: 'time', timeBucket: getBucketForTime(startTime), startTime }, phoneRefusal: null };
    }
    case 'anytime':
      // Another day's Anytime would be a move and a time, two writes that can land half (B22).
      return drop.date === null
        ? { write: { action: 'time', timeBucket: 'anytime', startTime: null }, phoneRefusal: null }
        : { write: null, phoneRefusal: 'another-day' };
    case 'braindump':
      return { write: { action: 'unschedule' }, phoneRefusal: null };
    case 'pause':
      // The phone's braindump never lists a paused habit, so it would vanish (B15).
      return { write: null, phoneRefusal: 'pause' };
    case 'none':
    case 'refused':
      return { write: null, phoneRefusal: null };
  }
}

// ── The route, over a mocked database ────────────────────────────────────────

let queries: Query[] = [];
let row: Record<string, unknown> | null = null;
let milestoneOf: string[] = [];

function from(table: string) {
  const q: Query = { table, calls: [] };
  queries.push(q);
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve()
              .then(() => respond(q))
              .then(resolve, reject);
        }
        return (...args: unknown[]) => {
          q.calls.push([String(prop), args]);
          return builder;
        };
      },
    },
  );
  return builder;
}

const called = (q: Query, method: string) => q.calls.filter(([m]) => m === method).map(([, args]) => args);
const op = (q: Query) => (['insert', 'update', 'delete', 'select'] as const).find((m) => called(q, m).length > 0);

function respond(q: Query): Result {
  if (q.table === 'item_events') return { data: null, error: null };
  // isLiveMilestone: the goals holding the item as a milestone, then the live ones among them.
  if (q.table === 'goal_items') return { data: milestoneOf.map((goal_id) => ({ goal_id })), error: null };
  if (q.table === 'goals') return { data: milestoneOf.map((id) => ({ id })), error: null };
  if (q.table !== 'items') return { data: null, error: { code: 'XX000', message: `unexpected ${q.table}` } };
  if (op(q) === 'update') return { data: null, error: null };
  return { data: row, error: null };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = () =>
  [b64({ alg: 'HS256' }), b64({ sub: USER, role: 'authenticated', exp: Date.now() / 1000 + 3600 }), 'sig'].join('.');

const post = (body: Body, id: string) =>
  POST(
    new Request(`https://do.dsul.app/api/app/items/${id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

/** Wait out the fire-and-forget event insert. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The row the route reads for `item`: every column an intent reads,
 * snake_case, as Postgres holds what itemFromRow mapped (app-item-write.test.ts
 * `rowFor`, the columns these four intents read).
 */
function rowFor(item: JsonItem): Record<string, unknown> {
  const i = item;
  return {
    id: item.id,
    type: itemTypeName(item as unknown as Item),
    parent_item_id: i.parentItemId ?? null,
    repeat_frequency: i.repeatFrequency ?? null,
    status: i.status ?? null,
    start_date: i.startDate ?? null,
    time_bucket: i.timeBucket ?? null,
    in_project_block: i.inProjectBlock ?? null,
    skipped_dates: i.skippedDates ?? [],
    daily_counts: i.dailyCounts ?? null,
    current_day_count: i.currentDayCount ?? null,
    paused_at: i.pausedAt ?? null,
    paused_until: i.pausedUntil ?? null,
    start_time: i.startTime ?? null,
    is_scheduled: i.isScheduled ?? null,
    duration: i.duration ?? null,
  };
}

/** A patch as the fixture holds it: a cleared column as an explicit null. */
const nulled = (patch: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v ?? null]));

/** `item` with `updates` applied: a cleared column left out, as the fixture's items are. */
function applied(item: JsonItem, updates: Record<string, unknown>): JsonItem {
  const next: Record<string, unknown> = { ...item };
  for (const [k, v] of Object.entries(updates)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next as JsonItem;
}

/**
 * `write` posted over `item`'s row: the route's status and error, and the
 * item updates and event inserts it made.
 */
async function send(write: Body, item: JsonItem, milestoneIds: string[] | null) {
  queries = [];
  row = rowFor(item);
  milestoneOf = milestoneIds?.includes(item.id) ? [GOAL] : [];
  const res = await post(write, item.id);
  await settle();
  const answered = (await res.json()) as { error?: string };
  return {
    status: res.status,
    error: answered.error ?? null,
    rows: queries.filter((q) => q.table === 'items' && op(q) === 'update'),
    events: queries.filter((q) => q.table === 'item_events' && op(q) === 'insert'),
  };
}

/** One case: the phone's body, and what the route answered and wrote. */
async function replay(c: DropCase): Promise<WriteCase> {
  const answer = planBlockDrop(c.item, c.from, c.target, { milestoneIds: c.milestoneIds && new Set(c.milestoneIds) });
  const { write, phoneRefusal } = phoneWrite(answer);
  const none = { name: c.name, write, phoneRefusal, status: null, error: null, updates: null, after: null };
  if (!write) return none;

  const { status, error, rows, events } = await send(write, c.item, c.milestoneIds);
  if (status !== 200) {
    expect(rows, c.name).toEqual([]);
    return { ...none, status, error };
  }

  const type = itemTypeName(c.item as unknown as Item);
  if (rows.length === 0) {
    // Already so: no write and no event.
    expect(events, c.name).toEqual([]);
    return { ...none, status: 200, updates: {}, after: c.item };
  }
  // One row update, and the one event the web's updateItem records beside it,
  // whose payload is the camelCase patch that update was made from.
  expect(rows, c.name).toHaveLength(1);
  expect(rows[0].calls, c.name).toEqual(expect.arrayContaining([['eq', ['id', c.item.id]], ['eq', ['type', type]]]));
  expect(events, c.name).toHaveLength(1);
  const event = called(events[0], 'insert')[0][0] as { action: string; payload: Record<string, unknown> };
  expect(event.action, c.name).toBe('update');
  const sent = called(rows[0], 'update')[0][0] as Record<string, unknown>;
  expect(sent, c.name).toEqual(updatesToRow(type, event.payload));
  // Every key of the patch reached a column: nothing was dropped on the way.
  expect(Object.keys(sent).length, c.name).toBe(Object.keys(event.payload).length);
  const updates = nulled(event.payload);
  return { ...none, status: 200, updates, after: applied(c.item, updates) };
}

// ── Writing and checking ─────────────────────────────────────────────────────

const serialize = (f: unknown) => JSON.stringify(f, null, 2) + '\n';

/**
 * The rows whose write lands as `{}`: the route finds the part of day and the
 * time already as sent, so the time chip's write changes nothing, while the
 * rule still reads something about the row that the write cannot reach (a
 * stashed slot, or a row under Anytime not marked scheduled). Nothing on
 * screen differs, and the phone draws them where they were. On the web the
 * same drops go through scheduleTask, which clears both.
 */
const UNMOVED = [
  'repeating task holding a stashed date: its own time',
  'one-off under Anytime, not on the grid: Anytime on its own day',
  'one-off under Anytime holding a stashed time: Anytime on its own day',
  'one-off under Anytime holding a stashed date: Anytime on its own day',
  'habit under Anytime holding a stashed time: Anytime on its own day',
];

describe('block drop writes shared with the iPhone', () => {
  let drops: DropCase[];
  let generated: BlockDropWrites;
  const byName = new Map<string, DropCase>();

  beforeAll(async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
    h.reportLiveCompletion.mockResolvedValue({ ok: true, skipped: true });
    h.createClient.mockImplementation(() => ({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: USER } }, error: null })) },
      from,
      rpc: vi.fn(async () => ({ data: null, error: null })),
    }));
    drops = (JSON.parse(readFileSync(MOVES, 'utf8')) as { cases: DropCase[] }).cases;
    for (const c of drops) byName.set(c.name, c);
    const cases: WriteCase[] = [];
    // Sequential: every case resets the one mocked database.
    for (const c of drops) cases.push(await replay(c));
    generated = JSON.parse(JSON.stringify({ cases })) as BlockDropWrites;
    if (process.env.UPDATE_FIXTURES) {
      mkdirSync(path.dirname(FILE), { recursive: true });
      writeFileSync(FILE, serialize(generated));
    }
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('block-drop-writes.json exists', () => {
    expect(existsSync(FILE), `missing ${FILE}; run with UPDATE_FIXTURES=1`).toBe(true);
  });

  it('block-drop-writes.json is what the route writes today', () => {
    // On drift: if the change is intended, regenerate (block-moves.json first)
    // and make the same change in the iPhone's drop mapping and its steps.
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(JSON.parse(serialize(generated)));
  });

  it('answers every case of block-moves.json once, in its order', () => {
    expect(generated.cases.map((c) => c.name)).toEqual(drops.map((c) => c.name));
    // The rule still answers what block-moves.json says, so the two fixtures can't drift apart.
    for (const c of drops) {
      const milestoneIds = c.milestoneIds && new Set(c.milestoneIds);
      expect(planBlockDrop(c.item, c.from, c.target, { milestoneIds }), c.name).toEqual(c.expected);
    }
  });

  it('reaches every write the phone makes, and every way it sends nothing', () => {
    const actions = new Set(generated.cases.flatMap((c) => (c.write ? [c.write.action] : [])));
    expect([...actions].sort()).toEqual(['schedule', 'time', 'unschedule']);
    const refusals = new Set(generated.cases.flatMap((c) => (c.phoneRefusal ? [c.phoneRefusal] : [])));
    expect([...refusals].sort()).toEqual(['another-day', 'pause']);
    expect(generated.cases.some((c) => !c.write && !c.phoneRefusal)).toBe(true);
    expect(generated.cases.some((c) => c.updates && Object.keys(c.updates).length === 0)).toBe(true);
  });

  it('the phone sends nothing for its own place, a refusal, a pause or another day’s Anytime', () => {
    for (const c of generated.cases) {
      const { expected } = byName.get(c.name)!;
      const sends =
        ['place', 'retime', 'braindump'].includes(expected.kind) ||
        (expected.kind === 'anytime' && expected.date === null);
      expect(c.write !== null, c.name).toBe(sends);
      if (!c.write) expect([c.status, c.error, c.updates, c.after], c.name).toEqual([null, null, null, null]);
      expect(c.phoneRefusal === 'pause', c.name).toBe(expected.kind === 'pause');
      expect(c.phoneRefusal === 'another-day', c.name).toBe(expected.kind === 'anytime' && expected.date !== null);
    }
  });

  it('no drop the phone takes comes back refused, but a subtask’s time', () => {
    for (const c of generated.cases) {
      if (!c.write) continue;
      const { item } = byName.get(c.name)!;
      if (item.parentItemId) {
        // The Time chip never edits a subtask (lib/item-edit.ts editRefusal). The
        // fixture's habit with a parent is the rule's edge; no surface draws one.
        expect([c.status, c.error], c.name).toEqual([400, 'not_for_subtask']);
        expect(c.write.action, c.name).toBe('time');
        continue;
      }
      expect([c.status, c.error], c.name).toEqual([200, null]);
    }
    expect(generated.cases.filter((c) => c.status === 400).length).toBeGreaterThan(0);
  });

  it('a series or a habit moves in time only: neither its body nor its write holds a date', () => {
    let count = 0;
    for (const c of generated.cases) {
      if (c.write?.action !== 'time') continue;
      count++;
      expect(Object.keys(c.write).sort(), c.name).toEqual(['action', 'startTime', 'timeBucket']);
      if (c.updates) expect(c.updates, c.name).not.toHaveProperty('startDate');
      if (c.after) expect(c.after.startDate, c.name).toBe(byName.get(c.name)!.item.startDate);
    }
    expect(count).toBeGreaterThan(0);
  });

  it('each write lands where the rule said', () => {
    for (const c of generated.cases) {
      if (!c.after) continue;
      const { expected, item } = byName.get(c.name)!;
      const a = c.after;
      switch (expected.kind) {
        case 'place': {
          const time = startTimeOf(expected.startMin);
          expect([a.startDate, a.startTime, a.timeBucket, a.isScheduled], c.name).toEqual([
            expected.date,
            time,
            getBucketForTime(time),
            true,
          ]);
          // Out of any project block, and its parked slot forgotten.
          expect([a.inProjectBlock, a.previousStartTime, a.previousStartDate], c.name).toEqual([
            false,
            undefined,
            undefined,
          ]);
          break;
        }
        case 'retime': {
          const time = startTimeOf(expected.startMin);
          expect([a.startTime, a.timeBucket], c.name).toEqual([time, getBucketForTime(time)]);
          expect(a.startDate, c.name).toBe(item.startDate);
          break;
        }
        case 'anytime':
          expect([a.timeBucket, a.startTime, a.startDate], c.name).toEqual(['anytime', undefined, item.startDate]);
          break;
        case 'braindump':
          expect([a.isScheduled, a.timeBucket, a.startTime, a.startDate], c.name).toEqual([
            false,
            undefined,
            undefined,
            undefined,
          ]);
          break;
        default:
          throw new Error(`${c.name}: a ${expected.kind} answer was written`);
      }
    }
  });

  it('after the write, the same drop is already there, but where the write changes nothing', () => {
    const unmoved: string[] = [];
    for (const c of generated.cases) {
      if (!c.after) continue;
      const { from, target, milestoneIds } = byName.get(c.name)!;
      const again = planBlockDrop(c.after, from, target, { milestoneIds: milestoneIds && new Set(milestoneIds) });
      if (again.kind === 'none') continue;
      unmoved.push(c.name);
      // The route found the row as sent and wrote nothing, so it is drawn where it was.
      expect(c.updates, c.name).toEqual({});
      expect(c.after, c.name).toEqual(byName.get(c.name)!.item);
    }
    expect(unmoved).toEqual(UNMOVED);
  });

  it('a retry: time and unschedule find the row already so, and schedule writes the same columns again', async () => {
    // The route's schedule never asks whether the row is already so (design
    // §6.2 keeps the intent as it is), so a retried drop that landed writes
    // its columns and records an event a second time. The row converges
    // either way; this pins today's shape so a change to it shows here.
    const seen = new Set<string>();
    for (const c of generated.cases) {
      if (!c.write || !c.after) continue;
      seen.add(String(c.write.action));
      const { status, error, rows, events } = await send(c.write, c.after, byName.get(c.name)!.milestoneIds);
      expect([status, error], c.name).toEqual([200, null]);
      if (c.write.action !== 'schedule') {
        expect([rows, events], c.name).toEqual([[], []]);
        continue;
      }
      expect(rows, c.name).toHaveLength(1);
      expect(events, c.name).toHaveLength(1);
      const event = called(events[0], 'insert')[0][0] as { payload: Record<string, unknown> };
      expect(nulled(event.payload), c.name).toEqual(c.updates);
    }
    expect([...seen].sort()).toEqual(['schedule', 'time', 'unschedule']);
  });

  it('the phone’s door fires no webhook', () => {
    expect(h.notifyPlugins).not.toHaveBeenCalled();
    // The route hands its webhook to after(), whose callbacks this file never
    // runs, so a webhook on this door shows as a queued callback, not a call.
    expect(h.after).not.toHaveBeenCalled();
  });
});
