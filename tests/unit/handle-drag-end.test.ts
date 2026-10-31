import { describe, it, expect, vi } from 'vitest';
import {
  listGroupMovers,
  parseProjectBlockId,
  placementOf,
  resolveDrop,
  type DropCommand,
  type DropContext,
} from '@/lib/dnd/handle-drag-end';
import { atlasCardDropId, atlasRowDragId, atlasSourceOf, dragItemIdOf, parseAtlasCardDropId } from '@/lib/dnd/atlas-ids';
import { scheduleHabitPatch, scheduleTaskPatch, UNSCHEDULE_TASK_PATCH } from '@/lib/item-edit';
import type { Item } from '@/lib/planner-types';

function ctx(overrides: Partial<DropContext> = {}): DropContext {
  return {
    itemType: 'task',
    // Noon UTC in UTC resolves to 2026-07-04 — the day-string the existing
    // assertions below expect. resolveDrop derives it via toDateStr(date, tz).
    selectedDate: new Date('2026-07-04T12:00:00Z'),
    userTimezone: 'UTC',
    // A cursor drag, so this file keeps asserting the FULL grammar. The one
    // target a finger is not offered, and the fact that every other one is
    // unchanged for it, live in dnd-touch-drop-targets.test.ts.
    input: 'pointer',
    getRefTime: () => undefined,
    inferDropTime: (bucket, position, refTime) => refTime ?? '09:00',
    ...overrides,
  };
}

describe('resolveDrop — droppable ID grammar (lib/dnd/CONTRACT.md)', () => {
  it('ignores drops when the dragged item is unknown', () => {
    expect(resolveDrop('t1', 'morning', ctx({ itemType: null }))).toBeNull();
  });

  it('ignores unrecognized target ids', () => {
    expect(resolveDrop('t1', 'garbage:target', ctx())).toBeNull();
  });

  describe('scheduled:{bucket}:{pos}:{refType}:{refId}', () => {
    it('schedules a task with a time inferred from the reference item', () => {
      const getRefTime = vi.fn().mockReturnValue('10:30');
      const inferDropTime = vi.fn().mockReturnValue('10:45');
      const cmd = resolveDrop(
        't1',
        'scheduled:morning:after:task:t2',
        ctx({ getRefTime, inferDropTime })
      );
      expect(getRefTime).toHaveBeenCalledWith('task', 't2');
      expect(inferDropTime).toHaveBeenCalledWith('morning', 'after', '10:30');
      expect(cmd).toEqual({
        kind: 'schedule-task',
        taskId: 't1',
        bucket: 'morning',
        time: '10:45',
        dateStr: '2026-07-04',
      });
    });

    it('handles the empty position without a reference item', () => {
      const inferDropTime = vi.fn().mockReturnValue('14:00');
      const cmd = resolveDrop('t1', 'scheduled:afternoon:empty', ctx({ inferDropTime }));
      expect(inferDropTime).toHaveBeenCalledWith('afternoon', 'empty');
      expect(cmd).toMatchObject({ kind: 'schedule-task', bucket: 'afternoon', time: '14:00' });
    });

    it('schedules habits with a time but no date', () => {
      const cmd = resolveDrop(
        'h1',
        'scheduled:evening:before:habit:h2',
        ctx({ itemType: 'habit', getRefTime: () => '19:00' })
      );
      expect(cmd).toEqual({ kind: 'schedule-habit', habitId: 'h1', bucket: 'evening', time: '19:00' });
    });
  });

  describe('bare bucket + unscheduled:{bucket}', () => {
    it.each(['anytime', 'morning', 'afternoon', 'evening'] as const)(
      'assigns a task to %s without a time',
      (bucket) => {
        expect(resolveDrop('t1', bucket, ctx())).toEqual({
          kind: 'schedule-task',
          taskId: 't1',
          bucket,
          dateStr: '2026-07-04',
        });
      }
    );

    it('assigns habits to the bucket without scheduling', () => {
      expect(resolveDrop('h1', 'morning', ctx({ itemType: 'habit' }))).toEqual({
        kind: 'assign-habit-bucket',
        habitId: 'h1',
        bucket: 'morning',
      });
    });

    it('treats unscheduled:{bucket} the same as the bare bucket', () => {
      expect(resolveDrop('t1', 'unscheduled:evening', ctx())).toMatchObject({
        kind: 'schedule-task',
        bucket: 'evening',
      });
      expect(resolveDrop('h1', 'unscheduled:evening', ctx({ itemType: 'habit' }))).toMatchObject({
        kind: 'assign-habit-bucket',
        bucket: 'evening',
      });
    });
  });

  describe('sidebar', () => {
    it('unschedules the dropped item', () => {
      expect(resolveDrop('t1', 'sidebar', ctx())).toEqual({ kind: 'unschedule', itemId: 't1' });
    });

    it('pauses a habit from the canvas, and leaves one already in the braindump', () => {
      expect(
        resolveDrop('h1', 'sidebar', ctx({ itemType: 'habit', draggedPlacement: { placed: true, recurring: true } }))
      ).toEqual({ kind: 'pause-item', itemId: 'h1' });
      expect(
        resolveDrop('h1', 'sidebar', ctx({ itemType: 'habit', draggedPlacement: { placed: false } }))
      ).toBeNull();
      expect(resolveDrop('h1', 'sidebar', ctx({ itemType: 'habit' }))).toBeNull();
    });
  });

  describe('projectblock:{date}:{name}', () => {
    it('moves a task into its own project block', () => {
      const cmd = resolveDrop('t1', 'projectblock:2026-07-06:Website', ctx({ draggedTaskProject: 'Website' }));
      expect(cmd).toEqual({ kind: 'move-task-to-project-block', taskId: 't1' });
    });

    it('rejects tasks from other projects and habits', () => {
      expect(resolveDrop('t1', 'projectblock:2026-07-06:Website', ctx({ draggedTaskProject: 'Other' }))).toBeNull();
      expect(resolveDrop('h1', 'projectblock:2026-07-06:Website', ctx({ itemType: 'habit' }))).toBeNull();
    });

    it('keeps a colon in the project name, and refuses the undated form', () => {
      expect(parseProjectBlockId('projectblock:2026-07-06:Q3: launch')).toEqual({
        dateStr: '2026-07-06',
        projectName: 'Q3: launch',
      });
      // The pre-#214 id: one per project, so seven week columns shared it.
      expect(parseProjectBlockId('projectblock:Website')).toBeNull();
      expect(resolveDrop('t1', 'projectblock:Website', ctx({ draggedTaskProject: 'Website' }))).toBeNull();
    });
  });


  describe('hour:{H} (day-schedule drop-on-hour)', () => {
    it('schedules a task at the top of the hour in the owning bucket', () => {
      expect(resolveDrop('t1', 'hour:9', ctx())).toEqual({
        kind: 'schedule-task',
        taskId: 't1',
        bucket: 'morning',
        time: '09:00',
        dateStr: '2026-07-04',
      });
      expect(resolveDrop('t1', 'hour:14', ctx())).toMatchObject({ bucket: 'afternoon', time: '14:00' });
      expect(resolveDrop('t1', 'hour:21', ctx())).toMatchObject({ bucket: 'evening', time: '21:00' });
    });

    it('schedules habits with the hour time', () => {
      expect(resolveDrop('h1', 'hour:7', ctx({ itemType: 'habit' }))).toEqual({
        kind: 'schedule-habit',
        habitId: 'h1',
        bucket: 'morning',
        time: '07:00',
      });
    });

    it('rejects out-of-range hours', () => {
      expect(resolveDrop('t1', 'hour:24', ctx())).toBeNull();
      expect(resolveDrop('t1', 'hour:x', ctx())).toBeNull();
    });
  });

  describe('day-view drop date is resolved in the USER timezone', () => {
    // Regression: the drop date used to be pre-formatted with date-fns in the
    // MACHINE timezone, while the day is derived with toDateStr in the user's
    // saved timezone. When the two disagreed, a drop on "today" landed on an
    // adjacent day. resolveDrop now owns the conversion, so it must key off the
    // user's timezone — proven with an instant that straddles the date line.
    const lateUtc = new Date('2026-07-04T23:30:00Z'); // 11:30pm UTC

    it('uses the user timezone, not UTC/machine, for the dropped day', () => {
      // Same instant, two saved timezones → two different calendar days.
      expect(
        resolveDrop('t1', 'hour:9', ctx({ selectedDate: lateUtc, userTimezone: 'UTC' }))
      ).toMatchObject({ dateStr: '2026-07-04' });

      // Tokyo (UTC+9): 11:30pm Jul 4 UTC is already 8:30am Jul 5 in Tokyo.
      expect(
        resolveDrop('t1', 'hour:9', ctx({ selectedDate: lateUtc, userTimezone: 'Asia/Tokyo' }))
      ).toMatchObject({ dateStr: '2026-07-05' });
    });

    it('applies to every day-view drop target that carries a date', () => {
      const tokyo = { selectedDate: lateUtc, userTimezone: 'Asia/Tokyo' };
      expect(resolveDrop('t1', 'anytime', ctx(tokyo))).toMatchObject({ dateStr: '2026-07-05' });
      expect(resolveDrop('t1', 'unscheduled:morning', ctx(tokyo))).toMatchObject({
        dateStr: '2026-07-05',
      });
      expect(
        resolveDrop('t1', 'scheduled:afternoon:empty', ctx({ ...tokyo, inferDropTime: () => '14:00' }))
      ).toMatchObject({ dateStr: '2026-07-05' });
    });
  });

  describe('week:{date}:{bucket}', () => {
    it('schedules a task onto the cell date, not the selected date', () => {
      expect(resolveDrop('t1', 'week:2026-07-09:morning', ctx())).toEqual({
        kind: 'schedule-task',
        taskId: 't1',
        bucket: 'morning',
        dateStr: '2026-07-09',
      });
    });

    it('schedules habits into the bucket', () => {
      expect(resolveDrop('h1', 'week:2026-07-09:evening', ctx({ itemType: 'habit' }))).toEqual({
        kind: 'schedule-habit',
        habitId: 'h1',
        bucket: 'evening',
      });
    });
  });

  describe('list:{date}', () => {
    it('puts a braindump task on that day, Anytime, no time', () => {
      expect(resolveDrop('t1', 'list:2026-07-09', ctx({ draggedPlacement: { placed: false } }))).toEqual({
        kind: 'schedule-task',
        taskId: 't1',
        bucket: 'anytime',
        dateStr: '2026-07-09',
      });
    });

    it('reads an omitted placement as the braindump', () => {
      expect(resolveDrop('t1', 'list:2026-07-09', ctx())).toMatchObject({ kind: 'schedule-task' });
    });

    it('moves a canvas task to another day, keeping its bucket and time', () => {
      expect(
        resolveDrop('t1', 'list:2026-07-09', ctx({ draggedPlacement: { placed: true, dateStr: '2026-07-06' } }))
      ).toEqual({ kind: 'move-task-to-date', taskId: 't1', dateStr: '2026-07-09' });
    });

    it('does nothing for a task dropped on the day it is already on', () => {
      expect(
        resolveDrop('t1', 'list:2026-07-09', ctx({ draggedPlacement: { placed: true, dateStr: '2026-07-09' } }))
      ).toBeNull();
    });

    it('leaves habits alone: a canvas one recurs, a braindump one would land on no day', () => {
      expect(
        resolveDrop('h1', 'list:2026-07-09', ctx({ itemType: 'habit', draggedPlacement: { placed: false } }))
      ).toBeNull();
      expect(
        resolveDrop('h1', 'list:2026-07-09', ctx({ itemType: 'habit', draggedPlacement: { placed: true } }))
      ).toBeNull();
    });

    it('never moves a recurring canvas task: its date is the series anchor', () => {
      expect(
        resolveDrop(
          't1',
          'list:2026-07-09',
          ctx({ draggedPlacement: { placed: true, dateStr: '2026-07-01', recurring: true } })
        )
      ).toBeNull();
    });
  });

  describe('placementOf', () => {
    it("mirrors the braindump's membership test", () => {
      expect(placementOf({ type: 'task' }).placed).toBe(false);
      expect(placementOf({ type: 'task', timeBucket: 'morning', startDate: '2026-07-09' })).toMatchObject({
        placed: true,
        dateStr: '2026-07-09',
      });
      expect(placementOf({ type: 'task', isScheduled: true }).placed).toBe(true);
      expect(placementOf({ type: 'habit', repeatFrequency: 'none' }).placed).toBe(false);
      // A recurring habit is on the canvas even with no bucket; the braindump
      // never lists it.
      expect(placementOf({ type: 'habit', repeatFrequency: 'daily' }).placed).toBe(true);
    });

    it('reads a legacy ISO startDate as its day', () => {
      expect(placementOf({ timeBucket: 'anytime', startDate: '2026-07-09T00:00:00.000Z' }).dateStr).toBe(
        '2026-07-09'
      );
    });
  });

  describe('listGroupMovers', () => {
    const tasks = [
      { id: 'inbox' },
      { id: 'same', timeBucket: 'morning', startDate: '2026-07-09' },
      { id: 'other', timeBucket: 'morning', startDate: '2026-07-08', startTime: '07:00' },
      { id: 'series', timeBucket: 'morning', startDate: '2026-07-01', repeatFrequency: 'daily' },
      { id: 'milestone', timeBucket: 'anytime', startDate: '2026-07-20' },
      { id: 'unselected' },
    ];
    it('moves braindump and other-day tasks, never recurring, milestone or same-day ones', () => {
      expect(
        listGroupMovers(['inbox', 'same', 'other', 'series', 'milestone'], '2026-07-09', tasks, new Set(['milestone']))
      ).toEqual(['inbox', 'other']);
    });
  });
});

/**
 * Week and blocks PR 11: a placed task's hour, week-hour and braindump drops
 * ask the shared drop rule (lib/block-moves.ts planBlockDrop), and the web
 * changes in exactly two ways. A repeating task moved to a new time keeps its
 * start date, so no earlier day loses it. A repeating, finished, in-block or
 * milestone task dropped on the braindump stays where it was, as Move to
 * Braindump already refuses it (lib/row-moves.ts canSendToBraindump). Every
 * other drop ends in the row it ended in before: one-offs, braindump rows
 * dragged onto the grid, habits, the Anytime strips and the bucket cells.
 *
 * Each case is asserted as the ROW the shell's store call leaves
 * (components/shell/app-shell.tsx handleDragEnd's switch, over the store's
 * patches), so a drop the rule answers `none` (a block let go where it was)
 * reads as the same row as the no-op write it used to make. These ran on the
 * code before the rule: the "unchanged" cases passed there, the "changed"
 * cases failed there, and both pass now.
 */
describe('resolveDrop: block drops follow the shared drop rule (PR 11)', () => {
  const DAY = '2026-07-04';
  const COLUMN = '2026-07-08';
  const SERIES_START = '2026-07-01';

  const task = (id: string, over: Record<string, unknown> = {}) =>
    ({
      type: 'task',
      id,
      title: id,
      status: 'pending',
      isScheduled: true,
      startDate: DAY,
      timeBucket: 'morning',
      startTime: '09:00',
      duration: 30,
      inProjectBlock: false,
      completedDates: [],
      skippedDates: [],
      ...over,
    }) as unknown as Item;
  const custom = (id: string, over: Record<string, unknown> = {}) =>
    task(id, { type: 'custom', customType: 'errand', ...over });

  const items = {
    oneOff: task('one-off'),
    series: task('series', { repeatFrequency: 'daily', startDate: SERIES_START }),
    seriesInBlock: task('series-in-block', {
      repeatFrequency: 'weekdays',
      startDate: SERIES_START,
      startTime: undefined,
      inProjectBlock: true,
      project: 'Work',
      previousStartTime: '08:00',
      previousStartDate: '2026-06-30',
    }),
    inBlock: task('in-block', { startTime: undefined, inProjectBlock: true, project: 'Work' }),
    done: task('done', { status: 'completed' }),
    letGo: task('let-go', { status: 'cancelled' }),
    milestone: task('milestone'),
    customOneOff: custom('custom-one-off'),
    customSeries: custom('custom-series', { repeatFrequency: 'weekdays', startDate: SERIES_START }),
    // A series whose occurrence on the column is skipped: the web never lifts
    // a skipped strip, so a drop there is another day's block landing.
    seriesSkippedThere: task('series-skipped-there', {
      repeatFrequency: 'daily',
      startDate: SERIES_START,
      skippedDates: [COLUMN],
    }),
    braindumpRow: task('braindump-row', {
      isScheduled: false,
      startDate: undefined,
      timeBucket: undefined,
      startTime: undefined,
    }),
    datedBraindumpRow: task('dated-braindump-row', { isScheduled: false, timeBucket: undefined, startTime: undefined }),
    habit: {
      type: 'habit',
      id: 'stretch',
      title: 'stretch',
      status: 'pending',
      repeatFrequency: 'daily',
      timeBucket: 'morning',
      startTime: '07:30',
      completedDates: [],
      skippedDates: [],
    } as unknown as Item,
  } as const;
  type Key = keyof typeof items;
  const MILESTONES: ReadonlySet<string> = new Set(['milestone']);

  /** The shell's ctx for a drag of `key`, as handleDragEnd builds it. */
  const dragCtx = (key: Key): DropContext => {
    const item = items[key];
    return ctx({
      itemType: item.type === 'habit' ? 'habit' : 'task',
      draggedTaskProject: (item as { project?: string }).project,
      draggedPlacement: placementOf(item),
      draggedItem: item,
      milestoneIds: MILESTONES,
    } as Partial<DropContext>);
  };

  /**
   * The row the shell's store call leaves, applied as the store applies its
   * patches (spread over the item). An absent key and a cleared one read the
   * same, and so do `inProjectBlock` false and absent, as every reader asks it.
   */
  const endRow = (item: Item, command: DropCommand | null): Record<string, unknown> => {
    const clean = (row: Record<string, unknown>) =>
      JSON.parse(JSON.stringify({ ...row, inProjectBlock: row.inProjectBlock || undefined })) as Record<string, unknown>;
    const it = item as unknown as Record<string, unknown>;
    if (!command) return clean(it);
    switch (command.kind) {
      case 'schedule-task':
        return clean({
          ...it,
          ...scheduleTaskPatch(command.bucket, command.time),
          ...(command.dateStr ? { startDate: command.dateStr } : {}),
        });
      case 'schedule-habit':
        return clean({ ...it, ...scheduleHabitPatch(command.bucket, command.time) });
      case 'assign-habit-bucket':
        return clean({ ...it, timeBucket: command.bucket, startTime: undefined });
      case 'unschedule':
        return clean({ ...it, ...UNSCHEDULE_TASK_PATCH });
      case 'move-task-to-date':
        return clean({ ...it, startDate: command.dateStr, timeBucket: it.timeBucket ?? 'anytime' });
      case 'move-task-to-project-block':
        return clean({ ...it, inProjectBlock: true });
      case 'pause-item':
        return clean({ ...it, paused: true });
      case 'file-into-container':
        // Membership only: the row itself keeps every scheduling field.
        return clean(it);
    }
  };
  const row = (key: Key, over: Record<string, unknown> = {}) =>
    endRow({ ...items[key], ...over } as Item, null);
  const drop = (key: Key, target: string) => endRow(items[key], resolveDrop(items[key].id, target, dragCtx(key)));

  /** At an hour: on the grid, out of any block, the time and its part of day. */
  const at = (key: Key, time: string, startDate: string | undefined, over: Record<string, unknown> = {}) =>
    row(key, {
      isScheduled: true,
      startTime: time,
      timeBucket: Number(time.slice(0, 2)) < 12 ? 'morning' : Number(time.slice(0, 2)) < 17 ? 'afternoon' : 'evening',
      startDate,
      inProjectBlock: false,
      previousStartTime: undefined,
      previousStartDate: undefined,
      ...over,
    });
  const inBraindump = (key: Key) =>
    row(key, { isScheduled: false, timeBucket: undefined, startTime: undefined, startDate: undefined });

  describe('unchanged: the row each drop ended in before the rule', () => {
    it.each([
      ['oneOff', 'hour:10', () => at('oneOff', '10:00', DAY)],
      ['oneOff', `weekhour:${COLUMN}:14`, () => at('oneOff', '14:00', COLUMN)],
      ['oneOff', 'hour:9', () => row('oneOff')],
      ['done', 'hour:10', () => at('done', '10:00', DAY)],
      ['inBlock', 'hour:10', () => at('inBlock', '10:00', DAY)],
      ['inBlock', `weekhour:${COLUMN}:18`, () => at('inBlock', '18:00', COLUMN)],
      ['milestone', 'hour:10', () => at('milestone', '10:00', DAY)],
      ['milestone', `weekhour:${COLUMN}:10`, () => at('milestone', '10:00', COLUMN)],
      ['customOneOff', 'hour:15', () => at('customOneOff', '15:00', DAY)],
      ['braindumpRow', 'hour:9', () => at('braindumpRow', '09:00', DAY)],
      ['braindumpRow', `weekhour:${COLUMN}:9`, () => at('braindumpRow', '09:00', COLUMN)],
      ['datedBraindumpRow', 'hour:13', () => at('datedBraindumpRow', '13:00', DAY)],
      ['habit', 'hour:6', () => row('habit', { startTime: '06:00', timeBucket: 'morning' })],
      ['habit', `weekhour:${COLUMN}:20`, () => row('habit', { startTime: '20:00', timeBucket: 'evening' })],
    ] as const)('%s dropped on %s', (key, target, expected) => {
      expect(drop(key, target)).toEqual(expected());
    });

    it.each([
      ['oneOff', () => inBraindump('oneOff')],
      ['customOneOff', () => inBraindump('customOneOff')],
      // Rows already in the braindump write the braindump's shape again, as
      // before: the rule is asked only of a row on the canvas.
      ['braindumpRow', () => inBraindump('braindumpRow')],
      ['datedBraindumpRow', () => inBraindump('datedBraindumpRow')],
      ['habit', () => row('habit', { paused: true })],
    ] as const)('%s dropped on the braindump', (key, expected) => {
      expect(drop(key, 'sidebar')).toEqual(expected());
    });

    it('an unplaced habit dropped on the braindump stays put', () => {
      const loose = { ...items.habit, repeatFrequency: 'none', timeBucket: undefined, startTime: undefined } as Item;
      const c = ctx({
        itemType: 'habit',
        draggedPlacement: placementOf(loose),
        draggedItem: loose,
        milestoneIds: MILESTONES,
      } as Partial<DropContext>);
      expect(resolveDrop(loose.id, 'sidebar', c)).toBeNull();
    });

    it.each([
      // The Anytime strips and the bucket cells are not block drops the rule
      // answers on the web: each ends where it did, a series' date included.
      ['series', 'unscheduled:anytime', () => row('series', { isScheduled: true, timeBucket: 'anytime', startTime: undefined, startDate: DAY, inProjectBlock: false })],
      ['series', `week:${COLUMN}:anytime`, () => row('series', { isScheduled: true, timeBucket: 'anytime', startTime: undefined, startDate: COLUMN, inProjectBlock: false })],
      ['oneOff', `week:${COLUMN}:anytime`, () => row('oneOff', { isScheduled: true, timeBucket: 'anytime', startTime: undefined, startDate: COLUMN, inProjectBlock: false })],
      ['inBlock', 'unscheduled:anytime', () => row('inBlock', { isScheduled: true, timeBucket: 'anytime', startTime: undefined, inProjectBlock: false })],
      ['series', `week:${COLUMN}:evening`, () => row('series', { isScheduled: true, timeBucket: 'evening', startTime: undefined, startDate: COLUMN, inProjectBlock: false })],
      ['oneOff', 'unscheduled:afternoon', () => row('oneOff', { isScheduled: true, timeBucket: 'afternoon', startTime: undefined, inProjectBlock: false })],
      ['habit', `week:${COLUMN}:anytime`, () => row('habit', { timeBucket: 'anytime', startTime: undefined })],
      ['oneOff', `list:${COLUMN}`, () => row('oneOff', { startDate: COLUMN })],
      ['series', `list:${COLUMN}`, () => row('series')],
    ] as const)('%s dropped on %s', (key, target, expected) => {
      expect(drop(key, target)).toEqual(expected());
    });

    it('the grammar without the dragged item answers as before (the shell asks it for a group)', () => {
      expect(resolveDrop('series', 'hour:10', ctx())).toEqual({
        kind: 'schedule-task',
        taskId: 'series',
        bucket: 'morning',
        time: '10:00',
        dateStr: DAY,
      });
      expect(resolveDrop('series', 'sidebar', ctx())).toEqual({ kind: 'unschedule', itemId: 'series' });
    });
  });

  describe('changed: a series moves in time only, and the braindump takes only what Move to Braindump takes', () => {
    it.each([
      ['series', 'hour:10', () => at('series', '10:00', SERIES_START)],
      ['series', 'hour:14', () => at('series', '14:00', SERIES_START)],
      ['series', `weekhour:${COLUMN}:19`, () => at('series', '19:00', SERIES_START)],
      ['customSeries', 'hour:11', () => at('customSeries', '11:00', SERIES_START)],
      ['seriesSkippedThere', `weekhour:${COLUMN}:8`, () => at('seriesSkippedThere', '08:00', SERIES_START)],
      // In a project block a time alone would leave it there, so the drop
      // releases it with its own start date.
      ['seriesInBlock', 'hour:10', () => at('seriesInBlock', '10:00', SERIES_START)],
      ['seriesInBlock', `weekhour:${COLUMN}:16`, () => at('seriesInBlock', '16:00', SERIES_START)],
    ] as const)('%s dropped on %s keeps its start date', (key, target, expected) => {
      expect(drop(key, target)).toEqual(expected());
    });

    it.each(['series', 'seriesInBlock', 'inBlock', 'done', 'letGo', 'milestone', 'customSeries'] as const)(
      '%s dropped on the braindump stays where it was',
      (key) => {
        expect(drop(key, 'sidebar')).toEqual(row(key));
      }
    );
  });
});

describe('atlas:{kind}:{id}, an Atlas card (PR4)', () => {
  const P = '11111111-1111-4111-8111-111111111111';
  const R = '22222222-2222-4222-8222-222222222222';
  const ITEM = '33333333-3333-4333-8333-333333333333';

  it.each(['project', 'routine', 'season', 'goal'] as const)('a drop on a %s card files into it', (kind) => {
    expect(resolveDrop(ITEM, atlasCardDropId(kind, P), ctx())).toEqual({
      kind: 'file-into-container',
      itemId: ITEM,
      container: { kind, id: P },
    });
  });

  it('a habit files the same way (the registry decides what may join, not the grammar)', () => {
    expect(resolveDrop(ITEM, atlasCardDropId('routine', R), ctx({ itemType: 'habit' }))).toMatchObject({
      kind: 'file-into-container',
    });
  });

  it('an item already in the container resolves to nothing', () => {
    const containerMembers = vi.fn(() => new Set([ITEM]));
    expect(resolveDrop(ITEM, atlasCardDropId('routine', R), ctx({ containerMembers }))).toBeNull();
    expect(containerMembers).toHaveBeenCalledWith({ kind: 'routine', id: R });
  });

  it('carries the card a row was picked up from', () => {
    const active = atlasRowDragId('routine', R, ITEM);
    expect(dragItemIdOf(active)).toBe(ITEM);
    expect(atlasSourceOf(active)).toEqual({ kind: 'routine', id: R });
    expect(
      resolveDrop(dragItemIdOf(active), atlasCardDropId('routine', P), ctx({ atlasSource: atlasSourceOf(active) }))
    ).toEqual({
      kind: 'file-into-container',
      itemId: ITEM,
      container: { kind: 'routine', id: P },
      source: { kind: 'routine', id: R },
    });
  });

  it('parses only well-formed ids, and leaves every other id alone', () => {
    expect(parseAtlasCardDropId(`atlas:project:${P}`)).toEqual({ kind: 'project', id: P });
    expect(parseAtlasCardDropId('atlas:folder:x')).toBeNull();
    expect(parseAtlasCardDropId('atlas:project:')).toBeNull();
    expect(parseAtlasCardDropId(`atlas:project:${P}:extra`)).toBeNull();
    expect(resolveDrop(ITEM, 'atlas:folder:x', ctx())).toBeNull();
    expect(dragItemIdOf(ITEM)).toBe(ITEM);
    expect(atlasSourceOf(ITEM)).toBeNull();
    expect(dragItemIdOf('atlasrow:folder:a:b')).toBe('atlasrow:folder:a:b');
  });

  it('is withheld from no input', () => {
    expect(resolveDrop(ITEM, atlasCardDropId('goal', P), ctx({ input: 'touch' }))).not.toBeNull();
  });
});
