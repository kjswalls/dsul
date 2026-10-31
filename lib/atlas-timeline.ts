import type { Goal, Season } from './planner-types';
import type { AtlasCard } from './atlas-model';
import { addDaysStr, daysBetween } from './container-schedule';
import { toDateOnly } from './overdue';
import { isRecurring } from './recurrence';

/**
 * Timeline (design PR2): months left to right, season bars, goal diamonds at
 * their target dates, projects at their next dated step, routines in a strip
 * of their own, and a lane for what has no date. Pure.
 *
 * Only a goal's target moves from here (a goal's `targetOn` is a target date,
 * like a milestone's start date: memory/plans/long-term-goals.md). Everything
 * else takes its date from its items, so a drag on it springs back.
 */

/** World px per day. A month is about 180px, a card about six weeks. */
export const TIMELINE_DAY_PX = 6;
/** The window never runs longer than this; Fit handles the rest. */
export const TIMELINE_MAX_MONTHS = 18;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface TimelineMonth {
  /** yyyy-MM-01 */
  start: string;
  label: string;
  x: number;
  w: number;
}

export interface TimelineWindow {
  /** First day drawn (yyyy-MM-01), at x = 0. */
  start: string;
  /** Last day drawn (inclusive). */
  end: string;
  months: TimelineMonth[];
}

const ymd = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10);
};
const parts = (day: string) => toDateOnly(day).split('-').map(Number) as [number, number, number];

function monthStart(day: string, add = 0): string {
  const [y, m] = parts(day);
  return ymd(y, m + add, 1);
}

function monthEnd(day: string): string {
  const [y, m] = parts(day);
  return ymd(y, m + 1, 0);
}

/**
 * From the month before today (or the month of the earliest goal target, if
 * that is earlier) to two months past the latest date shown (at least three
 * months ahead), clamped to {@link TIMELINE_MAX_MONTHS} from the start. A goal
 * card is drawn unclamped at its target, so the window always reaches every
 * goal target (`goalSpan`): a goal never sits outside the drawn months, where
 * a nudge would write the window's edge instead of the day it was nudged to.
 */
export function timelineWindow(
  todayStr: string,
  latest?: string,
  goalSpan?: { earliest?: string; latest?: string },
): TimelineWindow {
  const today = toDateOnly(todayStr);
  const defaultStart = monthStart(today, -1);
  const earliestGoal = goalSpan?.earliest ? monthStart(goalSpan.earliest) : undefined;
  const start = earliestGoal && earliestGoal < defaultStart ? earliestGoal : defaultStart;
  const floor = monthStart(today, 3);
  const wanted = latest && latest > floor ? monthStart(latest, 2) : floor;
  const capped = monthStart(start, TIMELINE_MAX_MONTHS - 1);
  const latestGoal = goalSpan?.latest ? monthStart(goalSpan.latest) : undefined;
  const cap = latestGoal && latestGoal > capped ? latestGoal : capped;
  const end = monthEnd(wanted > cap ? cap : wanted);
  const months: TimelineMonth[] = [];
  for (let m = start; m <= end; m = monthStart(m, 1)) {
    const [y, mo] = parts(m);
    const last = monthEnd(m);
    months.push({
      start: m,
      label: mo === 1 ? `${MONTHS[0]} ${y}` : MONTHS[mo - 1],
      x: xForDate({ start }, m),
      w: (daysBetween(m, last) + 1) * TIMELINE_DAY_PX,
    });
  }
  return { start, end, months };
}

/** The x of a day's left edge (not clamped). */
export function xForDate(win: Pick<TimelineWindow, 'start'>, day: string): number {
  return daysBetween(win.start, toDateOnly(day)) * TIMELINE_DAY_PX;
}

/** The day under an x, snapped to a whole day and kept inside the window. */
export function dateForX(win: Pick<TimelineWindow, 'start' | 'end'>, x: number): string {
  const day = rawDateForX(win, x);
  if (day < win.start) return win.start;
  if (day > win.end) return win.end;
  return day;
}

/**
 * The day under an x, snapped to a whole day, or null outside the window: a
 * drop past the drawn months springs back rather than writing the edge.
 */
export function dateForXInWindow(win: Pick<TimelineWindow, 'start' | 'end'>, x: number): string | null {
  const day = rawDateForX(win, x);
  return day < win.start || day > win.end ? null : day;
}

function rawDateForX(win: Pick<TimelineWindow, 'start'>, x: number): string {
  const n = Math.round(x / TIMELINE_DAY_PX);
  return addDaysStr(win.start, Number.isFinite(n) ? n : 0);
}

/** The window's width in world px. */
export function timelineWidth(win: TimelineWindow): number {
  return (daysBetween(win.start, win.end) + 1) * TIMELINE_DAY_PX;
}

/**
 * Whether a goal may take this target: a target before the goal's own start
 * is the inverted range the goal rules refuse (`targetOn < startsOn`).
 */
export function targetAllowed(goal: Pick<Goal, 'startsOn'>, day: string): boolean {
  return !goal.startsOn || toDateOnly(goal.startsOn) <= toDateOnly(day);
}

/** Where a card sits on the Timeline, and why. */
export type TimelinePlace =
  | { lane: 'repeats' }
  | { lane: 'goals'; day: string }
  | { lane: 'dated'; day: string; until?: string; what: 'next' | 'season' }
  | { lane: 'none' };

/** The earliest open one-off's start day, today or later. */
export function nextDatedStep(card: AtlasCard, todayStr: string): string | undefined {
  const today = toDateOnly(todayStr);
  let best: string | undefined;
  for (const m of card.members) {
    if (m.state !== 'open' || isRecurring(m.item)) continue;
    const d = 'startDate' in m.item && m.item.startDate ? toDateOnly(m.item.startDate) : undefined;
    if (!d) continue;
    const at = d < today ? today : d;
    if (!best || at < best) best = at;
  }
  return best;
}

export function timelinePlace(
  card: AtlasCard,
  todayStr: string,
  seasonsById: ReadonlyMap<string, Season>,
): TimelinePlace {
  if (card.kind === 'routine') return { lane: 'repeats' };
  if (card.kind === 'goal') return card.targetOn ? { lane: 'goals', day: toDateOnly(card.targetOn) } : { lane: 'none' };
  if (card.kind === 'season') {
    const s = seasonsById.get(card.id);
    const from = s?.startsOn ? toDateOnly(s.startsOn) : undefined;
    const to = s?.endsOn ? toDateOnly(s.endsOn) : undefined;
    if (!from && !to) return { lane: 'none' };
    return { lane: 'dated', day: from ?? toDateOnly(todayStr), until: to, what: 'season' };
  }
  const next = nextDatedStep(card, todayStr);
  return next ? { lane: 'dated', day: next, what: 'next' } : { lane: 'none' };
}

/** The earliest and latest goal targets: the window must reach both. */
export function goalTargetSpan(places: Iterable<TimelinePlace>): { earliest?: string; latest?: string } {
  let earliest: string | undefined;
  let latest: string | undefined;
  for (const p of places) {
    if (p.lane !== 'goals') continue;
    if (!earliest || p.day < earliest) earliest = p.day;
    if (!latest || p.day > latest) latest = p.day;
  }
  return { earliest, latest };
}

/** The latest date anything on the Timeline wants shown (the window's end). */
export function latestTimelineDate(places: Iterable<TimelinePlace>): string | undefined {
  let latest: string | undefined;
  for (const p of places) {
    const d = p.lane === 'goals' ? p.day : p.lane === 'dated' ? (p.until ?? p.day) : undefined;
    if (d && (!latest || d > latest)) latest = d;
  }
  return latest;
}
