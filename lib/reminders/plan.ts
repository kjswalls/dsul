/**
 * plan.ts — what the iPhone arms, and what it takes back out of the shade.
 *
 * On the phone the per-item cue, its snooze and the end-of-day review are
 * LOCAL notifications (memory/plans/reminders-platforms.md §2.3, Phase 2): the
 * OS holds the triggers, so a cue rings offline and on the minute, and the
 * server's tick skips this device for those kinds (design decision 18, one
 * scheduler per device). This module decides the set of requests: given the
 * planner as the phone last saw it, what is in its shade, and one instant, it
 * answers which UNNotificationRequests should be pending, under which
 * identifiers, with which triggers and words, and which delivered ones are now
 * stale. The hosted scheduler (ios/Dsul/Notifications) diffs that against
 * what is pending; DsulCore's ReminderPlan.swift is this file's twin, held to
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
 * THE SHAPES, and why each is what it is. Two rules bind them. A phone left
 * alone must not fall silent (decision 23): a one-off fires once and does not
 * launch the app, so a standing trigger swapped for a bare one-off rings once
 * and then nothing until dsul opens. And every ring lands on its own minute,
 * on a day the item occurs and, as far as the plan can see, still wants
 * doing: a 07:30 cue that rings at 14:00 is a different, worse intervention
 * wearing its name (due.ts, REMINDER_GRACE_MINUTES), and one on a day the
 * grid hides is the app arguing with a decision the user made. A repeating
 * trigger cannot be told when to stop, so where the two rules meet, the
 * second wins and the phone goes quiet instead (What is left, below).
 *
 *   · A cadence with a calendar (daily; one weekday; a day of the month) is
 *     ONE repeating calendar trigger under `dsul-item-<id>`, which counts once
 *     against the 64-pending cap however often it rings. A day of the month
 *     after the 28th is missing from the shorter months, where occursOn
 *     clamps to their last day, so its trigger rings in the long months and
 *     the next clamped day is a one-off beside it, under `#next`.
 *   · Two to six weekdays (weekdays, weekends, custom) are one repeating
 *     calendar trigger per weekday, `dsul-item-<id>#<weekday>`.
 *   · A slot STANDS only while its own next ring is the next wanted cue on its
 *     days AND every ring it makes in the LAPSE_DAYS after that one, and the
 *     ring after it however far off, wants doing too. Otherwise it is HELD:
 *     today is already done, skipped, tallied, paused or season-inactive and
 *     its cue is still to come; a pause or a season not yet begun covers its
 *     next ring; or the plan can already see an unwanted day ahead of it (a
 *     season's last day, a skip or a tick entered for a later day). A held
 *     weekday of a split is a one-off at that weekday's next wanted cue,
 *     under the same `#<weekday>`, and the other weekdays stand or are held
 *     by the same rule. A held DAILY slot splits into seven, `#1` … `#7`,
 *     likewise: a habit ticked before its cue keeps six standing triggers and
 *     one one-off a week out, and one whose season ends on Thursday has
 *     one-offs up to Thursday and nothing after.
 *     A held lone weekday or day of the month has no other day to stand on
 *     and is the one-off series below (§2.3: "monthly habits … keep a one-off
 *     and add a second only while under budget"). The first plan after
 *     whatever held a slot puts its calendar trigger back.
 *   · NO repeating interval trigger, which is where this departs from
 *     decision 23's letter. UNTimeIntervalNotificationTrigger has no start
 *     date: a repeating one fires `seconds` after it is ADDED and then every
 *     `seconds`, so it can first ring at the next wanted cue or repeat every
 *     24 hours, never both. Anchored at the cue its period is the time to the
 *     cue (24 to 48 hours for a daily habit ticked early, ten days for a pause
 *     of ten), so every ring after the first lands hours off its time, skips
 *     days, and for a weekday slot lands on days the habit does not occur,
 *     where a Done would credit a day nothing was due. With a 24-hour period it
 *     rings at the minute it was planned, and inside a pause.
 *   · One-offs only where no cadence exists to stand on, or the one there is
 *     is held with nothing else to stand on: a dated task; a series whose
 *     start, today or later, is not one of its repeat days (anchoredSeriesOn
 *     counts its start day off its rule, a day no calendar trigger rings; one
 *     that starts on a repeat day stands, held until it begins); a cue time
 *     in the zone's changeover minutes (clock.ts changeoverMinutes: 01:00–
 *     02:59 in New York, none at all in Kolkata), so no repeating trigger sits
 *     on a minute a daylight-saving night skips or plays twice; a held lone
 *     weekday or day of the month. Each gets the next wanted cue under
 *     `dsul-item-<id>` and the one after under `#next`, so a phone left alone
 *     does not go quiet at once.
 *   · A snooze is a one-off under `dsul-item-<id>#snooze`, never the item's
 *     own identifier, so the standing trigger stays armed beside it. It
 *     belongs to its day: one that would ring past that day's local midnight
 *     has expired (snooze.ts ringsOnDay), as it has on the server.
 *   · A cue whose minute has come and is still inside its window, on a device
 *     that has not rung it, rings now (`#now`): a reminder set at 07:35 for
 *     07:30 has no trigger left to fire today, and the server would still
 *     send it until 08:00. Never while a snooze from today is pending, armed
 *     here or expired at midnight: either way the user said "not now".
 *   · The review is a standing daily trigger under `dsul-eod`, held as a daily
 *     cue is: reviewed today before its hour, it splits into `dsul-eod#1` …
 *     `#7`, today's weekday a one-off a week out. A review hour in the
 *     changeover minutes is one-offs, `dsul-eod` and `#next`. It has no
 *     catch-up: the dock's line (lib/eod.ts isEodOwed) already asks.
 *
 * THE SHADE. A delivered notification is withdrawn when the day it is about
 * no longer wants doing: done, skipped or paused on any device since it rang;
 * its item gone or no longer one that reminds; reminders switched off on this
 * iPhone; for the review, that day reviewed (whenever and wherever the review
 * was answered) or the review switched off; or a snooze armed for that day,
 * which replaces it. The day is the notification's own dateStr, or else the
 * local day it was delivered on. Nothing else is touched: a Monday cue still
 * open stays in the shade when Wednesday's is ticked.
 *
 * What is left. The rules above trade a ring on a hidden day for silence, and
 * these are the silences, each lasting until dsul next plans (opened, or woken
 * in the background when iOS allows):
 *   · a held weekday of a split rings once, at its next wanted cue: a daily
 *     ticked before its cue is quiet on that weekday from two weeks on. A
 *     pause, or a season not yet begun, holds every weekday whose next ring
 *     it covers, so a pause of a week or more quiets the whole item from a
 *     week after it ends;
 *   · a held lone weekday rings twice, a week apart, a held day of the month
 *     twice, a month apart, and a series not yet begun from an off-rule start
 *     twice;
 *   · a cue or review hour in the zone's changeover minutes rings twice, a
 *     day apart;
 *   · a day of the month after the 28th rings in every long month and in the
 *     next short one, then not in the short ones;
 *   · a slot held by an unwanted day ahead rings once (a split's weekday) or
 *     twice, however far off that day is; and an unwanted day further than
 *     LAPSE_DAYS past a slot's next ring, and past the ring after it, is left
 *     to a plan in between, so a phone that plans nothing in the month before
 *     a season ends rings after it;
 *   · a split the budget cut short stands on the weekdays it kept.
 * Settings says it as "ticking early, a pause, a season, or a cue in the hour
 * the clocks change can quiet this iPhone's cue until dsul next opens".
 *
 * Pure: the instant comes in as `nowMs`, never from the clock here, and
 * nothing reads a store. That is what lets one function be the plan on two
 * platforms and a fixture file the proof that they agree.
 */

import { getItemTypeConfig, isRemindable, itemTypeName } from '../item-registry'
import { isRecurring, shouldShowOnDate } from '../recurrence'
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
  REMINDER_GRACE_MINUTES,
  sentKeyFor,
  streakOf,
  wantsDoingOn,
  type ReminderCandidate,
} from './due'
import { EOD_COPY, reminderCopy, type TimeFormat } from './copy'
import { addDays, changeoverMinutes, inMinuteRun, instantOf, localClock, weekdayOf } from './clock'
import { ringsOnDay } from './snooze'

/**
 * How many PENDING requests a plan may hold: 60 of the OS's 64.
 *
 * A catch-up (trigger `now`) is delivered the moment it is added and never
 * sits pending, so it is not counted. The four left over are slack, not a
 * reserve anything spends: a snooze tapped between two plans is added by the
 * delegate before the next plan counts it, and the system drops the requests
 * with the latest fire dates once an app is past 64, silently, which is the
 * failure this exists to keep the plan from ever reaching.
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

/** How far ahead a next wanted cue is looked for: a year, as firstRepeatDayFrom does. */
const HORIZON_DAYS = 366

/**
 * How far past a slot's next ring its later rings must want doing for it to
 * stand: a month, so a weekday's next four rings and a day of the month's
 * next one are inside it. A slot's following ring is checked even when it is
 * further off (the 31st's after a short month, up to 61 days on). An unwanted
 * day further off than both is left to a plan in between. The trade is
 * Kirby's to move: longer, and a season with an end date holds its habits'
 * slots (one-offs, which go quiet without a plan) for longer before it ends;
 * shorter, and a phone that goes that long without planning rings on the
 * days after it.
 */
const LAPSE_DAYS = 31

/**
 * How far ahead a zone's changeovers are looked for: longer than a year by
 * the week a changeover's date moves from one year to the next, so every
 * changeover a standing trigger will meet before the plan's searches run out
 * is in it, whichever day of the year the plan falls on.
 */
const CHANGEOVER_DAYS = 400

export type PlannedKind = 'cue' | 'snoozed' | 'catchUp' | 'eod'

/**
 * A trigger, in UNNotificationTrigger's own terms, so the hosted scheduler
 * maps each case to one initializer without deciding anything.
 *
 *   · calendar: UNCalendarNotificationTrigger(dateMatching: hour, minute and,
 *     when set, weekday or day, repeats: true). `weekday` is DateComponents'
 *     own: 1 = Sunday … 7 = Saturday, which is repeatDays + 1.
 *   · at: a one-off, UNCalendarNotificationTrigger with the full date
 *     (year, month, day, hour, minute), repeats: false.
 *   · afterMs: a one-off UNTimeIntervalNotificationTrigger, `ms` after the
 *     plan's instant (a snooze is a duration from a tap, not a wall time).
 *     Added later than the plan's instant, add it with firesAt minus the
 *     moment of adding.
 *   · now: no trigger at all; delivered at once, and never pending.
 *
 * There is no repeating interval: see the header for why it cannot be both
 * anchored at a cue and periodic.
 */
export type PlannedTrigger =
  | { type: 'calendar'; hour: number; minute: number; weekday?: number; day?: number; repeats: true }
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
   * link names it (the day it invites, never the day it is answered). A
   * calendar trigger only ever rings on its slot's own days, so that day is
   * one the item occurs on; whether it still wants doing there (done
   * elsewhere since, paused since the plan) is the delegate's to ask with
   * wantsDoingOn before it sends a Done.
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
 *   · over-budget: the item lost a request to the budget other than a
 *     second one-off (`#next`): its first, its snooze, or a weekday of its
 *     split. `kept` is how many of its cue requests remain (0: none). No
 *     itemId: the review, and `kept` counts the review's own.
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

/**
 * One notification in the shade, as getDeliveredNotifications reports it.
 * Any app's identifiers may be passed; only dsul's are ever withdrawn.
 */
export interface PlanDelivered {
  /** The request's identifier. */
  id: string
  /** UNNotification.date, epoch ms: when it was delivered. */
  deliveredAtMs: number
  /** Its userInfo's dateStr, when it carried one. */
  dateStr?: string
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
   * no snooze and no catch-up, and withdraws every cue in the shade; the
   * review has its own switch.
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
  /** What is in the shade now. Absent, nothing is withdrawn. */
  delivered?: readonly PlanDelivered[]
  graceMinutes?: number
  budget?: number
}

export interface NotificationPlan {
  /** Every request that should be pending (or, `now`, delivered), ordered by firesAt, then id. */
  requests: PlannedRequest[]
  /**
   * Identifiers to remove from the DELIVERED notifications, sorted: each one
   * of `delivered` that is stale (see the header's THE SHADE). Pending
   * requests are the diff's business, never this.
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

/**
 * The review's identifiers, in the same order as an item's: its standing
 * trigger (or its next one-off), its seven weekdays while it is held, and its
 * second one-off.
 */
export function eodIdentifiers(): string[] {
  return [
    EOD_IDENTIFIER,
    ...[1, 2, 3, 4, 5, 6, 7].map((weekday) => `${EOD_IDENTIFIER}#${weekday}`),
    `${EOD_IDENTIFIER}#next`,
  ]
}

/** The item a dsul identifier belongs to, or null for one that is not an item's. */
function itemIdOf(id: string): string | null {
  const prefix = itemIdentifier('')
  if (!id.startsWith(prefix)) return null
  const rest = id.slice(prefix.length)
  const hash = rest.indexOf('#')
  const itemId = hash < 0 ? rest : rest.slice(0, hash)
  return itemId && identifiers(itemId).includes(id) ? itemId : null
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

/** What one item, or the review, asks of the budget: its requests, soonest first. */
interface Ask {
  /** The item's id; absent for the review. */
  itemId?: string
  requests: PlannedRequest[]
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

const byFireThenId = (a: PlannedRequest, b: PlannedRequest) =>
  a.firesAt - b.firesAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const EVERY_WEEKDAY = [0, 1, 2, 3, 4, 5, 6] as const

/** One slot per weekday of `days` (0 = Sunday … 6), each under `<base>#<1 … 7>`. */
function weekdaySlots(base: string, days: readonly number[]): Slot[] {
  return days.map((w) => ({ id: `${base}#${w + 1}`, weekday: w + 1, rings: (d: string) => weekdayOf(d) === w }))
}

/** Every day, under `base`: the daily slot, an item's or the review's. */
const dailySlot = (base: string): Slot => ({ id: base, rings: () => true })

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
  days = HORIZON_DAYS,
): Cue | null {
  for (let i = 0; i < days; i += 1) {
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
function slotsOf(item: Item, today: string, timezone: string): Slot[] | 'oneOffs' {
  if (!isRecurring(item)) return 'oneOffs'
  if (getItemTypeConfig(itemTypeName(item)).dateAnchored) {
    const startDate = 'startDate' in item && item.startDate ? toDateOnly(item.startDate) : undefined
    // Undated occurs on no day (the one-offs find none); a start still to come
    // off the rule is a day no calendar trigger rings.
    if (!startDate) return 'oneOffs'
    if (startDate >= today && !shouldShowOnDate(item, startDate, timezone)) return 'oneOffs'
  }

  const base = itemIdentifier(item.id)
  const repeats = item as Repeats
  const weekdays = (days: readonly number[] | undefined): Slot[] => {
    const set = [...new Set((days ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
    if (set.length === 7) return [dailySlot(base)]
    if (set.length === 1) return [{ id: base, weekday: set[0] + 1, rings: (d) => weekdayOf(d) === set[0] }]
    return weekdaySlots(base, set)
  }

  switch (repeats.repeatFrequency) {
    case 'daily':
      return [dailySlot(base)]
    case 'weekdays':
      return weekdays([1, 2, 3, 4, 5])
    case 'weekends':
      return weekdays([0, 6])
    case 'weekly':
    case 'custom':
      return weekdays(repeats.repeatDays)
    case 'monthly': {
      const day = repeats.repeatMonthDay
      if (typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 31) {
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
 * Every item, and the review, asks for its requests, soonest first, and the
 * budget is spent in passes so it goes where it matters most: first the
 * review's soonest request (so the review is never absent while it is on),
 * then live snoozes (each asked for by name), then catch-ups (free: never
 * pending); then ONE request per item, soonest first, so every item rings at
 * its next cue before any item has a second; then everyone's others, the
 * review's among them, one at a time in the order they ring, so a short
 * budget gives every held daily its next few days rather than some their
 * week and the rest one day. An item, or the review, that loses anything but
 * a second one-off (`#next`) gets an over-budget note.
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

  // The minutes no repeating trigger may sit on here: those the zone's
  // daylight-saving changeovers skip or play twice.
  const changeovers = changeoverMinutes(timezone, nowMs, CHANGEOVER_DAYS)
  const onChangeover = (minutes: number) => changeovers.some((run) => inMinuteRun(minutes, run))

  const fixed: PlannedRequest[] = []
  const asks: Ask[] = []
  let reviewAsk: PlannedRequest[] = []
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

  /**
   * How one cadence, an item's or the review's, asks the budget. `once` makes
   * its one-off for a cue and `standing` its calendar trigger for a slot; the
   * rest is the same for both (see the header).
   */
  const cadence = (
    base: string,
    minutes: number,
    wanted: (dateStr: string) => boolean,
    gap: (dateStr: string) => void,
    once: (id: string, c: Cue) => PlannedRequest,
    standing: (slot: Slot, at: number) => PlannedRequest,
  ) => {
    /**
     * How many days from today none wants doing, or null when none does
     * within the horizon. Every search for a wanted cue starts there, so an
     * item paused for months is walked through once, not once per slot.
     */
    let unwantedDays: number | null | undefined
    const leadIn = (): number | null => {
      if (unwantedDays === undefined) {
        unwantedDays = null
        for (let i = 0; i < HORIZON_DAYS; i += 1) {
          if (wanted(addDays(today, i))) {
            unwantedDays = i
            break
          }
        }
      }
      return unwantedDays
    }
    /** The next cue `accept` takes on a day that wants doing, searched as from today. */
    const nextWanted = (accept: (dateStr: string) => boolean): Cue | null => {
      const skip = leadIn()
      if (skip === null) return null
      return nextCue(addDays(today, skip), minutes, timezone, nowMs, (d) => accept(d) && wanted(d), gap, HORIZON_DAYS - skip)
    }

    /** The next wanted cue under `base` and, when there is one, the one after under `#next`. */
    const series = (): PlannedRequest[] => {
      const first = nextWanted(() => true)
      if (!first) return []
      const second = nextCue(addDays(first.dateStr, 1), minutes, timezone, nowMs, wanted, gap)
      return second ? [once(base, first), once(`${base}#next`, second)] : [once(base, first)]
    }

    /**
     * Does every ring `s` makes in the LAPSE_DAYS after `from` want doing,
     * and its following ring too when that is further off (a trigger on the
     * 31st rings again two months on when the next month is short)?
     */
    const keepsWanting = (s: Slot, from: string) => {
      let rang = false
      for (let i = 1; i <= HORIZON_DAYS && (i <= LAPSE_DAYS || !rang); i += 1) {
        const dateStr = addDays(from, i)
        if (!s.rings(dateStr)) continue
        if (!wanted(dateStr)) return false
        rang = true
      }
      return true
    }

    /**
     * One slot: its calendar trigger while that trigger's own next ring is
     * the next wanted cue on its days and its rings after it want doing too;
     * else (held) a one-off at that cue under the slot's own identifier; else
     * nothing (no wanted cue within the horizon: paused with no end, a season
     * over for good).
     */
    const slot = (s: Slot): PlannedRequest | null => {
      const next = nextWanted(s.rings)
      if (!next) return null
      const rings = nextCue(today, minutes, timezone, nowMs, s.rings)
      return rings && rings.dateStr === next.dateStr && keepsWanting(s, next.dateStr)
        ? standing(s, rings.at)
        : once(s.id, next)
    }

    /** What standing `slots` ask: one request per slot, a held daily's seven, or the series. */
    const stand = (slots: readonly Slot[]): PlannedRequest[] => {
      if (slots.length !== 1) return slots.flatMap((s) => slot(s) ?? [])
      const [only] = slots
      const own = slot(only)
      // A day of the month after the 28th with none of its own days wanted
      // can still have a clamped one, which the series finds.
      if (!own) return only.day !== undefined && only.day > 28 ? series() : []
      if (own.trigger.type !== 'calendar') {
        // A lone weekday or day of the month has no other day to stand on.
        if (only.weekday !== undefined || only.day !== undefined) return series()
        // A daily slot splits, so the days that still want it keep standing.
        return weekdaySlots(base, EVERY_WEEKDAY).flatMap((w) => slot(w) ?? [])
      }
      if (only.day !== undefined && only.day > 28) {
        // The shorter months' clamped day, which a trigger on the 31st never rings.
        const clamped = nextWanted((d) => !only.rings(d))
        if (clamped) return [own, once(`${base}#next`, clamped)]
      }
      return [own]
    }

    return { series, stand }
  }

  /* ── The review ────────────────────────────────────────────────────── */

  const eod = input.eod
  if (eod?.enabled) {
    const minutes = eodMinutesOfDay(eod.time)
    if (minutes === null) {
      notes.push({ code: 'bad-time', value: eod.time })
    } else {
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
      const plan = cadence(
        EOD_IDENTIFIER,
        minutes,
        // Owed is lib/eod.ts's isEodOwed, minus the hour: any day not already
        // recorded as reviewed.
        (dateStr) => dateStr !== eod.lastReviewDate,
        gapReporter(minutes),
        (id, c) => review(id, { type: 'at', dateStr: c.dateStr, hhmm: hhmm(minutes) }, c.at, c.dateStr),
        (slot, at) => review(slot.id, calendarTrigger(minutes, slot.weekday), at),
      )
      reviewAsk = (onChangeover(minutes) ? plan.series() : plan.stand([dailySlot(EOD_IDENTIFIER)])).sort(byFireThenId)
    }
  }

  /* ── The items ─────────────────────────────────────────────────────── */

  /** The day each item's armed snooze belongs to: it replaces that day's cue in the shade. */
  const snoozedDay = new Map<string, string>()

  if (input.remindersEnabled) {
    const snoozeOf = new Map((input.snoozes ?? []).map((s) => [s.itemId, s]))
    const items = [...input.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    for (const item of items) {
      if (!isRemindable(item)) continue
      const at = 'reminderTime' in item ? item.reminderTime : undefined
      const minutes = minutesOfDay(at)
      if (minutes === null && at) notes.push({ code: 'bad-time', itemId: item.id, value: at })

      // One plan asks about the same days many times over (the series, each
      // slot, each slot's later rings), and an item under a pause asks about
      // every day of a year: wantsDoingOn once per day is enough.
      const answers = new Map<string, boolean>()
      const wanted = (dateStr: string) => {
        let answer = answers.get(dateStr)
        if (answer === undefined) {
          answer = wantsDoingOn(item, dateStr, ctx)
          answers.set(dateStr, answer)
        }
        return answer
      }

      const snooze = snoozeOf.get(item.id)
      const wantedToday = wanted(today)
      const snoozeId = `${itemIdentifier(item.id)}#snooze`

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
      // dueReminders: one for another day never rings, and one already
      // matured has rung (or the server's tick took it). PENDING is a snooze
      // for today still to come. It is armed only while the item still wants
      // doing today (one on something answered since would re-ask it) and
      // only if it rings before that day's local midnight: the web's Snooze
      // stores the tap plus fifteen minutes with no gate, so one tapped at
      // 23:55 arrives here as 00:10 tomorrow, and the server, whose scan reads
      // the snooze's day, would never ring it. Not gated on a cue time:
      // Snooze can be tapped on a last call, about an item with none. An
      // instant nobody can read is no snooze at all, as hasMatured reads it.
      const untilMs = snooze === undefined ? Number.NaN : Date.parse(snooze.until)
      const pending =
        snooze !== undefined && snooze.date === today && Number.isFinite(untilMs) && !hasMatured(snooze.until, nowMs)
      if (pending && wantedToday && ringsOnDay(untilMs, timezone, snooze.date)) {
        fixed.push(cue(snoozeId, 'snoozed', { type: 'afterMs', ms: untilMs - nowMs }, untilMs, snooze.date))
        snoozedDay.set(item.id, snooze.date)
      }

      if (minutes === null) continue

      // Armed inside its own window: the minute has come, so no trigger is
      // left to ring today, and the server would still be sending it. Never
      // while a snooze from today is pending, armed or expired at midnight:
      // either is the user's word on when to ask again.
      if (
        !pending &&
        wantedToday &&
        isWithinWindow(minutes, nowMinutes, grace) &&
        !sent.has(sentKeyFor(today, at as string))
      ) {
        fixed.push(cue(`${itemIdentifier(item.id)}#now`, 'catchUp', { type: 'now' }, nowMs, today))
      }

      const plan = cadence(
        itemIdentifier(item.id),
        minutes,
        wanted,
        gapReporter(minutes, item.id),
        (id, c) => cue(id, 'cue', { type: 'at', dateStr: c.dateStr, hhmm: at as string }, c.at, c.dateStr),
        (slot, firesAt) => cue(slot.id, 'cue', calendarTrigger(minutes, slot.weekday, slot.day), firesAt),
      )
      const slots = onChangeover(minutes) ? 'oneOffs' : slotsOf(item, today, timezone)
      const requests = slots === 'oneOffs' ? plan.series() : plan.stand(slots)
      if (requests.length) asks.push({ itemId: item.id, requests: requests.sort(byFireThenId) })
    }
  }

  /* ── The budget ────────────────────────────────────────────────────── */

  const taken: PlannedRequest[] = []
  let pendingCount = 0
  const short = new Set<string>()
  let reviewShort = false
  /** Take `request` if it fits; a catch-up always does, since it is never pending. */
  const take = (request: PlannedRequest) => {
    if (request.trigger.type !== 'now') {
      if (pendingCount >= budget) return false
      pendingCount += 1
    }
    taken.push(request)
    return true
  }
  /** Take `request`, or note its owner short unless it was only a second one-off. */
  const place = (request: PlannedRequest) => {
    if (take(request) || request.id.endsWith('#next')) return
    if (request.kind === 'eod') reviewShort = true
    else short.add(request.itemId as string)
  }

  // The review's soonest first (it is never absent), then snoozes (the user
  // asked for each one by name), then catch-ups; each by when it rings.
  if (reviewAsk.length) place(reviewAsk[0])
  const rank: Record<PlannedKind, number> = { eod: 0, snoozed: 1, catchUp: 2, cue: 3 }
  fixed.sort((a, b) => rank[a.kind] - rank[b.kind] || byFireThenId(a, b))
  for (const request of fixed) place(request)

  asks.sort((a, b) => byFireThenId(a.requests[0], b.requests[0]))
  for (const ask of asks) place(ask.requests[0])

  const others = [reviewAsk, ...asks.map((ask) => ask.requests)].flatMap((requests) => requests.slice(1))
  for (const request of others.sort(byFireThenId)) place(request)

  if (reviewShort) notes.push({ code: 'over-budget', kept: taken.filter((r) => r.kind === 'eod').length })
  for (const itemId of [...short].sort()) {
    const kept = taken.filter((r) => r.itemId === itemId && r.kind === 'cue').length
    notes.push({ code: 'over-budget', itemId, kept })
  }

  /* ── The shade ─────────────────────────────────────────────────────── */

  const withdraw = new Set<string>()
  const eodIds = new Set(eodIdentifiers())
  const itemById = new Map(input.items.map((item) => [item.id, item]))
  for (const delivered of input.delivered ?? []) {
    // The day it is about: its own, or the local day it rang on.
    let day: string
    if (delivered.dateStr !== undefined && DAY_PATTERN.test(delivered.dateStr)) {
      day = delivered.dateStr
    } else if (Number.isFinite(delivered.deliveredAtMs)) {
      day = localClock(new Date(delivered.deliveredAtMs), timezone).dateStr
    } else {
      continue
    }

    if (eodIds.has(delivered.id)) {
      // Answered: the review recorded for that day or a later one (lib/eod.ts
      // reviewedDay files a review finished after midnight under the night it
      // was for, so the invitation it answered is that night's).
      if (eod && (!eod.enabled || (eod.lastReviewDate !== null && eod.lastReviewDate >= day))) {
        withdraw.add(delivered.id)
      }
      continue
    }

    const itemId = itemIdOf(delivered.id)
    if (itemId === null) continue
    const item = itemById.get(itemId)
    const stale =
      !input.remindersEnabled ||
      item === undefined ||
      !isRemindable(item) ||
      !wantsDoingOn(item, day, ctx) ||
      (snoozedDay.get(itemId) === day && delivered.id !== `${itemIdentifier(itemId)}#snooze`)
    if (stale) withdraw.add(delivered.id)
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
