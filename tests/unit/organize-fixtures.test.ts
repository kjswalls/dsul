import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { countLive, routinePillLabel, seasonPillLabel } from '@/lib/collections';
import {
  inactiveItemIdsOn,
  isSeasonActiveOn,
  membersRevealedByRemoving,
  routineStandingOn,
  seasonResumeDate,
  suppressionLabel,
  suppressionReason,
} from '@/lib/active';
import {
  goalCountdown,
  goalMemberGroups,
  goalProgress,
  isGoalActive,
  lastDoneOn,
  milestoneState,
  milestoneTimeline,
  nextMilestone,
  progressLabel,
  sortGoalsForDisplay,
  timeElapsed,
  timeElapsedLabel,
  windDownMembers,
} from '@/lib/goals';
import {
  containerMemberIds,
  dayRollup,
  deriveContainerSchedule,
  occurrencesByItem,
  todayCount,
  todayInOrder,
  weekTotals,
  type ScheduleContainer,
} from '@/lib/container-schedule';
import { blockWhen, hasTimeBlock, timeBlockSummary } from '@/lib/project-block';
import {
  GOALS_OFF,
  GOAL_STATE_LABELS,
  HELD_BY_NONE,
  NOTHING_IN_IT_YET,
  NO_CHECKIN_YET,
  NO_MILESTONES_YET,
  NO_SUPPORTING_WORK,
  ORGANIZE_OFF,
  ROUTINE_STATE_LABELS,
  ROUTINE_TODAY_FINISHED,
  ROUTINE_TODAY_NEXT,
  SEASON_STATE_LABELS,
  checkinMeta,
  goalEndedNote,
  heldByState,
  milestoneTickLabel,
  routineHeldNote,
  routinePausedNote,
  routineTodayEmpty,
  routineTodaySummary,
  seasonRunsLabel,
  seasonStateNote,
  switchedOffSentence,
  windDownSentence,
} from '@/lib/organize-copy';
import { cadenceLabel } from '@/lib/cadence';
import { getItemTypeConfig } from '@/lib/item-registry';
import { projectItems } from '@/lib/planner-store';
import type { AwayPeriod } from '@/lib/away';
import { ACCENT_NAMES, ACCENT_RAMP, LEGACY_PROJECT_TOKENS, accentColorForName, projectColorToken } from '@/lib/accent-colors';
import {
  ALL_ICON_ENTRIES,
  CATEGORY_ICON_NAMES,
  FEATURED_ICON_NAMES,
  KEYWORD_ICON_NAMES,
  NAME_ICON_NAMES,
  hashName,
  resolveCategoryIconName,
} from '@/lib/category-icons';
import type { Goal, HabitItem, Item, Project, Routine, Season, Task } from '@/lib/planner-types';

/**
 * Organize's cases shared with the iPhone.
 *
 * The same contract as tests/unit/day-fixtures.test.ts, for the rules the
 * phone's Organize tab ports: the list's pills and counts (lib/collections.ts),
 * where a routine stands (lib/active.ts routineStandingOn, seasonResumeDate),
 * a goal's progress, its words and the list order (lib/goals.ts), who is in a
 * container (lib/container-schedule.ts containerMemberIds), and how a container
 * looks: its colour (lib/accent-colors.ts, with each token's oklch values read
 * out of app/globals.css) and its glyph (lib/category-icons.ts). The container
 * pages add why an item is hidden (suppressionReason, suppressionLabel,
 * membersRevealedByRemoving), a container's days (deriveContainerSchedule with
 * dayRollup, weekTotals, todayCount and todayInOrder), a goal's milestones,
 * countdown and wind-down (lib/goals.ts), a project's time block
 * (lib/project-block.ts), and the words both shells share (lib/organize-copy.ts,
 * in copy.json). Every case is
 * built here, run through the real TS, and written with its answer to
 * tests/fixtures/organize/*.json; DsulCore's fixture tests read the same files
 * and assert the Swift port answers identically.
 *
 * This test fails when a committed file no longer matches what the TS says,
 * including when a colour token in globals.css moves. Regenerate with:
 *
 *   UPDATE_FIXTURES=1 pnpm test tests/unit/organize-fixtures.test.ts
 *
 * then commit the JSON together with the Swift change that keeps the port in
 * step. Never hand-edit the JSON: the inputs live here.
 *
 * Shapes are the app's camelCase ones, as /api/app/planner serves them. Item
 * ids are uuids, because DsulCore decodes `Item.id` and every member array as
 * `[UUID]`; container ids are plain strings, as the sample's are.
 */

const DIR = path.resolve(__dirname, '../fixtures/organize');
const CSS = path.resolve(__dirname, '../../app/globals.css');

// ── Builders ─────────────────────────────────────────────────────────────────

/** Item n → a fixed, valid v4-shaped uuid. */
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const task = (n: number, title: string, over: Record<string, unknown> = {}): Item =>
  ({ type: 'task', id: uid(n), title, status: 'pending', isScheduled: true, order: 0, ...over }) as Item;

const custom = (n: number, customType: string, title: string, over: Record<string, unknown> = {}): Item =>
  ({ type: 'custom', customType, id: uid(n), title, status: 'pending', isScheduled: true, order: 0, ...over }) as Item;

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

const routine = (id: string, name: string, over: Partial<Routine> = {}): Routine => ({ id, name, itemIds: [], ...over });

const season = (id: string, name: string, state: Season['state'], over: Partial<Season> = {}): Season => ({
  id,
  name,
  state,
  itemIds: [],
  routineIds: [],
  ...over,
});

const goal = (id: string, name: string, over: Partial<Goal> = {}): Goal => ({
  id,
  name,
  state: 'active',
  memberIds: [],
  milestoneIds: [],
  checkinIds: [],
  ...over,
});

const project = (id: string, name: string, over: Partial<Project> = {}): Project =>
  ({ id, name, emoji: '', ...over }) as Project;

/** The day every dated case is asked on: a Friday. */
const TODAY = '2026-10-23';
const ZONE = 'America/New_York';

// ── labels.json: the list's pills and counts (lib/collections.ts) ───────────

/*
 * The seasons the routine pills are asked against. Each routine case names
 * the holders it means by giving them its id in routineIds.
 */
function heldBy(routineId: string, ...seasons: Season[]): Season[] {
  return seasons.map((s) => ({ ...s, routineIds: [...s.routineIds, routineId] }));
}

const OFF_PAUSED = season('s-shelf', 'Shelf', 'paused');
const OFF_LATER = season('s-winter', 'Winter', 'auto', { startsOn: '2026-11-01', endsOn: '2027-02-28' });
const OFF_LATER_STILL = season('s-holiday', 'Holiday', 'auto', { startsOn: '2026-12-01', endsOn: '2026-12-31' });
const OFF_ENDED = season('s-summer', 'Summer', 'auto', { startsOn: '2026-06-01', endsOn: '2026-10-01' });
const OFF_INVERTED = season('s-backwards', 'Backwards', 'auto', { startsOn: '2026-12-01', endsOn: '2026-11-01' });
const ON_RANGE = season('s-autumn', 'Autumn', 'auto', { startsOn: '2026-09-01', endsOn: '2026-11-30' });
const ON_PINNED = season('s-always', 'Always', 'active', { startsOn: '2027-01-01' });
const OFF_LATER_SAME_DAY = season('s-ski', 'Ski', 'auto', { startsOn: '2026-11-01' });

function buildLabels() {
  const live = [uid(1), uid(2), uid(3)];
  const countCases: { name: string; ids: string[]; live: string[] }[] = [
    { name: 'none', ids: [], live },
    { name: 'all live', ids: [uid(1), uid(2)], live },
    { name: 'a trashed member is not counted', ids: [uid(1), uid(9), uid(3)], live },
    { name: 'nothing live', ids: [uid(8), uid(9)], live },
    // countLive counts entries: a repeated id counts twice. Join tables are
    // keyed, so a container never holds one twice.
    { name: 'a repeated id counts each time', ids: [uid(1), uid(1)], live },
    { name: 'routine ids, which are plain strings', ids: ['r-a', 'r-gone'], live: ['r-a', 'r-b'] },
  ];
  const countLiveCases = countCases.map((c) => ({ ...c, expected: countLive(c.ids, new Set(c.live)) }));

  const r = (over: Partial<Routine> = {}) => routine('r-morning', 'Morning', { itemIds: [uid(1)], ...over });
  const routineCases: { name: string; routine: Routine; seasons: Season[]; today: string; timeZone: string }[] = [
    { name: 'live, in no season', routine: r(), seasons: [], today: TODAY, timeZone: ZONE },
    {
      name: 'paused, no return day',
      routine: r({ pausedAt: '2026-10-20T13:00:00Z' }),
      seasons: [],
      today: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'paused until a day',
      routine: r({ pausedAt: '2026-10-20T13:00:00Z', pausedUntil: '2026-10-30' }),
      seasons: [],
      today: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'paused until next year',
      routine: r({ pausedAt: '2026-10-20T13:00:00Z', pausedUntil: '2027-01-04' }),
      seasons: [],
      today: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'paused until today: back today',
      routine: r({ pausedAt: '2026-10-20T13:00:00Z', pausedUntil: TODAY }),
      seasons: [],
      today: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'a pause that starts tomorrow',
      routine: r({ pausedAt: '2026-10-24T13:00:00Z' }),
      seasons: [],
      today: TODAY,
      timeZone: ZONE,
    },
    {
      // 22:00 on the 23rd in New York is the 24th in Tokyo.
      name: 'paused late today, in New York',
      routine: r({ pausedAt: '2026-10-24T02:00:00Z' }),
      seasons: [],
      today: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'paused late today, read in Tokyo: not yet',
      routine: r({ pausedAt: '2026-10-24T02:00:00Z' }),
      seasons: [],
      today: TODAY,
      timeZone: 'Asia/Tokyo',
    },
    {
      name: 'an unreadable pause is no pause',
      routine: r({ pausedAt: 'not a date' }),
      seasons: [],
      today: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'held by a season switched off',
      routine: r(),
      seasons: heldBy('r-morning', OFF_PAUSED),
      today: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'held by a season that starts later',
      routine: r(),
      seasons: heldBy('r-morning', OFF_LATER),
      today: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'held by a season that has ended',
      routine: r(),
      seasons: heldBy('r-morning', OFF_ENDED),
      today: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'held by an inverted range: no return day',
      routine: r(),
      seasons: heldBy('r-morning', OFF_INVERTED),
      today: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'held by two: the sooner return wins',
      routine: r(),
      seasons: heldBy('r-morning', OFF_LATER_STILL, OFF_LATER),
      today: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'held by two: a dated one beats one with no return',
      routine: r(),
      seasons: heldBy('r-morning', OFF_PAUSED, OFF_LATER_STILL),
      today: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'two holders, one on: live',
      routine: r(),
      seasons: heldBy('r-morning', OFF_PAUSED, ON_RANGE),
      today: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'a season pinned on ignores its dates',
      routine: r(),
      seasons: heldBy('r-morning', ON_PINNED),
      today: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'its own pause wins over a hold',
      routine: r({ pausedAt: '2026-10-20T13:00:00Z', pausedUntil: '2026-10-30' }),
      seasons: heldBy('r-morning', OFF_LATER),
      today: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'a pause that ended, held by an off season',
      routine: r({ pausedAt: '2026-10-01T13:00:00Z', pausedUntil: '2026-10-10' }),
      seasons: heldBy('r-morning', OFF_PAUSED),
      today: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'off seasons that hold another routine',
      routine: r(),
      seasons: heldBy('r-other', OFF_PAUSED, OFF_LATER),
      today: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'a season that starts on a month boundary',
      routine: r(),
      seasons: heldBy('r-morning', season('s-jan', 'January', 'auto', { startsOn: '2027-01-05' })),
      today: TODAY,
      timeZone: ZONE,
    },
  ];
  const routinePillLabelCases = routineCases.map((c) => ({
    ...c,
    expected: routinePillLabel(c.routine, c.today, c.timeZone, c.seasons),
  }));

  const seasonCases: { name: string; season: Season; today: string }[] = [
    { name: 'auto, in range', season: ON_RANGE, today: TODAY },
    { name: 'active, out of range', season: ON_PINNED, today: TODAY },
    { name: 'paused', season: OFF_PAUSED, today: TODAY },
    { name: 'paused with a range it is in', season: { ...ON_RANGE, state: 'paused' }, today: TODAY },
    { name: 'auto, starts later', season: OFF_LATER, today: TODAY },
    { name: 'auto, ended', season: OFF_ENDED, today: TODAY },
    { name: 'auto, no dates', season: season('s-open', 'Open', 'auto'), today: TODAY },
    { name: 'auto, starts today', season: season('s-today', 'Today', 'auto', { startsOn: TODAY }), today: TODAY },
    { name: 'auto, ends today', season: season('s-last', 'Last', 'auto', { endsOn: TODAY }), today: TODAY },
    { name: 'auto, ended yesterday', season: season('s-gone', 'Gone', 'auto', { endsOn: '2026-10-22' }), today: TODAY },
    { name: 'auto, starts next year', season: season('s-next', 'Next', 'auto', { startsOn: '2027-01-05' }), today: TODAY },
    { name: 'auto, inverted range ahead', season: OFF_INVERTED, today: TODAY },
    {
      name: 'auto, inverted range behind',
      season: season('s-behind', 'Behind', 'auto', { startsOn: '2026-10-01', endsOn: '2026-09-01' }),
      today: TODAY,
    },
    { name: 'auto, starts later, no end', season: OFF_LATER_SAME_DAY, today: TODAY },
  ];
  const seasonPillLabelCases = seasonCases.map((c) => ({ ...c, expected: seasonPillLabel(c.season, c.today) }));

  return { countLive: countLiveCases, routinePillLabel: routinePillLabelCases, seasonPillLabel: seasonPillLabelCases };
}

// ── standing.json: where a routine stands (lib/active.ts) ────────────────────

function buildStanding() {
  const r = (over: Partial<Routine> = {}) => routine('r-morning', 'Morning', { itemIds: [uid(1)], ...over });
  const cases: { name: string; routine: Routine; seasons: Season[]; date: string; timeZone: string }[] = [
    { name: 'standalone and live', routine: r(), seasons: [], date: TODAY, timeZone: ZONE },
    {
      name: 'standalone and paused',
      routine: r({ pausedAt: '2026-10-20T13:00:00Z' }),
      seasons: [],
      date: TODAY,
      timeZone: ZONE,
    },
    { name: 'held by one on', routine: r(), seasons: heldBy('r-morning', ON_RANGE), date: TODAY, timeZone: ZONE },
    { name: 'held by one off', routine: r(), seasons: heldBy('r-morning', OFF_PAUSED), date: TODAY, timeZone: ZONE },
    {
      name: 'held by one on and one off: live, one blocker',
      routine: r(),
      seasons: heldBy('r-morning', OFF_LATER, ON_RANGE),
      date: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'three off: ranked by return, no return last',
      routine: r(),
      seasons: heldBy('r-morning', OFF_PAUSED, OFF_LATER_STILL, OFF_LATER),
      date: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'two with the same return: the first holder',
      routine: r(),
      seasons: heldBy('r-morning', OFF_LATER_SAME_DAY, OFF_LATER),
      date: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'two with no return: the first holder',
      routine: r(),
      seasons: heldBy('r-morning', OFF_ENDED, OFF_PAUSED),
      date: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'paused and held: localOn false, the blockers still named',
      routine: r({ pausedAt: '2026-10-20T13:00:00Z', pausedUntil: '2026-10-30' }),
      seasons: heldBy('r-morning', OFF_LATER),
      date: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'paused, held by one on',
      routine: r({ pausedAt: '2026-10-20T13:00:00Z' }),
      seasons: heldBy('r-morning', ON_RANGE),
      date: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'seasons that hold others are not holders',
      routine: r(),
      seasons: [...heldBy('r-other', OFF_PAUSED), ...heldBy('r-morning', ON_PINNED)],
      date: TODAY,
      timeZone: ZONE,
    },
    {
      name: 'on the day the later season starts',
      routine: r(),
      seasons: heldBy('r-morning', OFF_LATER),
      date: '2026-11-01',
      timeZone: ZONE,
    },
  ];
  const routineStandingOnCases = cases.map((c) => {
    const s = routineStandingOn(c.routine, c.seasons, c.date, c.timeZone);
    return {
      ...c,
      expected: {
        localOn: s.localOn,
        effectiveOn: s.effectiveOn,
        holderIds: s.holders.map((h) => h.id),
        blockerIds: s.blockers.map((b) => b.id),
        soonestBlockerId: s.soonestBlocker?.id ?? null,
      },
    };
  });

  const resumeCases: { name: string; season: Season; date: string }[] = [
    { name: 'auto, starts later', season: OFF_LATER, date: TODAY },
    { name: 'auto, starts later, no end', season: OFF_LATER_SAME_DAY, date: TODAY },
    { name: 'auto, starts today: no return, it is on', season: season('s-t', 'T', 'auto', { startsOn: TODAY }), date: TODAY },
    { name: 'auto, started', season: ON_RANGE, date: TODAY },
    { name: 'auto, ended', season: OFF_ENDED, date: TODAY },
    { name: 'auto, inverted: never', season: OFF_INVERTED, date: TODAY },
    { name: 'auto, no start', season: season('s-n', 'N', 'auto', { endsOn: '2026-12-01' }), date: TODAY },
    { name: 'paused, with a later start', season: { ...OFF_LATER, state: 'paused' }, date: TODAY },
    { name: 'active, with a later start', season: { ...OFF_LATER, state: 'active' }, date: TODAY },
  ];
  const seasonResumeDateCases = resumeCases.map((c) => ({ ...c, expected: seasonResumeDate(c.season, c.date) ?? null }));

  return {
    routineStandingOn: routineStandingOnCases,
    seasonResumeDate: seasonResumeDateCases,
    ...buildSuppression(),
  };
}

/*
 * Why an item is hidden (suppressionReason, put into words by
 * suppressionLabel), and what deleting a routine would bring back
 * (membersRevealedByRemoving): asked over one world of routines, seasons and
 * trips, on the day each case names.
 */
const SUPPRESSION_ROUTINES: Routine[] = [
  routine('r-paused', 'Morning', { pausedAt: '2026-10-20T13:00:00Z', itemIds: [uid(5), uid(13), uid(15), uid(23)] }),
  routine('r-paused-until', 'Evening', {
    pausedAt: '2026-10-20T13:00:00Z',
    pausedUntil: '2026-10-30',
    itemIds: [uid(6), uid(14)],
  }),
  routine('r-live', 'Desk', { itemIds: [uid(13), uid(21)] }),
  routine('r-held', 'Garden', { itemIds: [uid(8)] }),
  // Paused until after the season it sits in comes back: the routine binds.
  routine('r-held-paused', 'Ski prep', { pausedAt: '2026-10-20T13:00:00Z', pausedUntil: '2026-11-05', itemIds: [uid(9)] }),
  // Paused until before the season comes back: the season binds.
  routine('r-held-paused-early', 'Reading', { pausedAt: '2026-10-20T13:00:00Z', pausedUntil: '2026-10-28', itemIds: [uid(10)] }),
  // Paused with no return, in a season with one: the routine, with no date.
  routine('r-held-paused-forever', 'Piano', { pausedAt: '2026-10-20T13:00:00Z', itemIds: [uid(11)] }),
  routine('r-held-by-shelf', 'Stretching', { itemIds: [uid(12)] }),
];

const SUPPRESSION_SEASONS: Season[] = [
  season('s-winter', 'Winter', 'auto', {
    startsOn: '2026-11-01',
    endsOn: '2027-02-28',
    itemIds: [uid(7), uid(15)],
    routineIds: ['r-held', 'r-held-paused', 'r-held-paused-early', 'r-held-paused-forever'],
  }),
  season('s-shelf', 'Shelf', 'paused', { itemIds: [uid(4)], routineIds: ['r-held-by-shelf'] }),
  season('s-autumn', 'Autumn', 'auto', { startsOn: '2026-09-01', endsOn: '2026-11-30', itemIds: [uid(16)] }),
  season('s-holiday', 'Holiday', 'auto', { startsOn: '2026-12-01', endsOn: '2026-12-31', itemIds: [uid(14)] }),
];

const SUPPRESSION_ITEMS: Item[] = [
  habit(1, 'Plain'),
  habit(2, 'Paused item', { pausedAt: '2026-10-20T13:00:00Z' }),
  task(3, 'Paused until a day', { startDate: '2026-10-23', timeBucket: 'morning', pausedAt: '2026-10-20T13:00:00Z', pausedUntil: '2026-10-30' }),
  habit(4, 'Paused, in an off season', { pausedAt: '2026-10-20T13:00:00Z' }),
  habit(5, 'In a paused routine'),
  habit(6, 'In a routine paused until a day'),
  habit(7, 'Directly in a season that starts later'),
  habit(8, 'In a routine a later season holds'),
  habit(9, 'Routine back after its season'),
  habit(10, 'Routine back before its season'),
  habit(11, 'Routine paused for good, season dated'),
  habit(12, 'In a routine a switched-off season holds'),
  habit(13, 'Two paths, one live'),
  habit(14, 'Two dead paths, the sooner wins'),
  habit(15, 'A dated path beats one with no return'),
  habit(16, 'In a season that is on'),
  habit(18, 'Kept on the trip'),
  habit(19, 'Eases back after the trip'),
  task(20, 'Undated, never held by a trip', { isScheduled: false }),
  habit(21, 'In a routine the trip keeps'),
  // 22:00 on Oct 23 in New York is Oct 24 in Tokyo.
  habit(22, 'Paused tonight', { pausedAt: '2026-10-24T02:00:00Z' }),
  habit(23, 'Done today, in a paused routine', { completedDates: [TODAY] }),
];

const SUPPRESSION_AWAY: AwayPeriod[] = [
  {
    id: 't-coast',
    startsOn: '2026-11-02',
    endsOn: '2026-11-09',
    keep: { itemIds: [uid(18)], routineIds: ['r-live'], projectIds: [] },
    returns: { [uid(19)]: '2026-11-12' },
    fromTrip: {},
  },
  { id: 't-open', startsOn: '2027-01-10', keep: { itemIds: [], routineIds: [], projectIds: [] }, returns: {}, fromTrip: {} },
];

function buildSuppression() {
  const world = { items: SUPPRESSION_ITEMS, routines: SUPPRESSION_ROUTINES, seasons: SUPPRESSION_SEASONS, away: SUPPRESSION_AWAY };
  const ask = (name: string, n: number, date: string = TODAY, timeZone: string = ZONE) => ({ name, itemId: uid(n), date, timeZone });
  const asks = [
    ask('live, in no container', 1),
    ask('its own pause, no return day', 2),
    ask('its own pause until a day', 3),
    ask('its own pause wins over an off season', 4),
    ask('a paused routine, no return day', 5),
    ask('a routine paused until a day', 6),
    ask('directly in a season that starts later', 7),
    ask('a routine held by a season that starts later', 8),
    ask('blocked twice: the routine comes back last, so it is named', 9),
    ask('blocked twice: the season comes back last, so it is named', 10),
    ask('blocked twice: a routine with no return is named, with no date', 11),
    ask('a routine held by a switched-off season: no date', 12),
    ask('one live path is enough', 13),
    ask('two dead paths: the sooner return names it', 14),
    ask('a dated path beats one with no return', 15),
    ask('a season that is on', 16),
    ask('on a trip: back the day it ends', 1, '2026-11-04'),
    ask('on a trip, kept', 18, '2026-11-04'),
    ask('on a trip, easing back on a later wave', 19, '2026-11-04'),
    ask('after the trip, still on its wave', 19, '2026-11-10'),
    ask('after the trip and its wave', 19, '2026-11-12'),
    ask('an undated task never rests on a trip', 20, '2026-11-04'),
    ask('a routine the trip keeps', 21, '2026-11-04'),
    ask('its own pause wins over a trip', 2, '2026-11-04'),
    ask('an open-ended trip has no return', 1, '2027-01-15'),
    ask('paused late tonight, in New York', 22),
    ask('paused late tonight, read in Tokyo: not yet', 22, TODAY, 'Asia/Tokyo'),
    ask('the day a later season starts, its items are back', 7, '2026-11-01'),
  ];
  const byId = new Map(SUPPRESSION_ITEMS.map((i) => [i.id, i]));
  const suppressionReasonCases = asks.map((c) => {
    const r = suppressionReason(byId.get(c.itemId)!, c.date, {
      userTimezone: c.timeZone,
      routines: SUPPRESSION_ROUTINES,
      seasons: SUPPRESSION_SEASONS,
      away: SUPPRESSION_AWAY,
    });
    return {
      ...c,
      expected: r && {
        kind: r.kind,
        until: r.until ?? null,
        routineId: 'routine' in r ? (r.routine?.id ?? null) : null,
        seasonId: r.kind === 'season' ? r.season.id : null,
        short: suppressionLabel(r),
        long: suppressionLabel(r, { long: true }),
      },
    };
  });

  // The routine pane asks with its routines and seasons and no trips
  // (components/planner/organize/sections/routines.tsx), and so do these.
  const revealCases: { name: string; routineId: string; memberIds: string[] }[] = [
    {
      name: 'a paused routine: only what it alone held comes back',
      routineId: 'r-paused',
      memberIds: [uid(5), uid(13), uid(15), uid(23)],
    },
    { name: 'a live routine brings nothing back', routineId: 'r-live', memberIds: [uid(13), uid(21)] },
    { name: 'a routine an off season holds', routineId: 'r-held', memberIds: [uid(8)] },
    { name: 'held off twice: deleting the routine lifts both', routineId: 'r-held-paused', memberIds: [uid(9)] },
    { name: 'an id the routine does not hold is never named', routineId: 'r-held', memberIds: [uid(7)] },
    { name: 'a trashed member is never named', routineId: 'r-paused', memberIds: [uid(99), uid(5)] },
    { name: 'no members', routineId: 'r-paused', memberIds: [] },
  ];
  const membersRevealedByRemovingCases = revealCases.map((c) => ({
    ...c,
    date: TODAY,
    timeZone: ZONE,
    expected: membersRevealedByRemoving(
      c.routineId,
      c.memberIds,
      SUPPRESSION_ITEMS,
      { userTimezone: ZONE, routines: SUPPRESSION_ROUTINES, seasons: SUPPRESSION_SEASONS },
      TODAY,
    ),
  }));

  return {
    suppressionWorld: world,
    suppressionReason: suppressionReasonCases,
    membersRevealedByRemoving: membersRevealedByRemovingCases,
  };
}

// ── goals.json: progress, its words, and the list order (lib/goals.ts) ───────

function buildGoals() {
  const items: Item[] = [
    task(1, 'Book a tutor', { status: 'completed', startDate: '2026-09-15' }),
    task(2, 'First lesson', { status: 'pending', startDate: '2026-11-02' }),
    task(3, 'Order a novel', { status: 'pending', isScheduled: false }),
    task(4, 'Dropped checkpoint', { status: 'cancelled', startDate: '2026-10-01' }),
    custom(5, 'book', 'Read Dune', { status: 'completed' }),
    // A custom item's own done word decides, never a literal.
    custom(6, 'book', 'Read Neruda', { status: 'done' }),
    habit(7, 'Practise daily'),
    task(8, 'Run the 10K', { status: 'completed', startDate: '2026-10-04' }),
    // The timeline's (O3): late, ahead, undated, reached early, due today.
    task(20, 'Pick a venue', { startDate: '2026-10-10' }),
    task(21, 'Book flights', { startDate: '2026-11-15' }),
    task(22, 'Undated checkpoint', { isScheduled: false }),
    task(23, 'Second undated checkpoint', { isScheduled: false }),
    task(24, 'Reached early', { startDate: '2026-12-01', status: 'completed' }),
    task(25, 'Due today', { startDate: TODAY }),
    habit(26, 'Weekly review', {
      repeatFrequency: 'custom',
      repeatDays: [0],
      completedDates: ['2026-10-04', '2026-10-18', '2026-10-11'],
    }),
    task(27, 'Money check', { startDate: '2026-10-01', repeatFrequency: 'monthly', repeatMonthDay: 1, completedDates: ['2026-10-01'] }),
    habit(28, 'Daily Spanish'),
    task(30, 'Also late', { startDate: '2026-10-15' }),
    task(31, 'Tie A', { startDate: '2026-11-20' }),
    task(32, 'Tie B', { startDate: '2026-11-20' }),
    // A legacy row whose day is a whole ISO stamp.
    task(33, 'Legacy stamp', { startDate: '2026-10-01T00:00:00Z' }),
  ];
  // uid(99) is a trashed milestone: its join row outlives it, and the item is not here.
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const goals: Goal[] = [
    goal('g-none', 'No milestones', { memberIds: [uid(7)] }),
    goal('g-half', 'Half there', { milestoneIds: [uid(1), uid(2)] }),
    goal('g-all', 'All reached so far', { milestoneIds: [uid(1), uid(8)] }),
    goal('g-all-achieved', 'All reached, achieved', { state: 'achieved', milestoneIds: [uid(1), uid(8)] }),
    goal('g-set-aside', 'Set aside part way', { state: 'abandoned', milestoneIds: [uid(1), uid(2), uid(3)] }),
    goal('g-cancelled', 'A dropped checkpoint leaves both sides', { milestoneIds: [uid(1), uid(4), uid(2)] }),
    goal('g-trashed', 'A trashed checkpoint leaves both sides', { milestoneIds: [uid(99), uid(1)] }),
    goal('g-only-dropped', 'Only dropped and trashed', { milestoneIds: [uid(4), uid(99)] }),
    goal('g-custom', 'A custom type’s done word', { milestoneIds: [uid(5), uid(6)] }),
    goal('g-roles', 'Only milestones count', {
      milestoneIds: [uid(2)],
      checkinIds: [uid(7)],
      memberIds: [uid(8)],
    }),
  ];
  const goalProgressCases = goals.map((g) => {
    const p = goalProgress(g, itemsById);
    return {
      name: g.name,
      goal: g,
      expected: { achieved: p.achieved, total: p.total, fraction: p.fraction, label: progressLabel(g, p.achieved, p.total) },
    };
  });

  const labelCases = [
    { name: 'none, active', state: 'active', achieved: 0, total: 0 },
    { name: 'none, achieved', state: 'achieved', achieved: 0, total: 0 },
    { name: 'none done, active', state: 'active', achieved: 0, total: 3 },
    { name: 'part way, active', state: 'active', achieved: 2, total: 5 },
    { name: 'all done, active: so far', state: 'active', achieved: 2, total: 2 },
    { name: 'all done, achieved', state: 'achieved', achieved: 2, total: 2 },
    { name: 'all done, set aside', state: 'abandoned', achieved: 4, total: 4 },
    { name: 'part way, set aside', state: 'abandoned', achieved: 1, total: 4 },
    { name: 'double digits', state: 'active', achieved: 10, total: 12 },
  ] as const;
  const progressLabelCases = labelCases.map((c) => {
    const g = goal('g', 'G', { state: c.state });
    return { name: c.name, goal: g, achieved: c.achieved, total: c.total, expected: progressLabel(g, c.achieved, c.total) };
  });

  const isGoalActiveCases = (['active', 'achieved', 'abandoned'] as const).map((state) => {
    const g = goal(`g-${state}`, state, { state });
    return { name: state, goal: g, expected: isGoalActive(g) };
  });

  const a = (id: string, state: Goal['state'], sortOrder?: number) => goal(id, id, { state, sortOrder });
  const sortCases = [
    { name: 'empty', goals: [] as Goal[] },
    { name: 'all active keep their order', goals: [a('g1', 'active', 2), a('g2', 'active', 0), a('g3', 'active', 1)] },
    {
      name: 'ended sink, each half in its order',
      goals: [a('g1', 'achieved', 0), a('g2', 'active', 1), a('g3', 'abandoned', 2), a('g4', 'active', 3), a('g5', 'achieved', 4)],
    },
    { name: 'all ended keep their order', goals: [a('g1', 'abandoned'), a('g2', 'achieved'), a('g3', 'abandoned')] },
    { name: 'one active after the ended', goals: [a('g1', 'achieved'), a('g2', 'achieved'), a('g3', 'active')] },
  ];
  const sortGoalsForDisplayCases = sortCases.map((c) => ({
    ...c,
    expected: sortGoalsForDisplay(c.goals).map((g) => g.id),
  }));

  return {
    world: { items },
    goalProgress: goalProgressCases,
    progressLabel: progressLabelCases,
    isGoalActive: isGoalActiveCases,
    sortGoalsForDisplay: sortGoalsForDisplayCases,
    ...buildGoalPage(items, itemsById),
  };
}

/*
 * The goal page (O3): the next checkpoint, each milestone's state and the
 * timeline's order and words, the time gone and the days left, the wind-down
 * list, the supporting work by type, and a check-in's last day. Asked on
 * TODAY over the same world as the progress cases.
 */
function buildGoalPage(items: Item[], itemsById: Map<string, Item>) {
  const ms = (name: string, ids: number[], over: Partial<Goal> = {}) => ({
    name,
    goal: goal(`g-${ids.join('-') || 'none'}`, name, { milestoneIds: ids.map(uid), ...over }),
  });
  const timelineGoals = [
    ms('a late next, then one ahead, after one reached', [21, 20, 1]),
    ms('dated first by date, then the undated in stored order', [23, 22, 2]),
    ms('a dropped one stays, a trashed one goes', [4, 99, 2]),
    ms('a late one that is not next', [30, 20]),
    ms('reached ahead of its date', [24]),
    ms('due today is not late', [25]),
    ms('all reached: nothing is next', [1, 8]),
    ms('no milestones', []),
    ms('only undated: the first is next', [22, 23]),
    ms('a custom type’s done word', [5, 6]),
    ms('the same date keeps stored order', [32, 31]),
    ms('a legacy ISO day', [33, 21]),
    ms('an ended goal still marks its next', [20, 21], { state: 'achieved' }),
  ];
  const milestoneTimelineCases = timelineGoals.map((c) => ({
    ...c,
    today: TODAY,
    expected: milestoneTimeline(c.goal, itemsById, TODAY).map((r) => ({
      itemId: r.item.id,
      state: r.state,
      date: r.date ?? null,
      late: r.late,
      dateLabel: r.dateLabel,
      annotations: r.annotations,
    })),
  }));
  const nextMilestoneCases = timelineGoals.map((c) => ({
    ...c,
    expected: nextMilestone(c.goal, itemsById)?.id ?? null,
  }));

  const stateAsks: { name: string; n: number; isNext: boolean }[] = [
    { name: 'dropped outranks next', n: 4, isNext: true },
    { name: 'reached outranks next', n: 1, isNext: true },
    { name: 'next outranks late', n: 20, isNext: true },
    { name: 'late and not next', n: 20, isNext: false },
    { name: 'due today is ahead', n: 25, isNext: false },
    { name: 'undated is ahead', n: 22, isNext: false },
    { name: 'a future day is ahead', n: 21, isNext: false },
    { name: 'a legacy ISO day before today', n: 33, isNext: false },
    { name: 'a custom type’s other word is not reached', n: 6, isNext: false },
  ];
  const milestoneStateCases = stateAsks.map((c) => ({
    name: c.name,
    item: itemsById.get(uid(c.n))!,
    isNext: c.isNext,
    today: TODAY,
    expected: milestoneState(itemsById.get(uid(c.n))!, c.isNext, TODAY),
  }));

  const windowed = (name: string, startsOn: string | undefined, targetOn: string | undefined, today = TODAY) => ({
    name,
    goal: goal('g-window', 'Window', { startsOn, targetOn }),
    today,
  });
  const elapsedAsks = [
    windowed('no window', undefined, undefined),
    windowed('a target alone', undefined, '2026-11-01'),
    windowed('a start alone', '2026-10-01', undefined),
    windowed('an inverted window', '2026-11-01', '2026-10-01'),
    windowed('a one-day window is no window', '2026-10-01', '2026-10-01'),
    windowed('before it starts', '2026-11-01', '2026-12-01'),
    windowed('on its first day', TODAY, '2026-12-01'),
    windowed('part way', '2026-10-01', '2026-11-01'),
    windowed('exactly half', '2026-10-15', '2026-10-31'),
    windowed('a half percent rounds up', '2026-10-22', '2026-10-30'),
    windowed('on its target day', '2026-10-01', TODAY),
    windowed('past its target', '2026-09-01', '2026-10-01'),
    windowed('legacy ISO days', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'),
    windowed('across a year', '2026-12-01', '2027-03-01', '2027-01-15'),
  ];
  const timeElapsedCases = elapsedAsks.map((c) => ({
    ...c,
    expected: { fraction: timeElapsed(c.goal, c.today), label: timeElapsedLabel(c.goal, c.today) },
  }));

  const countdownAsks: { name: string; goal: Goal }[] = [
    { name: 'days to go', goal: goal('g-c', 'C', { targetOn: '2026-11-04' }) },
    { name: 'one day to go', goal: goal('g-c', 'C', { targetOn: '2026-10-24' }) },
    { name: 'the target is today', goal: goal('g-c', 'C', { targetOn: TODAY }) },
    { name: 'one day past', goal: goal('g-c', 'C', { targetOn: '2026-10-22' }) },
    { name: 'days past', goal: goal('g-c', 'C', { targetOn: '2026-10-20' }) },
    { name: 'into next year', goal: goal('g-c', 'C', { targetOn: '2027-01-04' }) },
    { name: 'a legacy ISO target', goal: goal('g-c', 'C', { targetOn: '2026-11-04T00:00:00Z' }) },
    { name: 'no target', goal: goal('g-c', 'C') },
    { name: 'achieved: no countdown', goal: goal('g-c', 'C', { state: 'achieved', targetOn: '2026-11-04' }) },
    { name: 'set aside: no countdown', goal: goal('g-c', 'C', { state: 'abandoned', targetOn: '2026-11-04' }) },
  ];
  const goalCountdownCases = countdownAsks.map((c) => ({ ...c, today: TODAY, expected: goalCountdown(c.goal, TODAY) }));

  const windDownAsks: { name: string; goal: Goal }[] = [
    {
      name: 'check-ins, then supporting work, then milestones; recurring only',
      goal: goal('g-done', 'Done', {
        state: 'achieved',
        checkinIds: [uid(26)],
        memberIds: [uid(2), uid(28), uid(99)],
        milestoneIds: [uid(27), uid(1)],
      }),
    },
    { name: 'nothing recurring', goal: goal('g-done', 'Done', { state: 'abandoned', memberIds: [uid(2)], milestoneIds: [uid(1)] }) },
    { name: 'an empty goal', goal: goal('g-done', 'Done', { state: 'achieved' }) },
  ];
  const windDownMembersCases = windDownAsks.map((c) => ({
    ...c,
    expected: windDownMembers(c.goal, itemsById).map((i) => i.id),
  }));

  const groupAsks: { name: string; ids: string[] }[] = [
    { name: 'by type, in first-seen order', ids: [uid(28), uid(2), uid(26), uid(5), uid(99), uid(3)] },
    { name: 'one type', ids: [uid(2), uid(3)] },
    { name: 'none', ids: [] },
    { name: 'only trashed', ids: [uid(99)] },
  ];
  const goalMemberGroupsCases = groupAsks.map((c) => ({
    ...c,
    expected: goalMemberGroups(c.ids, itemsById).map((g) => ({
      typeName: g.typeName,
      labelPlural: getItemTypeConfig(g.typeName).labelPlural,
      ids: g.items.map((i) => i.id),
    })),
  }));

  const lastDoneOnCases = [26, 27, 28, 1].map((n) => {
    const item = items.find((i) => i.id === uid(n))!;
    return { name: item.title, item, expected: lastDoneOn(item) ?? null };
  });

  return {
    nextMilestone: nextMilestoneCases,
    milestoneState: milestoneStateCases,
    milestoneTimeline: milestoneTimelineCases,
    timeElapsed: timeElapsedCases,
    goalCountdown: goalCountdownCases,
    windDownMembers: windDownMembersCases,
    goalMemberGroups: goalMemberGroupsCases,
    lastDoneOn: lastDoneOnCases,
  };
}

// ── schedule.json: who is in a container (lib/container-schedule.ts) ────────

function buildSchedule() {
  const items: Item[] = [
    task(1, 'Filed as Work', { project: 'Work' }),
    task(2, 'Filed as work', { project: 'work' }),
    task(3, 'Filed as WORK', { project: 'WORK' }),
    // A fold, never a trim: a trailing space is another project.
    task(4, 'Filed as "Work "', { project: 'Work ' }),
    // Subtasks carry their parent's project: in the members, not in the list.
    task(5, 'A subtask filed as Work', { project: 'Work', parentItemId: uid(1), isScheduled: false }),
    task(6, 'Unfiled'),
    task(7, 'Filed as empty', { project: '' }),
    habit(8, 'A habit filed as work', { project: 'work' }),
    task(9, 'Done, still a member', { project: 'Work', status: 'completed' }),
    task(10, 'Filed as Café', { project: 'Café' }),
    task(11, 'Filed as CAFÉ', { project: 'CAFÉ' }),
    task(12, 'Filed as Straße', { project: 'Straße' }),
    task(13, 'Filed as STRASSE', { project: 'STRASSE' }),
    // JS folds a dotted capital I to i and a combining dot above.
    task(14, 'Filed as İstanbul', { project: '\u0130stanbul' }),
    task(15, 'Filed as its JS fold', { project: 'i\u0307stanbul' }),
    task(19, 'Filed as istanbul', { project: 'istanbul' }),
    habit(16, 'Stretch'),
    habit(17, 'Meditate'),
    task(18, 'Plants'),
  ];
  const routines: Routine[] = [
    routine('r-morning', 'Morning', { itemIds: [uid(17), uid(16)] }),
    // A member id the payload no longer holds (a trashed item) stays in the array.
    routine('r-evening', 'Evening', { itemIds: [uid(18), uid(99)] }),
    routine('r-empty', 'Empty'),
  ];

  const cases: { name: string; container: ScheduleContainer }[] = [
    { name: 'a routine: its itemIds, in order, as stored', container: { kind: 'routine', routine: routines[0] } },
    { name: 'a routine with a trashed member', container: { kind: 'routine', routine: routines[1] } },
    { name: 'an empty routine', container: { kind: 'routine', routine: routines[2] } },
    {
      name: 'a season: its own items, then each routine’s, once each',
      container: {
        kind: 'season',
        season: season('s-autumn', 'Autumn', 'auto', {
          itemIds: [uid(18), uid(6)],
          routineIds: ['r-morning', 'r-evening'],
        }),
      },
    },
    {
      name: 'a season holding a routine that is gone',
      container: { kind: 'season', season: season('s-shelf', 'Shelf', 'paused', { routineIds: ['r-gone', 'r-morning'] }) },
    },
    { name: 'an empty season', container: { kind: 'season', season: season('s-none', 'None', 'auto') } },
    {
      name: 'a goal: milestones, check-ins, then members',
      container: {
        kind: 'goal',
        goal: goal('g-spanish', 'Spanish', { memberIds: [uid(16)], milestoneIds: [uid(2), uid(1)], checkinIds: [uid(18)] }),
      },
    },
    { name: 'a project, by folded name', container: { kind: 'project', project: project('p-work', 'Work') } },
    { name: 'the same project, named in capitals', container: { kind: 'project', project: project('p-work', 'WORK') } },
    { name: 'a project folds accents', container: { kind: 'project', project: project('p-cafe', 'café') } },
    { name: 'a project folds ß as JS does', container: { kind: 'project', project: project('p-strasse', 'Straße') } },
    {
      name: 'a project folds a dotted capital I as JS does',
      container: { kind: 'project', project: project('p-ist', '\u0130stanbul') },
    },
    { name: 'a project nobody is filed under', container: { kind: 'project', project: project('p-empty', 'Errands') } },
  ];
  const byId = new Map(items.map((i) => [i.id, i]));
  const containerMemberIdsCases = cases.map((c) => {
    const expected = containerMemberIds(c.container, items, routines);
    return {
      ...c,
      expected,
      // The project list's rows (components/planner/organize/sections/labels.tsx,
      // the console's project pane): the members less subtasks, which is what
      // the phone counts as "N items". Only a project's list drops them.
      ...(c.container.kind === 'project'
        ? { listed: expected.filter((id) => !(byId.get(id) as { parentItemId?: string } | undefined)?.parentItemId) }
        : {}),
    };
  });

  return { world: { items, routines }, containerMemberIds: containerMemberIdsCases, ...buildCalendar() };
}

/*
 * Where a container's items land, day by day (deriveContainerSchedule), and
 * what the phone reads off it: each day counted by state (dayRollup, the
 * "Last 14 days" strip), the week's totals and today's count (weekTotals,
 * todayCount), and today's run in the container's order (todayInOrder).
 *
 * One world, asked over the fourteen days that end on TODAY (a Friday) unless
 * a case says otherwise. Oct 10 is a Saturday.
 */
const CAL_FROM = '2026-10-10';

const CALENDAR_ITEMS: Item[] = [
  habit(1, 'Stretch', {
    timeBucket: 'morning',
    order: 0,
    completedDates: ['2026-10-12', '2026-10-13', '2026-10-20', TODAY],
    skippedDates: ['2026-10-15'],
  }),
  habit(2, 'Meditate', {
    timeBucket: 'morning',
    order: 1,
    repeatFrequency: 'custom',
    repeatDays: [1, 3, 5],
    completedDates: ['2026-10-14', '2026-10-16'],
  }),
  // The member added today: a daily habit with nothing recorded.
  habit(3, 'Journal', { timeBucket: 'evening', order: 2 }),
  task(4, 'Water plants', {
    timeBucket: 'afternoon',
    startDate: '2026-10-03',
    repeatFrequency: 'custom',
    repeatDays: [6],
    completedDates: ['2026-10-10'],
    skippedDates: ['2026-10-17'],
  }),
  task(5, 'Book dentist', { timeBucket: 'anytime', startDate: '2026-10-21', status: 'completed' }),
  task(6, 'Call bank', { timeBucket: 'morning', startDate: '2026-10-15' }),
  // Cancelled is a recorded decision: skipped, never due.
  task(7, 'Return parcel', { timeBucket: 'morning', startDate: '2026-10-18', status: 'cancelled' }),
  task(8, 'Send invoice', { timeBucket: 'afternoon', startDate: TODAY }),
  // A recurring task shows from its anchor on, never before.
  task(9, 'Stand-up notes', {
    timeBucket: 'morning',
    startDate: '2026-10-20',
    repeatFrequency: 'daily',
    completedDates: ['2026-10-21'],
  }),
  task(10, 'Pick a gift', { isScheduled: false }),
  // Dated with no bucket: the grid drops it, and it is not braindump work either.
  task(11, 'Unbucketed', { startDate: '2026-10-22' }),
  task(12, 'Paused errand', { isScheduled: false, pausedAt: '2026-10-20T13:00:00Z' }),
  // In a routine paused from Oct 19: gone from the days it is held, except a
  // day it was done anyway (a done day is not an open loop, so not hidden).
  habit(13, 'Run', {
    timeBucket: 'evening',
    repeatFrequency: 'custom',
    repeatDays: [2, 4],
    completedDates: ['2026-10-13', '2026-10-20'],
  }),
  // In a routine a season holds until Oct 16: weekends inside it show, and a
  // weekend after it shows only where it was done.
  habit(14, 'Long walk', {
    timeBucket: 'afternoon',
    repeatFrequency: 'weekends',
    completedDates: ['2026-10-11', '2026-10-18'],
  }),
  task(15, 'Season errand', { timeBucket: 'morning', startDate: '2026-10-12' }),
  task(16, 'Write the report', { timeBucket: 'morning', startDate: '2026-10-14', status: 'completed', project: 'Work' }),
  task(17, 'Clear the inbox', {
    timeBucket: 'morning',
    startDate: '2026-10-01',
    repeatFrequency: 'weekdays',
    completedDates: ['2026-10-22'],
    skippedDates: ['2026-10-19'],
    project: 'work',
  }),
  task(18, 'Plan the quarter', { isScheduled: false, project: 'WORK' }),
  // A subtask carries its parent's project, and never lands on a day.
  task(19, 'Report appendix', { isScheduled: false, project: 'Work', parentItemId: uid(16) }),
  custom(21, 'book', 'Read Dune', { timeBucket: 'evening', startDate: '2026-10-19', status: 'completed' }),
  // Skipped today: on the run, counted as skipped, never the next one.
  habit(22, 'Floss', { timeBucket: 'evening', skippedDates: [TODAY] }),
];

const CALENDAR_ROUTINES: Routine[] = [
  // Its own order, not the grid's: Meditate first.
  routine('r-morning', 'Morning', { itemIds: [uid(2), uid(1)] }),
  routine('r-evening', 'Evening', { itemIds: [uid(13)], pausedAt: '2026-10-19T12:00:00Z' }),
  routine('r-weekend', 'Weekend', { itemIds: [uid(14)] }),
  routine('r-empty', 'Empty'),
];

const CALENDAR_SEASONS: Season[] = [
  season('s-autumn', 'Autumn', 'auto', {
    startsOn: '2026-09-01',
    endsOn: '2026-10-16',
    itemIds: [uid(15)],
    routineIds: ['r-weekend'],
  }),
];

const CALENDAR_PROJECTS: Project[] = [
  project('p-work', 'Work', {
    startTime: '09:00',
    timeBucket: 'morning',
    repeatFrequency: 'weekdays',
    duration: 90,
  } as Partial<Project>),
];

/** A trip over Oct 12 to Oct 14 (back on the 15th). */
const CALENDAR_TRIP: AwayPeriod = {
  id: 't-weekend-away',
  startsOn: '2026-10-12',
  endsOn: '2026-10-15',
  keep: { itemIds: [], routineIds: [], projectIds: [] },
  returns: {},
  fromTrip: {},
};

function buildCalendar() {
  const [morning, evening, , empty] = CALENDAR_ROUTINES;
  const { tasks, habits } = projectItems(CALENDAR_ITEMS);
  const asked: {
    name: string;
    container: ScheduleContainer;
    from?: string;
    days?: number;
    away?: AwayPeriod[];
    memberIds?: string[];
    block?: Project;
  }[] = [
    { name: 'a routine, in its own order', container: { kind: 'routine', routine: morning } },
    {
      name: 'the same routine with a member added today: no past cell changes',
      container: { kind: 'routine', routine: { ...morning, itemIds: [...morning.itemIds, uid(3)] } },
    },
    { name: 'a paused routine leaves the days it holds, except a day done anyway', container: { kind: 'routine', routine: evening } },
    {
      name: 'a season and its routine, ending mid-range',
      container: { kind: 'season', season: CALENDAR_SEASONS[0] },
    },
    {
      name: 'a goal: checkpoints, a check-in and supporting work',
      container: {
        kind: 'goal',
        goal: goal('g-run', 'Run a half', {
          milestoneIds: [uid(5), uid(8)],
          checkinIds: [uid(4)],
          memberIds: [uid(1), uid(10), uid(12), uid(21)],
        }),
      },
    },
    {
      name: 'a project by folded name, with its time block',
      container: { kind: 'project', project: CALENDAR_PROJECTS[0] },
      block: CALENDAR_PROJECTS[0],
    },
    {
      name: 'a trip holds what falls inside it, except what was done',
      container: { kind: 'routine', routine: morning },
      away: [CALENDAR_TRIP],
    },
    { name: 'the week ahead: today and six days after', container: { kind: 'routine', routine: morning }, from: TODAY, days: 7 },
    {
      name: 'a range that ends before today',
      container: { kind: 'routine', routine: morning },
      from: '2026-10-01',
      days: 5,
    },
    { name: 'an empty routine', container: { kind: 'routine', routine: empty } },
    {
      name: 'a skip is passed over: next is the first still due',
      container: { kind: 'routine', routine: routine('r-night', 'Night', { itemIds: [uid(22), uid(2), uid(1)] }) },
    },
    {
      name: 'done and skipped: through for today',
      container: { kind: 'routine', routine: routine('r-night', 'Night', { itemIds: [uid(22), uid(1)] }) },
    },
    {
      name: 'an id the payload no longer holds lands nowhere',
      container: { kind: 'routine', routine: { ...morning, itemIds: [uid(99), uid(1)] } },
    },
  ];

  const deriveContainerScheduleCases = asked.map((c) => {
    const from = c.from ?? CAL_FROM;
    const days = c.days ?? 14;
    const away = c.away ?? [];
    const memberIds = containerMemberIds(c.container, CALENDAR_ITEMS, CALENDAR_ROUTINES);
    const schedule = deriveContainerSchedule({
      memberIds,
      source: {
        items: CALENDAR_ITEMS,
        tasks: tasks as Task[],
        habits: habits as HabitItem[],
        routines: CALENDAR_ROUTINES,
        seasons: CALENDAR_SEASONS,
        away,
        timezone: ZONE,
      },
      from,
      days,
      todayStr: TODAY,
      block: c.block,
    });
    const byItem = occurrencesByItem(schedule);
    const run = todayInOrder(schedule, memberIds, TODAY);
    return {
      name: c.name,
      container: c.container,
      memberIds,
      from,
      days,
      today: TODAY,
      timeZone: ZONE,
      away,
      blockProjectId: c.block?.id ?? null,
      expected: {
        days: schedule.days.map((d) => ({
          date: d.date,
          occurrences: d.occurrences.map((o) => ({ itemId: o.itemId, state: o.state, once: o.once })),
          block: d.block?.id ?? null,
        })),
        unscheduled: schedule.unscheduled.map((i) => i.id),
        rollup: dayRollup(schedule),
        weekTotals: weekTotals(byItem, memberIds),
        todayCount: todayCount(byItem, memberIds, TODAY) ?? null,
        todayRun: {
          rows: run.rows,
          done: run.done,
          skipped: run.skipped,
          nextId: run.nextId ?? null,
          finished: run.finished,
        },
      },
    };
  });

  return {
    calendar: {
      items: CALENDAR_ITEMS,
      routines: CALENDAR_ROUTINES,
      seasons: CALENDAR_SEASONS,
      projects: CALENDAR_PROJECTS,
    },
    deriveContainerSchedule: deriveContainerScheduleCases,
  };
}

// ── look.json: colour and glyph (lib/accent-colors.ts, lib/category-icons.ts) ─

/**
 * oklch → sRGB, Björn Ottosson's OKLab matrices plus the sRGB transfer
 * curve, clamped to [0, 1]. The reference the Swift port converts with too.
 */
function oklchToSrgb(l: number, c: number, h: number): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  const linear = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  const [r, g, bl] = linear.map((x) => Math.min(1, Math.max(0, gamma(x))));
  return [r, g, bl];
}

const hex = ([r, g, b]: [number, number, number]) =>
  '#' + [r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');

/** The theme's colour tokens a container can name. */
const TOKENS = [
  ...Array.from({ length: 8 }, (_, i) => `accent-${i + 1}`),
  'habit-wellness',
  'habit-work',
  'habit-personal',
];

/** One rule block of globals.css, from its selector line to its closing brace. */
function block(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`globals.css: no ${JSON.stringify(selector)} block`);
  const end = css.indexOf('\n}', start);
  return css.slice(start, end);
}

/** Each token's oklch triple in one theme's block: exactly one declaration each. */
function triples(text: string, theme: string): Map<string, { l: number; c: number; h: number }> {
  const out = new Map<string, { l: number; c: number; h: number }>();
  for (const token of TOKENS) {
    const re = new RegExp(`--${token}:\\s*oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s*\\)`, 'g');
    const found = [...text.matchAll(re)];
    if (found.length !== 1) throw new Error(`globals.css ${theme}: --${token} declared ${found.length} times as oklch`);
    const [, l, c, h] = found[0];
    out.set(token, { l: Number(l), c: Number(c), h: Number(h) });
  }
  return out;
}

function buildLook() {
  const css = readFileSync(CSS, 'utf8');
  const light = triples(block(css, '[data-theme-preview],\n:root {'), 'light');
  const dark = triples(block(css, '\n.dark {'), 'dark');
  const tokens = TOKENS.map((token) => {
    const l = light.get(token)!;
    const d = dark.get(token)!;
    const accent = /^accent-(\d)$/.exec(token);
    return {
      name: token,
      css: `var(--${token})`,
      swatch: accent ? ACCENT_NAMES[Number(accent[1]) - 1] : null,
      light: { ...l, hex: hex(oklchToSrgb(l.l, l.c, l.h)) },
      dark: { ...d, hex: hex(oklchToSrgb(d.l, d.c, d.h)) },
    };
  });
  const byCss = new Map(tokens.map((t) => [t.css, t]));

  /**
   * A stored colour as the phone draws it: a theme token from the table, a
   * raw `#rrggbb` (an agent can store one), and anything else falls back to
   * the name hash, as an unknown token would read nothing on the web.
   */
  function drawn(color: string | null, containerName: string) {
    const token = color ?? accentColorForName(containerName);
    const known = byCss.get(token);
    if (known) return { source: color === null ? 'name' : 'token', token, light: known.light.hex, dark: known.dark.hex };
    if (/^#[0-9a-fA-F]{6}$/.test(token)) return { source: 'hex', token: null, light: token.toLowerCase(), dark: token.toLowerCase() };
    const fallback = byCss.get(accentColorForName(containerName))!;
    return { source: 'name', token: fallback.css, light: fallback.light.hex, dark: fallback.dark.hex };
  }

  // The ramp hash sums UTF-16 code units, so these pin the phone's iteration.
  const accentNames = [
    'Errands',
    'Deep Work',
    'deep work',
    'anchor',
    '',
    'A',
    'Café',
    'Cafe\u0301',
    '日本語',
    '🏃 Run club',
    '👩\u200d👩\u200d👧 Family',
    'Morning routine',
    'Autumn',
    'Speak Spanish by spring',
  ];
  const accentForName = accentNames.map((input, i) => {
    const token = accentColorForName(input);
    return { name: `${i}: ${JSON.stringify(input)}`, input, token, index: Number(/accent-(\d)/.exec(token)![1]) };
  });

  // Whole Project rows, as the payload carries them (DsulCore's decoder needs the id).
  const projects: Project[] = [
    project('p-admin', 'Admin', { color: 'var(--accent-3)' }),
    project('p-health', 'Health'),
    project('p-work', 'work', { color: 'var(--accent-7)' }),
    project('p-personal', 'Personal'),
    project('p-blue', 'Blue', { color: 'blue' }),
  ];
  // Every legacy name reaches its token in at least one case: 'work' needs a
  // list without p-work, whose stored colour would otherwise win.
  const withoutWork = projects.filter((p) => p.id !== 'p-work');
  const projectColorInputs: { name: string; input: string; projects?: Project[] }[] = [
    { name: 'stored colour wins', input: 'Admin' },
    { name: 'the name folds to find the project', input: 'ADMIN' },
    { name: 'a legacy name with a stored colour keeps it', input: 'Work' },
    { name: 'the work legacy name with no project takes its token', input: 'WORK', projects: withoutWork },
    { name: 'a legacy name with no colour takes its token', input: 'personal' },
    { name: 'a legacy name with no project takes its token', input: 'Wellness' },
    { name: 'no colour: the folded name’s ramp step', input: 'Health' },
    { name: 'no project: the folded name’s ramp step', input: 'Errands' },
    { name: 'folded before hashing', input: 'ERRANDS' },
    { name: 'free text passes through untouched', input: 'blue' },
    { name: 'an object key is not a legacy name', input: 'constructor' },
  ];
  const projectColor = projectColorInputs.map((c) => {
    const list = c.projects ?? projects;
    return { name: c.name, input: c.input, projects: list, expected: projectColorToken(c.input, list) };
  });

  const colorInputs: { name: string; color: string | null; containerName: string }[] = [
    { name: 'no colour: the raw name’s ramp step', color: null, containerName: 'Morning routine' },
    { name: 'no colour, the raw name, never folded', color: null, containerName: 'ERRANDS' },
    { name: 'a ramp token', color: 'var(--accent-2)', containerName: 'Anything' },
    { name: 'the lime', color: 'var(--accent-8)', containerName: 'Anything' },
    { name: 'a legacy token', color: 'var(--habit-work)', containerName: 'Anything' },
    { name: 'a raw hex', color: '#1a2B3c', containerName: 'Anything' },
    { name: 'a short hex falls back', color: '#abc', containerName: 'Errands' },
    { name: 'a CSS name falls back', color: 'blue', containerName: 'Errands' },
    { name: 'an unknown token falls back', color: 'var(--accent-9)', containerName: 'Errands' },
    { name: 'an empty string falls back', color: '', containerName: 'Errands' },
  ];
  const colors = colorInputs.map((c) => ({ ...c, expected: drawn(c.color, c.containerName) }));

  const iconInputs: { name: string; glyph: string | null; containerName: string }[] = [
    { name: 'a picked icon wins', glyph: 'icon:Sunrise', containerName: 'Work' },
    { name: 'a token outside the library derives', glyph: 'icon:CalendarRange', containerName: 'Autumn' },
    { name: 'a token naming an object key derives', glyph: 'icon:constructor', containerName: 'Errands' },
    { name: 'a legacy emoji derives', glyph: '📋', containerName: 'Admin' },
    { name: 'an empty glyph derives', glyph: '', containerName: 'Admin' },
    { name: 'no glyph derives', glyph: null, containerName: 'Admin' },
    { name: 'a lowercase token is not a library name', glyph: 'icon:sunrise', containerName: 'Morning' },
    { name: 'an exact default name', glyph: null, containerName: 'Work' },
    { name: 'an exact default name, trimmed and folded', glyph: null, containerName: '  No Project ' },
    { name: 'an object key is not a default name', glyph: null, containerName: 'constructor' },
    { name: 'a keyword', glyph: null, containerName: 'Gym days' },
    { name: 'the first keyword wins', glyph: null, containerName: 'Morning run' },
    { name: 'a keyword inside a word', glyph: null, containerName: 'Bookkeeping' },
    { name: 'the hash', glyph: null, containerName: 'Errands' },
    { name: 'the hash over an accent', glyph: null, containerName: 'Café' },
    { name: 'the hash over an emoji', glyph: null, containerName: '🏃 Club' },
    { name: 'the hash over Japanese', glyph: null, containerName: '日本語' },
    { name: 'the hash at -2^31', glyph: null, containerName: 'evadgrga' },
    { name: 'an empty name', glyph: null, containerName: '' },
    { name: 'a season made with the web’s default glyph', glyph: 'icon:CalendarRange', containerName: 'Summer' },
    { name: 'a goal made with the web’s default glyph', glyph: 'icon:Target', containerName: 'Speak Spanish' },
    { name: 'a routine made with the web’s default glyph', glyph: 'icon:Repeat', containerName: 'Morning' },
  ];
  const icons = iconInputs.map((c) => ({ ...c, expected: resolveCategoryIconName(c.glyph, c.containerName) }));

  // hashName over the strings categoryIconName hands it (already trimmed and
  // folded), and the index it picks. 'evadgrga' reaches -2^31, whose
  // Math.abs is 2^31, past int32: the case a Swift Int32 abs traps on.
  const hashInputs = ['', 'a', 'errands', 'café', 'cafe\u0301', '🏃 club', '日本語', 'evadgrga', 'a much longer name for a project'];
  const hash = hashInputs.map((input, i) => {
    const h = hashName(input);
    return { name: `${i}: ${JSON.stringify(input)}`, input, hash: h, index: h % CATEGORY_ICON_NAMES.length };
  });

  // A project's time block in one line (lib/project-block.ts), the project
  // page's fact (O3). `when` is blockWhen's answer whether or not a block shows.
  const blockAsks: { name: string; over: Partial<Project> }[] = [
    { name: 'weekdays, an hour', over: { startTime: '18:00', timeBucket: 'evening', repeatFrequency: 'weekdays', duration: 60 } },
    { name: 'every day, with minutes', over: { startTime: '06:30', timeBucket: 'morning', repeatFrequency: 'daily', duration: 45 } },
    { name: 'past midnight wraps', over: { startTime: '23:00', timeBucket: 'evening', repeatFrequency: 'weekends', duration: 120 } },
    { name: 'noon and midnight read 12', over: { startTime: '12:00', timeBucket: 'afternoon', repeatFrequency: 'monthly', duration: 720 } },
    { name: 'no duration is an hour', over: { startTime: '09:00', timeBucket: 'morning', repeatFrequency: 'custom', repeatDays: [1, 3] } },
    { name: 'a zero duration stays zero', over: { startTime: '09:00', timeBucket: 'morning', repeatFrequency: 'daily', duration: 0 } },
    {
      name: 'a legacy repeat is shown as stored',
      over: { startTime: '09:00', timeBucket: 'morning', repeatFrequency: 'weekly' as Project['repeatFrequency'], duration: 60 },
    },
    { name: 'none is still a repeat to the rule', over: { startTime: '09:00', timeBucket: 'morning', repeatFrequency: 'none', duration: 60 } },
    { name: 'a start with seconds', over: { startTime: '07:05:00', timeBucket: 'morning', repeatFrequency: 'daily', duration: 60 } },
    { name: 'an unreadable start reads as midnight', over: { startTime: 'noon', timeBucket: 'morning', repeatFrequency: 'daily', duration: 60 } },
    { name: 'no repeat: no block', over: { startTime: '09:00', timeBucket: 'morning', duration: 60 } },
    { name: 'no part of day: no block', over: { startTime: '09:00', repeatFrequency: 'daily', duration: 60 } },
    { name: 'no start: no block', over: { timeBucket: 'morning', repeatFrequency: 'daily', duration: 60 } },
    { name: 'nothing set', over: {} },
  ];
  const blocks = blockAsks.map((c) => {
    const p = project('p-block', 'Block', c.over);
    return { name: c.name, project: p, expected: { hasTimeBlock: hasTimeBlock(p), when: blockWhen(p), summary: timeBlockSummary(p) ?? null } };
  });

  const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    tokens,
    accentForName,
    projectColor,
    colors,
    icons,
    hash,
    blocks,
    tables: {
      // ACCENT_RAMP's tokens, in step order, and their picker names.
      ramp: [...ACCENT_RAMP],
      swatches: [...ACCENT_NAMES],
      library: ALL_ICON_ENTRIES.map(([n]) => n).sort(byCodeUnit),
      featured: [...FEATURED_ICON_NAMES],
      categoryIcons: [...CATEGORY_ICON_NAMES],
      nameIcons: Object.entries(NAME_ICON_NAMES).map(([key, icon]) => ({ key, icon })),
      keywordIcons: KEYWORD_ICON_NAMES.map(([keywords, icon]) => ({ keywords: [...keywords], icon })),
    },
  };
}

// ── copy.json: Organize's words (lib/organize-copy.ts) ─────────────────────

/*
 * The routine's held note needs a world: `hiddenHere` is its members in
 * inactiveItemIdsOn for today, asked with routines and seasons and no trips,
 * as the routine pane asks it. Each case brings its routines and seasons.
 */
const HELD_ITEMS: Item[] = [
  habit(1, 'Water'),
  // Also in a live routine of its own: hidden by neither.
  habit(2, 'Stretch'),
  // Done today, so not an open loop, so not hidden.
  habit(3, 'Done today', { completedDates: [TODAY] }),
  task(4, 'Undated', { isScheduled: false }),
];

function buildCopy() {
  const desk = routine('r-desk', 'Desk', { itemIds: [uid(2)] });
  const morning = (over: Partial<Routine> = {}) =>
    routine('r-morning', 'Morning', { itemIds: [uid(1), uid(2), uid(3), uid(4)], ...over });
  const holding = (s: Season) => ({ ...s, routineIds: ['r-morning'] });
  const heldAsks: { name: string; routines: Routine[]; seasons: Season[] }[] = [
    { name: 'live and standalone: no note', routines: [morning(), desk], seasons: [] },
    {
      name: 'its own pause: the paused note says it, not this',
      routines: [morning({ pausedAt: '2026-10-20T13:00:00Z' }), desk],
      seasons: [holding(OFF_LATER)],
    },
    { name: 'one off season with a return day', routines: [morning(), desk], seasons: [holding(OFF_LATER)] },
    { name: 'one switched-off season: no return day', routines: [morning(), desk], seasons: [holding(OFF_PAUSED)] },
    { name: 'one ended season: no return day', routines: [morning(), desk], seasons: [holding(OFF_ENDED)] },
    {
      name: 'two off seasons: the sooner return',
      routines: [morning(), desk],
      seasons: [holding(OFF_LATER_STILL), holding(OFF_LATER)],
    },
    { name: 'one on, one off: no note', routines: [morning(), desk], seasons: [holding(OFF_PAUSED), holding(ON_RANGE)] },
    {
      name: 'one item hidden',
      routines: [morning({ itemIds: [uid(1), uid(2)] }), desk],
      seasons: [holding(OFF_LATER)],
    },
    {
      name: 'every member is on the day another way',
      routines: [morning({ itemIds: [uid(2), uid(3)] }), desk],
      seasons: [holding(OFF_LATER)],
    },
  ];
  const routineHeldNoteCases = heldAsks.map((c) => {
    const r = c.routines.find((x) => x.id === 'r-morning')!;
    const standing = routineStandingOn(r, c.seasons, TODAY, ZONE);
    const hidden = inactiveItemIdsOn(HELD_ITEMS, TODAY, { userTimezone: ZONE, routines: c.routines, seasons: c.seasons });
    const hiddenHere = r.itemIds.filter((id) => hidden.has(id)).length;
    return {
      ...c,
      routineId: r.id,
      today: TODAY,
      timeZone: ZONE,
      expected: { hiddenHere, note: routineHeldNote(standing, hiddenHere, TODAY) },
    };
  });

  const pausedAsks: { name: string; routine: Routine }[] = [
    { name: 'no return day', routine: routine('r', 'R', { pausedAt: '2026-10-20T13:00:00Z' }) },
    { name: 'back on a day', routine: routine('r', 'R', { pausedAt: '2026-10-20T13:00:00Z', pausedUntil: '2026-10-30' }) },
    { name: 'back next year', routine: routine('r', 'R', { pausedAt: '2026-10-20T13:00:00Z', pausedUntil: '2027-01-04' }) },
  ];
  const routinePausedNoteCases = pausedAsks.map((c) => ({ ...c, expected: routinePausedNote(c.routine) }));

  const heldByAsks: { name: string; season: Season }[] = [
    { name: 'on its dates', season: ON_RANGE },
    { name: 'pinned on', season: ON_PINNED },
    { name: 'switched off', season: OFF_PAUSED },
    { name: 'starts later', season: OFF_LATER },
    { name: 'ended', season: OFF_ENDED },
    { name: 'switched off with a later start still names it', season: { ...OFF_LATER, state: 'paused' } },
    { name: 'an inverted range ahead still names its start', season: OFF_INVERTED },
    { name: 'starts next year', season: season('s-next', 'Next', 'auto', { startsOn: '2027-01-05' }) },
  ];
  const heldByStateCases = heldByAsks.map((c) => ({ ...c, today: TODAY, expected: heldByState(c.season, TODAY) }));

  const summaryAsks = [
    { name: 'nothing on', done: 0, total: 0, skipped: 0 },
    { name: 'part way', done: 2, total: 3, skipped: 0 },
    { name: 'with a skip', done: 2, total: 3, skipped: 1 },
    { name: 'only a skip', done: 0, total: 1, skipped: 1 },
    { name: 'all done', done: 12, total: 12, skipped: 0 },
  ];
  const routineTodaySummaryCases = summaryAsks.map((c) => ({ ...c, expected: routineTodaySummary(c.done, c.total, c.skipped) }));

  const emptyAsks = [
    { name: 'no members', routineName: 'Morning', memberCount: 0 },
    { name: 'members, none on today', routineName: 'Morning', memberCount: 3 },
    { name: 'a name with an emoji', routineName: '🌙 Wind down', memberCount: 1 },
  ];
  const routineTodayEmptyCases = emptyAsks.map((c) => ({ ...c, expected: routineTodayEmpty(c.routineName, c.memberCount) }));

  const noteAsks: { name: string; season: Season }[] = [
    { name: 'pinned on', season: ON_PINNED },
    { name: 'switched off', season: OFF_PAUSED },
    { name: 'dates, none set', season: season('s-open', 'Open', 'auto') },
    { name: 'dates, on now', season: ON_RANGE },
    { name: 'dates, starts later', season: OFF_LATER },
    { name: 'dates, ended', season: OFF_ENDED },
    { name: 'dates, a start alone, on', season: season('s-from', 'From', 'auto', { startsOn: '2026-10-01' }) },
    { name: 'dates, a start alone, later', season: OFF_LATER_SAME_DAY },
    { name: 'dates, an end alone, on', season: season('s-until', 'Until', 'auto', { endsOn: '2026-12-01' }) },
    { name: 'dates, an end alone, over', season: season('s-gone', 'Gone', 'auto', { endsOn: '2026-10-22' }) },
    { name: 'dates, inverted', season: OFF_INVERTED },
  ];
  const seasonStateNoteCases = noteAsks.map((c) => {
    const live = isSeasonActiveOn(c.season, TODAY);
    return { ...c, today: TODAY, live, expected: seasonStateNote(c.season, live) };
  });

  const runsAsks: { name: string; startsOn?: string; endsOn?: string }[] = [
    { name: 'both', startsOn: '2026-10-01', endsOn: '2027-03-15' },
    { name: 'a start alone', startsOn: '2026-10-01' },
    { name: 'an end alone', endsOn: '2027-03-15' },
    { name: 'neither' },
  ];
  const seasonRunsLabelCases = runsAsks.map((c) => ({
    name: c.name,
    startsOn: c.startsOn ?? null,
    endsOn: c.endsOn ?? null,
    expected: seasonRunsLabel(c.startsOn, c.endsOn),
  }));

  const endedAsks: { name: string; goal: Goal }[] = [
    { name: 'active: no note', goal: goal('g', 'G') },
    { name: 'achieved, with its day', goal: goal('g', 'G', { state: 'achieved', achievedAt: '2026-10-01T18:00:00.123456+00:00' }) },
    // The stamp's own date, as the page reads it: 01:00 UTC is Oct 1 in New York.
    { name: 'achieved, the stamp’s UTC day', goal: goal('g', 'G', { state: 'achieved', achievedAt: '2026-10-02T01:00:00Z' }) },
    { name: 'achieved, no stamp', goal: goal('g', 'G', { state: 'achieved' }) },
    { name: 'set aside', goal: goal('g', 'G', { state: 'abandoned' }) },
    { name: 'set aside after it was achieved', goal: goal('g', 'G', { state: 'abandoned', achievedAt: '2026-09-01T12:00:00Z' }) },
  ];
  const goalEndedNoteCases = endedAsks.map((c) => ({ ...c, expected: goalEndedNote(c.goal) }));

  const windAsks: { name: string; state: Goal['state']; count: number }[] = [
    { name: 'achieved, none', state: 'achieved', count: 0 },
    { name: 'achieved, one', state: 'achieved', count: 1 },
    { name: 'achieved, three', state: 'achieved', count: 3 },
    { name: 'set aside, one', state: 'abandoned', count: 1 },
    { name: 'set aside, two', state: 'abandoned', count: 2 },
    { name: 'active, one: nothing to wind down', state: 'active', count: 1 },
  ];
  const windDownSentenceCases = windAsks.map((c) => ({ ...c, expected: windDownSentence({ state: c.state }, c.count) }));

  const checkinAsks: Item[] = [
    habit(1, 'A weekly review', { repeatFrequency: 'custom', repeatDays: [0], completedDates: ['2026-10-04', '2026-10-18', '2026-10-11'] }),
    habit(2, 'A first review', { repeatFrequency: 'custom', repeatDays: [0] }),
    habit(3, 'A daily line', { completedDates: ['2026-10-22'] }),
    task(4, 'A monthly money check', {
      startDate: '2026-10-01',
      repeatFrequency: 'monthly',
      repeatMonthDay: 1,
      completedDates: ['2026-10-01'],
    }),
    task(5, 'Two days a week', { startDate: '2026-10-05', repeatFrequency: 'custom', repeatDays: [3, 1], completedDates: ['2027-01-04'] }),
  ];
  const checkinMetaCases = checkinAsks.map((item) => {
    const cadence = cadenceLabel(item as never);
    const lastDone = lastDoneOn(item) ?? null;
    return { name: item.title, item, cadence, lastDone, expected: checkinMeta(cadence, lastDone ?? undefined) };
  });

  const milestoneTickLabelCases = [
    { name: 'not reached yet', title: 'Run a 10K', reached: false },
    { name: 'reached', title: 'Run a 10K', reached: true },
  ].map((c) => ({ ...c, expected: milestoneTickLabel(c.title, c.reached) }));

  const switchedOffCases = [
    { name: 'organize', ...ORGANIZE_OFF, sentence: switchedOffSentence(ORGANIZE_OFF) },
    { name: 'goals', ...GOALS_OFF, sentence: switchedOffSentence(GOALS_OFF) },
  ];

  return {
    tables: {
      stateLabels: { routine: ROUTINE_STATE_LABELS, season: SEASON_STATE_LABELS, goal: GOAL_STATE_LABELS },
      nothingInItYet: NOTHING_IN_IT_YET,
      heldByNone: HELD_BY_NONE,
      routineTodayFinished: ROUTINE_TODAY_FINISHED,
      routineTodayNext: ROUTINE_TODAY_NEXT,
      noCheckinYet: NO_CHECKIN_YET,
      noMilestonesYet: NO_MILESTONES_YET,
      noSupportingWork: NO_SUPPORTING_WORK,
    },
    heldWorld: { items: HELD_ITEMS },
    switchedOff: switchedOffCases,
    routinePausedNote: routinePausedNoteCases,
    routineHeldNote: routineHeldNoteCases,
    heldByState: heldByStateCases,
    routineTodaySummary: routineTodaySummaryCases,
    routineTodayEmpty: routineTodayEmptyCases,
    seasonStateNote: seasonStateNoteCases,
    seasonRunsLabel: seasonRunsLabelCases,
    goalEndedNote: goalEndedNoteCases,
    windDownSentence: windDownSentenceCases,
    checkinMeta: checkinMetaCases,
    milestoneTickLabel: milestoneTickLabelCases,
  };
}

// ── Writing and checking ─────────────────────────────────────────────────────

const FIXTURES: Record<string, () => unknown> = {
  labels: buildLabels,
  standing: buildStanding,
  goals: buildGoals,
  schedule: buildSchedule,
  look: buildLook,
  copy: buildCopy,
};

const serialize = (f: unknown) => JSON.stringify(f, null, 2) + '\n';

describe('organize fixtures shared with DsulCore', () => {
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
      // Every top-level array is a list of named cases; `world` and `tables`
      // are the shared inputs, not cases.
      const lists = Object.values(value as Record<string, unknown>).filter((v): v is { name: string }[] =>
        Array.isArray(v)
      );
      expect(lists.length).toBeGreaterThan(0);
      for (const list of lists) {
        expect(list.length).toBeGreaterThan(0);
        const names = list.map((c) => c.name);
        expect(names.every((n) => typeof n === 'string' && n.length > 0)).toBe(true);
        expect(new Set(names).size).toBe(names.length);
      }
    });

    it(`${name}.json is what the TS answers today`, () => {
      // On drift: if the TS change is intended, regenerate with UPDATE_FIXTURES=1
      // and make the same change in ios/DsulCore/Sources/DsulCore/.
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(serialize(value)));
    });
  }
});

describe('the cases say what they claim', () => {
  // Guards on the inputs: a case that no longer exercises its edge would
  // still regenerate green, so the edges are asserted here.

  it('the pills cover every wording', () => {
    const { routinePillLabel: routines, seasonPillLabel: seasons } = buildLabels();
    // Each answer with its date replaced, so the set is the wordings.
    const shape = (w: string | null) => (w === null ? 'none' : w.replace(/[A-Z][a-z]{2} \d{1,2}$/, 'DATE'));
    const words = new Set([...routines, ...seasons].map((c) => shape(c.expected)));
    expect([...words].sort()).toEqual(['Ended', 'From DATE', 'Held', 'Held · DATE', 'Paused', 'Until DATE', 'none']);
    // Fixed English months, whatever the machine's locale.
    expect(routines.find((c) => c.name === 'paused until next year')?.expected).toBe('Until Jan 4');
    // The time zone decides the day a pause starts.
    const ny = routines.find((c) => c.name === 'paused late today, in New York')?.expected;
    const tokyo = routines.find((c) => c.name === 'paused late today, read in Tokyo: not yet')?.expected;
    expect([ny, tokyo]).toEqual(['Paused', null]);
  });

  it('standing ranks with a stable sort and puts no return last', () => {
    const cases = buildStanding().routineStandingOn;
    const pick = (n: string) => cases.find((c) => c.name === n)!.expected;
    expect(pick('three off: ranked by return, no return last').soonestBlockerId).toBe(OFF_LATER.id);
    expect(pick('two with the same return: the first holder').soonestBlockerId).toBe(OFF_LATER_SAME_DAY.id);
    expect(pick('two with no return: the first holder').soonestBlockerId).toBe(OFF_ENDED.id);
  });

  it('progress leaves dropped and trashed checkpoints out, and words a full fraction by state', () => {
    const cases = buildGoals().goalProgress;
    const pick = (n: string) => cases.find((c) => c.name === n)!.expected;
    expect(pick('A dropped checkpoint leaves both sides')).toMatchObject({ achieved: 1, total: 2 });
    expect(pick('A trashed checkpoint leaves both sides')).toMatchObject({ achieved: 1, total: 1, label: '1/1 so far' });
    expect(pick('Only dropped and trashed')).toMatchObject({ total: 0, fraction: null, label: 'No milestones yet' });
    expect(pick('All reached, achieved').label).toBe('2/2');
  });

  it('a project’s members fold case and never trim, and its list drops subtasks', () => {
    const cases = buildSchedule().containerMemberIds;
    const work = cases.find((c) => c.name === 'a project, by folded name')!;
    expect(work.expected).toEqual([uid(1), uid(2), uid(3), uid(5), uid(8), uid(9)]);
    expect(work.listed).toEqual([uid(1), uid(2), uid(3), uid(8), uid(9)]);
  });

  it('the look reads every token from both themes, in gamut, and the hash reaches -2^31', () => {
    const look = buildLook();
    expect(look.tokens).toHaveLength(TOKENS.length);
    for (const t of look.tokens) {
      for (const theme of [t.light, t.dark]) {
        expect(theme.hex).toMatch(/^#[0-9a-f]{6}$/);
        // Unclamped, still in [0, 1]: the clamp in the reference changes nothing.
        const raw = oklchToSrgbUnclamped(theme.l, theme.c, theme.h);
        for (const x of raw) expect(x >= 0 && x <= 1, `${t.name} ${x}`).toBe(true);
      }
    }
    // Every legacy project token is some case's answer, so the hand-copied
    // map in DsulCore is pinned entry by entry.
    const reached = new Set(look.projectColor.map((c) => c.expected));
    for (const token of Object.values(LEGACY_PROJECT_TOKENS)) expect(reached.has(token), token).toBe(true);
    expect(look.hash.find((c) => c.input === 'evadgrga')?.hash).toBe(2 ** 31);
    expect(look.icons.find((c) => c.containerName === 'evadgrga')?.expected).toBe(
      CATEGORY_ICON_NAMES[2 ** 31 % CATEGORY_ICON_NAMES.length],
    );
  });

  it('a member added today changes no past cell: done and skips stay, only the unrecorded grows', () => {
    const cases = buildSchedule().deriveContainerSchedule;
    const before = cases.find((c) => c.name === 'a routine, in its own order')!.expected.rollup;
    const after = cases.find((c) => c.name === 'the same routine with a member added today: no past cell changes')!
      .expected.rollup;
    // The strip's past cell (design §2 Q7): lime with anything done, an outline
    // with a skip, a wash with only unrecorded days, an outline with nothing on.
    // A skip outranks the unrecorded, or a day with one would turn to a wash.
    const cell = (d: (typeof before)[number]) =>
      d.done > 0 ? 'done' : d.skipped > 0 ? 'skipped' : d.open > 0 ? 'nothing recorded' : 'nothing on';
    const past = (r: typeof before) => r.filter((d) => d.date < TODAY);
    expect(past(after).map((d) => d.date)).toEqual(past(before).map((d) => d.date));
    expect(past(before).length).toBeGreaterThan(0);
    past(before).forEach((d, i) => {
      const a = past(after)[i];
      expect({ done: a.done, skipped: a.skipped, due: a.due }).toEqual({ done: d.done, skipped: d.skipped, due: d.due });
      expect(a.open).toBeGreaterThanOrEqual(d.open);
      expect(cell(a), d.date).toBe(cell(d));
    });
    // The edge is exercised: a past day with a skip, and one with only the unrecorded.
    expect(past(before).some((d) => d.skipped > 0 && d.done === 0)).toBe(true);
    expect(past(before).some((d) => d.open > 0 && d.done === 0 && d.skipped === 0)).toBe(true);
    // Nothing on a past day is ever due: due is today's alone.
    for (const c of cases) for (const d of past(c.expected.rollup)) expect(d.due, `${c.name} ${d.date}`).toBe(0);
  });

  it('suppression names every kind, and the binding constraint is the latest return', () => {
    const cases = buildStanding().suppressionReason;
    const kinds = new Set(cases.map((c) => c.expected?.kind ?? 'none'));
    expect([...kinds].sort()).toEqual(['away', 'none', 'paused', 'routine', 'season']);
    const pick = (n: string) => cases.find((c) => c.name === n)!.expected;
    expect(pick('blocked twice: the routine comes back last, so it is named')?.kind).toBe('routine');
    expect(pick('blocked twice: the season comes back last, so it is named')?.kind).toBe('season');
    expect(pick('blocked twice: a routine with no return is named, with no date')?.until).toBeNull();
    expect(pick('one live path is enough')).toBeNull();
    // The time zone decides the day.
    expect([pick('paused late tonight, in New York')?.kind, pick('paused late tonight, read in Tokyo: not yet')]).toEqual([
      'paused',
      null,
    ]);
  });

  it('the timeline reaches every state and note, and the countdown its three forms', () => {
    const goals = buildGoals();
    const rows = goals.milestoneTimeline.flatMap((c) => c.expected);
    expect([...new Set(rows.map((r) => r.state))].sort()).toEqual(['achieved', 'ahead', 'dropped', 'next', 'overdue']);
    expect([...new Set(rows.flatMap((r) => r.annotations))].sort()).toEqual([
      'dropped',
      'next up',
      'reached',
      'still ahead of you',
    ]);
    expect(rows.some((r) => r.dateLabel === 'No date yet')).toBe(true);
    expect(rows.some((r) => r.late)).toBe(true);
    const forms = new Set(
      goals.goalCountdown.map((c) =>
        c.expected === null ? 'none' : c.expected.replace(/^\d+ days? (to|past) .*$/, (_, w: string) => w),
      ),
    );
    expect([...forms].sort()).toEqual(['none', 'past', 'target is today', 'to']);
  });

  it('the shared words hold the copy rules: no em dash, nothing "missed"', () => {
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(buildCopy());
    expect(strings.length).toBeGreaterThan(50);
    for (const s of strings) {
      expect(s.includes('—'), s).toBe(false);
      expect(/missed/i.test(s), s).toBe(false);
    }
  });
});

/** The reference without its clamp, for the gamut check above. */
function oklchToSrgbUnclamped(l: number, c: number, h: number): number[] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ].map(gamma);
}
