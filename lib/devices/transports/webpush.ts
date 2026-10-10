/**
 * The web push transport: a `devices` row with transport 'webpush', through
 * lib/push-send.ts's sendWebPush, which owns the payload's split into
 * encrypted body and RFC 8030 headers (ttl, expiresAtMs, urgency, topic) and
 * the reading of every rejection. This file only says what each answer means
 * for the ROW.
 */

import { isPushConfigured, sendWebPush } from '../../push-send'
import type { DeviceMessage, DeviceRow, TransportOutcome } from '../types'

/** A push-send failure as a `last_failure` code. Never the push service's own words. */
function codeOf(status: number | undefined, detail: string | undefined): string {
  if (detail === 'push not configured') return 'not_configured'
  if (status === 401 || status === 403) return 'vapid_rejected'
  if (status === 429) return 'throttled'
  if (status !== undefined && status >= 500) return 'push_service_error'
  if (status !== undefined) return `http_${status}`
  return 'network'
}

export const webpushTransport = {
  /** No VAPID pair, no web push: every row is held, never failed (and never pruned). */
  available: isPushConfigured,

  async send(device: DeviceRow, message: DeviceMessage): Promise<TransportOutcome> {
    if (!device.token || !device.keys) return { ok: false, terminal: false, code: 'no_token' }
    const result = await sendWebPush({ endpoint: device.token, keys: device.keys }, message.payload)
    if (result.outcome === 'sent') return { ok: true }
    // 404/410: the endpoint is gone for good. push-send says why nothing else
    // prunes (a 401/403 is OUR key, and pruning on it would delete every row
    // the deployment holds on the first tick after a bad deploy).
    if (result.outcome === 'expired') return { ok: false, terminal: true, code: `gone_${result.status ?? 410}` }
    return { ok: false, terminal: false, code: codeOf(result.status, result.detail) }
  },
}
