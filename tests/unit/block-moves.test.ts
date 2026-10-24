import { describe, expect, it } from 'vitest';
import {
  planBlockDrop,
  startTimeOf,
  type BlockDrop,
  type BlockItem,
  type BlockTarget,
} from '@/lib/block-moves';

/**
 * The shared block drop rule (lib/block-moves.ts), row by row against the
 * Week and blocks design's move table (its §5.5).
 * Columns are capabilities, not types: a dated one-off, a dated series, and a
 * type with no date (habits today). A custom type is dated, so it answers as a
 * task does.
 */

const DAY = '2026-07-04';
const COLUMN = '2026-07-08';
const SERIES_START = '2026-07-01';
const MILESTONES: ReadonlySet<string> = new Set(['milestone']);

const task = (id: string, over: Partial<BlockItem> = {}): BlockItem => ({
  id,
  type: 'task',
  status: 'pending',
  isScheduled: true,
  startDate: DAY,
  timeBucket: 'morning',
  startTime: '09:00',
  inProjectBlock: false,
  completedDates: [],
  ...over,
});
const series = (id: string, over: Partial<BlockItem> = {}) =>
  task(id, { repeatFrequency: 'daily', startDate: SERIES_START, ...over });
const errand = (id: string, over: Partial<BlockItem> = {}) => task(id, { type: 'custom', customType: 'errand', ...over });
const habit = (id: string, over: Partial<BlockItem> = {}): BlockItem => ({
  id,
  type: 'habit',
  status: 'pending',
  repeatFrequency: 'daily',
  timeBucket: 'morning',
  startTime: '07:30',
  completedDates: [],
  ...over,
});

const ON_DAY = { date: DAY, skipped: false };
const hour = (date: string, startMin: number): BlockTarget => ({ kind: 'hour', date, startMin });
const anytime = (date: string): BlockTarget => ({ kind: 'anytime', date });
const BRAINDUMP: BlockTarget = { kind: 'braindump' };

const plan = (item: BlockItem, target: BlockTarget, milestoneIds: ReadonlySet<string> | null = MILESTONES) =>
  planBlockDrop(item, ON_DAY, target, { milestoneIds });

const place = (date: string, startMin: number): BlockDrop => ({ kind: 'place', date, startMin });
const retime = (startMin: number): BlockDrop => ({ kind: 'retime', startMin });
const refused = (reason: string) => ({ kind: 'refused', reason });
const NONE: BlockDrop = { kind: 'none' };

describe('planBlockDrop: an hour on its own day', () => {
  it('places a dated one-off on the day, at the time', () => {
    expect(plan(task('a'), hour(DAY, 615))).toEqual(place(DAY, 615));
    expect(plan(errand('e'), hour(DAY, 615))).toEqual(place(DAY, 615));
  });

  it('retimes a series, keeping its start date', () => {
    expect(plan(series('s'), hour(DAY, 600))).toEqual(retime(600));
    expect(plan(errand('es', { repeatFrequency: 'weekdays', startDate: SERIES_START }), hour(DAY, 600))).toEqual(
      retime(600)
    );
  });

  it('places a series inside a project block on its own start date, which releases it', () => {
    const inBlock = series('sb', { startTime: undefined, inProjectBlock: true });
    expect(plan(inBlock, hour(DAY, 600))).toEqual(place(SERIES_START, 600));
    // A legacy ISO start date is cut at 'T', as lib/day-items.ts reads it.
    expect(plan({ ...inBlock, startDate: `${SERIES_START}T00:00:00.000Z` }, hour(DAY, 600))).toEqual(
      place(SERIES_START, 600)
    );
  });

  it('retimes a habit, which has no date', () => {
    expect(plan(habit('h'), hour(DAY, 1200))).toEqual(retime(1200));
    expect(plan(habit('h', { timeBucket: 'anytime', startTime: undefined }), hour(DAY, 480))).toEqual(retime(480));
  });

  it('places a done, an in-block, a let-go and a milestone one-off as any one-off', () => {
    expect(plan(task('done', { status: 'completed' }), hour(DAY, 660))).toEqual(place(DAY, 660));
    expect(plan(task('blk', { inProjectBlock: true, startTime: undefined }), hour(DAY, 540))).toEqual(place(DAY, 540));
    expect(plan(task('gone', { status: 'cancelled' }), hour(DAY, 660))).toEqual(place(DAY, 660));
    expect(plan(task('milestone'), hour(DAY, 660))).toEqual(place(DAY, 660));
  });

  it('places a row from the braindump, dated or not, on the day', () => {
    const loose = task('loose', { isScheduled: false, startDate: undefined, timeBucket: undefined, startTime: undefined });
    expect(plan(loose, hour(DAY, 540))).toEqual(place(DAY, 540));
    expect(plan({ ...loose, startDate: DAY }, hour(DAY, 540))).toEqual(place(DAY, 540));
    // A series with no start date is drawn on no day, so the drop gives it one.
    expect(plan({ ...loose, repeatFrequency: 'daily' }, hour(DAY, 540))).toEqual(place(DAY, 540));
  });
});

describe('planBlockDrop: an hour in another column (Week)', () => {
  it('places a dated one-off on the column', () => {
    expect(plan(task('a'), hour(COLUMN, 840))).toEqual(place(COLUMN, 840));
    expect(plan(errand('e'), hour(COLUMN, 840))).toEqual(place(COLUMN, 840));
  });

  it('retimes a series and a habit on their own day', () => {
    expect(plan(series('s'), hour(COLUMN, 840))).toEqual(retime(840));
    expect(plan(habit('h'), hour(COLUMN, 840))).toEqual(retime(840));
  });
});

describe('planBlockDrop: Anytime', () => {
  it('takes anything out of its time on its own day', () => {
    expect(plan(task('a'), anytime(DAY))).toEqual({ kind: 'anytime', date: null });
    expect(plan(series('s'), anytime(DAY))).toEqual({ kind: 'anytime', date: null });
    expect(plan(habit('h'), anytime(DAY))).toEqual({ kind: 'anytime', date: null });
    expect(plan(errand('e'), anytime(DAY))).toEqual({ kind: 'anytime', date: null });
  });

  it('refuses a task inside a project block', () => {
    expect(plan(task('blk', { inProjectBlock: true, startTime: undefined }), anytime(DAY))).toEqual(refused('in-block'));
    expect(plan(series('sb', { inProjectBlock: true }), anytime(DAY))).toEqual(refused('in-block'));
  });

  it("moves a dated one-off to another column's Anytime", () => {
    expect(plan(task('a'), anytime(COLUMN))).toEqual({ kind: 'anytime', date: COLUMN });
    expect(plan(errand('e'), anytime(COLUMN))).toEqual({ kind: 'anytime', date: COLUMN });
  });

  it("refuses another column's Anytime for a series and a habit", () => {
    expect(plan(series('s'), anytime(COLUMN))).toEqual(refused('another-day'));
    expect(plan(habit('h'), anytime(COLUMN))).toEqual(refused('another-day'));
  });

  it('gives a row with no date the day it was dropped on', () => {
    const loose = task('loose', { isScheduled: false, startDate: undefined, timeBucket: undefined, startTime: undefined });
    expect(plan(loose, anytime(DAY))).toEqual({ kind: 'anytime', date: DAY });
  });
});

describe('planBlockDrop: the braindump', () => {
  it('sends a dated one-off back, behind Move to Braindump', () => {
    expect(plan(task('a'), BRAINDUMP)).toEqual({ kind: 'braindump' });
    expect(plan(errand('e'), BRAINDUMP)).toEqual({ kind: 'braindump' });
    expect(plan(task('anytime', { timeBucket: 'anytime', startTime: undefined }), BRAINDUMP)).toEqual({
      kind: 'braindump',
    });
  });

  it('refuses what Move to Braindump refuses', () => {
    expect(plan(series('s'), BRAINDUMP)).toEqual(refused('not-braindump'));
    expect(plan(series('sb', { inProjectBlock: true }), BRAINDUMP)).toEqual(refused('not-braindump'));
    expect(plan(task('done', { status: 'completed' }), BRAINDUMP)).toEqual(refused('not-braindump'));
    expect(plan(task('gone', { status: 'cancelled' }), BRAINDUMP)).toEqual(refused('not-braindump'));
    expect(plan(task('blk', { inProjectBlock: true }), BRAINDUMP)).toEqual(refused('not-braindump'));
    expect(plan(task('milestone'), BRAINDUMP)).toEqual(refused('not-braindump'));
    expect(plan(errand('es', { repeatFrequency: 'weekdays' }), BRAINDUMP)).toEqual(refused('not-braindump'));
  });

  it('asks what the verb and the server ask beside it: a day to take away, never a subtask', () => {
    // lib/verb-gates.ts's braindump gate wants a start date; lib/item-intents.ts
    // applyUnschedule refuses a subtask. Neither row is drawn on the web's canvas.
    expect(plan(task('undated', { startDate: undefined }), BRAINDUMP)).toEqual(refused('not-braindump'));
    expect(plan(task('sub', { parentItemId: 'a' }), BRAINDUMP)).toEqual(refused('not-braindump'));
    expect(plan(task('sub', { parentItemId: 'a' }), BRAINDUMP, null)).toEqual(refused('milestones-unknown'));
  });

  it('refuses while the milestones are unknown, and answers once they are', () => {
    expect(plan(task('a'), BRAINDUMP, null)).toEqual(refused('milestones-unknown'));
    expect(plan(task('a'), BRAINDUMP, new Set())).toEqual({ kind: 'braindump' });
    expect(plan(task('milestone'), BRAINDUMP, new Set())).toEqual({ kind: 'braindump' });
  });

  it('pauses a habit, and refuses one the registry will not pause', () => {
    expect(plan(habit('h'), BRAINDUMP)).toEqual({ kind: 'pause' });
    expect(plan(habit('h'), BRAINDUMP, null)).toEqual({ kind: 'pause' });
    expect(plan(habit('sub', { parentItemId: 'parent' }), BRAINDUMP)).toEqual(refused('not-pausable'));
  });

  it('leaves a row the braindump already lists where it is', () => {
    const loose = task('loose', { isScheduled: false, startDate: undefined, timeBucket: undefined, startTime: undefined });
    expect(plan(loose, BRAINDUMP)).toEqual(NONE);
    expect(plan({ ...loose, startDate: DAY }, BRAINDUMP)).toEqual(NONE);
    expect(plan({ ...loose, repeatFrequency: 'daily', startDate: DAY }, BRAINDUMP)).toEqual(NONE);
    expect(plan(habit('h', { repeatFrequency: 'none', timeBucket: undefined, startTime: undefined }), BRAINDUMP)).toEqual(
      NONE
    );
  });

  it('does not count a let-go row as listed, since the braindump leaves it out', () => {
    const letGo = task('gone', { isScheduled: false, timeBucket: undefined, startTime: undefined, status: 'cancelled' });
    expect(plan(letGo, BRAINDUMP)).toEqual(refused('not-braindump'));
  });
});

describe('planBlockDrop: a series still in the braindump is not a block', () => {
  // It is drawn on no day, so the drop gives it the day it lands on, as the
  // web's braindump-to-grid drop does (resolveDrop, a row from the braindump).
  const dumped = series('dumped', { isScheduled: false, timeBucket: undefined, startTime: undefined });

  it('is placed on the hour it is dropped on, in any column', () => {
    expect(plan(dumped, hour(DAY, 615))).toEqual(place(DAY, 615));
    expect(plan(dumped, hour(COLUMN, 840))).toEqual(place(COLUMN, 840));
  });

  it("moves to the day of the Anytime it is dropped on", () => {
    expect(plan(dumped, anytime(COLUMN))).toEqual({ kind: 'anytime', date: COLUMN });
  });

  it('stays where it is on the braindump', () => {
    expect(plan(dumped, BRAINDUMP)).toEqual(NONE);
  });

  it('keeps its start date once it is filed under a part of day, though not marked scheduled', () => {
    // assignTaskToBucket leaves isScheduled false and a bucket: drawn, so a block.
    expect(plan({ ...dumped, timeBucket: 'morning' }, hour(COLUMN, 840))).toEqual(retime(840));
  });
});

describe('planBlockDrop: its own place', () => {
  it('is nothing to do', () => {
    expect(plan(task('a'), hour(DAY, 540))).toEqual(NONE);
    expect(plan(series('s'), hour(DAY, 540))).toEqual(NONE);
    expect(plan(series('s'), hour(COLUMN, 540))).toEqual(NONE);
    expect(plan(habit('h'), hour(DAY, 450))).toEqual(NONE);
    expect(plan(task('any', { timeBucket: 'anytime', startTime: undefined }), anytime(DAY))).toEqual(NONE);
    expect(plan(habit('h', { timeBucket: 'anytime', startTime: undefined }), anytime(DAY))).toEqual(NONE);
  });

  it('is a move when anything the drop writes would change', () => {
    // Stored under the wrong part of day: the drop files it under the hour's.
    expect(plan(task('a', { timeBucket: 'afternoon' }), hour(DAY, 540))).toEqual(place(DAY, 540));
    // Not yet on the grid, or holding a block's stashed time.
    expect(plan(task('a', { isScheduled: false }), hour(DAY, 540))).toEqual(place(DAY, 540));
    expect(plan(task('a', { previousStartTime: '08:00' }), hour(DAY, 540))).toEqual(place(DAY, 540));
    expect(plan(series('s', { previousStartDate: '2026-06-30' }), hour(DAY, 540))).toEqual(retime(540));
    // A legacy ISO date is written back clean.
    expect(plan(task('a', { startDate: `${DAY}T00:00:00.000Z` }), hour(DAY, 540))).toEqual(place(DAY, 540));
    expect(plan(task('a', { isScheduled: false, timeBucket: 'anytime', startTime: undefined }), anytime(DAY))).toEqual({
      kind: 'anytime',
      date: null,
    });
  });
});

describe('planBlockDrop: never', () => {
  it('moves a skipped occurrence', () => {
    const skipped = { date: DAY, skipped: true };
    for (const target of [hour(DAY, 600), hour(COLUMN, 600), anytime(DAY), anytime(COLUMN), BRAINDUMP]) {
      for (const item of [task('a'), series('s'), habit('h')]) {
        expect(planBlockDrop(item, skipped, target, { milestoneIds: MILESTONES })).toEqual(refused('skipped'));
      }
    }
  });

  it('takes an hour outside the day', () => {
    for (const startMin of [-15, 1440, 600.5, Number.NaN]) {
      expect(plan(task('a'), hour(DAY, startMin))).toEqual(refused('invalid'));
      expect(plan(habit('h'), hour(DAY, startMin))).toEqual(refused('invalid'));
    }
    expect(plan(task('a'), hour(DAY, 0))).toEqual(place(DAY, 0));
    expect(plan(task('a'), hour(DAY, 1439))).toEqual(place(DAY, 1439));
  });
});

describe('startTimeOf', () => {
  it('writes minutes after midnight as the stored clock', () => {
    expect(startTimeOf(0)).toBe('00:00');
    expect(startTimeOf(615)).toBe('10:15');
    expect(startTimeOf(1439)).toBe('23:59');
  });
});
