import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  EOD_IDENTIFIER,
  NOTIFICATION_BUDGET,
  eodIdentifiers,
  identifiers,
  itemIdentifier,
  planNotifications,
  type NotificationPlan,
  type PlanInput,
  type PlannedRequest,
} from '@/lib/reminders/plan';
import { addDays, instantOf, weekdayOf } from '@/lib/reminders/clock';
import { reminderCopy, EOD_COPY } from '@/lib/reminders/copy';
import type { Item, Routine, Season } from '@dsul/types';
import { assertContract } from './support/copy-contract';

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';

/** 2026-10-05 is a Monday. */
const MON = '2026-10-05';
const TUE = '2026-10-06';

/** `over` is loose so a legacy value ('weekly') can be written as stored rows hold it. */
const habit = (id: string, over: Record<string, unknown> = {}): Item =>
  ({
    type: 'habit', id, title: `Habit ${id}`, streak: 0, status: 'pending',
    completedDates: [], skippedDates: [], dailyCounts: {}, repeatFrequency: 'daily',
    reminderTime: '07:30',
    ...over,
  }) as Item;

const task = (id: string, over: Record<string, unknown> = {}): Item =>
  ({ type: 'task', id, title: `Task ${id}`, status: 'pending', isScheduled: true, order: 0, reminderTime: '07:30', ...over }) as Item;

/** The instant `hhmm` reads on `dateStr` in `zone`. */
const wall = (dateStr: string, hhmm: string, zone = NY): number => {
  const [h, m] = hhmm.split(':').map(Number);
  const t = instantOf(dateStr, h * 60 + m, zone);
  if (t === null) throw new Error(`${dateStr} ${hhmm} does not exist in ${zone}`);
  return t;
};

const plan = (over: Partial<PlanInput> & { at?: number } = {}): NotificationPlan => {
  const { at, ...rest } = over;
  return planNotifications({
    nowMs: at ?? wall(MON, '06:00'),
    timezone: NY,
    items: [],
    remindersEnabled: true,
    ...rest,
  });
};

const only = (p: NotificationPlan): PlannedRequest => {
  expect(p.requests).toHaveLength(1);
  return p.requests[0];
};

const ids = (p: NotificationPlan) => p.requests.map((r) => r.id).sort();

describe('identifiers', () => {
  it('names every identifier an item can be under', () => {
    expect(identifiers('abc')).toEqual([
      'dsul-item-abc',
      'dsul-item-abc#1', 'dsul-item-abc#2', 'dsul-item-abc#3', 'dsul-item-abc#4',
      'dsul-item-abc#5', 'dsul-item-abc#6', 'dsul-item-abc#7',
      'dsul-item-abc#next', 'dsul-item-abc#now', 'dsul-item-abc#snooze',
    ]);
    expect(itemIdentifier('abc')).toBe('dsul-item-abc');
    expect(eodIdentifiers()).toEqual(['dsul-eod', 'dsul-eod#next']);
  });
});

describe('instantOf', () => {
  it('reads a wall time in the zone', () => {
    expect(instantOf('2026-08-10', 450, 'Asia/Kolkata')).toBe(Date.parse('2026-08-10T02:00:00Z'));
    expect(instantOf(MON, 450, NY)).toBe(Date.parse('2026-10-05T11:30:00Z'));
  });

  // Spring forward: 02:00 → 03:00 on 2026-03-08 in Los Angeles.
  it('has no instant for a minute a spring-forward skips', () => {
    expect(instantOf('2026-03-08', 150, LA)).toBeNull();
    expect(instantOf('2026-03-08', 90, LA)).toBe(Date.parse('2026-03-08T09:30:00Z'));
    expect(instantOf('2026-03-08', 180, LA)).toBe(Date.parse('2026-03-08T10:00:00Z'));
  });

  // Fall back: 01:00–01:59 happens twice on 2026-11-01. The first is PDT.
  it('takes the earlier of a minute a fall-back doubles', () => {
    expect(instantOf('2026-11-01', 90, LA)).toBe(Date.parse('2026-11-01T08:30:00Z'));
    expect(instantOf('2026-11-01', 120, LA)).toBe(Date.parse('2026-11-01T10:00:00Z'));
  });

  it('does day arithmetic on labels', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekdayOf(MON)).toBe(1);
    expect(weekdayOf('2026-10-04')).toBe(0);
  });
});

describe('planNotifications: standing triggers', () => {
  it('a daily habit is one repeating calendar trigger under its own id', () => {
    const h = habit('h1', { streak: 12 });
    const r = only(plan({ items: [h] }));
    expect(r).toEqual({
      id: 'dsul-item-h1',
      kind: 'cue',
      itemId: 'h1',
      trigger: { type: 'calendar', hour: 7, minute: 30, repeats: true },
      firesAt: wall(MON, '07:30'),
      title: 'Habit h1',
      body: '7:30 am · 12 days',
      threadId: 'dsul.cues',
      summaryArgument: 'Habit h1',
      categoryId: 'DSUL_CUE',
      level: 'active',
      relevance: 12 / 30,
      userInfo: { kind: 'cue', itemId: 'h1', at: '07:30' },
    });
  });

  it('a cue already past today rings first tomorrow', () => {
    const r = only(plan({ items: [habit('h1')], at: wall(MON, '09:00') }));
    expect(r.trigger).toEqual({ type: 'calendar', hour: 7, minute: 30, repeats: true });
    expect(r.firesAt).toBe(wall(TUE, '07:30'));
  });

  it('one weekday is one trigger with DateComponents\' weekday (1 = Sunday)', () => {
    const weekly = habit('h1', { repeatFrequency: 'weekly', repeatDays: [2] });
    const r = only(plan({ items: [weekly] }));
    expect(r.id).toBe('dsul-item-h1');
    expect(r.trigger).toEqual({ type: 'calendar', hour: 7, minute: 30, weekday: 3, repeats: true });
    expect(r.firesAt).toBe(wall(TUE, '07:30'));
  });

  it('two to six weekdays split into one trigger per weekday', () => {
    const p = plan({ items: [habit('h1', { repeatFrequency: 'custom', repeatDays: [5, 1, 3] })] });
    expect(p.requests.map((r) => [r.id, r.trigger])).toEqual([
      ['dsul-item-h1#2', { type: 'calendar', hour: 7, minute: 30, weekday: 2, repeats: true }],
      ['dsul-item-h1#4', { type: 'calendar', hour: 7, minute: 30, weekday: 4, repeats: true }],
      ['dsul-item-h1#6', { type: 'calendar', hour: 7, minute: 30, weekday: 6, repeats: true }],
    ]);
    expect(ids(plan({ items: [habit('h1', { repeatFrequency: 'weekdays' })] }))).toEqual(
      ['#2', '#3', '#4', '#5', '#6'].map((s) => `dsul-item-h1${s}`),
    );
    expect(ids(plan({ items: [habit('h1', { repeatFrequency: 'weekends' })] }))).toEqual(['dsul-item-h1#1', 'dsul-item-h1#7']);
  });

  it('all seven days is daily, and no days is nothing', () => {
    const every = habit('h1', { repeatFrequency: 'custom', repeatDays: [0, 1, 2, 3, 4, 5, 6] });
    expect(only(plan({ items: [every] })).trigger).toEqual({ type: 'calendar', hour: 7, minute: 30, repeats: true });
    expect(plan({ items: [habit('h1', { repeatFrequency: 'custom', repeatDays: [] })] }).requests).toEqual([]);
  });

  it('a monthly day up to the 28th is a calendar trigger on that day', () => {
    const r = only(plan({ items: [habit('h1', { repeatFrequency: 'monthly', repeatMonthDay: 15 })] }));
    expect(r.trigger).toEqual({ type: 'calendar', hour: 7, minute: 30, day: 15, repeats: true });
    expect(r.firesAt).toBe(wall('2026-10-15', '07:30'));
  });

  // A calendar trigger on the 31st matches no day in a 30-day month, where
  // occursOn clamps to the 30th. So the 29th–31st are one-offs, worked out
  // by the clamp itself.
  it('a monthly day after the 28th is a one-off, then the clamped next', () => {
    const p = plan({ items: [habit('h1', { repeatFrequency: 'monthly', repeatMonthDay: 31 })] });
    expect(p.requests.map((r) => [r.id, r.trigger, r.dateStr])).toEqual([
      ['dsul-item-h1', { type: 'at', dateStr: '2026-10-31', hhmm: '07:30' }, '2026-10-31'],
      ['dsul-item-h1#next', { type: 'at', dateStr: '2026-11-30', hhmm: '07:30' }, '2026-11-30'],
    ]);
  });

  it('never plans a subtask, an item with no cue, or one whose type cannot remind', () => {
    const sub = task('t1', { startDate: MON, parentItemId: 'p' });
    expect(plan({ items: [sub, habit('h2', { reminderTime: undefined })] }).requests).toEqual([]);
  });

  it('reads the 24-hour preference into the body', () => {
    expect(only(plan({ items: [habit('h1')], timeFormat: '24h' })).body).toBe('07:30');
  });

  it('leads with the anchor phrase when there is one', () => {
    expect(only(plan({ items: [habit('h1', { reminderAnchor: 'I pour my coffee' })] })).body).toBe('I pour my coffee');
  });
});

describe('planNotifications: one-offs', () => {
  it('a dated task is one one-off on its day', () => {
    const r = only(plan({ items: [task('t1', { startDate: '2026-10-09' })] }));
    expect(r).toMatchObject({
      id: 'dsul-item-t1',
      kind: 'cue',
      dateStr: '2026-10-09',
      trigger: { type: 'at', dateStr: '2026-10-09', hhmm: '07:30' },
      firesAt: wall('2026-10-09', '07:30'),
      userInfo: { kind: 'cue', itemId: 't1', dateStr: '2026-10-09', at: '07:30' },
    });
  });

  it('a task with no date, a past date, or done plans nothing', () => {
    expect(plan({ items: [task('t1')] }).requests).toEqual([]);
    expect(plan({ items: [task('t1', { startDate: '2026-10-01' })] }).requests).toEqual([]);
    expect(plan({ items: [task('t1', { startDate: '2026-10-09', status: 'completed' })] }).requests).toEqual([]);
  });

  // Its start day counts even off its rule (anchoredSeriesOn), so a series
  // that has not begun has no cadence to stand on yet.
  it('a recurring task that starts later is one-offs until it has begun', () => {
    const t = task('t1', { repeatFrequency: 'custom', repeatDays: [1], startDate: '2026-10-09' }); // a Friday
    expect(plan({ items: [t] }).requests.map((r) => [r.id, r.dateStr])).toEqual([
      ['dsul-item-t1', '2026-10-09'],
      ['dsul-item-t1#next', '2026-10-12'],
    ]);
    const begun = task('t1', { repeatFrequency: 'daily', startDate: '2026-09-01' });
    expect(only(plan({ items: [begun] })).trigger.type).toBe('calendar');
    // Anchored and undated occurs on no day at all.
    expect(plan({ items: [task('t1', { repeatFrequency: 'daily' })] }).requests).toEqual([]);
  });

  it('a cue time in 01:00–03:59 is one-offs whatever its cadence', () => {
    const p = plan({ items: [habit('h1', { reminderTime: '03:15' })], at: wall('2026-08-10', '12:00') });
    expect(p.requests.map((r) => [r.id, r.trigger])).toEqual([
      ['dsul-item-h1', { type: 'at', dateStr: '2026-08-11', hhmm: '03:15' }],
      ['dsul-item-h1#next', { type: 'at', dateStr: '2026-08-12', hhmm: '03:15' }],
    ]);
    expect(only(plan({ items: [habit('h1', { reminderTime: '04:00' })] })).trigger.type).toBe('calendar');
    expect(only(plan({ items: [habit('h1', { reminderTime: '00:59' })] })).trigger.type).toBe('calendar');
  });
});

describe('planNotifications: handled today (decision 23)', () => {
  const tomorrow = wall(TUE, '07:30');

  it('done before its cue: the same slot, an interval first ringing at the next wanted cue', () => {
    const now = wall(MON, '06:00');
    const r = only(plan({ items: [habit('h1', { completedDates: [MON] })], at: now }));
    expect(r.id).toBe('dsul-item-h1');
    expect(r.trigger).toEqual({ type: 'interval', seconds: (tomorrow - now) / 1000, repeats: true, anchorAt: tomorrow });
    expect(r.firesAt).toBe(tomorrow);
    expect(r.dateStr).toBeUndefined();
  });

  it('the first plan after today\'s cue time restores the calendar trigger', () => {
    const r = only(plan({ items: [habit('h1', { completedDates: [MON] })], at: wall(MON, '07:31') }));
    expect(r.trigger).toEqual({ type: 'calendar', hour: 7, minute: 30, repeats: true });
    expect(r.firesAt).toBe(tomorrow);
  });

  it('skipped, or tallied to its target, is handled the same way', () => {
    expect(only(plan({ items: [habit('h1', { skippedDates: [MON] })] })).trigger.type).toBe('interval');
    const counted = habit('h1', { timesPerDay: 2, dailyCounts: { [MON]: 2 } });
    expect(only(plan({ items: [counted] })).trigger.type).toBe('interval');
    const partway = habit('h1', { timesPerDay: 2, dailyCounts: { [MON]: 1 } });
    expect(only(plan({ items: [partway] })).trigger.type).toBe('calendar');
  });

  it('a paused habit anchors at the day it comes back, and an open pause plans nothing', () => {
    const until = habit('h1', { pausedAt: '2026-10-01T12:00:00Z', pausedUntil: '2026-10-08' });
    const r = only(plan({ items: [until] }));
    expect(r.trigger).toMatchObject({ type: 'interval', anchorAt: wall('2026-10-08', '07:30') });
    expect(plan({ items: [habit('h1', { pausedAt: '2026-10-01T12:00:00Z' })] }).requests).toEqual([]);
  });

  it('season-inactive anchors at the season\'s start; a paused season plans nothing', () => {
    const h = habit('h1');
    const autumn = { id: 's1', name: 'Later', state: 'auto', startsOn: '2026-10-07', itemIds: ['h1'], routineIds: [] } as Season;
    expect(only(plan({ items: [h], seasons: [autumn] })).trigger).toMatchObject({
      type: 'interval',
      anchorAt: wall('2026-10-07', '07:30'),
    });
    const shelf = { id: 's2', name: 'Shelf', state: 'paused', itemIds: ['h1'], routineIds: [] } as Season;
    expect(plan({ items: [h], seasons: [shelf] }).requests).toEqual([]);
    // A second, live container keeps it ringing.
    const live = { id: 'r1', name: 'Always', itemIds: ['h1'] } as Routine;
    const shelved = { id: 'r2', name: 'Shelved', itemIds: ['h1'], pausedAt: '2026-01-01T12:00:00Z' } as Routine;
    expect(only(plan({ items: [h], routines: [live, shelved] })).trigger.type).toBe('calendar');
  });

  it('only the handled weekday of a split becomes an interval, a week out', () => {
    const p = plan({ items: [habit('h1', { repeatFrequency: 'custom', repeatDays: [1, 3], completedDates: [MON] })] });
    expect(p.requests.map((r) => [r.id, r.trigger.type, r.firesAt])).toEqual([
      ['dsul-item-h1#4', 'calendar', wall('2026-10-07', '07:30')],
      ['dsul-item-h1#2', 'interval', wall('2026-10-12', '07:30')],
    ]);
  });

  it('withdraws every delivered identifier of an item handled today, and nothing of one not due', () => {
    const p = plan({ items: [habit('h1', { completedDates: [MON] }), habit('h2', { repeatFrequency: 'weekends' })] });
    expect(p.withdraw).toEqual(identifiers('h1').sort());
  });

  it('never rings a whole interval early: the seconds round up to the cue', () => {
    const now = wall(MON, '06:00') + 400;
    const r = only(plan({ items: [habit('h1', { completedDates: [MON] })], at: now }));
    expect(r.trigger).toMatchObject({ type: 'interval', seconds: Math.ceil((tomorrow - now) / 1000) });
  });
});

describe('planNotifications: snoozes', () => {
  const now = wall(MON, '07:35');
  const until = new Date(wall(MON, '07:50')).toISOString();

  it('arms a one-off under #snooze beside the standing trigger, and withdraws the cue it replaces', () => {
    const h = habit('h1');
    const p = plan({ items: [h], at: now, snoozes: [{ itemId: 'h1', until, date: MON }], localSentKeys: [`${MON}T07:30`] });
    expect(p.requests.map((r) => r.id)).toEqual(['dsul-item-h1#snooze', 'dsul-item-h1']);
    expect(p.requests[0]).toMatchObject({
      kind: 'snoozed',
      dateStr: MON,
      trigger: { type: 'afterMs', ms: 15 * 60_000 },
      firesAt: wall(MON, '07:50'),
      body: '7:30 am',
      userInfo: { kind: 'snoozed', itemId: 'h1', dateStr: MON, at: '07:30' },
    });
    expect(p.withdraw).toContain('dsul-item-h1');
    expect(p.withdraw).not.toContain('dsul-item-h1#snooze');
  });

  it('honours a snooze on an item with no cue of its own (tapped on a last call)', () => {
    const p = plan({ items: [habit('h1', { reminderTime: undefined })], at: now, snoozes: [{ itemId: 'h1', until, date: MON }] });
    const r = only(p);
    expect(r.body).toBe('');
    expect(r.userInfo).toEqual({ kind: 'snoozed', itemId: 'h1', dateStr: MON });
  });

  it('ignores a snooze for another day, one already matured, and one on a handled item', () => {
    const h = habit('h1');
    const sent = [`${MON}T07:30`];
    const other = plan({ items: [h], at: now, localSentKeys: sent, snoozes: [{ itemId: 'h1', until, date: '2026-10-04' }] });
    expect(ids(other)).toEqual(['dsul-item-h1']);
    const matured = plan({ items: [h], at: wall(MON, '07:51'), localSentKeys: sent, snoozes: [{ itemId: 'h1', until, date: MON }] });
    expect(ids(matured)).toEqual(['dsul-item-h1']);
    const done = plan({
      items: [habit('h1', { completedDates: [MON] })],
      at: now,
      snoozes: [{ itemId: 'h1', until, date: MON }],
    });
    expect(done.requests.some((r) => r.kind === 'snoozed')).toBe(false);
    expect(done.withdraw).toContain('dsul-item-h1#snooze');
  });

  it('needs the reminders switch, as every cue does', () => {
    expect(plan({ items: [habit('h1')], at: now, remindersEnabled: false, snoozes: [{ itemId: 'h1', until, date: MON }] }).requests).toEqual([]);
  });
});

describe('planNotifications: catch-up', () => {
  it('a cue armed inside its own window rings now, once', () => {
    const now = wall(MON, '07:40');
    const p = plan({ items: [habit('h1')], at: now });
    expect(p.requests.map((r) => [r.id, r.kind, r.trigger, r.firesAt])).toEqual([
      ['dsul-item-h1#now', 'catchUp', { type: 'now' }, now],
      ['dsul-item-h1', 'cue', { type: 'calendar', hour: 7, minute: 30, repeats: true }, wall(TUE, '07:30')],
    ]);
    expect(p.requests[0].dateStr).toBe(MON);
    expect(p.requests[0].userInfo).toEqual({ kind: 'catchUp', itemId: 'h1', dateStr: MON, at: '07:30' });
  });

  it('is deduped by the device\'s own sent keys', () => {
    const p = plan({ items: [habit('h1')], at: wall(MON, '07:40'), localSentKeys: [`${MON}T07:30`] });
    expect(ids(p)).toEqual(['dsul-item-h1']);
  });

  it('closes with the window, and never for something already handled', () => {
    expect(ids(plan({ items: [habit('h1')], at: wall(MON, '08:00') }))).toEqual(['dsul-item-h1']);
    expect(plan({ items: [habit('h1', { completedDates: [MON] })], at: wall(MON, '07:40') }).requests.map((r) => r.kind)).toEqual(['cue']);
  });

  it('never beside a live snooze', () => {
    const until = new Date(wall(MON, '07:55')).toISOString();
    const p = plan({ items: [habit('h1')], at: wall(MON, '07:40'), snoozes: [{ itemId: 'h1', until, date: MON }] });
    expect(p.requests.map((r) => r.kind).sort()).toEqual(['cue', 'snoozed']);
  });
});

describe('planNotifications: the review', () => {
  const eod = { enabled: true, time: '21:00', lastReviewDate: null };

  it('is one standing daily trigger under dsul-eod, in the rituals thread', () => {
    const r = only(plan({ eod, remindersEnabled: false }));
    expect(r).toEqual({
      id: EOD_IDENTIFIER,
      kind: 'eod',
      trigger: { type: 'calendar', hour: 21, minute: 0, repeats: true },
      firesAt: wall(MON, '21:00'),
      title: EOD_COPY.title,
      body: EOD_COPY.body,
      threadId: 'dsul.rituals',
      summaryArgument: EOD_COPY.title,
      categoryId: 'DSUL_EOD',
      level: 'active',
      relevance: 0,
      userInfo: { kind: 'eod' },
    });
  });

  it('reviewed today before its hour: never absent, an interval at tomorrow\'s hour, the invitation withdrawn', () => {
    const now = wall(MON, '20:00');
    const p = plan({ eod: { ...eod, lastReviewDate: MON }, at: now });
    const r = only(p);
    expect(r.id).toBe(EOD_IDENTIFIER);
    expect(r.trigger).toEqual({ type: 'interval', seconds: 25 * 3600, repeats: true, anchorAt: wall(TUE, '21:00') });
    expect(p.withdraw).toEqual(eodIdentifiers());
  });

  it('reviewed today after its hour: the calendar trigger, first ringing tomorrow', () => {
    const r = only(plan({ eod: { ...eod, lastReviewDate: MON }, at: wall(MON, '22:00') }));
    expect(r.trigger.type).toBe('calendar');
    expect(r.firesAt).toBe(wall(TUE, '21:00'));
  });

  it('reads the hour with the review\'s own parser, and notes one it cannot read', () => {
    expect(only(plan({ eod: { ...eod, time: '9:00' } })).trigger).toEqual({ type: 'calendar', hour: 9, minute: 0, repeats: true });
    expect(plan({ eod: { ...eod, time: 'whenever' } })).toEqual({
      requests: [],
      withdraw: [],
      notes: [{ code: 'bad-time', value: 'whenever' }],
    });
    expect(plan({ eod: { ...eod, enabled: false } }).requests).toEqual([]);
  });

  it('a review in the small hours is one-offs, each about its own day', () => {
    const p = plan({ eod: { ...eod, time: '1:30' }, at: wall(MON, '12:00') });
    expect(p.requests.map((r) => [r.id, r.trigger, r.userInfo])).toEqual([
      ['dsul-eod', { type: 'at', dateStr: TUE, hhmm: '01:30' }, { kind: 'eod', dateStr: TUE }],
      ['dsul-eod#next', { type: 'at', dateStr: '2026-10-07', hhmm: '01:30' }, { kind: 'eod', dateStr: '2026-10-07' }],
    ]);
  });
});

describe('planNotifications: no last call', () => {
  // Design decision 24. A list worked out at the last plan can name a habit
  // done elsewhere since, the one scold the copy contract cannot send.
  it('plans nothing but cues, snoozes, catch-ups and the review', () => {
    const p = plan({
      items: [habit('h1', { reminderTime: undefined, streak: 40 }), habit('h2')],
      eod: { enabled: true, time: '21:00', lastReviewDate: null },
    });
    expect(new Set(p.requests.map((r) => r.kind))).toEqual(new Set(['cue', 'eod']));
    expect(p.requests.some((r) => r.itemId === 'h1')).toBe(false);
  });
});

describe('planNotifications: daylight saving', () => {
  it('a spring-forward minute is absent that day, with a note', () => {
    const p = plan({ timezone: LA, items: [habit('h1', { reminderTime: '02:30' })], at: wall('2026-03-07', '22:00', LA) });
    expect(p.requests.map((r) => r.dateStr)).toEqual(['2026-03-09', '2026-03-10']);
    expect(p.notes).toEqual([{ code: 'dst-gap', itemId: 'h1', dateStr: '2026-03-08', at: '02:30' }]);
  });

  it('a fall-back minute rings exactly once, at its first instant', () => {
    const p = plan({ timezone: LA, items: [habit('h1', { reminderTime: '01:30' })], at: wall('2026-10-31', '22:00', LA) });
    expect(p.requests.map((r) => [r.dateStr, r.firesAt])).toEqual([
      ['2026-11-01', Date.parse('2026-11-01T08:30:00Z')],
      ['2026-11-02', Date.parse('2026-11-02T09:30:00Z')],
    ]);
    expect(p.notes).toEqual([]);
  });

  it('a gap already behind the plan is not reported', () => {
    const p = plan({ timezone: LA, items: [habit('h1', { reminderTime: '02:30' })], at: wall('2026-03-08', '10:00', LA) });
    expect(p.notes).toEqual([]);
  });
});

describe('planNotifications: the budget', () => {
  const daily = (n: number) =>
    Array.from({ length: n }, (_, i) => habit(`h${String(i).padStart(2, '0')}`));

  it('holds 60 of the 64 the OS allows, and notes what it dropped', () => {
    expect(NOTIFICATION_BUDGET).toBe(60);
    const p = plan({ items: daily(61) });
    expect(p.requests).toHaveLength(60);
    expect(p.requests.some((r) => r.itemId === 'h60')).toBe(false);
    expect(p.notes).toEqual([{ code: 'over-budget', itemId: 'h60', kept: 0 }]);
  });

  it('gives every item its next cue before any weekday set gets its slots', () => {
    const split = habit('a-split', { repeatFrequency: 'custom', repeatDays: [1, 3, 5] });
    const p = plan({ items: [split, habit('b1'), habit('b2')], budget: 4 });
    expect(p.requests.map((r) => [r.id, r.trigger.type])).toEqual([
      ['dsul-item-a-split', 'at'],
      ['dsul-item-b1', 'calendar'],
      ['dsul-item-b2', 'calendar'],
      ['dsul-item-a-split#next', 'at'],
    ]);
    expect(p.notes).toEqual([{ code: 'over-budget', itemId: 'a-split', kept: 2 }]);
    // With room, the same set stands on its three weekdays.
    expect(ids(plan({ items: [split, habit('b1'), habit('b2')], budget: 5 }))).toEqual([
      'dsul-item-a-split#2', 'dsul-item-a-split#4', 'dsul-item-a-split#6', 'dsul-item-b1', 'dsul-item-b2',
    ]);
  });

  it('spends it on the review first, and on the soonest cue next', () => {
    const p = plan({
      items: [habit('late', { reminderTime: '20:00' }), habit('early', { reminderTime: '07:00' })],
      eod: { enabled: true, time: '21:00', lastReviewDate: null },
      budget: 2,
    });
    expect(ids(p)).toEqual([EOD_IDENTIFIER, 'dsul-item-early']);
    expect(p.notes).toEqual([{ code: 'over-budget', itemId: 'late', kept: 0 }]);
  });

  it('puts a snooze before a catch-up, whatever their items', () => {
    const now = wall(MON, '07:40');
    const until = new Date(wall(MON, '07:55')).toISOString();
    const p = plan({
      items: [habit('a'), habit('z', { reminderTime: '06:00' })],
      at: now,
      localSentKeys: [`${MON}T06:00`],
      snoozes: [{ itemId: 'z', until, date: MON }],
      budget: 1,
    });
    expect(ids(p)).toEqual(['dsul-item-z#snooze']);
    expect(p.notes).toEqual([
      { code: 'over-budget', itemId: 'a', kept: 0 },
      { code: 'over-budget', itemId: 'z', kept: 0 },
    ]);
  });
});

describe('planNotifications: invariants', () => {
  afterEach(() => vi.restoreAllMocks());

  const world = (): PlanInput => ({
    nowMs: wall(MON, '07:40'),
    timezone: NY,
    remindersEnabled: true,
    timeFormat: '12h',
    eod: { enabled: true, time: '21:30', lastReviewDate: null },
    items: [
      habit('a', { streak: 3 }),
      habit('b', { repeatFrequency: 'weekdays', reminderAnchor: 'after lunch', reminderTime: '13:00' }),
      habit('c', { repeatFrequency: 'monthly', repeatMonthDay: 30, completedDates: [MON] }),
      habit('d', { reminderTime: '02:00' }),
      habit('e', { completedDates: [MON], reminderTime: '09:00' }),
      task('f', { startDate: '2026-10-07' }),
      task('g', { repeatFrequency: 'weekly', repeatDays: [3], startDate: '2026-09-02' }),
    ],
    snoozes: [{ itemId: 'b', until: new Date(wall(MON, '07:50')).toISOString(), date: MON }],
  });

  it('has unique ids within the budget, each from its item\'s identifiers, in firing order', () => {
    const p = planNotifications(world());
    const all = p.requests.map((r) => r.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeLessThanOrEqual(NOTIFICATION_BUDGET);
    for (const r of p.requests) {
      expect(r.itemId ? identifiers(r.itemId) : eodIdentifiers()).toContain(r.id);
    }
    const fires = p.requests.map((r) => r.firesAt);
    expect(fires).toEqual([...fires].sort((x, y) => x - y));
    expect(p.withdraw).toEqual([...new Set(p.withdraw)].sort());
  });

  it('says every cue in reminderCopy\'s words, and every word keeps the contract', () => {
    const input = world();
    for (const timeFormat of ['12h', '24h'] as const) {
      const p = planNotifications({ ...input, timeFormat });
      for (const r of p.requests) {
        if (r.kind === 'eod') {
          expect({ title: r.title, body: r.body }).toEqual(EOD_COPY);
        } else {
          const item = input.items.find((i) => i.id === r.itemId)!;
          const at = 'reminderTime' in item ? item.reminderTime : undefined;
          const anchor = ('reminderAnchor' in item ? item.reminderAnchor : undefined) || undefined;
          expect({ title: r.title, body: r.body }).toEqual(
            reminderCopy({ item, at: at ?? '', anchor, snoozed: r.kind === 'snoozed' }, timeFormat),
          );
        }
        expect(r.summaryArgument).toBe(r.title);
        assertContract({ title: r.title, body: r.body });
      }
    }
  });

  it('never reads the clock: time comes in as nowMs', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('planNotifications read the clock');
    });
    expect(planNotifications(world()).requests.length).toBeGreaterThan(0);
  });

  it('answers the same whatever order the items arrive in', () => {
    const input = world();
    expect(planNotifications({ ...input, items: [...input.items].reverse() })).toEqual(planNotifications(input));
  });

  it('plans nothing in a zone the runtime does not know, and says so', () => {
    expect(planNotifications({ ...world(), timezone: 'Not/AZone' })).toEqual({
      requests: [],
      withdraw: [],
      notes: [{ code: 'bad-zone', value: 'Not/AZone' }],
    });
  });

  it('notes a cue time that is not HH:mm', () => {
    expect(plan({ items: [habit('h1', { reminderTime: '7:30' })] }).notes).toEqual([
      { code: 'bad-time', itemId: 'h1', value: '7:30' },
    ]);
  });
});

/* ── Client-safe ─────────────────────────────────────────────────────────── */

const ROOT = process.cwd();

function specifiers(source: string): string[] {
  const re = /\b(?:import|export)\s[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;
  return [...source.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
}

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? path.join(ROOT, spec.slice(2)) : path.resolve(path.dirname(from), spec);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every local file `entry` reaches, and every package any of them imports. */
function closure(entries: string[]): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const walk = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.') || spec.startsWith('@/')) {
        const next = resolveLocal(file, spec);
        expect(next, `${spec} from ${file}`).not.toBeNull();
        walk(next as string);
      } else {
        packages.add(spec);
      }
    }
  };
  for (const entry of entries) walk(path.join(ROOT, entry));
  return { files: [...files].map((f) => path.relative(ROOT, f)).sort(), packages: [...packages].sort() };
}

describe('the plan runs anywhere the planner does', () => {
  // The phone runs these through their Swift twins and the page may run them
  // in a browser: nothing in reach may be a server module or a Node builtin.
  const { files, packages } = closure(['lib/reminders/plan.ts', 'lib/reminders/snooze.ts', 'lib/reminders/clock.ts']);

  it('imports no server module and no Node builtin', () => {
    expect(packages).toEqual(['@dsul/types', 'date-fns']);
    for (const file of files) {
      expect(file).not.toMatch(/(^|\/)(scan|deliver|db|push-send|supabase[\w-]*|extension-state)\.ts$|\/server\/|\/channels\//);
    }
  });

  it('never reads the clock itself', () => {
    for (const file of ['lib/reminders/plan.ts', 'lib/reminders/snooze.ts', 'lib/reminders/clock.ts']) {
      expect(readFileSync(path.join(ROOT, file), 'utf8'), file).not.toMatch(/Date\.now\(|new Date\(\)/);
    }
  });
});
