/**
 * The registry's writes: register, release, rotate. Server only, through the
 * service role, and only ever after a route has established WHO (cookie now,
 * bearer in Phase 2d) — or, for the one no-session form, that the caller holds
 * the web push endpoint itself.
 *
 * register_device() (064) is the only writer of a row. It retires any row
 * holding the same (transport, token) under another (user, device) — the
 * token decides ownership, which is what closes #254 — then upserts on
 * (user_id, device_id). This file adds the 12-hour touch throttle in front of
 * it: a browser re-registers on every boot, and an unchanged registration seen
 * within the last 12 hours writes nothing.
 *
 * DEPLOY LEADS MIGRATION. Until 064 is applied, a web push registration is the
 * pre-registry upsert into push_subscriptions (009) and a release deletes from
 * it, for one release; anything else answers `unavailable`.
 */

import type { DeviceRegistration } from '@dsul/types'
import type { createServiceClient } from '../supabase-service'
import { isMissingRegistry } from './db'

type ServiceClient = ReturnType<typeof createServiceClient>

/** A re-registration that changes nothing writes nothing if the row was seen this recently. */
export const TOUCH_THROTTLE_MS = 12 * 60 * 60 * 1000

export type RegistryResult =
  | { ok: true; written: boolean; legacy?: true }
  | { ok: false; code: 'unavailable' | 'failed' | 'not_found'; detail?: string }

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The columns a touch compares, and the throttle's clock. */
const EXISTING_COLUMNS =
  'id, platform, transport, delivery, os, form, token, keys, apns_environment, parent_device_id, ' +
  'app_version, os_version, timezone, last_seen_at, last_failure'

interface Existing {
  id: string
  platform: string
  transport: string
  delivery: string
  os: string | null
  form: string | null
  token: string | null
  keys: { p256dh?: string; auth?: string } | null
  apns_environment: string | null
  parent_device_id: string | null
  app_version: string | null
  os_version: string | null
  timezone: string | null
  last_seen_at: string
  last_failure: string | null
}

/**
 * Would this registration change the row? The coalesced fields (os, form,
 * parent, versions, zone) keep their value when the body leaves them out, so
 * only a value that is sent can differ. A row carrying a failure is always
 * re-written: a fresh registration is the device saying it works again.
 */
function unchanged(row: Existing, reg: DeviceRegistration): boolean {
  const same = (sent: string | undefined, held: string | null) => sent === undefined || sent === held
  return (
    row.platform === reg.platform &&
    row.transport === reg.transport &&
    row.delivery === (reg.delivery ?? 'push') &&
    (row.token ?? undefined) === reg.token &&
    (row.keys?.p256dh ?? undefined) === reg.keys?.p256dh &&
    (row.keys?.auth ?? undefined) === reg.keys?.auth &&
    (row.apns_environment ?? undefined) === reg.apnsEnvironment &&
    same(reg.os, row.os) &&
    same(reg.form, row.form) &&
    same(reg.parentDeviceId, row.parent_device_id) &&
    same(reg.appVersion, row.app_version) &&
    same(reg.osVersion, row.os_version) &&
    same(reg.timezone, row.timezone) &&
    row.last_failure === null
  )
}

/** register_device()'s fifteen arguments, in its own order. Exported for the test that pins them. */
export function registerArgs(userId: string, reg: DeviceRegistration, label: string | null) {
  return {
    p_user_id: userId,
    p_device_id: reg.deviceId,
    p_platform: reg.platform,
    p_transport: reg.transport,
    p_delivery: reg.delivery ?? 'push',
    p_os: reg.os ?? null,
    p_form: reg.form ?? null,
    p_token: reg.token ?? null,
    p_keys: reg.keys ?? null,
    p_apns_environment: reg.apnsEnvironment ?? null,
    p_parent_device_id: reg.parentDeviceId ?? null,
    p_label: label,
    p_app_version: reg.appVersion ?? null,
    p_os_version: reg.osVersion ?? null,
    p_timezone: reg.timezone ?? null,
  }
}

/**
 * Register (or touch) one device for an authenticated user.
 *
 * `label` is written only for a NEW row: register_device keeps an existing
 * label when it is passed null, and the label is the owner's to rename
 * (064's UPDATE grant). A browser's suggested name ("Chrome on Mac") sent on
 * every boot would otherwise undo the rename each time.
 */
export async function registerDevice(
  service: ServiceClient,
  userId: string,
  reg: DeviceRegistration,
  nowMs: number = Date.now(),
): Promise<RegistryResult> {
  try {
    const { data, error } = await service
      .from('devices')
      .select(EXISTING_COLUMNS)
      .eq('user_id', userId)
      .eq('device_id', reg.deviceId)
      .maybeSingle()
    if (error) {
      if (isMissingRegistry(error)) return legacyRegister(service, userId, reg)
      return { ok: false, code: 'failed', detail: error.message }
    }
    const existing = data as unknown as Existing | null
    if (existing && unchanged(existing, reg)) {
      const seen = Date.parse(existing.last_seen_at)
      if (Number.isFinite(seen) && nowMs - seen < TOUCH_THROTTLE_MS) return { ok: true, written: false }
    }
    const { error: rpcError } = await service.rpc(
      'register_device',
      registerArgs(userId, reg, existing ? null : (reg.label ?? null)),
    )
    if (rpcError) {
      if (isMissingRegistry(rpcError)) return { ok: false, code: 'unavailable' }
      return { ok: false, code: 'failed', detail: rpcError.message }
    }
    return { ok: true, written: true }
  } catch (err) {
    return { ok: false, code: 'failed', detail: messageOf(err) }
  }
}

/**
 * Release by web push endpoint, with NO session (#254). The endpoint is the
 * capability to push already, so releasing it grants nothing new; a miss is a
 * no-op, and the route answers `{ ok: true }` either way. Web push only: an
 * APNs or FCM token cannot send by itself, and an open delete-by-token for one
 * would be a free denial of service.
 *
 * The filter is the endpoint and nothing else. Never a user id: the caller
 * has none, and the row it needs gone may be someone else's.
 */
export async function releaseWebPushToken(service: ServiceClient, token: string): Promise<RegistryResult> {
  try {
    const { error } = await service.from('devices').delete().eq('transport', 'webpush').eq('token', token)
    if (!error) return { ok: true, written: true }
    if (!isMissingRegistry(error)) return { ok: false, code: 'failed', detail: error.message }
    const legacy = await service.from('push_subscriptions').delete().eq('endpoint', token)
    if (legacy.error) return { ok: false, code: 'failed', detail: legacy.error.message }
    return { ok: true, written: true, legacy: true }
  } catch (err) {
    return { ok: false, code: 'failed', detail: messageOf(err) }
  }
}

/** Release one of the session user's own devices by its id (the desktop app's tokenless row, a native logout). */
export async function releaseOwnDevice(
  service: ServiceClient,
  userId: string,
  deviceId: string,
): Promise<RegistryResult> {
  try {
    const { error } = await service.from('devices').delete().eq('user_id', userId).eq('device_id', deviceId)
    if (!error) return { ok: true, written: true }
    // No registry, so no row by that id: nothing to release.
    if (isMissingRegistry(error)) return { ok: true, written: false, legacy: true }
    return { ok: false, code: 'failed', detail: error.message }
  } catch (err) {
    return { ok: false, code: 'failed', detail: messageOf(err) }
  }
}

/**
 * The service worker's `pushsubscriptionchange`: the browser replaced this
 * endpoint. The row holding `oldToken` for this user keeps its device id,
 * prefs and label and takes the new token through register_device, so
 * `registered_at` moves and nothing else does. No row holds it (the browser
 * gave no old subscription, or it was already released) ⇒ `not_found`, and
 * the app's next boot registers the new endpoint the ordinary way.
 */
export async function rotateWebPushToken(
  service: ServiceClient,
  userId: string,
  oldToken: string,
  next: { token: string; keys: { p256dh: string; auth: string } },
  nowMs: number = Date.now(),
): Promise<RegistryResult> {
  try {
    const { data, error } = await service
      .from('devices')
      .select('device_id, platform, delivery')
      .eq('user_id', userId)
      .eq('transport', 'webpush')
      .eq('token', oldToken)
      .maybeSingle()
    if (error) {
      if (!isMissingRegistry(error)) return { ok: false, code: 'failed', detail: error.message }
      const gone = await service.from('push_subscriptions').delete().eq('user_id', userId).eq('endpoint', oldToken)
      if (gone.error) return { ok: false, code: 'failed', detail: gone.error.message }
      return legacyUpsert(service, userId, next.token, next.keys)
    }
    const row = data as { device_id: string; platform: DeviceRegistration['platform']; delivery: 'push' | 'local' } | null
    if (!row) return { ok: false, code: 'not_found' }
    return registerDevice(
      service,
      userId,
      {
        deviceId: row.device_id,
        platform: row.platform,
        transport: 'webpush',
        delivery: row.delivery,
        token: next.token,
        keys: next.keys,
      },
      nowMs,
    )
  } catch (err) {
    return { ok: false, code: 'failed', detail: messageOf(err) }
  }
}

async function legacyRegister(service: ServiceClient, userId: string, reg: DeviceRegistration): Promise<RegistryResult> {
  if (reg.transport !== 'webpush' || !reg.token || !reg.keys) return { ok: false, code: 'unavailable' }
  return legacyUpsert(service, userId, reg.token, reg.keys)
}

/** The pre-registry write, exactly as /api/push/subscribe made it, but through the service role. */
async function legacyUpsert(
  service: ServiceClient,
  userId: string,
  endpoint: string,
  keys: { p256dh: string; auth: string },
): Promise<RegistryResult> {
  const { error } = await service
    .from('push_subscriptions')
    .upsert({ user_id: userId, endpoint, p256dh: keys.p256dh, auth: keys.auth }, { onConflict: 'user_id,endpoint' })
  if (error) return { ok: false, code: 'failed', detail: error.message }
  return { ok: true, written: true, legacy: true }
}
