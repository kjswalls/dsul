/**
 * retry.ts — the retry pass: a claimed nudge that reached no device, sent
 * again while its window is open. Server only; the scan is its one caller.
 *
 * memory/plans/reminders-platforms.md §5.2, PR-1d, and 067's header. A claim
 * is spent the moment it is won (claim, then act), so a send that is cut off
 * after it, by the route's maxDuration or a crash, loses that cue for the
 * day. #276's 500s were lossless because they fell BEFORE every claim; this is
 * the case that is not. The ledger is how the next tick can tell: the scan
 * opens a row at the claim (cue-log-write.ts), so a row still undelivered,
 * with its window open, is a nudge nobody got.
 *
 * Four rules, each from a way the obvious version is wrong:
 *
 *   · DEVICES ONLY. The retry goes through sendToUser (the push channel's
 *     send), never deliverNudge's fan-out. Voice, SMS and the call already
 *     had their go, and one that did deliver is not asked again; one that
 *     failed is not worth a second phone call two ticks late.
 *   · A CONDITIONAL CLAIM on `attempts`: `… where id = $id and attempts =
 *     $read and delivered_at is null`. A blind increment is not exclusive, so
 *     two overlapping ticks would both re-send (scan.ts's claimCandidates says
 *     why the same holds for cues).
 *   · ASKED AGAIN FIRST. Minutes have passed since the claim. A habit ticked
 *     in between, a last call whose last item was done: each is silence now
 *     (due.ts's wantsDoingOn), and the row is closed for retries with a code
 *     saying why. An `eod` row (the end of day review's invitation, retired in
 *     ghost rows phase 2) is never sent again: it is closed as not wanted.
 *   · NOT THIS TICK'S. A row is retried only once it is RETRY_AFTER_MS old,
 *     so a row another tick opened a moment ago, whose send is still in
 *     flight, is never taken for a lost one.
 */

import type { ActivationContext } from '../active'
import type { Item } from '../planner-types'
import type { createServiceClient } from '../supabase-service'
import { cueNudge, lastCallNudge } from './build'
import { sendNudgeToDevices } from './channels/push'
import type { LocalClock } from './clock'
import type { TimeFormat } from './copy'
import { closeCueLog, isMissingCueLog, MAX_ATTEMPTS, type CueLogKind, type CueLogResult } from './cue-log-write'
import { lastCallItems, wantsDoingOn } from './due'
import type { Nudge } from './nudge'

type ServiceClient = ReturnType<typeof createServiceClient>

/**
 * How old a row must be before it is taken for lost. Under the tick's five
 * minutes, so the previous tick's rows qualify at the next one, and above the
 * route's 60-second maxDuration, so a sibling tick's send is never still in
 * flight.
 */
export const RETRY_AFTER_MS = 4 * 60_000

export const OPEN_CUE_COLUMNS = 'id, user_id, key, kind, item_id, date_str, window_end, claimed_at, attempts, results'

export interface OpenCueRow {
  id: string
  user_id: string
  key: string
  kind: CueLogKind
  item_id: string | null
  date_str: string
  window_end: string
  claimed_at: string | null
  attempts: number
  results: CueLogResult[] | null
}

export interface OpenCues {
  byUser: Map<string, OpenCueRow[]>
  /** The read failed for a reason other than 067 missing. */
  error?: string
}

/**
 * Every user's rows worth a retry, in one read: undelivered, under the cap,
 * window still open, and old enough (RETRY_AFTER_MS). A missing table is no
 * rows; any other failure is no rows and a note, since the retry is a
 * backstop and never a reason to hold up the tick.
 */
export async function readOpenCues(service: ServiceClient, userIds: readonly string[], nowMs: number): Promise<OpenCues> {
  const byUser = new Map<string, OpenCueRow[]>()
  if (userIds.length === 0) return { byUser }
  try {
    const { data, error } = await service
      .from('cue_log')
      .select(OPEN_CUE_COLUMNS)
      .in('user_id', [...userIds])
      .is('delivered_at', null)
      .lt('attempts', MAX_ATTEMPTS)
      .gt('window_end', new Date(nowMs).toISOString())
      .lt('claimed_at', new Date(nowMs - RETRY_AFTER_MS).toISOString())
    if (error) return isMissingCueLog(error) ? { byUser } : { byUser, error: (error as { message?: string }).message ?? 'read failed' }
    for (const row of (data ?? []) as OpenCueRow[]) {
      byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row])
    }
    return { byUser }
  } catch (err) {
    return { byUser, error: err instanceof Error ? err.message : String(err) }
  }
}

/** What the retry needs to ask one user's rows again. */
export interface RetryUser {
  userId: string
  clock: LocalClock
  timeFormat: TimeFormat
  remindersOn: boolean
  lastCallOn: boolean
  /** The user's items and their activation context, read once and only if a row needs them. */
  world: () => Promise<{ items: Item[]; ctx: ActivationContext }>
}

/** Why a row is no longer worth sending, as the `results` code it is closed with. */
type Silence = 'not_today' | 'not_wanted' | 'malformed'

/**
 * The nudge a row stands for, worded as it would be now, or why it is
 * silence now. The copy is rebuilt rather than stored (067 keeps no title or
 * body), which is also right: a streak that moved since the claim reads as it
 * is.
 */
export async function nudgeForRow(row: OpenCueRow, user: RetryUser): Promise<Nudge | Silence> {
  if (row.date_str !== user.clock.dateStr) return 'not_today'
  const expiresAtMs = Date.parse(row.window_end)
  if (!Number.isFinite(expiresAtMs)) return 'malformed'

  // The review's invitation is no longer sent (ghost rows phase 2), so a row
  // an older build claimed and lost is closed, not re-sent.
  if (row.kind === 'eod') return 'not_wanted'

  if (row.kind === 'last-call') {
    if (!user.remindersOn || !user.lastCallOn) return 'not_wanted'
    const { items, ctx } = await user.world()
    return lastCallNudge(lastCallItems(items, row.date_str, ctx), row.date_str, expiresAtMs) ?? 'not_wanted'
  }

  if (row.kind === 'cue' || row.kind === 'snooze') {
    if (!user.remindersOn) return 'not_wanted'
    if (!row.item_id) return 'malformed'
    const { items, ctx } = await user.world()
    const item = items.find((i) => i.id === row.item_id)
    if (!item || !wantsDoingOn(item, row.date_str, ctx)) return 'not_wanted'
    const anchor = ('reminderAnchor' in item ? item.reminderAnchor : undefined) || undefined
    if (row.kind === 'snooze') {
      // The key carries the instant the snooze was held at: its name stays its name.
      const held = row.key.slice(`snooze:${row.item_id}:`.length)
      const at = ('reminderTime' in item ? item.reminderTime : undefined) ?? ''
      return cueNudge({ item, at, anchor, snoozed: true }, row.date_str, user.timeFormat, expiresAtMs, held)
    }
    // 'cue:<itemId>:<date>T<HH:mm>': the minute it was cued for, which the
    // item's own reminderTime may have moved off since.
    const prefix = `cue:${row.item_id}:${row.date_str}T`
    const at = row.key.startsWith(prefix) ? row.key.slice(prefix.length) : ''
    if (!/^\d{2}:\d{2}$/.test(at)) return 'malformed'
    return cueNudge({ item, at, anchor, snoozed: false }, row.date_str, user.timeFormat, expiresAtMs, null)
  }

  // 'pledge' rows are not the scan's to write, so not its to retry.
  return 'not_wanted'
}

export interface RetrySummary {
  /** Rows re-sent this tick. */
  retried: number
  notes: string[]
}

/**
 * Retry one user's open rows. Never throws: each row is its own try, and a
 * row that fails is a note.
 */
export async function retryOpenCues(
  service: ServiceClient,
  rows: readonly OpenCueRow[],
  user: RetryUser,
): Promise<RetrySummary> {
  const summary: RetrySummary = { retried: 0, notes: [] }
  for (const row of rows) {
    try {
      const before = Array.isArray(row.results) ? row.results : []
      const nudge = await nudgeForRow(row, user)

      if (typeof nudge === 'string') {
        // Silence now. Closed for retries, with the reason, so the ledger says
        // why the cue it claimed was never shown.
        const at = new Date(user.clock.nowMs).toISOString()
        const error = await closeCueLog(service, user.userId, row.id, [{ channel: 'retry', ok: false, code: nudge, at }], {
          before,
          nowMs: user.clock.nowMs,
        })
        if (error) summary.notes.push(`${user.userId}: cue_log ${row.key} close failed — ${error}`)
        continue
      }

      // The conditional claim: only the tick that moves `attempts` from the
      // value it read sends.
      const { data: won, error: claimError } = await service
        .from('cue_log')
        .update({ attempts: row.attempts + 1 })
        .eq('id', row.id)
        .eq('user_id', user.userId)
        .eq('attempts', row.attempts)
        .is('delivered_at', null)
        .select('id')
      if (claimError) {
        summary.notes.push(`${user.userId}: cue_log ${row.key} retry claim failed — ${claimError.message}`)
        continue
      }
      if (!Array.isArray(won) || won.length === 0) continue

      const result = await sendNudgeToDevices(service, user.userId, nudge)
      const at = new Date(Date.now()).toISOString()
      const entry: CueLogResult = result.ok && !result.unreached
        ? { channel: 'push', ok: true, at }
        : { channel: 'push', ok: false, code: result.unreached ? 'unreached' : 'failed', at }
      summary.retried += 1
      if (!entry.ok) summary.notes.push(`${user.userId}: ${row.kind} retry via push ${entry.code} — ${result.detail ?? '?'}`)

      const error = await closeCueLog(service, user.userId, row.id, [entry], { before, nowMs: user.clock.nowMs })
      if (error) summary.notes.push(`${user.userId}: cue_log ${row.key} close failed — ${error}`)
    } catch (err) {
      summary.notes.push(`${user.userId}: cue_log ${row.key} retry skipped — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return summary
}
