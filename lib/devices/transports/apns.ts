/**
 * The APNs transport: a `devices` row with transport 'apns', the iPhone app's
 * (memory/plans/reminders-platforms.md §5.4, Phase 3). Server only.
 *
 * What reaches a phone this way is what its own triggers do not cover: the
 * last call and the pledge notice. Cues, snoozes and the review are armed on
 * the phone itself (`delivery 'local'`), and selectDevices() holds those
 * kinds back before a send ever gets here. The one other thing it sends is a
 * silent wake (`wake()`, lib/devices/wake.ts), which tells the phone to
 * re-plan those triggers after an item changed somewhere else.
 *
 * Five rules, each from Apple's documentation or from the way the obvious
 * version goes wrong:
 *
 *   · OFF UNTIL CONFIGURED. Without APNS_TEAM_ID, APNS_KEY_ID, APNS_KEY_P8
 *     and APNS_BUNDLE_ID (or with a key that does not parse) `available()` is
 *     false, so every apns row is HELD (`transport_off`), never failed and
 *     never pruned, exactly as web push is without a VAPID pair.
 *   · ONE PROVIDER TOKEN, REUSED. An ES256 JWT signed with the .p8 key, minted
 *     once and reused for 50 minutes: Apple refuses one older than an hour
 *     (`ExpiredProviderToken`) and throttles one renewed more often than every
 *     20 (`TooManyProviderTokenUpdates`). A 403 ExpiredProviderToken mints a
 *     fresh one and tries once more; nothing else re-mints.
 *   · THE HOST FOLLOWS THE TOKEN. A token from a development build is valid
 *     only on the sandbox host, and the row says which it is
 *     (`apns_environment`). Sent to the other host it answers BadDeviceToken,
 *     which is terminal, so the wrong host would prune a good phone.
 *   · PRUNED ONLY ON APPLE'S WORD. 400 BadDeviceToken and
 *     DeviceTokenNotForTopic are terminal. 410 Unregistered is terminal only
 *     when its `timestamp` is after the row's `registered_at`: a token the
 *     phone registered again since Apple stopped taking it is the phone's
 *     newer word. A 403 is OUR key, and pruning on it would empty every phone
 *     on the first send after a bad deploy.
 *   · NEVER THROWS. A transport answers (lib/devices/send.ts); the network
 *     and a malformed key are codes.
 */

import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { connect } from 'node:http2'
import { DEFAULT_TTL_S, type PushPayload } from '../../push-send'
import type { DeviceMessage, DeviceRow, TransportOutcome } from '../types'

/** The cue category the iPhone app registers, with Done and Snooze (ios/DsulCore ReminderPlan.swift `cueCategory`). */
export const APNS_CUE_CATEGORY = 'DSUL_CUE'
/** The lock-screen thread a ritual stacks under (lib/reminders/plan.ts RITUAL_THREAD). */
export const APNS_RITUAL_THREAD = 'dsul.rituals'

/** Apple's limit on an alert's payload. */
export const APNS_MAX_PAYLOAD_BYTES = 4096
/** Apple's limit on `apns-collapse-id`. */
const COLLAPSE_ID_BYTES = 64
/** How long a provider token is reused: inside Apple's 20-to-60-minute window. */
export const PROVIDER_TOKEN_TTL_MS = 50 * 60_000
/** How long one request may take before it is a network failure. */
const REQUEST_TIMEOUT_MS = 10_000

export const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const

/** A device token: 32 bytes as hex today; Apple says not to assume the length. */
export const APNS_TOKEN = /^[0-9a-f]{64,200}$/i

export interface ApnsConfig {
  teamId: string
  keyId: string
  key: KeyObject
  bundleId: string
}

const TEAM_OR_KEY_ID = /^[A-Z0-9]{10}$/
const BUNDLE_ID = /^[A-Za-z0-9.-]{1,155}$/

let parsed: { source: string; config: ApnsConfig | null } | null = null

/**
 * The deployment's APNs credentials, or null when any is missing or malformed.
 * The .p8 key is accepted as Apple downloads it or with its newlines escaped
 * as `\n`, which is how a multi-line value usually survives a dashboard.
 * Parsed once per distinct value.
 */
export function apnsConfig(env: Record<string, string | undefined> = process.env): ApnsConfig | null {
  const teamId = env.APNS_TEAM_ID?.trim() ?? ''
  const keyId = env.APNS_KEY_ID?.trim() ?? ''
  const bundleId = env.APNS_BUNDLE_ID?.trim() ?? ''
  const pem = (env.APNS_KEY_P8 ?? '').replace(/\\n/g, '\n').trim()
  const source = [teamId, keyId, bundleId, pem].join('\u0000')
  if (parsed?.source === source) return parsed.config

  let config: ApnsConfig | null = null
  if (TEAM_OR_KEY_ID.test(teamId) && TEAM_OR_KEY_ID.test(keyId) && BUNDLE_ID.test(bundleId) && pem) {
    try {
      const key = createPrivateKey({ key: pem, format: 'pem' })
      if (key.asymmetricKeyType === 'ec') config = { teamId, keyId, key, bundleId }
    } catch {
      config = null
    }
  }
  parsed = { source, config }
  return config
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url')

/** A provider token: ES256 over `{alg, kid}.{iss, iat}`, the signature in JOSE's r||s form. */
export function mintProviderToken(config: ApnsConfig, nowMs: number): string {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }))
  const claims = b64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(nowMs / 1000) }))
  const input = `${header}.${claims}`
  const signature = sign('sha256', Buffer.from(input), { key: config.key, dsaEncoding: 'ieee-p1363' })
  return `${input}.${b64url(signature)}`
}

/** The token cache: one per team and key, reused for PROVIDER_TOKEN_TTL_MS. */
export interface ProviderTokens {
  get(config: ApnsConfig, nowMs: number): string
  /** Drop the cached token after Apple called it expired. */
  renew(config: ApnsConfig, nowMs: number): string
}

export function providerTokens(mint: typeof mintProviderToken = mintProviderToken): ProviderTokens {
  let cached: { id: string; token: string; mintedAt: number } | null = null
  const fresh = (config: ApnsConfig, nowMs: number) => {
    cached = { id: `${config.teamId}.${config.keyId}`, token: mint(config, nowMs), mintedAt: nowMs }
    return cached.token
  }
  return {
    get(config, nowMs) {
      const id = `${config.teamId}.${config.keyId}`
      if (cached && cached.id === id && nowMs - cached.mintedAt < PROVIDER_TOKEN_TTL_MS && nowMs >= cached.mintedAt) {
        return cached.token
      }
      return fresh(config, nowMs)
    },
    renew: fresh,
  }
}

export interface ApnsRequest {
  headers: Record<string, string>
  body: string
}

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 512 ? v : undefined)

/**
 * The request a payload becomes, less its path and authorization, as of
 * `nowMs`. Null when it cannot be sent at all (over Apple's 4 KB).
 *
 *   · `apns-expiration` is the sooner of `ttl` and `expiresAtMs`, as an epoch
 *     second; 0 is Apple's "now or not at all", which is what a window already
 *     past means. With neither, DEFAULT_TTL_S, never Apple's own indefinite hold.
 *   · `apns-priority` 10 for 'high' urgency, 5 otherwise: a last call wakes
 *     the phone, a pledge notice waits for it.
 *   · `apns-collapse-id` is the tag, which already keys a re-delivery to its
 *     slot on the web (lib/reminders/channels/push.ts tagOf).
 *   · The Done and Snooze buttons are the phone's own `DSUL_CUE` category, and
 *     only for a notification about one item on one day, as on the web.
 *   · The app reads its userInfo as strings: `url`, `itemId`, `dateStr`,
 *     `kind`, `key`, and nothing else from `data`.
 */
export function apnsRequestOf(payload: PushPayload, nowMs: number, bundleId: string): ApnsRequest | null {
  const limits: number[] = []
  if (typeof payload.ttl === 'number' && Number.isFinite(payload.ttl)) limits.push(nowMs + payload.ttl * 1000)
  if (typeof payload.expiresAtMs === 'number' && Number.isFinite(payload.expiresAtMs)) limits.push(payload.expiresAtMs)
  const until = limits.length > 0 ? Math.min(...limits) : nowMs + DEFAULT_TTL_S * 1000
  const expiration = until <= nowMs ? 0 : Math.floor(until / 1000)

  const headers: Record<string, string> = {
    'apns-push-type': 'alert',
    'apns-topic': bundleId,
    'apns-priority': payload.urgency === 'high' ? '10' : '5',
    'apns-expiration': String(expiration),
  }
  if (payload.tag && Buffer.byteLength(payload.tag, 'utf8') <= COLLAPSE_ID_BYTES) headers['apns-collapse-id'] = payload.tag

  const data = payload.data ?? {}
  const custom: Record<string, string> = {}
  const url = str(payload.url) ?? str(data.url)
  if (url) custom.url = url
  for (const field of ['itemId', 'dateStr', 'kind', 'key'] as const) {
    const value = str(data[field])
    if (value) custom[field] = value
  }
  const buttons = (payload.actions ?? []).some((a) => a.action === 'done')
  const aps: Record<string, unknown> = {
    alert: { title: payload.title, body: payload.body },
    sound: 'default',
    'thread-id': APNS_RITUAL_THREAD,
  }
  if (buttons && custom.itemId && custom.dateStr) aps.category = APNS_CUE_CATEGORY

  const body = JSON.stringify({ aps, ...custom })
  if (Buffer.byteLength(body, 'utf8') > APNS_MAX_PAYLOAD_BYTES) return null
  return { headers, body }
}

/** What Apple answered, as a response with its `reason` and, for a 410, its `timestamp`. */
export interface ApnsResponse {
  status: number
  reason?: string
  /** Epoch milliseconds: when Apple last knew the token was valid (410 only). */
  timestamp?: number
}

/** Apple's answer, for the row. `registeredAt` is when this row's token was registered. */
export function outcomeOf(res: ApnsResponse, registeredAt: string): TransportOutcome {
  if (res.status === 200) return { ok: true }
  const reason = res.reason ?? ''
  if (res.status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic')) {
    return { ok: false, terminal: true, code: reason === 'BadDeviceToken' ? 'bad_device_token' : 'not_for_topic' }
  }
  if (res.status === 410) {
    const registered = Date.parse(registeredAt)
    const newer = typeof res.timestamp === 'number' && Number.isFinite(registered) && res.timestamp > registered
    return newer ? { ok: false, terminal: true, code: 'gone_410' } : { ok: false, terminal: false, code: 'unregistered_before' }
  }
  if (res.status === 403) return { ok: false, terminal: false, code: 'provider_token_rejected' }
  if (res.status === 413) return { ok: false, terminal: false, code: 'payload_too_large' }
  if (res.status === 429) {
    return { ok: false, terminal: false, code: reason === 'TooManyProviderTokenUpdates' ? 'token_updates' : 'throttled' }
  }
  if (res.status >= 500) return { ok: false, terminal: false, code: 'apns_error' }
  return { ok: false, terminal: false, code: `http_${res.status}` }
}

/** One HTTP/2 POST to APNs. Rejects only on the network; any status is an answer. */
export type ApnsPost = (origin: string, headers: Record<string, string>, body: string) => Promise<ApnsResponse>

/** The default ApnsPost: a session per request, closed when it answers. */
export const http2Post: ApnsPost = (origin, headers, body) =>
  new Promise((resolve, reject) => {
    let settled = false
    const session = connect(origin)
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      session.close()
      fn()
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      session.destroy()
      reject(new Error('timeout'))
    }, REQUEST_TIMEOUT_MS)
    session.on('error', (err) => done(() => reject(err)))
    const req = session.request({ ':method': 'POST', ...headers })
    let status = 0
    let text = ''
    req.setEncoding('utf8')
    req.on('response', (h) => {
      status = Number(h[':status'] ?? 0)
    })
    req.on('data', (chunk: string) => {
      if (text.length < 4096) text += chunk
    })
    req.on('end', () =>
      done(() => {
        let reason: string | undefined
        let timestamp: number | undefined
        try {
          const json = JSON.parse(text) as { reason?: unknown; timestamp?: unknown }
          if (typeof json.reason === 'string') reason = json.reason
          if (typeof json.timestamp === 'number') timestamp = json.timestamp
        } catch {
          // An empty 200, or a body that is not JSON: the status says enough.
        }
        resolve({ status, reason, timestamp })
      }),
    )
    req.on('error', (err) => done(() => reject(err)))
    req.end(body)
  })

export interface ApnsDeps {
  config: () => ApnsConfig | null
  post: ApnsPost
  tokens: ProviderTokens
  now: () => number
}

/** What a send needs of a row: its token, its host, and when it was registered. */
export type ApnsTarget = Pick<DeviceRow, 'token' | 'apns_environment' | 'registered_at'>

/** What a wake carries for the app: why it was sent (ios AppDelegate reads `dsul.reason`). */
export const APNS_WAKE_REASON = 'items'

/**
 * The background wake (PR-3c): no alert, no sound, only `content-available`,
 * so iOS launches the app in the background to fetch and re-plan
 * (lib/devices/wake.ts sends it).
 *
 *   · `apns-push-type: background` at priority 5: Apple refuses 10 for a push
 *     with no alert.
 *   · `apns-expiration: 0`, now or never. APNs holds ONE notification per app
 *     for a phone that is off, and a held wake would replace a held last call.
 *     A phone that missed its wake re-plans when it is next opened anyway.
 */
export function apnsWakeRequest(bundleId: string): ApnsRequest {
  return {
    headers: {
      'apns-push-type': 'background',
      'apns-topic': bundleId,
      'apns-priority': '5',
      'apns-expiration': '0',
    },
    body: JSON.stringify({ aps: { 'content-available': 1 }, dsul: { reason: APNS_WAKE_REASON } }),
  }
}

export function createApnsTransport(deps: ApnsDeps) {
  /** One request to one row: the checks every send makes, the one re-mint, Apple's answer as an outcome. */
  async function deliver(
    device: ApnsTarget,
    build: (config: ApnsConfig, nowMs: number) => ApnsRequest | null,
  ): Promise<TransportOutcome> {
    const config = deps.config()
    if (!config) return { ok: false, terminal: false, code: 'not_configured' }
    if (!device.token || !APNS_TOKEN.test(device.token)) return { ok: false, terminal: false, code: 'no_token' }
    const env = device.apns_environment
    if (env !== 'production' && env !== 'sandbox') return { ok: false, terminal: false, code: 'no_environment' }

    const nowMs = deps.now()
    const request = build(config, nowMs)
    if (!request) return { ok: false, terminal: false, code: 'payload_too_large' }
    const origin = APNS_HOSTS[env]
    const path = `/3/device/${device.token.toLowerCase()}`

    const attempt = async (token: string) =>
      deps.post(origin, { ':path': path, authorization: `bearer ${token}`, ...request.headers }, request.body)

    try {
      let res = await attempt(deps.tokens.get(config, nowMs))
      if (res.status === 403 && res.reason === 'ExpiredProviderToken') {
        res = await attempt(deps.tokens.renew(config, nowMs))
      }
      return outcomeOf(res, device.registered_at)
    } catch {
      return { ok: false, terminal: false, code: 'network' }
    }
  }

  return {
    available: () => deps.config() !== null,

    send(device: DeviceRow, message: DeviceMessage): Promise<TransportOutcome> {
      return deliver(device, (config, nowMs) => apnsRequestOf(message.payload, nowMs, config.bundleId))
    },

    /** The silent wake: the phone fetches its planner and re-plans its own triggers. */
    wake(device: ApnsTarget): Promise<TransportOutcome> {
      return deliver(device, (config) => apnsWakeRequest(config.bundleId))
    },
  }
}

export const apnsTransport = createApnsTransport({
  config: () => apnsConfig(),
  post: http2Post,
  tokens: providerTokens(),
  now: () => Date.now(),
})
