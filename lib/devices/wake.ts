/**
 * sendWakes — the iPhone app's background wake (reminders PR-3c, migration
 * 076, memory/plans/reminders-platforms.md §5.4). Server only; a tier of the
 * reminder tick (app/api/cron/reminders).
 *
 * The phone arms its own cues, so an item ticked, skipped, paused or re-timed
 * anywhere else is still armed there until the phone re-plans. 076's trigger
 * stamps the user's apns rows `wake_requested_at` on such a change; this
 * sends each of those phones one silent push, and the app fetches its planner
 * and re-plans (ios AppDelegate → NotificationHub.backgroundRefresh).
 *
 *   · AT MOST ONE PER PHONE PER 30 MINUTES. Apple asks for no more than two or
 *     three background pushes an hour and throttles above that; a wake asked
 *     for inside the window waits for its end, and is sent then, because the
 *     stamp it left is still newer than the last push.
 *   · CLAIM, THEN SEND. `last_background_push_at` is moved by a conditional
 *     update that names the value this tick read, and only a row the database
 *     actually changed is pushed: two ticks that overlap send one wake.
 *   · NEVER THROWS, and quiet until 076 is applied (42703, or the table
 *     missing): deploy leads migration.
 *
 * A failed wake records its code in `last_failure` like any send; a token
 * Apple calls gone prunes the row. A wake is not retried: the next change
 * asks again, and the phone re-plans when opened regardless.
 */

import type { createServiceClient } from '../supabase-service'
import { isMissingRegistry } from './db'
import { apnsTransport, type ApnsTarget } from './transports/apns'
import type { TransportOutcome } from './types'

type ServiceClient = ReturnType<typeof createServiceClient>

/** No phone is woken more often than this. */
export const WAKE_THROTTLE_MS = 30 * 60_000
/** At most this many phones a tick; the rest wait for the next one. */
export const WAKE_BATCH = 200

export const WAKE_COLUMNS = 'id, user_id, token, apns_environment, registered_at, wake_requested_at, last_background_push_at'

export interface WakeRow extends ApnsTarget {
  id: string
  user_id: string
  wake_requested_at: string | null
  last_background_push_at: string | null
}

export interface WakeSender {
  available: () => boolean
  wake: (device: ApnsTarget) => Promise<TransportOutcome>
}

export interface WakeSummary {
  /** Rows with a wake asked for. */
  asked: number
  /** Pushes Apple took. */
  sent: number
  /** Inside the 30-minute window, or already answered by a later push. */
  waiting: number
  failed: number
  pruned: number
  notes: string[]
}

const EMPTY: WakeSummary = { asked: 0, sent: 0, waiting: 0, failed: 0, pruned: 0, notes: [] }

/** Is a wake owed to this row now: asked for since its last push, and that push 30 minutes gone. */
export function wakeOwed(row: Pick<WakeRow, 'wake_requested_at' | 'last_background_push_at'>, nowMs: number): boolean {
  const asked = row.wake_requested_at ? Date.parse(row.wake_requested_at) : NaN
  if (!Number.isFinite(asked)) return false
  if (!row.last_background_push_at) return true
  const last = Date.parse(row.last_background_push_at)
  if (!Number.isFinite(last)) return true
  return asked > last && nowMs - last >= WAKE_THROTTLE_MS
}

/** 076 not applied: the columns are not there (42703), or nor is the table. */
function isMissingWakes(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === '42703' || code === 'PGRST204' || isMissingRegistry(error)
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function sendWakes(
  service: ServiceClient,
  opts: { nowMs?: number; sender?: WakeSender } = {},
): Promise<WakeSummary> {
  const nowMs = opts.nowMs ?? Date.now()
  const sender = opts.sender ?? apnsTransport
  // No APNs key: nothing can be sent, so nothing is read or claimed. The
  // stamps keep, and the first tick after the key is set sends them.
  if (!sender.available()) return { ...EMPTY, notes: [] }

  let rows: WakeRow[]
  try {
    const { data, error } = await service
      .from('devices')
      .select(WAKE_COLUMNS)
      .eq('transport', 'apns')
      .not('wake_requested_at', 'is', null)
      .limit(WAKE_BATCH)
    if (error) {
      if (isMissingWakes(error)) return { ...EMPTY, notes: [] }
      return { ...EMPTY, notes: [`read failed: ${(error as { message?: string }).message ?? 'unknown'}`] }
    }
    rows = (data ?? []) as unknown as WakeRow[]
  } catch (err) {
    return { ...EMPTY, notes: [`read failed: ${messageOf(err)}`] }
  }

  const summary: WakeSummary = { ...EMPTY, asked: rows.length, notes: [] }
  const at = new Date(nowMs).toISOString()

  await Promise.allSettled(
    rows.map(async (row) => {
      if (!wakeOwed(row, nowMs)) {
        summary.waiting++
        return
      }
      try {
        const claim = service.from('devices').update({ last_background_push_at: at }).eq('id', row.id)
        const guarded = row.last_background_push_at
          ? claim.eq('last_background_push_at', row.last_background_push_at)
          : claim.is('last_background_push_at', null)
        const { data, error } = await guarded.select('id')
        if (error) {
          summary.notes.push(`claim failed: ${(error as { message?: string }).message ?? 'unknown'}`)
          return
        }
        // Another tick took it first.
        if (!Array.isArray(data) || data.length === 0) {
          summary.waiting++
          return
        }

        const outcome = await sender.wake(row)
        if (outcome.ok) {
          summary.sent++
        } else if (outcome.terminal) {
          summary.pruned++
          await service.from('devices').delete().eq('id', row.id)
        } else {
          summary.failed++
          await service.from('devices').update({ last_failure: outcome.code }).eq('id', row.id)
        }
      } catch (err) {
        summary.notes.push(`wake failed: ${messageOf(err)}`)
      }
    }),
  )
  return summary
}
