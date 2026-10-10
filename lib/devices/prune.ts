/**
 * When a device stops being one.
 *
 * Two ways, and they are kept apart on purpose:
 *
 *   · INLINE, on a terminal answer from a push service (web 404/410): the
 *     token is gone for good, and the row is deleted by id as the send that
 *     found it finishes (lib/devices/send.ts).
 *   · NIGHTLY, for rows no answer will ever prune: Safari answers 200 for a
 *     dead subscription, APNs never ages a token, FCM calls a token stale after
 *     a month. 065's `prune-devices` job deletes a row unseen for STALE_DAYS.
 *
 * "Seen" is a registration touch (at most every 12 hours, lib/devices/
 * registry.ts) OR an accepted send, which stamps `last_seen_at` too, so a
 * device that only ever receives is never pruned as unseen.
 *
 * STALE_DAYS is also the sender's own cut-off (select.ts): a row the job would
 * delete tonight is not sent to this afternoon. tests/unit/devices-prune.test.ts
 * holds these numbers against 065's text, so the two cannot drift.
 */

import type { DeviceTransport } from './types'

export const STALE_DAYS: Record<DeviceTransport, number> = {
  webpush: 180,
  apns: 180,
  none: 180,
  fcm: 60,
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Unseen for longer than its transport allows. An unreadable stamp is stale: it cannot vouch for anything. */
export function isStale(row: { transport: DeviceTransport; last_seen_at: string }, nowMs: number): boolean {
  const seen = Date.parse(row.last_seen_at)
  if (!Number.isFinite(seen)) return true
  return nowMs - seen > STALE_DAYS[row.transport] * DAY_MS
}
