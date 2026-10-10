/**
 * cue-log.ts — the name of one logical cue in `cue_log` (migration 067).
 *
 * One row per (user, key). The key is what a device acks after it shows the
 * notification (POST /api/reminders/ack), so every sender and every presenter
 * must spell it the same way: the scan when it puts it on a push (the
 * payload's `data.key`), and the page tick when it shows a cue it claimed.
 *
 *   cue:<itemId>:<yyyy-MM-dd>T<HH:mm>   the day's cue (its sentKeyFor)
 *   snooze:<itemId>:<ISO instant>        a matured snooze, by the instant it was held at
 *   last-call:<yyyy-MM-dd>
 *   eod:<yyyy-MM-dd>
 *
 * A snooze's instant is normalised through toISOString, because PostgREST
 * renders a timestamptz as `…+00:00` and a browser writes `…Z`: the same
 * instant must not be two keys.
 *
 * Pure and client-safe.
 */

import { sentKeyFor } from './due'

/** The shape the ack route accepts: a kind, then up to two parts, nothing longer than the table's text wants. */
export const CUE_LOG_KEY = /^(?:cue|snooze|last-call|eod|pledge):[A-Za-z0-9:._TZ+-]{1,160}$/

export function cueKey(itemId: string, dateStr: string, at: string): string {
  return `cue:${itemId}:${sentKeyFor(dateStr, at)}`
}

/** null when `held` is not an instant. */
export function snoozeKey(itemId: string, held: string): string | null {
  const ms = Date.parse(held)
  return Number.isFinite(ms) ? `snooze:${itemId}:${new Date(ms).toISOString()}` : null
}

export function dayKey(kind: 'last-call' | 'eod', dateStr: string): string {
  return `${kind}:${dateStr}`
}
