import { describe, it, expect, vi } from 'vitest';
import { listGroupMovers, placementOf, resolveDrop, type DropContext } from '@/lib/dnd/handle-drag-end';

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
  });

  describe('projectblock:{name}', () => {
    it('moves a task into its own project block', () => {
      const cmd = resolveDrop('t1', 'projectblock:Website', ctx({ draggedTaskProject: 'Website' }));
      expect(cmd).toEqual({ kind: 'move-task-to-project-block', taskId: 't1' });
    });

    it('rejects tasks from other projects and habits', () => {
      expect(resolveDrop('t1', 'projectblock:Website', ctx({ draggedTaskProject: 'Other' }))).toBeNull();
      expect(resolveDrop('h1', 'projectblock:Website', ctx({ itemType: 'habit' }))).toBeNull();
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
