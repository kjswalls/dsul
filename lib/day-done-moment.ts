/**
 * The day done moment: the words the aurora shows when the last thing on today
 * is ticked (components/celebrate/day-done-aurora.tsx), the once-a-day gate,
 * and the one live read both it and the day done sound ask after a tick.
 *
 * Copy is Kirby's pick from the round on 2026-11-07 (/mnt/project-files/
 * day-done/copy.html): lowercase and a little silly, like the sign-in headline
 * (lib/login-headlines.ts), never a guess at the time or the day. The headline
 * is drawn at random from the pool each time it plays.
 */

import { useAwayStore } from './away-store'
import { dayDoneCount } from './day-done'
import { usePlannerStore } from './planner-store'
import { toDateStr } from './recurrence'

export const DAY_DONE_HEADLINES: readonly string[] = [
  'all done.',
  'nothing left. you did that.',
  'look at you, finishing things.',
  'not one box left. suspicious.',
  'done and done and done.',
  'everything’s done. go be a person.',
]

/** The lime chip beside the date while today stays cleared. */
export const DAY_DONE_CHIP = 'perfect'

/** Along the bottom of the aurora. It also closes by itself. */
export const DAY_DONE_HINT = 'click or press any key to close'
/** The same on a touch screen, where there is no key to press. */
export const DAY_DONE_HINT_TOUCH = 'tap anywhere to close'

/** One of them. `random` is injectable so tests can pin the pick. */
export function pickDayDoneHeadline(random: () => number = Math.random): string {
  return DAY_DONE_HEADLINES[Math.floor(random() * DAY_DONE_HEADLINES.length)] ?? DAY_DONE_HEADLINES[0]
}

/** "5 of 5 done": every counted thing was done, so both numbers are the same. */
export function dayDoneCountLine(n: number): string {
  return `${n} of ${n} done`
}

/**
 * Today's date and, when today is cleared, how many things it was; read live
 * from the stores, for a listener that has just heard a tick. Null count while
 * anything on today is still open.
 */
export function readTodayDone(): { today: string; count: number | null } {
  const planner = usePlannerStore.getState()
  const tz = planner.userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const today = toDateStr(new Date(), tz)
  const count = dayDoneCount(planner.items, today, {
    userTimezone: tz,
    routines: planner.routines,
    seasons: planner.seasons,
    away: useAwayStore.getState().periods,
  })
  return { today, count }
}

const PLAYED_KEY = 'dsul-day-done-played'

/**
 * Claims today's aurora: true the first time it is asked for `dateStr` on this
 * device, false after. Kept in localStorage so a reload, an untick and a tick
 * again does not play it twice. Storage that throws (a private window) falls
 * back to this page's memory.
 */
let playedInMemory: string | null = null
export function claimDayDone(dateStr: string): boolean {
  let last: string | null = playedInMemory
  try {
    last = window.localStorage.getItem(PLAYED_KEY) ?? playedInMemory
  } catch {
    // keep the in-memory answer
  }
  if (last === dateStr) return false
  playedInMemory = dateStr
  try {
    window.localStorage.setItem(PLAYED_KEY, dateStr)
  } catch {
    // the in-memory claim still holds for this page
  }
  return true
}
