/**
 * scan.ts — the tick.
 *
 * Runs every few minutes, works out whose cue is due in their own local minute,
 * and hands each resolved nudge to lib/reminders/deliver.ts. The route around
 * it (app/api/cron/reminders) is auth and nothing else, so this stays callable
 * from a test with a stubbed client and a fixed `now`.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not decide whether an item wants
 * doing (lib/reminders/due.ts), it does not write the words (copy.ts), and it
 * does not know a single channel's name (deliver.ts). Its whole job is the loop
 * and the bookkeeping — which is the part that has to be right about
 * timezones, and the part nothing else should have an opinion about.
 */

import { addDays, format, parseISO } from 'date-fns'
import { fetchItems, fetchRoutines, fetchPrograms } from '../db'
import { settleOneDay } from '../stakes/settle'
import type { createServiceClient } from '../supabase-service'
import {
  dueReminders,
  lastCallItems,
  minutesOfDay,
  sentKeyFor,
  streakOf,
  type ReminderCandidate,
  type ScanRow,
} from './due'
import { lastCallCopy, reminderCopy, type TimeFormat } from './copy'
import { deliverNudge, type DeliveryReport } from './deliver'
import type { Nudge, NudgeItem } from './nudge'
import type { ActivationContext } from '../active'
import type { Item } from '../planner-types'
import { isMissingColumn, loadChannelState } from './extension-state'

type ServiceClient = ReturnType<typeof createServiceClient>

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
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now)
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now)
  return {
    dateStr,
    nowMinutes: minutesOfDay(hhmm) ?? 0,
    nowIso: now.toISOString(),
    nowMs: now.getTime(),
  }
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

function toNudgeItem(item: Item): NudgeItem {
  return { id: item.id, title: item.title, streak: streakOf(item) }
}


export async function runReminderScan(
  service: ServiceClient,
  options: ScanOptions,
): Promise<ScanSummary> {
  const summary: ScanSummary = { users: 0, cues: 0, lastCalls: 0, daysSettled: 0, notes: [] }

  // Split exactly the way lib/settings-service.ts splits its own select, and
  // for a sharper version of the same reason. PostgREST rejects the WHOLE query
  // with 42703 when one named column is missing, so naming the stakes columns
  // unconditionally means a database that has 029 but not 031 stops delivering
  // every reminder — Tier 1 and Tier 2 alike — until someone runs db:push by
  // hand. The stakes half is the part that should degrade, not all of it.
  const REMINDER_COLUMNS =
    'user_id, timezone, time_format, habit_reminders_enabled, habit_last_call_enabled, ' +
    'habit_last_call_time, habit_last_call_date'
  const STAKES_COLUMNS = 'stakes_enabled, stakes_settle_time, stakes_settled_date'

  const readUsers = async (columns: string, stakesKnown: boolean) => {
    let query = service.from('user_settings').select(columns)
    // EITHER switch brings a user into the tick. They are genuinely separate
    // wants — someone may keep the accounting while turning off the nagging —
    // and filtering on reminders alone would silently never settle their days.
    // Without the stakes columns there is nothing to OR against.
    query = stakesKnown
      ? query.or('habit_reminders_enabled.eq.true,stakes_enabled.eq.true')
      : query.eq('habit_reminders_enabled', true)
    return query.not('timezone', 'is', null)
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
    throw new Error(error.message)
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
    throw new Error(bookError.message)
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
      // Both nudge kinds hang off the master switch. It is implied by the query's
      // .or() only when stakes are off, so it is asserted here rather than
      // assumed — that is exactly the kind of implication a later filter change
      // breaks silently.
      const remindersOn = user.habit_reminders_enabled === true
      const lastCallMinutes = remindersOn && user.habit_last_call_enabled
        ? minutesOfDay(user.habit_last_call_time)
        : null
      const lastCallDue =
        lastCallMinutes !== null &&
        user.habit_last_call_date !== clock.dateStr &&
        clock.nowMinutes >= lastCallMinutes &&
        clock.nowMinutes < Math.min(lastCallMinutes + (options.graceMinutes ?? 30), 1440)

      const settleMinutes =
        stakesAvailable && user.stakes_enabled ? minutesOfDay(user.stakes_settle_time) : null
      const pendingDays =
        settleMinutes !== null && clock.nowMinutes >= settleMinutes
          ? daysToSettle(clock.dateStr, user.stakes_settled_date)
          : []

      // Nothing set and nothing owed — do not pay for the item fetch.
      if (book.size === 0 && !lastCallDue && pendingDays.length === 0) continue

      summary.users += 1

      const [items, routines, programs] = await Promise.all([
        fetchItems(user.user_id, undefined, service),
        fetchRoutines(user.user_id, service),
        fetchPrograms(user.user_id, service),
      ])

      // routines/programs return null when their tables are unreachable. Passing
      // the nulls through as "no memberships known" is the ActivationContext
      // contract and leaves item-level pause still honoured — which is the safe
      // direction: the worst case is a nudge for something a paused PROGRAM
      // covers, not a nudge for something the user paused by hand.
      const ctx: ActivationContext = {
        userTimezone: timezone,
        routines: routines ?? undefined,
        programs: programs ?? undefined,
      }

      const timeFormat: TimeFormat = user.time_format === '24h' ? '24h' : '12h'
      const channelState = await loadChannelState(service, user.user_id)
      const base = { userId: user.user_id, service, timeFormat, timezone }

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

      const candidates = remindersOn
        ? dueReminders(scanRows, { ...clock, graceMinutes: options.graceMinutes }, ctx)
        : []

      if (candidates.length > 0) {
        // CLAIM BEFORE DELIVERING, which is the opposite of what
        // /api/cron/eod-notify does and a deliberate divergence.
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

function noteFailures(
  summary: ScanSummary,
  userId: string,
  kind: string,
  reports: DeliveryReport[],
): void {
  for (const report of reports) {
    if (report.ok || report.skipped) continue
    summary.notes.push(`${userId}: ${kind} via ${report.channel} failed — ${report.detail ?? '?'}`)
  }
}
