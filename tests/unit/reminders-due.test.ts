import { describe, it, expect } from 'vitest';
import {
  minutesOfDay,
  isWithinWindow,
  occursOn,
  wantsDoingOn,
  dueReminders,
  lastCallItems,
  streakOf,
  hasMatured,
  sentKeyFor,
  REMINDER_GRACE_MINUTES,
  type ScanRow,
} from '@/lib/reminders/due';
import type { ActivationContext } from '@/lib/active';
import type { Item, Season, Routine } from '@dsul/types';

const TZ = 'America/New_York';
const ctx: ActivationContext = { userTimezone: TZ };

const habit = (over: Partial<Item> = {}): Item => ({
  type: 'habit', id: 'h', title: 'Vitamins', project: 'G', streak: 0, status: 'pending',
  completedDates: [], skippedDates: [], dailyCounts: {}, repeatFrequency: 'daily',
  ...over,
} as Item);

const task = (over: Partial<Item> = {}): Item => ({
  type: 'task', id: 't', title: 'File taxes', status: 'pending', isScheduled: false, order: 0,
  ...over,
} as Item);

/** 2026-08-10 is a Monday. */
const MON = '2026-08-10';
const TUE = '2026-08-11';
const SAT = '2026-08-15';

const NOW_ISO = '2026-08-10T12:00:00.000Z';
const clock = (nowMinutes: number, dateStr = MON) => ({
  dateStr,
  nowMinutes,
  nowIso: NOW_ISO,
  nowMs: Date.parse(NOW_ISO),
});

describe('minutesOfDay', () => {
  it('parses a 24-hour time', () => {
    expect(minutesOfDay('00:00')).toBe(0);
    expect(minutesOfDay('07:30')).toBe(450);
    expect(minutesOfDay('23:59')).toBe(1439);
  });

  // Null, not NaN and not 0: 0 is a real time, and NaN makes every comparison
  // silently false — which is how a malformed row becomes a cue that never
  // fires and nobody can explain.
  it('returns null for anything that is not HH:mm', () => {
    expect(minutesOfDay(undefined)).toBeNull();
    expect(minutesOfDay('')).toBeNull();
    expect(minutesOfDay('7:30')).toBeNull();
    expect(minutesOfDay('24:00')).toBeNull();
    expect(minutesOfDay('12:60')).toBeNull();
    expect(minutesOfDay('noon')).toBeNull();
  });
});

describe('isWithinWindow', () => {
  it('opens at the stated minute and runs for the grace period', () => {
    expect(isWithinWindow(450, 449)).toBe(false);
    expect(isWithinWindow(450, 450)).toBe(true);
    expect(isWithinWindow(450, 450 + REMINDER_GRACE_MINUTES - 1)).toBe(true);
    expect(isWithinWindow(450, 450 + REMINDER_GRACE_MINUTES)).toBe(false);
  });

  // The divergence from eod-notify, and the reason it exists: a wrapping window
  // plus a same-day dedupe stamp double-sends. 23:50 fires and stamps day N;
  // at 00:05 the window is still open, the local date has rolled to N+1, the
  // stamp no longer matches, and the cue goes out again for yesterday.
  it('clamps at midnight instead of wrapping into the next day', () => {
    expect(isWithinWindow(1430, 1439)).toBe(true);
    expect(isWithinWindow(1430, 0)).toBe(false);
    expect(isWithinWindow(1430, 5)).toBe(false);
  });
});

describe('occursOn', () => {
  it('follows the recurrence rule for an un-anchored habit', () => {
    const weekdays = habit({ repeatFrequency: 'weekdays' });
    expect(occursOn(weekdays, MON, TZ)).toBe(true);
    expect(occursOn(weekdays, SAT, TZ)).toBe(false);
  });

  // Migrated habits have start_date NULL by design (migration 019). Gating them
  // on it would silence every reminder on every habit predating unification.
  it('does not require a startDate on an un-anchored type', () => {
    expect(occursOn(habit(), MON, TZ)).toBe(true);
  });

  it('gates an anchored recurring task on startDate <= date', () => {
    const t = task({ repeatFrequency: 'daily', startDate: TUE });
    expect(occursOn(t, MON, TZ)).toBe(false);
    expect(occursOn(t, TUE, TZ)).toBe(true);
  });

  // deriveDayItems rejects this outright (`if (!task.startDate) return false`
  // BEFORE its recurrence branch), and unscheduling a recurring task to the
  // braindump produces exactly this row — so treating it as "every matching
  // day" would nudge daily about something no view renders.
  it('an anchored recurring item with NO startDate occurs on no day', () => {
    expect(occursOn(task({ repeatFrequency: 'daily' }), MON, TZ)).toBe(false);
  });

  it('puts a one-shot task on exactly its own date', () => {
    const t = task({ startDate: MON });
    expect(occursOn(t, MON, TZ)).toBe(true);
    expect(occursOn(t, TUE, TZ)).toBe(false);
  });

  it('puts an undated task on no date at all', () => {
    expect(occursOn(task(), MON, TZ)).toBe(false);
  });

  it('tolerates a legacy full-ISO startDate', () => {
    expect(occursOn(task({ startDate: `${MON}T00:00:00Z` }), MON, TZ)).toBe(true);
  });
});

describe('wantsDoingOn', () => {
  it('is true for an untouched occurrence', () => {
    expect(wantsDoingOn(habit(), MON, ctx)).toBe(true);
  });

  it('is false once the date is completed or skipped', () => {
    expect(wantsDoingOn(habit({ completedDates: [MON] }), MON, ctx)).toBe(false);
    expect(wantsDoingOn(habit({ skippedDates: [MON] }), MON, ctx)).toBe(false);
  });

  it('is false for a counted habit already tallied today', () => {
    expect(wantsDoingOn(habit({ dailyCounts: { [MON]: 1 } }), MON, ctx)).toBe(false);
  });

  // The whole reason this delegates to lib/active rather than reimplementing
  // it: a notification about something the user explicitly paused is not a
  // cosmetic bug, it is the app nagging them about a decision they made.
  it('is false while the item itself is paused', () => {
    const paused = habit({ pausedAt: '2026-08-01T12:00:00Z', pausedUntil: '2026-09-01' });
    expect(wantsDoingOn(paused, MON, ctx)).toBe(false);
  });

  it('is false while a season holding it is paused', () => {
    const h = habit({ id: 'h1' });
    const season: Season = {
      id: 'p1', name: 'Summer', state: 'paused',
      itemIds: ['h1'], routineIds: [],
    } as Season;
    expect(wantsDoingOn(h, MON, { ...ctx, seasons: [season] })).toBe(false);
  });

  it('stays live when a second container still wants it', () => {
    const h = habit({ id: 'h1' });
    const paused: Routine = { id: 'r1', name: 'Morning', itemIds: ['h1'], pausedAt: '2026-08-01T12:00:00Z' } as Routine;
    const live: Routine = { id: 'r2', name: 'Always', itemIds: ['h1'] } as Routine;
    expect(wantsDoingOn(h, MON, { ...ctx, routines: [paused, live] })).toBe(true);
  });
});

describe('dueReminders', () => {
  const row = (item: Item, over: Partial<ScanRow> = {}): ScanRow => ({ item, ...over });

  it('returns an item whose cue is in the window', () => {
    const h = habit({ reminderTime: '07:30' });
    expect(dueReminders([row(h)], clock(450), ctx).map((c) => c.item.id)).toEqual(['h']);
  });

  it('returns nothing before the window opens or after it closes', () => {
    const h = habit({ reminderTime: '07:30' });
    expect(dueReminders([row(h)], clock(449), ctx)).toEqual([]);
    expect(dueReminders([row(h)], clock(450 + REMINDER_GRACE_MINUTES), ctx)).toEqual([]);
  });

  it('ignores items with no reminder set', () => {
    expect(dueReminders([row(habit())], clock(450), ctx)).toEqual([]);
  });

  it('will not send twice for the same day and time', () => {
    const h = habit({ reminderTime: '07:30' });
    expect(dueReminders([row(h, { sentKey: `${MON}T07:30` })], clock(450), ctx)).toEqual([]);
    // A stamp from YESTERDAY must not suppress today.
    expect(dueReminders([row(h, { sentKey: '2026-08-09T07:30' })], clock(450), ctx)).toHaveLength(1);
  });

  // The point of putting the TIME in the key. Retiming a cue to later the same
  // day has to re-arm it, or the user changes the time, watches nothing happen
  // and concludes reminders are broken. The alternative — clearing the stamp
  // whenever reminder_time is written — fires the cue a second time on any
  // unrelated edit, because the dialog's whole-item save names every field.
  it('re-arms when the cue is moved to a new time on the same day', () => {
    const moved = habit({ reminderTime: '18:00' });
    const stamped = row(moved, { sentKey: `${MON}T07:30` });
    expect(dueReminders([stamped], clock(18 * 60), ctx)).toHaveLength(1);
  });

  it('but an unrelated edit does not re-arm it', () => {
    const renamed = habit({ title: 'Vitamins (new name)', reminderTime: '07:30' });
    const stamped = row(renamed, { sentKey: `${MON}T07:30` });
    expect(dueReminders([stamped], clock(455), ctx)).toEqual([]);
  });

  it('stays silent about something already done', () => {
    const h = habit({ reminderTime: '07:30', completedDates: [MON] });
    expect(dueReminders([row(h)], clock(450), ctx)).toEqual([]);
  });

  // A matured snooze has to beat BOTH guards — by the time it fires, the day's
  // cue has been sent and its window has usually closed. Re-opening exactly
  // that state is what the user asked for when they tapped Snooze.
  it('a matured snooze overrides both the day stamp and the window', () => {
    const h = habit({ reminderTime: '07:30' });
    const snoozed = row(h, {
      sentKey: `${MON}T07:30`,
      snoozeUntil: '2026-08-10T11:00:00.000Z',
      snoozeDate: MON,
    });
    const out = dueReminders([snoozed], clock(900), ctx);
    expect(out).toHaveLength(1);
    expect(out[0].snoozed).toBe(true);
  });

  it('a snooze that has not matured yet stays quiet', () => {
    const h = habit({ reminderTime: '07:30' });
    const pending = row(h, {
      sentKey: `${MON}T07:30`,
      snoozeUntil: '2026-08-10T13:00:00.000Z',
      snoozeDate: MON,
    });
    expect(dueReminders([pending], clock(900), ctx)).toEqual([]);
  });

  // THE bug the day gate exists for. A snooze is cleared as it fires, but it
  // only fires while the item still wants doing — so completing the habit IN
  // THE APP leaves the row armed. Ungated, that stale row fires at the first
  // tick after midnight on the next day the habit is due and stamps that day,
  // suppressing the real cue.
  it('a snooze belonging to another day never fires', () => {
    const h = habit({ reminderTime: '07:30' });
    const stale = row(h, {
      sentKey: '2026-08-09T07:30',
      snoozeUntil: '2026-08-09T12:00:00.000Z',
      snoozeDate: '2026-08-09',
    });
    // 00:05 on the following day — matured long ago, and outside the window.
    expect(dueReminders([stale], clock(5), ctx)).toEqual([]);
  });

  // Snooze can be tapped on a LAST CALL, whose item often carries no per-item
  // cue at all. Requiring one would accept the tap and never honour it.
  it('honours a snooze on an item that has no reminder time of its own', () => {
    const h = habit({ reminderTime: undefined });
    const snoozed = row(h, { snoozeUntil: '2026-08-10T11:00:00.000Z', snoozeDate: MON });
    const out = dueReminders([snoozed], clock(900), ctx);
    expect(out).toHaveLength(1);
    expect(out[0].at).toBe('');
  });

  it('a snooze does not resurrect an item that was completed meanwhile', () => {
    const h = habit({ reminderTime: '07:30', completedDates: [MON] });
    const snoozed = row(h, {
      sentKey: `${MON}T07:30`,
      snoozeUntil: '2026-08-10T11:00:00.000Z',
      snoozeDate: MON,
    });
    expect(dueReminders([snoozed], clock(900), ctx)).toEqual([]);
  });

  it('never nudges about a subtask', () => {
    const sub = task({ id: 's', reminderTime: '07:30', startDate: MON, parentItemId: 'parent' });
    expect(dueReminders([row(sub)], clock(450), ctx)).toEqual([]);
  });

  it('orders a caught-up batch by the time the day was planned', () => {
    const rows = [
      row(habit({ id: 'b', reminderTime: '07:20' })),
      row(habit({ id: 'a', reminderTime: '07:00' })),
    ];
    expect(dueReminders(rows, clock(445), ctx).map((c) => c.item.id)).toEqual(['a', 'b']);
  });

  it('carries the anchor phrase through, and drops an empty one', () => {
    const withAnchor = habit({ id: 'w', reminderTime: '07:30', reminderAnchor: 'I pour my coffee' });
    const blank = habit({ id: 'b', reminderTime: '07:30', reminderAnchor: '' });
    const out = dueReminders([row(withAnchor), row(blank)], clock(450), ctx);
    expect(out.find((c) => c.item.id === 'w')?.anchor).toBe('I pour my coffee');
    expect(out.find((c) => c.item.id === 'b')?.anchor).toBeUndefined();
  });
});

describe('lastCallItems', () => {
  it('names only what still wants doing', () => {
    const open = habit({ id: 'open' });
    const done = habit({ id: 'done', completedDates: [MON] });
    expect(lastCallItems([open, done], MON, ctx).map((i) => i.id)).toEqual(['open']);
  });

  // The frame is what today's miss COSTS, and a dated task has nothing to lose
  // by that argument — including one turns a sharp message back into the
  // generic evening nag every other surface declines to send.
  it('leaves tasks out, however open they are', () => {
    const t = task({ id: 't1', startDate: MON });
    expect(lastCallItems([t, habit({ id: 'h1' })], MON, ctx).map((i) => i.id)).toEqual(['h1']);
  });

  it('puts the biggest streak first, so truncation drops the cheapest', () => {
    const small = habit({ id: 'small', streak: 2 });
    const big = habit({ id: 'big', streak: 40 });
    const mid = habit({ id: 'mid', streak: 9 });
    expect(lastCallItems([small, big, mid], MON, ctx).map((i) => i.id)).toEqual([
      'big', 'mid', 'small',
    ]);
  });

  it('does not require a reminder to be set on the habit', () => {
    expect(lastCallItems([habit()], MON, ctx)).toHaveLength(1);
  });
});

describe('streakOf', () => {
  it('is 0 for a type with no counter', () => {
    expect(streakOf(task())).toBe(0);
    expect(streakOf(habit({ streak: 12 }))).toBe(12);
  });
});

describe('hasMatured', () => {
  const now = Date.parse('2026-08-10T12:00:00.000Z');

  it('compares instants, not strings', () => {
    expect(hasMatured('2026-08-10T11:59:59.000Z', now)).toBe(true);
    expect(hasMatured('2026-08-10T12:00:01.000Z', now)).toBe(false);
  });

  // PostgREST renders a timestamptz as `…+00:00`; toISOString() produces `…Z`.
  // Compared as strings that is lexicographic, and works only by luck.
  it('reads the offset form PostgREST actually returns', () => {
    expect(hasMatured('2026-08-10T11:00:00+00:00', now)).toBe(true);
    expect(hasMatured('2026-08-10T13:00:00+00:00', now)).toBe(false);
    // A non-UTC offset is the case a string compare gets outright wrong:
    // 14:00+03:00 is 11:00Z, which HAS matured.
    expect(hasMatured('2026-08-10T14:00:00+03:00', now)).toBe(true);
  });

  it('treats an unreadable value as not yet matured', () => {
    expect(hasMatured('whenever', now)).toBe(false);
    expect(hasMatured(undefined, now)).toBe(false);
  });
});

describe('sentKeyFor', () => {
  it('carries the day and the time', () => {
    expect(sentKeyFor('2026-08-10', '07:30')).toBe('2026-08-10T07:30');
  });
});
