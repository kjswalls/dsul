import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import {
  planBlockDrop,
  type BlockDrop,
  type BlockDropRefusal,
  type BlockItem,
  type BlockOrigin,
  type BlockTarget,
} from '@/lib/block-moves';

/**
 * The block drop rule, shared with the iPhone.
 *
 * Writes tests/fixtures/day/block-moves.json from the real lib/block-moves.ts:
 * every row of the Week and blocks design's move table (§5.5) for a one-off, a
 * repeating task, a repeating task in a project block, a habit, a done one-off,
 * an in-block one-off, a milestone, a row already in the braindump, a skipped
 * occurrence and a custom dated type, with the edges beside them. DsulCore's
 * BlockMoves.swift is checked against it (BlockMovesFixtureTests.swift).
 *
 * Each case: `item` (the app's camelCase item, an absent key left out), `from`
 * (the day the block was drawn on, and whether that occurrence is skipped),
 * `target` (an hour, an Anytime, or the braindump), `milestoneIds` (sorted, or
 * null while unknown), and `expected`, planBlockDrop's answer.
 *
 * Regenerate after an intended change:
 *   UPDATE_FIXTURES=1 pnpm exec vitest run tests/unit/block-moves-fixtures.test.ts
 */

const FILE = path.join(__dirname, '..', 'fixtures', 'day', 'block-moves.json');

const DAY = '2026-07-04';
const COLUMN = '2026-07-08';
const SERIES_START = '2026-07-01';

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

type Case = {
  name: string;
  item: BlockItem & Record<string, unknown>;
  from: BlockOrigin;
  target: BlockTarget;
  milestoneIds: string[] | null;
  expected: BlockDrop;
};
type BlockMovesFixture = { cases: Case[] };

const MILESTONE = uid(908);

const task = (n: number, title: string, over: Record<string, unknown> = {}) =>
  ({
    type: 'task',
    id: uid(n),
    title,
    status: 'pending',
    isScheduled: true,
    order: 0,
    startDate: DAY,
    timeBucket: 'morning',
    startTime: '09:00',
    duration: 30,
    inProjectBlock: false,
    completedDates: [],
    skippedDates: [],
    ...over,
  }) as BlockItem & Record<string, unknown>;
const custom = (n: number, title: string, over: Record<string, unknown> = {}) =>
  task(n, title, { type: 'custom', customType: 'errand', ...over });
const habit = (n: number, title: string, over: Record<string, unknown> = {}) =>
  ({
    type: 'habit',
    id: uid(n),
    title,
    streak: 0,
    status: 'pending',
    repeatFrequency: 'daily',
    timeBucket: 'morning',
    startTime: '07:30',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    ...over,
  }) as BlockItem & Record<string, unknown>;

const UNPLACED = { isScheduled: false, timeBucket: undefined, startTime: undefined };

/** The items, each with the minute of its own time (540, nine, for one with none). */
const ITEMS: [string, BlockItem & Record<string, unknown>, number][] = [
  ['one-off', task(901, 'post the letter'), 540],
  ['repeating task', task(902, 'water plants', { repeatFrequency: 'daily', startDate: SERIES_START }), 540],
  [
    'repeating task in a project block',
    task(903, 'standup notes', {
      repeatFrequency: 'weekdays',
      startDate: SERIES_START,
      startTime: undefined,
      inProjectBlock: true,
      project: 'Work',
      previousStartTime: '08:00',
      previousStartDate: '2026-06-30',
    }),
    540,
  ],
  ['habit', habit(904, 'stretch'), 450],
  ['untimed habit', habit(905, 'read', { timeBucket: 'anytime', startTime: undefined }), 540],
  ['done one-off', task(906, 'call the bank', { status: 'completed' }), 540],
  [
    'in-block one-off',
    task(907, 'draft the brief', { startTime: undefined, inProjectBlock: true, project: 'Work' }),
    540,
  ],
  ['milestone', task(908, 'first 10K', { timeBucket: 'anytime', startTime: undefined }), 540],
  ['row in the braindump', task(909, 'idea', { ...UNPLACED, startDate: undefined }), 540],
  ['dated row in the braindump', task(910, 'dentist', { ...UNPLACED }), 540],
  ['custom one-off', custom(911, 'post office'), 540],
  ['custom repeating', custom(912, 'market run', { repeatFrequency: 'weekdays', startDate: SERIES_START }), 540],
  ['let-go one-off', task(913, 'old plan', { status: 'cancelled' }), 540],
  ['one-off under Anytime', task(914, 'tidy desk', { timeBucket: 'anytime', startTime: undefined }), 540],
  [
    'repeating task with no start date',
    task(915, 'floss', { repeatFrequency: 'daily', startDate: undefined, isScheduled: false }),
    540,
  ],
  ['one-off with a legacy ISO date', task(916, 'renew pass', { startDate: `${DAY}T00:00:00.000Z` }), 540],
  ['habit subtask', habit(917, 'warm up', { parentItemId: uid(904) }), 450],
];

function buildCases(): Case[] {
  const cases: Case[] = [];
  const add = (name: string, item: Case['item'], from: BlockOrigin, target: BlockTarget, milestoneIds: string[] | null) =>
    cases.push({
      name,
      item,
      from,
      target,
      milestoneIds,
      expected: planBlockDrop(item, from, target, { milestoneIds: milestoneIds && new Set(milestoneIds) }),
    });
  const onDay: BlockOrigin = { date: DAY, skipped: false };
  const known = [MILESTONE];

  for (const [label, item, ownMin] of ITEMS) {
    add(`${label}: a new hour on its own day`, item, onDay, { kind: 'hour', date: DAY, startMin: 615 }, known);
    const own = item.startTime ? 'its own time' : 'nine, having no time of its own';
    add(`${label}: ${own}`, item, onDay, { kind: 'hour', date: DAY, startMin: ownMin }, known);
    add(`${label}: an hour in another column`, item, onDay, { kind: 'hour', date: COLUMN, startMin: 840 }, known);
    add(`${label}: an evening hour`, item, onDay, { kind: 'hour', date: DAY, startMin: 1155 }, known);
    add(`${label}: Anytime on its own day`, item, onDay, { kind: 'anytime', date: DAY }, known);
    add(`${label}: Anytime in another column`, item, onDay, { kind: 'anytime', date: COLUMN }, known);
    add(`${label}: the braindump`, item, onDay, { kind: 'braindump' }, known);
  }

  // A skipped occurrence never moves, whatever the target.
  const skippedSeries = task(918, 'run', { repeatFrequency: 'daily', startDate: SERIES_START, skippedDates: [DAY] });
  const skipped: BlockOrigin = { date: DAY, skipped: true };
  add('skipped occurrence: a new hour', skippedSeries, skipped, { kind: 'hour', date: DAY, startMin: 615 }, known);
  add('skipped occurrence: another column', skippedSeries, skipped, { kind: 'hour', date: COLUMN, startMin: 840 }, known);
  add('skipped occurrence: Anytime', skippedSeries, skipped, { kind: 'anytime', date: DAY }, known);
  add('skipped occurrence: the braindump', skippedSeries, skipped, { kind: 'braindump' }, known);
  add('skipped habit: a new hour', habit(919, 'journal', { skippedDates: [DAY] }), skipped, {
    kind: 'hour',
    date: DAY,
    startMin: 615,
  }, known);
  // Skipped on another day only: the occurrence lifted is not.
  add('repeating task skipped on another day: a new hour', { ...skippedSeries, skippedDates: [COLUMN] }, onDay, {
    kind: 'hour',
    date: COLUMN,
    startMin: 480,
  }, known);

  // The milestone ids: unknown, and known but empty.
  const [, oneOff] = ITEMS[0];
  const [, milestone] = ITEMS[7];
  add('one-off: the braindump while milestones are unknown', oneOff, onDay, { kind: 'braindump' }, null);
  add('milestone: the braindump while milestones are unknown', milestone, onDay, { kind: 'braindump' }, null);
  add('milestone: the braindump once no goal holds it', milestone, onDay, { kind: 'braindump' }, []);
  add('habit: the braindump while milestones are unknown', ITEMS[3][1], onDay, { kind: 'braindump' }, null);

  // Hours outside the day, and its edges.
  for (const startMin of [-15, 1440]) {
    add(`one-off: minute ${startMin}`, oneOff, onDay, { kind: 'hour', date: DAY, startMin }, known);
    add(`habit: minute ${startMin}`, ITEMS[3][1], onDay, { kind: 'hour', date: DAY, startMin }, known);
  }
  add('one-off: midnight', oneOff, onDay, { kind: 'hour', date: DAY, startMin: 0 }, known);
  add('one-off: the last minute', oneOff, onDay, { kind: 'hour', date: DAY, startMin: 1439 }, known);
  add('one-off: noon', oneOff, onDay, { kind: 'hour', date: DAY, startMin: 720 }, known);
  add('one-off: five in the afternoon', oneOff, onDay, { kind: 'hour', date: DAY, startMin: 1020 }, known);

  // Its own place, but stored where the drop would write something else.
  add('one-off filed under the wrong part of day: its own time', task(920, 'pay rent', { timeBucket: 'afternoon' }), onDay, {
    kind: 'hour',
    date: DAY,
    startMin: 540,
  }, known);
  add('one-off holding a stashed time: its own time', task(921, 'gym bag', { previousStartTime: '08:00' }), onDay, {
    kind: 'hour',
    date: DAY,
    startMin: 540,
  }, known);
  add('repeating task holding a stashed date: its own time', task(922, 'vitamins', {
    repeatFrequency: 'daily',
    startDate: SERIES_START,
    previousStartDate: '2026-06-30',
  }), onDay, { kind: 'hour', date: DAY, startMin: 540 }, known);
  add('one-off under Anytime, not on the grid: Anytime on its own day', task(923, 'sort mail', {
    isScheduled: false,
    timeBucket: 'anytime',
    startTime: undefined,
  }), onDay, { kind: 'anytime', date: DAY }, known);

  // Anytime's own place asks for no stash, either.
  const underAnytime = { timeBucket: 'anytime', startTime: undefined };
  const ownAnytime: BlockTarget = { kind: 'anytime', date: DAY };
  add('one-off under Anytime holding a stashed time: Anytime on its own day', task(924, 'water the fern', {
    ...underAnytime,
    previousStartTime: '08:00',
  }), onDay, ownAnytime, known);
  add('one-off under Anytime holding a stashed date: Anytime on its own day', task(925, 'file receipts', {
    ...underAnytime,
    previousStartDate: '2026-06-30',
  }), onDay, ownAnytime, known);
  add('habit under Anytime holding a stashed time: Anytime on its own day', habit(926, 'breathe', {
    ...underAnytime,
    previousStartTime: '07:00',
  }), onDay, ownAnytime, known);

  // A habit with no part of day: the braindump lists it only when it does not repeat.
  const braindump: BlockTarget = { kind: 'braindump' };
  const noPart = { timeBucket: undefined, startTime: undefined };
  add('repeating habit with no part of day: the braindump', habit(927, 'hydrate', noPart), onDay, braindump, known);
  add('habit that does not repeat, with no part of day: the braindump', habit(928, 'try yoga', {
    ...noPart,
    repeatFrequency: 'none',
  }), onDay, braindump, known);
  add('repeating habit subtask with no part of day: the braindump', habit(929, 'refill bottle', {
    ...noPart,
    parentItemId: uid(927),
  }), onDay, braindump, known);

  // Move to Braindump beyond canSendToBraindump: the braindump lists no let-go
  // row, the verb takes only a row with a day, the server never a subtask.
  add('let-go row in the braindump: the braindump', task(930, 'old idea', { ...UNPLACED, status: 'cancelled' }), onDay, braindump, known);
  add('one-off with a part of day and no date: the braindump', task(931, 'call back', { startDate: undefined }), onDay, braindump, known);
  add('one-off subtask: the braindump', task(932, 'buy stamps', { parentItemId: uid(901) }), onDay, braindump, known);

  // A series still in the braindump is not a block: the drop gives it the day
  // it lands on, as the web's braindump-to-grid drop does.
  const dumped = task(933, 'stretch calves', { ...UNPLACED, repeatFrequency: 'daily', startDate: SERIES_START });
  add('repeating task in the braindump with a start date: an hour in another column', dumped, onDay, {
    kind: 'hour',
    date: COLUMN,
    startMin: 840,
  }, known);
  add('repeating task in the braindump with a start date: Anytime in another column', dumped, onDay, {
    kind: 'anytime',
    date: COLUMN,
  }, known);
  add('repeating task in the braindump with a start date: the braindump', dumped, onDay, braindump, known);

  return asJson(cases);
}

/** As the fixture holds it: an absent key left out, as on the wire. */
const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const serialize = (f: unknown) => JSON.stringify(f, null, 2) + '\n';

describe('block moves shared with DsulCore', () => {
  const generated: BlockMovesFixture = { cases: buildCases() };

  if (process.env.UPDATE_FIXTURES) {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE, serialize(generated));
  }

  it('block-moves.json exists', () => {
    expect(existsSync(FILE), `missing ${FILE}; run with UPDATE_FIXTURES=1`).toBe(true);
  });

  it('block-moves.json has cases with unique names', () => {
    expect(generated.cases.length).toBeGreaterThan(0);
    const names = generated.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('block-moves.json is what the TS answers today', () => {
    // On drift: if the TS change is intended, regenerate with UPDATE_FIXTURES=1
    // and make the same change in ios/DsulCore/Sources/DsulCore/BlockMoves.swift.
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(JSON.parse(serialize(generated)));
  });

  it('every case answers the same from the item as the fixture holds it', () => {
    for (const c of generated.cases) {
      const milestoneIds = c.milestoneIds && new Set(c.milestoneIds);
      expect(planBlockDrop(c.item, c.from, c.target, { milestoneIds }), c.name).toEqual(c.expected);
    }
  });

  it('the cases reach every answer and every refusal', () => {
    const kinds = new Set(generated.cases.map((c) => c.expected.kind));
    expect([...kinds].sort()).toEqual(['anytime', 'braindump', 'none', 'pause', 'place', 'refused', 'retime']);
    const reasons = new Set(
      generated.cases.flatMap((c) => (c.expected.kind === 'refused' ? [c.expected.reason] : []))
    );
    const all: BlockDropRefusal[] = [
      'another-day',
      'in-block',
      'invalid',
      'milestones-unknown',
      'not-braindump',
      'not-pausable',
      'skipped',
    ];
    expect([...reasons].sort()).toEqual(all);
    const dates = generated.cases.flatMap((c) => (c.expected.kind === 'anytime' ? [c.expected.date] : []));
    expect(dates).toContain(null);
    expect(dates).toContain(COLUMN);
  });

  it('a repeating block never takes another date, and a one-off always lands where it is drawn', () => {
    for (const c of generated.cases) {
      // A dated series on the canvas (a series still in the braindump is not a block yet).
      const placed = !!c.item.isScheduled || !!c.item.timeBucket;
      const repeats = !!c.item.repeatFrequency && c.item.repeatFrequency !== 'none' && !!c.item.startDate && placed;
      if (repeats && c.expected.kind === 'place') {
        expect(c.expected.date, c.name).toBe(c.item.startDate!.split('T')[0]);
      }
      if (repeats && c.expected.kind === 'anytime') expect(c.expected.date, c.name).toBeNull();
      if (c.item.type !== 'habit' && !repeats && c.target.kind === 'hour' && c.expected.kind === 'place') {
        expect(c.expected.date, c.name).toBe(c.target.date);
      }
    }
  });
});
