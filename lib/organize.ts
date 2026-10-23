import {
  deriveContainerSchedule,
  occurrencesByItem,
  weekStartOf,
  weekTotals,
  type ScheduleSource,
  type WeekStartDay,
} from './container-schedule';
import { isGoalActive, nextMilestone, sortGoalsForDisplay } from './goals';
import { toDateOnly } from './overdue';
import type { Goal, Item } from './planner-types';

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
