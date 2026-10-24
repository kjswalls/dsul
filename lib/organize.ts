import {
  deriveContainerSchedule,
  occurrencesByItem,
  weekStartOf,
  weekTotals,
  type ScheduleSource,
  type WeekStartDay,
} from './container-schedule';
import { isGoalActive, nextMilestone, sortGoalsForDisplay } from './goals';
import { inactiveItemIdsOn } from './active';
import { toDateOnly } from './overdue';
import type { Goal, Item, Routine, Season } from './planner-types';

/**
 * organize.ts: the answers Organize's summary needs that no one component
 * owns, pure, so the iPhone's Organize tab (ios/DsulCore Organize.swift,
 * pinned by tests/fixtures/organize/organize.json) asks the same questions the
 * same way.
 *
 * Nothing here re-derives "does this want doing". The week is the grid's own
 * answer for each day (deriveContainerSchedule), counted by the rule every
 * member list already counts with (weekTotals): what is done, out of what is
 * done or still ahead. The next milestone is each goal's own nextMilestone.
 * What putting a routine in a season would hide is the resolver's own answer
 * (inactiveItemIdsOn), asked twice. A routine step's new place is one id
 * moved in a list, the order the container route writes (lib/app-containers.ts
 * moveMember) and the phone steps by.
 */

/* ── THIS WEEK ────────────────────────────────────────────────────────── */

/** The week card's numbers. */
export interface OrganizeWeek {
  /** The week's first day, from the user's Week starts on setting. */
  from: string;
  /** Its last day, six days on. */
  through: string;
  done: number;
  /**
   * What the card's "of" counts: done, plus what is due today or later. A
   * skip is a decision, not work, and a past day with nothing recorded is
   * `open`, never a miss, so neither is on either side (weekTotals).
   */
  counted: number;
}

/**
 * How the week is going, across EVERYTHING the grid shows this calendar week,
 * however it is filed (design Q1's default, Kirby's to change): every task and
 * habit, from the week's first day for seven days, each day the grid's own
 * answer (so a paused item, an off season's items and a trip's rest are not
 * on it), counted done out of done-or-due.
 *
 * Subtasks never count: the grid's `tasks` projection leaves them out, and
 * `source.tasks` is that projection. A finished one-off counts on its day
 * whatever showCompletedTasks says, as every container chart counts it.
 */
export function organizeWeek(source: ScheduleSource, todayStr: string, weekStartDay: WeekStartDay): OrganizeWeek {
  const from = weekStartOf(todayStr, weekStartDay);
  const ids = source.items.map((i) => i.id);
  const schedule = deriveContainerSchedule({ memberIds: ids, source, from, days: 7, todayStr });
  const { done, total } = weekTotals(occurrencesByItem(schedule), ids);
  return { from, through: schedule.days[schedule.days.length - 1]?.date ?? from, done, counted: total };
}

/* ── NEXT MILESTONE ───────────────────────────────────────────────────── */

/** The milestone the summary card points at, and the goal it belongs to. */
export interface MilestoneAcross {
  goal: Goal;
  milestone: Item;
  /** Its target day, yyyy-MM-dd, or undefined when it has none. */
  date?: string;
}

/**
 * The next milestone across every active goal: the earliest DATED one (each
 * goal's own `nextMilestone`), and failing that the first undated one in
 * `sortGoalsForDisplay` order. A tie on the day goes to the goal listed
 * first. Ended goals are passed over, and so is a goal with nothing open.
 * Null when no active goal has an open milestone, which hides the card.
 *
 * A late milestone keeps its date and nothing more, as the goal page's own
 * "next:" line does: there is no countdown to a milestone, only to a goal.
 */
export function nextMilestoneAcross(goals: readonly Goal[], itemsById: Map<string, Item>): MilestoneAcross | null {
  let dated: MilestoneAcross | null = null;
  let undated: MilestoneAcross | null = null;
  for (const goal of sortGoalsForDisplay(goals)) {
    if (!isGoalActive(goal)) continue;
    const milestone = nextMilestone(goal, itemsById);
    if (!milestone) continue;
    const date = 'startDate' in milestone && milestone.startDate ? toDateOnly(milestone.startDate) : undefined;
    if (date) {
      if (!dated || date < dated.date!) dated = { goal, milestone, date };
    } else if (!undated) {
      undated = { goal, milestone };
    }
  }
  return dated ?? undated;
}

/* ── A ROUTINE'S STEPS ────────────────────────────────────────────────── */

/**
 * A routine's member order with `item` moved to sit right after `after`, or
 * first when `after` is null: the order a routine page's drag (and its "Move
 * up" and "Move down") asks for, one item placed after another, never a list
 * sent whole.
 *
 * Every other member keeps its order relative to the rest. An `item` that is
 * not in `ids`, an `after` that is not (once `item` is taken out), or an
 * `after` that is `item` itself changes nothing: the answer is `ids` as it
 * was. The container route refuses the first two before it gets here (409
 * `member_gone`, `anchor_gone`) and the third as a body (400), so the phone's
 * optimistic step and the server always agree on what was moved.
 *
 * Pure, over ids only: a member whose item is in the Trash (its join row
 * outlives the item's soft delete) keeps its place among the rest, so the
 * order the phone draws, which skips it, is the order it asked for.
 */
export function moveMemberAfter(ids: readonly string[], item: string, after: string | null): string[] {
  if (after === item || !ids.includes(item)) return [...ids];
  const rest = ids.filter((id) => id !== item);
  if (after === null) return [item, ...rest];
  const at = rest.indexOf(after);
  if (at < 0) return [...ids];
  return [...rest.slice(0, at + 1), item, ...rest.slice(at + 1)];
}

/* ── A SEASON'S ROUTINES ──────────────────────────────────────────────── */

/** What wouldHideAttaching asks the resolver with: the live routines and seasons, and the zone. */
export interface AttachWorld {
  userTimezone: string;
  /** The user's LIVE routines (ActivationContext's contract). */
  routines: readonly Routine[];
  /** The user's LIVE seasons, the one the routine would join among them. */
  seasons: readonly Season[];
}

/**
 * How many items putting routine `routineId` in season `seasonId` would
 * ACTUALLY take off `dateStr`: the attach confirm's count (the web's seasons
 * pane; the iPhone's season page, "This will hide 3 items for now"). Zero
 * means no confirm: the routine goes straight in.
 *
 * A routine that belongs to NO season answers for itself. Put it in its
 * first season and the season answers too, so attaching a live routine to a
 * season that is off makes its items leave today as a side effect of a join
 * write. Only that first season rescopes it: a routine another season
 * already holds is purely added to (the path algebra is disjunctive), so it
 * hides nothing and is never asked about, which keeps the one prompt that
 * has something to say from being dismissed unread.
 *
 * The count is the resolver's DELTA, asked by simulating the join, never a
 * member count: a member already hidden (its own pause, the routine's), one
 * a second live path still carries (another routine, the season's own items)
 * and one with nothing left to do today would all move nothing.
 *
 * Asked with the routines and seasons and no trips, as the web's pane asks
 * it: a trip's rest is a hold of its own, and the season would still be
 * holding the item when the trip ends.
 */
export function wouldHideAttaching(
  seasonId: string,
  routineId: string,
  items: readonly Item[],
  world: AttachWorld,
  dateStr: string,
): number {
  const { userTimezone, routines, seasons } = world;
  if (seasons.some((s) => s.id !== seasonId && s.routineIds.includes(routineId))) return 0;
  const before = inactiveItemIdsOn(items, dateStr, { userTimezone, routines, seasons });
  const after = inactiveItemIdsOn(items, dateStr, {
    userTimezone,
    routines,
    seasons: seasons.map((s) => (s.id === seasonId ? { ...s, routineIds: [...s.routineIds, routineId] } : s)),
  });
  let n = 0;
  for (const id of after) if (!before.has(id)) n += 1;
  return n;
}
