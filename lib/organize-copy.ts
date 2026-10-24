import { formatDay, seasonResumeDate, isSeasonActiveOn, type RoutineStanding } from './active';
import { CONTAINER_KINDS, type ContainerKind } from './container-registry';
import type { TrashKind } from './db';
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

/**
 * The attach confirm: putting a routine in a season that would hide some of
 * its items (lib/organize.ts wouldHideAttaching counts them; nothing is asked
 * when it is 0). The web's seasons pane and the iPhone's season page say the
 * same title, description and button; the phone's Cancel is the system's.
 *
 * The title has no full stop: it is a heading.
 */
export function attachConfirmTitle(hides: number): string {
  return `This will hide ${hides} ${hides === 1 ? 'item' : 'items'} for now`;
}

/**
 * What the attach does, said out loud: the routine looked after itself, the
 * season answers for it now, and the season is off, so its items wait for it.
 * A season following its dates that starts later names the day they come
 * back; any other waits for the switch.
 *
 * The rule is the pane's own (`state` auto, a start after today), not
 * seasonResumeDate's, so the words stay exactly the web's. `hides` is
 * wouldHideAttaching's count, never a member count. One item is said in the
 * singular ("its 1 item comes back", "restores it"); the web said "its 1 item
 * come back", and both shells take the fix, as #579's delete sentences did.
 */
export function attachConfirmDescription(
  routineName: string,
  season: Pick<Season, 'name' | 'state' | 'startsOn'>,
  hides: number,
  todayStr: string,
): string {
  const returns =
    season.state === 'auto' && season.startsOn && todayStr < season.startsOn ? formatDay(season.startsOn) : null;
  const one = hides === 1;
  const items = `${hides} ${one ? 'item' : 'items'}`;
  const waits = returns
    ? `${one ? 'comes' : 'come'} back on ${returns}`
    : `${one ? 'stays' : 'stay'} hidden until you switch it on`;
  return (
    `“${routineName}” looks after itself today. Putting it in ${season.name} hands that over. ` +
    `${season.name} is off, so its ${items} ${waits}. ` +
    `Nothing is deleted, and taking it back out restores ${one ? 'it' : 'them'}.`
  );
}

/** The attach confirm's button. */
export const ATTACH_CONFIRM_LABEL = 'Add it anyway';

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

/* ── the summary cards (the iPhone's Organize tab) ───────────────────── */

/** THIS WEEK with nothing done or due: the card shows no bar. */
export const NOTHING_ON_THIS_WEEK = 'Nothing on this week';

/**
 * THIS WEEK's line, over lib/organize.ts organizeWeek: "18 of 23 done", or
 * {@link NOTHING_ON_THIS_WEEK} when nothing is done or due. Never a share of
 * the past: `counted` is what is done plus what is still ahead.
 */
export function weekCardSentence(done: number, counted: number): string {
  return counted === 0 ? NOTHING_ON_THIS_WEEK : `${done} of ${counted} done`;
}

/**
 * NEXT MILESTONE's second line: the milestone's day as the goal page's "next:"
 * line words it, then the goal: "Oct 4 · Run a half marathon". An undated
 * milestone shows the goal's name alone. No countdown: the web counts down to
 * a goal's target, never to a milestone.
 */
export function nextMilestoneLine(date: string | undefined, goalName: string): string {
  return date ? `${formatDay(date)} · ${goalName}` : goalName;
}

/* ── the Trash ────────────────────────────────────────────────────────── */

/** How long a soft-deleted row survives before the nightly purge (migration 036). */
export const TRASH_WINDOW_DAYS = 30;

/**
 * What each row of the bin was, spelled out: the one list that mixes kinds,
 * so the kind is a word on the row rather than something a glyph implies.
 * The container nouns are the registry's (CONTAINER_KINDS), never hand-typed.
 */
export const TRASH_KIND_LABELS: Readonly<Record<TrashKind, string>> = {
  item: 'Item',
  project: CONTAINER_KINDS.project.label,
  routine: CONTAINER_KINDS.routine.label,
  season: CONTAINER_KINDS.season.label,
  goal: CONTAINER_KINDS.goal.label,
};

/** An empty bin. */
export const NOTHING_IN_TRASH = `Nothing deleted in the last ${TRASH_WINDOW_DAYS} days.`;

/** What the bin is for, said once beside it. */
export const TRASH_TEACHING = `Anything you delete waits here for ${TRASH_WINDOW_DAYS} days, then goes for good.`;

/**
 * How long ago, in the words a bin needs.
 *
 * Days rather than a date, because the only question a trash row has to answer
 * is "how much of my thirty days is left", and "Aug 3" makes the reader do
 * that subtraction themselves. Rounded DOWN from the elapsed milliseconds, so
 * something deleted twenty-five hours ago reads "1d" rather than "2d" and the
 * count never runs ahead of the purge.
 */
export function whenGone(deletedAt: string, now = Date.now()): string {
  const elapsed = now - new Date(deletedAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'just now';
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Days of the 30-day window still left, for "gone for good in Nd".
 *
 * Counts DOWN from `whenGone`'s elapsed days so the two never disagree: freshly
 * deleted reads the full window, and anything past the purge boundary clamps to
 * 0 rather than a negative. A malformed or future stamp reads as the full window,
 * the same benefit of the doubt `whenGone`'s "just now" gives.
 */
export function daysUntilPurge(deletedAt: string, now = Date.now()): number {
  const elapsed = now - new Date(deletedAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return TRASH_WINDOW_DAYS;
  return Math.max(0, TRASH_WINDOW_DAYS - Math.floor(elapsed / 86_400_000));
}

/**
 * A trash row's meta before its age: the kind, then what comes back WITH it,
 * said before the click rather than discovered after: "Item · 2 subtasks",
 * "Project · 3 items refile". A count of 0 says nothing.
 */
export function trashKindLine(kind: TrashKind, childCount: number, memberCount: number): string {
  let line = TRASH_KIND_LABELS[kind];
  if (childCount > 0) line += ` · ${childCount} ${childCount === 1 ? 'subtask' : 'subtasks'}`;
  if (memberCount > 0) line += ` · ${memberCount} ${memberCount === 1 ? 'item' : 'items'} refile`;
  return line;
}

/** The whole meta line: "Project · 3 items refile · 3d ago". */
export function trashRowMeta(
  row: { kind: TrashKind; childCount: number; memberCount: number; deletedAt: string },
  now = Date.now(),
): string {
  return `${trashKindLine(row.kind, row.childCount, row.memberCount)} · ${whenGone(row.deletedAt, now)}`;
}

/** What restoring a trashed container reconnects: one honest sentence per kind. */
export function restoreSentence(kind: Exclude<TrashKind, 'item'>, memberCount: number): string {
  const noun = CONTAINER_KINDS[kind].label.toLowerCase();
  switch (kind) {
    case 'project':
      return memberCount > 0
        ? `Restoring brings the ${noun} back and re-files the ${memberCount} ${memberCount === 1 ? 'item' : 'items'} still pointing at it.`
        : `Restoring brings the ${noun} back. Nothing is filed under it right now.`;
    case 'routine':
      return `Restoring brings the ${noun} back, along with the items it grouped.`;
    case 'season':
      return `Restoring brings the ${noun} back, along with the routines and items it held.`;
    case 'goal':
      return `Restoring brings the ${noun} back, along with its milestones, check-ins and members.`;
  }
}

/**
 * A name a trashed container is still holding (the unique index spans the
 * bin, components/planner/organize/use-trashed-names.ts heldByTrash). The
 * message names the Trash because the bin is the fix.
 */
export function nameInTrashSentence(noun: string, name: string): string {
  return `A deleted ${noun} called “${name}” still has that name. Restore it from Trash, or pick a different one.`;
}

/**
 * A name a live sibling already has, folding case (components/planner/organize/
 * sections/labels.tsx takenBy, which says it inline as a rename is typed; the
 * iPhone's banner for a project rename refused 409 `name_taken`).
 */
export function nameTakenSentence(noun: string, name: string): string {
  return `You already have a ${noun} called “${name}”.`;
}

/* ── making one ───────────────────────────────────────────────────────── */

/**
 * The create form's words, and the glyph a new one starts with: the console's
 * "+ New" (container-create-form.tsx for a goal, routine or season; labels.tsx
 * for a project) and the iPhone's create sheet, which opens from its + menu
 * with nothing but a name.
 */
export interface CreateCopy {
  /** "NEW ROUTINE": names what is being made. */
  eyebrow: string;
  /** "Name your routine…" */
  placeholder: string;
  /** The form's button: "Create routine". */
  addLabel: string;
  /**
   * The glyph token a new one starts with (lib/category-icons.ts
   * makeIconToken's `icon:<Name>`, spelled out so a route can read these words
   * without the icon library). `icon:CalendarRange` is not in the library, so a
   * new season's glyph derives from its name, on the web and the phone alike.
   */
  icon: string;
  /** What the kind is for, said once under the field. */
  hint: string;
}

/** The three nouns come from the registry (CONTAINER_KINDS), so moving one is an edit there. */
function createCopy(kind: ContainerKind, icon: string, hint: string): CreateCopy {
  const noun = CONTAINER_KINDS[kind].label.toLowerCase();
  return { eyebrow: `NEW ${noun.toUpperCase()}`, placeholder: `Name your ${noun}…`, addLabel: `Create ${noun}`, icon, hint };
}

/** Each kind's create words, as the console's form shows them. */
export const CONTAINER_CREATE_COPY: Readonly<Record<ContainerKind, CreateCopy>> = {
  goal: createCopy(
    'goal',
    'icon:Target',
    'A goal is the reason a stretch of work exists. It holds the habits and tasks that serve it, the checkpoints along the way, and a recurring check-in. It never hides anything.',
  ),
  routine: createCopy(
    'routine',
    'icon:Repeat',
    'A routine is a set of things you do regularly, in order, like a morning or a workout week. Pause it and they all step off your day together.',
  ),
  season: createCopy(
    'season',
    'icon:CalendarRange',
    'A season is a stretch of life (a summer, a term, a training block) that switches whole routines on and off. Without dates it starts always-on, hiding nothing.',
  ),
  project: createCopy(
    'project',
    'icon:Briefcase',
    `${CONTAINER_KINDS.project.labelPlural} file your tasks, and can carry a repeating block on the grid.`,
  ),
};

/* ── deleting one ─────────────────────────────────────────────────────── */

/**
 * Which shell a sentence is for. The web has ⌘Z; the iPhone has no undo, so
 * its delete words never offer one, and every one of them ends on the bin
 * ({@link DELETE_STAYS_IN_TRASH}, by kind).
 */
export type CopyShell = 'web' | 'phone';

/**
 * How every iPhone delete confirm ends: the Trash, never an undo. It names
 * the kind, because the sentence before it can end on an item ("It just stops
 * being grouped."), and a bare "It" would read as the item going.
 */
export const DELETE_STAYS_IN_TRASH: Readonly<Record<ContainerKind, string>> = {
  routine: `The ${CONTAINER_KINDS.routine.label.toLowerCase()} stays in the Trash for ${TRASH_WINDOW_DAYS} days.`,
  season: `The ${CONTAINER_KINDS.season.label.toLowerCase()} stays in the Trash for ${TRASH_WINDOW_DAYS} days.`,
  goal: `The ${CONTAINER_KINDS.goal.label.toLowerCase()} stays in the Trash for ${TRASH_WINDOW_DAYS} days.`,
  project: `The ${CONTAINER_KINDS.project.label.toLowerCase()} stays in the Trash for ${TRASH_WINDOW_DAYS} days.`,
};

/**
 * A delete confirm's title: "Delete this routine?", "Delete this season?",
 * "Delete Run a half marathon?" (the goal's own name, which is the sentence
 * that has to be there) and `Delete “Home”?`.
 */
export function deleteTitle(kind: ContainerKind, name: string): string {
  switch (kind) {
    case 'routine':
    case 'season':
      return `Delete this ${CONTAINER_KINDS[kind].label.toLowerCase()}?`;
    case 'goal':
      return `Delete ${name}?`;
    case 'project':
      return `Delete “${name}”?`;
  }
}

/** A delete confirm's button: "Delete", and the goal's "Delete goal". */
export const DELETE_CONFIRM_LABELS: Readonly<Record<ContainerKind, string>> = {
  routine: 'Delete',
  season: 'Delete',
  goal: `Delete ${CONTAINER_KINDS.goal.label.toLowerCase()}`,
  project: 'Delete',
};

/**
 * What a delete confirm says will happen, counted the way the pane counts it.
 *
 *   routine  `liveCount` is its live members (countLive); `reappear` is
 *            whether removing it puts any of them back on the day
 *            (membersRevealedByRemoving, lib/active.ts): the routine's path
 *            goes, so items a season was holding off through it come back.
 *   season   `itemCount` and `routineCount` are its live direct members and
 *            live routines; `live` is isSeasonActiveOn for today. Deleting an
 *            off season removes its paths, so what it was hiding comes back.
 *   goal     nothing to count: its members are ordinary items and stay.
 *   project  `itemCount` is the items filed under it (the web counts its exact
 *            name; the iPhone its folded members, subtasks left out, the
 *            number its page lists). `requiredCount` and `destination` are the
 *            web store's own move (`unfiled` reassigns a type whose container
 *            is required); the iPhone's delete stamps the project alone and
 *            moves nothing, so its sentence never says so.
 */
export type DeleteConsequenceInput =
  | { kind: 'routine'; name: string; liveCount: number; reappear: boolean }
  | { kind: 'season'; name: string; itemCount: number; routineCount: number; live: boolean }
  | { kind: 'goal' }
  | { kind: 'project'; name: string; itemCount: number; requiredCount?: number; destination?: string };

/**
 * The confirm's sentence. The web's says what ⌘Z can do where it can; the
 * iPhone's drops any undo and ends every kind on {@link DELETE_STAYS_IN_TRASH}
 * (the goal's opening "moves to the trash for 30 days" moves there too, so it
 * is said once). Both shells count in the singular for one thing, and an
 * empty routine says only that it is removed (the panes once said "its 0
 * items stay" and "the 1 item it holds stay").
 */
export function deleteConsequence(input: DeleteConsequenceInput, shell: CopyShell): string {
  const onPhone = (said: string) => `${said} ${DELETE_STAYS_IN_TRASH[input.kind]}`;
  switch (input.kind) {
    case 'routine': {
      const n = input.liveCount;
      // An empty routine has nothing to keep, so it says only that it goes.
      const said =
        n === 0
          ? `“${input.name}” is removed.`
          : `“${input.name}” is removed, but its ${n} ${n === 1 ? 'item stays' : 'items stay'} exactly as ` +
            `${n === 1 ? 'it is' : 'they are'}. ${n === 1 ? 'It just stops' : 'They just stop'} being grouped` +
            `${input.reappear ? `, and ${n === 1 ? 'it comes' : 'they come'} back into view` : ''}.`;
      return shell === 'phone' ? onPhone(said) : said;
    }
    case 'season': {
      const { itemCount, routineCount } = input;
      const held = [
        itemCount > 0 ? `${itemCount} ${itemCount === 1 ? 'item' : 'items'}` : null,
        routineCount > 0 ? `${routineCount} ${routineCount === 1 ? 'routine' : 'routines'}` : null,
      ]
        .filter(Boolean)
        .join(' and ');
      const one = itemCount + routineCount === 1;
      const said =
        `“${input.name}” is removed` +
        (held ? `, but the ${held} it holds ${one ? 'stays exactly as it is' : 'stay exactly as they are'}` : '') +
        (!input.live && (itemCount > 0 || routineCount > 0) ? '. Anything it was hiding comes back into view' : '') +
        '.';
      return shell === 'phone' ? onPhone(said) : said;
    }
    case 'goal': {
      const kept =
        'Its habits, tasks and milestones are ordinary items and stay exactly where they are. ' +
        'Only the goal and its links go.';
      return shell === 'phone' ? onPhone(kept) : `The goal moves to the trash for ${TRASH_WINDOW_DAYS} days. ${kept}`;
    }
    case 'project': {
      const n = input.itemCount;
      const filed =
        n === 0
          ? 'Nothing is filed under it, so nothing moves.'
          : `Its ${n} ${n === 1 ? 'item stays' : 'items stay'} exactly as ${n === 1 ? 'it is' : 'they are'}. ` +
            `${n === 1 ? 'It just stops' : 'They just stop'} being filed under ${input.name}.`;
      if (shell === 'phone') return onPhone(filed);
      const required = input.requiredCount ?? 0;
      const moved =
        required > 0 && input.destination
          ? ` The ${required === 1 ? 'habit moves' : `${required} habits move`} to “${input.destination}”.`
          : '';
      return `${filed}${moved} ⌘Z brings it back now, and it stays in the Trash for ${TRASH_WINDOW_DAYS} days.`;
    }
  }
}

/** The iPhone's Trash, when the list could not be read: never an empty bin. */
export const TRASH_LOAD_FAILED = "Couldn't load the Trash.";

/** The iPhone's Restore, refused for a reason the phone cannot fix, or not answered. */
export const RESTORE_FAILED = "Couldn't restore it. Check your connection and try again.";

/**
 * The iPhone's Restore, answered 404: the row is no longer in the bin (the
 * nightly purge took it after the list was read). A retry can never land, so
 * the phone drops the row rather than asking for one.
 */
export const RESTORE_GONE = "It's no longer in the Trash.";

/**
 * The iPhone's words for a refused restore (POST /api/app/trash/restore,
 * lib/app-containers.ts): `name_taken` when a live project folds to the same
 * name (`name` is that project's), `parent_gone` when a subtask's parent is in
 * the bin too, `not_found` when the row is no longer in the bin
 * ({@link RESTORE_GONE}). Anything else is {@link RESTORE_FAILED}.
 */
export function restoreRefusal(code: string | undefined, name: string): string {
  if (code === 'name_taken') {
    return `You already have a ${CONTAINER_KINDS.project.label.toLowerCase()} called “${name}”. Rename that one, then restore this one.`;
  }
  if (code === 'parent_gone') return 'Its parent is in the Trash too. Restore that instead.';
  if (code === 'not_found') return RESTORE_GONE;
  return RESTORE_FAILED;
}

/* ── container writes (the iPhone's POST /api/app/containers/:kind/:id) ── */

/**
 * The iPhone's words for a routine's Pause until refused with 409
 * `pause_refused`: the day picked is no longer after today (a picker left
 * open across midnight), so nothing was paused. The item sheet says the same
 * for an item's pause. The web's store refuses the same request before it
 * writes, and says nothing.
 */
export const PAUSE_REFUSED = 'That day is no longer after today, so nothing was paused.';

/**
 * The iPhone's words for a membership write refused because another device
 * got there first: a routine step's move whose item (`member_gone`) or anchor
 * (`anchor_gone`) has left the routine, and a season hold whose routine is
 * gone (`container_gone`). The phone refetches on any failed write, so what
 * it shows next is the server's.
 */
export const CHANGED_ELSEWHERE = 'It changed on another device. Showing the latest.';

/**
 * The iPhone's words for a refused container write (lib/app-containers.ts):
 *   - `pause_refused` is {@link PAUSE_REFUSED};
 *   - `name_taken` (a project renamed onto a live project's name, folding
 *     case) is {@link nameTakenSentence};
 *   - `name_in_trash` (a project renamed onto the exact name a project in the
 *     Trash still holds) is {@link nameInTrashSentence};
 *   - `member_gone`, `anchor_gone` (a routine step's move, O12) and
 *     `container_gone` (a season hold, O13) are {@link CHANGED_ELSEWHERE}.
 * The two name sentences name the container by `sentName`, the name the phone
 * sent in its rename, never the answer's body; without one they have no
 * words. Null for a code with no words of its own (a 404, a 500, no answer at
 * all), which the phone words as any failed write. Later parts add their
 * codes here.
 */
export function containerRefusal(code: string | undefined, sentName?: string): string | null {
  const noun = CONTAINER_KINDS.project.label.toLowerCase();
  if (code === 'pause_refused') return PAUSE_REFUSED;
  if (code === 'member_gone' || code === 'anchor_gone' || code === 'container_gone') return CHANGED_ELSEWHERE;
  if (code === 'name_taken' && sentName !== undefined) return nameTakenSentence(noun, sentName);
  if (code === 'name_in_trash' && sentName !== undefined) return nameInTrashSentence(noun, sentName);
  return null;
}
