import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import {
  formatDay,
  inactiveItemIdsOn,
  isItemActiveOn,
  isOpenLoopOn,
  isPausedOn,
  isSeasonActiveOn,
  resolvePauseWrite,
  type Pausable,
} from '@/lib/active';
import { deriveDayItems, flattenDayRows, BUCKET_ORDER, type DayItems } from '@/lib/day-items';
import { deriveTimedEntries } from '@/components/views/day-schedule';
import { braindumpMembers } from '@/lib/braindump-members';
import { groupRows } from '@/lib/grouping';
import { isRowDone, isRowSkipped, toggleRowDone, type ItemToggleActions } from '@/lib/item-toggle';
import {
  ITEM_VERBS,
  deleteConfirmTitle,
  eligibleVerbs,
  nextDayOf,
  occurrenceOn,
  type VerbContext,
} from '@/lib/item-verbs';
import {
  buildCustomTypeConfig,
  getItemTypeConfig,
  isCollectible,
  isPausable,
  isRemindable,
  isSkippable,
  type ItemTypeConfig,
} from '@/lib/item-registry';
import { canMoveToNextDay, canReschedule, formatTargetDay, nextDayLabel, nextDayTarget } from '@/lib/row-moves';
import { reminderNeedsDate } from '@/lib/bulk-edit';
import { cadenceLabel } from '@/lib/cadence';
import { membershipSummary } from '@/lib/item-bands';
import { occursOn } from '@/lib/reminders/due';
import { formatCueTime, type TimeFormat } from '@/lib/reminders/copy';
import { isCompletedOnDate } from '@/lib/recurrence';
import { projectItems } from '@/lib/planner-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { EXT_STREAKS } from '@/lib/extension-registry';
import type { OccurrenceState } from '@/lib/container-schedule';
import type { HabitItem, Item, Project, Routine, Season, Task } from '@/lib/planner-types';

/**
 * Today-screen cases shared with the iPhone.
 *
 * The same contract as tests/unit/recurrence-fixtures.test.ts, for the rules
 * the phone's Today screen ports: suppression (lib/active.ts), the task/habit
 * split (lib/planner-store.ts `projectItems`, imported from the store itself,
 * so a change there moves these fixtures), `deriveDayItems` (lib/day-items.ts),
 * `deriveTimedEntries` (components/views/day-schedule.tsx), braindump
 * membership (lib/braindump-members.ts), routine grouping (lib/grouping.ts),
 * the tick rules (lib/item-toggle.ts), and what the item sheet asks: the verb
 * gates and labels (lib/item-verbs.ts), the carry (lib/row-moves.ts), the
 * occurrence (lib/reminders/due.ts `occursOn`), the pause write
 * (lib/active.ts `resolvePauseWrite`), the registry capabilities and the chip
 * copy. Every case is built here, run through the real TS, and written with
 * its answer to tests/fixtures/day/*.json. DsulCore's *FixtureTests.swift
 * (ios/DsulCore/Tests/DsulCoreTests/) read the same files and assert the Swift
 * port answers identically. The sheet's optimistic writes, which need the real
 * store, are in tests/unit/verb-writes-fixtures.test.ts (verb-writes.json).
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

// ── verbs.json ───────────────────────────────────────────────────────────────

/**
 * The verbs the phone's item sheet offers, in ITEM_VERBS (declaration) order.
 * `delete` is always eligible, so it alone is exempt from the both-answers
 * check below. `resetStreak` is offered from the streak chip, not the bar.
 */
const SHEET_VERBS = [
  'tick',
  'skip',
  'unskip',
  'pause',
  'resume',
  'nextDay',
  'reschedule',
  'resetStreak',
  'delete',
] as const;
const ALWAYS_ELIGIBLE: ReadonlySet<SheetVerb> = new Set(['delete']);
type SheetVerb = (typeof SHEET_VERBS)[number];

type VerbAnswer = { eligible: boolean; label: string };
type VerbsCase = {
  name: string;
  item: Item;
  dateStr: string;
  todayStr: string;
  timeZone: string;
  /** What the caller knows about `dateStr`; null is unknown (the palette's case). */
  occurrence: OccurrenceState | 'absent' | null;
  /**
   * The Streaks extension (lib/extension-gates.ts streaksEnabled), which
   * Reset streak asks. The phone reads it from the payload's settings.
   */
  streaksEnabled: boolean;
  verbs: Record<Exclude<SheetVerb, 'nextDay'>, VerbAnswer> & {
    nextDay: VerbAnswer & { detail: string; target: string };
  };
  /** `eligibleVerbs`, narrowed to SHEET_VERBS and kept in its order. */
  eligible: SheetVerb[];
};

/**
 * Each case's occurrence is what the sheet would pass: `occurrenceOn` unless
 * the case names one ('unknown' for none at all), so the gates are checked
 * against every state a caller can hand them. Streaks is on unless the case
 * turns it off, through the extensions store the web's gate reads.
 */
function buildVerbs(): { cases: VerbsCase[] } {
  const T = '2026-10-02'; // a Friday
  const SAT = '2026-10-03';
  const WED = '2026-09-30';
  const NEXT_THU = '2026-10-08';
  const PAUSED = '2026-09-20T15:00:00Z';
  const sheet = new Set<string>(SHEET_VERBS);
  const make = (
    name: string,
    item: Item,
    opts: {
      dateStr?: string;
      todayStr?: string;
      timeZone?: string;
      occurrence?: OccurrenceState | 'absent' | 'unknown';
      streaksEnabled?: boolean;
    } = {}
  ): VerbsCase => {
    const streaksEnabled = opts.streaksEnabled ?? true;
    const dateStr = opts.dateStr ?? T;
    const todayStr = opts.todayStr ?? T;
    const timeZone = opts.timeZone ?? NY;
    const occurrence =
      opts.occurrence === 'unknown' ? undefined : (opts.occurrence ?? occurrenceOn(item, dateStr, todayStr, timeZone));
    const ctx: VerbContext = {
      dateStr,
      date: new Date(`${dateStr}T12:00:00Z`),
      todayStr,
      tz: timeZone,
      milestoneIds: new Set(),
      occurrence,
    };
    const answer = (id: SheetVerb): VerbAnswer => ({
      eligible: ITEM_VERBS[id].eligible(item, ctx),
      label: ITEM_VERBS[id].label(item, ctx),
    });
    useExtensionsStore.setState({ enabled: { [EXT_STREAKS]: streaksEnabled } });
    try {
      return {
        name,
        item,
        dateStr,
        todayStr,
        timeZone,
        occurrence: occurrence ?? null,
        streaksEnabled,
        verbs: {
          tick: answer('tick'),
          skip: answer('skip'),
          unskip: answer('unskip'),
          pause: answer('pause'),
          resume: answer('resume'),
          nextDay: { ...answer('nextDay'), detail: ITEM_VERBS.nextDay.detail!(item, ctx)!, target: nextDayOf(item, ctx) },
          reschedule: answer('reschedule'),
          resetStreak: answer('resetStreak'),
          delete: answer('delete'),
        },
        eligible: eligibleVerbs(item, ctx)
          .map((v) => v.id)
          .filter((id): id is SheetVerb => sheet.has(id)),
      };
    } finally {
      useExtensionsStore.setState({ enabled: {} });
    }
  };
  const stretch = (over: Record<string, unknown> = {}) => habit(601, 'stretch', over);
  const counted = (over: Record<string, unknown> = {}) => habit(602, 'water x3', { timesPerDay: 3, ...over });
  const journal = (over: Record<string, unknown>) => habit(604, 'journal', over);
  const daily = (over: Record<string, unknown> = {}) =>
    task(610, 'water plants', { repeatFrequency: 'daily', startDate: '2026-09-01', timeBucket: 'morning', ...over });
  const oneOff = (over: Record<string, unknown> = {}) =>
    task(620, 'buy milk', { startDate: T, timeBucket: 'morning', ...over });
  const subtask = (over: Record<string, unknown> = {}) =>
    task(621, 'oat milk', { startDate: T, timeBucket: 'morning', parentItemId: uid(620), ...over });
  const errand = (over: Record<string, unknown> = {}) =>
    custom(630, 'errand', 'post office', { startDate: T, timeBucket: 'afternoon', ...over });
  const weekdayErrand = (over: Record<string, unknown> = {}) =>
    errand({ repeatFrequency: 'weekdays', startDate: '2026-09-01', ...over });
  return {
    cases: [
      // Habits.
      make('habit, due today', stretch()),
      make('habit, done today', stretch({ completedDates: [T], streak: 3 })),
      make('habit with a streak, due today', stretch({ streak: 5 })),
      make('habit with a streak, Streaks off', stretch({ streak: 5 }), { streaksEnabled: false }),
      make('habit, skipped today', stretch({ skippedDates: [T], status: 'skipped' })),
      make('habit, skipped and completed today', stretch({ skippedDates: [T], completedDates: [T] })),
      make('counted habit, nothing counted', counted()),
      make('counted habit, 1 of 3', counted({ dailyCounts: { [T]: 1 } })),
      make('counted habit, done', counted({ dailyCounts: { [T]: 3 }, completedDates: [T] })),
      make('weekday habit on a Saturday is absent', habit(603, 'standup', { repeatFrequency: 'weekdays' }), {
        dateStr: SAT,
      }),
      make('habit on a past open day', stretch(), { dateStr: WED }),
      make('habit done on a past day', stretch({ completedDates: [WED] }), { dateStr: WED }),
      make('habit on a future day is due', stretch(), { dateStr: SAT }),
      make('habit on a past day, occurrence unknown', stretch(), { dateStr: WED, occurrence: 'unknown' }),
      make('habit paused, open-ended', journal({ pausedAt: PAUSED })),
      make('habit paused until next week', journal({ pausedAt: PAUSED, pausedUntil: NEXT_THU })),
      make('habit whose pause ends today is live', journal({ pausedAt: PAUSED, pausedUntil: T })),
      // 02:00 UTC on the 3rd is 22:00 on the 2nd in New York.
      make('habit paused tonight, New York', journal({ pausedAt: '2026-10-03T02:00:00Z' })),
      make('habit paused tonight, read in UTC', journal({ pausedAt: '2026-10-03T02:00:00Z' }), { timeZone: 'UTC' }),
      make('habit with repeat none is one-shot', habit(605, 'once', { repeatFrequency: 'none' })),
      make('habit with repeat none, done', habit(605, 'once', { repeatFrequency: 'none', completedDates: [T] })),
      make('habit with no repeat frequency is one-shot', habit(605, 'once', { repeatFrequency: undefined })),
      // Recurring tasks.
      make('recurring task, due today', daily()),
      make('recurring task, done today', daily({ completedDates: [T] })),
      make('recurring task, skipped today', daily({ skippedDates: [T] })),
      make('recurring task, a past open day', daily(), { dateStr: WED }),
      make('recurring task, before its start is absent', daily({ startDate: '2026-10-05' })),
      make('recurring task, off its custom days is absent', daily({ repeatFrequency: 'custom', repeatDays: [1, 3] })),
      make('recurring task with no start date is absent', daily({ startDate: undefined })),
      make('recurring task, cancelled', daily({ status: 'cancelled' })),
      make('recurring task, paused', daily({ pausedAt: PAUSED })),
      make('recurring task in a project block', daily({ inProjectBlock: true })),
      // One-offs.
      make('one-off, today', oneOff()),
      make('one-off, completed', oneOff({ status: 'completed' })),
      make('one-off, cancelled', oneOff({ status: 'cancelled' })),
      make('one-off, overdue', oneOff({ startDate: '2026-09-28' })),
      make('one-off, drawn on a past day', oneOff({ startDate: '2026-09-29' }), { dateStr: '2026-09-29' }),
      make('one-off, next week', oneOff({ startDate: NEXT_THU }), { dateStr: NEXT_THU }),
      make('one-off, undated', oneOff({ startDate: undefined, timeBucket: undefined, isScheduled: false })),
      make('one-off, in a project block', oneOff({ inProjectBlock: true })),
      make('one-off, paused', oneOff({ pausedAt: PAUSED })),
      make('one-off, repeat none', oneOff({ repeatFrequency: 'none' })),
      make('one-off ignores an absent occurrence', oneOff(), { occurrence: 'absent' }),
      make('subtask', subtask()),
      make('subtask, completed', subtask({ status: 'completed' })),
      // Custom types ride the task rules.
      make('custom one-off', errand()),
      make('custom one-off, completed', errand({ status: 'completed' })),
      make('custom one-off, undated', errand({ startDate: undefined, timeBucket: undefined, isScheduled: false })),
      make('custom recurring, due', weekdayErrand()),
      make('custom recurring, done', weekdayErrand({ completedDates: [T] })),
      make('custom recurring, skipped', weekdayErrand({ skippedDates: [T] })),
      make('custom recurring on a Saturday is absent', weekdayErrand(), { dateStr: SAT }),
    ],
  };
}

// ── row-moves.json ───────────────────────────────────────────────────────────

type TargetCase = { name: string; rowDateStr: string; todayStr: string; expected: string };
type CarryLabelCase = { name: string; target: string; todayStr: string; expected: string };
type DayCopyCase = { name: string; dateStr: string; expected: string };
type MoveCase = { name: string; item: Item; kind: 'task' | 'habit'; dateStr: string; expected: boolean };
type RowMovesFixture = {
  nextDayTarget: TargetCase[];
  nextDayLabel: CarryLabelCase[];
  formatTargetDay: DayCopyCase[];
  canMoveToNextDay: MoveCase[];
  canReschedule: MoveCase[];
};

function buildRowMoves(): RowMovesFixture {
  const T = '2026-10-02';
  const targets = (
    [
      ['a row on today goes to tomorrow', T, T],
      ['a future row goes to its next day', '2026-10-08', T],
      ['an overdue row goes to real tomorrow, not its next day', '2026-09-28', T],
      ['month end', '2026-10-31', '2026-10-31'],
      ['year end', '2026-12-31', '2026-12-30'],
      ['into a leap day', '2028-02-28', '2028-02-28'],
      ['past February in a common year', '2027-02-28', '2027-02-01'],
      ['across a DST change', '2026-11-01', '2026-11-01'],
    ] as [string, string, string][]
  ).map(([name, rowDateStr, todayStr]) => ({
    name,
    rowDateStr,
    todayStr,
    expected: nextDayTarget(rowDateStr, todayStr),
  }));
  const labels = (
    [
      ['tomorrow', '2026-10-03', T],
      ['the day after tomorrow', '2026-10-04', T],
      ['today itself', T, T],
      ['tomorrow across a month', '2026-11-01', '2026-10-31'],
    ] as [string, string, string][]
  ).map(([name, target, todayStr]) => ({ name, target, todayStr, expected: nextDayLabel(target, todayStr) }));
  const days = (
    [
      ['a Thursday', '2026-10-08'],
      ['a Saturday', '2026-10-03'],
      ['new year', '2027-01-01'],
      ['a leap day', '2028-02-29'],
      ['US DST starts', '2026-03-08'],
      ['US DST ends', '2026-11-01'],
      ['the last day of the year', '2026-12-31'],
    ] as [string, string][]
  ).map(([name, dateStr]) => ({ name, dateStr, expected: formatTargetDay(dateStr) }));
  const oneOff = (over: Record<string, unknown> = {}) => task(701, 'buy milk', { startDate: T, ...over });
  const errand = (over: Record<string, unknown> = {}) => custom(702, 'errand', 'post office', { startDate: T, ...over });
  const moveInputs = (
    [
      ['one-off pending', oneOff(), 'task'],
      ['one-off completed', oneOff({ status: 'completed' }), 'task'],
      ['one-off cancelled', oneOff({ status: 'cancelled' }), 'task'],
      ['one-off in a project block', oneOff({ inProjectBlock: true }), 'task'],
      ['one-off undated', oneOff({ startDate: undefined }), 'task'],
      ['repeat none is a one-off', oneOff({ repeatFrequency: 'none' }), 'task'],
      ['recurring task', oneOff({ repeatFrequency: 'daily' }), 'task'],
      ['recurring task done that day', oneOff({ repeatFrequency: 'daily', completedDates: [T] }), 'task'],
      ['subtask is not refused here', oneOff({ parentItemId: uid(799) }), 'task'],
      ['paused one-off is not refused here', oneOff({ pausedAt: '2026-09-20T15:00:00Z' }), 'task'],
      ['custom one-off', errand(), 'task'],
      ['custom one-off completed', errand({ status: 'completed' }), 'task'],
      ['custom recurring', errand({ repeatFrequency: 'weekdays' }), 'task'],
      [
        'custom item shaped as the server builds it',
        errand({ repeatFrequency: 'none', inProjectBlock: false, completedDates: [] }),
        'task',
      ],
      ['habit', habit(703, 'stretch'), 'habit'],
      ['a task asked about as a habit', oneOff(), 'habit'],
    ] as [string, Item, 'task' | 'habit'][]
  );
  // The same rows asked both gates: Reschedule's differs from the carry's only
  // in taking a recurring task (its picked day becomes the series start).
  const moves = moveInputs.map(([name, item, kind]) => ({ name, item, kind, dateStr: T, expected: canMoveToNextDay(item, kind, T) }));
  const reschedules = moveInputs.map(([name, item, kind]) => ({ name, item, kind, dateStr: T, expected: canReschedule(item, kind, T) }));
  return {
    nextDayTarget: targets,
    nextDayLabel: labels,
    formatTargetDay: days,
    canMoveToNextDay: moves,
    canReschedule: reschedules,
  };
}

// ── cadence.json ─────────────────────────────────────────────────────────────

type CadenceCase = { name: string; item: Item; expected: string };

/**
 * Recurring items only. A one-off's label is `formatShort`, which formats in
 * the runtime's locale, so no fixed answer exists for it to pin.
 */
function buildCadence(): { cases: CadenceCase[] } {
  const cases = (
    [
      ['daily habit', habit(751, 'stretch')],
      ['weekdays', task(752, 'standup', { repeatFrequency: 'weekdays', startDate: '2026-09-01' })],
      ['weekends', habit(753, 'long run', { repeatFrequency: 'weekends' })],
      ['monthly on a day', task(754, 'rent', { repeatFrequency: 'monthly', repeatMonthDay: 12, startDate: '2026-09-12' })],
      ['monthly with no day', habit(755, 'review', { repeatFrequency: 'monthly' })],
      ['custom days are sorted', habit(756, 'gym', { repeatFrequency: 'custom', repeatDays: [5, 1, 3] })],
      ['custom, one day', habit(757, 'church', { repeatFrequency: 'custom', repeatDays: [0] })],
      ['custom, all seven days', habit(758, 'meds', { repeatFrequency: 'custom', repeatDays: [6, 5, 4, 3, 2, 1, 0] })],
      ['custom, no days', habit(759, 'empty', { repeatFrequency: 'custom', repeatDays: [] })],
      ['custom, days missing', habit(760, 'missing', { repeatFrequency: 'custom' })],
      ['legacy weekly is its own word', habit(761, 'legacy', { repeatFrequency: 'weekly', repeatDays: [2] })],
      ['an unknown frequency is its own word', habit(762, 'agent', { repeatFrequency: 'fortnightly' })],
      [
        'custom type, custom days',
        custom(763, 'errand', 'post office', { repeatFrequency: 'custom', repeatDays: [2, 4], startDate: '2026-09-01' }),
      ],
    ] as [string, Item][]
  ).map(([name, item]) => ({ name, item, expected: cadenceLabel(item) }));
  return { cases };
}

// ── pause-write.json ─────────────────────────────────────────────────────────

/** A key present with null means "write NULL"; an absent key leaves the column alone. */
type PausePatchOut = { pausedAt?: string | null; pausedUntil?: string | null };
type PauseWriteCase = {
  name: string;
  current: Pausable;
  /** `paused` absent = not sent. `pausedUntil` absent = not sent, null = sent as "no end". */
  req: { paused?: boolean; pausedUntil?: string | null };
  todayStr: string;
  nowIso: string;
  timeZone: string;
  expected: { patch: PausePatchOut } | { reason: string };
};

function buildPauseWrite(): { cases: PauseWriteCase[] } {
  const T = '2026-10-02';
  const NOW = '2026-10-02T15:00:00.000Z';
  const PAUSED = '2026-09-20T15:00:00Z';
  const make = (
    name: string,
    current: Pausable,
    req: PauseWriteCase['req'],
    timeZone: string = NY
  ): PauseWriteCase => {
    const r = resolvePauseWrite(current, req, T, NOW, timeZone);
    const expected =
      'reason' in r
        ? { reason: r.reason }
        : { patch: Object.fromEntries(Object.entries(r.patch).map(([k, v]) => [k, v ?? null])) as PausePatchOut };
    return { name, current, req, todayStr: T, nowIso: NOW, timeZone, expected };
  };
  const paused = { pausedAt: PAUSED };
  return {
    cases: [
      make('resume a running pause', paused, { paused: false }),
      make('resume a pause with an end date', { ...paused, pausedUntil: '2026-10-09' }, { paused: false }),
      make('resume something live writes nothing', {}, { paused: false }),
      make('resume after the pause already ended writes nothing', { ...paused, pausedUntil: T }, { paused: false }),
      make('pause something live', {}, { paused: true }),
      make('pause until a later day', {}, { paused: true, pausedUntil: '2026-10-09' }),
      make('pause until tomorrow', {}, { paused: true, pausedUntil: '2026-10-03' }),
      make('pause with a null end', {}, { paused: true, pausedUntil: null }),
      make('pause until today is refused', {}, { paused: true, pausedUntil: T }),
      make('pause until a past day is refused', {}, { paused: true, pausedUntil: '2026-09-30' }),
      make('pause again after an ended pause restamps and clears the end', { pausedAt: '2026-09-01T12:00:00Z', pausedUntil: '2026-09-20' }, { paused: true }),
      make('pause what is already paused writes nothing', paused, { paused: true }),
      make('pause what is already paused, with a new end', paused, { paused: true, pausedUntil: '2026-10-09' }),
      make('pause what is already paused, with a null end', { ...paused, pausedUntil: '2026-10-09' }, { paused: true, pausedUntil: null }),
      make('an end date alone moves a running pause', paused, { pausedUntil: '2026-10-09' }),
      make('a null end alone clears the end of a running pause', { ...paused, pausedUntil: '2026-10-09' }, { pausedUntil: null }),
      make('an end date alone on something live is refused', {}, { pausedUntil: '2026-10-09' }),
      make('an empty request writes nothing', paused, {}),
      make('a junk pausedAt reads as live', { pausedAt: 'not a date' }, { paused: true }),
      // 02:00 UTC on the 3rd: already begun in New York, still tomorrow in UTC.
      make('a pause begun tonight in New York resumes', { pausedAt: '2026-10-03T02:00:00Z' }, { paused: false }),
      make('the same pause read in UTC has not begun', { pausedAt: '2026-10-03T02:00:00Z' }, { paused: false }, 'UTC'),
    ],
  };
}

// ── occurs.json ──────────────────────────────────────────────────────────────

type OccursCase = {
  name: string;
  item: Item;
  dateStr: string;
  todayStr: string;
  timeZone: string;
  occursOn: boolean;
  /** `occurrenceOn`; null for a one-off. */
  occurrence: OccurrenceState | 'absent' | null;
};

function buildOccurs(): { cases: OccursCase[] } {
  const T = '2026-10-02'; // a Friday
  const make = (name: string, item: Item, dateStr: string = T, timeZone: string = NY): OccursCase => ({
    name,
    item,
    dateStr,
    todayStr: T,
    timeZone,
    occursOn: occursOn(item, dateStr, timeZone),
    occurrence: occurrenceOn(item, dateStr, T, timeZone) ?? null,
  });
  const stretch = (over: Record<string, unknown> = {}) => habit(801, 'stretch', over);
  const anchored = (over: Record<string, unknown> = {}) =>
    task(802, 'water plants', { repeatFrequency: 'daily', startDate: '2026-09-01', ...over });
  return {
    cases: [
      make('one-off on its day', task(803, 'buy milk', { startDate: T })),
      make('one-off on another day', task(803, 'buy milk', { startDate: '2026-10-01' })),
      make('one-off undated', task(803, 'buy milk')),
      make('one-off with a timestamp start', task(803, 'buy milk', { startDate: '2026-10-02T00:00:00Z' })),
      make('repeat none is a one-off', task(803, 'buy milk', { startDate: T, repeatFrequency: 'none' })),
      make('habit with repeat none occurs nowhere', stretch({ repeatFrequency: 'none' })),
      make('habit, due today', stretch()),
      make('habit, done today', stretch({ completedDates: [T] })),
      make('habit, skipped today', stretch({ skippedDates: [T] })),
      make('habit, skipped and done reads as done', stretch({ skippedDates: [T], completedDates: [T] })),
      make('habit, a future day is due', stretch(), '2026-10-05'),
      make('habit, a past day is open', stretch(), '2026-09-29'),
      make('habit, a past day skipped', stretch({ skippedDates: ['2026-09-29'] }), '2026-09-29'),
      make('weekday habit on a Saturday', stretch({ repeatFrequency: 'weekdays' }), '2026-10-03'),
      make('weekend habit on a Saturday', stretch({ repeatFrequency: 'weekends' }), '2026-10-03'),
      make('custom-days habit on its day', stretch({ repeatFrequency: 'custom', repeatDays: [5] })),
      make('custom-days habit off its day', stretch({ repeatFrequency: 'custom', repeatDays: [1, 3] })),
      make('legacy weekly habit on its day', stretch({ repeatFrequency: 'weekly', repeatDays: [5] })),
      make('monthly habit on its day', stretch({ repeatFrequency: 'monthly', repeatMonthDay: 2 })),
      make('monthly 31st clamps to the 30th', stretch({ repeatFrequency: 'monthly', repeatMonthDay: 31 }), '2026-09-30'),
      make('monthly with no day occurs nowhere', stretch({ repeatFrequency: 'monthly' })),
      make('an unknown frequency occurs nowhere', stretch({ repeatFrequency: 'fortnightly' })),
      make('a habit rule reads the day, not the zone', stretch({ repeatFrequency: 'weekdays' }), T, 'Asia/Tokyo'),
      make('recurring task inside its series', anchored()),
      make('recurring task before its start', anchored({ startDate: '2026-10-05' })),
      make('recurring task on its start day, off its rule', anchored({ startDate: T, repeatFrequency: 'custom', repeatDays: [1] })),
      make('recurring task with no start date', anchored({ startDate: undefined })),
      make('recurring task done on a past day', anchored({ completedDates: ['2026-09-29'] }), '2026-09-29'),
      make('custom recurring inside its series', custom(804, 'errand', 'post office', { repeatFrequency: 'weekdays', startDate: '2026-09-01' })),
      make('custom recurring with no start date', custom(804, 'errand', 'post office', { repeatFrequency: 'weekdays' })),
    ],
  };
}

// ── caps.json ────────────────────────────────────────────────────────────────

type TypeCaps = {
  /** The registry name: 'task', 'habit' or a custom slug. */
  name: string;
  label: string;
  doneStatus: string;
  skipStatus: string | null;
  defaultFrequency: string;
  defaultBlockMinutes: number;
  dateAnchored: boolean;
  dateAddressable: boolean;
  skippable: boolean;
  pausable: boolean;
  remindable: boolean;
  collectible: boolean;
  braindumpEligible: boolean;
  subtasks: boolean;
  /** `counters.streak`. */
  streakCounter: boolean;
  /** `counters.dailyCounts`. */
  dailyCounts: boolean;
  /** `fields.includes('priority')`, the item panel's gate on the Priority chip. */
  hasPriority: boolean;
  /** `fields.includes('notes')`, the sheet's gate on editing the notes. */
  hasNotes: boolean;
  /** `fields.includes('duration')`, the Time sheet's gate on its lengths (lib/item-edit.ts no_duration). */
  hasDuration: boolean;
  /** `form.titlePlaceholder`, the title field's empty prompt. */
  titlePlaceholder: string;
  /** The delete confirm's title (lib/item-verbs.ts deleteConfirmTitle). */
  deleteTitle: string;
  /** `form.deleteDescription` for each of DELETE_TITLES: the delete confirm's message. */
  deleteDescriptions: DeleteDescription[];
};
type DeleteDescription = { title: string; text: string };
/**
 * A custom type as the payload's `itemTypes` names it, hydrated through
 * buildCustomTypeConfig, the way the web's store hydrates the user's types.
 * `typeLabel` is the label the registry answers with, and `deleteTitle` the
 * confirm's title (lib/item-verbs.ts deleteConfirmTitle).
 */
type HydratedCaps = {
  name: string;
  label: string;
  labelPlural: string;
  typeLabel: string;
  titlePlaceholder: string;
  deleteTitle: string;
  deleteDescriptions: DeleteDescription[];
};
type ItemCapsCase = {
  name: string;
  item: Item;
  isSkippable: boolean;
  isPausable: boolean;
  isRemindable: boolean;
  isCollectible: boolean;
  /** lib/bulk-edit.ts reminderNeedsDate: a cue that would never fire for want of a day. */
  reminderNeedsDate: boolean;
};
type CapsFixture = { types: TypeCaps[]; items: ItemCapsCase[]; hydrated: HydratedCaps[] };

/** A plain title, and one with the quotes the message wraps it in. */
const DELETE_TITLES = ['Buy milk', 'Say "hi"'];

const deleteDescriptions = (c: ItemTypeConfig): DeleteDescription[] =>
  DELETE_TITLES.map((title) => ({ title, text: c.form.deleteDescription(title) }));

/**
 * The registry slice the phone ports. Custom slugs are not hydrated in
 * `types`, so they answer with the on-the-fly template `getItemTypeConfig`
 * falls back to — the label is the slug with its first letter capitalised,
 * nothing else touched ('side-quest' → 'Side-quest'). `hydrated` is the other
 * case: a type the payload's `itemTypes` names, whose own label the words use
 * (a placeholder, a delete title and message) while every capability stays
 * the template's.
 */
function buildCaps(): CapsFixture {
  const types = ['task', 'habit', 'errand', 'side-quest', 'book_club', 'x'].map((name): TypeCaps => {
    const c = getItemTypeConfig(name);
    return {
      name,
      label: c.label,
      doneStatus: c.doneStatus,
      skipStatus: c.skipStatus,
      defaultFrequency: c.defaultFrequency,
      defaultBlockMinutes: c.schedule.defaultBlockMinutes,
      dateAnchored: c.dateAnchored,
      dateAddressable: c.dateAddressable,
      skippable: c.skippable,
      pausable: c.pausable,
      remindable: c.remindable,
      collectible: c.collectible,
      braindumpEligible: c.braindumpEligible,
      subtasks: c.subtasks,
      streakCounter: c.counters.streak,
      dailyCounts: c.counters.dailyCounts,
      hasPriority: c.fields.includes('priority'),
      hasNotes: c.fields.includes('notes'),
      hasDuration: c.fields.includes('duration'),
      titlePlaceholder: c.form.titlePlaceholder,
      deleteTitle: deleteConfirmTitle(c.label),
      deleteDescriptions: deleteDescriptions(c),
    };
  });
  const hydrated = [
    { name: 'side_quest', label: 'Side quest', labelPlural: 'Side quests' },
    { name: 'book-club', label: 'Book Club', labelPlural: 'Book Clubs' },
    // A word-final capital sigma lower-cases to the final form (Final_Sigma),
    // which JavaScript's toLowerCase applies and Swift's lowercased() doesn't.
    { name: 'stochos', label: 'ΣΤΟΧΟΣ', labelPlural: 'ΣΤΟΧΟΙ' },
  ].map((def): HydratedCaps => {
    const c = buildCustomTypeConfig(def);
    return {
      ...def,
      typeLabel: c.label,
      titlePlaceholder: c.form.titlePlaceholder,
      deleteTitle: deleteConfirmTitle(c.label),
      deleteDescriptions: deleteDescriptions(c),
    };
  });
  const items = (
    [
      ['one-off task', task(851, 'buy milk', { startDate: '2026-10-02' })],
      ['task with repeat none', task(851, 'buy milk', { repeatFrequency: 'none' })],
      ['recurring task', task(852, 'water plants', { repeatFrequency: 'daily', startDate: '2026-09-01' })],
      ['subtask', task(853, 'oat milk', { parentItemId: uid(851) })],
      ['recurring subtask', task(854, 'rinse', { repeatFrequency: 'daily', parentItemId: uid(852) })],
      ['habit', habit(855, 'stretch')],
      ['habit with repeat none', habit(855, 'stretch', { repeatFrequency: 'none' })],
      ['habit with no repeat frequency', habit(855, 'stretch', { repeatFrequency: undefined })],
      ['custom one-off', custom(856, 'errand', 'post office')],
      ['custom recurring', custom(857, 'errand', 'post office', { repeatFrequency: 'weekdays' })],
      ['custom subtask', custom(858, 'errand', 'stamps', { parentItemId: uid(856) })],
    ] as [string, Item][]
  ).map(([name, item]) => ({
    name,
    item,
    isSkippable: isSkippable(item),
    isPausable: isPausable(item),
    isRemindable: isRemindable(item),
    isCollectible: isCollectible(item),
    reminderNeedsDate: reminderNeedsDate(item),
  }));
  return { types, items, hydrated };
}

// ── chips.json ───────────────────────────────────────────────────────────────

type SummaryCase = { name: string; names: string[]; expected: string | null };
type CueTimeCase = { name: string; hhmm: string; timeFormat: TimeFormat; expected: string };
type ChipsFixture = { membershipSummary: SummaryCase[]; formatCueTime: CueTimeCase[]; formatDay: DayCopyCase[] };

function buildChips(): ChipsFixture {
  const summaries = (
    [
      ['none', []],
      ['one', ['Wind down']],
      ['two', ['Wind down', 'Morning']],
      ['three', ['Wind down', 'Morning', 'Gym']],
    ] as [string, string[]][]
  ).map(([name, names]) => ({ name, names, expected: membershipSummary(names) ?? null }));
  const cueTimes = (
    [
      ['midnight', '00:00'],
      ['half past midnight', '00:30'],
      ['morning', '07:05'],
      ['noon', '12:00'],
      ['afternoon', '13:45'],
      ['last minute', '23:59'],
    ] as [string, string][]
  ).flatMap(([name, hhmm]) =>
    (['12h', '24h'] as const).map((timeFormat) => ({
      name: `${name}, ${timeFormat}`,
      hhmm,
      timeFormat,
      expected: formatCueTime(hhmm, timeFormat),
    }))
  );
  const days = (
    [
      ['first of a month', '2026-09-01'],
      ['two-digit day', '2026-10-18'],
      ['December', '2026-12-31'],
      ['a timestamp reads as its day', '2026-09-01T00:00:00Z'],
      ['junk comes back as it was', 'not a date'],
    ] as [string, string][]
  ).map(([name, dateStr]) => ({ name, dateStr, expected: formatDay(dateStr) }));
  return { membershipSummary: summaries, formatCueTime: cueTimes, formatDay: days };
}

// ── Writing and checking ─────────────────────────────────────────────────────

const FIXTURES: Record<string, () => unknown> = {
  active: buildActive,
  'day-items': buildDayItems,
  timed: buildTimed,
  braindump: buildBraindump,
  'routine-groups': buildRoutineGroups,
  toggle: buildToggle,
  verbs: buildVerbs,
  'row-moves': buildRowMoves,
  cadence: buildCadence,
  'pause-write': buildPauseWrite,
  occurs: buildOccurs,
  caps: buildCaps,
  chips: buildChips,
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

  it('the item sheet cases exercise both answers of every gate', () => {
    const both = new Set([true, false]);
    const verbs = (generated.verbs as { cases: VerbsCase[] }).cases;
    for (const id of SHEET_VERBS) {
      const answers = new Set(verbs.map((c) => c.verbs[id].eligible));
      expect(answers, id).toEqual(ALWAYS_ELIGIBLE.has(id) ? new Set([true]) : both);
    }
    // Delete is offered on every item, and last, after every verb in the bar;
    // Reset streak, where it is offered, comes just before it.
    for (const c of verbs) {
      expect(c.eligible.at(-1), c.name).toBe('delete');
      if (c.eligible.includes('resetStreak')) expect(c.eligible.at(-2), c.name).toBe('resetStreak');
    }
    // Reset streak is refused with Streaks off on a streak it would otherwise reset.
    expect(verbs.some((c) => !c.streaksEnabled && !c.verbs.resetStreak.eligible && (c.item as HabitItem).streak > 0)).toBe(true);
    expect(new Set(verbs.map((c) => c.verbs.resetStreak.label))).toEqual(new Set(['Reset streak']));
    expect(new Set(verbs.map((c) => c.occurrence))).toEqual(new Set(['done', 'skipped', 'due', 'open', 'absent', null]));
    const tickLabels = new Set(verbs.map((c) => c.verbs.tick.label));
    for (const label of ['Mark done', 'Mark not done', 'Done today', 'Undo today', 'Count one (1/3)']) {
      expect(tickLabels, label).toContain(label);
    }
    expect(new Set(verbs.map((c) => c.verbs.nextDay.label))).toEqual(new Set(['Move to tomorrow', 'Move to next day']));
    expect(new Set(verbs.map((c) => c.verbs.reschedule.label))).toEqual(new Set(['Reschedule', 'Schedule']));

    const moves = generated['row-moves'] as RowMovesFixture;
    expect(new Set(moves.canMoveToNextDay.map((c) => c.expected))).toEqual(both);
    expect(new Set(moves.canReschedule.map((c) => c.expected))).toEqual(both);
    // At least one row where the two gates part: a recurring task.
    expect(moves.canReschedule.some((c, i) => c.expected !== moves.canMoveToNextDay[i].expected)).toBe(true);
    expect(new Set(moves.nextDayLabel.map((c) => c.expected))).toEqual(new Set(['Move to tomorrow', 'Move to next day']));

    const occurs = (generated.occurs as { cases: OccursCase[] }).cases;
    expect(new Set(occurs.map((c) => c.occursOn))).toEqual(both);
    expect(new Set(occurs.map((c) => c.occurrence))).toEqual(new Set(['done', 'skipped', 'due', 'open', 'absent', null]));

    const caps = generated.caps as CapsFixture;
    for (const key of ['isSkippable', 'isPausable', 'isRemindable', 'isCollectible', 'reminderNeedsDate'] as const) {
      expect(new Set(caps.items.map((c) => c[key])), key).toEqual(both);
    }
    // The task and habit messages differ, and a hydrated label reaches every
    // word the phone shows, so the fixture can tell a port that ignores it.
    const words = (name: string) => caps.types.find((t) => t.name === name)!.deleteDescriptions[0].text;
    expect(words('task')).not.toBe(words('habit'));
    const deleteTitle = (name: string) => caps.types.find((t) => t.name === name)!.deleteTitle;
    expect(deleteTitle('task')).not.toBe(deleteTitle('habit'));
    for (const t of caps.types) expect(t.deleteTitle, t.name).toContain(t.label.toLowerCase());
    for (const h of caps.hydrated) {
      expect(h.titlePlaceholder, h.name).toContain(h.label.toLowerCase());
      expect(h.deleteTitle, h.name).toContain(h.label.toLowerCase());
      expect(h.typeLabel, h.name).not.toBe(getItemTypeConfig(h.name).label);
    }

    const pauses = (generated['pause-write'] as { cases: PauseWriteCase[] }).cases;
    const patches = pauses.flatMap((c) => ('patch' in c.expected ? [c.expected.patch] : []));
    expect(pauses.some((c) => 'reason' in c.expected)).toBe(true);
    expect(patches.some((p) => Object.keys(p).length === 0)).toBe(true);
    expect(patches.some((p) => 'pausedAt' in p)).toBe(true);
    // The null that clears a column survives serialization as a present key.
    expect(patches.some((p) => p.pausedUntil === null)).toBe(true);

    const chips = generated.chips as ChipsFixture;
    expect(chips.membershipSummary.some((c) => c.expected === null)).toBe(true);
  });
});
