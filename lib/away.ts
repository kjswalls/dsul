/**
 * away.ts — vacation mode, the outermost layer of "is this item live?"
 *
 * A trip is ONE row (supabase/migrations/071_away_periods.sql), never a pause
 * written onto every item. {@link awayHoldOn} is asked first by
 * isItemActiveOn and inactiveItemIdsOn (lib/active.ts), so every surface that
 * already asks those (the grid, reminders, last calls, stakes, day done, the
 * agent API) follows a trip without knowing trips exist.
 *
 * The layer is CONJUNCTIVE, unlike seasons: a season is one more reason for an
 * item to appear, a trip is a reason for everything to rest. Only the keep
 * list answers back.
 *
 * Three rules carry the design (memory/plans/vacation-mode.md):
 *
 * - Only what falls on a day rests: recurring items and dated tasks. An
 *   undated braindump item is never held, so the braindump stays usable.
 * - The end is EXCLUSIVE, like an item's pausedUntil: "until the 20th" is
 *   back ON the 20th. Read-side, so a trip ends with no cron and no write.
 * - Coming back is gentle: `returns` holds a later return day for some habits
 *   (the easing-back waves), so a habit stays resting until its wave.
 *
 * Pure and string-based like active.ts: callers pass the day. It imports no
 * module that imports active.ts, so the two never form a cycle.
 */

import { isRecurring } from './recurrence';
import type { Item, Routine } from './planner-types';

/** What keeps going on a trip. An item is kept if it, its project, its parent or any routine holding it is listed. */
export interface AwayKeep {
  itemIds: readonly string[];
  routineIds: readonly string[];
  projectIds: readonly string[];
}

export interface AwayPeriod {
  id: string;
  /** First day away, yyyy-MM-dd in the user's zone. */
  startsOn: string;
  /** The day you are back, EXCLUSIVE. Omitted = open-ended. */
  endsOn?: string;
  keep: AwayKeep;
  /** itemId → the day it comes back, when later than endsOn (the easing waves). */
  returns: Readonly<Record<string, string>>;
  /** itemId → the day it was due, for tasks moved to the braindump on return. */
  fromTrip: Readonly<Record<string, string>>;
  /** When those tasks were moved. Unset = not yet. */
  settledAt?: string;
}

export const EMPTY_KEEP: AwayKeep = { itemIds: [], routineIds: [], projectIds: [] };

const day = (s: string) => s.slice(0, 10);

/** Does the trip list this item, its parent, its project or a routine holding it? */
export function isKeptOn(
  item: Pick<Item, 'id' | 'project'> & { projectId?: string; parentItemId?: string },
  period: AwayPeriod,
  routines: readonly Routine[] | undefined,
): boolean {
  const keep = period.keep;
  if (keep.itemIds.includes(item.id)) return true;
  if (item.parentItemId && keep.itemIds.includes(item.parentItemId)) return true;
  if (item.projectId && keep.projectIds.includes(item.projectId)) return true;
  if (keep.routineIds.length && routines?.length) {
    for (const r of routines) {
      if (keep.routineIds.includes(r.id) && r.itemIds.includes(item.id)) return true;
    }
  }
  return false;
}

/** Only what falls on a day rests. An undated one-shot (the braindump) never does. */
export function isDayBound(item: Item): boolean {
  return isRecurring(item) || !!dateOf(item);
}

/** A one-shot's day. Habits carry no startDate (they fall on every matching day). */
const dateOf = (item: Item): string | undefined => (item as { startDate?: string }).startDate;

/** The day `item` is back from `period`: its wave if it has a later one, else the trip's end. */
export function returnDayOf(itemId: string, period: AwayPeriod): string | undefined {
  if (!period.endsOn) return undefined;
  const wave = period.returns[itemId];
  return wave && day(wave) > day(period.endsOn) ? day(wave) : day(period.endsOn);
}

/**
 * The trip holding `item` on `dateStr`, or undefined when no trip does.
 *
 * Held means: the day is inside the trip (or inside the item's easing wave
 * after it), the item falls on days, and nothing on the keep list claims it.
 */
export function awayHoldOn(
  item: Item,
  dateStr: string,
  away: readonly AwayPeriod[] | undefined,
  routines: readonly Routine[] | undefined,
): AwayPeriod | undefined {
  if (!away?.length) return undefined;
  if (!isDayBound(item)) return undefined;
  const d = day(dateStr);
  for (const period of away) {
    if (d < day(period.startsOn)) continue;
    const back = returnDayOf(item.id, period);
    if (back && d >= back) continue;
    if (isKeptOn(item as Item & { projectId?: string; parentItemId?: string }, period, routines)) continue;
    return period;
  }
  return undefined;
}

/** The trip you are on today: started, and not yet at its end day. */
export function currentAway(away: readonly AwayPeriod[] | undefined, todayStr: string): AwayPeriod | undefined {
  const d = day(todayStr);
  return away?.find((p) => day(p.startsOn) <= d && (!p.endsOn || d < day(p.endsOn)));
}

/** A trip that has not started yet. There is at most one trip at a time, future ones included. */
export function upcomingAway(away: readonly AwayPeriod[] | undefined, todayStr: string): AwayPeriod | undefined {
  const d = day(todayStr);
  return away?.find((p) => day(p.startsOn) > d);
}

/** The trip you are easing back from: over, but with a habit whose wave has not come yet. */
export function easingAway(away: readonly AwayPeriod[] | undefined, todayStr: string): AwayPeriod | undefined {
  const d = day(todayStr);
  return away?.find((p) => !!p.endsOn && d >= day(p.endsOn) && d < lastReturnDay(p));
}

/** The last day anything comes back from `period` (its end when there are no waves). */
export function lastReturnDay(period: AwayPeriod): string {
  let last = period.endsOn ? day(period.endsOn) : '9999-12-31';
  for (const wave of Object.values(period.returns)) if (day(wave) > last) last = day(wave);
  return last;
}

// ── Coming back gently ──────────────────────────────────────────────────────

/**
 * How many days the comeback is spread over: as many days as you were away, up
 * to a week. A day or less comes back all at once.
 */
export function easeDays(startsOn: string, endsOn: string): number {
  const length = daysBetween(startsOn, endsOn);
  if (length <= 1) return 0;
  return Math.min(length, 7);
}

/**
 * The easing waves for a trip ending on `endsOn`: itemId → its return day.
 *
 * Only habits and other recurring items ease back; a task comes back on the
 * end day (and is moved to the braindump if it came due while away). The
 * easiest come first: the longest streaks and the smallest daily targets lead,
 * because a streak that waited is the strongest pull back in. The first one
 * returns on the end day itself; the rest are split into waves on days 2, 4
 * and 6 of the ease (or the last day, for a short one).
 *
 * Written when the trip starts and again on "I'm back", so the waves are
 * stored, never re-derived from counters that move while you're away.
 */
export function planReturns(
  items: readonly Item[],
  period: Pick<AwayPeriod, 'startsOn' | 'keep'>,
  endsOn: string,
  routines: readonly Routine[] | undefined,
): Record<string, string> {
  const ease = easeDays(period.startsOn, endsOn);
  if (ease === 0) return {};
  const probe: AwayPeriod = { id: '', startsOn: period.startsOn, endsOn, keep: period.keep, returns: {}, fromTrip: {} };
  const habits = items
    .filter((i) => isRecurring(i as Item & { repeatFrequency?: string }))
    .filter((i) => !isKeptOn(i as Item & { projectId?: string; parentItemId?: string }, probe, routines))
    .sort(easiestFirst);
  if (habits.length <= 1) return {};

  let offsets = [2, 4, 6].filter((o) => o < ease);
  if (offsets.length === 0) offsets = [ease - 1];
  const rest = habits.slice(1);
  const per = Math.ceil(rest.length / offsets.length);
  const out: Record<string, string> = {};
  rest.forEach((item, i) => {
    out[item.id] = addDays(endsOn, offsets[Math.min(Math.floor(i / per), offsets.length - 1)]);
  });
  return out;
}

function easiestFirst(a: Item, b: Item): number {
  const streak = (i: Item) => (i as { streak?: number }).streak ?? 0;
  const target = (i: Item) => (i as { timesPerDay?: number }).timesPerDay ?? 1;
  return (
    streak(b) - streak(a) ||
    target(a) - target(b) ||
    a.title.localeCompare(b.title) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * What to keep by default: habits done on each of the last 30 days, weekends
 * included (meds, plants). The things you never skip are the ones a trip
 * should not stop.
 */
export function suggestKeeps(items: readonly Item[], todayStr: string): string[] {
  const days = Array.from({ length: 30 }, (_, i) => addDays(day(todayStr), -(i + 1)));
  return items
    .filter((i) => isRecurring(i as Item & { repeatFrequency?: string }))
    .filter((i) => {
      const done = new Set((i as { completedDates?: string[] }).completedDates ?? []);
      return days.every((d) => done.has(d));
    })
    .map((i) => i.id);
}

/**
 * The tasks that came due while you were away and still want doing: pending
 * one-shots dated inside the trip and not kept. On return they move to the
 * braindump under "From the trip" instead of piling onto the first day back.
 */
export function tripTasks(
  items: readonly Item[],
  period: AwayPeriod,
  routines: readonly Routine[] | undefined,
): Item[] {
  if (!period.endsOn) return [];
  const start = day(period.startsOn);
  const end = day(period.endsOn);
  return items.filter((i) => {
    if (isRecurring(i as Item & { repeatFrequency?: string })) return false;
    const date = dateOf(i);
    if (i.status !== 'pending' || !date) return false;
    const d = day(date);
    if (d < start || d >= end) return false;
    return !isKeptOn(i as Item & { projectId?: string; parentItemId?: string }, period, routines);
  });
}

// ── Calendar arithmetic (local: container-schedule.ts imports active.ts) ────

const parts = (d: string) => day(d).split('-').map(Number) as [number, number, number];

/** `date` plus `n` calendar days, on Date.UTC so no process zone can move it. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** Whole days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = parts(a);
  const [yb, mb, db] = parts(b);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}
