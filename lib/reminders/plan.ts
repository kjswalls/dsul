/**
 * plan.ts — what the iPhone arms, and what it takes back out of the shade.
 *
 * On the phone the per-item cue, its snooze and the end-of-day review are
 * LOCAL notifications (memory/plans/reminders-platforms.md §2.3, Phase 2): the
 * OS holds the triggers, so a cue rings offline and on the minute, and the
 * server's tick skips this device for those kinds (design decision 18, one
 * scheduler per device). This module decides the set of requests: given the
 * planner as the phone last saw it and one instant, it answers which
 * UNNotificationRequests should be pending, under which identifiers, with
 * which triggers and words, and which delivered ones are now stale. The
 * hosted scheduler (ios/Dsul/Notifications) diffs that against what is
 * pending and delivered; DsulCore's Plan.swift is this file's twin, held to
 * it by tests/fixtures/day/notification-plan.json.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never decides whether an item wants
 * doing: that is wantsDoingOn (due.ts), asked once per candidate day, so the
 * phone and the server cannot disagree about a paused habit. It never writes
 * a sentence: the cue's words are reminderCopy's and the review's EOD_COPY,
 * verbatim. And it plans NO last call (design decision 24): the last call's
 * body is the day's state at its minute, and a list worked out at the last
 * plan can name a habit already done elsewhere since, which is the one scold
 * the copy contract cannot send. The phone has no last call until APNs.
 *
 * THE SHAPES, and why each is what it is (decision 23: a standing trigger is
 * never replaced by a bare one-off, because a one-off fires once and does not
 * launch the app, so the phone would fall silent after it until dsul opens):
 *
 *   · A cadence with a calendar (daily; one weekday; a day of the month up to
 *     the 28th) is ONE repeating calendar trigger under `dsul-item-<id>`,
 *     which counts once against the 64-pending cap however often it rings.
 *   · Two to six weekdays (weekdays, weekends, custom) are one repeating
 *     calendar trigger per weekday, `dsul-item-<id>#<weekday>`.
 *   · When the trigger's own next ring is not the next WANTED cue (today is
 *     already done, skipped, tallied, paused or season-inactive, and its cue
 *     is still to come), the slot keeps its identifier and becomes a
 *     repeating interval trigger whose first ring is the next wanted cue. The
 *     first plan after today's cue time puts the calendar trigger back,
 *     because from then on the two agree again.
 *   · One-offs only where no cadence exists to stand on: a dated task; a
 *     series that has not begun (an anchored recurring item whose start is
 *     today or later, since its start day need not be a repeat day); a day of
 *     the month after the 28th (a calendar trigger on the 31st skips every
 *     shorter month, where occursOn clamps to the last day); any cue time in
 *     01:00–03:59, so no repeating trigger sits on a daylight-saving boundary;
 *     a weekday set the budget cannot hold. Each gets the next wanted cue
 *     under `dsul-item-<id>` and, while the budget allows, the one after
 *     under `#next`, so a phone left alone does not go quiet at once.
 *   · A snooze is a one-off under `dsul-item-<id>#snooze`, never the item's
 *     own identifier, so the standing trigger stays armed beside it; arming
 *     one withdraws the delivered cue it replaces.
 *   · A cue whose minute has come and is still inside its window, on a device
 *     that has not rung it, rings now (`#now`): a reminder set at 07:35 for
 *     07:30 has no trigger left to fire today, and the server would still
 *     send it until 08:00.
 *   · The review is a standing daily trigger under `dsul-eod` that is never
 *     removed while it is switched on: reviewed today before its hour, it
 *     becomes the same interval trigger, first ringing at tomorrow's hour.
 *     A review hour in 01:00–03:59 is one-offs, for the cues' reason. It has
 *     no catch-up: the dock's line (lib/eod.ts isEodOwed) already asks.
 *
 * Pure: the instant comes in as `nowMs`, never from the clock here, and
 * nothing reads a store. That is what lets one function be the plan on two
 * platforms and a fixture file the proof that they agree.
 */

import { getItemTypeConfig, isRemindable, itemTypeName } from '../item-registry'
import { isRecurring } from '../recurrence'
import { toDateOnly } from '../overdue'
// The review's own parser, as in lib/reminders/scan.ts: user_settings'
// eod_review_time has no CHECK, so '9:00' is a value a row can hold, and
// due.ts's strict parser would read it as no review at all.
import { minutesOfDay as eodMinutesOfDay } from '../eod'
import type { ActivationContext } from '../active'
import type { Item, Routine, Season } from '../planner-types'
import {
  hasMatured,
  isWithinWindow,
  minutesOfDay,
  occursOn,
  REMINDER_GRACE_MINUTES,
  sentKeyFor,
  streakOf,
  wantsDoingOn,
  type ReminderCandidate,
} from './due'
import { EOD_COPY, reminderCopy, type TimeFormat } from './copy'
import { addDays, instantOf, localClock, weekdayOf } from './clock'

/**
 * How many requests a plan may hold: 60 of the OS's 64 pending.
 *
 * The four left over are slack, not a reserve anything spends: a snooze
 * tapped between two plans is added by the delegate before the next plan
 * counts it, and the system drops the requests with the latest fire dates
 * once an app is past 64, silently, which is the failure this exists to keep
 * the plan from ever reaching.
 */
export const NOTIFICATION_BUDGET = 60

/** The thread a cue and its snooze stack under on the lock screen. */
export const CUE_THREAD = 'dsul.cues'
/** The review's thread, and the last call's once APNs brings one. */
export const RITUAL_THREAD = 'dsul.rituals'
/** Done and Snooze, without authenticationRequired: lock-screen Done is the feature. */
export const CUE_CATEGORY = 'DSUL_CUE'
export const EOD_CATEGORY = 'DSUL_EOD'

/** The review's identifier. One a day at most, so a new one replaces the last in the shade. */
export const EOD_IDENTIFIER = 'dsul-eod'

/** The streak at which a cue's relevance reaches 1: a month at stake sorts first. */
export const RELEVANCE_FULL_STREAK = 30

/**
 * Cue times in [01:00, 04:00) are planned as one-offs. Daylight saving moves
 * clocks inside this band in the zones dsul's users are in (02:00 in the
 * Americas, 01:00 UTC in Europe), and what a repeating calendar trigger does
 * with a minute that is skipped or doubled is not something Apple documents.
 * A one-off at an instant this module worked out has no such question.
 */
const DST_BAND_START = 60
const DST_BAND_END = 240

/** How far ahead a next wanted cue is looked for: a year, as firstRepeatDayFrom does. */
const HORIZON_DAYS = 366

export type PlannedKind = 'cue' | 'snoozed' | 'catchUp' | 'eod'

/**
 * A trigger, in UNNotificationTrigger's own terms, so the hosted scheduler
 * maps each case to one initializer without deciding anything.
 *
 *   · calendar: UNCalendarNotificationTrigger(dateMatching: hour, minute and,
 *     when set, weekday or day, repeats: true). `weekday` is DateComponents'
 *     own: 1 = Sunday … 7 = Saturday, which is repeatDays + 1.
 *   · interval: UNTimeIntervalNotificationTrigger(timeInterval: seconds,
 *     repeats: true). Such a trigger has no start date: it first fires
 *     `seconds` after it is ADDED, then every `seconds`. So `seconds` is the
 *     time from the plan's instant to `anchorAt` (the next wanted cue), which
 *     makes the first ring land on the cue; the rings after it drift by the
 *     difference from a day (or a week) until the next plan, which restores
 *     the calendar trigger. Added later than the plan's instant, add it with
 *     `anchorAt` minus the moment of adding.
 *   · at: a one-off, UNCalendarNotificationTrigger with the full date
 *     (year, month, day, hour, minute), repeats: false.
 *   · afterMs: a one-off UNTimeIntervalNotificationTrigger, `ms` after the
 *     plan's instant (a snooze is a duration from a tap, not a wall time).
 *   · now: no trigger at all; delivered at once.
 */
export type PlannedTrigger =
  | { type: 'calendar'; hour: number; minute: number; weekday?: number; day?: number; repeats: true }
  | { type: 'interval'; seconds: number; repeats: true; anchorAt: number }
  | { type: 'at'; dateStr: string; hhmm: string }
  | { type: 'afterMs'; ms: number }
  | { type: 'now' }

/** What the notification carries back to the delegate when it is tapped or acted on. */
export interface PlannedUserInfo {
  kind: PlannedKind
  itemId?: string
  /**
   * The day it is about, when it is about exactly one. A repeating trigger
   * rings on many, so it has none, and the delegate takes the local day of
   * the notification's own date: Done credits that day, and the review's
   * link names it (the day it invites, never the day it is answered).
   */
  dateStr?: string
  /** The cue's 'HH:mm', so the delegate can record sentKeyFor(day, at) as rung. */
  at?: string
}

export interface PlannedRequest {
  /** The UNNotificationRequest identifier. See {@link identifiers}. */
  id: string
  kind: PlannedKind
  itemId?: string
  /** Set exactly when userInfo's is: the request is about one day. */
  dateStr?: string
  trigger: PlannedTrigger
  /** The instant (epoch ms) this request first rings, as planned. Order and diagnostics, not identity. */
  firesAt: number
  title: string
  body: string
  threadId: typeof CUE_THREAD | typeof RITUAL_THREAD
  /** The title again, so a collapsed stack reads "3 more from dsul · Vitamins, Reading …". */
  summaryArgument: string
  categoryId: typeof CUE_CATEGORY | typeof EOD_CATEGORY
  /** UNNotificationInterruptionLevel. Time Sensitive is Phase 4's, per item and opt-in. */
  level: 'active'
  /** UNNotificationContent.relevanceScore, 0…1: the streak at stake, the review 0. */
  relevance: number
  userInfo: PlannedUserInfo
}

/**
 * Something the plan could not do, said in a shape a log or a test can match.
 *
 *   · bad-zone: the device's zone is not one the runtime knows; nothing planned.
 *   · bad-time: a cue time (or, with no itemId, the review's hour) is not a time.
 *   · dst-gap: that day's cue falls in the hour a spring-forward skips, so it
 *     does not ring that day, as it would not from the server either.
 *   · over-budget: the item lost requests to the budget; `kept` is how many of
 *     its cue requests remain (0: none). No itemId: the review.
 */
export type PlanNote =
  | { code: 'bad-zone'; value: string }
  | { code: 'bad-time'; itemId?: string; value: string }
  | { code: 'dst-gap'; itemId?: string; dateStr: string; at: string }
  | { code: 'over-budget'; itemId?: string; kept: number }

/** A snooze as the planner payload projects it (`reminder_snooze_until/date`). */
export interface PlanSnooze {
  itemId: string
  /** An ISO instant. */
  until: string
  /** The local day the snooze belongs to, yyyy-MM-dd. */
  date: string
}

/** The end-of-day review's three settings, as the planner payload carries them. */
export interface PlanEod {
  enabled: boolean
  /** eod_review_time: 'HH:mm', or the looser 'H:mm' lib/eod.ts accepts. */
  time: string
  /** last_eod_review_date: the day the last review was FOR (lib/eod.ts reviewedDay). */
  lastReviewDate: string | null
}

export interface PlanInput {
  /** The instant of this plan, epoch milliseconds. */
  nowMs: number
  /** The device's IANA zone: a phone's cues ring where the phone is. */
  timezone: string
  /** The planner's items, deleted ones excluded. */
  items: readonly Item[]
  /** Live routines and seasons, as ActivationContext wants them. */
  routines?: readonly Routine[]
  seasons?: readonly Season[]
  timeFormat?: TimeFormat
  /**
   * habit_reminders_enabled AND this device's own switch. Off plans no cue,
   * no snooze and no catch-up; the review has its own switch.
   */
  remindersEnabled: boolean
  eod?: PlanEod | null
  snoozes?: readonly PlanSnooze[]
  /**
   * sentKeyFor(day, at) of every cue this device has already rung, or had
   * armed to ring at its minute: a trigger that was pending at 07:30 rang at
   * 07:30, whether or not the banner is still in the shade. A catch-up is
   * planned only for a cue missing from here, and the scheduler adds a
   * catch-up's key the moment it adds the request, so a second plan a second
   * later cannot ring it twice.
   */
  localSentKeys?: readonly string[]
  graceMinutes?: number
  budget?: number
}

export interface NotificationPlan {
  /** Every request that should be pending, ordered by firesAt, then id. */
  requests: PlannedRequest[]
  /**
   * Identifiers to remove from the DELIVERED notifications, sorted: the cues
   * of an item whose day is already handled, the cue a snooze replaces, and a
   * review already done. Pending requests are the diff's business, never this.
   */
  withdraw: string[]
  notes: PlanNote[]
}

/** The item's own identifier: replaces a pending cue, replaces a delivered one, withdraws. */
export function itemIdentifier(itemId: string): string {
  return `dsul-item-${itemId}`
}

/**
 * Every identifier an item can ever be under, in a fixed order: its own, one
 * per weekday (#1 Sunday … #7 Saturday), the second one-off (#next), the
 * catch-up (#now) and the snooze (#snooze).
 *
 * Every one, not only the ones its cadence uses today: a habit moved from
 * three weekdays to daily still has `#2` in the shade from this morning, and a
 * withdrawal that asked the item's current shape would leave it there.
 */
export function identifiers(itemId: string): string[] {
  const base = itemIdentifier(itemId)
  return [
    base,
    ...[1, 2, 3, 4, 5, 6, 7].map((weekday) => `${base}#${weekday}`),
    `${base}#next`,
    `${base}#now`,
    `${base}#snooze`,
  ]
}

/** The review's identifiers: its standing trigger, and its second one-off in the small hours. */
export function eodIdentifiers(): string[] {
  return [EOD_IDENTIFIER, `${EOD_IDENTIFIER}#next`]
}

/* ── Internals ─────────────────────────────────────────────────────────── */

interface Cue {
  dateStr: string
  /** The instant, epoch ms. */
  at: number
}

/** One standing calendar trigger, and the days it rings on. */
interface Slot {
  id: string
  weekday?: number
  day?: number
  rings: (dateStr: string) => boolean
}

interface Repeats {
  repeatFrequency?: string
  repeatDays?: number[]
  repeatMonthDay?: number
}

/** What one item asks of the budget. */
interface ItemAsk {
  itemId: string
  /** The one request it must have to ring at all. */
  primary: PlannedRequest
  /** Its weekday slots, which replace the primary while the budget allows. */
  upgrade?: PlannedRequest[]
  /** The one-off after the primary, while the budget allows. */
  secondary?: PlannedRequest
}

const inDstBand = (minutes: number) => minutes >= DST_BAND_START && minutes < DST_BAND_END

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

const byFireThenId = (a: PlannedRequest, b: PlannedRequest) =>
  a.firesAt - b.firesAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * The first cue at `minutes`, on a day from `fromDay` on that `accept` takes,
 * that is still to come. A day whose minute does not exist (spring forward) is
 * passed over and reported to `onGap`; nothing is moved to another minute.
 */
function nextCue(
  fromDay: string,
  minutes: number,
  timezone: string,
  nowMs: number,
  accept: (dateStr: string) => boolean,
  onGap?: (dateStr: string) => void,
): Cue | null {
  for (let i = 0; i < HORIZON_DAYS; i += 1) {
    const dateStr = addDays(fromDay, i)
    if (!accept(dateStr)) continue
    const at = instantOf(dateStr, minutes, timezone)
    if (at === null) {
      onGap?.(dateStr)
      continue
    }
    if (at > nowMs) return { dateStr, at }
  }
  return null
}

/**
 * The standing slots an item's cadence can stand on, or 'oneOffs' when it has
 * none (see the header for each case). An empty list is a cadence that rings
 * on no day at all, such as custom with no days: no request, as occursOn.
 */
function slotsOf(item: Item, minutes: number, today: string): Slot[] | 'oneOffs' {
  if (inDstBand(minutes)) return 'oneOffs'
  if (!isRecurring(item)) return 'oneOffs'
  const startDate = 'startDate' in item && item.startDate ? toDateOnly(item.startDate) : undefined
  if (getItemTypeConfig(itemTypeName(item)).dateAnchored && (!startDate || startDate >= today)) {
    return 'oneOffs'
  }

  const base = itemIdentifier(item.id)
  const repeats = item as Repeats
  const daily: Slot = { id: base, rings: () => true }
  const weekdays = (days: readonly number[] | undefined): Slot[] => {
    const set = [...new Set((days ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
    if (set.length === 7) return [daily]
    if (set.length === 1) return [{ id: base, weekday: set[0] + 1, rings: (d) => weekdayOf(d) === set[0] }]
    return set.map((w) => ({ id: `${base}#${w + 1}`, weekday: w + 1, rings: (d) => weekdayOf(d) === w }))
  }

  switch (repeats.repeatFrequency) {
    case 'daily':
      return [daily]
    case 'weekdays':
      return weekdays([1, 2, 3, 4, 5])
    case 'weekends':
      return weekdays([0, 6])
    case 'weekly':
    case 'custom':
      return weekdays(repeats.repeatDays)
    case 'monthly': {
      const day = repeats.repeatMonthDay
      if (typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 28) {
        return [{ id: base, day, rings: (d) => Number(d.slice(8, 10)) === day }]
      }
      return 'oneOffs'
    }
    default:
      return 'oneOffs'
  }
}

/**
 * Build a plan.
 *
 * Requests are chosen in passes so the budget is spent where it matters
 * most: first what must ring regardless (the review, live snoozes,
 * catch-ups), then ONE request per item, soonest first, so every item rings
 * at its next cue before any item has its whole week; then each weekday set
 * its full slots (in that order, while they fit); then the second one-offs.
 * An item that loses anything to the budget gets an over-budget note.
 */
export function planNotifications(input: PlanInput): NotificationPlan {
  const { nowMs, timezone } = input
  const notes: PlanNote[] = []

  let today: string
  let nowMinutes: number
  try {
    ;({ dateStr: today, nowMinutes } = localClock(new Date(nowMs), timezone))
  } catch {
    return { requests: [], withdraw: [], notes: [{ code: 'bad-zone', value: timezone }] }
  }

  const ctx: ActivationContext = {
    userTimezone: timezone,
    routines: input.routines,
    seasons: input.seasons,
  }
  const timeFormat = input.timeFormat ?? '12h'
  const grace = input.graceMinutes ?? REMINDER_GRACE_MINUTES
  const budget = input.budget ?? NOTIFICATION_BUDGET
  const sent = new Set(input.localSentKeys ?? [])

  const fixed: PlannedRequest[] = []
  const asks: ItemAsk[] = []
  const withdraw = new Set<string>()
  const gapsSeen = new Set<string>()

  /** Report a skipped spring-forward minute once, and only if it was still to come. */
  const gapReporter = (minutes: number, itemId?: string) => (dateStr: string) => {
    if (dateStr === today && minutes <= nowMinutes) return
    const key = `${itemId ?? ''}|${dateStr}`
    if (gapsSeen.has(key)) return
    gapsSeen.add(key)
    notes.push(itemId === undefined
      ? { code: 'dst-gap', dateStr, at: hhmm(minutes) }
      : { code: 'dst-gap', itemId, dateStr, at: hhmm(minutes) })
  }

  /* ── The review ────────────────────────────────────────────────────── */

  let eodSecondary: PlannedRequest | undefined
  const eod = input.eod
  if (eod?.enabled) {
    const minutes = eodMinutesOfDay(eod.time)
    if (minutes === null) {
      notes.push({ code: 'bad-time', value: eod.time })
    } else {
      // Owed is lib/eod.ts's isEodOwed, minus the hour: any day not already
      // recorded as reviewed. Only today can be, so only today is ever skipped.
      const wanted = (dateStr: string) => dateStr !== eod.lastReviewDate
      const gap = gapReporter(minutes)
      const review = (id: string, trigger: PlannedTrigger, firesAt: number, dateStr?: string): PlannedRequest => ({
        id,
        kind: 'eod',
        ...(dateStr === undefined ? {} : { dateStr }),
        trigger,
        firesAt,
        title: EOD_COPY.title,
        body: EOD_COPY.body,
        threadId: RITUAL_THREAD,
        summaryArgument: EOD_COPY.title,
        categoryId: EOD_CATEGORY,
        level: 'active',
        relevance: 0,
        userInfo: dateStr === undefined ? { kind: 'eod' } : { kind: 'eod', dateStr },
      })

      if (inDstBand(minutes)) {
        const first = nextCue(today, minutes, timezone, nowMs, wanted, gap)
        if (first) {
          fixed.push(review(EOD_IDENTIFIER, { type: 'at', dateStr: first.dateStr, hhmm: hhmm(minutes) }, first.at, first.dateStr))
          const second = nextCue(addDays(first.dateStr, 1), minutes, timezone, nowMs, wanted, gap)
          if (second) {
            eodSecondary = review(
              `${EOD_IDENTIFIER}#next`,
              { type: 'at', dateStr: second.dateStr, hhmm: hhmm(minutes) },
              second.at,
              second.dateStr,
            )
          }
        }
      } else {
        const rings = nextCue(today, minutes, timezone, nowMs, () => true)
        const next = nextCue(today, minutes, timezone, nowMs, wanted, gap)
        if (next) {
          fixed.push(
            rings && rings.dateStr === next.dateStr
              ? review(EOD_IDENTIFIER, calendarTrigger(minutes), rings.at)
              : review(EOD_IDENTIFIER, intervalTrigger(next.at, nowMs), next.at),
          )
        }
      }
      // Done today: the invitation in the shade has been answered.
      if (eod.lastReviewDate === today) for (const id of eodIdentifiers()) withdraw.add(id)
    }
  }

  /* ── The items ─────────────────────────────────────────────────────── */

  if (input.remindersEnabled) {
    const snoozeOf = new Map((input.snoozes ?? []).map((s) => [s.itemId, s]))
    const items = [...input.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    for (const item of items) {
      if (!isRemindable(item)) continue
      const at = 'reminderTime' in item ? item.reminderTime : undefined
      const minutes = minutesOfDay(at)
      if (minutes === null && at) notes.push({ code: 'bad-time', itemId: item.id, value: at })

      const snooze = snoozeOf.get(item.id)
      const wantedToday = wantsDoingOn(item, today, ctx)
      const own = identifiers(item.id)
      const snoozeId = `${itemIdentifier(item.id)}#snooze`

      // Handled today (done, skipped, tallied, paused, season-inactive): what
      // is in the shade about it asks for something already answered.
      if ((minutes !== null || snooze) && occursOn(item, today, timezone) && !wantedToday) {
        for (const id of own) withdraw.add(id)
      }

      const cue = (
        id: string,
        kind: PlannedKind,
        trigger: PlannedTrigger,
        firesAt: number,
        dateStr?: string,
      ): PlannedRequest => {
        const candidate: ReminderCandidate = {
          item,
          // Empty for a snooze on an item with no cue of its own (one tapped
          // on a last call), which reminderCopy reads as no time to echo.
          at: at ?? '',
          anchor: ('reminderAnchor' in item ? item.reminderAnchor : undefined) || undefined,
          snoozed: kind === 'snoozed',
        }
        const { title, body } = reminderCopy(candidate, timeFormat)
        const streak = streakOf(item)
        return {
          id,
          kind,
          itemId: item.id,
          ...(dateStr === undefined ? {} : { dateStr }),
          trigger,
          firesAt,
          title,
          body,
          threadId: CUE_THREAD,
          summaryArgument: title,
          categoryId: CUE_CATEGORY,
          level: 'active',
          relevance: streak > 0 ? Math.min(1, streak / RELEVANCE_FULL_STREAK) : 0,
          userInfo: {
            kind,
            itemId: item.id,
            ...(dateStr === undefined ? {} : { dateStr }),
            ...(at ? { at } : {}),
          },
        }
      }

      // A snooze belongs to its day (habit-reminders.md decision 8), as in
      // dueReminders: one for another day never rings, one already matured has
      // rung (or the server's tick took it), and one on an item no longer
      // wanted today would re-ask something answered. Not gated on a cue time:
      // Snooze can be tapped on a last call, about an item with none.
      let snoozed = false
      if (snooze && snooze.date === today && wantedToday && !hasMatured(snooze.until, nowMs)) {
        const untilMs = Date.parse(snooze.until)
        if (Number.isFinite(untilMs)) {
          snoozed = true
          fixed.push(cue(snoozeId, 'snoozed', { type: 'afterMs', ms: untilMs - nowMs }, untilMs, snooze.date))
          // The snooze replaces whichever of the item's cues is in the shade.
          for (const id of own) if (id !== snoozeId) withdraw.add(id)
        }
      }

      if (minutes === null) continue

      // Armed inside its own window: the minute has come, so no trigger is
      // left to ring today, and the server would still be sending it. Never
      // beside a live snooze, which is the user's word on when to ask again.
      if (
        !snoozed &&
        wantedToday &&
        isWithinWindow(minutes, nowMinutes, grace) &&
        !sent.has(sentKeyFor(today, at as string))
      ) {
        fixed.push(cue(`${itemIdentifier(item.id)}#now`, 'catchUp', { type: 'now' }, nowMs, today))
      }

      const gap = gapReporter(minutes, item.id)
      const wanted = (dateStr: string) => wantsDoingOn(item, dateStr, ctx)
      const oneOff = (id: string, c: Cue) =>
        cue(id, 'cue', { type: 'at', dateStr: c.dateStr, hhmm: at as string }, c.at, c.dateStr)
      const oneOffs = (): Pick<ItemAsk, 'primary' | 'secondary'> | null => {
        const first = nextCue(today, minutes, timezone, nowMs, wanted, gap)
        if (!first) return null
        const second = nextCue(addDays(first.dateStr, 1), minutes, timezone, nowMs, wanted, gap)
        return {
          primary: oneOff(itemIdentifier(item.id), first),
          ...(second ? { secondary: oneOff(`${itemIdentifier(item.id)}#next`, second) } : {}),
        }
      }

      const slots = slotsOf(item, minutes, today)
      if (slots === 'oneOffs') {
        const series = oneOffs()
        if (series) asks.push({ itemId: item.id, ...series })
        continue
      }

      // Each slot: its calendar trigger when that trigger's own next ring is
      // the next wanted cue on its days, else the interval trigger anchored at
      // that cue (decision 23). A slot with no wanted cue within the horizon
      // (paused with no end, a season over for good) plans nothing.
      const planned = slots.flatMap((slot) => {
        const rings = nextCue(today, minutes, timezone, nowMs, slot.rings)
        const next = nextCue(today, minutes, timezone, nowMs, (d) => slot.rings(d) && wanted(d), gap)
        if (!next) return []
        return [
          rings && rings.dateStr === next.dateStr
            ? cue(slot.id, 'cue', calendarTrigger(minutes, slot.weekday, slot.day), rings.at)
            : cue(slot.id, 'cue', intervalTrigger(next.at, nowMs), next.at),
        ]
      })
      if (planned.length === 0) continue
      if (slots.length === 1) {
        asks.push({ itemId: item.id, primary: planned[0] })
        continue
      }
      // A weekday set rides the budget as one one-off until its slots fit.
      const series = oneOffs()
      if (series) asks.push({ itemId: item.id, ...series, upgrade: planned })
    }
  }

  /* ── The budget ────────────────────────────────────────────────────── */

  const taken: PlannedRequest[] = []
  const short = new Set<string>()
  let eodShort = false

  // The review first (it is never removed), then snoozes (the user asked for
  // each one by name), then catch-ups; each by when it rings.
  const rank: Record<PlannedKind, number> = { eod: 0, snoozed: 1, catchUp: 2, cue: 3 }
  fixed.sort((a, b) => rank[a.kind] - rank[b.kind] || byFireThenId(a, b))
  for (const request of fixed) {
    if (taken.length < budget) taken.push(request)
    else if (request.itemId) short.add(request.itemId)
    else eodShort = true
  }

  asks.sort((a, b) => byFireThenId(a.primary, b.primary))
  const placed: ItemAsk[] = []
  for (const ask of asks) {
    if (taken.length < budget) {
      taken.push(ask.primary)
      placed.push(ask)
    } else {
      short.add(ask.itemId)
    }
  }

  const upgraded = new Set<string>()
  for (const ask of placed) {
    if (!ask.upgrade) continue
    if (taken.length - 1 + ask.upgrade.length <= budget) {
      taken.splice(taken.indexOf(ask.primary), 1, ...ask.upgrade)
      upgraded.add(ask.itemId)
    } else {
      short.add(ask.itemId)
    }
  }

  const seconds = placed
    .filter((ask) => ask.secondary && !upgraded.has(ask.itemId))
    .map((ask) => ask.secondary as PlannedRequest)
  if (eodSecondary && taken.some((r) => r.id === EOD_IDENTIFIER)) seconds.push(eodSecondary)
  for (const request of seconds.sort(byFireThenId)) {
    if (taken.length < budget) taken.push(request)
  }

  if (eodShort) notes.push({ code: 'over-budget', kept: 0 })
  for (const itemId of [...short].sort()) {
    const kept = taken.filter((r) => r.itemId === itemId && r.kind === 'cue').length
    notes.push({ code: 'over-budget', itemId, kept })
  }

  return {
    requests: taken.sort(byFireThenId),
    withdraw: [...withdraw].sort(),
    notes,
  }
}

function calendarTrigger(minutes: number, weekday?: number, day?: number): PlannedTrigger {
  return {
    type: 'calendar',
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
    ...(weekday === undefined ? {} : { weekday }),
    ...(day === undefined ? {} : { day }),
    repeats: true,
  }
}

/**
 * The interval trigger whose first ring is `anchorAt`: whole seconds, rounded
 * up so it never rings before the cue, and at least the 60 a repeating
 * interval trigger must have.
 */
function intervalTrigger(anchorAt: number, nowMs: number): PlannedTrigger {
  return {
    type: 'interval',
    seconds: Math.max(60, Math.ceil((anchorAt - nowMs) / 1000)),
    repeats: true,
    anchorAt,
  }
}
