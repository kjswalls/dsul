/**
 * clock.ts — a zone's wall clock, read both ways.
 *
 * `localClock` answers "what day and minute is it for this user?" from an
 * instant: the scan's question, moved here from lib/reminders/scan.ts (which
 * re-exports it) so that code with no server in reach can ask it too. The
 * iPhone's notification plan (plan.ts) and its snooze gate (snooze.ts) run on
 * the phone through their Swift twins, and a module that imported the scan to
 * read a clock would drag the database client in behind it.
 *
 * `instantOf` answers the other way round: "when is 07:30 on the 10th, here?"
 * A cue is a wall-clock appointment and an armed notification is an instant,
 * so the plan has to cross between the two for every request it makes. It is
 * the one crossing where daylight saving can bite, and it bites in both
 * directions: a spring-forward night has a local half hour that never happens,
 * and a fall-back night has one that happens twice. `changeoverMinutes` says
 * which minutes of the day those are in a zone, so the plan can keep its
 * repeating triggers off them.
 *
 * Pure: nothing here reads the clock; every instant comes in as an argument.
 * Day arithmetic is done on yyyy-MM-dd strings through UTC, never through a
 * zone, because a calendar day is a label and adding one to a label must not
 * depend on where the runtime happens to be.
 */

import { minutesOfDay } from './due'

export interface LocalClock {
  dateStr: string
  nowMinutes: number
  nowIso: string
  nowMs: number
}

/**
 * The user's own day and minute.
 *
 * `hourCycle: 'h23'` rather than `hour12: false`, which is not the same thing:
 * the latter leaves the cycle to the locale and some ICU builds answer midnight
 * as "24", which parses to 1440 and silently puts every user an entire day
 * outside every window. Naming the cycle removes the question.
 */
export function localClock(now: Date, timezone: string): LocalClock {
  const { minute, day } = clockFormatters(timezone)
  const hhmm = minute.format(now)
  const dateStr = day.format(now)
  return {
    dateStr,
    nowMinutes: minutesOfDay(hhmm) ?? 0,
    nowIso: now.toISOString(),
    nowMs: now.getTime(),
  }
}

/**
 * localClock's two formatters, one pair per zone. Building an
 * Intl.DateTimeFormat costs a hundred times what formatting with one does,
 * and the plan reads the clock once per delivered notification. A zone the
 * runtime does not know throws here, every time, as it did uncached.
 */
const clockFormatterCache = new Map<string, { minute: Intl.DateTimeFormat; day: Intl.DateTimeFormat }>()

function clockFormatters(timezone: string) {
  let f = clockFormatterCache.get(timezone)
  if (!f) {
    f = {
      minute: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
      day: new Intl.DateTimeFormat('en-CA', { timeZone: timezone }),
    }
    clockFormatterCache.set(timezone, f)
  }
  return f
}

const DAY_MS = 86_400_000

/** yyyy-MM-dd plus `days`, as calendar arithmetic with no zone in sight. */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/**
 * 0 = Sunday … 6 = Saturday: the convention `repeatDays` and
 * lib/recurrence.ts use. A label's weekday, read in UTC so no zone moves it.
 */
export function weekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** One formatter per zone: building them is the expensive part of a read. */
const wallFormatters = new Map<string, Intl.DateTimeFormat>()

function wallFormatter(timezone: string): Intl.DateTimeFormat {
  let f = wallFormatters.get(timezone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    wallFormatters.set(timezone, f)
  }
  return f
}

/**
 * The zone's wall clock at `ms`, written as if that wall clock were UTC, to
 * the whole second. `% 24` for the same reason localClock names its cycle.
 */
function wallAsUtc(ms: number, timezone: string): number {
  const parts = wallFormatter(timezone).formatToParts(new Date(ms))
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
}

/** The zone's offset from UTC at `ms`, in milliseconds (wall minus UTC). */
function offsetAt(ms: number, timezone: string): number {
  return wallAsUtc(ms, timezone) - Math.floor(ms / 1000) * 1000
}

/**
 * The instant (epoch milliseconds) the zone's wall clock reads `minutes` past
 * midnight on `dateStr`, or null when it never does.
 *
 * Null is the spring-forward answer: on 2026-03-08 in Los Angeles the clock
 * goes from 01:59 to 03:00, so 02:30 that day is no instant at all. Mapping it
 * to 03:30 instead would fire a cue at a time nobody chose, which is what the
 * server's own window refuses to do (habit-reminders.md, "DST spring-forward
 * can drop one cue"), so the phone drops the same cue the server would.
 *
 * On a fall-back night the time happens twice, and this is the EARLIER of the
 * two: the first moment the wall reads it, which is also when the server's
 * window first opens and its claim then holds the second one off.
 *
 * Found by trying the offsets in force a day either side of the naive guess
 * (each zone changes its offset at most once in two days), and keeping only
 * the instants whose wall clock really reads the time asked for. When the two
 * agree, no changeover is near and the one offset is the answer.
 */
export function instantOf(dateStr: string, minutes: number, timezone: string): number | null {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number)
  const naive = Date.UTC(y, m - 1, d, 0, minutes)
  if (!Number.isFinite(naive)) return null
  const before = offsetAt(naive - DAY_MS, timezone)
  const after = offsetAt(naive + DAY_MS, timezone)
  if (before === after) return naive - before
  const found = [naive - before, naive - after]
    .filter((t) => wallAsUtc(t, timezone) === naive)
    .sort((a, b) => a - b)
  return found[0] ?? null
}

/**
 * A run of wall-clock minutes of the day: `length` minutes from `start`
 * (minutes past midnight), wrapping past midnight when it runs over.
 */
export interface MinuteRun {
  start: number
  length: number
}

const MINUTES_PER_DAY = 1440

/** Is `minutes` (past midnight) inside `run`? */
export function inMinuteRun(minutes: number, run: MinuteRun): boolean {
  return (((minutes - run.start) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY < run.length
}

/**
 * The wall-clock minutes the zone's changeovers touch in the `days` days
 * from `fromMs`: for each change of offset, the minutes it skips (a spring
 * forward) or plays twice (a fall back), as runs sorted by start, each once.
 * Empty for a zone whose offset never changes in that time (Asia/Kolkata,
 * UTC, Asia/Tokyo), which is most of the world.
 *
 * In New York both changeovers fall at 02:00, so the runs are 02:00–02:59
 * (skipped in March) and 01:00–01:59 (played twice in November). Santiago
 * changes at midnight, 00:00–00:59 in September and 23:00–23:59 in April;
 * Lord Howe Island moves half an hour. The plan arms no repeating trigger on
 * any of these minutes (plan.ts), since what one does with a minute that is
 * skipped or doubled is not something Apple documents.
 *
 * Found by reading the offset once a day and, where two readings differ,
 * bisecting to the first whole second of the new one. A zone changes its
 * offset at most once in a day, the same assumption instantOf makes.
 */
export function changeoverMinutes(timezone: string, fromMs: number, days: number): MinuteRun[] {
  const runs = new Map<string, MinuteRun>()
  let lo = Math.floor(fromMs / 1000) * 1000
  let before = offsetAt(lo, timezone)
  for (let i = 1; i <= days; i += 1) {
    const hi = lo + DAY_MS
    const after = offsetAt(hi, timezone)
    if (after !== before) {
      // offsetAt(a) is the old offset and offsetAt(b) is not, a whole number of seconds apart.
      let a = lo
      let b = hi
      while (b - a > 1000) {
        const mid = a + Math.max(1, Math.floor((b - a) / 2000)) * 1000
        if (offsetAt(mid, timezone) === before) a = mid
        else b = mid
      }
      const changed = offsetAt(b, timezone)
      const low = b + Math.min(before, changed)
      const high = b + Math.max(before, changed)
      const lowMinute = Math.floor(low / 60_000)
      const length = Math.ceil((high - lowMinute * 60_000) / 60_000)
      const run: MinuteRun = length >= MINUTES_PER_DAY
        ? { start: 0, length: MINUTES_PER_DAY }
        : { start: ((lowMinute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY, length }
      runs.set(`${run.start}+${run.length}`, run)
    }
    before = after
    lo = hi
  }
  return [...runs.values()].sort((x, y) => x.start - y.start || x.length - y.length)
}
