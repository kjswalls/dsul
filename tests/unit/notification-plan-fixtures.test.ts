import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import {
  NOTIFICATION_BUDGET,
  eodIdentifiers,
  identifiers,
  planNotifications,
  type NotificationPlan,
  type PlanInput,
} from '@/lib/reminders/plan';
import { snoozeFireInstant } from '@/lib/reminders/snooze';
import { addDays, changeoverMinutes, instantOf, localClock, weekdayOf, type MinuteRun } from '@/lib/reminders/clock';
import { EOD_COPY, reminderCopy } from '@/lib/reminders/copy';
import { occursOn, wantsDoingOn } from '@/lib/reminders/due';
import { SNOOZE_MINUTES } from '@/lib/reminders/channels/push';
import type { Item, Routine, Season } from '@/lib/planner-types';
import { NEVER_SCOLDS } from './support/copy-contract';

/**
 * The iPhone's notification plan, shared with DsulCore.
 *
 * lib/reminders/plan.ts decides which local notifications the phone arms
 * (memory/plans/reminders-platforms.md §2.3, §5.3), lib/reminders/snooze.ts
 * when a snooze tapped on it rings, and lib/reminders/clock.ts which minutes a
 * zone's changeovers touch. Every case is built here, run through the real TS,
 * and written with its answer to tests/fixtures/day/notification-plan.json;
 * DsulCore's NotificationPlanFixtureTests.swift and SnoozeFixtureTests.swift
 * read the same file and assert the Swift answers identically.
 *
 * A case's `input` is planNotifications' input verbatim (items in the app's
 * camelCase `Item` shape, as day-fixtures.test.ts writes them; `delivered`,
 * when present, is what the shade holds) and its `expected` the whole plan:
 * requests in order, withdrawals sorted, notes. Instants are epoch
 * milliseconds.
 *
 * This test fails when the committed file no longer matches what the TS says.
 * Regenerate with:
 *
 *   UPDATE_FIXTURES=1 pnpm test tests/unit/notification-plan-fixtures.test.ts
 *
 * then commit the JSON together with the Swift change that keeps the port in
 * step. Never hand-edit the JSON: the inputs live here.
 */

const DIR = path.resolve(__dirname, '../fixtures/day');

// ── Builders ─────────────────────────────────────────────────────────────────

/** Item n → a fixed, valid v4-shaped uuid. */
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

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
    reminderTime: '07:30',
    ...over,
  }) as Item;

const task = (n: number, title: string, over: Record<string, unknown> = {}): Item =>
  ({ type: 'task', id: uid(n), title, status: 'pending', isScheduled: true, order: 0, reminderTime: '07:30', ...over }) as Item;

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
/** Chile springs forward at local midnight, outside the 01:00–03:59 band: 2026-09-06 has no 00:30. */
const SANTIAGO = 'America/Santiago';
/** 2026-10-05 is a Monday. */
const MON = '2026-10-05';

/** The instant `hhmm` reads on `dateStr` in `zone`. */
const wall = (dateStr: string, hhmm: string, zone = NY): number => {
  const [h, m] = hhmm.split(':').map(Number);
  const t = instantOf(dateStr, h * 60 + m, zone);
  if (t === null) throw new Error(`${dateStr} ${hhmm} does not exist in ${zone}`);
  return t;
};
const iso = (ms: number) => new Date(ms).toISOString();

// ── identifiers ──────────────────────────────────────────────────────────────

type IdentifiersCase = { name: string; itemId: string | null; expected: string[] };

// ── snoozeFireInstant ────────────────────────────────────────────────────────

type SnoozeCase = {
  name: string;
  nowMs: number;
  minutes: number;
  timeZone: string;
  dayStr: string;
  expected: number | null;
};

function buildSnoozes(): SnoozeCase[] {
  const make = (name: string, nowMs: number, dayStr: string, timeZone = NY, minutes = SNOOZE_MINUTES): SnoozeCase => ({
    name,
    nowMs,
    minutes,
    timeZone,
    dayStr,
    expected: snoozeFireInstant(nowMs, minutes, timeZone, dayStr),
  });
  return [
    make('07:35, fifteen minutes on', wall('2026-08-10', '07:35'), '2026-08-10'),
    make('23:40 rings the same day', wall('2026-08-10', '23:40'), '2026-08-10'),
    make('23:50 is past midnight: null', wall('2026-08-10', '23:50'), '2026-08-10'),
    make('23:45 lands on midnight, the next day: null', wall('2026-08-10', '23:45'), '2026-08-10'),
    make('a millisecond before 23:45 still rings', wall('2026-08-10', '23:45') - 1, '2026-08-10'),
    make('yesterday\'s notification after midnight: null', wall('2026-08-11', '00:05'), '2026-08-10'),
    make('London reads its own day', Date.parse('2026-08-11T03:30:00Z'), '2026-08-10', 'Europe/London'),
    make('New York at the same instant', Date.parse('2026-08-11T03:30:00Z'), '2026-08-10'),
    make('Tokyo at 23:50: null', wall('2026-08-10', '23:50', 'Asia/Tokyo'), '2026-08-10', 'Asia/Tokyo'),
    make('across a spring-forward hour, the same day', wall('2026-03-08', '01:50', LA), '2026-03-08', LA),
    make('a zone the runtime does not know: null', wall('2026-08-10', '07:35'), '2026-08-10', 'Not/AZone'),
    make('a malformed day: null', wall('2026-08-10', '07:35'), '2026-8-10'),
    make('no length: null', wall('2026-08-10', '07:35'), '2026-08-10', NY, 0),
  ];
}

// ── changeoverMinutes ────────────────────────────────────────────────────────

/** The minutes a zone's changeovers touch, which the plan keeps repeating triggers off. */
type ChangeoverCase = { name: string; timeZone: string; fromMs: number; days: number; expected: MinuteRun[] };

function buildChangeovers(): ChangeoverCase[] {
  const make = (name: string, timeZone: string, fromMs: number, days = 400): ChangeoverCase => ({
    name,
    timeZone,
    fromMs,
    days,
    expected: changeoverMinutes(timeZone, fromMs, days),
  });
  const oct = Date.parse('2026-10-05T12:00:00Z');
  return [
    make('New York: 02:00 skipped, 01:00 played twice', NY, oct),
    make('London: 01:00 both ways', 'Europe/London', oct),
    make('Paris: 02:00 both ways', 'Europe/Paris', oct),
    make('Santiago: at midnight, and 23:00 played twice', SANTIAGO, oct),
    make('Lord Howe: half an hour', 'Australia/Lord_Howe', oct),
    make('Chatham: at 02:45', 'Pacific/Chatham', oct),
    make('Kolkata: never', 'Asia/Kolkata', oct),
    make('UTC: never', 'UTC', oct),
    make('Tokyo: never', 'Asia/Tokyo', oct),
    make('Los Angeles the day after its spring-forward, a year on: November\'s only', LA, Date.parse('2026-03-09T12:00:00Z'), 366),
    make('the same, 400 days on: both', LA, Date.parse('2026-03-09T12:00:00Z')),
    make('Los Angeles an hour before its fall-back, one day on', LA, Date.parse('2026-11-01T07:30:00Z'), 1),
  ];
}

// ── plans ────────────────────────────────────────────────────────────────────

type PlanCase = { name: string; input: PlanInput; expected: NotificationPlan };

function buildPlans(): PlanCase[] {
  const at6 = wall(MON, '06:00');
  const make = (name: string, over: Partial<PlanInput>): PlanCase => {
    const input: PlanInput = { nowMs: at6, timezone: NY, items: [], remindersEnabled: true, ...over };
    return { name, input, expected: planNotifications(input) };
  };
  const vitamins = (over: Record<string, unknown> = {}) => habit(1001, 'Vitamins', over);
  const eod = { enabled: true, time: '21:00', lastReviewDate: null };
  const until = (hhmm: string) => iso(wall(MON, hhmm));
  const season = (id: string, over: Partial<Season>): Season =>
    ({ id, name: id, state: 'auto', itemIds: [], routineIds: [], ...over }) as Season;
  const routine = (id: string, itemIds: string[], over: Partial<Routine> = {}): Routine => ({ id, name: id, itemIds, ...over });

  return [
    // Standing triggers.
    make('daily: one standing calendar trigger', { items: [vitamins({ streak: 12 })] }),
    make('a streak past a month: relevance stops at 1', { items: [vitamins({ streak: 45 })] }),
    make('a cue already past today rings first tomorrow', { items: [vitamins()], nowMs: wall(MON, '09:00') }),
    make('legacy weekly: one weekday', { items: [vitamins({ repeatFrequency: 'weekly', repeatDays: [2] })] }),
    make('custom three weekdays: one slot each', { items: [vitamins({ repeatFrequency: 'custom', repeatDays: [5, 1, 3] })] }),
    make('weekdays: five slots', { items: [vitamins({ repeatFrequency: 'weekdays' })] }),
    make('weekends: two slots', { items: [vitamins({ repeatFrequency: 'weekends' })] }),
    make('custom, all seven days, is daily', { items: [vitamins({ repeatFrequency: 'custom', repeatDays: [0, 1, 2, 3, 4, 5, 6] })] }),
    make('custom with no days: nothing', { items: [vitamins({ repeatFrequency: 'custom', repeatDays: [] })] }),
    make('monthly on the 15th: a day trigger', { items: [vitamins({ repeatFrequency: 'monthly', repeatMonthDay: 15 })] }),
    make('monthly on the 31st: standing in the long months, the next short one a one-off', {
      items: [vitamins({ repeatFrequency: 'monthly', repeatMonthDay: 31 })],
    }),
    make('monthly on the 31st in November: the clamped 30th first, the trigger next', {
      items: [vitamins({ repeatFrequency: 'monthly', repeatMonthDay: 31 })],
      nowMs: wall('2026-11-05', '06:00'),
    }),
    make('monthly on the 29th in January: February\'s 28th a one-off', {
      items: [vitamins({ repeatFrequency: 'monthly', repeatMonthDay: 29 })],
      nowMs: wall('2027-01-30', '06:00'),
    }),
    make('monthly with no day: nothing', { items: [vitamins({ repeatFrequency: 'monthly' })] }),
    // A season's end two months on: a trigger on the 31st rings next past a
    // short month, so that ring holds it, and a clamped day can be all that
    // is left.
    make('monthly on the 31st, its season ending before December\'s: October\'s alone', {
      items: [vitamins({ repeatFrequency: 'monthly', repeatMonthDay: 31 })],
      seasons: [season('autumn', { endsOn: '2026-11-29', itemIds: [uid(1001)] })],
    }),
    make('monthly on the 31st, its season ending after January\'s: standing, November\'s clamped day beside it', {
      items: [vitamins({ repeatFrequency: 'monthly', repeatMonthDay: 31 })],
      seasons: [season('autumn', { endsOn: '2027-01-31', itemIds: [uid(1001)] })],
    }),
    make('monthly on the 31st, its season ending in March: February\'s clamped 28th alone', {
      items: [vitamins({ repeatFrequency: 'monthly', repeatMonthDay: 31 })],
      seasons: [season('winter', { endsOn: '2027-03-04', itemIds: [uid(1001)] })],
      nowMs: wall('2027-02-27', '06:00'),
    }),
    make('24-hour words', { items: [vitamins()], timeFormat: '24h' }),
    make('the anchor leads the words', { items: [vitamins({ reminderAnchor: 'I pour my coffee', streak: 3 })] }),

    // One-offs.
    make('a dated task: one one-off', { items: [task(1002, 'File taxes', { startDate: '2026-10-09' })] }),
    make('a task with no date: nothing', { items: [task(1002, 'File taxes')] }),
    make('a task already past: nothing', { items: [task(1002, 'File taxes', { startDate: '2026-10-01' })] }),
    make('a recurring task starting off its rule: one-offs from its start', {
      items: [task(1003, 'Water plants', { repeatFrequency: 'custom', repeatDays: [1], startDate: '2026-10-09' })],
    }),
    make('a recurring task starting today on a repeat day: standing', {
      items: [task(1003, 'Water plants', { repeatFrequency: 'daily', startDate: MON })],
    }),
    make('a recurring task starting tomorrow: held until it begins', {
      items: [task(1003, 'Water plants', { repeatFrequency: 'daily', startDate: '2026-10-06' })],
    }),
    make('a recurring task begun: standing', {
      items: [task(1003, 'Water plants', { repeatFrequency: 'daily', startDate: '2026-09-01' })],
    }),
    make('a cue in New York\'s changeover minutes: one-offs', { items: [vitamins({ reminderTime: '02:15' })], nowMs: wall('2026-08-10', '12:00') }),
    make('03:00 is standing: past New York\'s changeover', { items: [vitamins({ reminderTime: '03:00' })] }),
    make('00:59 is standing: New York\'s changeover starts at 01:00', { items: [vitamins({ reminderTime: '00:59' })] }),
    make('Kolkata never changes its clocks: a small-hours cue stands', {
      timezone: 'Asia/Kolkata',
      items: [vitamins({ reminderTime: '02:30' })],
      nowMs: wall(MON, '06:00', 'Asia/Kolkata'),
    }),
    make('UTC never changes: a small-hours review stands', {
      timezone: 'UTC',
      eod: { enabled: true, time: '2:30', lastReviewDate: null },
      remindersEnabled: false,
      nowMs: wall(MON, '06:00', 'UTC'),
    }),

    // Handled today (decision 23): held slots. No repeating interval: one
    // cannot first ring at the cue and then every day, so a held daily stands
    // on its other six weekdays, and a lone weekday or month day is one-offs.
    make('done before its cue: six weekdays standing, today\'s a one-off a week out', {
      items: [vitamins({ completedDates: [MON] })],
    }),
    make('done at 08:00 before a 21:00 cue: every ring on its minute', {
      items: [vitamins({ reminderTime: '21:00', streak: 12, completedDates: [MON] })],
      nowMs: wall(MON, '08:00'),
    }),
    make('done before its cue without room for the seven: the two soonest, standing', {
      items: [vitamins({ completedDates: [MON] })],
      budget: 2,
    }),
    make('done, planned after its cue: the calendar restored', {
      items: [vitamins({ completedDates: [MON] })],
      nowMs: wall(MON, '07:31'),
    }),
    make('skipped before its cue', { items: [vitamins({ skippedDates: [MON] })] }),
    make('tallied to its target', { items: [vitamins({ timesPerDay: 2, dailyCounts: { [MON]: 2 } })] }),
    make('tallied below its target: standing', { items: [vitamins({ timesPerDay: 2, dailyCounts: { [MON]: 1 } })] }),
    make('paused until Thursday: standing from its return, one-offs a week on for the rest', {
      items: [vitamins({ pausedAt: '2026-10-01T12:00:00Z', pausedUntil: '2026-10-08' })],
    }),
    make('paused until January: the next wanted cue is looked for a year ahead', {
      items: [vitamins({ pausedAt: '2026-10-01T12:00:00Z', pausedUntil: '2027-01-03' })],
    }),
    make('paused with no end: nothing', { items: [vitamins({ pausedAt: '2026-10-01T12:00:00Z' })] }),
    make('a season starting Wednesday: standing from its start', {
      items: [vitamins()],
      seasons: [season('later', { startsOn: '2026-10-07', itemIds: [uid(1001)] })],
    }),
    make('a paused season: nothing', { items: [vitamins()], seasons: [season('shelf', { state: 'paused', itemIds: [uid(1001)] })] }),
    make('a second, live container keeps it standing', {
      items: [vitamins()],
      routines: [
        routine('always', [uid(1001)]),
        routine('shelved', [uid(1001)], { pausedAt: '2026-01-01T12:00:00Z' }),
      ],
    }),
    make('a split, today handled: that weekday a week out', {
      items: [vitamins({ repeatFrequency: 'custom', repeatDays: [1, 3], completedDates: [MON] })],
    }),
    make('Mon, Wed and Fri, done Monday at 06:00 before a 21:00 cue', {
      items: [vitamins({ repeatFrequency: 'custom', repeatDays: [1, 3, 5], reminderTime: '21:00', completedDates: [MON] })],
    }),
    make('one weekday, done today: next week and the week after', {
      items: [vitamins({ repeatFrequency: 'weekly', repeatDays: [1], completedDates: [MON] })],
    }),
    make('monthly on the 15th, done today: the one-off series', {
      items: [vitamins({ repeatFrequency: 'monthly', repeatMonthDay: 15, completedDates: ['2026-10-15'] })],
      nowMs: wall('2026-10-15', '06:00'),
    }),
    make('monthly on the 15th, done today, room for one', {
      items: [vitamins({ repeatFrequency: 'monthly', repeatMonthDay: 15, completedDates: ['2026-10-15'] })],
      nowMs: wall('2026-10-15', '06:00'),
      budget: 1,
    }),
    make('done today: its delivered cue withdrawn, an off day left alone', {
      items: [vitamins({ completedDates: [MON] }), habit(1004, 'Long run', { repeatFrequency: 'weekends' })],
      nowMs: wall(MON, '09:00'),
      delivered: [
        { id: `dsul-item-${uid(1001)}`, deliveredAtMs: wall(MON, '07:30') },
        { id: `dsul-item-${uid(1004)}#1`, deliveredAtMs: wall('2026-10-04', '07:30') },
      ],
    }),

    // An unwanted day ahead (a season's end, a mark entered for a later day):
    // a standing trigger cannot be told to stop, so its slot is held now.
    make('a season ending Thursday: one-offs up to Thursday, nothing after', {
      items: [vitamins()],
      seasons: [season('autumn', { endsOn: '2026-10-08', itemIds: [uid(1001)] })],
    }),
    make('a season ending in a week, done today: nothing past its end', {
      items: [vitamins({ completedDates: [MON] })],
      seasons: [season('autumn', { endsOn: '2026-10-08', itemIds: [uid(1001)] })],
    }),
    make('a season from Thursday to the next Thursday: its days, and none after', {
      timezone: LA,
      items: [vitamins({ reminderTime: '23:59', completedDates: [MON] })],
      seasons: [season('fortnight', { startsOn: '2026-10-08', endsOn: '2026-10-15', itemIds: [uid(1001)] })],
      nowMs: wall(MON, '23:58', LA),
    }),
    make('three weekdays in a season ending Saturday: one-offs', {
      items: [vitamins({ repeatFrequency: 'custom', repeatDays: [1, 3, 5] })],
      seasons: [season('autumn', { endsOn: '2026-10-10', itemIds: [uid(1001)] })],
    }),
    make('a lone weekday whose season ends before its third ring: the series', {
      items: [vitamins({ repeatFrequency: 'weekly', repeatDays: [1] })],
      seasons: [season('autumn', { endsOn: '2026-10-20', itemIds: [uid(1001)] })],
    }),
    make('skipped on Wednesday in advance: Wednesday held, the rest standing', {
      items: [vitamins({ skippedDates: ['2026-10-07'] })],
    }),
    make('ticked a week ahead for a Friday: this Friday once', {
      items: [vitamins({ completedDates: ['2026-10-16'] })],
    }),
    make('three weekdays with next Monday skipped: this Monday once', {
      items: [vitamins({ repeatFrequency: 'custom', repeatDays: [1, 3, 5], skippedDates: ['2026-10-12'] })],
    }),
    make('a season ending more than a month past the next ring: still standing', {
      items: [vitamins()],
      seasons: [season('winter', { endsOn: '2026-11-05', itemIds: [uid(1001)] })],
    }),
    make('a season ending a month past the next ring: the weekdays that reach it held', {
      items: [vitamins()],
      seasons: [season('winter', { endsOn: '2026-11-04', itemIds: [uid(1001)] })],
    }),

    // Snoozes.
    make('a snooze beside the standing trigger, its cue withdrawn', {
      items: [vitamins()],
      nowMs: wall(MON, '07:35'),
      snoozes: [{ itemId: uid(1001), until: until('07:50'), date: MON }],
      localSentKeys: [`${MON}T07:30`],
      delivered: [{ id: `dsul-item-${uid(1001)}`, deliveredAtMs: wall(MON, '07:30') }],
    }),
    make('a snooze on an item with no cue of its own', {
      items: [vitamins({ reminderTime: undefined, streak: 5 })],
      nowMs: wall(MON, '07:35'),
      snoozes: [{ itemId: uid(1001), until: until('07:50'), date: MON }],
    }),
    make('a snooze for another day: ignored', {
      items: [vitamins()],
      nowMs: wall(MON, '07:35'),
      snoozes: [{ itemId: uid(1001), until: until('07:50'), date: '2026-10-04' }],
      localSentKeys: [`${MON}T07:30`],
    }),
    make('a snooze already matured: ignored', {
      items: [vitamins()],
      nowMs: wall(MON, '07:51'),
      snoozes: [{ itemId: uid(1001), until: until('07:50'), date: MON }],
      localSentKeys: [`${MON}T07:30`],
    }),
    make('a snooze in the +00:00 form', {
      items: [vitamins()],
      nowMs: wall(MON, '07:35'),
      snoozes: [{ itemId: uid(1001), until: '2026-10-05T11:50:00+00:00', date: MON }],
      localSentKeys: [`${MON}T07:30`],
    }),
    make('a snooze maturing past midnight: nothing', {
      items: [vitamins({ reminderTime: '23:30' })],
      nowMs: wall(MON, '23:56'),
      snoozes: [{ itemId: uid(1001), until: iso(wall('2026-10-06', '00:10')), date: MON }],
    }),
    make('a snooze ringing at 23:59: armed', {
      items: [vitamins({ reminderTime: '23:30' })],
      nowMs: wall(MON, '23:50'),
      snoozes: [{ itemId: uid(1001), until: until('23:59'), date: MON }],
    }),
    make('a snooze on something done meanwhile: ignored and withdrawn', {
      items: [vitamins({ completedDates: [MON] })],
      nowMs: wall(MON, '07:35'),
      snoozes: [{ itemId: uid(1001), until: until('07:50'), date: MON }],
      delivered: [{ id: `dsul-item-${uid(1001)}#snooze`, deliveredAtMs: wall(MON, '07:20'), dateStr: MON }],
    }),
    make('a snooze replaces only its own day\'s cue in the shade', {
      items: [vitamins({ repeatFrequency: 'custom', repeatDays: [1, 3, 5] })],
      nowMs: wall('2026-10-07', '07:35'),
      snoozes: [{ itemId: uid(1001), until: iso(wall('2026-10-07', '07:50')), date: '2026-10-07' }],
      localSentKeys: ['2026-10-07T07:30'],
      delivered: [
        { id: `dsul-item-${uid(1001)}#2`, deliveredAtMs: wall(MON, '07:30') },
        { id: `dsul-item-${uid(1001)}#4`, deliveredAtMs: wall('2026-10-07', '07:30') },
      ],
    }),

    // Catch-up.
    make('armed inside its window: rings now, once', { items: [vitamins()], nowMs: wall(MON, '07:40') }),
    make('already rung on this device: no catch-up', {
      items: [vitamins()],
      nowMs: wall(MON, '07:40'),
      localSentKeys: [`${MON}T07:30`],
    }),
    make('the window closed: no catch-up', { items: [vitamins()], nowMs: wall(MON, '08:00') }),
    make('a ten-minute grace, closed at 07:45: no catch-up', { items: [vitamins()], nowMs: wall(MON, '07:45'), graceMinutes: 10 }),
    make('an hour\'s grace, still open at 08:15: rings now', { items: [vitamins()], nowMs: wall(MON, '08:15'), graceMinutes: 60 }),
    make('handled: no catch-up', { items: [vitamins({ completedDates: [MON] })], nowMs: wall(MON, '07:40') }),
    make('never beside a live snooze', {
      items: [vitamins()],
      nowMs: wall(MON, '07:40'),
      snoozes: [{ itemId: uid(1001), until: until('07:55'), date: MON }],
    }),

    // The review.
    make('review: one standing trigger', { eod, remindersEnabled: false }),
    make('review done before its hour: standing on the other six days, never absent', {
      eod: { ...eod, lastReviewDate: MON },
      nowMs: wall(MON, '20:00'),
      delivered: [{ id: 'dsul-eod', deliveredAtMs: wall('2026-10-04', '21:00') }],
    }),
    make('review done at 08:00 before its hour: every ring at the hour', {
      eod: { ...eod, lastReviewDate: MON },
      nowMs: wall(MON, '08:00'),
    }),
    make('review done before its hour, room for one: tomorrow\'s weekday and a note', {
      eod: { ...eod, lastReviewDate: MON },
      nowMs: wall(MON, '20:00'),
      items: [vitamins()],
      budget: 1,
    }),
    make('review done after its hour: the calendar, first ringing tomorrow', {
      eod: { ...eod, lastReviewDate: MON },
      nowMs: wall(MON, '22:00'),
    }),
    make('review done yesterday: standing', { eod: { ...eod, lastReviewDate: '2026-10-04' }, nowMs: wall(MON, '20:00') }),
    make('review at 9:00, the loose form', { eod: { ...eod, time: '9:00' } }),
    make('review at an unreadable hour: a note', { eod: { ...eod, time: 'whenever' } }),
    make('review switched off: nothing', { eod: { ...eod, enabled: false } }),
    make('review in the small hours: one-offs', { eod: { ...eod, time: '1:30' }, nowMs: wall(MON, '12:00') }),
    make('review beside cues', { eod, items: [vitamins(), habit(1005, 'Reading', { reminderTime: '21:00', streak: 30 })] }),
    make('review answered after midnight: the night it answered withdrawn', {
      eod: { ...eod, time: '23:30', lastReviewDate: MON },
      remindersEnabled: false,
      nowMs: wall('2026-10-06', '00:15'),
      delivered: [{ id: 'dsul-eod', deliveredAtMs: wall(MON, '23:30') }],
    }),
    make('review answered on the web, reconciled next morning: withdrawn', {
      eod: { ...eod, lastReviewDate: MON },
      remindersEnabled: false,
      nowMs: wall('2026-10-06', '07:00'),
      delivered: [{ id: 'dsul-eod', deliveredAtMs: wall(MON, '21:00') }],
    }),
    make('review still owed for its night: left in the shade', {
      eod: { ...eod, time: '23:30', lastReviewDate: '2026-10-04' },
      remindersEnabled: false,
      nowMs: wall('2026-10-06', '00:15'),
      delivered: [{ id: 'dsul-eod', deliveredAtMs: wall(MON, '23:30') }],
    }),
    make('review switched off: its invitation withdrawn', {
      eod: { ...eod, enabled: false },
      remindersEnabled: false,
      nowMs: wall('2026-10-06', '07:00'),
      delivered: [{ id: 'dsul-eod', deliveredAtMs: wall(MON, '21:00') }],
    }),
    // G14: a review recorded for a day ahead of today holds that day.
    make('review recorded for tomorrow: that weekday a week out', {
      eod: { ...eod, lastReviewDate: '2026-10-06' },
      remindersEnabled: false,
      nowMs: wall(MON, '22:00'),
    }),

    // No last call (decision 24).
    make('a streak with no cue: no last call', {
      items: [vitamins({ reminderTime: undefined, streak: 40 })],
      eod,
      nowMs: wall(MON, '20:30'),
    }),

    // Daylight saving.
    make('Los Angeles 2026-03-08 02:30: absent, with a note', {
      timezone: LA,
      items: [vitamins({ reminderTime: '02:30' })],
      nowMs: wall('2026-03-07', '22:00', LA),
    }),
    make('Los Angeles 2026-11-01 01:30: exactly one instant', {
      timezone: LA,
      items: [vitamins({ reminderTime: '01:30' })],
      nowMs: wall('2026-10-31', '22:00', LA),
    }),
    make('Los Angeles, a standing cue across the spring-forward night', {
      timezone: LA,
      items: [vitamins({ reminderTime: '07:30' })],
      nowMs: wall('2026-03-07', '22:00', LA),
    }),
    make('Santiago, a 00:30 cue on its midnight changeover: one-offs, and a note', {
      timezone: SANTIAGO,
      items: [vitamins({ reminderTime: '00:30' })],
      nowMs: wall('2026-09-05', '12:00', SANTIAGO),
    }),
    make('Santiago, a review at 0:30 on the same changeover: one-offs, and a note', {
      timezone: SANTIAGO,
      eod: { ...eod, time: '0:30' },
      remindersEnabled: false,
      nowMs: wall('2026-09-05', '12:00', SANTIAGO),
    }),
    // G1: a held 00:30 daily the night before Santiago's changeover: one note.
    make('Santiago, done before a 00:30 cue the night before its changeover: one note', {
      timezone: SANTIAGO,
      items: [vitamins({ reminderTime: '00:30', completedDates: ['2026-09-05'] })],
      nowMs: wall('2026-09-05', '00:10', SANTIAGO),
    }),
    // G2, G2b: a gap earlier today is behind the plan and not reported.
    make('Santiago, its changeover earlier today: no note', {
      timezone: SANTIAGO,
      items: [vitamins({ reminderTime: '00:30' })],
      nowMs: wall('2026-09-06', '12:00', SANTIAGO),
    }),
    make('Los Angeles, its spring-forward earlier today: no note', {
      timezone: LA,
      items: [vitamins({ reminderTime: '02:30' })],
      nowMs: wall('2026-03-08', '10:00', LA),
    }),
    make('Tokyo: the day is Tokyo\'s', {
      timezone: 'Asia/Tokyo',
      items: [vitamins({ completedDates: [MON] })],
      nowMs: Date.parse('2026-10-04T21:00:00Z'), // 06:00 on the 5th in Tokyo
    }),

    // The budget.
    make('61 daily habits: 60 and a note', {
      items: Array.from({ length: 61 }, (_, i) => habit(1100 + i, `Habit ${i + 1}`)),
    }),
    make('a weekday set the budget cannot hold: its soonest first, the rest by when they ring', {
      items: [
        habit(1010, 'Gym', { repeatFrequency: 'custom', repeatDays: [1, 3, 5] }),
        habit(1011, 'Read'),
        habit(1012, 'Stretch'),
      ],
      budget: 4,
    }),
    make('the same set with room stands on its weekdays', {
      items: [
        habit(1010, 'Gym', { repeatFrequency: 'custom', repeatDays: [1, 3, 5] }),
        habit(1011, 'Read'),
        habit(1012, 'Stretch'),
      ],
      budget: 5,
    }),
    make('the review first, then the soonest cue', {
      items: [habit(1013, 'Late', { reminderTime: '20:00' }), habit(1014, 'Early', { reminderTime: '07:00' })],
      eod,
      budget: 2,
    }),
    make('a snooze first, and a catch-up costs no pending room', {
      items: [habit(1015, 'A'), habit(1016, 'Z', { reminderTime: '06:00' })],
      nowMs: wall(MON, '07:40'),
      localSentKeys: [`${MON}T06:00`],
      snoozes: [{ itemId: uid(1016), until: until('07:55'), date: MON }],
      budget: 1,
    }),

    make('a catch-up for thirty and twenty-nine Wednesday habits: every item still armed', {
      items: [
        ...Array.from({ length: 30 }, (_, i) => habit(1200 + i, `Morning ${i + 1}`)),
        ...Array.from({ length: 29 }, (_, i) => habit(1300 + i, `Wednesday ${i + 1}`, { repeatFrequency: 'weekly', repeatDays: [3] })),
      ],
      eod,
      nowMs: wall(MON, '07:35'),
    }),
    make('a held review, a held daily, three weekdays and a daily in six places', {
      items: [
        habit(1030, 'Held', { reminderTime: '07:00', completedDates: [MON] }),
        habit(1031, 'Gym', { repeatFrequency: 'custom', repeatDays: [1, 3, 5], reminderTime: '07:15' }),
        habit(1032, 'Read', { reminderTime: '07:45' }),
      ],
      eod: { ...eod, lastReviewDate: MON },
      nowMs: wall(MON, '06:00'),
      budget: 6,
    }),
    make('ten held dailies in twenty places: two days each, in the order they ring', {
      items: Array.from({ length: 10 }, (_, i) => habit(1400 + i, `Held ${i + 1}`, { completedDates: [MON] })),
      budget: 20,
    }),
    // G4: the seconds go by when they ring, not item by item.
    make('two held dailies in eight places: each its next four days', {
      items: [
        habit(2005, 'A', { completedDates: [MON] }),
        habit(2006, 'B', { reminderTime: '08:00', completedDates: [MON] }),
      ],
      budget: 8,
    }),
    // G13: a held review takes all seven when they fit, and says nothing.
    make('a held review in exactly seven places: all seven, no note', {
      eod: { ...eod, lastReviewDate: MON },
      remindersEnabled: false,
      nowMs: wall(MON, '20:00'),
      budget: 7,
    }),
    // G3: two one-off series in three places: the sooner second, the review's or not.
    make('two one-off series in three places: the sooner second', {
      items: [habit(2010, 'Night', { reminderTime: '01:10' })],
      eod: { ...eod, time: '2:50' },
      budget: 3,
    }),
    make('a review at 3:50 stands in New York beside a 01:10 series', {
      items: [habit(2010, 'Night', { reminderTime: '01:10' })],
      eod: { ...eod, time: '3:50' },
      budget: 3,
    }),
    // G5: one place, three habits: the soonest, and the notes sorted by id.
    make('one place for three habits: the soonest, the others noted in id order', {
      items: [
        habit(2007, 'Nine', { reminderTime: '09:00' }),
        habit(2008, 'Eight', { reminderTime: '08:00' }),
        habit(2009, 'Seven', { reminderTime: '07:00' }),
      ],
      budget: 1,
    }),
    // G15: a snooze lost to the budget is noted, even with no cue of its own.
    make('one place for two snoozes: the sooner, the other noted', {
      items: [habit(2016, 'First', { reminderTime: undefined }), habit(2017, 'Second', { reminderTime: undefined })],
      nowMs: wall(MON, '07:35'),
      snoozes: [
        { itemId: uid(2016), until: until('07:50'), date: MON },
        { itemId: uid(2017), until: until('07:55'), date: MON },
      ],
      budget: 1,
    }),

    // The shade (§3.5: completion elsewhere after delivery → withdrawn on the
    // next reconcile). Each rang Monday at 07:30, was ticked elsewhere at
    // 22:00, and is planned next on Tuesday at 06:00.
    make('done elsewhere after it rang yesterday: withdrawn', {
      items: [vitamins({ completedDates: [MON] })],
      nowMs: wall('2026-10-06', '06:00'),
      delivered: [{ id: `dsul-item-${uid(1001)}`, deliveredAtMs: wall(MON, '07:30') }],
    }),
    make('a weekly cue done elsewhere after it rang: withdrawn, not left a week', {
      items: [vitamins({ repeatFrequency: 'weekly', repeatDays: [1], completedDates: [MON] })],
      nowMs: wall('2026-10-06', '06:00'),
      delivered: [{ id: `dsul-item-${uid(1001)}`, deliveredAtMs: wall(MON, '07:30') }],
    }),
    make('Monday still open when Wednesday is ticked: only Wednesday\'s withdrawn', {
      items: [vitamins({ repeatFrequency: 'custom', repeatDays: [1, 3, 5], completedDates: ['2026-10-07'] })],
      nowMs: wall('2026-10-07', '12:00'),
      delivered: [
        { id: `dsul-item-${uid(1001)}#2`, deliveredAtMs: wall(MON, '07:30') },
        { id: `dsul-item-${uid(1001)}#4`, deliveredAtMs: wall('2026-10-07', '07:30') },
      ],
    }),
    make('an item deleted since it rang: withdrawn', {
      items: [habit(1005, 'Reading')],
      nowMs: wall('2026-10-06', '06:00'),
      delivered: [
        { id: `dsul-item-${uid(1001)}`, deliveredAtMs: wall(MON, '07:30') },
        { id: `dsul-item-${uid(1005)}`, deliveredAtMs: wall(MON, '07:30') },
        { id: 'another-app-1', deliveredAtMs: wall(MON, '07:30') },
      ],
    }),
    make('reminders switched off: every cue withdrawn, the review kept', {
      items: [vitamins()],
      eod,
      remindersEnabled: false,
      nowMs: wall('2026-10-06', '06:00'),
      delivered: [
        { id: `dsul-item-${uid(1001)}`, deliveredAtMs: wall(MON, '07:30') },
        { id: `dsul-item-${uid(1001)}#now`, deliveredAtMs: wall(MON, '07:35'), dateStr: MON },
        { id: 'dsul-eod', deliveredAtMs: wall(MON, '21:00') },
      ],
    }),
    make('a catch-up delivered past midnight is about its own day', {
      items: [vitamins({ reminderTime: '23:50', completedDates: [MON] })],
      nowMs: wall('2026-10-06', '06:00'),
      delivered: [
        { id: `dsul-item-${uid(1001)}#now`, deliveredAtMs: wall('2026-10-06', '00:01'), dateStr: MON },
        { id: `dsul-item-${uid(1001)}`, deliveredAtMs: wall('2026-10-06', '00:01') },
      ],
    }),

    // What plans nothing, and what says why.
    make('a subtask: nothing', { items: [task(1020, 'Sub', { startDate: '2026-10-09', parentItemId: uid(1021) })] }),
    make('reminders off: no cue', { items: [vitamins()], remindersEnabled: false }),
    make('a cue time that is not HH:mm: a note', { items: [vitamins({ reminderTime: '7:30' })] }),
    make('a zone the runtime does not know: nothing, a note', { items: [vitamins()], eod, timezone: 'Not/AZone' }),
  ];
}

// ── Writing and checking ─────────────────────────────────────────────────────

type PlanFixture = {
  identifiers: IdentifiersCase[];
  snoozeFireInstant: SnoozeCase[];
  changeoverMinutes: ChangeoverCase[];
  plans: PlanCase[];
};

function buildFixture(): PlanFixture {
  return {
    identifiers: [
      { name: 'an item', itemId: uid(1001), expected: identifiers(uid(1001)) },
      { name: 'the review', itemId: null, expected: eodIdentifiers() },
    ],
    snoozeFireInstant: buildSnoozes(),
    changeoverMinutes: buildChangeovers(),
    plans: buildPlans(),
  };
}

const serialize = (f: unknown) => JSON.stringify(f, null, 2) + '\n';

describe('notification plan fixtures shared with DsulCore', () => {
  const fixture = buildFixture();
  const file = path.join(DIR, 'notification-plan.json');

  if (process.env.UPDATE_FIXTURES) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, serialize(fixture));
  }

  it('notification-plan.json exists', () => {
    expect(existsSync(file), `missing ${file}; run with UPDATE_FIXTURES=1`).toBe(true);
  });

  it('notification-plan.json has cases with unique names', () => {
    for (const list of [fixture.identifiers, fixture.snoozeFireInstant, fixture.changeoverMinutes, fixture.plans]) {
      const names = list.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('notification-plan.json is what the TS answers today', () => {
    // On drift: if the TS change is intended, regenerate with UPDATE_FIXTURES=1
    // and make the same change in ios/DsulCore/Sources/DsulCore/.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(serialize(fixture)));
  });

  // What NotificationPlanFixtureTests.swift asserts on its own, over every case:
  // the budget (pending requests only: a catch-up is delivered at once), one
  // request per identifier, each from its owner's identifiers, every
  // withdrawal one of what was delivered, and no spring-forward gap noted twice.
  it('every plan holds the invariants the Swift side checks', () => {
    for (const { name, input, expected } of fixture.plans) {
      const all = expected.requests.map((r) => r.id);
      const pending = expected.requests.filter((r) => r.trigger.type !== 'now');
      expect(pending.length, name).toBeLessThanOrEqual(input.budget ?? NOTIFICATION_BUDGET);
      expect(new Set(all).size, name).toBe(all.length);
      for (const r of expected.requests) {
        expect(r.itemId ? identifiers(r.itemId) : eodIdentifiers(), name).toContain(r.id);
      }
      const delivered = new Set((input.delivered ?? []).map((d) => d.id));
      for (const id of expected.withdraw) expect(delivered.has(id), `${name}: ${id}`).toBe(true);
      const gaps = expected.notes.filter((n) => n.code === 'dst-gap').map((n) => JSON.stringify(n));
      expect(new Set(gaps).size, name).toBe(gaps.length);
    }
  });

  it('every body is reminderCopy\'s, or the review\'s, and keeps the contract', () => {
    for (const { name, input, expected } of fixture.plans) {
      for (const r of expected.requests) {
        if (r.kind === 'eod') {
          expect({ title: r.title, body: r.body }, name).toEqual(EOD_COPY);
          continue;
        }
        const item = input.items.find((i) => i.id === r.itemId)!;
        const at = 'reminderTime' in item ? item.reminderTime : undefined;
        const anchor = ('reminderAnchor' in item ? item.reminderAnchor : undefined) || undefined;
        const words = reminderCopy({ item, at: at ?? '', anchor, snoozed: r.kind === 'snoozed' }, input.timeFormat ?? '12h');
        expect(r.body, name).toBe(words.body);
        expect(r.title, name).toBe(words.title);
        for (const line of [r.title, r.body]) expect(line, name).not.toMatch(NEVER_SCOLDS);
      }
    }
  });

  it('the cases reach every rule', () => {
    const requests = fixture.plans.flatMap((c) => c.expected.requests);
    expect(new Set(requests.map((r) => r.kind))).toEqual(new Set(['cue', 'snoozed', 'catchUp', 'eod']));
    expect(new Set(requests.map((r) => r.trigger.type))).toEqual(new Set(['calendar', 'at', 'afterMs', 'now']));
    const notes = fixture.plans.flatMap((c) => c.expected.notes);
    expect(new Set(notes.map((n) => n.code))).toEqual(new Set(['bad-zone', 'bad-time', 'dst-gap', 'over-budget']));
    expect(fixture.plans.some((c) => c.expected.withdraw.length > 0)).toBe(true);
    expect(requests.some((r) => r.trigger.type === 'calendar' && r.trigger.weekday !== undefined)).toBe(true);
    expect(requests.some((r) => r.trigger.type === 'calendar' && r.trigger.day !== undefined)).toBe(true);
    expect(requests.some((r) => r.id.endsWith('#next'))).toBe(true);
    // The budget case is the default budget, full.
    const full = fixture.plans.find((c) => c.name === '61 daily habits: 60 and a note')!;
    expect(full.expected.requests).toHaveLength(NOTIFICATION_BUDGET);
    expect(full.expected.notes).toEqual([{ code: 'over-budget', itemId: uid(1160), kept: 0 }]);
    // The snooze day gate, both ways, and the same gate on a snooze the
    // payload carries.
    const gate = (n: string) => fixture.snoozeFireInstant.find((c) => c.name === n)!.expected;
    expect(gate('23:50 is past midnight: null')).toBeNull();
    expect(gate('23:40 rings the same day')).not.toBeNull();
    const byName = (n: string) => fixture.plans.find((c) => c.name === n)!;
    const kinds = (n: string) => byName(n).expected.requests.map((r) => r.kind);
    expect(kinds('a snooze maturing past midnight: nothing')).toEqual(['cue']);
    expect(kinds('a snooze ringing at 23:59: armed')).toContain('snoozed');
    // A grace other than the default, closing the window and keeping it open.
    expect(kinds('a ten-minute grace, closed at 07:45: no catch-up')).not.toContain('catchUp');
    expect(kinds('an hour\'s grace, still open at 08:15: rings now')).toContain('catchUp');
    // A changeover at midnight is a changeover: Santiago's 00:30 is one-offs,
    // and the night it skips is noted once.
    const midnight = byName('Santiago, a 00:30 cue on its midnight changeover: one-offs, and a note').expected;
    expect(midnight.notes).toEqual([{ code: 'dst-gap', itemId: uid(1001), dateStr: '2026-09-06', at: '00:30' }]);
    expect(midnight.requests.map((r) => r.trigger.type)).toEqual(['at', 'at']);
    expect(byName('Santiago, a review at 0:30 on the same changeover: one-offs, and a note').expected.notes).toEqual([
      { code: 'dst-gap', dateStr: '2026-09-06', at: '00:30' },
    ]);
    expect(byName('Santiago, done before a 00:30 cue the night before its changeover: one note').expected.notes).toEqual([
      { code: 'dst-gap', itemId: uid(1001), dateStr: '2026-09-06', at: '00:30' },
    ]);
    for (const n of ['Santiago, its changeover earlier today: no note', 'Los Angeles, its spring-forward earlier today: no note']) {
      expect(byName(n).expected.notes, n).toEqual([]);
    }
    // The changeover's edges in New York, and zones that never change.
    const types = (n: string) => byName(n).expected.requests.map((r) => r.trigger.type);
    expect(types('00:59 is standing: New York\'s changeover starts at 01:00')).toEqual(['calendar']);
    expect(types('03:00 is standing: past New York\'s changeover')).toEqual(['calendar']);
    expect(types('a cue in New York\'s changeover minutes: one-offs')).toEqual(['at', 'at']);
    expect(types('Kolkata never changes its clocks: a small-hours cue stands')).toEqual(['calendar']);
    expect(types('UTC never changes: a small-hours review stands')).toEqual(['calendar']);
    // A next wanted cue past the first two months.
    const away = byName('paused until January: the next wanted cue is looked for a year ahead');
    expect(away.expected.requests.length).toBeGreaterThan(0);
    expect(away.expected.requests[0].firesAt - away.input.nowMs).toBeGreaterThan(60 * 86_400_000);
    // The relevance clamp: a streak past RELEVANCE_FULL_STREAK still scores 1.
    expect(byName('a streak past a month: relevance stops at 1').expected.requests.map((r) => r.relevance)).toEqual([1]);
    // A held lone day of the month is the one-off series, never a repeat.
    expect(types('monthly on the 15th, done today: the one-off series')).toEqual(['at', 'at']);
    // The 31st held by its ring after a short month, and a clamped day alone.
    expect(types('monthly on the 31st, its season ending before December\'s: October\'s alone')).toEqual(['at']);
    expect(types('monthly on the 31st, its season ending after January\'s: standing, November\'s clamped day beside it')).toEqual(['calendar', 'at']);
    expect(byName('monthly on the 31st, its season ending in March: February\'s clamped 28th alone').expected.requests.map((r) => r.dateStr)).toEqual([
      '2027-02-28',
    ]);
    // A season's end: nothing standing that would ring past it.
    expect(types('a season ending Thursday: one-offs up to Thursday, nothing after')).toEqual(['at', 'at', 'at', 'at']);
    expect(types('a season ending more than a month past the next ring: still standing')).toEqual(['calendar']);
    // A catch-up is never charged: thirty of them beside sixty pending.
    const caught = byName('a catch-up for thirty and twenty-nine Wednesday habits: every item still armed').expected;
    expect(caught.requests.filter((r) => r.trigger.type === 'now')).toHaveLength(30);
    expect(caught.requests.filter((r) => r.trigger.type !== 'now')).toHaveLength(NOTIFICATION_BUDGET);
    expect(caught.notes).toEqual([]);
    // A held review under a full budget still stands, and says so if cut.
    expect(byName('a held review in exactly seven places: all seven, no note').expected.requests).toHaveLength(7);
    // The shade: a day ticked elsewhere after its cue rang is withdrawn.
    expect(byName('done elsewhere after it rang yesterday: withdrawn').expected.withdraw).toEqual([`dsul-item-${uid(1001)}`]);
    expect(byName('Monday still open when Wednesday is ticked: only Wednesday\'s withdrawn').expected.withdraw).toEqual([
      `dsul-item-${uid(1001)}#4`,
    ]);
    expect(byName('review answered after midnight: the night it answered withdrawn').expected.withdraw).toEqual(['dsul-eod']);
  });

  // Every request rings on its item's cue minute (or the review's hour), on a
  // day the item occurs: what a drifting repeating interval broke. A calendar
  // trigger rings at its own hour and minute on its own days, so holding its
  // first ring and its components here holds every ring. And every ring in
  // the month after it (LAPSE_DAYS), and the one after it however far off,
  // wants doing: what a calendar trigger left standing past a season's end, a
  // skip or a tick ahead broke.
  it('every request rings at its own minute, on a day its item occurs and wants doing', () => {
    for (const { name, input, expected } of fixture.plans) {
      for (const r of expected.requests) {
        if (r.trigger.type === 'afterMs' || r.trigger.type === 'now') continue;
        const where = `${name}: ${r.id}`;
        const item = input.items.find((i) => i.id === r.itemId);
        const at = item && 'reminderTime' in item ? item.reminderTime : undefined;
        const want = r.kind === 'eod' ? input.eod!.time.padStart(5, '0') : at;
        const got = r.trigger.type === 'at'
          ? r.trigger.hhmm
          : `${String(r.trigger.hour).padStart(2, '0')}:${String(r.trigger.minute).padStart(2, '0')}`;
        expect(got, where).toBe(want);
        const clock = localClock(new Date(r.firesAt), input.timezone);
        expect(clock.nowMinutes, where).toBe(Number(got.slice(0, 2)) * 60 + Number(got.slice(3)));
        if (r.trigger.type === 'at') expect(r.trigger.dateStr, where).toBe(clock.dateStr);
        if (r.trigger.type === 'calendar' && r.trigger.weekday !== undefined) {
          expect(weekdayOf(clock.dateStr) + 1, where).toBe(r.trigger.weekday);
        }
        if (item) expect(occursOn(item, clock.dateStr, input.timezone), `${where} on ${clock.dateStr}`).toBe(true);
        if (r.kind === 'eod') expect(clock.dateStr, where).not.toBe(input.eod!.lastReviewDate);

        const ctx = { userTimezone: input.timezone, routines: input.routines, seasons: input.seasons };
        const t = r.trigger;
        // Its rings in the month after its first, and the one after its
        // first however far (the 31st's, two months on past a short one).
        const days = t.type === 'calendar'
          ? Array.from({ length: 63 }, (_, i) => addDays(clock.dateStr, i))
            .filter((d) => (t.weekday === undefined || weekdayOf(d) + 1 === t.weekday) && (t.day === undefined || Number(d.slice(8, 10)) === t.day))
            .filter((d, i) => i < 2 || d <= addDays(clock.dateStr, 31))
          : [clock.dateStr];
        for (const d of days) {
          if (item) expect(wantsDoingOn(item, d, ctx), `${where} rings on ${d}`).toBe(true);
          else expect(d, `${where} rings on ${d}`).not.toBe(input.eod!.lastReviewDate);
        }
      }
    }
  });
});
