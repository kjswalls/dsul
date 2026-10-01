import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import {
  anchoredSeriesOn,
  firstRepeatDayFrom,
  shouldShowOnDate,
  isCompletedOnDate,
  isSkippedOnDate,
  isRecurring,
} from '@/lib/recurrence';

/**
 * Shared recurrence cases for the web and the iPhone.
 *
 * The cases are built here, run through the real lib/recurrence.ts, and written
 * with their results to tests/fixtures/recurrence/cases.json. DsulCore's
 * RecurrenceFixtureTests.swift (ios/DsulCore/Tests/DsulCoreTests/) reads the same
 * file and asserts the Swift port answers identically, so a change to either
 * side that the other doesn't make turns CI red.
 *
 * This test fails when the committed file no longer matches what the TS says
 * (a case added here, or a behavior change in lib/recurrence.ts). Regenerate it
 * with:
 *
 *   UPDATE_FIXTURES=1 pnpm test tests/unit/recurrence-fixtures.test.ts
 *
 * then commit the JSON together with the Swift change that keeps the port in
 * step. Never hand-edit the JSON: the inputs live here.
 *
 * Rules carry the web's item field names (repeatFrequency / repeatDays /
 * repeatMonthDay); the Swift side maps them onto RepeatRule. A missing key is
 * `undefined` on the web and nil in Swift, and so is an explicit null.
 */

const FIXTURE = path.resolve(__dirname, '../fixtures/recurrence/cases.json');

type Rule = { repeatFrequency?: string | null; repeatDays?: number[]; repeatMonthDay?: number };
// The web signatures say `string`, but rows reach them with null too.
type WebRule = Parameters<typeof shouldShowOnDate>[0];
const web = (rule: Rule) => rule as WebRule;
// Unused by every function under test; passed because the signatures want it.
const TZ = 'UTC';

// Sun 2025-01-12 … Sat 2025-01-18
const WEEK = ['2025-01-12', '2025-01-13', '2025-01-14', '2025-01-15', '2025-01-16', '2025-01-17', '2025-01-18'];

const WEEK_RULES: [string, Rule][] = [
  ['daily', { repeatFrequency: 'daily' }],
  ['weekdays', { repeatFrequency: 'weekdays' }],
  ['weekends', { repeatFrequency: 'weekends' }],
  ['custom Mon/Wed/Fri', { repeatFrequency: 'custom', repeatDays: [1, 3, 5] }],
  ['weekly (legacy) Sun/Sat', { repeatFrequency: 'weekly', repeatDays: [0, 6] }],
  ['custom no days', { repeatFrequency: 'custom', repeatDays: [] }],
  ['custom days missing', { repeatFrequency: 'custom' }],
  ['custom out-of-range day 7', { repeatFrequency: 'custom', repeatDays: [7] }],
  ['none', { repeatFrequency: 'none' }],
  ['frequency missing', {}],
  ['frequency null', { repeatFrequency: null }],
  ['frequency empty', { repeatFrequency: '' }],
  ['unknown frequency', { repeatFrequency: 'fortnightly' }],
];

/** [label, monthDay (undefined = missing), day] */
const MONTHLY: [string, number | undefined, string][] = [
  ['15th, day before', 15, '2025-01-14'],
  ['15th, on it', 15, '2025-01-15'],
  ['15th, day after', 15, '2025-01-16'],
  ['1st, new year', 1, '2026-01-01'],
  ['31st in Jan', 31, '2025-01-31'],
  ['31st on Jan 30', 31, '2025-01-30'],
  ['31st clamps to Feb 28 (2025)', 31, '2025-02-28'],
  ['31st not Feb 27 (2025)', 31, '2025-02-27'],
  ['31st clamps to Feb 29 (2024 leap)', 31, '2024-02-29'],
  ['31st not Feb 28 (2024 leap)', 31, '2024-02-28'],
  ['31st clamps to Apr 30', 31, '2025-04-30'],
  ['31st not Apr 29', 31, '2025-04-29'],
  ['30th clamps to Feb 28 (2025)', 30, '2025-02-28'],
  ['30th in Apr', 30, '2025-04-30'],
  ['30th clamps to Feb 29 (2000, leap century)', 30, '2000-02-29'],
  ['29th clamps to Feb 28 (2025)', 29, '2025-02-28'],
  ['29th clamps to Feb 28 (2100, not leap)', 29, '2100-02-28'],
  ['29th on Feb 29 (2024 leap)', 29, '2024-02-29'],
  ['29th not Feb 28 (2024 leap)', 29, '2024-02-28'],
  ['29th in Mar', 29, '2025-03-29'],
  ['29th not Mar 28', 29, '2025-03-28'],
  ['out-of-range 40 clamps to Jan 31', 40, '2025-01-31'],
  ['zero never matches', 0, '2025-01-01'],
  ['monthDay missing', undefined, '2025-01-15'],
];

type ShowCase = { name: string; rule: Rule; day: string; expected: boolean };
type AnchoredCase = { name: string; rule: Rule; start: string; day: string; expected: boolean };
type FirstCase = { name: string; rule: Rule; from: string; expected: string };
type DatesCase = { name: string; dates?: string[]; day: string; expected: boolean };
type RecurringCase = { name: string; rule: Rule; expected: boolean };

type Fixture = {
  shouldShowOnDate: ShowCase[];
  anchoredSeriesOn: AnchoredCase[];
  firstRepeatDayFrom: FirstCase[];
  isCompletedOnDate: DatesCase[];
  isSkippedOnDate: DatesCase[];
  isRecurring: RecurringCase[];
};

const thu: Rule = { repeatFrequency: 'custom', repeatDays: [4] };
const monthly = (n: number | undefined): Rule =>
  n === undefined ? { repeatFrequency: 'monthly' } : { repeatFrequency: 'monthly', repeatMonthDay: n };

function build(): Fixture {
  const show: ShowCase[] = [];
  for (const [label, rule] of WEEK_RULES) {
    for (const day of WEEK) show.push({ name: `${label} on ${day}`, rule, day, expected: false });
  }
  for (const [label, n] of [['weekdays', 'weekdays'], ['weekends', 'weekends']] as const) {
    // Across a year boundary: Wed 2025-12-31, Thu 2026-01-01, Sat 2026-01-03.
    for (const day of ['2025-12-31', '2026-01-01', '2026-01-03']) {
      show.push({ name: `${label} on ${day}`, rule: { repeatFrequency: n }, day, expected: false });
    }
  }
  for (const [label, n, day] of MONTHLY) {
    show.push({ name: `monthly ${label}`, rule: monthly(n), day, expected: false });
  }
  for (const c of show) c.expected = shouldShowOnDate(web(c.rule), c.day, TZ);

  const anchored: AnchoredCase[] = [
    // A Thursday series whose start was moved to a Friday.
    { name: 'Thu series, day before start', rule: thu, start: '2025-01-17', day: '2025-01-16', expected: false },
    { name: 'Thu series, its Friday start counts', rule: thu, start: '2025-01-17', day: '2025-01-17', expected: false },
    { name: 'Thu series, Saturday after start', rule: thu, start: '2025-01-17', day: '2025-01-18', expected: false },
    { name: 'Thu series, next Thursday', rule: thu, start: '2025-01-17', day: '2025-01-23', expected: false },
    { name: 'Thu series, Thursday before start', rule: thu, start: '2025-01-17', day: '2025-01-09', expected: false },
    { name: 'timestamp start reads as its day', rule: thu, start: '2025-01-17T09:30:00.000Z', day: '2025-01-17', expected: false },
    { name: 'none rule, on start', rule: { repeatFrequency: 'none' }, start: '2025-01-17', day: '2025-01-17', expected: false },
    { name: 'none rule, after start', rule: { repeatFrequency: 'none' }, start: '2025-01-17', day: '2025-01-18', expected: false },
    { name: 'daily, before start', rule: { repeatFrequency: 'daily' }, start: '2025-03-01', day: '2025-02-28', expected: false },
    { name: 'daily, after start', rule: { repeatFrequency: 'daily' }, start: '2025-03-01', day: '2025-03-02', expected: false },
    { name: 'monthly 31st, clamped Feb after start', rule: monthly(31), start: '2025-01-10', day: '2025-02-28', expected: false },
    { name: 'monthly 31st, start across a year', rule: monthly(31), start: '2024-12-31', day: '2025-01-31', expected: false },
  ];
  for (const c of anchored) c.expected = anchoredSeriesOn(web(c.rule), c.start, c.day, TZ);

  const first: FirstCase[] = [
    { name: 'Thu series from a Friday', rule: thu, from: '2025-01-17', expected: '' },
    { name: 'Thu series from a Thursday', rule: thu, from: '2025-01-16', expected: '' },
    { name: 'timestamp from', rule: thu, from: '2025-01-17T23:00:00Z', expected: '' },
    { name: 'weekdays from Saturday', rule: { repeatFrequency: 'weekdays' }, from: '2025-01-18', expected: '' },
    { name: 'weekends from Monday', rule: { repeatFrequency: 'weekends' }, from: '2025-01-13', expected: '' },
    { name: 'daily from itself', rule: { repeatFrequency: 'daily' }, from: '2025-01-15', expected: '' },
    { name: 'monthly 31st from Feb 1 (2025)', rule: monthly(31), from: '2025-02-01', expected: '' },
    { name: 'monthly 29th from Feb 1 (2024 leap)', rule: monthly(29), from: '2024-02-01', expected: '' },
    { name: 'monthly 15th across a year', rule: monthly(15), from: '2025-12-20', expected: '' },
    { name: 'Sat series across a year', rule: { repeatFrequency: 'custom', repeatDays: [6] }, from: '2025-12-28', expected: '' },
    { name: 'none falls back to from', rule: { repeatFrequency: 'none' }, from: '2025-01-15', expected: '' },
    { name: 'none falls back to sliced from', rule: { repeatFrequency: 'none' }, from: '2025-01-15T10:00:00Z', expected: '' },
    { name: 'custom no days falls back', rule: { repeatFrequency: 'custom', repeatDays: [] }, from: '2025-01-15', expected: '' },
    { name: 'unknown frequency falls back', rule: { repeatFrequency: 'fortnightly' }, from: '2025-01-15', expected: '' },
    { name: 'monthly without a day falls back', rule: monthly(undefined), from: '2025-01-15', expected: '' },
  ];
  for (const c of first) c.expected = firstRepeatDayFrom(web(c.rule), c.from);

  const dates = (): DatesCase[] => [
    { name: 'dates missing', day: '2025-01-15', expected: false },
    { name: 'dates empty', dates: [], day: '2025-01-15', expected: false },
    { name: 'on a listed day', dates: ['2025-01-14', '2025-01-15'], day: '2025-01-15', expected: false },
    { name: 'on an unlisted day', dates: ['2025-01-14', '2025-01-16'], day: '2025-01-15', expected: false },
    { name: 'a timestamp entry is not the day', dates: ['2025-01-15T00:00:00Z'], day: '2025-01-15', expected: false },
  ];
  const completed = dates();
  for (const c of completed) c.expected = isCompletedOnDate({ completedDates: c.dates }, c.day);
  const skipped = dates();
  for (const c of skipped) c.expected = isSkippedOnDate({ skippedDates: c.dates }, c.day);

  const recurring: RecurringCase[] = (
    [
      ['frequency missing', {}],
      ['frequency null', { repeatFrequency: null }],
      ['frequency empty', { repeatFrequency: '' }],
      ['none', { repeatFrequency: 'none' }],
      ['daily', { repeatFrequency: 'daily' }],
      ['weekdays', { repeatFrequency: 'weekdays' }],
      ['custom', { repeatFrequency: 'custom', repeatDays: [1] }],
      ['monthly', { repeatFrequency: 'monthly', repeatMonthDay: 1 }],
      ['unknown frequency still counts', { repeatFrequency: 'fortnightly' }],
    ] as [string, Rule][]
  ).map(([name, rule]) => ({ name, rule, expected: isRecurring(web(rule)) }));

  return {
    shouldShowOnDate: show,
    anchoredSeriesOn: anchored,
    firstRepeatDayFrom: first,
    isCompletedOnDate: completed,
    isSkippedOnDate: skipped,
    isRecurring: recurring,
  };
}

const serialize = (f: Fixture) => JSON.stringify(f, null, 2) + '\n';

describe('recurrence fixtures shared with DsulCore', () => {
  const generated = build();

  if (process.env.UPDATE_FIXTURES) {
    mkdirSync(path.dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, serialize(generated));
  }

  it('the committed file exists', () => {
    expect(existsSync(FIXTURE), `missing ${FIXTURE}; run with UPDATE_FIXTURES=1`).toBe(true);
  });

  it('covers every function the Swift port mirrors', () => {
    for (const [fn, cases] of Object.entries(generated)) {
      expect(cases.length, fn).toBeGreaterThan(0);
    }
    const total = Object.values(generated).reduce((n, cases) => n + cases.length, 0);
    expect(total).toBeGreaterThanOrEqual(60);
  });

  it('names are unique per function, so a Swift failure points at one case', () => {
    for (const [fn, cases] of Object.entries(generated)) {
      const names = (cases as { name: string }[]).map((c) => c.name);
      expect(new Set(names).size, fn).toBe(names.length);
    }
  });

  it('the committed results are what lib/recurrence.ts answers today', () => {
    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;
    // On drift: if the TS change is intended, regenerate with UPDATE_FIXTURES=1
    // and make the same change in ios/DsulCore/Sources/DsulCore/Recurrence.swift.
    expect(committed).toEqual(generated);
  });
});
