/**
 * lib/devices — every device dsul can reach (migration 065,
 * memory/plans/reminders-platforms.md §3.2).
 *
 * The wire shapes live in @dsul/types; these are the server's own: a row as
 * the service role reads it (token and keys included, which no browser ever
 * sees), what one transport answers, and what a fan-out came to.
 */

import type {
  DeviceDelivery,
  DeviceForm,
  DevicePlatform,
  DevicePrefs,
  DeviceSendKind,
  DeviceTransport,
} from '@dsul/types'
import type { PushPayload } from '../push-send'

export type { DeviceDelivery, DeviceForm, DevicePlatform, DevicePrefs, DeviceSendKind, DeviceTransport }

/** A `devices` row as the sender reads it, through the service role. */
export interface DeviceRow {
  id: string
  user_id: string
  device_id: string
  platform: DevicePlatform
  transport: DeviceTransport
  delivery: DeviceDelivery
  os: string | null
  form: DeviceForm | null
  token: string | null
  keys: { p256dh: string; auth: string } | null
  timezone: string | null
  /** Read leniently: the owner writes it through PostgREST, and 065 checks only that it is an object. */
  prefs: unknown
  registered_at: string
  last_seen_at: string
}

/** What a send is about, and the notification itself. */
export interface DeviceMessage {
  kind: DeviceSendKind
  payload: PushPayload
}

/**
 * What one transport made of one device. NEVER a thrown error: a transport
 * answers, and an expired token in one must not cost the others.
 *
 *   · ok       — the push service took it. Taken, not shown.
 *   · terminal — the token is gone for good (web 404/410); the row is pruned.
 *   · otherwise the row stays, with `code` as its last failure.
 *
 * `code` matches 065's `last_failure` CHECK, `^[a-z0-9_]{1,64}$`: a short
 * code, never a provider's body.
 */
export type TransportOutcome = { ok: true } | { ok: false; terminal: boolean; code: string }

/** Why a device was not sent to. */
export type HeldReason =
  | 'no_transport' // transport 'none': nothing can push to it
  | 'local' // it schedules its own cues
  | 'native_wins' // the iPhone app on the same phone covers it
  | 'muted'
  | 'kind_off'
  | 'stale'
  | 'quiet'
  | 'no_sender' // a transport this build cannot send on yet (apns, fcm)
  | 'transport_off' // a transport this deployment has no credentials for (no VAPID pair)

export interface DeviceSendResult {
  deviceId: string
  transport: DeviceTransport
  outcome: 'accepted' | 'failed' | 'pruned' | 'held'
  /** The failure code, or the held reason. */
  code?: string
}

export interface SendReport {
  /** Rows the user has. Zero is an answer only when `detail` is absent. */
  devices: number
  /** Rows the selection let through: the devices a push was attempted on. */
  eligible: number
  /** Taken by a push service. */
  accepted: number
  /** Attempts that went nowhere; the row stays. */
  failed: number
  /** Rows deleted because their token is gone for good. */
  pruned: number
  /** Rows the selection held back, for any HeldReason. */
  held: number
  perDevice: DeviceSendResult[]
  /** Set ONLY when the rows could not be read; every count is then 0. */
  detail?: string
  /**
   * True while 065 is not applied: the send went through push_subscriptions
   * (009) instead, as it did before the registry. For one release only.
   */
  legacy?: boolean
}
