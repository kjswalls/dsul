/**
 * snooze.ts — when a snooze tapped on this device rings again, if at all.
 *
 * The server's snooze is two columns (habit-reminders.md decision 8):
 * `reminder_snooze_until`, an instant, and `reminder_snooze_date`, the day the
 * snooze belongs to, and the scan fires a matured snooze only while its day is
 * still today (dueReminders' day gate). A device that schedules its own snooze
 * (the iPhone, as a one-off under `dsul-item-<id>#snooze`; plan.ts) has to hold
 * the same gate, or a Snooze tapped at 23:55 on a 15-minute snooze rings at
 * 00:10 about a day that is over, and its Done button ticks the wrong box.
 *
 * Pure: the tap's instant comes in as `nowMs`, never from the clock here.
 */

import { localClock } from './clock'

/**
 * The instant (epoch milliseconds) a snooze of `minutes`, tapped at `nowMs`
 * on a notification about `dayStr`, should ring, or null when it should not
 * ring at all.
 *
 * Null whenever that instant is not on `dayStr` in `zone`: past its local
 * midnight a snooze expires rather than misfires ("in 15 minutes" at 23:55 is,
 * in practice, "not tonight"), and the scan, which reads the day the snooze
 * belongs to, would refuse it at maturity anyway. A notification still in the
 * shade from yesterday therefore snoozes to nothing, which is the same answer
 * the server gives it. Null, too, for anything it cannot place: a zone the
 * runtime does not know, a malformed day, or a length that is not a positive
 * number of minutes.
 *
 * The length is the caller's: the one the notification's button promises
 * (SNOOZE_MINUTES, lib/reminders/channels/push.ts, beside the button), never
 * a second number picked here.
 */
export function snoozeFireInstant(
  nowMs: number,
  minutes: number,
  zone: string,
  dayStr: string,
): number | null {
  if (!Number.isFinite(nowMs) || !Number.isFinite(minutes) || minutes <= 0) return null
  const fireMs = nowMs + minutes * 60_000
  return ringsOnDay(fireMs, zone, dayStr) ? fireMs : null
}

/**
 * Does a snooze that rings at `fireMs` still ring on `dayStr` in `zone`?
 *
 * The day gate alone, for a snooze whose instant is already fixed: one the
 * planner payload carries (`reminder_snooze_until/date`, written by the web's
 * Snooze or another device's), which plan.ts arms on this phone. That instant
 * is the tap plus SNOOZE_MINUTES with no gate of its own (/api/reminders/act
 * stores it as is), so a web Snooze tapped at 23:55 arrives as 00:10 the next
 * day and must expire here exactly as snoozeFireInstant's would. False for
 * anything it cannot place: an instant that is not finite, a zone the runtime
 * does not know, or a day not shaped yyyy-MM-dd.
 */
export function ringsOnDay(fireMs: number, zone: string, dayStr: string): boolean {
  if (!Number.isFinite(fireMs)) return false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) return false
  try {
    return localClock(new Date(fireMs), zone).dateStr === dayStr
  } catch {
    return false
  }
}
