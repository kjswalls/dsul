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
import { instantOf } from '@/lib/reminders/clock';
import { EOD_COPY, reminderCopy } from '@/lib/reminders/copy';
import { SNOOZE_MINUTES } from '@/lib/reminders/channels/push';
import type { Item, Routine, Season } from '@/lib/planner-types';
import { NEVER_SCOLDS } from './support/copy-contract';

/**
 * The iPhone's notification plan, shared with DsulCore.
 *
 * lib/reminders/plan.ts decides which local notifications the phone arms
 * (memory/plans/reminders-platforms.md §2.3, §5.3), and lib/reminders/snooze.ts
 * when a snooze tapped on it rings. Every case is built here, run through the
 * real TS, and written with its answer to tests/fixtures/day/notification-plan.json;
 * DsulCore's NotificationPlanFixtureTests.swift and SnoozeFixtureTests.swift
 * read the same file and assert Plan.swift and Snooze.swift answer identically.
 *
 * A case's `input` is planNotifications' input verbatim (items in the app's
 * camelCase `Item` shape, as day-fixtures.test.ts writes them) and its
 * `expected` the whole plan: requests in order, withdrawals sorted, notes.
 * Instants are epoch milliseconds.
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
    make('a cue already past today rings first tomorrow', { items: [vitamins()], nowMs: wall(MON, '09:00') }),
    make('legacy weekly: one weekday', { items: [vitamins({ repeatFrequency: 'weekly', repeatDays: [2] })] }),
    make('custom three weekdays: one slot each', { items: [vitamins({ repeatFrequency: 'custom', repeatDays: [5, 1, 3] })] }),
    make('weekdays: five slots', { items: [vitamins({ repeatFrequency: 'weekdays' })] }),
    make('weekends: two slots', { items: [vitamins({ repeatFrequency: 'weekends' })] }),
    make('custom, all seven days, is daily', { items: [vitamins({ repeatFrequency: 'custom', repeatDays: [0, 1, 2, 3, 4, 5, 6] })] }),
    make('custom with no days: nothing', { items: [vitamins({ repeatFrequency: 'custom', repeatDays: [] })] }),
    make('monthly on the 15th: a day trigger', { items: [vitamins({ repeatFrequency: 'monthly', repeatMonthDay: 15 })] }),
    make('monthly on the 31st: one-offs on the clamped days', { items: [vitamins({ repeatFrequency: 'monthly', repeatMonthDay: 31 })] }),
    make('monthly with no day: nothing', { items: [vitamins({ repeatFrequency: 'monthly' })] }),
    make('24-hour words', { items: [vitamins()], timeFormat: '24h' }),
    make('the anchor leads the words', { items: [vitamins({ reminderAnchor: 'I pour my coffee', streak: 3 })] }),

    // One-offs.
    make('a dated task: one one-off', { items: [task(1002, 'File taxes', { startDate: '2026-10-09' })] }),
    make('a task with no date: nothing', { items: [task(1002, 'File taxes')] }),
    make('a task already past: nothing', { items: [task(1002, 'File taxes', { startDate: '2026-10-01' })] }),
    make('a recurring task not yet begun: one-offs from its start', {
      items: [task(1003, 'Water plants', { repeatFrequency: 'custom', repeatDays: [1], startDate: '2026-10-09' })],
    }),
    make('a recurring task begun: standing', {
      items: [task(1003, 'Water plants', { repeatFrequency: 'daily', startDate: '2026-09-01' })],
    }),
    make('a cue time in 01:00–03:59: one-offs', { items: [vitamins({ reminderTime: '03:15' })], nowMs: wall('2026-08-10', '12:00') }),
    make('04:00 is standing again', { items: [vitamins({ reminderTime: '04:00' })] }),

    // Handled today (decision 23).
    make('done before its cue: an interval at the next wanted cue', { items: [vitamins({ completedDates: [MON] })] }),
    make('done, planned after its cue: the calendar restored', {
      items: [vitamins({ completedDates: [MON] })],
      nowMs: wall(MON, '07:31'),
    }),
    make('skipped before its cue', { items: [vitamins({ skippedDates: [MON] })] }),
    make('tallied to its target', { items: [vitamins({ timesPerDay: 2, dailyCounts: { [MON]: 2 } })] }),
    make('tallied below its target: standing', { items: [vitamins({ timesPerDay: 2, dailyCounts: { [MON]: 1 } })] }),
    make('paused until Thursday: an interval at its return', {
      items: [vitamins({ pausedAt: '2026-10-01T12:00:00Z', pausedUntil: '2026-10-08' })],
    }),
    make('paused with no end: nothing', { items: [vitamins({ pausedAt: '2026-10-01T12:00:00Z' })] }),
    make('a season starting Wednesday: an interval at its start', {
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
    make('done today: its delivered cues withdrawn, an off day left alone', {
      items: [vitamins({ completedDates: [MON] }), habit(1004, 'Long run', { repeatFrequency: 'weekends' })],
    }),
    make('the interval rounds up to whole seconds', { items: [vitamins({ completedDates: [MON] })], nowMs: at6 + 400 }),

    // Snoozes.
    make('a snooze beside the standing trigger, its cue withdrawn', {
      items: [vitamins()],
      nowMs: wall(MON, '07:35'),
      snoozes: [{ itemId: uid(1001), until: until('07:50'), date: MON }],
      localSentKeys: [`${MON}T07:30`],
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
    make('a snooze on something done meanwhile: ignored and withdrawn', {
      items: [vitamins({ completedDates: [MON] })],
      nowMs: wall(MON, '07:35'),
      snoozes: [{ itemId: uid(1001), until: until('07:50'), date: MON }],
    }),

    // Catch-up.
    make('armed inside its window: rings now, once', { items: [vitamins()], nowMs: wall(MON, '07:40') }),
    make('already rung on this device: no catch-up', {
      items: [vitamins()],
      nowMs: wall(MON, '07:40'),
      localSentKeys: [`${MON}T07:30`],
    }),
    make('the window closed: no catch-up', { items: [vitamins()], nowMs: wall(MON, '08:00') }),
    make('handled: no catch-up', { items: [vitamins({ completedDates: [MON] })], nowMs: wall(MON, '07:40') }),
    make('never beside a live snooze', {
      items: [vitamins()],
      nowMs: wall(MON, '07:40'),
      snoozes: [{ itemId: uid(1001), until: until('07:55'), date: MON }],
    }),

    // The review.
    make('review: one standing trigger', { eod, remindersEnabled: false }),
    make('review done before its hour: an interval, never absent', {
      eod: { ...eod, lastReviewDate: MON },
      nowMs: wall(MON, '20:00'),
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
    make('Tokyo: the day is Tokyo\'s', {
      timezone: 'Asia/Tokyo',
      items: [vitamins({ completedDates: [MON] })],
      nowMs: Date.parse('2026-10-04T21:00:00Z'), // 06:00 on the 5th in Tokyo
    }),

    // The budget.
    make('61 daily habits: 60 and a note', {
      items: Array.from({ length: 61 }, (_, i) => habit(1100 + i, `Habit ${i + 1}`)),
    }),
    make('a weekday set the budget cannot hold: one-offs, before the others\' slots', {
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
    make('a snooze before a catch-up', {
      items: [habit(1015, 'A'), habit(1016, 'Z', { reminderTime: '06:00' })],
      nowMs: wall(MON, '07:40'),
      localSentKeys: [`${MON}T06:00`],
      snoozes: [{ itemId: uid(1016), until: until('07:55'), date: MON }],
      budget: 1,
    }),

    // What plans nothing, and what says why.
    make('a subtask: nothing', { items: [task(1020, 'Sub', { startDate: '2026-10-09', parentItemId: uid(1021) })] }),
    make('reminders off: no cue', { items: [vitamins()], remindersEnabled: false }),
    make('a cue time that is not HH:mm: a note', { items: [vitamins({ reminderTime: '7:30' })] }),
    make('a zone the runtime does not know: nothing, a note', { items: [vitamins()], eod, timezone: 'Not/AZone' }),
  ];
}

// ── Writing and checking ─────────────────────────────────────────────────────

type PlanFixture = { identifiers: IdentifiersCase[]; snoozeFireInstant: SnoozeCase[]; plans: PlanCase[] };

function buildFixture(): PlanFixture {
  return {
    identifiers: [
      { name: 'an item', itemId: uid(1001), expected: identifiers(uid(1001)) },
      { name: 'the review', itemId: null, expected: eodIdentifiers() },
    ],
    snoozeFireInstant: buildSnoozes(),
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
    for (const list of [fixture.identifiers, fixture.snoozeFireInstant, fixture.plans]) {
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
  // the budget, one request per identifier, each from its owner's identifiers.
  it('every plan holds the invariants the Swift side checks', () => {
    for (const { name, input, expected } of fixture.plans) {
      const all = expected.requests.map((r) => r.id);
      expect(all.length, name).toBeLessThanOrEqual(input.budget ?? NOTIFICATION_BUDGET);
      expect(new Set(all).size, name).toBe(all.length);
      for (const r of expected.requests) {
        expect(r.itemId ? identifiers(r.itemId) : eodIdentifiers(), name).toContain(r.id);
      }
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
    expect(new Set(requests.map((r) => r.trigger.type))).toEqual(new Set(['calendar', 'interval', 'at', 'afterMs', 'now']));
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
    // The snooze day gate, both ways.
    const gate = (n: string) => fixture.snoozeFireInstant.find((c) => c.name === n)!.expected;
    expect(gate('23:50 is past midnight: null')).toBeNull();
    expect(gate('23:40 rings the same day')).not.toBeNull();
  });
});
