import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { countLive, routinePillLabel, seasonPillLabel } from '@/lib/collections';
import { routineStandingOn, seasonResumeDate } from '@/lib/active';
import { goalProgress, isGoalActive, progressLabel, sortGoalsForDisplay } from '@/lib/goals';
import { containerMemberIds, type ScheduleContainer } from '@/lib/container-schedule';
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
import type { Goal, Item, Project, Routine, Season } from '@/lib/planner-types';

/**
 * Organize's cases shared with the iPhone.
 *
 * The same contract as tests/unit/day-fixtures.test.ts, for the rules the
 * phone's Organize tab ports: the list's pills and counts (lib/collections.ts),
 * where a routine stands (lib/active.ts routineStandingOn, seasonResumeDate),
 * a goal's progress, its words and the list order (lib/goals.ts), who is in a
 * container (lib/container-schedule.ts containerMemberIds), and how a container
 * looks: its colour (lib/accent-colors.ts, with each token's oklch values read
 * out of app/globals.css) and its glyph (lib/category-icons.ts). Every case is
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

  return { routineStandingOn: routineStandingOnCases, seasonResumeDate: seasonResumeDateCases };
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

  return { world: { items, routines }, containerMemberIds: containerMemberIdsCases };
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

  const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    tokens,
    accentForName,
    projectColor,
    colors,
    icons,
    hash,
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

// ── Writing and checking ─────────────────────────────────────────────────────

const FIXTURES: Record<string, () => unknown> = {
  labels: buildLabels,
  standing: buildStanding,
  goals: buildGoals,
  schedule: buildSchedule,
  look: buildLook,
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
