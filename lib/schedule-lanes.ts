import { groupRows, type GroupableRow } from './grouping';
import { MIN_CHANNEL_PX } from './schedule-constants';
import type { Goal, GroupBy, Season, Routine } from './planner-types';

/**
 * How a Schedule grid answers a grouping — lanes, or focus (Phase 5b).
 *
 * The grid cannot take section headings: a row's y position IS its time, so a
 * heading either breaks the axis or floats free of it. The partition has to go
 * on x instead, and x is not free — a channel below MIN_CHANNEL_PX is not a
 * readable block. So there are two answers, and which one applies is arithmetic
 * rather than preference:
 *
 *   LANES — x subdivides into one band per group. Lanes NEST INSIDE overlap
 *     resolution rather than replacing it: `placeSiblings(sibs, area, depth)`
 *     already derives its channel budget from `area`, so handing it a lane's band
 *     instead of the field's makes every existing rule — column packing,
 *     containment, the inset cascade, the content-band pass — run inside a lane
 *     exactly as it ran inside the field.
 *
 *   FOCUS — no lanes at all. Every block keeps full geometry; picking a group
 *     recedes the others. Costs zero pixels, which is why it is the answer
 *     wherever lanes cannot be afforded or cannot be honest.
 *
 * TIME BUCKET gets neither. The grid declines it and the Anytime strip answers
 * alone — see the guard in `planLanes`.
 *
 * Three things force focus, all for different reasons:
 *
 *   WEEK, always. At every derived default on every common monitor a week column
 *     is arithmetically EXACTLY ONE 140px channel. There is nothing to divide.
 *
 *   ROUTINE, SEASON and GOAL, always, on any variant. All three are
 *     many-to-many and their grouping branch is first-claim-wins, so a lane
 *     cannot express insert-into-B versus move-to-B: an item claimed by goal A
 *     is in A's lane while also serving B, and dragging it into B's band would
 *     have to mean something the membership cannot say. They are focus-only on
 *     the schedule in every version, not just this one. (The gates suppress and
 *     the goal does not; that difference decides nothing here — the lane
 *     geometry only ever asked whether the grouping is a partition.)
 *
 *   PAST THE BUDGET. There is deliberately no "Other" lane: folding the trailing
 *     groups into one names groups it cannot spatially distinguish, which is a
 *     channel that lies. The whole view falls back to focus instead, where every
 *     group is reachable at full geometry.
 */

export type LaneMode = 'none' | 'lanes' | 'focus';

export interface Lane {
  /** The group's key from `groupRows` — stable, and what focus is held by. */
  key: string;
  label: string;
  /** Band inside the events field, as percentages. Both 0 in focus mode. */
  leftPct: number;
  rightPct: number;
  /** Rows in this lane, in grouping order. */
  count: number;
}

export interface LanePlan {
  mode: LaneMode;
  lanes: Lane[];
  /** item id → lane key. Every grouped row appears exactly once. */
  laneOf: Map<string, string>;
}

export const NO_LANES: LanePlan = { mode: 'none', lanes: [], laneOf: new Map() };

export interface LaneOptions {
  variant: 'day' | 'week';
  /** Measured width of the events layer. Unknown means "cannot divide safely". */
  fieldWidth?: number | null;
  routines?: readonly Routine[];
  seasons?: readonly Season[];
  goals?: readonly Goal[];
}

/**
 * How many lanes this field can carry.
 *
 * MIN_CHANNEL_PX, not a new number: a lane has to hold at least one channel at
 * the floor, which is the same question `channelsThatFit` asks inside the overlap
 * pass. It lands on the figures the design was costed against — a ~936px field
 * gives six, and the ~504px left when the item panel opens gives three.
 */
export const laneBudget = (fieldWidth: number): number =>
  Math.max(1, Math.floor(fieldWidth / MIN_CHANNEL_PX));

export function planLanes(
  rows: GroupableRow[],
  groupBy: GroupBy,
  { variant, fieldWidth, routines, seasons, goals }: LaneOptions
): LanePlan {
  if (groupBy === 'none' || rows.length === 0) return NO_LANES;
  /**
   * Time of day does not become lanes, and does not become focus either — the
   * grid declines the question outright and only the Anytime strip answers it.
   * That is what `groupBySupport` promises with "Anytime only".
   *
   * y already IS the bucket, and `autoCorrectBucket` (planner-store.ts:596-602)
   * forces a timed item's bucket to match its startTime — so the lanes are
   * mutually exclusive on y BY CONSTRUCTION. Three lanes would be a literal
   * staircase carrying no information y did not already carry, with two thirds
   * of the field dead at every height. Shipped that way for one commit; the
   * comment forbidding it was in view-options.ts while nothing implemented it.
   */
  if (groupBy === 'bucket') return NO_LANES;

  const groups = groupRows(rows, groupBy, { routines, seasons, goals });
  if (groups.length === 0) return NO_LANES;

  const laneOf = new Map<string, string>();
  for (const g of groups) for (const row of g.rows) laneOf.set(row.item.id, g.key);

  const divisible =
    variant === 'day' &&
    // Routine, season and goal are focus-only forever — all three are
    // many-to-many, and their grouping is first-claim-wins; see the header.
    groupBy !== 'routine' &&
    groupBy !== 'season' &&
    groupBy !== 'goal' &&
    // One group is not a partition; it is a label. Focus renders that as a
    // single cap with nothing to recede, which is honest and costs no width.
    groups.length >= 2 &&
    fieldWidth != null &&
    laneBudget(fieldWidth) >= groups.length;

  if (!divisible) {
    return {
      mode: 'focus',
      lanes: groups.map((g) => ({ key: g.key, label: g.label, leftPct: 0, rightPct: 0, count: g.rows.length })),
      laneOf,
    };
  }

  const n = groups.length;
  const w = 100 / n;
  return {
    mode: 'lanes',
    lanes: groups.map((g, i) => ({
      key: g.key,
      label: g.label,
      leftPct: i * w,
      rightPct: (n - 1 - i) * w,
      count: g.rows.length,
    })),
    laneOf,
  };
}

/**
 * The focused key, or null — resolved against the CURRENT plan.
 *
 * Focus is held by group key in a store that knows nothing about grouping, so a
 * key can outlive the lanes it named: switch from Project to Priority and
 * `project:Work` no longer matches anything. Resolving here rather than clearing
 * the store on every group-by change means a stale key simply stops applying,
 * and cannot recede the whole grid with nothing on screen able to explain it.
 */
export function resolveFocus(plan: LanePlan, focused: string | null): string | null {
  if (!focused || plan.mode === 'none') return null;
  return plan.lanes.some((l) => l.key === focused) ? focused : null;
}

/**
 * True when this row should render receded — focus is on, and not on its lane.
 *
 * A row the plan never saw is NEVER receded. Both call sites build the plan from
 * the same array they render, so today that cannot happen — but the two are
 * separate expressions in separate memos, and the failure modes are not
 * symmetric: an unreceded stray is a block at full strength on a focused day,
 * while a receded one is work greyed out for a reason nothing on screen can
 * explain. The cheap end of that is `false`, and it is not the end
 * `laneKeyOf(...) !== active` gives you.
 */
export function isReceded(plan: LanePlan, focused: string | null, id: string): boolean {
  const active = resolveFocus(plan, focused);
  if (!active) return false;
  const lane = laneKeyOf(plan, id);
  return lane !== null && lane !== active;
}

/** A row's lane key, or null when the plan never saw it. */
export const laneKeyOf = (plan: LanePlan, id: string): string | null => plan.laneOf.get(id) ?? null;
