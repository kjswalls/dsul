/**
 * scan.ts — the tick.
 *
 * Runs every few minutes, works out whose cue, last call or end-of-day review
 * is due in their own local minute, and hands each resolved nudge to
 * lib/reminders/deliver.ts. The route around it (app/api/cron/reminders) is
 * auth and a log line and nothing else, so this stays callable from a test
 * with a stubbed client and a fixed `now`.
 *
 * ONE SCAN, FOUR TIERS, per user and in this order: the EOD review (Tier 0),
 * the per-item cues (1), the streak-at-risk last call (2), the stakes
 * settlement (3). The review used to be a cron route of its own; it is a tier
 * because a second route was a second clock, a second copy of the window
 * arithmetic (it wrapped at midnight) and a second order of operations (it
 * delivered, then stamped). Something new that wants to reach a person on a
 * schedule (#220's morning check) is a tier here too, never a route:
 * tests/unit/one-cron.test.ts holds app/api/cron to this one.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not decide whether an item wants
 * doing (lib/reminders/due.ts), it does not write the words (copy.ts), and it
 * does not know a single channel's name (deliver.ts). Its whole job is the loop
 * and the bookkeeping — which is the part that has to be right about
 * timezones, and the part nothing else should have an opinion about.
 */

import { addDays, format, parseISO } from 'date-fns'
import { fetchItems, fetchRoutines, fetchSeasons } from '../db'
import { settleOneDay } from '../stakes/settle'
import type { createServiceClient } from '../supabase-service'
import {
  dueReminders,
  isWithinWindow,
  lastCallItems,
  minutesOfDay,
  REMINDER_GRACE_MINUTES,
  sentKeyFor,
  streakOf,
  type ReminderCandidate,
  type ScanRow,
} from './due'
// The review's own parser, under another name, because due.ts's is the one
// this file means by `minutesOfDay`. The two are not interchangeable: see the
// review's tier below.
import { isEodOwed, minutesOfDay as eodMinutesOfDay } from '../eod'
import { EOD_COPY, lastCallCopy, reminderCopy, type TimeFormat } from './copy'
import { deliverNudge, type DeliveryReport } from './deliver'
import type { Nudge, NudgeItem } from './nudge'
import type { ActivationContext } from '../active'
import type { Item } from '../planner-types'
import { isMissingColumn, loadChannelState } from './extension-state'
import { localClock, type LocalClock } from './clock'

type ServiceClient = ReturnType<typeof createServiceClient>

// The clock moved to ./clock (code with no server in reach reads it too); it
// is re-exported so every existing importer keeps its path.
export { localClock, type LocalClock } from './clock'

/** Minutes in a day: where every window here stops, rather than wrapping. */
const MINUTES_PER_DAY = 1440

/**
 * How often the tick runs: the five-minute schedule pg_cron holds for
 * dsul-reminders (044, re-created by 058 when missing). Not a setting; the
 * schedule is in SQL, and tests/unit/reminders-scan.test.ts holds the two to
 * each other.
 *
 * Every zone in use is a whole number of quarter hours from UTC, so a tick
 * lands on a multiple of five in every user's own minutes too, and the day's
 * last one is at 23:55 everywhere.
 */
export const TICK_MINUTES = 5

/** The day's last tick, in every user's own minutes: 23:55. */
const LAST_TICK = MINUTES_PER_DAY - TICK_MINUTES

/**
 * Where a window that is clamped at midnight must open for a tick to land in
 * it: at its own minute, or at the day's last tick if that minute is later.
 *
 * Clamped, a window opening at 23:57 is [23:57, 24:00), and no tick falls in
 * it: the last one of the day ran at 23:55, and the next is tomorrow's 00:00,
 * by which time the date has rolled and nothing about today is owed. A review,
 * a last call or a cue set to 23:56 through 23:59 (each is a native time
 * input, so any minute can be saved) would never be sent, with no note to say
 * so. Opened at 23:55 it goes a few minutes early instead, which is the better
 * of the two. All three windows open here: the review's and the last call's
 * below, the cues' through dueReminders' `latestOpening`. So does the stakes
 * settlement's threshold, which is no window but has the same gap.
 */
export function windowOpensAt(minutes: number): number {
  return Math.min(minutes, LAST_TICK)
}

/**
 * The switches that bring a user into the tick, any one of them.
 *
 * Asked twice, in two languages: here, as the user query's .or(), and in SQL,
 * where dsul_tick (058) asks the same question before it sends the request at
 * all. The two must name the same flags. A flag added here and not there is a
 * tier that never runs for anyone with only that switch on: dsul_tick finds no
 * one, never calls the route, and nothing errors (cron.job_run_details says
 * succeeded; the fail-open clause catches a column that is missing, not one
 * that was left out). So a new flag needs a new migration that redefines
 * dsul_tick's gate, and tests/unit/reminders-scan.test.ts holds the latest
 * definition to this list. On a database without 034 the user query's retry
 * drops stakes_enabled, the one flag with a migration of its own.
 *
 * 062 gave dsul_tick one more clause, deliberately NOT in this list: it also
 * wakes for any switched-on recipe with a timed trigger (user_mods), which is
 * the recipe tier's own read (lib/recipes/server/tick.ts), never this scan's.
 */
export const TICK_FLAGS = ['habit_reminders_enabled', 'stakes_enabled', 'eod_review_enabled'] as const

/**
 * The instant `endMinutes` arrives on the user's own day: when a nudge about
 * it stops being worth delivering (Nudge.expiresAtMs). Never before this tick.
 *
 * Counted from the start of the tick's minute, because `nowMinutes` is
 * truncated: counted from the tick itself, a tick that runs at 23:50:40 would
 * put midnight at 00:00:40 and hold yesterday's last call past it, which is
 * the one thing the clamp is there to stop. The minute starts at the same
 * instant in every zone in use, each being a whole number of minutes from UTC.
 *
 * An instant and not a TTL. The push transport turns it into seconds as each
 * request leaves (lib/push-send.ts), so the time the tick takes to reach a
 * user, and the device read before the send, come off the TTL instead of
 * landing after midnight.
 */
export function expiryAt(clock: LocalClock, endMinutes: number): number {
  const minuteStartMs = clock.nowMs - (clock.nowMs % 60_000)
  return Math.max(clock.nowMs, minuteStartMs + (endMinutes - clock.nowMinutes) * 60_000)
}

/**
 * When a cue stops being worth delivering: at the end of the window it was
 * found in, which is dueReminders' own (target + grace, clamped at midnight).
 * The push service then drops it at the moment the scan itself would have
 * stopped sending it.
 *
 * A matured snooze has no window. It waits for the first tick after it
 * matures, any time that day, so its grace runs from the tick that claimed it,
 * as the last call's does.
 */
function cueExpiresAt(candidate: ReminderCandidate, clock: LocalClock, grace: number): number {
  const target = candidate.snoozed ? null : minutesOfDay(candidate.at)
  return expiryAt(clock, Math.min((target ?? clock.nowMinutes) + grace, MINUTES_PER_DAY))
}

interface ReminderUserRow {
  user_id: string
  timezone: string | null
  time_format: string | null
  habit_reminders_enabled: boolean | null
  habit_last_call_enabled: boolean | null
  habit_last_call_time: string | null
  habit_last_call_date: string | null
  stakes_enabled: boolean | null
  stakes_settle_time: string | null
  stakes_settled_date: string | null
  eod_review_enabled: boolean | null
  eod_review_time: string | null
  /** yyyy-MM-dd the review was last invited: the review tier's claim. */
  last_eod_notified_date: string | null
  /** yyyy-MM-dd the review was last DONE, which retires tonight's invitation. */
  last_eod_review_date: string | null
}

/**
 * How far back a settlement will catch up.
 *
 * Not unbounded, and not zero. Zero means a deployment that was down overnight
 * silently forgives a day — a commitment device that forgets is not one.
 * Unbounded means a user who enables stakes for the first time gets their
 * entire history settled at once, which for the pledge tier is a bill for
 * months they never agreed to. A week covers a real outage and stops there.
 */
const MAX_CATCH_UP_DAYS = 7

/** Calendar arithmetic on a yyyy-MM-dd, with no timezone in sight. */
function shiftDay(dateStr: string, days: number): string {
  return format(addDays(parseISO(dateStr), days), 'yyyy-MM-dd')
}

/**
 * The days a user still owes a settlement for, oldest first.
 *
 * Always strictly BEFORE today: a day is settled once it is over, never while
 * it is still winnable.
 */
export function daysToSettle(today: string, settledThrough: string | null): string[] {
  const yesterday = shiftDay(today, -1)
  if (!settledThrough) return [yesterday]
  if (settledThrough >= yesterday) return []

  // The oldest day still worth settling. Starting from the cap rather than
  // truncating from the other end means a long-dormant account settles the days
  // it might still care about, not a week from last spring.
  const floor = shiftDay(yesterday, -(MAX_CATCH_UP_DAYS - 1))
  let cursor = shiftDay(settledThrough, 1)
  if (cursor < floor) cursor = floor

  const days: string[] = []
  while (cursor <= yesterday) {
    days.push(cursor)
    cursor = shiftDay(cursor, 1)
  }
  return days
}

interface BookkeepingRow {
  id: string
  user_id: string
  reminder_sent_key: string | null
  reminder_snooze_until: string | null
  reminder_snooze_date: string | null
}

export interface ScanSummary {
  /** Users considered this tick. */
  users: number
  /** Item cues delivered. */
  cues: number
  /** Last calls delivered. */
  lastCalls: number
  /** End-of-day review invitations delivered. */
  eod: number
  /**
   * Nudges that reached nobody: every channel that took one had nowhere to
   * deliver it (push with no device) or declined it. Each is ALSO counted in
   * `cues`, `lastCalls` or `eod`, because its claim was consumed all the same —
   * see noteFailures.
   */
  unreached: number
  /** Days closed by the stakes settlement. */
  daysSettled: number
  /** Non-fatal problems, one line each. */
  notes: string[]
  /** True when migration 032 has not been applied — the scan is a no-op. */
  migrationMissing?: boolean
}

export interface ScanOptions {
  now: Date
  graceMinutes?: number
}

/**
 * The scan could not start: one of the two reads every claim depends on (the
 * users, then their bookkeeping) failed.
 *
 * The one way runReminderScan rejects, and a safe one. Nothing has been
 * claimed and nothing sent, so the next tick inside the window simply tries
 * again; everything after those reads is per user and caught. It carries the
 * notes gathered before it (a missing stakes migration, say) so the route can
 * answer 500 with them rather than with the bare message
 * (memory/plans/reminders-platforms.md §7, decision 7).
 */
export class ReminderScanError extends Error {
  readonly notes: string[]

  constructor(message: string, notes: readonly string[]) {
    super(message)
    this.name = 'ReminderScanError'
    this.notes = [...notes]
  }
}

function toNudgeItem(item: Item): NudgeItem {
  return { id: item.id, title: item.title, streak: streakOf(item) }
}


export async function runReminderScan(
  service: ServiceClient,
  options: ScanOptions,
): Promise<ScanSummary> {
  const summary: ScanSummary = {
    users: 0,
    cues: 0,
    lastCalls: 0,
    eod: 0,
    unreached: 0,
    daysSettled: 0,
    notes: [],
  }

  // One grace for every window this tick opens and for how long the pushes it
  // sends may wait, so the two cannot be tuned apart.
  const grace = options.graceMinutes ?? REMINDER_GRACE_MINUTES

  // Split exactly the way lib/settings-service.ts splits its own select, and
  // for a sharper version of the same reason. PostgREST rejects the WHOLE query
  // with 42703 when one named column is missing, so naming the stakes columns
  // unconditionally means a database that has 029 but not 031 stops delivering
  // every reminder — Tier 1 and Tier 2 alike — until someone runs db:push by
  // hand. The stakes half is the part that should degrade, not all of it.
  //
  // The review's four columns ride with the reminders, not the stakes: they
  // are older than 032 (002, 010 and 018), so any database the reminder half
  // can read, they are on.
  const REMINDER_COLUMNS =
    'user_id, timezone, time_format, habit_reminders_enabled, habit_last_call_enabled, ' +
    'habit_last_call_time, habit_last_call_date, ' +
    'eod_review_enabled, eod_review_time, last_eod_notified_date, last_eod_review_date'
  const STAKES_COLUMNS = 'stakes_enabled, stakes_settle_time, stakes_settled_date'

  const readUsers = async (columns: string, stakesKnown: boolean) => {
    // ANY switch brings a user into the tick. They are genuinely separate
    // wants — someone may keep the accounting while turning off the nagging,
    // or want the evening review and no reminders at all — and filtering on
    // reminders alone would silently never settle their days or invite their
    // review. Without the stakes columns there is no stakes flag to OR
    // against; the review's is still there.
    //
    // A flag added to TICK_FLAGS needs a new migration that redefines
    // dsul_tick's gate to match, or the tick never reaches the route for
    // anyone with only that switch on (see TICK_FLAGS).
    const wants = TICK_FLAGS.filter((flag) => stakesKnown || flag !== 'stakes_enabled')
      .map((flag) => `${flag}.eq.true`)
      .join(',')
    return service.from('user_settings').select(columns).or(wants).not('timezone', 'is', null)
  }

  let { data: users, error } = await readUsers(`${REMINDER_COLUMNS}, ${STAKES_COLUMNS}`, true)
  let stakesAvailable = true

  if (error && isMissingColumn(error)) {
    stakesAvailable = false
    summary.notes.push('migration 034 not applied — settling is off, reminders continue')
    ;({ data: users, error } = await readUsers(REMINDER_COLUMNS, false))
  }

  if (error) {
    // A database without migration 032 must degrade to silence, not to a 500
    // that pages someone: the cron fires every few minutes, so an error here
    // is an alert storm about a migration that simply has not run yet.
    if (isMissingColumn(error)) {
      return { ...summary, migrationMissing: true, notes: ['migration 032 not applied'] }
    }
    throw new ReminderScanError(error.message, summary.notes)
  }

  const rows = (users ?? []) as unknown as ReminderUserRow[]
  if (rows.length === 0) return summary

  // ONE query for everyone's bookkeeping, rather than one per user. It also
  // answers the cheap question — "does this user have any reminder at all?" —
  // which is what lets the expensive per-user item fetch be skipped entirely
  // for someone who has set none.
  const { data: bookRows, error: bookError } = await service
    .from('items')
    .select('id, user_id, reminder_sent_key, reminder_snooze_until, reminder_snooze_date')
    .in('user_id', rows.map((r) => r.user_id))
    // EITHER a standing cue or a live snooze brings a row in. Filtering on
    // reminder_time alone would drop the snooze tapped on a LAST CALL, whose
    // item often has no per-item cue — the tap would be accepted by the act
    // route and then never read by anything.
    .or('reminder_time.not.is.null,reminder_snooze_until.not.is.null')
    .is('deleted_at', null)

  if (bookError) {
    if (isMissingColumn(bookError)) {
      return { ...summary, migrationMissing: true, notes: ['migration 032 not applied'] }
    }
    throw new ReminderScanError(bookError.message, summary.notes)
  }

  const bookByUser = new Map<string, Map<string, BookkeepingRow>>()
  for (const row of (bookRows ?? []) as BookkeepingRow[]) {
    let forUser = bookByUser.get(row.user_id)
    if (!forUser) bookByUser.set(row.user_id, (forUser = new Map()))
    forUser.set(row.id, row)
  }

  for (const user of rows) {
    const timezone = user.timezone as string
    let clock: LocalClock
    try {
      clock = localClock(options.now, timezone)
    } catch {
      // An unparseable IANA zone is the user's data, not our bug — skip them
      // and keep going rather than failing the whole tick for everyone.
      summary.notes.push(`${user.user_id}: unusable timezone ${timezone}`)
      continue
    }

    // ONE user's failure must not cost everyone else their reminders. Without
    // this boundary a single rejected fetch — a transient PostgREST error, one
    // malformed row — propagates out of the scan and 500s the route, which
    // silently drops every user after this one in the list AND contradicts the
    // route's own "200 for a partial tick" contract.
    try {
      const book = bookByUser.get(user.user_id) ?? new Map<string, BookkeepingRow>()
      // Both reminder kinds hang off the master switch. The query's .or() never
      // implies it (a user is here for stakes or the review just as well), so
      // it is asserted here rather than assumed — that is exactly the kind of
      // implication a later filter change breaks silently.
      const remindersOn = user.habit_reminders_enabled === true
      const lastCallMinutes = remindersOn && user.habit_last_call_enabled
        ? minutesOfDay(user.habit_last_call_time)
        : null
      // Clamped at midnight, and opened no later than the day's last tick
      // (windowOpensAt), so a last call set to 23:58 goes at 23:55 rather than
      // never. What it names is worked out at the tick, so nothing else moves.
      const lastCallDue =
        lastCallMinutes !== null &&
        user.habit_last_call_date !== clock.dateStr &&
        isWithinWindow(windowOpensAt(lastCallMinutes), clock.nowMinutes, grace)

      // Not a window but a threshold, and it has the same gap: a settle time of
      // 23:56–23:59 is a minute no tick reaches, and at 00:00 the date has
      // rolled and the clock starts again below it, so `>= 23:58` was never
      // true and no day was ever settled, with no note. It opens where the
      // windows do (windowOpensAt): at 23:55, yesterday is settled.
      const settleMinutes =
        stakesAvailable && user.stakes_enabled ? minutesOfDay(user.stakes_settle_time) : null
      const pendingDays =
        settleMinutes !== null && clock.nowMinutes >= windowOpensAt(settleMinutes)
          ? daysToSettle(clock.dateStr, user.stakes_settled_date)
          : []

      // Is tonight's review owed, and is this its window? Owed is lib/eod.ts's
      // isEodOwed, the question the dock asks, so a review already DONE today
      // is never invited — which the route this tier replaced never checked.
      // That veto is only as good as the stamp it reads: last_eod_review_date
      // is the day a review was FOR (the push's own date, via its link and
      // lib/eod.ts's reviewedDay), so last night's review finished after
      // midnight does not cancel tonight's invitation.
      // Its hour is read by lib/eod.ts's parser, never due.ts's: the column has
      // no CHECK (010) and the store saves what it is given, so '9:00' is a
      // value a row can hold, and the strict HH:mm parser would read it as no
      // time at all and the review as never due. The window is due.ts's,
      // clamped at midnight like every other here: a 23:50 review gets ten
      // minutes, and is never sent again at 00:05 as the next day's. It opens
      // no later than the day's last tick (windowOpensAt), so a 23:57 review
      // goes at 23:55 rather than never, and owed is then asked as of the
      // review's own hour, or the veto below would undo that by asking at
      // 23:55 whether 23:57 has come.
      const eodMinutes = user.eod_review_time ? eodMinutesOfDay(user.eod_review_time) : null
      const eodDue =
        eodMinutes !== null &&
        user.last_eod_notified_date !== clock.dateStr &&
        isWithinWindow(windowOpensAt(eodMinutes), clock.nowMinutes, grace) &&
        isEodOwed(
          {
            eodReviewEnabled: user.eod_review_enabled === true,
            eodReviewTime: user.eod_review_time ?? '',
            lastEodReviewDate: user.last_eod_review_date,
          },
          clock.dateStr,
          Math.max(clock.nowMinutes, eodMinutes),
        )

      // The item tiers' cheap question. A standing cue wants the master switch
      // AND a row with a reminder on it: rows left over from before the switch
      // went off bring nobody in, now that the review alone can put a user in
      // the tick.
      const itemsWanted = (remindersOn && book.size > 0) || lastCallDue || pendingDays.length > 0

      // Nothing set and nothing owed — do not pay for the reads below.
      if (!eodDue && !itemsWanted) continue

      summary.users += 1

      const timeFormat: TimeFormat = user.time_format === '24h' ? '24h' : '12h'
      // Read before any claim below, the review's included. A claim whose
      // delivery then cannot even be attempted is a nudge spent on nothing.
      const channelState = await loadChannelState(service, user.user_id)
      const base = { userId: user.user_id, service, timeFormat, timezone }

      /* ── The end-of-day review (Tier 0) ────────────────────────────────── */

      // First, and before the item fetch, so a user who only wants the review
      // never pays for one. Delivered through deliverNudge like every other
      // nudge, never by calling the push channel directly: the fan-out is what
      // absorbs a channel that fails, so a push that could not read the
      // devices costs this review and not the cues below; and it is what lets
      // voice and SMS decline the kind (REMINDER_KINDS) rather than this tier
      // knowing that push is the only channel that wants it.
      if (eodDue) {
        // CLAIMED, then delivered: the cue path's rule, and the reverse of the
        // route this replaced, which delivered and then stamped, so a stamp
        // that failed after a push that landed left the next tick free to send
        // it again. Conditional, so two overlapping ticks cannot both win it.
        const { data: claimedEod, error: eodError } = await service
          .from('user_settings')
          .update({ last_eod_notified_date: clock.dateStr })
          .eq('user_id', user.user_id)
          .or(`last_eod_notified_date.is.null,last_eod_notified_date.neq.${clock.dateStr}`)
          .select('user_id')

        if (eodError) {
          summary.notes.push(`${user.user_id}: eod claim failed — ${eodError.message}`)
        } else if ((claimedEod ?? []).length === 0) {
          // Another tick got there first. Nothing to do, and nothing wrong.
        } else {
          const nudge: Nudge = {
            kind: 'eod',
            title: EOD_COPY.title,
            body: EOD_COPY.body,
            // The day it invites a review of, so a tap after midnight is
            // recorded as that day's review and not the new one's, which would
            // retire the new day's invitation before it is sent (lib/eod.ts's
            // reviewedDay). The app still opens the bare ?eod=1 of older pushes.
            url: `/?eod=${clock.dateStr}`,
            dateStr: clock.dateStr,
            items: [],
            // Good until the user's own midnight and no further: the review
            // is about today, and tomorrow's invitation is tomorrow's.
            expiresAtMs: expiryAt(clock, MINUTES_PER_DAY),
          }
          const reports = await deliverNudge(nudge, base, channelState)
          noteFailures(summary, user.user_id, 'eod', reports)
          summary.eod += 1
        }
      }

      if (!itemsWanted) continue

      const [items, routines, seasons] = await Promise.all([
        fetchItems(user.user_id, undefined, service),
        fetchRoutines(user.user_id, service),
        fetchSeasons(user.user_id, service),
      ])

      // routines/seasons return null when their tables are unreachable. Passing
      // the nulls through as "no memberships known" is the ActivationContext
      // contract and leaves item-level pause still honoured — which is the safe
      // direction: the worst case is a nudge for something a paused SEASON
      // covers, not a nudge for something the user paused by hand.
      const ctx: ActivationContext = {
        userTimezone: timezone,
        routines: routines ?? undefined,
        seasons: seasons ?? undefined,
      }

      /* ── The per-item cues ─────────────────────────────────────────────── */

      const scanRows: ScanRow[] = items.map((item) => {
        const row = book.get(item.id)
        return {
          item,
          sentKey: row?.reminder_sent_key ?? undefined,
          snoozeUntil: row?.reminder_snooze_until ?? undefined,
          snoozeDate: row?.reminder_snooze_date ?? undefined,
        }
      })

      // Sweep snoozes that can never fire: matured, but belonging to a day that
      // is no longer today. They are left behind whenever the user completes the
      // habit in the app rather than on the notification, and dueReminders now
      // refuses them — but a row that is refused forever is still a row every
      // tick reads.
      const staleSnoozes = [...book.values()]
        .filter(
          (row) =>
            row.reminder_snooze_until !== null &&
            row.reminder_snooze_date !== clock.dateStr,
        )
        .map((row) => row.id)
      if (staleSnoozes.length > 0) {
        await service
          .from('items')
          .update({ reminder_snooze_until: null, reminder_snooze_date: null })
          .in('id', staleSnoozes)
          .eq('user_id', user.user_id)
          // Re-asserted against the DATABASE, not just against the ids computed
          // from a read that is by now seconds old. A snooze tapped in that gap
          // carries today's date, and an unconditional clear would erase it —
          // the user's tap becoming a silent no-op, which is the failure mode
          // the whole snooze redesign exists to remove.
          .or(`reminder_snooze_date.is.null,reminder_snooze_date.neq.${clock.dateStr}`)
      }

      // latestOpening: this clock ticks every five minutes, so a cue's window
      // opens no later than its last tick, as the review's and the last
      // call's do. due.ts leaves it to the caller because a clock that ticks
      // every minute should not ring a 23:58 cue at 23:55.
      const candidates = remindersOn
        ? dueReminders(scanRows, { ...clock, graceMinutes: grace, latestOpening: LAST_TICK }, ctx)
        : []

      if (candidates.length > 0) {
        // CLAIM BEFORE DELIVERING, which is the opposite of what the review's
        // old route (/api/cron/eod-notify, now the tier above) did, and a
        // deliberate divergence.
        //
        // Deliver-first survives a failed write by re-sending, and for a push
        // notification that is nearly free — the tag collapses the duplicate into
        // the same slot in the shade. It stops being free the moment a channel
        // costs money or rings a phone: six identical calls between 07:30 and
        // 08:00 is not a degraded experience, it is the reason someone uninstalls
        // the app. A stamp that lands and a delivery that fails costs one missed
        // cue on one day; the reverse costs trust.
        //
        // And it is a CLAIM, not a blind stamp: each update is conditional on the
        // state it read, and only rows the database actually changed are
        // delivered. A blind write is not exclusive, so two overlapping ticks —
        // which a slow push endpoint and an at-least-once cron make possible —
        // would both "succeed" and both deliver.
        const claimed = await claimCandidates(service, user.user_id, clock.dateStr, candidates, book)

        if (claimed === null) {
          summary.notes.push(`${user.user_id}: cue claim failed`)
        } else {
          for (const candidate of claimed) {
            const { title, body } = reminderCopy(candidate, timeFormat)
            const nudge: Nudge = {
              kind: 'cue',
              title,
              body,
              url: `/item/${candidate.item.id}`,
              dateStr: clock.dateStr,
              itemId: candidate.item.id,
              items: [toNudgeItem(candidate.item)],
              snoozed: candidate.snoozed,
              expiresAtMs: cueExpiresAt(candidate, clock, grace),
            }
            const reports = await deliverNudge(nudge, base, channelState)
            noteFailures(summary, user.user_id, 'cue', reports)
            summary.cues += 1
          }
        }
      }

      /* ── The streak-at-risk last call ──────────────────────────────────── */

      if (lastCallDue) {
        const open = lastCallItems(items, clock.dateStr, ctx)
        const copy = lastCallCopy(open)

        // CLAIMED, not stamped — the cue path's rule, and it matters more here.
        // A blind write always "succeeds", so two overlapping ticks would both
        // proceed and both deliver: with the phone-call channel on, that is two
        // Twilio calls and two billed SMS for one nudge.
        //
        // Claimed even when there is nothing to say. "Everything is done" is not
        // a notification anyone asked for, but it IS an answered question, and
        // leaving it unclaimed would re-ask it every tick for the rest of the
        // window.
        const { data: claimedLastCall, error: stampError } = await service
          .from('user_settings')
          .update({ habit_last_call_date: clock.dateStr })
          .eq('user_id', user.user_id)
          .or(`habit_last_call_date.is.null,habit_last_call_date.neq.${clock.dateStr}`)
          .select('user_id')

        if (stampError) {
          summary.notes.push(`${user.user_id}: last-call claim failed — ${stampError.message}`)
        } else if ((claimedLastCall ?? []).length === 0) {
          // Another tick got there first. Nothing to do, and nothing wrong.
        } else if (copy) {
          const nudge: Nudge = {
            kind: 'last-call',
            title: copy.title,
            body: copy.body,
            url: '/',
            dateStr: clock.dateStr,
            itemId: open.length === 1 ? open[0].id : undefined,
            items: open.map(toNudgeItem),
            // One grace from THIS tick, never past midnight, rather than to the
            // end of the window it was found in. What a last call says is the
            // day's state at the minute it was computed, so how long it stays
            // true runs from then.
            expiresAtMs: expiryAt(clock, Math.min(clock.nowMinutes + grace, MINUTES_PER_DAY)),
          }
          const reports = await deliverNudge(nudge, base, channelState)
          noteFailures(summary, user.user_id, 'last-call', reports)
          summary.lastCalls += 1
        }
      }

      /* ── The stakes settlement ─────────────────────────────────────────── */

      // When each item came into existence, in the user's own days. Read here
      // rather than carried on the Item, and read only when a day is actually
      // owed. Without it every newly created habit is settled as a miss for the
      // day before it existed — see CreatedOnLookup.
      const createdOn = pendingDays.length > 0
        ? await loadCreatedOn(service, user.user_id, timezone)
        : () => undefined

      for (const day of pendingDays) {
        const report = await settleOneDay(service, {
          userId: user.user_id,
          dateStr: day,
          timezone,
          items,
          createdOn,
          activation: ctx,
          extensionEnabled: channelState.extensionEnabled,
          configs: channelState.configs,
          secrets: channelState.secrets,
        })

        for (const note of report.notes) summary.notes.push(`${user.user_id}: ${day} ${note}`)

        // Stamp only on a CLEAN settlement. A day whose claim write failed has
        // recorded nothing and acted on nothing, so advancing past it would
        // forgive it permanently — and the catch-up window exists precisely so
        // the next tick can finish the job.
        if (report.notes.length > 0) break

        const { error: stampError } = await service
          .from('user_settings')
          .update({ stakes_settled_date: day })
          .eq('user_id', user.user_id)

        if (stampError) {
          summary.notes.push(`${user.user_id}: settle stamp failed — ${stampError.message}`)
          break
        }
        summary.daysSettled += 1
      }
    } catch (err) {
      summary.notes.push(
        `${user.user_id}: skipped — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return summary
}

/**
 * Each item's birth day in `timezone`: the later of its creation and its latest
 * type switch. A switch is only counted for an item that has a creation row.
 */
export function birthDays(
  items: readonly { id: string; created_at: string | null }[],
  switches: readonly { item_id: string; created_at: string | null }[],
  timezone: string,
): Map<string, string> {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone })
  const byId = new Map<string, string>()
  const stamp = (id: string, iso: string | null, onlyKnown: boolean) => {
    if (!iso) return
    const at = new Date(iso)
    if (Number.isNaN(at.getTime())) return
    const day = formatter.format(at)
    const known = byId.get(id)
    if (onlyKnown && !known) return
    if (!known || day > known) byId.set(id, day)
  }
  for (const row of items) stamp(row.id, row.created_at, false)
  for (const row of switches) stamp(row.item_id, row.created_at, true)
  return byId
}

/**
 * Each item's creation day, in the user's timezone — or the day it last
 * changed type, when that is later.
 *
 * A lookup rather than a map at the call site so a failed read degrades to
 * "unknown", which settleDay treats as "do not exclude" — the same answer it
 * gave before this existed. That is the right direction for a READ failure:
 * refusing to settle at all would let a transient error forgive a day
 * permanently, since the stamp only advances on a clean settlement.
 */
async function loadCreatedOn(
  service: ServiceClient,
  userId: string,
  timezone: string,
): Promise<(itemId: string) => string | undefined> {
  const { data, error } = await service
    .from('items')
    .select('id, created_at')
    .eq('user_id', userId)
    .is('deleted_at', null)

  if (error || !data) return () => undefined

  // A type switch is a second birth. A task made months ago and switched to a
  // habit this morning was never owed yesterday, but created_at says it
  // existed then, and the settlement would bill it as a miss. The edit pane
  // records every switch as an update event carrying the new `type`
  // (db.changeItemType), so the latest one moves the birth forward. Forgiving
  // by construction: a failed read keeps created_at, the answer given before
  // switches existed.
  const { data: switches, error: switchError } = await service
    .from('item_events')
    .select('item_id, created_at')
    .eq('user_id', userId)
    .eq('action', 'update')
    .not('payload->>type', 'is', null)

  const byId = birthDays(
    data as { id: string; created_at: string | null }[],
    switchError || !switches ? [] : (switches as { item_id: string; created_at: string | null }[]),
    timezone,
  )
  return (itemId: string) => byId.get(itemId)
}

/**
 * Take exclusive ownership of the cues about to be delivered.
 *
 * Two shapes, because the two kinds of candidate are claimed against different
 * state:
 *
 *   · a scheduled cue is claimed by moving reminder_sent_key to this day+time,
 *     ONLY from a row that is not already stamped with it;
 *   · a snoozed cue is claimed by clearing the snooze, ONLY from a row whose
 *     reminder_snooze_until is still the exact value this tick read. That
 *     compare-and-swap is what stops the clear from destroying a NEWER snooze
 *     armed after the bookkeeping read — the user's second tap becoming a
 *     silent no-op.
 *
 * Returns the candidates whose claim actually changed a row, or null if the
 * database refused the write outright.
 */
async function claimCandidates(
  service: ServiceClient,
  userId: string,
  dateStr: string,
  candidates: readonly ReminderCandidate[],
  book: Map<string, BookkeepingRow>,
): Promise<ReminderCandidate[] | null> {
  const snoozed = candidates.filter((c) => c.snoozed)
  const won: ReminderCandidate[] = []

  // One statement per cue rather than one for the batch: the key each row is
  // claimed against contains that row's own reminder time, so a batched update
  // could not express the condition.
  for (const candidate of candidates.filter((c) => !c.snoozed)) {
    const key = sentKeyFor(dateStr, candidate.at)
    const { data, error } = await service
      .from('items')
      .update({ reminder_sent_key: key })
      .eq('id', candidate.item.id)
      .eq('user_id', userId)
      .or(`reminder_sent_key.is.null,reminder_sent_key.neq.${key}`)
      .select('id')
    if (error) return null
    if ((data ?? []).length > 0) won.push(candidate)
  }

  // One statement each: the CAS value differs per row, so these cannot batch.
  // Snoozes are rare and short-lived, so the loop is a handful of rows at most.
  for (const candidate of snoozed) {
    const held = book.get(candidate.item.id)?.reminder_snooze_until
    if (!held) continue
    const { data, error } = await service
      .from('items')
      .update({ reminder_snooze_until: null, reminder_snooze_date: null })
      .eq('id', candidate.item.id)
      .eq('user_id', userId)
      .eq('reminder_snooze_until', held)
      .select('id')
    if (error) return null
    if ((data ?? []).length > 0) won.push(candidate)
  }

  return won
}

/**
 * Note what went wrong with one nudge's delivery, and count it if it reached
 * nobody.
 *
 * `unreached` counts the nudge only when EVERY report is unreached or skipped:
 * push had no device, and nothing else was on or wanted it. The claim was
 * consumed all the same, and on purpose (habit-reminders.md decision 4): a cue
 * with no device is discharged, not held over and retried into an SMS the next
 * tick. So this is the count of cues spent on silence, the number that says
 * push has quietly stopped reaching someone. A failure among the reports keeps
 * the nudge out of it; that is already a note of its own.
 *
 * An unreached channel earns a line only when nothing else got through. With
 * the SMS sent, a push with no device is how the user set things up, not a
 * problem.
 */
function noteFailures(
  summary: ScanSummary,
  userId: string,
  kind: string,
  reports: DeliveryReport[],
): void {
  if (reports.some((r) => r.unreached) && reports.every((r) => r.unreached || r.skipped)) {
    summary.unreached += 1
  }
  const delivered = reports.some((r) => r.ok && !r.skipped && !r.unreached)
  for (const report of reports) {
    if (report.unreached) {
      if (!delivered) {
        summary.notes.push(`${userId}: ${kind} via ${report.channel} unreached — ${report.detail ?? '?'}`)
      }
      continue
    }
    if (report.ok || report.skipped) continue
    summary.notes.push(`${userId}: ${kind} via ${report.channel} failed — ${report.detail ?? '?'}`)
  }
}
