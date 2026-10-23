import { formatDay, seasonResumeDate, isSeasonActiveOn, type RoutineStanding } from './active';
import type { Goal, Routine, Season } from './planner-types';

/**
 * organize-copy.ts: the words Organize's two shells share.
 *
 * Each sentence here was moved out of the web component that said it, and that
 * component imports it back, so the console, the container pages and the
 * iPhone's Organize tab (ios/DsulCore OrganizeCopy.swift, pinned by
 * tests/fixtures/organize/copy.json) cannot word the same thing two ways.
 *
 * Pure and store-free, so a route could import it. Dates are `formatDay`'s
 * fixed English months ("Oct 30"), never the browser locale: the same word on
 * every device, and a fixture that does not depend on the machine it was
 * written on. The guilt-free law holds in every line: nothing here says
 * "missed", and nothing is late, only "still ahead".
 */

/* ── counts in running text ───────────────────────────────────────────── */

/**
 * A sentence in runs, with its counts marked. The web sets each count in its
 * numeral face (`font-num`), as it did before the sentence moved here; the
 * phone and the fixture read the joined text ({@link runsText}). A date or a
 * name is never a count, so "Back on Nov 1." stays in the running face.
 */
export type CopyRun = string | { count: number };

/** The runs as one string. */
export function runsText(runs: readonly CopyRun[]): string {
  return runs.map((r) => (typeof r === 'string' ? r : String(r.count))).join('');
}

/* ── status chips ─────────────────────────────────────────────────────── */

/** A routine's Status chip: its OWN switch, the value the chip writes. */
export const ROUTINE_STATE_LABELS = { active: 'Active', paused: 'Paused' } as const;

/** A season's Status chip. `auto` follows its dates, so it reads "Dates". */
export const SEASON_STATE_LABELS = { active: 'On', paused: 'Off', auto: 'Dates' } as const satisfies Record<
  Season['state'],
  string
>;

/** A goal's Status chip. `abandoned` is "Set aside": the goal is put down, nothing failed. */
export const GOAL_STATE_LABELS = { active: 'Active', achieved: 'Achieved', abandoned: 'Set aside' } as const satisfies Record<
  Goal['state'],
  string
>;

/* ── switched off ─────────────────────────────────────────────────────── */

/** What a page says while its extension is off: inert, never "not found". */
export interface SwitchedOff {
  title: string;
  body: string;
}

/** A routine's or season's page with Organize off (components/planner/container-page.tsx). */
export const ORGANIZE_OFF: SwitchedOff = {
  title: 'Organize is switched off',
  body:
    'Your routines and seasons are still here. Switch the extension back on and this page ' +
    'picks up where it left off. Nothing was deleted.',
};

/** A goal's page with Goals off (app/goal/[id]/page.tsx). */
export const GOALS_OFF: SwitchedOff = {
  title: 'Goals is switched off',
  body:
    'Your goals are still here. Switch the extension back on and this page picks up where it ' +
    'left off. Nothing was deleted.',
};

/** The title and body as one run of text, for a surface with no room for a heading. */
export function switchedOffSentence(off: SwitchedOff): string {
  return `${off.title}. ${off.body}`;
}

/* ── a routine ────────────────────────────────────────────────────────── */

/** A container with nothing in it. */
export const NOTHING_IN_IT_YET = 'Nothing is in it yet.';

/**
 * Under a paused routine's Status: when its items come back, and that nothing
 * was lost. The caller shows it only while the routine's own switch is off.
 */
export function routinePausedNote(routine: Pick<Routine, 'pausedUntil'>): string {
  const back = routine.pausedUntil
    ? `Its items come back on ${formatDay(routine.pausedUntil)}, on their own.`
    : 'Its items are hidden until you resume.';
  return `${back} Streaks and history stay exactly as they are.`;
}

/**
 * Under an ACTIVE routine that every season holding it has switched off: the
 * chip says Active and is telling the truth about the value it writes, so this
 * says what that value is achieving, which is nothing. Null when the two agree.
 *
 * Two sentences about different subjects. The first is about the ROUTINE: no
 * season holding it is on. The second is about its ITEMS, and is only true of
 * the ones actually off the day, `hiddenHere` (its members in
 * `inactiveItemIdsOn` for today, asked with the routines and seasons and no
 * trips, as routines.tsx asks it): a member another routine is still carrying
 * is not hidden. The return date is the soonest holder's, because the rule is
 * disjunctive: the first season back carries the routine.
 */
export function routineHeldNote(
  standing: Pick<RoutineStanding, 'localOn' | 'effectiveOn' | 'blockers' | 'soonestBlocker'>,
  hiddenHere: number,
  todayStr: string,
): string | null {
  const runs = routineHeldNoteRuns(standing, hiddenHere, todayStr);
  return runs && runsText(runs);
}

/** {@link routineHeldNote} in runs, its two counts marked (the date is not a count). */
export function routineHeldNoteRuns(
  standing: Pick<RoutineStanding, 'localOn' | 'effectiveOn' | 'blockers' | 'soonestBlocker'>,
  hiddenHere: number,
  todayStr: string,
): CopyRun[] | null {
  const blocker = standing.soonestBlocker;
  if (!standing.localOn || standing.effectiveOn || !blocker) return null;
  const routine: CopyRun[] =
    standing.blockers.length === 1
      ? [`“${blocker.name}” is off, so this routine isn’t carrying anything right now.`]
      : [
          'All ',
          { count: standing.blockers.length },
          ' seasons holding it are off, so this routine isn’t carrying anything right now.',
        ];
  if (hiddenHere === 0) return [...routine, ' Its items are still on your day another way.'];
  const back = seasonResumeDate(blocker, todayStr);
  return [
    ...routine,
    ' ',
    { count: hiddenHere },
    ` ${hiddenHere === 1 ? 'item is' : 'items are'} hidden. `,
    back ? `Back on ${formatDay(back)}.` : 'They come back when one of those seasons does.',
  ];
}

/** "Held by", with no season holding the routine. */
export const HELD_BY_NONE = 'No season. It answers for itself.';

/**
 * A holder's state in a routine's "Held by" list: "on", "off", or
 * "off until Nov 1" when the season starts later. It reads the start date
 * whatever the season's state, as the page always has.
 */
export function heldByState(season: Season, todayStr: string): string {
  if (isSeasonActiveOn(season, todayStr)) return 'on';
  return season.startsOn && season.startsOn > todayStr ? `off until ${formatDay(season.startsOn)}` : 'off';
}

/** Today's run of a routine: "2 of 3 done", "2 of 3 done · 1 skipped". Null with nothing on. */
export function routineTodaySummary(done: number, total: number, skipped: number): string | null {
  const runs = routineTodaySummaryRuns(done, total, skipped);
  return runs && runsText(runs);
}

/** {@link routineTodaySummary} in runs, every number a count. */
export function routineTodaySummaryRuns(done: number, total: number, skipped: number): CopyRun[] | null {
  if (total === 0) return null;
  return [{ count: done }, ' of ', { count: total }, ' done', ...(skipped > 0 ? [' · ', { count: skipped }, ' skipped'] : [])];
}

/** A routine with nothing on today: empty, or empty TODAY. */
export function routineTodayEmpty(name: string, memberCount: number): string {
  return memberCount === 0 ? NOTHING_IN_IT_YET : `Nothing from ${name} is on today.`;
}

/** Everything on today is done or skipped. */
export const ROUTINE_TODAY_FINISHED = 'All through for today.';

/** The meta on the first member still due. */
export const ROUTINE_TODAY_NEXT = 'next';

/* ── a season ─────────────────────────────────────────────────────────── */

/** "Oct 1 to Mar 15", "from Oct 1", "until Mar 15"; null with no dates. */
function seasonSpan(startsOn: string | undefined, endsOn: string | undefined): string | null {
  const from = startsOn ? formatDay(startsOn) : null;
  const to = endsOn ? formatDay(endsOn) : null;
  if (from && to) return `${from} to ${to}`;
  if (from) return `from ${from}`;
  if (to) return `until ${to}`;
  return null;
}

/**
 * The four ways a season can be, in the season's own words: under its Status
 * on the console pane, on its page, and on the iPhone. `live` is
 * `isSeasonActiveOn(season, today)`.
 */
export function seasonStateNote(season: Season, live: boolean): string {
  if (season.state === 'active') return 'On until you say otherwise. Dates are ignored while it is set this way.';
  if (season.state === 'paused') return 'Off. Everything it holds is hidden, and streaks and history stay exactly as they are.';
  const span = seasonSpan(season.startsOn, season.endsOn);
  if (!span) return 'Always on. Give it a start or an end to make it follow the calendar.';
  return `Runs ${span}, inclusive. ${live ? 'On now.' : 'Off right now. Nothing it holds is showing.'}`;
}

/**
 * The iPhone's Runs chip, under Dates: "Oct 1 to Mar 15", "From Oct 1",
 * "Until Mar 15", or null with no dates. The web's chip draws an arrow; the
 * span is seasonStateNote's.
 */
export function seasonRunsLabel(startsOn: string | undefined, endsOn: string | undefined): string | null {
  const span = seasonSpan(startsOn, endsOn);
  return span ? span[0].toUpperCase() + span.slice(1) : null;
}

/* ── a goal ───────────────────────────────────────────────────────────── */

/**
 * The page's note on an ended goal, or null while it is active. An achieved
 * goal's day is its `achievedAt` stamp's own date, as the page has read it.
 */
export function goalEndedNote(goal: Pick<Goal, 'state' | 'achievedAt'>): string | null {
  if (goal.state === 'active') return null;
  if (goal.state === 'achieved') {
    const on = goal.achievedAt ? ` on ${formatDay(goal.achievedAt.slice(0, 10))}` : '';
    return `Achieved${on}. Everything below is the record of how it went.`;
  }
  return 'Set aside. Its work is untouched, and nothing here was cancelled on your behalf.';
}

/**
 * The wind-down (long-term-goals.md decision 5): an ended goal's recurring
 * members keep coming round, and this is the one place that says so. It names
 * them and changes nothing: a goal never writes its members. Null with none,
 * and null for a goal still active, which has nothing to wind down.
 */
export function windDownSentence(goal: Pick<Goal, 'state'>, count: number): string | null {
  if (goal.state === 'active' || count === 0) return null;
  const lead =
    count === 1 ? 'This still repeats on its own schedule.' : `${count} of its items still repeat on their own schedules.`;
  return (
    `${lead} Nothing was changed for you. ${goal.state === 'achieved' ? 'An achieved' : 'A set-aside'} goal never ` +
    'edits its members. Keep them as they are, open one to park it in a season, or delete it for good.'
  );
}

/** A goal with no check-in. */
export const NO_CHECKIN_YET =
  'No check-in yet. A recurring review (weekly is usually right) is what keeps a long goal from going ' +
  'quiet for a month at a time.';

/** A goal with no milestones, under Milestones. */
export const NO_MILESTONES_YET =
  'No checkpoints yet. A milestone is a one-shot task whose date is the day you mean to have reached it.';

/** A goal with no plain members, under Supporting work. */
export const NO_SUPPORTING_WORK = 'Nothing else is filed under this goal yet.';

/**
 * A check-in row's meta: its cadence (lib/cadence.ts `cadenceLabel`), then the
 * last day it was done (lib/goals.ts `lastDoneOn`): "Sun · last Oct 19", or
 * just "Sun" before the first one.
 */
export function checkinMeta(cadence: string, lastDone: string | undefined): string {
  return lastDone ? `${cadence} · last ${formatDay(lastDone)}` : cadence;
}

/** A milestone's tick, named for what it does. */
export function milestoneTickLabel(title: string, reached: boolean): string {
  return reached ? `Mark ${title} not reached` : `Mark ${title} reached`;
}
