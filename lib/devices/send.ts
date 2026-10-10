/**
 * sendToUser — one notification to every device a user has that wants it.
 *
 * The registry's sender (memory/plans/reminders-platforms.md §5.2), and the one
 * place a push leaves for a user: the reminder scan's push channel, the pledge
 * notice and /api/push/send all come through here.
 *
 *   1. Read the user's rows through the service role (the only reader of
 *      `token` and `keys`).
 *   2. selectDevices() decides who takes this kind (lib/devices/select.ts).
 *   3. Each eligible row goes to its transport, all at once, settled not
 *      raced: a rejection is that device's failure (`threw`), never the
 *      caller's.
 *   4. The rows answer for themselves, once per outcome: accepted rows get
 *      `last_sent_at` and `last_seen_at` (a device that only receives is still
 *      seen, so the nightly prune spares it), failed rows their code in
 *      `last_failure`, and terminal rows are deleted by id.
 *
 * NEVER THROWS. A read that fails is answered with zeros and a `detail`, the
 * contract lib/push-send.ts's sendPushToUser kept before it.
 *
 * DEPLOY LEADS MIGRATION. Until 064 is applied the table is missing (42P01 /
 * PGRST205), and the send goes through push_subscriptions as it did before the
 * registry: sendPushToUser, reported with `legacy: true`. For one release.
 */

import { sendPushToUser } from '../push-send'
import type { createServiceClient } from '../supabase-service'
import { DEVICE_SEND_COLUMNS, isMissingRegistry } from './db'
import { selectDevices } from './select'
import { webpushTransport } from './transports/webpush'
import type {
  DeviceMessage,
  DeviceRow,
  DeviceSendResult,
  DeviceTransport,
  SendReport,
  TransportOutcome,
} from './types'

type ServiceClient = ReturnType<typeof createServiceClient>

export interface Transport {
  /** False when this deployment cannot send on it at all: its rows are held, not failed. */
  available: () => boolean
  send: (device: DeviceRow, message: DeviceMessage) => Promise<TransportOutcome>
}

/** The transports this build can send on. APNs arrives in Phase 3, FCM in Phase 5. */
export const SENDERS: Partial<Record<DeviceTransport, Transport>> = {
  webpush: webpushTransport,
}

export interface SendOptions {
  /** The clock the selection reads (stale, quiet hours). Defaults to now. */
  nowMs?: number
}

function readFailed(detail: string): SendReport {
  return { devices: 0, eligible: 0, accepted: 0, failed: 0, pruned: 0, held: 0, perDevice: [], detail }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function sendToUser(
  service: ServiceClient,
  userId: string,
  message: DeviceMessage,
  opts: SendOptions = {},
  senders: Partial<Record<DeviceTransport, Transport>> = SENDERS,
): Promise<SendReport> {
  const nowMs = opts.nowMs ?? Date.now()

  let rows: DeviceRow[]
  try {
    const { data, error } = await service.from('devices').select(DEVICE_SEND_COLUMNS).eq('user_id', userId)
    if (error) {
      if (isMissingRegistry(error)) return legacySend(service, userId, message)
      return readFailed(`read failed: ${error.message}`)
    }
    rows = (data ?? []) as unknown as DeviceRow[]
  } catch (err) {
    return readFailed(`read failed: ${messageOf(err)}`)
  }

  const { eligible: selected, held } = selectDevices(rows, message.kind, nowMs)
  const perDevice: DeviceSendResult[] = held.map(({ row, reason }) => ({
    deviceId: row.device_id,
    transport: row.transport,
    outcome: 'held',
    code: reason,
  }))

  // A row is attempted only through a transport this build has and this
  // deployment can use; the rest are held, which is what keeps a missing VAPID
  // pair from reading as every device failing (and from being pruned on).
  const eligible: { row: DeviceRow; transport: Transport }[] = []
  for (const row of selected) {
    const transport = senders[row.transport]
    const reason = !transport ? 'no_sender' : transport.available() ? null : 'transport_off'
    if (reason) perDevice.push({ deviceId: row.device_id, transport: row.transport, outcome: 'held', code: reason })
    else eligible.push({ row, transport: transport! })
  }

  const settled = await Promise.allSettled(eligible.map(({ row, transport }) => transport.send(row, message)))
  const outcomes: TransportOutcome[] = settled.map((s) =>
    s.status === 'fulfilled' ? s.value : { ok: false, terminal: false, code: 'threw' },
  )

  const accepted: string[] = []
  const pruned: string[] = []
  const failedByCode = new Map<string, string[]>()
  eligible.forEach(({ row }, i) => {
    const outcome = outcomes[i]
    if (outcome.ok) {
      accepted.push(row.id)
      perDevice.push({ deviceId: row.device_id, transport: row.transport, outcome: 'accepted' })
    } else if (outcome.terminal) {
      pruned.push(row.id)
      perDevice.push({ deviceId: row.device_id, transport: row.transport, outcome: 'pruned', code: outcome.code })
    } else {
      failedByCode.set(outcome.code, [...(failedByCode.get(outcome.code) ?? []), row.id])
      perDevice.push({ deviceId: row.device_id, transport: row.transport, outcome: 'failed', code: outcome.code })
    }
  })

  await stamp(service, userId, nowMs, accepted, pruned, failedByCode)

  const failed = [...failedByCode.values()].reduce((n, ids) => n + ids.length, 0)
  return {
    devices: rows.length,
    eligible: eligible.length,
    accepted: accepted.length,
    failed,
    pruned: pruned.length,
    held: rows.length - eligible.length,
    perDevice,
  }
}

/**
 * The rows answer for the send, one statement per outcome. Best effort: a
 * stamp that does not land costs a "last reached" line, and a prune that does
 * not land retries itself (the endpoint answers 410 again next time). Neither
 * is worth failing a delivery that has already happened.
 */
async function stamp(
  service: ServiceClient,
  userId: string,
  nowMs: number,
  accepted: string[],
  pruned: string[],
  failedByCode: Map<string, string[]>,
): Promise<void> {
  const at = new Date(nowMs).toISOString()
  const writes: PromiseLike<unknown>[] = []
  if (accepted.length) {
    writes.push(
      service
        .from('devices')
        .update({ last_sent_at: at, last_seen_at: at, last_failure: null })
        .eq('user_id', userId)
        .in('id', accepted),
    )
  }
  for (const [code, ids] of failedByCode) {
    writes.push(service.from('devices').update({ last_failure: code }).eq('user_id', userId).in('id', ids))
  }
  if (pruned.length) {
    writes.push(service.from('devices').delete().eq('user_id', userId).in('id', pruned))
  }
  await Promise.allSettled(writes.map((w) => Promise.resolve(w)))
}

/** 064 not applied yet: the pre-registry send, in the registry's terms. */
async function legacySend(service: ServiceClient, userId: string, message: DeviceMessage): Promise<SendReport> {
  try {
    const r = await sendPushToUser(service, userId, message.payload)
    const report: SendReport = {
      devices: r.devices,
      eligible: r.devices,
      accepted: r.sent,
      failed: r.failed,
      pruned: r.expired,
      held: 0,
      perDevice: [],
      legacy: true,
    }
    if (r.detail !== undefined) report.detail = r.detail
    return report
  } catch (err) {
    return { ...readFailed(`read failed: ${messageOf(err)}`), legacy: true }
  }
}
