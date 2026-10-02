import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import {
  inactiveItemIdsOn,
  isItemActiveOn,
  isOpenLoopOn,
  isPausedOn,
  isSeasonActiveOn,
} from '@/lib/active';
import { deriveDayItems, flattenDayRows, BUCKET_ORDER, type DayItems } from '@/lib/day-items';
import { deriveTimedEntries } from '@/components/views/day-schedule';
import { braindumpMembers } from '@/lib/braindump-members';
import { groupRows } from '@/lib/grouping';
import { isRowDone, isRowSkipped, toggleRowDone, type ItemToggleActions } from '@/lib/item-toggle';
import { isCompletedOnDate } from '@/lib/recurrence';
import { projectItems } from '@/lib/planner-store';
import type { HabitItem, Item, Project, Routine, Season, Task } from '@/lib/planner-types';

/**
 * Today-screen cases shared with the iPhone.
 *
 * The same contract as tests/unit/recurrence-fixtures.test.ts, for the rules
 * the phone's Today screen ports: suppression (lib/active.ts), the task/habit
 * split (lib/planner-store.ts `projectItems`, imported from the store itself,
 * so a change there moves these fixtures), `deriveDayItems` (lib/day-items.ts),
 * `deriveTimedEntries` (components/views/day-schedule.tsx), braindump
 * membership (lib/braindump-members.ts), routine grouping (lib/grouping.ts)
 * and the tick rules (lib/item-toggle.ts). Every case is built here, run
 * through the real TS, and written with its answer to
 * tests/fixtures/day/*.json. DsulCore's *FixtureTests.swift
 * (ios/DsulCore/Tests/DsulCoreTests/) read the same files and assert the Swift
 * port answers identically.
 *
 * This test fails when a committed file no longer matches what the TS says.
 * Regenerate with:
 *
 *   UPDATE_FIXTURES=1 pnpm test tests/unit/day-fixtures.test.ts
 *
 * then commit the JSON together with the Swift change that keeps the port in
 * step. Never hand-edit the JSON: the inputs live here.
 *
 * Items are written in the app's camelCase `Item` shape, the one
 * /api/app/planner serves and DsulCore's `Item` decodes, so the fixtures also
 * exercise the phone's decoder. Ids are uuids because `Item.id` is a `UUID`
 * there; expected id lists are sorted wherever the TS answer is a Set.
 */

const DIR = path.resolve(__dirname, '../fixtures/day');

// ── Builders ─────────────────────────────────────────────────────────────────

/** Item n → a fixed, valid v4-shaped uuid. */
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const task = (n: number, title: string, over: Record<string, unknown> = {}): Item =>
  ({ type: 'task', id: uid(n), title, status: 'pending', isScheduled: true, order: 0, ...over }) as Item;

const custom = (n: number, customType: string, title: string, over: Record<string, unknown> = {}): Item =>
  ({
    type: 'custom',
    customType,
    id: uid(n),
    title,
    status: 'pending',
    isScheduled: true,
    order: 0,
    ...over,
  }) as Item;

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
    ...over,
  }) as Item;

const routine = (id: string, name: string, itemIds: string[], over: Partial<Routine> = {}): Routine => ({
  id,
  name,
  itemIds,
  ...over,
});

const season = (id: string, name: string, over: Partial<Season> = {}): Season => ({
  id,
  name,
  state: 'auto',
  itemIds: [],
  routineIds: [],
  ...over,
});

const project = (id: string, name: string, over: Record<string, unknown> = {}): Project =>
  ({ id, name, emoji: '', ...over }) as Project;

const sortedIds = (ids: Iterable<string>) => [...ids].sort();

// ── active.json ──────────────────────────────────────────────────────────────

type PauseCase = {
  name: string;
  pausedAt?: string;
  pausedUntil?: string;
  date: string;
  timeZone: string;
  expected: boolean;
};
type SeasonCase = { name: string; season: Season; date: string; expected: boolean };
type OpenLoopCase = { name: string; item: Item; date: string; expected: boolean };
type WorldDay = { date: string; inactive: string[]; live: string[] };
type World = {
  name: string;
  timeZone: string;
  items: Item[];
  routines: Routine[];
  seasons: Season[];
  days: WorldDay[];
};
type ActiveFixture = {
  isPausedOn: PauseCase[];
  isSeasonActiveOn: SeasonCase[];
  isOpenLoopOn: OpenLoopCase[];
  worlds: World[];
};

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';

function buildActive(): ActiveFixture {
  const pause = (
    name: string,
    p: { pausedAt?: string; pausedUntil?: string },
    date: string,
    timeZone: string
  ): PauseCase => ({ name, ...p, date, timeZone, expected: false });

  const AUG10 = '2026-08-10T12:00:00Z';
  const pauses: PauseCase[] = [
    pause('no pausedAt', {}, '2026-08-15', NY),
    pause('pausedUntil alone pauses nothing', { pausedUntil: '2026-09-01' }, '2026-08-15', NY),
    pause('empty pausedAt', { pausedAt: '' }, '2026-08-15', NY),
    pause('open-ended, on its first day', { pausedAt: AUG10 }, '2026-08-10', NY),
    pause('open-ended, the day before', { pausedAt: AUG10 }, '2026-08-09', NY),
    pause('open-ended, months later', { pausedAt: AUG10 }, '2027-01-01', NY),
    pause('until is exclusive, the day before it', { pausedAt: AUG10, pausedUntil: '2026-09-01' }, '2026-08-31', NY),
    pause('until is exclusive, on it', { pausedAt: AUG10, pausedUntil: '2026-09-01' }, '2026-09-01', NY),
    pause('until is exclusive, after it', { pausedAt: AUG10, pausedUntil: '2026-09-02' }, '2026-09-03', NY),
    pause('a timestamp until reads as its day', { pausedAt: AUG10, pausedUntil: '2026-09-01T00:00:00Z' }, '2026-09-01', NY),
    pause('a timestamp until, the day before', { pausedAt: AUG10, pausedUntil: '2026-09-01T00:00:00Z' }, '2026-08-31', NY),
    pause('until before the start ends it at once', { pausedAt: AUG10, pausedUntil: '2026-08-05' }, '2026-08-10', NY),
    // Postgres timestamptz as load_planner's to_jsonb writes it.
    pause('microseconds and +00:00, that day in LA', { pausedAt: '2026-09-30T14:03:22.123456+00:00' }, '2026-09-30', LA),
    pause('microseconds and +00:00, the day before in LA', { pausedAt: '2026-09-30T14:03:22.123456+00:00' }, '2026-09-29', LA),
    pause('whole seconds and +00:00, NY is still the day before', { pausedAt: '2026-08-10T00:00:00+00:00' }, '2026-08-09', NY),
    pause('one fractional digit and Z', { pausedAt: '2026-09-30T23:30:00.5Z' }, '2026-09-30', 'UTC'),
    pause('one fractional digit and Z, Tokyo is a day on', { pausedAt: '2026-09-30T23:30:00.5Z' }, '2026-09-30', 'Asia/Tokyo'),
    pause('milliseconds at the last instant, UTC', { pausedAt: '2026-08-10T23:59:59.999Z' }, '2026-08-10', 'UTC'),
    pause('milliseconds at the last instant, Tokyo', { pausedAt: '2026-08-10T23:59:59.999Z' }, '2026-08-10', 'Asia/Tokyo'),
    pause('+05:30 offset, read in UTC', { pausedAt: '2026-08-11T03:00:00+05:30' }, '2026-08-10', 'UTC'),
    pause('+05:30 offset, read in Kolkata', { pausedAt: '2026-08-11T03:00:00+05:30' }, '2026-08-10', 'Asia/Kolkata'),
    pause('-07:00 offset, read in UTC', { pausedAt: '2026-08-10T20:00:00-07:00' }, '2026-08-10', 'UTC'),
    pause('-07:00 offset, read in LA', { pausedAt: '2026-08-10T20:00:00-07:00' }, '2026-08-10', LA),
    pause('crosses midnight: still the 10th in NY', { pausedAt: '2026-08-11T01:00:00Z' }, '2026-08-10', NY),
    pause('crosses midnight: already the 11th in Berlin', { pausedAt: '2026-08-11T01:00:00Z' }, '2026-08-10', 'Europe/Berlin'),
    pause('a bare date is UTC midnight, so NY starts the day before', { pausedAt: '2026-08-10' }, '2026-08-09', NY),
    pause('junk pausedAt pauses nothing', { pausedAt: 'not a date' }, '2026-08-15', NY),
  ];
  for (const c of pauses) c.expected = isPausedOn(c, c.date, c.timeZone);

  const seasonCases: SeasonCase[] = (
    [
      ['manual active ignores its range', season('s', 'S', { state: 'active', startsOn: '2026-09-01', endsOn: '2026-09-30' }), '2026-08-15'],
      ['manual paused ignores its range', season('s', 'S', { state: 'paused', startsOn: '2026-08-01', endsOn: '2026-08-31' }), '2026-08-15'],
      ['auto with no range is always on', season('s', 'S'), '2026-08-15'],
      ['auto, before its start', season('s', 'S', { startsOn: '2026-06-01', endsOn: '2026-08-31' }), '2026-05-31'],
      ['auto, on its start (inclusive)', season('s', 'S', { startsOn: '2026-06-01', endsOn: '2026-08-31' }), '2026-06-01'],
      ['auto, on its end (inclusive)', season('s', 'S', { startsOn: '2026-06-01', endsOn: '2026-08-31' }), '2026-08-31'],
      ['auto, after its end', season('s', 'S', { startsOn: '2026-06-01', endsOn: '2026-08-31' }), '2026-09-01'],
      ['auto, open start', season('s', 'S', { endsOn: '2026-08-31' }), '2020-01-01'],
      ['auto, open end', season('s', 'S', { startsOn: '2026-06-01' }), '2030-01-01'],
      ['auto, inverted range is never on', season('s', 'S', { startsOn: '2026-09-01', endsOn: '2026-08-01' }), '2026-08-15'],
      ['auto, a timestamp start reads as its day', season('s', 'S', { startsOn: '2026-06-01T00:00:00Z' }), '2026-06-01'],
    ] as [string, Season, string][]
  ).map(([name, s, date]) => ({ name, season: s, date, expected: isSeasonActiveOn(s, date) }));

  const D = '2026-10-02';
  const openLoops: OpenLoopCase[] = (
    [
      ['one-off pending', task(1, 'one-off', { startDate: D })],
      ['one-off completed', task(1, 'one-off', { startDate: D, status: 'completed' })],
      ['one-off cancelled', task(1, 'one-off', { startDate: D, status: 'cancelled' })],
      ['repeat none is one-shot: completed', task(1, 'none', { repeatFrequency: 'none', status: 'completed' })],
      ['repeat none is one-shot: pending', task(1, 'none', { repeatFrequency: 'none' })],
      ['recurring task, open', task(1, 'daily', { repeatFrequency: 'daily', startDate: '2026-09-01' })],
      ['recurring task, done that day', task(1, 'daily', { repeatFrequency: 'daily', completedDates: [D] })],
      ['recurring task, done another day', task(1, 'daily', { repeatFrequency: 'daily', completedDates: ['2026-10-01'] })],
      ['recurring task, skipped that day', task(1, 'daily', { repeatFrequency: 'daily', skippedDates: [D] })],
      ['recurring task, completed status is not the truth', task(1, 'daily', { repeatFrequency: 'daily', status: 'completed' })],
      ['habit, open', habit(1, 'habit')],
      ['habit, done', habit(1, 'habit', { completedDates: [D] })],
      ['habit, skipped', habit(1, 'habit', { skippedDates: [D] })],
      ['counted habit below target', habit(1, '3x', { timesPerDay: 3, dailyCounts: { [D]: 2 } })],
      ['counted habit at target', habit(1, '3x', { timesPerDay: 3, dailyCounts: { [D]: 3 } })],
      ['counted habit over target', habit(1, '3x', { timesPerDay: 3, dailyCounts: { [D]: 4 } })],
      ['counted habit, a count on another day', habit(1, '3x', { timesPerDay: 3, dailyCounts: { '2026-10-01': 3 } })],
      ['habit with no target: any count discharges', habit(1, 'once', { dailyCounts: { [D]: 1 } })],
      ['habit with target 0 reads as 1', habit(1, 'zero', { timesPerDay: 0, dailyCounts: { [D]: 1 } })],
      ['habit, a zero count is no mark', habit(1, 'once', { dailyCounts: { [D]: 0 } })],
    ] as [string, Item][]
  ).map(([name, item]) => ({ name, item, date: D, expected: isOpenLoopOn(item, D) }));

  return {
    isPausedOn: pauses,
    isSeasonActiveOn: seasonCases,
    isOpenLoopOn: openLoops,
    worlds: [containersWorld(), tokyoWorld()],
  };
}

function resolveWorld(w: Omit<World, 'days'>, dates: string[]): World {
  const ctx = { userTimezone: w.timeZone, routines: w.routines, seasons: w.seasons };
  return {
    ...w,
    days: dates.map((date) => ({
      date,
      inactive: sortedIds(inactiveItemIdsOn(w.items, date, ctx)),
      live: sortedIds(w.items.filter((i) => isItemActiveOn(i, date, ctx)).map((i) => i.id)),
    })),
  };
}

/** Routines, seasons and the paths between them, walked across two months. */
function containersWorld(): World {
  const items: Item[] = [
    habit(1, 'standalone, in nothing'),
    habit(2, 'in a live standalone routine'),
    habit(3, 'in a paused routine'),
    habit(4, 'in a paused routine, ticked on the 12th', { completedDates: ['2026-08-12'] }),
    task(5, 'one-off in a summer season', { startDate: '2026-08-12', timeBucket: 'morning' }),
    habit(6, 'in a routine held by a paused season'),
    habit(7, 'in that routine AND a live one'),
    habit(8, 'in a routine held by a paused and an active season'),
    habit(9, 'its own pause', { pausedAt: '2026-08-10T12:00:00Z' }),
    habit(10, 'in a season that starts in September'),
    task(11, 'completed, in the paused season', { status: 'completed', startDate: '2026-08-12' }),
    task(12, 'cancelled, in the paused season', { status: 'cancelled', startDate: '2026-08-12' }),
    habit(13, 'counted, in the paused routine', {
      timesPerDay: 3,
      dailyCounts: { '2026-08-12': 1, '2026-08-15': 3 },
    }),
    task(14, 'recurring, in the paused season, skipped on the 12th', {
      repeatFrequency: 'daily',
      startDate: '2026-08-01',
      skippedDates: ['2026-08-12'],
    }),
    habit(15, 'in a routine paused late on the 10th, NY time'),
    habit(16, 'in a routine inside a summer season'),
    habit(17, 'in a season directly and through a paused routine'),
  ];
  const routines: Routine[] = [
    routine('r-live', 'Morning', [uid(2), uid(7), uid(17)]),
    routine('r-paused', 'Evening', [uid(3), uid(4), uid(13)], {
      pausedAt: '2026-08-10T15:00:00Z',
      pausedUntil: '2026-08-20',
    }),
    routine('r-in-paused-season', 'Gym', [uid(6), uid(7)]),
    routine('r-two-holders', 'Reading', [uid(8)]),
    // 03:30 UTC on the 11th is 23:30 on the 10th in New York.
    routine('r-late', 'Late', [uid(15)], { pausedAt: '2026-08-11T03:30:00.250000+00:00' }),
    routine('r-summer', 'Summer mornings', [uid(16)]),
    routine('r-paused-forever', 'Shelved', [uid(17)], { pausedAt: '2026-01-01T12:00:00Z' }),
  ];
  const seasons: Season[] = [
    season('s-summer', 'Summer', {
      startsOn: '2026-06-01',
      endsOn: '2026-08-31',
      itemIds: [uid(5), uid(17)],
      routineIds: ['r-summer'],
    }),
    season('s-paused', 'Shelf', {
      state: 'paused',
      itemIds: [uid(11), uid(12), uid(14)],
      routineIds: ['r-in-paused-season', 'r-two-holders'],
    }),
    season('s-active', 'Always', { state: 'active', routineIds: ['r-two-holders'] }),
    season('s-autumn', 'Autumn', { startsOn: '2026-09-01', itemIds: [uid(10)] }),
  ];
  return resolveWorld({ name: 'routines and seasons', timeZone: NY, items, routines, seasons }, [
    '2026-08-05',
    '2026-08-10',
    '2026-08-12',
    '2026-08-15',
    '2026-08-25',
    '2026-09-01',
    '2026-09-05',
  ]);
}

/** A routine paused at a microsecond timestamp that is already tomorrow in Tokyo. */
function tokyoWorld(): World {
  const items: Item[] = [habit(21, 'in the Tokyo routine'), task(22, 'one-off, paused itself', {
    startDate: '2026-09-30',
    pausedAt: '2026-09-29T15:30:00.000001+00:00',
  })];
  const routines: Routine[] = [
    routine('r-tokyo', 'Tokyo', [uid(21)], { pausedAt: '2026-09-29T15:30:00.000001+00:00', pausedUntil: '2026-10-02' }),
  ];
  return resolveWorld({ name: 'Tokyo pauses', timeZone: 'Asia/Tokyo', items, routines, seasons: [] }, [
    '2026-09-29',
    '2026-09-30',
    '2026-10-01',
    '2026-10-02',
  ]);
}

// ── day-items.json and timed.json ────────────────────────────────────────────

type Buckets = Record<string, string[]>;
/** The containers and items a scenario runs over, written once per file. */
type DayWorld = {
  timeZone: string;
  items: Item[];
  projects: Project[];
  routines: Routine[];
  seasons: Season[];
};
type DayScenarioInput = {
  name: string;
  /** A key of the file's `worlds`. */
  world: string;
  date: string;
  showCompletedTasks: boolean;
};
type DayExpected = {
  inactive: string[];
  tasks: string[];
  habits: string[];
  tasksByBucket: Buckets;
  habitsByBucket: Buckets;
  recurringProjects: string[];
  flat: string[];
};
type DayScenario = DayScenarioInput & { expected: DayExpected };
type TimedEntryOut = { id: string; startMin: number; duration: number };
type TimedScenario = DayScenarioInput & { expected: TimedEntryOut[] };

function runDay(
  input: DayScenarioInput,
  w: DayWorld
): { day: DayItems; inactive: Set<string>; tasks: Task[]; habits: HabitItem[] } {
  const inactive = inactiveItemIdsOn(w.items, input.date, {
    userTimezone: w.timeZone,
    routines: w.routines,
    seasons: w.seasons,
  });
  const { tasks, habits } = projectItems(w.items);
  // What hooks/use-day-items.ts passes with the phone's defaults: no canvas
  // filters, typeFilter 'all', no goal clause.
  const day = deriveDayItems({
    tasks,
    habits,
    projects: w.projects,
    dateStr: input.date,
    timezone: w.timeZone,
    typeFilter: 'all',
    showCompletedTasks: input.showCompletedTasks,
    inactiveItemIds: inactive,
  });
  return { day, inactive, tasks, habits };
}

const bucketIds = (byBucket: Record<string, { id: string }[]>): Buckets =>
  Object.fromEntries(BUCKET_ORDER.map((b) => [b, byBucket[b].map((i) => i.id)]));

/** One busy Friday: every rule deriveDayItems applies, with the phone's defaults. */
function busyWorld(): DayWorld {
  const D = '2026-10-02'; // a Friday
  const items: Item[] = [
    task(101, 'timed, morning', { startDate: D, timeBucket: 'morning', startTime: '09:00', order: 0 }),
    task(102, 'untimed, order 2', { startDate: D, timeBucket: 'morning', order: 2 }),
    task(103, 'untimed, order 1', { startDate: D, timeBucket: 'morning', order: 1 }),
    task(104, 'yesterday', { startDate: '2026-10-01', timeBucket: 'morning' }),
    task(105, 'no bucket is dropped', { startDate: D }),
    task(106, 'completed one-off', { startDate: D, timeBucket: 'afternoon', status: 'completed' }),
    task(107, 'cancelled still shows', { startDate: D, timeBucket: 'evening', status: 'cancelled' }),
    task(108, 'daily since Monday', { startDate: '2026-09-28', timeBucket: 'anytime', repeatFrequency: 'daily' }),
    task(109, 'Thursdays, anchored on this Friday', {
      startDate: D,
      timeBucket: 'anytime',
      repeatFrequency: 'custom',
      repeatDays: [4],
    }),
    task(110, 'Thursdays, anchored last Friday', {
      startDate: '2026-09-25',
      timeBucket: 'anytime',
      repeatFrequency: 'custom',
      repeatDays: [4],
    }),
    task(111, 'daily, starts next week', { startDate: '2026-10-05', timeBucket: 'anytime', repeatFrequency: 'daily' }),
    task(112, 'daily, done today', {
      startDate: '2026-09-01',
      timeBucket: 'afternoon',
      repeatFrequency: 'daily',
      completedDates: [D],
    }),
    task(113, 'daily, skipped today', {
      startDate: '2026-09-01',
      timeBucket: 'afternoon',
      repeatFrequency: 'daily',
      skippedDates: [D],
    }),
    task(114, 'subtask', { startDate: D, timeBucket: 'morning', parentItemId: uid(101) }),
    custom(115, 'errand', 'custom type, timed', { startDate: D, timeBucket: 'afternoon', startTime: '13:30' }),
    task(116, 'legacy timestamp start', { startDate: '2026-10-02T07:00:00.000Z', timeBucket: 'anytime', order: 5 }),
    task(117, 'no start date', { timeBucket: 'morning' }),
    task(118, 'stored bucket wins over the hour', { startDate: D, timeBucket: 'evening', startTime: '08:00' }),
    task(119, 'in the Deep Work block', {
      startDate: D,
      timeBucket: 'morning',
      inProjectBlock: true,
      project: 'Deep Work',
    }),
    task(120, 'in a paused routine', { startDate: D, timeBucket: 'morning' }),
    task(121, 'zero-length block', { startDate: D, timeBucket: 'afternoon', startTime: '15:00', duration: 0 }),
    task(122, 'in the Errands block, own time ignored', {
      startDate: D,
      timeBucket: 'afternoon',
      startTime: '14:00',
      inProjectBlock: true,
      project: 'Errands',
    }),
    task(123, 'in a block not on today', {
      startDate: D,
      timeBucket: 'afternoon',
      inProjectBlock: true,
      project: 'Weekend',
    }),
    task(124, 'timed with a duration', { startDate: D, timeBucket: 'morning', startTime: '09:00', duration: 50 }),
    custom(125, 'errand', 'custom type, recurring', {
      startDate: '2026-09-01',
      timeBucket: 'evening',
      repeatFrequency: 'weekdays',
    }),
    habit(201, 'daily, morning', { timeBucket: 'morning' }),
    habit(202, 'weekdays at 07:30', { timeBucket: 'morning', startTime: '07:30', repeatFrequency: 'weekdays' }),
    habit(203, 'weekends only', { timeBucket: 'morning', repeatFrequency: 'weekends' }),
    habit(204, 'monthly with no day shows nowhere', { timeBucket: 'anytime', repeatFrequency: 'monthly' }),
    habit(205, 'Fridays at 21:00 for 45', {
      timeBucket: 'evening',
      startTime: '21:00',
      duration: 45,
      repeatFrequency: 'custom',
      repeatDays: [5],
    }),
    habit(206, 'daily, no bucket is dropped'),
    habit(207, 'done today', { timeBucket: 'anytime', completedDates: [D] }),
    habit(208, 'skipped today', { timeBucket: 'anytime', skippedDates: [D] }),
    habit(209, 'counted, 1 of 3', { timeBucket: 'afternoon', timesPerDay: 3, dailyCounts: { [D]: 1 } }),
    habit(210, 'in a paused routine', { timeBucket: 'morning' }),
    habit(211, 'in a paused routine, done today', { timeBucket: 'morning', completedDates: [D] }),
    habit(212, 'monthly on the 31st', { timeBucket: 'evening', repeatFrequency: 'monthly', repeatMonthDay: 31 }),
    habit(213, 'monthly on the 2nd at 06:00', {
      timeBucket: 'morning',
      startTime: '06:00',
      repeatFrequency: 'monthly',
      repeatMonthDay: 2,
    }),
  ];
  const projects: Project[] = [
    project('p-deep', 'Deep Work', { repeatFrequency: 'daily', startTime: '09:00', timeBucket: 'morning', duration: 90 }),
    project('p-admin', 'Admin', { repeatFrequency: 'monthly', startTime: '16:00', timeBucket: 'afternoon' }),
    project('p-gym', 'Gym', { repeatFrequency: 'custom', repeatDays: [1, 3, 5], startTime: '18:00', timeBucket: 'evening' }),
    project('p-weekend', 'Weekend', { repeatFrequency: 'weekends', startTime: '10:00', timeBucket: 'morning' }),
    project('p-untimed', 'No time', { repeatFrequency: 'daily', timeBucket: 'morning' }),
    project('p-errands', 'Errands', { repeatFrequency: 'weekdays', startTime: '12:00', timeBucket: 'afternoon' }),
    // 'weekly' is legacy free text on some rows; it falls to the default arm.
    project('p-legacy', 'Legacy weekly', { repeatFrequency: 'weekly', repeatDays: [5], startTime: '11:00', timeBucket: 'morning' }),
    project('p-month-end', 'Month end', {
      repeatFrequency: 'monthly',
      repeatMonthDay: 31,
      startTime: '17:00',
      timeBucket: 'evening',
    }),
    project('p-none', 'Not recurring', { repeatFrequency: 'none', repeatDays: [5], startTime: '08:00', timeBucket: 'morning' }),
    project('p-plain', 'Plain', {}),
  ];
  const routines: Routine[] = [
    routine('r-paused', 'Paused', [uid(120), uid(210), uid(211)], { pausedAt: '2026-09-01T12:00:00Z' }),
  ];
  return { timeZone: LA, items, projects, routines, seasons: [] };
}


const DAY_WORLDS: Record<string, DayWorld> = {
  busy: busyWorld(),
  empty: { timeZone: LA, items: [], projects: [], routines: [], seasons: [] },
};

const DAY_SCENARIOS: DayScenarioInput[] = [
  { name: 'a busy Friday', world: 'busy', date: '2026-10-02', showCompletedTasks: true },
  { name: 'a busy Friday, completed tasks hidden', world: 'busy', date: '2026-10-02', showCompletedTasks: false },
  // Monthly blocks: a project with no month day reads `|| 1`, while a habit
  // with none shows nowhere (shouldShowOnDate). Both rules, as written.
  { name: 'the 1st: a monthly block with no day', world: 'busy', date: '2026-11-01', showCompletedTasks: true },
  { name: 'the 30th: the 31st clamps', world: 'busy', date: '2026-11-30', showCompletedTasks: true },
  { name: 'the next Thursday', world: 'busy', date: '2026-10-08', showCompletedTasks: true },
  { name: 'empty', world: 'empty', date: '2026-10-02', showCompletedTasks: true },
];

function buildDayItems(): { worlds: Record<string, DayWorld>; scenarios: DayScenario[] } {
  return {
    worlds: DAY_WORLDS,
    scenarios: DAY_SCENARIOS.map((input) => {
      const { day, inactive, tasks, habits } = runDay(input, DAY_WORLDS[input.world]);
      return {
        ...input,
        expected: {
          inactive: sortedIds(inactive),
          tasks: tasks.map((t) => t.id),
          habits: habits.map((h) => h.id),
          tasksByBucket: bucketIds(day.tasksByBucket),
          habitsByBucket: bucketIds(day.habitsByBucket),
          recurringProjects: day.recurringProjects.map((p) => p.id),
          flat: flattenDayRows(day).map((r) => r.item.id),
        },
      };
    }),
  };
}

function buildTimed(): { worlds: Record<string, DayWorld>; scenarios: TimedScenario[] } {
  return {
    worlds: DAY_WORLDS,
    scenarios: DAY_SCENARIOS.map((input) => ({
      ...input,
      expected: deriveTimedEntries(runDay(input, DAY_WORLDS[input.world]).day).map((e) => ({
        id: e.item.id,
        startMin: e.startMin,
        duration: e.duration,
      })),
    })),
  };
}

// ── braindump.json ───────────────────────────────────────────────────────────

type BraindumpCase = {
  name: string;
  /** The day suppression is resolved at — always today, never the selected day. */
  today: string;
  /** The day the canvas shows; the braindump ignores it. */
  selectedDate: string;
  timeZone: string;
  items: Item[];
  routines: Routine[];
  seasons: Season[];
  expected: string[];
  /** What a port that wrongly resolved at the selected day would answer. */
  atSelectedDate: string[];
};

function buildBraindump(): { cases: BraindumpCase[] } {
  const items: Item[] = [
    task(301, 'unscheduled', { isScheduled: false }),
    task(302, 'scheduled, no bucket', { isScheduled: true }),
    task(303, 'unscheduled with a bucket', { isScheduled: false, timeBucket: 'morning' }),
    task(304, 'unscheduled with a start date', { isScheduled: false, startDate: '2026-10-09' }),
    task(305, 'subtask', { isScheduled: false, parentItemId: uid(301) }),
    custom(306, 'errand', 'custom type', { isScheduled: false }),
    habit(307, 'habit, no bucket, no repeat', { repeatFrequency: 'none' }),
    habit(308, 'habit, no bucket, daily'),
    task(309, 'in a routine paused from the 4th', { isScheduled: false }),
    task(310, 'paused itself since September', { isScheduled: false, pausedAt: '2026-09-01T12:00:00Z' }),
    task(311, 'completed', { isScheduled: false, status: 'completed' }),
    task(312, 'completed, in a paused routine', { isScheduled: false, status: 'completed' }),
    task(313, 'empty bucket reads as none', { isScheduled: false, timeBucket: '' }),
    task(314, 'isScheduled missing', { isScheduled: undefined }),
    habit(315, 'habit, a bucket', { repeatFrequency: 'none', timeBucket: 'evening' }),
  ];
  const routines: Routine[] = [
    routine('r-from-4th', 'From the 4th', [uid(309)], { pausedAt: '2026-10-04T15:00:00Z' }),
    routine('r-shelved', 'Shelved', [uid(312)], { pausedAt: '2026-09-01T12:00:00Z' }),
  ];
  const make = (name: string, today: string, selectedDate: string): BraindumpCase => {
    const members = (date: string) => {
      const suppressed = inactiveItemIdsOn(items, date, { userTimezone: NY, routines, seasons: [] });
      const { tasks, habits } = projectItems(items);
      return braindumpMembers(tasks, habits, suppressed).map((r) => r.item.id);
    };
    return {
      name,
      today,
      selectedDate,
      timeZone: NY,
      items,
      routines,
      seasons: [],
      expected: members(today),
      atSelectedDate: members(selectedDate),
    };
  };
  return {
    cases: [
      make('selected day is not today', '2026-10-02', '2026-10-05'),
      make('today inside the pause', '2026-10-05', '2026-10-02'),
      make('selected day is today', '2026-10-02', '2026-10-02'),
    ],
  };
}

// ── routine-groups.json ──────────────────────────────────────────────────────

type GroupsCase = {
  name: string;
  items: Item[];
  routines: Routine[];
  expected: { groups: { routineId: string; itemIds: string[] }[]; loose: string[] };
};

function buildRoutineGroups(): { cases: GroupsCase[] } {
  const rows: Item[] = [
    habit(401, 'meds'),
    habit(402, 'stretch'),
    task(403, 'inbox', { startDate: '2026-10-02' }),
    task(404, 'standup', { startDate: '2026-10-02' }),
    task(405, 'draft', { startDate: '2026-10-02' }),
    habit(406, 'read'),
  ];
  const morning = routine('r-morning', 'Morning', [uid(404), uid(402), uid(401)]);
  // 402 is in both: it lands in whichever routine claims it first, in store order.
  const evening = routine('r-evening', 'Evening', [uid(406), uid(402)]);
  const empty = routine('r-empty', 'Not today', [uid(999)]);
  const twin = routine('r-twin', 'Morning', [uid(405)]);
  const make = (name: string, items: Item[], routines: Routine[]): GroupsCase => {
    const groups = groupRows(
      items.map((item) =>
        item.type === 'habit'
          ? { itemType: 'habit' as const, item: item as HabitItem }
          : { itemType: 'task' as const, item: item as Task }
      ),
      'routine',
      { routines }
    );
    return {
      name,
      items,
      routines,
      expected: {
        groups: groups.filter((g) => g.gate).map((g) => ({ routineId: g.gate!.id, itemIds: g.rows.map((r) => r.item.id) })),
        loose: groups.find((g) => !g.gate)?.rows.map((r) => r.item.id) ?? [],
      },
    };
  };
  return {
    cases: [
      make('an item in two routines goes to the first', rows, [morning, evening, empty]),
      make('store order decides the claim', rows, [evening, morning, empty]),
      make('two routines may share a name', rows, [morning, twin]),
      make('no routines: everything is loose', rows, []),
      make('no rows', [], [morning, evening]),
    ],
  };
}

// ── toggle.json ──────────────────────────────────────────────────────────────

type ToggleCall =
  | { fn: 'toggleTaskStatus'; status: string | null; date: string | null }
  | { fn: 'toggleHabitStatus'; status: string; count: number | null; date: string | null };
type ToggleCase = {
  name: string;
  item: Item;
  date: string;
  isRowDone: boolean;
  isRowSkipped: boolean;
  calls: ToggleCall[];
  /** The write the phone sends (POST /api/app/items/:id `complete`), or null for none. */
  intent: { done: boolean; count?: number } | null;
};

/**
 * The end state each recorded call asks the store for. item-toggle.ts decides
 * WHICH action and arguments; the store then resolves them
 * (lib/planner-store.ts `toggleTaskStatus` and `toggleHabitStatus`):
 * - a recurring task (called with a date) flips that date's completion;
 * - a one-off task (no date, no status) flips `completed` ↔ `pending`, so a
 *   cancelled task ticks to completed;
 * - a habit is done exactly when the status asked for is 'done', and carries
 *   the count it was given.
 * That resolution is the phone's `tickIntent`, so it is spelled out here.
 */
function intentOf(call: ToggleCall, item: Item, dateStr: string): { done: boolean; count?: number } {
  if (call.fn === 'toggleHabitStatus') {
    return call.count === null ? { done: call.status === 'done' } : { done: call.status === 'done', count: call.count };
  }
  if (call.date !== null) return { done: !isCompletedOnDate(item, dateStr) };
  const next = call.status ?? (item.status === 'completed' ? 'pending' : 'completed');
  return { done: next === 'completed' };
}

function buildToggle(): { cases: ToggleCase[] } {
  const D = '2026-10-02';
  const make = (name: string, item: Item): ToggleCase => {
    const row =
      item.type === 'habit'
        ? { itemType: 'habit' as const, item: item as HabitItem }
        : { itemType: 'task' as const, item: item as Task };
    const calls: ToggleCall[] = [];
    const dateOut = (date?: Date) => (date ? D : null);
    const actions: ItemToggleActions = {
      toggleTaskStatus: (_id, status, date) => {
        calls.push({ fn: 'toggleTaskStatus', status: status ?? null, date: dateOut(date) });
      },
      toggleHabitStatus: (_id, status, count, date) => {
        calls.push({ fn: 'toggleHabitStatus', status, count: count ?? null, date: dateOut(date) });
      },
    };
    toggleRowDone(row, { date: new Date(`${D}T12:00:00`), dateStr: D }, actions);
    if (calls.length > 1) throw new Error(`${name}: one tick made ${calls.length} store calls`);
    return {
      name,
      item,
      date: D,
      isRowDone: isRowDone(row, D),
      isRowSkipped: isRowSkipped(row, D),
      calls,
      intent: calls.length ? intentOf(calls[0], item, D) : null,
    };
  };
  const counted = (over: Record<string, unknown>) => habit(501, 'water x3', { timesPerDay: 3, ...over });
  const cases = [
    make('one-off pending ticks done', task(501, 'one-off', { startDate: D })),
    make('one-off completed unticks', task(501, 'one-off', { startDate: D, status: 'completed' })),
    make('one-off cancelled ticks done', task(501, 'one-off', { startDate: D, status: 'cancelled' })),
    make('recurring task ticks that date', task(501, 'daily', { repeatFrequency: 'daily', startDate: '2026-09-01' })),
    make('recurring task done that date unticks', task(501, 'daily', { repeatFrequency: 'daily', completedDates: [D] })),
    make('recurring task done another date ticks', task(501, 'daily', { repeatFrequency: 'daily', completedDates: ['2026-10-01'] })),
    make('recurring task skipped is refused', task(501, 'daily', { repeatFrequency: 'daily', skippedDates: [D] })),
    make('recurring task completed status is not the truth', task(501, 'daily', { repeatFrequency: 'daily', status: 'completed' })),
    make('custom one-off ticks done', custom(501, 'errand', 'errand', { startDate: D })),
    make('custom recurring done unticks', custom(501, 'errand', 'errand', { repeatFrequency: 'weekdays', completedDates: [D] })),
    make('habit ticks done', habit(501, 'stretch')),
    make('habit done unticks', habit(501, 'stretch', { completedDates: [D], streak: 4 })),
    make('habit skipped is refused', habit(501, 'stretch', { skippedDates: [D] })),
    make('habit skipped and completed is refused', habit(501, 'stretch', { skippedDates: [D], completedDates: [D] })),
    make('habit with target 1 is binary', habit(501, 'once', { timesPerDay: 1, dailyCounts: { [D]: 0 } })),
    make('counted habit 0 of 3 steps to 1', counted({})),
    make('counted habit 1 of 3 steps to 2', counted({ dailyCounts: { [D]: 1 } })),
    make('counted habit 2 of 3 reaches target', counted({ dailyCounts: { [D]: 2 } })),
    make('counted habit at target unticks to 0', counted({ dailyCounts: { [D]: 3 }, completedDates: [D] })),
    make('counted habit done without a count unticks to 0', counted({ completedDates: [D] })),
    make('counted habit at count but not done ticks done', counted({ dailyCounts: { [D]: 3 } })),
    make('counted habit skipped is refused', counted({ dailyCounts: { [D]: 1 }, skippedDates: [D] })),
  ];
  return { cases };
}

// ── Writing and checking ─────────────────────────────────────────────────────

const FIXTURES: Record<string, () => unknown> = {
  active: buildActive,
  'day-items': buildDayItems,
  timed: buildTimed,
  braindump: buildBraindump,
  'routine-groups': buildRoutineGroups,
  toggle: buildToggle,
};

const serialize = (f: unknown) => JSON.stringify(f, null, 2) + '\n';

describe('day fixtures shared with DsulCore', () => {
  const generated = Object.fromEntries(Object.entries(FIXTURES).map(([name, build]) => [name, build()]));

  if (process.env.UPDATE_FIXTURES) {
    mkdirSync(DIR, { recursive: true });
    for (const [name, value] of Object.entries(generated)) {
      writeFileSync(path.join(DIR, `${name}.json`), serialize(value));
    }
  }

  for (const [name, value] of Object.entries(generated)) {
    const file = path.join(DIR, `${name}.json`);

    it(`${name}.json exists`, () => {
      expect(existsSync(file), `missing ${file}; run with UPDATE_FIXTURES=1`).toBe(true);
    });

    it(`${name}.json has cases with unique names`, () => {
      const lists = Object.values(value as Record<string, unknown>).filter((v): v is { name: string }[] =>
        Array.isArray(v)
      );
      expect(lists.length).toBeGreaterThan(0);
      for (const list of lists) {
        expect(list.length).toBeGreaterThan(0);
        const names = list.map((c) => c.name);
        expect(new Set(names).size).toBe(names.length);
      }
    });

    it(`${name}.json is what the TS answers today`, () => {
      // On drift: if the TS change is intended, regenerate with UPDATE_FIXTURES=1
      // and make the same change in ios/DsulCore/Sources/DsulCore/.
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(serialize(value)));
    });
  }

  it('the cases exercise both answers of every predicate', () => {
    const active = generated.active as ActiveFixture;
    for (const list of [active.isPausedOn, active.isSeasonActiveOn, active.isOpenLoopOn]) {
      expect(new Set(list.map((c) => c.expected))).toEqual(new Set([true, false]));
    }
    const world = active.worlds[0];
    expect(world.days.some((d) => d.inactive.length > 0)).toBe(true);
    expect(world.days.some((d) => d.live.length < world.items.length)).toBe(true);

    const braindump = (generated.braindump as { cases: BraindumpCase[] }).cases[0];
    expect(braindump.expected).not.toEqual(braindump.atSelectedDate);

    const toggles = (generated.toggle as { cases: ToggleCase[] }).cases;
    expect(toggles.some((c) => c.intent === null)).toBe(true);
    expect(toggles.some((c) => c.intent?.count === 0)).toBe(true);
    // A binary tick always asks for the opposite of what the row shows; were it
    // not, a tick would re-send the state the box already has.
    for (const c of toggles) {
      if (c.intent && c.intent.count === undefined) expect(c.intent.done, c.name).toBe(!c.isRowDone);
    }
  });
});
