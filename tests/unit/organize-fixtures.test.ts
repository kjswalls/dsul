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
  addDaysStr,
  containerMemberIds,
  dayRollup,
  deriveContainerSchedule,
  occurrencesByItem,
  todayCount,
  todayInOrder,
  weekTotals,
  type ScheduleContainer,
  type WeekStartDay,
} from '@/lib/container-schedule';
import { nextMilestoneAcross, organizeWeek } from '@/lib/organize';
import {
  NOTHING_PAUSED,
  PAUSED_NO_DATE,
  PAUSED_WELCOME,
  backOn,
  entryKindLine,
  pausedDayLabel,
  pausedEntryName,
  pausedNote,
  pausedShelf,
  pausedStateLine,
  returnDayLabel,
} from '@/lib/paused-shelf';
import { blockWhen, hasTimeBlock, timeBlockSummary } from '@/lib/project-block';
import { seasonStateForSwitch } from '@/lib/scope-rail';
import { toDateStr } from '@/lib/recurrence';
import {
  CONTAINER_WRITE_SCHEMAS,
  containerIntentPatch,
  type ContainerIntentTarget,
  type OrganizeKind,
} from '@/lib/app-containers';
import {
  GOALS_OFF,
  GOAL_STATE_LABELS,
  HELD_BY_NONE,
  NOTHING_IN_IT_YET,
  NO_CHECKIN_YET,
  NO_MILESTONES_YET,
  NO_SUPPORTING_WORK,
  NOTHING_IN_TRASH,
  NOTHING_ON_THIS_WEEK,
  ORGANIZE_OFF,
  PAUSE_REFUSED,
  RESTORE_FAILED,
  RESTORE_GONE,
  ROUTINE_STATE_LABELS,
  ROUTINE_TODAY_FINISHED,
  ROUTINE_TODAY_NEXT,
  SEASON_STATE_LABELS,
  TRASH_KIND_LABELS,
  TRASH_LOAD_FAILED,
  TRASH_TEACHING,
  TRASH_WINDOW_DAYS,
  checkinMeta,
  containerRefusal,
  daysUntilPurge,
  goalEndedNote,
  heldByState,
  milestoneTickLabel,
  nameInTrashSentence,
  nameTakenSentence,
  nextMilestoneLine,
  restoreRefusal,
  restoreSentence,
  routineHeldNote,
  routinePausedNote,
  routineTodayEmpty,
  routineTodaySummary,
  seasonRunsLabel,
  seasonStateNote,
  switchedOffSentence,
  trashKindLine,
  trashRowMeta,
  weekCardSentence,
  whenGone,
  windDownSentence,
} from '@/lib/organize-copy';
import { cadenceLabel } from '@/lib/cadence';
import { getCustomTypeDefs, getItemTypeConfig, hydrateCustomTypes } from '@/lib/item-registry';
import { projectItems } from '@/lib/planner-store';
import type { AwayPeriod } from '@/lib/away';
import type { TrashKind } from '@/lib/db';
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
import type { Goal, HabitItem, Item, ItemTypeDef, Project, Routine, Season, Task } from '@/lib/planner-types';

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
 * in copy.json, the Trash's words included). The summary cards add the week's
 * count and the next milestone across goals (lib/organize.ts, organize.json),
 * and the Paused page what is set aside, grouped by the day it comes back
 * (lib/paused-shelf.ts, paused.json). The writes add what a binary switch
 * stores for a season (lib/scope-rail.ts seasonStateForSwitch, in
 * standing.json), and what each field intent the container route takes does
 * to a container (lib/app-containers.ts containerIntentPatch,
 * container-writes.json, which app-containers.test.ts also runs through the
 * route), with the phone's words for a refused one in copy.json. Every case
 * is built here, run through the real TS, and written with its answer to
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

  // The state a binary switch writes (lib/scope-rail.ts): Paused's "Turn on
  // now" on the phone, setGateOn on the web. Dates that already agree with the
  // switch give `auto`, so the season keeps following them; otherwise the
  // manual state. Never the Status menu's rule, which sends what was picked.
  const switchAsks: { name: string; season: Season; on: boolean; date: string }[] = [
    { name: 'on, dates cover today: auto, still dated', season: ON_RANGE, on: true, date: TODAY },
    { name: 'off, dates cover today: paused', season: ON_RANGE, on: false, date: TODAY },
    { name: 'on, starts later: active', season: OFF_LATER, on: true, date: TODAY },
    { name: 'off, starts later: auto, the dates already say off', season: OFF_LATER, on: false, date: TODAY },
    { name: 'on, ended: active', season: OFF_ENDED, on: true, date: TODAY },
    { name: 'off, ended: auto', season: OFF_ENDED, on: false, date: TODAY },
    { name: 'on, inverted range: active', season: OFF_INVERTED, on: true, date: TODAY },
    { name: 'off, inverted range: auto', season: OFF_INVERTED, on: false, date: TODAY },
    { name: 'on, switched off with dates covering today: auto', season: { ...ON_RANGE, state: 'paused' }, on: true, date: TODAY },
    { name: 'on, switched off with a later start: active', season: { ...OFF_LATER, state: 'paused' }, on: true, date: TODAY },
    { name: 'on, switched off with no dates: auto', season: OFF_PAUSED, on: true, date: TODAY },
    { name: 'off, pinned on with no dates: paused', season: season('s-pin', 'Pin', 'active'), on: false, date: TODAY },
    { name: 'off, pinned on with a later start: auto', season: ON_PINNED, on: false, date: TODAY },
    { name: 'on, its first day: auto', season: OFF_LATER, on: true, date: '2026-11-01' },
    { name: 'on, its last day: auto', season: ON_RANGE, on: true, date: '2026-11-30' },
    { name: 'on, the day after its last: active', season: ON_RANGE, on: true, date: '2026-12-01' },
  ];
  const seasonStateForSwitchCases = switchAsks.map((c) => ({
    ...c,
    expected: seasonStateForSwitch(c.season, c.on, c.date),
  }));

  return {
    routineStandingOn: routineStandingOnCases,
    seasonResumeDate: seasonResumeDateCases,
    seasonStateForSwitch: seasonStateForSwitchCases,
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

  // The Trash (O14). Every age is asked at one fixed instant, never the clock.
  const NOW = '2026-10-23T12:00:00Z';
  const now = Date.parse(NOW);
  const ages: { name: string; deletedAt: string }[] = [
    { name: 'thirty seconds ago', deletedAt: '2026-10-23T11:59:30Z' },
    { name: 'under an hour, as Postgres writes it', deletedAt: '2026-10-23T11:01:00.123456+00:00' },
    { name: 'an hour', deletedAt: '2026-10-23T11:00:00Z' },
    { name: 'another offset: three hours', deletedAt: '2026-10-23T05:00:00-04:00' },
    { name: 'twenty-three hours', deletedAt: '2026-10-22T13:00:00Z' },
    { name: 'twenty-five hours: one day, rounded down', deletedAt: '2026-10-22T11:00:00Z' },
    { name: 'three days, as Postgres writes it', deletedAt: '2026-10-20T09:00:00.123456+00:00' },
    { name: 'twenty-nine days', deletedAt: '2026-09-24T11:00:00Z' },
    { name: 'past the window', deletedAt: '2026-09-22T12:00:00Z' },
    { name: 'a stamp in the future', deletedAt: '2026-10-23T13:00:00Z' },
    { name: 'not a stamp', deletedAt: 'not a date' },
  ];
  const whenGoneCases = ages.map((c) => ({ ...c, now: NOW, expected: whenGone(c.deletedAt, now) }));
  const daysUntilPurgeCases = ages.map((c) => ({ ...c, now: NOW, expected: daysUntilPurge(c.deletedAt, now) }));

  const metaAsks: { name: string; kind: TrashKind; childCount: number; memberCount: number; deletedAt: string }[] = [
    { name: 'an item alone', kind: 'item', childCount: 0, memberCount: 0, deletedAt: '2026-10-20T09:00:00.123456+00:00' },
    { name: 'an item with a subtask', kind: 'item', childCount: 1, memberCount: 0, deletedAt: '2026-10-23T10:00:00Z' },
    { name: 'an item with two subtasks', kind: 'item', childCount: 2, memberCount: 0, deletedAt: '2026-10-23T10:00:00Z' },
    { name: 'a project with nothing filed', kind: 'project', childCount: 0, memberCount: 0, deletedAt: '2026-10-23T11:59:30Z' },
    { name: 'a project with one item', kind: 'project', childCount: 0, memberCount: 1, deletedAt: '2026-10-20T09:00:00Z' },
    { name: 'a project with three items', kind: 'project', childCount: 0, memberCount: 3, deletedAt: '2026-10-20T09:00:00Z' },
    { name: 'a routine', kind: 'routine', childCount: 0, memberCount: 0, deletedAt: '2026-10-21T12:00:00Z' },
    { name: 'a season', kind: 'season', childCount: 0, memberCount: 0, deletedAt: '2026-10-08T12:00:00Z' },
    { name: 'a goal with three to reconnect', kind: 'goal', childCount: 0, memberCount: 3, deletedAt: '2026-10-17T09:00:00Z' },
  ];
  const trashRowMetaCases = metaAsks.map((c) => ({
    ...c,
    now: NOW,
    expected: { kindLine: trashKindLine(c.kind, c.childCount, c.memberCount), meta: trashRowMeta(c, now) },
  }));

  const restoreAsks: { name: string; kind: Exclude<TrashKind, 'item'>; memberCount: number }[] = [
    { name: 'a project with nothing filed', kind: 'project', memberCount: 0 },
    { name: 'a project with one item', kind: 'project', memberCount: 1 },
    { name: 'a project with three items', kind: 'project', memberCount: 3 },
    { name: 'a routine', kind: 'routine', memberCount: 0 },
    { name: 'a season', kind: 'season', memberCount: 0 },
    { name: 'a goal', kind: 'goal', memberCount: 3 },
  ];
  const restoreSentenceCases = restoreAsks.map((c) => ({ ...c, expected: restoreSentence(c.kind, c.memberCount) }));

  const refusalAsks: { name: string; code: string | null; projectName: string }[] = [
    { name: 'a live project has the name', code: 'name_taken', projectName: 'work' },
    { name: 'its parent is in the bin', code: 'parent_gone', projectName: '' },
    { name: 'gone from the bin', code: 'not_found', projectName: '' },
    { name: 'a code the phone has no words for', code: 'invalid', projectName: '' },
    { name: 'no answer at all', code: null, projectName: '' },
  ];
  const restoreRefusalCases = refusalAsks.map((c) => ({ ...c, expected: restoreRefusal(c.code ?? undefined, c.projectName) }));

  // A container write's refusal (POST /api/app/containers/:kind/:id, from
  // O8a): words for the codes that have them, null where the phone says what
  // it says for any failed write. `sentName` is the name the phone sent in
  // its rename (O9), which the two name refusals say; null for a write that
  // sent none, where they have no words.
  const containerRefusalCases = [
    { name: 'a pause until a day no longer after today', code: 'pause_refused', sentName: null },
    { name: 'gone, or never the caller’s', code: 'not_found', sentName: null },
    { name: 'a body the route refuses', code: 'invalid', sentName: null },
    { name: 'no answer at all', code: null, sentName: null },
    { name: 'a rename onto a live project’s name', code: 'name_taken', sentName: 'House' },
    { name: 'a rename onto a live project’s name in another case', code: 'name_taken', sentName: 'work' },
    { name: 'a rename onto a name the Trash still holds', code: 'name_in_trash', sentName: 'Errands' },
    { name: 'a rename refused for another reason', code: 'not_found', sentName: 'House' },
    { name: 'a pause refused, whatever name was sent', code: 'pause_refused', sentName: 'House' },
    { name: 'a name refusal with no name sent', code: 'name_taken', sentName: null },
  ].map((c) => ({ ...c, expected: containerRefusal(c.code ?? undefined, c.sentName ?? undefined) }));

  const nameInTrashCases = [
    { name: 'a project', noun: 'project', heldName: 'Admin' },
    { name: 'a routine', noun: 'routine', heldName: 'Morning' },
  ].map((c) => ({ ...c, expected: nameInTrashSentence(c.noun, c.heldName) }));

  // A name a live sibling already has (O9's rename; labels.tsx takenBy says
  // it inline on the web).
  const nameTakenCases = [
    { name: 'a project', noun: 'project', heldName: 'Work' },
    { name: 'a name with quotes in it', noun: 'project', heldName: 'Mum’s “stuff”' },
  ].map((c) => ({ ...c, expected: nameTakenSentence(c.noun, c.heldName) }));

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
      trashWindowDays: TRASH_WINDOW_DAYS,
      trashKindLabels: TRASH_KIND_LABELS,
      nothingInTrash: NOTHING_IN_TRASH,
      trashTeaching: TRASH_TEACHING,
      trashLoadFailed: TRASH_LOAD_FAILED,
      restoreFailed: RESTORE_FAILED,
      restoreGone: RESTORE_GONE,
      pauseRefused: PAUSE_REFUSED,
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
    whenGone: whenGoneCases,
    daysUntilPurge: daysUntilPurgeCases,
    trashRowMeta: trashRowMetaCases,
    restoreSentence: restoreSentenceCases,
    restoreRefusal: restoreRefusalCases,
    nameInTrashSentence: nameInTrashCases,
    nameTakenSentence: nameTakenCases,
    containerRefusal: containerRefusalCases,
  };
}

// ── organize.json: the summary cards (lib/organize.ts) ──────────────────────

/*
 * THIS WEEK, asked of one world in the three Week starts on settings, then
 * each edge on its own small world. TODAY is a Friday: a Sunday week runs
 * Oct 18 to 24, a Monday week Oct 19 to 25, and a Saturday week Oct 17 to 23,
 * so in that one today is the last day.
 */
const WEEK_ITEMS: Item[] = [
  habit(1, 'Stretch', {
    timeBucket: 'morning',
    completedDates: ['2026-10-17', '2026-10-19', '2026-10-20', TODAY],
    skippedDates: ['2026-10-21'],
  }),
  // Mon, Wed, Fri: Monday unrecorded, Wednesday done, today still due.
  habit(2, 'Meditate', { timeBucket: 'morning', repeatFrequency: 'custom', repeatDays: [1, 3, 5], completedDates: ['2026-10-21'] }),
  task(3, 'Call bank', { timeBucket: 'morning', startDate: '2026-10-20', status: 'completed' }),
  task(4, 'Send invoice', { timeBucket: 'afternoon', startDate: TODAY }),
  // Saturday: inside a Sunday or a Monday week, after a Saturday one.
  task(5, 'Water plants', { timeBucket: 'anytime', startDate: '2026-10-24' }),
  // Cancelled is a recorded decision: skipped, so on neither side.
  task(6, 'Return parcel', { timeBucket: 'morning', startDate: '2026-10-22', status: 'cancelled' }),
  task(7, 'Pick a gift', { isScheduled: false }),
  // A done subtask on a day: never on the grid, so never counted.
  task(8, 'Report appendix', { timeBucket: 'morning', startDate: '2026-10-22', status: 'completed', parentItemId: uid(3) }),
  // Paused from Tuesday: gone from every day of the week from then on.
  task(9, 'Paused errand', { timeBucket: 'evening', startDate: TODAY, pausedAt: '2026-10-20T13:00:00Z' }),
  // In a routine paused from Monday: gone, except a day it was done anyway.
  habit(10, 'Run', { timeBucket: 'evening', repeatFrequency: 'custom', repeatDays: [2, 4], completedDates: ['2026-10-20'] }),
  // An off season's own item: gone all week.
  task(11, 'Season errand', { timeBucket: 'morning', startDate: '2026-10-22' }),
  custom(12, 'book', 'Read Dune', { timeBucket: 'evening', startDate: '2026-10-19', status: 'completed' }),
  // Skipped today: today's one is on neither side.
  habit(13, 'Floss', { timeBucket: 'evening', skippedDates: [TODAY] }),
];

const WEEK_ROUTINES: Routine[] = [routine('r-evening', 'Evening', { itemIds: [uid(10)], pausedAt: '2026-10-19T12:00:00Z' })];

const WEEK_SEASONS: Season[] = [season('s-shelf', 'Shelf', 'paused', { itemIds: [uid(11)] })];

/**
 * A trip from today, back on Sunday: today and Saturday rest. Only a day still
 * ahead can change the count; a past day it rests was unrecorded or done.
 */
const WEEK_TRIP: AwayPeriod = {
  id: 't-weekend',
  startsOn: TODAY,
  endsOn: '2026-10-25',
  keep: { itemIds: [], routineIds: [], projectIds: [] },
  returns: {},
  fromTrip: {},
};

interface WeekAsk {
  name: string;
  items?: Item[];
  routines?: Routine[];
  seasons?: Season[];
  away?: AwayPeriod[];
  today?: string;
  weekStartDay: WeekStartDay;
}

function buildOrganize() {
  const without = (...ns: number[]) => WEEK_ITEMS.filter((i) => !ns.map(uid).includes(i.id));
  const resumed = WEEK_ITEMS.map((i) => (i.id === uid(9) ? ({ ...i, pausedAt: undefined } as Item) : i));
  const weekAsks: WeekAsk[] = [
    { name: 'a Sunday week: done of done-or-due, everything the grid shows', weekStartDay: 'sunday' },
    { name: 'a Monday week', weekStartDay: 'monday' },
    { name: 'a Saturday week: today is its last day', weekStartDay: 'saturday' },
    { name: 'the week’s first day: nothing is past yet', weekStartDay: 'monday', today: '2026-10-19' },
    { name: 'a Monday week asked on its Sunday', weekStartDay: 'monday', today: '2026-10-25' },
    { name: 'the same world with no subtask: the same answer', weekStartDay: 'sunday', items: without(8) },
    { name: 'the paused errand resumed: on the week', weekStartDay: 'sunday', items: resumed },
    { name: 'a trip rests what falls inside it, except what was done', weekStartDay: 'sunday', away: [WEEK_TRIP] },
    {
      name: 'nothing on this week: an undated task and one next month',
      weekStartDay: 'sunday',
      items: [task(7, 'Pick a gift', { isScheduled: false }), task(20, 'Next month', { timeBucket: 'morning', startDate: '2026-11-12' })],
    },
    {
      name: 'only a skip and an unrecorded past day: nothing counted',
      weekStartDay: 'monday',
      items: [
        habit(21, 'Mon and Tue', { timeBucket: 'morning', repeatFrequency: 'custom', repeatDays: [1, 2], skippedDates: ['2026-10-19'] }),
        task(6, 'Return parcel', { timeBucket: 'morning', startDate: '2026-10-22', status: 'cancelled' }),
      ],
    },
    {
      name: 'a finished one-off counts on its day',
      weekStartDay: 'sunday',
      items: [task(3, 'Call bank', { timeBucket: 'morning', startDate: '2026-10-20', status: 'completed' })],
    },
    { name: 'no items at all', weekStartDay: 'sunday', items: [] },
  ];

  const week = weekAsks.map((c) => {
    const items = c.items ?? WEEK_ITEMS;
    const routines = c.routines ?? WEEK_ROUTINES;
    const seasons = c.seasons ?? WEEK_SEASONS;
    const away = c.away ?? [];
    const today = c.today ?? TODAY;
    const { tasks, habits } = projectItems(items);
    const answer = organizeWeek(
      { items, tasks: tasks as Task[], habits: habits as HabitItem[], routines, seasons, away, timezone: ZONE },
      today,
      c.weekStartDay,
    );
    return {
      name: c.name,
      items,
      routines,
      seasons,
      away,
      today,
      timeZone: ZONE,
      weekStartDay: c.weekStartDay,
      expected: { ...answer, sentence: weekCardSentence(answer.done, answer.counted) },
    };
  });

  // NEXT MILESTONE: one item list, each case its own goals.
  const milestoneItems: Item[] = [
    task(1, 'Run a 10K', { startDate: '2026-10-30' }),
    task(2, 'Book the race', { startDate: '2026-10-26' }),
    task(3, 'Late checkpoint', { startDate: '2026-10-04' }),
    task(4, 'Undated checkpoint', { isScheduled: false }),
    task(5, 'Second undated', { isScheduled: false }),
    task(6, 'Reached', { startDate: '2026-10-10', status: 'completed' }),
    task(7, 'Dropped', { startDate: '2026-10-12', status: 'cancelled' }),
    task(8, 'Same day too', { startDate: '2026-10-26' }),
    // A legacy row whose day is a whole ISO stamp.
    task(9, 'Legacy stamp', { startDate: '2026-11-02T00:00:00Z' }),
    custom(10, 'book', 'Read the guide', { startDate: '2026-10-28', status: 'completed' }),
    // A habit's done word on a custom item: not this type's, so still open.
    custom(11, 'book', 'Read the notes', { startDate: '2026-10-27', status: 'done' }),
  ];
  const milestoneById = new Map(milestoneItems.map((i) => [i.id, i]));
  const g = (id: string, name: string, ms: number[], over: Partial<Goal> = {}) =>
    goal(id, name, { milestoneIds: ms.map(uid), ...over });
  const milestoneAsks: { name: string; goals: Goal[] }[] = [
    { name: 'the earliest dated across goals', goals: [g('g-run', 'Run a half marathon', [1]), g('g-race', 'Race day', [2])] },
    { name: 'a tie on the day: the goal listed first', goals: [g('g-first', 'Listed first', [8]), g('g-second', 'Listed second', [2])] },
    { name: 'a late milestone keeps its date', goals: [g('g-run', 'Run a half marathon', [1, 3])] },
    { name: 'dated beats undated, whatever the order', goals: [g('g-undated', 'Undated', [4]), g('g-run', 'Run a half marathon', [1])] },
    { name: 'undated only: the first goal’s first', goals: [g('g-one', 'One', [4, 5]), g('g-two', 'Two', [5])] },
    {
      name: 'an ended goal is passed over',
      goals: [g('g-done', 'Done', [3], { state: 'achieved' }), g('g-aside', 'Set aside', [2], { state: 'abandoned' }), g('g-run', 'Run a half marathon', [1])],
    },
    { name: 'reached and dropped are passed: the next open one', goals: [g('g-run', 'Run a half marathon', [6, 7, 1])] },
    { name: 'a custom type’s own done word, never a habit’s', goals: [g('g-read', 'Read more', [10, 11, 9])] },
    { name: 'a whole ISO stamp: its day', goals: [g('g-legacy', 'Legacy', [9])] },
    // uid(99) is a trashed milestone: its join row outlives it.
    { name: 'a trashed milestone is passed over', goals: [g('g-trash', 'Trash', [99, 4])] },
    { name: 'nothing open anywhere: no card', goals: [g('g-run', 'Run a half marathon', [6, 7]), g('g-none', 'None', [])] },
    { name: 'no goals: no card', goals: [] },
  ];
  const nextMilestoneAcrossCases = milestoneAsks.map((c) => {
    const next = nextMilestoneAcross(c.goals, milestoneById);
    return {
      ...c,
      expected: next
        ? {
            goalId: next.goal.id,
            itemId: next.milestone.id,
            date: next.date ?? null,
            line: nextMilestoneLine(next.date, next.goal.name),
          }
        : null,
    };
  });

  return {
    tables: { nothingOnThisWeek: NOTHING_ON_THIS_WEEK },
    milestoneWorld: { items: milestoneItems },
    organizeWeek: week,
    nextMilestoneAcross: nextMilestoneAcrossCases,
    weekCardSentence: [
      { name: 'part way', done: 18, counted: 23 },
      { name: 'none done yet', done: 0, counted: 4 },
      { name: 'all done', done: 7, counted: 7 },
      { name: 'nothing on', done: 0, counted: 0 },
    ].map((c) => ({ ...c, expected: weekCardSentence(c.done, c.counted) })),
  };
}

// ── paused.json: what is set aside (lib/paused-shelf.ts) ────────────────────

/*
 * One world, asked at TODAY (a Friday) in New York: items paused to a day, to
 * no day, a routine paused, and a routine an off season holds (named by the
 * season, the switch that brings it back). The trip case adds a trip over
 * today, whose rest is never "set aside".
 */
const PAUSED_ITEMS: Item[] = [
  task(1, 'Renew passport', { isScheduled: false, pausedAt: '2026-10-20T13:00:00Z', pausedUntil: '2026-10-24' }),
  habit(2, 'Cold shower', { pausedAt: '2026-10-20T13:00:00Z', pausedUntil: '2026-10-30' }),
  task(3, 'Sort the garage', { isScheduled: false, pausedAt: '2026-10-21T13:00:00Z' }),
  custom(4, 'book', 'Read Dune', { isScheduled: false, pausedAt: '2026-10-21T13:00:00Z', pausedUntil: '2026-10-30' }),
  // A subtask travels with its parent: never a row of its own.
  task(5, 'Find old photos', { isScheduled: false, parentItemId: uid(1), pausedAt: '2026-10-20T13:00:00Z' }),
  habit(6, 'Read', { timeBucket: 'evening' }),
  habit(7, 'Floss', { timeBucket: 'evening' }),
  habit(8, 'Stand up'),
  task(9, 'Clear the desk', { timeBucket: 'morning', startDate: '2026-10-01', repeatFrequency: 'weekdays' }),
  habit(10, 'Wax skis'),
  habit(11, 'Walk'),
  task(12, 'Still on', { timeBucket: 'morning', startDate: TODAY }),
  habit(13, 'Night stretch'),
  // Paused at 23:30 in New York: today there, tomorrow already in Tokyo.
  task(14, 'Late pause', { isScheduled: false, pausedAt: '2026-10-24T03:30:00Z' }),
];

const PAUSED_ROUTINES: Routine[] = [
  routine('r-evening', 'Evening', { itemIds: [uid(6), uid(7)], pausedAt: '2026-10-19T12:00:00Z', pausedUntil: '2026-10-30' }),
  routine('r-desk', 'Desk', { itemIds: [uid(8), uid(9)] }),
  routine('r-night', 'Night', { itemIds: [uid(13)], pausedAt: '2026-10-19T12:00:00Z', pausedUntil: '2027-01-04' }),
];

const PAUSED_SEASONS: Season[] = [
  season('s-winter', 'Winter', 'auto', { startsOn: '2026-11-01', endsOn: '2027-02-28', itemIds: [uid(10)], routineIds: ['r-desk'] }),
];

/** Over today, back on Monday: every habit rests, and none of it is "set aside". */
const PAUSED_TRIP: AwayPeriod = {
  id: 't-weekend',
  startsOn: '2026-10-22',
  endsOn: '2026-10-26',
  keep: { itemIds: [], routineIds: [], projectIds: [] },
  returns: {},
  fromTrip: {},
};

const pausedCtx = (timeZone: string, away: AwayPeriod[] = []) => ({
  userTimezone: timeZone,
  routines: PAUSED_ROUTINES,
  seasons: PAUSED_SEASONS,
  ...(away.length ? { away } : {}),
});

function shelfAnswer(items: Item[], today: string, timeZone: string, away: AwayPeriod[]) {
  const shelf = pausedShelf(items, today, pausedCtx(timeZone, away));
  // The state line is asked with no trips, as the detail pane asks it.
  const lineCtx = pausedCtx(timeZone);
  return {
    count: shelf.count,
    note: pausedNote(shelf, today),
    days: shelf.days.map((d) => ({
      key: d.key,
      until: d.until ?? null,
      label: pausedDayLabel(d, today),
      entries: d.entries.map((e) => ({
        kind: e.kind,
        key: e.key,
        id: e.kind === 'item' ? e.item.id : e.kind === 'routine' ? e.routine.id : e.season.id,
        name: pausedEntryName(e),
        until: e.until ?? null,
        itemIds: e.kind === 'item' ? [e.item.id] : e.items.map((i) => i.id),
        kindLine: entryKindLine(e),
        stateLine: pausedStateLine(e, today, lineCtx),
      })),
    })),
  };
}

function buildPaused() {
  const live = PAUSED_ITEMS.filter((i) => [uid(11), uid(12)].includes(i.id));
  const shelfAsks: { name: string; items: Item[]; timeZone: string; away: AwayPeriod[] }[] = [
    { name: 'nothing paused', items: live, timeZone: ZONE, away: [] },
    { name: 'grouped by return day, soonest first, no date last', items: PAUSED_ITEMS, timeZone: ZONE, away: [] },
    { name: 'a trip over today: its rest is not set aside, an item’s own pause still is', items: PAUSED_ITEMS, timeZone: ZONE, away: [PAUSED_TRIP] },
    { name: 'read in Tokyo: the late pause has not started', items: PAUSED_ITEMS, timeZone: 'Asia/Tokyo', away: [] },
  ];
  const shelf = shelfAsks.map((c) => ({
    name: c.name,
    items: c.items,
    routines: PAUSED_ROUTINES,
    seasons: PAUSED_SEASONS,
    away: c.away,
    today: TODAY,
    timeZone: c.timeZone,
    expected: shelfAnswer(c.items, TODAY, c.timeZone, c.away),
  }));

  // The rail's line names the soonest return: tomorrow, a weekday within the week, a day past it.
  const noteAsks: { name: string; until?: string }[] = [
    { name: 'back tomorrow', until: '2026-10-24' },
    { name: 'back in two days', until: '2026-10-25' },
    { name: 'back in six days', until: '2026-10-29' },
    { name: 'back in a week', until: '2026-10-30' },
    { name: 'back next month', until: '2026-11-12' },
    { name: 'no day to come back' },
  ];
  const pausedNoteCases = noteAsks.map((c) => {
    const items = [task(1, 'Renew passport', { isScheduled: false, pausedAt: '2026-10-20T13:00:00Z', ...(c.until ? { pausedUntil: c.until } : {}) })];
    const answer = pausedNote(pausedShelf(items, TODAY, { userTimezone: ZONE }), TODAY);
    return { name: c.name, items, today: TODAY, timeZone: ZONE, expected: answer };
  });

  const returnDayLabelCases = [
    { name: 'tomorrow', day: '2026-10-24' },
    { name: 'the day after', day: '2026-10-25' },
    { name: 'a week on', day: '2026-10-30' },
    { name: 'across the clocks changing', day: '2026-11-01' },
    { name: 'next month', day: '2026-11-12' },
    { name: 'next year', day: '2027-01-04' },
    { name: 'today itself', day: TODAY },
  ].map((c) => ({ ...c, today: TODAY, expected: returnDayLabel(c.day, TODAY) }));

  // An item row's kind line, read through the registry as the web has it
  // once the user's types are hydrated (planner-store's load): the type's own
  // label, or the slug capitalised when the label is empty or the type has no
  // row. Each case carries the types it was asked under; the phone passes the
  // payload's `itemTypes` as `labels`, which are these same rows.
  const kindLineTypes = [
    { name: 'book', label: 'Book to read', labelPlural: 'Books to read' },
    { name: 'side-quest', label: '', labelPlural: '' },
  ];
  const kindLineAsks: { name: string; item: Item }[] = [
    { name: 'a task', item: task(1, 'Renew passport', { isScheduled: false, pausedAt: '2026-10-20T13:00:00Z' }) },
    { name: 'a habit', item: habit(2, 'Cold shower', { pausedAt: '2026-10-20T13:00:00Z' }) },
    { name: 'a custom type, as the user named it', item: custom(4, 'book', 'Read Dune', { isScheduled: false, pausedAt: '2026-10-21T13:00:00Z' }) },
    { name: 'a custom type with an empty label: its slug capitalised', item: custom(15, 'side-quest', 'Map the trail', { isScheduled: false, pausedAt: '2026-10-21T13:00:00Z' }) },
    { name: 'a custom type with no row: its slug capitalised', item: custom(16, 'errand', 'Post the parcel', { isScheduled: false, pausedAt: '2026-10-21T13:00:00Z' }) },
  ];
  const typesBefore = getCustomTypeDefs();
  hydrateCustomTypes(kindLineTypes.map((t, i) => ({ id: `ty-${i}`, ...t }) as ItemTypeDef));
  let entryKindLineCases: { name: string; item: Item; itemTypes: typeof kindLineTypes; expected: string }[];
  try {
    entryKindLineCases = kindLineAsks.map((c) => ({
      ...c,
      itemTypes: kindLineTypes,
      expected: entryKindLine({ kind: 'item', key: `item:${c.item.id}`, item: c.item }),
    }));
  } finally {
    hydrateCustomTypes(typesBefore);
  }

  const backOnCases = [
    { name: 'tomorrow: the passport', date: '2026-10-24' },
    { name: 'a week on: each named once, in the store’s order', date: '2026-10-30' },
    { name: 'the season’s first day names the season', date: '2026-11-01' },
    { name: 'a day nothing comes back', date: '2026-10-25' },
  ].map((c) => ({ ...c, timeZone: ZONE, expected: backOn(PAUSED_ITEMS, c.date, pausedCtx(ZONE)) }));

  return {
    tables: { noDate: PAUSED_NO_DATE, nothingPaused: NOTHING_PAUSED, welcome: PAUSED_WELCOME },
    world: { items: PAUSED_ITEMS, routines: PAUSED_ROUTINES, seasons: PAUSED_SEASONS },
    pausedShelf: shelf,
    pausedNote: pausedNoteCases,
    returnDayLabel: returnDayLabelCases,
    entryKindLine: entryKindLineCases,
    backOn: backOnCases,
  };
}

// ── container-writes.json: what a field intent does (lib/app-containers.ts) ─

/*
 * POST /api/app/containers/:kind/:id decides its write with
 * containerIntentPatch on the container as stored; the phone runs the same
 * rule (DsulCore applyingContainer) to step optimistically and to replay a
 * landed write at the instant it was sent. Each case pins that instant
 * (`now`), the zone the server resolved (`timeZone`: for a pause the
 * account's, else the device's, else UTC; for every other intent, which
 * reads no zone, the UTC the route passes) and the day they make (`today`).
 * A goal's state stamps `achievedAt` at `now`.
 *
 * `body` is the JSON the phone sends, checked here against the route's own
 * schema. `expected.patch` is the write, with a cleared field as null (the
 * row's column set to null; on the phone, the field removed); `{}` is
 * "already so", answered 200 with nothing written. `expected.after` is the
 * container with the patch applied. A refusal is the 409 the route answers,
 * and leaves the container as it was.
 *
 * A season's `updatedAt` is left out on purpose: the row's trigger restamps
 * it on every write, the phone never writes it, and the next fetch carries
 * the new one.
 */
const CW_NOW = '2026-10-23T17:00:00.000Z';
/** 23:30 on Oct 23 in New York, already Oct 24 in UTC. */
const CW_LATE = '2026-10-24T03:30:00.000Z';
/** Only a pause reads a zone: for every other intent the route reads none and passes UTC. */
const STATE_ZONE = 'UTC';

type WriteAsk =
  | { name: string; kind: 'routine'; before: Routine; body: unknown; now: string; timeZone: string }
  | { name: string; kind: 'season'; before: Season; body: unknown; now: string; timeZone: string }
  | { name: string; kind: 'goal'; before: Goal; body: unknown; now: string; timeZone: string }
  | { name: string; kind: 'project'; before: Project; body: unknown; now: string; timeZone: string };

const nullForUndefined = (patch: object) =>
  Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === undefined ? null : v]));

function applied(before: object, patch: object): Record<string, unknown> {
  const after: Record<string, unknown> = { ...before, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete after[k];
  return after;
}

function buildContainerWrites() {
  const r = CW_ROUTINE;
  const s = CW_SEASON;
  const pause = (over: Record<string, unknown> = {}) => ({ action: 'pause', paused: true, timeZone: ZONE, ...over });
  const resume = { action: 'pause', paused: false, timeZone: ZONE };
  const state = (to: Season['state']) => ({ action: 'state', state: to });
  const RAN = '2026-10-20T13:00:00.000Z';

  const asks: WriteAsk[] = [
    // Routine: Pause, Pause until and Resume (the Status chip; Paused's Resume).
    { name: 'pause a live routine', kind: 'routine', before: r(), body: pause(), now: CW_NOW, timeZone: ZONE },
    {
      name: 'pause a live routine until a day',
      kind: 'routine',
      before: r(),
      body: pause({ pausedUntil: '2026-10-30' }),
      now: CW_NOW,
      timeZone: ZONE,
    },
    {
      name: 'pause until tomorrow',
      kind: 'routine',
      before: r(),
      body: pause({ pausedUntil: '2026-10-24' }),
      now: CW_NOW,
      timeZone: ZONE,
    },
    {
      name: 'pause again: already so, the first stamp kept',
      kind: 'routine',
      before: r({ pausedAt: RAN }),
      body: pause(),
      now: CW_NOW,
      timeZone: ZONE,
    },
    {
      name: 'pause again with no day: its resume day kept',
      kind: 'routine',
      before: r({ pausedAt: RAN, pausedUntil: '2026-10-30' }),
      body: pause(),
      now: CW_NOW,
      timeZone: ZONE,
    },
    {
      name: 'pause until on a running pause: the day moves, the stamp stays',
      kind: 'routine',
      before: r({ pausedAt: RAN, pausedUntil: '2026-10-30' }),
      body: pause({ pausedUntil: '2026-11-06' }),
      now: CW_NOW,
      timeZone: ZONE,
    },
    {
      name: 'pause until on a pause with no day: the day is set',
      kind: 'routine',
      before: r({ pausedAt: RAN }),
      body: pause({ pausedUntil: '2026-11-06' }),
      now: CW_NOW,
      timeZone: ZONE,
    },
    {
      name: 'pause until the day it already has: the same day written again',
      kind: 'routine',
      before: r({ pausedAt: RAN, pausedUntil: '2026-10-30' }),
      body: pause({ pausedUntil: '2026-10-30' }),
      now: CW_NOW,
      timeZone: ZONE,
    },
    {
      name: 'pause after the last one ended: a new pause, its old day cleared',
      kind: 'routine',
      before: r({ pausedAt: '2026-10-01T13:00:00.000Z', pausedUntil: '2026-10-10' }),
      body: pause(),
      now: CW_NOW,
      timeZone: ZONE,
    },
    {
      name: 'resume a pause: it ends today, the interval kept',
      kind: 'routine',
      before: r({ pausedAt: RAN }),
      body: resume,
      now: CW_NOW,
      timeZone: ZONE,
    },
    {
      name: 'resume a pause with a day: it ends today instead',
      kind: 'routine',
      before: r({ pausedAt: RAN, pausedUntil: '2026-10-30' }),
      body: resume,
      now: CW_NOW,
      timeZone: ZONE,
    },
    { name: 'resume a live routine: already so', kind: 'routine', before: r(), body: resume, now: CW_NOW, timeZone: ZONE },
    {
      name: 'resume after the pause ended: already so',
      kind: 'routine',
      before: r({ pausedAt: '2026-10-01T13:00:00.000Z', pausedUntil: '2026-10-10' }),
      body: resume,
      now: CW_NOW,
      timeZone: ZONE,
    },
    {
      name: 'pause until today: refused, it would end at once',
      kind: 'routine',
      before: r(),
      body: pause({ pausedUntil: TODAY }),
      now: CW_NOW,
      timeZone: ZONE,
    },
    {
      name: 'pause until a past day: refused',
      kind: 'routine',
      before: r(),
      body: pause({ pausedUntil: '2026-10-20' }),
      now: CW_NOW,
      timeZone: ZONE,
    },
    {
      name: 'late at night in New York: still the 23rd, so the 24th is tomorrow',
      kind: 'routine',
      before: r(),
      body: pause({ pausedUntil: '2026-10-24' }),
      now: CW_LATE,
      timeZone: ZONE,
    },
    {
      name: 'the same instant with no zone stored and the device in UTC: already the 24th, refused',
      kind: 'routine',
      before: r(),
      body: pause({ pausedUntil: '2026-10-24', timeZone: 'UTC' }),
      now: CW_LATE,
      timeZone: 'UTC',
    },
    {
      name: 'resume late at night in New York: ends on the 23rd',
      kind: 'routine',
      before: r({ pausedAt: RAN }),
      body: resume,
      now: CW_LATE,
      timeZone: ZONE,
    },
    {
      name: 'a pause the device sent without its zone: the account’s zone',
      kind: 'routine',
      before: r(),
      body: { action: 'pause', paused: true },
      now: CW_NOW,
      timeZone: ZONE,
    },

    // Season: On, Off and Dates, stored exactly as picked.
    { name: 'on: following its dates to pinned on', kind: 'season', before: s('auto'), body: state('active'), now: CW_NOW, timeZone: STATE_ZONE },
    { name: 'off: following its dates to switched off', kind: 'season', before: s('auto'), body: state('paused'), now: CW_NOW, timeZone: STATE_ZONE },
    { name: 'dates: pinned on back to its dates', kind: 'season', before: s('active'), body: state('auto'), now: CW_NOW, timeZone: STATE_ZONE },
    { name: 'dates: switched off back to its dates', kind: 'season', before: s('paused'), body: state('auto'), now: CW_NOW, timeZone: STATE_ZONE },
    { name: 'on: switched off to pinned on', kind: 'season', before: s('paused'), body: state('active'), now: CW_NOW, timeZone: STATE_ZONE },
    { name: 'off: pinned on to switched off', kind: 'season', before: s('active'), body: state('paused'), now: CW_NOW, timeZone: STATE_ZONE },
    {
      name: 'on, past its end: pinned on, the dates kept',
      kind: 'season',
      before: s('auto', { startsOn: '2026-06-01', endsOn: '2026-10-01' }),
      body: state('active'),
      now: CW_NOW,
      timeZone: STATE_ZONE,
    },
    {
      name: 'dates on a season with none: stored as picked',
      kind: 'season',
      before: s('paused', { startsOn: undefined, endsOn: undefined }),
      body: state('auto'),
      now: CW_NOW,
      timeZone: STATE_ZONE,
    },
    { name: 'on when already pinned on: already so', kind: 'season', before: s('active'), body: state('active'), now: CW_NOW, timeZone: STATE_ZONE },
    { name: 'off when already switched off: already so', kind: 'season', before: s('paused'), body: state('paused'), now: CW_NOW, timeZone: STATE_ZONE },
    { name: 'dates when already following them: already so', kind: 'season', before: s('auto'), body: state('auto'), now: CW_NOW, timeZone: STATE_ZONE },

    // O8b: the other fields. Each reads no zone, and writes its value again
    // when it already has it (only a pause and the two states are ever
    // "already so").
    ...fieldAsks(),
    // O9: rename, icon and colour, on every kind.
    ...identityAsks(),
  ];

  const cases = asks.map((c) => {
    const at = new Date(c.now);
    const today = toDateStr(at, c.timeZone);
    const parsed = CONTAINER_WRITE_SCHEMAS[c.kind].safeParse(c.body);
    if (!parsed.success) throw new Error(`${c.name}: the route would refuse this body`);
    // The schema of `c.kind` parsed it, so the intent is that kind's.
    const target = { kind: c.kind, container: c.before, intent: parsed.data } as ContainerIntentTarget;
    const result = containerIntentPatch(target, { now: at, timeZone: c.timeZone });
    const before = JSON.parse(JSON.stringify(c.before)) as object;
    const expected =
      'refused' in result
        ? { refused: result.refused, status: result.status, patch: null, after: before }
        : { refused: null, status: 200, patch: nullForUndefined(result.patch), after: applied(before, result.patch) };
    return { name: c.name, kind: c.kind, before, body: c.body, now: c.now, timeZone: c.timeZone, today, expected };
  });

  // Bodies the route refuses with 400 before reading anything: the phone's
  // encoder must never produce one.
  const invalidAsks: { name: string; kind: OrganizeKind; body: unknown }[] = [
    { name: 'a resume with a day', kind: 'routine', body: { action: 'pause', paused: false, pausedUntil: '2026-10-30' } },
    { name: 'a pause with no paused', kind: 'routine', body: { action: 'pause', pausedUntil: '2026-10-30' } },
    { name: 'a pause until a null day', kind: 'routine', body: { action: 'pause', paused: true, pausedUntil: null } },
    { name: 'a pause until a day that is not a date', kind: 'routine', body: { action: 'pause', paused: true, pausedUntil: '30/10/2026' } },
    { name: 'a key the server does not know', kind: 'routine', body: { action: 'pause', paused: true, note: 'x' } },
    { name: 'a season’s state on a routine', kind: 'routine', body: { action: 'state', state: 'paused' } },
    { name: 'a state that is not one of the three', kind: 'season', body: { action: 'state', state: 'on' } },
    { name: 'a pause on a season', kind: 'season', body: { action: 'pause', paused: true } },
    { name: 'a pause on a project', kind: 'project', body: { action: 'pause', paused: true } },
    // O8b: the other fields.
    { name: 'a usual time that is not HH:mm', kind: 'routine', body: { action: 'usualTime', usualTime: '7:15' } },
    { name: 'a usual time past the day', kind: 'routine', body: { action: 'usualTime', usualTime: '24:00' } },
    { name: 'a usual time with no time', kind: 'routine', body: { action: 'usualTime' } },
    { name: 'notes with no notes', kind: 'routine', body: { action: 'notes' } },
    { name: 'notes that are not text', kind: 'season', body: { action: 'notes', notes: 3 } },
    { name: 'a why on a routine', kind: 'routine', body: { action: 'why', why: 'To sleep.' } },
    { name: 'notes on a goal: its free text is the why', kind: 'goal', body: { action: 'notes', notes: 'x' } },
    { name: 'runs that end before they start', kind: 'season', body: { action: 'dates', startsOn: '2026-12-01', endsOn: '2026-11-01' } },
    { name: 'runs with one end left out', kind: 'season', body: { action: 'dates', startsOn: '2026-12-01' } },
    { name: 'runs on a day that is not on the calendar', kind: 'season', body: { action: 'dates', startsOn: '2026-02-30', endsOn: null } },
    { name: 'a goal’s window on a season', kind: 'season', body: { action: 'window', startsOn: null, targetOn: null } },
    { name: 'a window that closes before it opens', kind: 'goal', body: { action: 'window', startsOn: '2026-10-23', targetOn: '2026-10-22' } },
    { name: 'a window with no target key', kind: 'goal', body: { action: 'window', startsOn: '2026-10-23' } },
    { name: 'a goal state that is not one of the three', kind: 'goal', body: { action: 'state', state: 'paused' } },
    { name: 'a season’s dates on a goal', kind: 'goal', body: { action: 'dates', startsOn: null, endsOn: null } },
    { name: 'an achievedAt the server would stamp itself', kind: 'goal', body: { action: 'state', state: 'achieved', achievedAt: CW_NOW } },
    { name: 'a usual time on a project', kind: 'project', body: { action: 'usualTime', usualTime: '07:00' } },
    // O9: rename, icon and colour.
    { name: 'an empty name', kind: 'routine', body: { action: 'rename', name: '' } },
    { name: 'a name of spaces', kind: 'project', body: { action: 'rename', name: '   ' } },
    { name: 'a null name', kind: 'goal', body: { action: 'rename', name: null } },
    { name: 'a null icon: the web never clears a glyph', kind: 'season', body: { action: 'icon', icon: null } },
    { name: 'an icon with no icon: prefix', kind: 'routine', body: { action: 'icon', icon: 'Moon' } },
    { name: 'an icon with no name', kind: 'project', body: { action: 'icon', icon: 'icon:' } },
    { name: 'an icon name with a dash', kind: 'goal', body: { action: 'icon', icon: 'icon:Calendar-Range' } },
    { name: 'a project’s glyph sent as emoji', kind: 'project', body: { action: 'icon', emoji: 'icon:House' } },
    { name: 'a colour that is not a ramp token', kind: 'routine', body: { action: 'color', color: '#ff8800' } },
    { name: 'a ramp step past the eighth', kind: 'season', body: { action: 'color', color: 'var(--accent-9)' } },
    { name: 'a colour with no colour key', kind: 'goal', body: { action: 'color' } },
    // O10's, not yet taken.
    { name: 'a delete, for now', kind: 'project', body: { action: 'delete' } },
  ];
  const invalid = invalidAsks.map((c) => {
    if (CONTAINER_WRITE_SCHEMAS[c.kind].safeParse(c.body).success) throw new Error(`${c.name}: the route would take this body`);
    return { ...c, expected: { status: 400, error: 'invalid' } };
  });

  return { cases, invalid };
}

/** A routine, a season, a goal and a project as the field cases find them. */
const CW_ROUTINE = (over: Partial<Routine> = {}) =>
  routine('r-evening', 'Evening', { itemIds: [uid(1), uid(2)], sortOrder: 1, usualTime: '21:30', ...over });
const CW_SEASON = (state: Season['state'], over: Partial<Season> = {}) =>
  season('s-autumn', 'Autumn', state, { startsOn: '2026-09-01', endsOn: '2026-11-30', itemIds: [uid(3)], routineIds: ['r-evening'], sortOrder: 0, ...over });
const CW_GOAL = (over: Partial<Goal> = {}) =>
  goal('g-half', 'Run a half marathon', {
    why: 'To feel strong again.',
    startsOn: '2026-09-01',
    targetOn: '2027-03-15',
    sortOrder: 0,
    memberIds: [uid(4)],
    milestoneIds: [uid(5), uid(6)],
    checkinIds: [uid(7)],
    ...over,
  });
const CW_PROJECT = (over: Partial<Project> = {}) => project('p-home', 'Home', { emoji: 'icon:House', ...over });
/** When a goal was first achieved, a week before the cases are asked. */
const ACHIEVED = '2026-10-16T09:30:00.000Z';

/** O8b: usual time, runs, a goal's state and window, notes and the why. */
function fieldAsks(): WriteAsk[] {
  const at = { now: CW_NOW, timeZone: STATE_ZONE };
  const usual = (usualTime: string | null) => ({ action: 'usualTime', usualTime });
  const notes = (text: string | null) => ({ action: 'notes', notes: text });
  const dates = (startsOn: string | null, endsOn: string | null) => ({ action: 'dates', startsOn, endsOn });
  const goalState = (to: Goal['state']) => ({ action: 'state', state: to });
  const windowOf = (startsOn: string | null, targetOn: string | null) => ({ action: 'window', startsOn, targetOn });
  const why = (text: string | null) => ({ action: 'why', why: text });
  return [
    // Routine: Usual time, and its note.
    { name: 'usual time: set', kind: 'routine', before: CW_ROUTINE(), body: usual('07:15'), ...at },
    { name: 'usual time: on a routine with none', kind: 'routine', before: CW_ROUTINE({ usualTime: undefined }), body: usual('06:45'), ...at },
    { name: 'usual time: cleared', kind: 'routine', before: CW_ROUTINE(), body: usual(null), ...at },
    { name: 'usual time: the time it has, written again', kind: 'routine', before: CW_ROUTINE(), body: usual('21:30'), ...at },
    {
      name: 'usual time on a paused routine: the pause untouched',
      kind: 'routine',
      before: CW_ROUTINE({ pausedAt: '2026-10-20T13:00:00.000Z', pausedUntil: '2026-10-30' }),
      body: usual('22:00'),
      ...at,
    },
    { name: 'routine notes: set, trimmed', kind: 'routine', before: CW_ROUTINE(), body: notes('  Lights out by ten.\n'), ...at },
    { name: 'routine notes: replaced', kind: 'routine', before: CW_ROUTINE({ notes: 'Old.' }), body: notes('New.'), ...at },
    { name: 'routine notes: cleared with null', kind: 'routine', before: CW_ROUTINE({ notes: 'Old.' }), body: notes(null), ...at },
    { name: 'routine notes: blank clears them', kind: 'routine', before: CW_ROUTINE({ notes: 'Old.' }), body: notes('  \n\t '), ...at },
    { name: 'routine notes: two lines kept', kind: 'routine', before: CW_ROUTINE(), body: notes('Phone away.\nBook out.'), ...at },

    // Season: Runs, and its note.
    { name: 'runs: both ends moved', kind: 'season', before: CW_SEASON('auto'), body: dates('2026-11-01', '2027-02-28'), ...at },
    { name: 'runs: the end cleared, open after', kind: 'season', before: CW_SEASON('auto'), body: dates('2026-09-01', null), ...at },
    { name: 'runs: the start cleared, open before', kind: 'season', before: CW_SEASON('auto'), body: dates(null, '2026-11-30'), ...at },
    { name: 'runs: both cleared, always on its dates', kind: 'season', before: CW_SEASON('auto'), body: dates(null, null), ...at },
    { name: 'runs: one day', kind: 'season', before: CW_SEASON('auto'), body: dates('2026-12-25', '2026-12-25'), ...at },
    {
      name: 'runs on a season with none',
      kind: 'season',
      before: CW_SEASON('auto', { startsOn: undefined, endsOn: undefined }),
      body: dates('2026-10-23', '2026-12-31'),
      ...at,
    },
    {
      name: 'runs on a season switched off: the dates wait, the state stays',
      kind: 'season',
      before: CW_SEASON('paused'),
      body: dates('2026-12-01', '2027-01-31'),
      ...at,
    },
    { name: 'runs it already has, written again', kind: 'season', before: CW_SEASON('auto'), body: dates('2026-09-01', '2026-11-30'), ...at },
    { name: 'season notes: set, trimmed', kind: 'season', before: CW_SEASON('auto'), body: notes(' Leaves, soup, early nights. '), ...at },
    { name: 'season notes: cleared', kind: 'season', before: CW_SEASON('auto', { notes: 'Old.' }), body: notes(null), ...at },

    // Goal: Status. resolveGoalStateWrite: a stamp at `now`, kept on a retry.
    { name: 'achieve: stamped now', kind: 'goal', before: CW_GOAL(), body: goalState('achieved'), ...at },
    {
      name: 'achieve again: already so, the first stamp kept',
      kind: 'goal',
      before: CW_GOAL({ state: 'achieved', achievedAt: ACHIEVED }),
      body: goalState('achieved'),
      ...at,
    },
    {
      name: 'reopen an achieved goal: the stamp cleared',
      kind: 'goal',
      before: CW_GOAL({ state: 'achieved', achievedAt: ACHIEVED }),
      body: goalState('active'),
      ...at,
    },
    {
      name: 'set aside an achieved goal: the stamp kept',
      kind: 'goal',
      before: CW_GOAL({ state: 'achieved', achievedAt: ACHIEVED }),
      body: goalState('abandoned'),
      ...at,
    },
    { name: 'set aside an active goal', kind: 'goal', before: CW_GOAL(), body: goalState('abandoned'), ...at },
    { name: 'reopen a set-aside goal', kind: 'goal', before: CW_GOAL({ state: 'abandoned' }), body: goalState('active'), ...at },
    {
      name: 'achieve a set-aside goal: stamped now',
      kind: 'goal',
      before: CW_GOAL({ state: 'abandoned' }),
      body: goalState('achieved'),
      ...at,
    },
    { name: 'active when already active: already so', kind: 'goal', before: CW_GOAL(), body: goalState('active'), ...at },
    { name: 'set aside when already set aside: already so', kind: 'goal', before: CW_GOAL({ state: 'abandoned' }), body: goalState('abandoned'), ...at },
    {
      name: 'achieve at 03:30 UTC (still Oct 23 in New York): the stamp is the instant, never a day',
      kind: 'goal',
      before: CW_GOAL(),
      body: goalState('achieved'),
      now: CW_LATE,
      timeZone: STATE_ZONE,
    },

    // Goal: the window, and the why.
    { name: 'window: both ends moved', kind: 'goal', before: CW_GOAL(), body: windowOf('2026-10-01', '2027-04-30'), ...at },
    { name: 'window: no target', kind: 'goal', before: CW_GOAL(), body: windowOf('2026-09-01', null), ...at },
    { name: 'window: no start', kind: 'goal', before: CW_GOAL(), body: windowOf(null, '2027-03-15'), ...at },
    { name: 'window: cleared', kind: 'goal', before: CW_GOAL(), body: windowOf(null, null), ...at },
    { name: 'window: a target on the day it starts', kind: 'goal', before: CW_GOAL(), body: windowOf('2026-10-23', '2026-10-23'), ...at },
    {
      name: 'window on an achieved goal: its state and stamp untouched',
      kind: 'goal',
      before: CW_GOAL({ state: 'achieved', achievedAt: ACHIEVED }),
      body: windowOf('2026-09-01', '2026-10-16'),
      ...at,
    },
    { name: 'why: set, trimmed', kind: 'goal', before: CW_GOAL({ why: undefined }), body: why('  So the stairs stop winning. '), ...at },
    { name: 'why: replaced', kind: 'goal', before: CW_GOAL(), body: why('For the race in March.'), ...at },
    { name: 'why: cleared with null', kind: 'goal', before: CW_GOAL(), body: why(null), ...at },
    { name: 'why: blank clears it', kind: 'goal', before: CW_GOAL(), body: why('   '), ...at },

    // Project: its note.
    { name: 'project notes: set, trimmed', kind: 'project', before: CW_PROJECT(), body: notes('Chores and repairs.\n'), ...at },
    { name: 'project notes: cleared', kind: 'project', before: CW_PROJECT({ notes: 'Chores.' }), body: notes(null), ...at },
    { name: 'project notes: blank clears them', kind: 'project', before: CW_PROJECT({ notes: 'Chores.' }), body: notes(' '), ...at },
  ];
}

/** O9: rename, icon and colour, on every kind. */
function identityAsks(): WriteAsk[] {
  const at = { now: CW_NOW, timeZone: STATE_ZONE };
  const rename = (name: string) => ({ action: 'rename', name });
  const icon = (token: string) => ({ action: 'icon', icon: token });
  const color = (token: string | null) => ({ action: 'color', color: token });
  return [
    { name: 'routine rename', kind: 'routine', before: CW_ROUTINE(), body: rename('Wind down'), ...at },
    { name: 'routine rename, trimmed', kind: 'routine', before: CW_ROUTINE(), body: rename('  Wind down  '), ...at },
    {
      name: 'routine rename keeps its pause, its time and its members',
      kind: 'routine',
      before: CW_ROUTINE({ pausedAt: '2026-10-20T13:00:00.000Z' }),
      body: rename('Evenings'),
      ...at,
    },
    { name: 'routine icon', kind: 'routine', before: CW_ROUTINE(), body: icon('icon:Moon'), ...at },
    { name: 'routine icon replaced', kind: 'routine', before: CW_ROUTINE({ icon: 'icon:Repeat' }), body: icon('icon:Moon'), ...at },
    { name: 'routine colour', kind: 'routine', before: CW_ROUTINE(), body: color('var(--accent-4)'), ...at },
    { name: 'routine colour: Automatic clears it', kind: 'routine', before: CW_ROUTINE({ color: 'var(--accent-4)' }), body: color(null), ...at },

    { name: 'season rename', kind: 'season', before: CW_SEASON('auto'), body: rename('Fall'), ...at },
    { name: 'season rename to the name it has, in another case', kind: 'season', before: CW_SEASON('auto'), body: rename('autumn'), ...at },
    { name: 'season icon', kind: 'season', before: CW_SEASON('auto'), body: icon('icon:Leaf'), ...at },
    { name: 'season colour', kind: 'season', before: CW_SEASON('auto'), body: color('var(--accent-1)'), ...at },
    { name: 'season colour: lime', kind: 'season', before: CW_SEASON('paused'), body: color('var(--accent-8)'), ...at },
    { name: 'season colour: Automatic clears it', kind: 'season', before: CW_SEASON('auto', { color: 'var(--accent-1)' }), body: color(null), ...at },

    { name: 'goal rename', kind: 'goal', before: CW_GOAL(), body: rename('Run the Brooklyn Half'), ...at },
    {
      name: 'goal rename keeps its state and its stamp',
      kind: 'goal',
      before: CW_GOAL({ state: 'achieved', achievedAt: ACHIEVED }),
      body: rename('Ran a half marathon'),
      ...at,
    },
    { name: 'goal icon', kind: 'goal', before: CW_GOAL({ icon: 'icon:Target' }), body: icon('icon:Trophy'), ...at },
    { name: 'goal colour', kind: 'goal', before: CW_GOAL(), body: color('var(--accent-3)'), ...at },
    { name: 'goal colour: Automatic clears it', kind: 'goal', before: CW_GOAL({ color: 'var(--accent-3)' }), body: color(null), ...at },

    // A project's own row. The route also re-files its members by
    // project_id, and refuses a clash; neither is the patch's (see
    // app-containers.test.ts).
    { name: 'project rename', kind: 'project', before: CW_PROJECT(), body: rename('House'), ...at },
    { name: 'project rename to its own name in another case', kind: 'project', before: CW_PROJECT(), body: rename('home'), ...at },
    { name: 'project rename, trimmed', kind: 'project', before: CW_PROJECT({ notes: 'Chores.' }), body: rename(' Household '), ...at },
    { name: 'project icon: written to its emoji', kind: 'project', before: CW_PROJECT(), body: icon('icon:Hammer'), ...at },
    { name: 'project icon over a legacy emoji', kind: 'project', before: CW_PROJECT({ emoji: '🏠' }), body: icon('icon:House'), ...at },
    { name: 'project colour', kind: 'project', before: CW_PROJECT(), body: color('var(--accent-6)'), ...at },
    { name: 'project colour: Automatic clears it', kind: 'project', before: CW_PROJECT({ color: 'var(--accent-6)' }), body: color(null), ...at },
  ];
}

// ── Writing and checking ─────────────────────────────────────────────────────

const FIXTURES: Record<string, () => unknown> = {
  labels: buildLabels,
  standing: buildStanding,
  goals: buildGoals,
  schedule: buildSchedule,
  look: buildLook,
  copy: buildCopy,
  organize: buildOrganize,
  paused: buildPaused,
  'container-writes': buildContainerWrites,
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

  it('the week counts done of done-or-due: never a skip, a past blank, a subtask or a hidden day', () => {
    const cases = buildOrganize().organizeWeek;
    const pick = (n: string) => cases.find((c) => c.name === n)!;
    const base = pick('a Sunday week: done of done-or-due, everything the grid shows').expected;
    expect(base).toMatchObject({ from: '2026-10-18', through: '2026-10-24' });
    expect(base.counted).toBeGreaterThan(base.done);
    expect(base.done).toBeGreaterThan(0);
    // Each week is seven days from its first, in all three settings.
    for (const c of cases) expect(addDaysStr(c.expected.from, 6), c.name).toBe(c.expected.through);
    expect(pick('a Saturday week: today is its last day').expected.through).toBe(TODAY);
    expect(pick('a Monday week asked on its Sunday').expected.from).toBe('2026-10-19');
    expect(pick('the week’s first day: nothing is past yet').expected.from).toBe('2026-10-19');
    // A subtask never counts, even done on a day in the week.
    expect(pick('the same world with no subtask: the same answer').expected).toEqual(base);
    // A pause takes days off the week; resumed, they are back.
    expect(pick('the paused errand resumed: on the week').expected.counted).toBe(base.counted + 1);
    // A trip rests its days, except what was done on them.
    const trip = pick('a trip rests what falls inside it, except what was done').expected;
    expect(trip.counted).toBeLessThan(base.counted);
    expect(trip.done).toBe(base.done);
    // A skip and an unrecorded past day are on neither side: nothing on.
    for (const n of ['only a skip and an unrecorded past day: nothing counted', 'nothing on this week: an undated task and one next month', 'no items at all']) {
      expect(pick(n).expected, n).toMatchObject({ done: 0, counted: 0, sentence: NOTHING_ON_THIS_WEEK });
    }
    expect(pick('a finished one-off counts on its day').expected).toMatchObject({ done: 1, counted: 1, sentence: '1 of 1 done' });
  });

  it('the next milestone is the earliest dated across active goals, and words its day without a countdown', () => {
    const cases = buildOrganize().nextMilestoneAcross;
    const pick = (n: string) => cases.find((c) => c.name === n)!.expected;
    expect(pick('a late milestone keeps its date')?.line).toBe('Oct 4 · Run a half marathon');
    expect(pick('a tie on the day: the goal listed first')?.goalId).toBe('g-first');
    expect(pick('dated beats undated, whatever the order')?.goalId).toBe('g-run');
    expect(pick('an ended goal is passed over')?.goalId).toBe('g-run');
    expect(pick('undated only: the first goal’s first')).toEqual({ goalId: 'g-one', itemId: uid(4), date: null, line: 'One' });
    expect(pick('a whole ISO stamp: its day')?.date).toBe('2026-11-02');
    expect(pick('a custom type’s own done word, never a habit’s')?.itemId).toBe(uid(11));
    expect(pick('nothing open anywhere: no card')).toBeNull();
    expect(pick('no goals: no card')).toBeNull();
  });

  it('the shelf counts items, never entries, and leaves out a trip’s rest, a subtask and a pause not yet begun', () => {
    const cases = buildPaused().pausedShelf;
    const pick = (n: string) => cases.find((c) => c.name === n)!.expected;
    const base = pick('grouped by return day, soonest first, no date last');
    expect(base.days.map((d) => d.label)).toEqual(['Tomorrow', 'Fri, Oct 30', 'Sun, Nov 1', 'Mon, Jan 4', 'No date']);
    const entries = base.days.flatMap((d) => d.entries);
    expect(base.count).toBe(entries.reduce((n, e) => n + e.itemIds.length, 0));
    expect(base.count).toBeGreaterThan(entries.length);
    // Containers first within a day.
    expect(base.days[1].entries.map((e) => e.kind)).toEqual(['routine', 'item', 'item']);
    expect(entries.find((e) => e.kind === 'season')?.kindLine).toBe('Season · 3 items');
    expect(entries.some((e) => e.itemIds.includes(uid(5)))).toBe(false);
    expect(pick('nothing paused')).toEqual({ count: 0, note: null, days: [] });
    // A trip names itself before a routine or a season (suppressionReason), so
    // what it rests leaves the shelf, Walk included; an item's own pause
    // outranks the trip and stays.
    const tripCtx = { userTimezone: ZONE, routines: PAUSED_ROUTINES, seasons: PAUSED_SEASONS, away: [PAUSED_TRIP] };
    expect(inactiveItemIdsOn(PAUSED_ITEMS, TODAY, tripCtx).has(uid(11))).toBe(true);
    const trip = pick('a trip over today: its rest is not set aside, an item’s own pause still is');
    const tripEntries = trip.days.flatMap((d) => d.entries);
    expect(trip.count).toBeLessThan(base.count);
    expect(tripEntries.length).toBeGreaterThan(0);
    expect(tripEntries.every((e) => e.kind === 'item')).toBe(true);
    expect(tripEntries.some((e) => e.itemIds.includes(uid(11)))).toBe(false);
    // The zone decides the day a pause starts.
    expect(entries.some((e) => e.itemIds.includes(uid(14)))).toBe(true);
    const tokyo = pick('read in Tokyo: the late pause has not started').days.flatMap((d) => d.entries);
    expect(tokyo.some((e) => e.itemIds.includes(uid(14)))).toBe(false);
  });

  it('an item’s kind line reads the user’s own type label, the slug only without one, and leaves the registry as it found it', () => {
    const before = getCustomTypeDefs();
    const cases = buildPaused().entryKindLine;
    expect(getCustomTypeDefs()).toBe(before);
    expect(Object.fromEntries(cases.map((c) => [c.name, c.expected]))).toEqual({
      'a task': 'Task',
      'a habit': 'Habit',
      'a custom type, as the user named it': 'Book to read',
      'a custom type with an empty label: its slug capitalised': 'Side-quest',
      'a custom type with no row: its slug capitalised': 'Errand',
    });
  });

  it('the shared words hold the copy rules: no em dash, nothing "missed"', () => {
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(buildCopy());
    walk(buildOrganize());
    walk(buildPaused());
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
