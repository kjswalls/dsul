/**
 * due.ts — the ONE definition of "does dsul owe you a nudge right now?"
 *
 * Written the way lib/active.ts and lib/overdue.ts were, and for the same
 * reason: this predicate is about to be asked by the reminder scan, the last
 * call, every delivery channel and (from Tier 3) the nightly settlement, and
 * four copies would drift. Everything here is pure and string-based — nothing
 * reads a store, nothing calls `new Date()` for "now". Callers pass the day and
 * the minute, which is what makes it testable and timezone-stable.
 *
 * It deliberately does NOT re-derive what "still wants doing" means. That is
 * isOpenLoopOn + isItemActiveOn in lib/active.ts, and reimplementing either
 * here would be exactly the drift the reminder is worst placed to survive: a
 * notification about a habit the grid has already hidden is not a cosmetic bug,
 * it is the app nagging someone about something they explicitly paused.
 *
 * See memory/plans/habit-reminders.md.
 */

import { getItemTypeConfig, isRemindable, itemTypeName } from '../item-registry'
import { isItemActiveOn, isOpenLoopOn, type ActivationContext } from '../active'
import { anchoredSeriesOn, isRecurring, shouldShowOnDate } from '../recurrence'
import { toDateOnly } from '../overdue'
import type { Item } from '../planner-types'

/**
 * How long after its stated time a cue may still land.
 *
 * Not zero, because the scan runs on a schedule and a missed tick (a deploy, a
 * cold start, a platform hiccup) would otherwise drop the day silently. Not
 * "any time later today" either: the evidence this feature is built on is about
 * pairing a behavior with a stable context, and a 07:30 cue delivered at 14:00
 * is no longer that cue — it is a different, worse intervention wearing its
 * name. Thirty minutes covers several missed ticks and still lands inside the
 * moment the user chose.
 */
export const REMINDER_GRACE_MINUTES = 30

/** Minutes in a day — the clamp that keeps a late cue from wrapping midnight. */
const MINUTES_PER_DAY = 1440

/**
 * 'HH:mm' → minutes since local midnight, or null if it isn't a time.
 *
 * Null rather than NaN or 0: '0' is a real time (00:00) and NaN silently makes
 * every comparison false, which is how a malformed row becomes a reminder that
 * never fires and nobody can explain. Callers must handle the null.
 */
export function minutesOfDay(hhmm: string | undefined | null): number | null {
  if (!hhmm) return null
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(hhmm)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * Is `nowMinutes` inside [target, target + grace) on the SAME local day?
 *
 * The window is clamped to midnight rather than wrapped, which is the one place
 * this deliberately diverges from the eod-notify cron it is modelled on. That
 * route wraps (`windowEnd >= 1440 ? now >= start || now < end - 1440`), and a
 * wrap plus a same-day dedupe stamp is a double-send: a 23:50 cue fires and
 * stamps day N, then at 00:05 the window is still open, the local date has
 * rolled to N+1, the stamp no longer matches, and the same reminder goes out
 * again — at ten past midnight, for yesterday's habit.
 *
 * Clamping costs a late-evening reminder some of its grace and nothing else.
 */
export function isWithinWindow(
  targetMinutes: number,
  nowMinutes: number,
  graceMinutes: number = REMINDER_GRACE_MINUTES,
): boolean {
  const end = Math.min(targetMinutes + graceMinutes, MINUTES_PER_DAY)
  return nowMinutes >= targetMinutes && nowMinutes < end
}

/**
 * Does this item have an occurrence on `dateStr` at all?
 *
 * Transcribed from deriveDayItems' day filter (lib/day-items.ts) with the
 * per-type branch resolved through the registry instead of through which
 * projection array the row arrived in — the scan reads `items` directly and has
 * no tasks[]/habits[] split to lean on.
 *
 * The three cases, and why each is what it is:
 *   - recurring + date-anchored: its start date, then the recurrence rule
 *     (anchoredSeriesOn), because an anchored item must not render before it
 *     starts and a date the user picked is a day it happens.
 *   - recurring + un-anchored (habits): the recurrence rule alone. Migrated
 *     habits have start_date NULL by design (019) and gating them on it would
 *     silence every reminder on every habit that predates the unification.
 *   - one-shot: exactly its own date.
 */
export function occursOn(item: Item, dateStr: string, userTimezone: string): boolean {
  const day = toDateOnly(dateStr)
  const startDate = 'startDate' in item ? item.startDate : undefined
  const anchored = getItemTypeConfig(itemTypeName(item)).dateAnchored

  if (isRecurring(item)) {
    // An ANCHORED type with no startDate occurs on no day at all — the same
    // rule deriveDayItems applies with `if (!task.startDate) return false`
    // BEFORE its recurrence branch. Treating it as "every matching day"
    // instead would nudge daily about an item no view renders: unscheduling a
    // recurring task to the braindump clears startDate and leaves
    // repeatFrequency alone, which is exactly that state.
    if (anchored && !startDate) return false
    if (anchored) return anchoredSeriesOn(item, toDateOnly(startDate as string), day, userTimezone)
    return shouldShowOnDate(item, day, userTimezone)
  }

  if (!startDate) return false
  return toDateOnly(startDate) === day
}

/**
 * Does this item still want doing on `dateStr`?
 *
 * Occurrence AND open loop AND not suppressed — the full question, in the order
 * that answers cheapest-first. This is the predicate every nudge is gated on;
 * anything that fails it must produce silence, not a softer message.
 */
export function wantsDoingOn(
  item: Item,
  dateStr: string,
  ctx: ActivationContext,
): boolean {
  return (
    occursOn(item, dateStr, ctx.userTimezone) &&
    isOpenLoopOn(item, dateStr) &&
    isItemActiveOn(item, dateStr, ctx)
  )
}

/** One item that has earned a nudge, with the copy inputs already resolved. */
export interface ReminderCandidate {
  item: Item
  /** The cue's stated local time, 'HH:mm'. */
  at: string
  /** The implementation-intention phrase, when the user wrote one. */
  anchor?: string
  /** This delivery is a matured snooze rather than the day's first cue. */
  snoozed: boolean
}

export interface ScanClock {
  /** The user's local day, yyyy-MM-dd. */
  dateStr: string
  /** Minutes since the user's local midnight. */
  nowMinutes: number
  /**
   * The same moment as an absolute ISO instant.
   *
   * Both are carried because the two questions genuinely differ: a cue is a
   * wall-clock appointment ("07:30 wherever I am") and a snooze is a duration
   * from an instant ("15 minutes from when I tapped it"). Deriving either from
   * the other needs the timezone at every call site, which is how one of them
   * ends up an hour wrong twice a year.
   */
  nowIso: string
  /**
   * The same instant in epoch milliseconds.
   *
   * Carried rather than derived at the comparison site because the value it is
   * compared against comes back from PostgREST, which renders a timestamptz as
   * `…+00:00` while `toISOString()` produces `…Z`. Comparing those two as
   * STRINGS is lexicographic, so it happens to work for UTC and silently stops
   * working the moment the connection reports any other offset. Numbers have no
   * such failure mode.
   */
  nowMs: number
  graceMinutes?: number
}

/**
 * One row as the scan sees it: the item, plus the bookkeeping that is NOT part
 * of the item.
 *
 * `sentKey` is items.reminder_sent_key and is deliberately absent from the Item
 * schema. It is the scan's own dedupe stamp, written by a cron and read by
 * nothing a user can see — putting it in taskShape/habitShape would enrol it in
 * TASK_FIELDS, which means undo patches would carry it, the legacy projections
 * would publish it to every agent, and a redo could hand a stale stamp back and
 * silently re-arm a cue that had already fired.
 */
export interface ScanRow {
  item: Item
  /** items.reminder_sent_key — 'yyyy-MM-ddTHH:mm'. See {@link sentKeyFor}. */
  sentKey?: string
  /** items.reminder_snooze_until — an ISO instant, or absent. */
  snoozeUntil?: string
  /** items.reminder_snooze_date — the local day the snooze belongs to. */
  snoozeDate?: string
}

/**
 * The dedupe stamp for one cue: the user's local day AND the time it was for.
 *
 * The day alone cannot survive retiming — moving a cue to later the same day
 * would be silently swallowed until tomorrow — and the obvious workaround
 * (clear the stamp whenever reminder_time is written) fires the cue a SECOND
 * time on any unrelated edit, because the item dialog's whole-item save names
 * every field. Putting the time IN the key answers both at once.
 *
 * The local day rather than UTC is the only comparison that survives travel:
 * stamping UTC re-arms every cue for anyone who crosses a date boundary
 * mid-afternoon.
 */
export function sentKeyFor(dateStr: string, at: string): string {
  return `${dateStr}T${at}`
}

/**
 * Every item whose cue is due in this tick and has not already been sent.
 */
export function dueReminders(
  rows: readonly ScanRow[],
  clock: ScanClock,
  ctx: ActivationContext,
): ReminderCandidate[] {
  const out: ReminderCandidate[] = []
  for (const { item, sentKey, snoozeUntil, snoozeDate } of rows) {
    if (!isRemindable(item)) continue
    const at = 'reminderTime' in item ? item.reminderTime : undefined
    const target = minutesOfDay(at)

    // A matured snooze OVERRIDES both the day stamp and the window. Both would
    // otherwise reject it, and rightly so for a first delivery: the day's cue
    // has already been sent and its window has usually closed. Re-opening
    // exactly that state is what the user asked for when they tapped Snooze.
    //
    // It is gated on the snooze's OWN day, which is what keeps that override
    // from becoming a bug. Without the day gate a stale snooze — armed, then
    // orphaned because the user completed the habit in the app rather than on
    // the notification — fires at the first tick after midnight on the next day
    // the item is due AND stamps that day, suppressing the real cue. See
    // migration 032's note on reminder_snooze_date.
    const snoozed =
      snoozeDate === clock.dateStr && hasMatured(snoozeUntil, clock.nowMs)

    if (snoozed) {
      // Deliberately NOT gated on reminderTime. Snooze can be tapped on a
      // LAST CALL, whose item may carry no per-item cue at all; requiring one
      // would accept the tap and then silently never honour it.
      if (!wantsDoingOn(item, clock.dateStr, ctx)) continue
      out.push({
        item,
        at: at ?? '',
        anchor: ('reminderAnchor' in item ? item.reminderAnchor : undefined) || undefined,
        snoozed: true,
      })
      continue
    }

    if (target === null) continue
    if (sentKey === sentKeyFor(clock.dateStr, at as string)) continue
    if (!isWithinWindow(target, clock.nowMinutes, clock.graceMinutes)) continue
    if (!wantsDoingOn(item, clock.dateStr, ctx)) continue
    out.push({
      item,
      at: at as string,
      anchor: ('reminderAnchor' in item ? item.reminderAnchor : undefined) || undefined,
      snoozed: false,
    })
  }
  // Earliest cue first — a tick that catches two after an outage should read in
  // the order the day was planned, not in row order.
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

/**
 * What the streak-at-risk last call is allowed to name.
 *
 * Streak-bearing types only, which is a copy decision as much as a data one:
 * the last call's whole frame is what today's miss COSTS, and loss aversion is
 * the mechanism it borrows. A dated task has nothing to lose by the same
 * argument, so including one would turn a sharp message back into the generic
 * evening nag every other surface already declines to send.
 *
 * Derived from `counters.streak` rather than a second registry flag: two flags
 * that must agree are one refactor away from disagreeing.
 *
 * Ordered by streak descending — biggest loss first, because the list is
 * truncated in the copy and the truncation should drop the cheapest item.
 */
export function lastCallItems(
  items: readonly Item[],
  dateStr: string,
  ctx: ActivationContext,
): Item[] {
  return items
    .filter((item) => {
      if (!isRemindable(item)) return false
      if (!getItemTypeConfig(itemTypeName(item)).counters.streak) return false
      return wantsDoingOn(item, dateStr, ctx)
    })
    .sort((a, b) => streakOf(b) - streakOf(a))
}

/** Stored streak, or 0 for a type that has no counter. */
export function streakOf(item: Item): number {
  return 'streak' in item && typeof item.streak === 'number' ? item.streak : 0
}

/**
 * Has a stored snooze instant arrived?
 *
 * Parsed rather than string-compared — see ScanClock.nowMs. An unparseable
 * value answers false: a snooze nobody can read is a snooze that never fires,
 * which is the safe direction (the stale sweep clears it) where the opposite
 * would deliver at every tick forever.
 */
export function hasMatured(snoozeUntil: string | undefined, nowMs: number): boolean {
  if (snoozeUntil === undefined) return false
  const at = Date.parse(snoozeUntil)
  return Number.isFinite(at) && at <= nowMs
}
