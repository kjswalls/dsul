/**
 * push-send.ts — one place that actually pushes.
 *
 * Extracted from app/api/push/send/route.ts when the reminder scan became a
 * second caller. The scan could have POSTed to that route the way
 * /api/cron/eod-notify does, and that pattern is exactly why this file exists:
 * a server route calling ITSELF over HTTP has to reconstruct its own origin
 * from a Host header, carry the service key in a header so it can authenticate
 * to itself, and pay a network round-trip per user — three failure modes bought
 * for no isolation whatsoever, since both ends run in the same deployment.
 *
 * The route keeps its HTTP surface (the browser and OpenClaw both use it) and
 * now delegates here. eod-notify was switched over in the same change rather
 * than left as the last self-fetching caller.
 */

import webPush, {
  type PushSubscription as WebPushSubscription,
  type RequestOptions,
  type Urgency,
} from 'web-push'
import type { createServiceClient } from './supabase-service'

type ServiceClient = ReturnType<typeof createServiceClient>

/**
 * One action button on a notification.
 *
 * Two is the practical ceiling: Chrome renders at most two on Android and
 * `maxActions` is 2 on most builds, so a third is silently dropped rather than
 * scrolled. Design for two and the notification looks the same everywhere.
 */
export interface PushAction {
  /** Matched in the service worker's notificationclick handler. */
  action: string
  title: string
}

export interface PushPayload {
  title: string
  body: string
  /** Where a plain click lands. */
  url?: string
  /**
   * Collapse key. Two notifications with the same tag replace rather than
   * stack, which is what keeps a re-delivered cue from becoming a pile.
   */
  tag?: string
  actions?: PushAction[]
  /** Echoed back to the service worker on click — the item id, the date. */
  data?: Record<string, unknown>

  // The three below are about the DELIVERY, not the notification. sendWebPush
  // turns them into RFC 8030 request headers and strips them from the
  // encrypted body, so the service worker never sees them.

  /**
   * Seconds the push service may hold this for a device that is off or out of
   * signal (RFC 8030 §5.2). Absent means DEFAULT_TTL_S, never web-push's own
   * four weeks; 0 means now or not at all. The caller that knows the moment
   * works it out: a push library with no clock cannot know when a cue stops
   * being one.
   */
  ttl?: number
  /** How hard the push service may wake the device for it (§5.3). Absent means 'normal'. */
  urgency?: Urgency
  /**
   * Replaces an UNDELIVERED push with the same topic in the push service's
   * queue (§5.4). `tag` collapses what is already in the shade; this collapses
   * what never got there, so a phone that was off wakes to the latest push
   * about a thing rather than every one sent while it was away. At most 32
   * characters of the URL-safe base64 alphabet: anything else is left off
   * (see transportOf), never sent.
   */
  topic?: string
}

/**
 * The TTL a push gets when its caller names none: six hours.
 *
 * web-push's own default (DEFAULT_TTL = 2419200 in its web-push-lib.js) is
 * four weeks, so a push to a phone left in a drawer used to arrive the next
 * time it was switched on, whenever that was, looking like news. Six hours
 * covers a phone that was off for an afternoon or a night and stops there.
 * What uses it is a caller with no window of its own, /api/push/send above
 * all, whose body has no field for one.
 */
export const DEFAULT_TTL_S = 6 * 3600

/** RFC 8030 §5.4: a Topic is 1 to 32 characters of the URL-safe base64 alphabet. */
const PUSH_TOPIC = /^[A-Za-z0-9_-]{1,32}$/

/** Is this a Topic a push service will accept? web-push throws on one it will not. */
export function isPushTopic(topic: string): boolean {
  return PUSH_TOPIC.test(topic)
}

export interface PushResult {
  /**
   * Subscriptions found for the user: the devices the push was attempted on.
   * Zero is an answer ("nowhere to push") only when `detail` is absent.
   */
  devices: number
  /** Accepted by the push service. Accepted, not shown: no push service promises the screen. */
  sent: number
  /** Endpoints the push service reported gone (404/410), deleted as they were found. */
  expired: number
  /**
   * Attempts that went nowhere but leave the endpoint in place: throttled, a
   * push service 5xx, the network, a VAPID key the service refused.
   */
  failed: number
  /**
   * Set ONLY when the subscriptions could not be read at all. Every count is
   * then 0, and that 0 is an unanswered question rather than an empty list —
   * which is why a caller checks this before it believes `devices`.
   */
  detail?: string
}

/** Where one push goes: web-push's own subscription shape, the browser's toJSON(). */
export type WebPushTarget = Pick<WebPushSubscription, 'endpoint' | 'keys'>

/**
 * The RFC 8030 delivery headers, under web-push's own names: how long the push
 * service may hold the message, how hard to wake the device for it, and what
 * it replaces in the service's queue. They describe the DELIVERY, not the
 * notification, so they travel as request headers and never in the encrypted
 * body the service worker reads.
 */
export type WebPushOptions = Pick<RequestOptions, 'TTL' | 'urgency' | 'topic'>

/** The notification the service worker reads: a PushPayload less its delivery fields. */
type PushBody = Omit<PushPayload, 'ttl' | 'urgency' | 'topic'>

/**
 * Split a payload into what is encrypted and what is a header.
 *
 * Every option is checked here rather than left to web-push, which THROWS on
 * a topic outside the alphabet or a negative TTL, and a throw inside
 * sendWebPush is a failed send to every device the user has. A topic that
 * cannot be sent costs the queue its collapse and nothing else; a TTL that is
 * not a number gets the default. A TTL below zero means the moment has already
 * passed, which is 0 ("now or not at all"), not the default.
 */
function transportOf(payload: PushPayload): { body: PushBody; options: WebPushOptions } {
  const { ttl, urgency, topic, ...body } = payload
  const options: WebPushOptions = {
    TTL: typeof ttl === 'number' && Number.isFinite(ttl) ? Math.max(0, Math.floor(ttl)) : DEFAULT_TTL_S,
  }
  if (urgency) options.urgency = urgency
  if (topic !== undefined && isPushTopic(topic)) options.topic = topic
  return { body, options }
}

/**
 * What one device's push came to.
 *
 *   · sent    — the push service took it (2xx);
 *   · expired — the endpoint is gone for good (404/410), and the caller prunes it;
 *   · failed  — nothing arrived and the endpoint stays: a retry, or a fixed
 *               key, can still reach it.
 */
export interface DeviceResult {
  outcome: 'sent' | 'expired' | 'failed'
  /** The push service's HTTP status, when it answered at all. */
  status?: number
  /** Why it did not go, for a log line. Absent on `sent`. */
  detail?: string
}

let vapidConfigured = false

/**
 * Returns false when VAPID isn't configured, so callers can degrade instead of
 * throwing. A personal deployment without keys should mean "push is off", not
 * "the reminder scan 500s for every user".
 */
export function isPushConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
}

function configureVapid(): void {
  if (vapidConfigured) return
  webPush.setVapidDetails(
    'mailto:hello@dsul.app',
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY as string,
    process.env.VAPID_PRIVATE_KEY as string,
  )
  vapidConfigured = true
}

/**
 * Sort a rejected send by what it means for the endpoint, not by what it
 * looked like.
 *
 * Only 404/410 prune. Everything else leaves the row alone, and two of those
 * are deliberate:
 *
 *   · 429 and 5xx are the push service having a bad minute. The endpoint is
 *     fine; deleting it would sign the device out of notifications over
 *     something the next tick gets through.
 *   · 401/403 is the push service refusing OUR VAPID key — a rotated pair, a
 *     malformed one in an environment variable. That is every subscription the
 *     deployment holds failing at once, and pruning on it would delete them all
 *     on the first tick after a bad deploy, when only the user's own browser can
 *     subscribe again. Fix the key and the same rows work.
 *
 * No status at all is the network, or web-push refusing before it sent
 * (unreadable keys on the row): failed, and kept, by the same reasoning.
 */
function classifyRejection(err: unknown): DeviceResult {
  const raw = (err as { statusCode?: unknown } | null)?.statusCode
  const status = typeof raw === 'number' ? raw : undefined
  if (status === 404 || status === 410) return { outcome: 'expired', status, detail: `gone (${status})` }
  if (status === 401 || status === 403) return { outcome: 'failed', status, detail: 'vapid rejected' }
  if (status !== undefined) return { outcome: 'failed', status, detail: `push service answered ${status}` }
  return { outcome: 'failed', detail: err instanceof Error ? err.message : String(err) }
}

/**
 * Push one payload to one device, and say what came of it. NEVER throws.
 *
 * Transport-shaped on purpose: it knows a subscription and a payload and
 * nothing about users, tables or which rows to prune. sendPushToUser below
 * reads push_subscriptions and calls this per row; a device registry reads its
 * own rows and calls the same function, so moving the read never moves the
 * send, its options or its classification.
 *
 * The payload is the encrypted body, less its delivery fields (ttl, urgency,
 * topic), which go as headers instead: see transportOf. They ride on the
 * payload rather than beside it so that every caller, and every device a
 * caller fans out to, sends the same headers for the same push.
 */
export async function sendWebPush(sub: WebPushTarget, payload: PushPayload): Promise<DeviceResult> {
  if (!isPushConfigured()) return { outcome: 'failed', detail: 'push not configured' }
  const { body, options } = transportOf(payload)
  try {
    // Inside the try: setVapidDetails throws on a malformed key, and a key
    // that cannot be used is a failed send, not a crashed caller.
    configureVapid()
    const response = await webPush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      JSON.stringify(body),
      options,
    )
    return { outcome: 'sent', status: response.statusCode }
  } catch (err) {
    return classifyRejection(err)
  }
}

/** Nothing was attempted. With a detail, the read failed; without one, there was nowhere to push. */
function nothingSent(detail?: string): PushResult {
  const result: PushResult = { devices: 0, sent: 0, expired: 0, failed: 0 }
  if (detail !== undefined) result.detail = detail
  return result
}

/**
 * Push one payload to every device a user has subscribed. NEVER throws.
 *
 * Requires a SERVICE client: push_subscriptions is RLS'd to the owner, and the
 * scan runs with no session at all.
 *
 * A failed read is answered — zeros and a `detail` — rather than thrown. It
 * used to throw, and the only thing that caught it was deliverNudge's
 * allSettled; every other caller had to remember a try of its own, and the
 * channel contract (lib/reminders/channels/types.ts) is that a delivery
 * failure is a result. Each caller now decides what an unanswered read costs.
 *
 * Expired endpoints (410 Gone / 404) are deleted as they are found. That is not
 * housekeeping — a user who reinstalls the PWA accumulates dead endpoints, and
 * every one of them is a request the scan pays for on every tick forever.
 */
export async function sendPushToUser(
  service: ServiceClient,
  userId: string,
  payload: PushPayload,
): Promise<PushResult> {
  if (!isPushConfigured()) return nothingSent()

  let subscriptions: { endpoint: string; p256dh: string; auth: string }[]
  try {
    const { data, error } = await service
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_id', userId)
    if (error) return nothingSent(`read failed: ${error.message}`)
    subscriptions = data ?? []
  } catch (err) {
    return nothingSent(`read failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (subscriptions.length === 0) return nothingSent()

  const results = await Promise.all(
    subscriptions.map((sub) =>
      sendWebPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload),
    ),
  )

  const expired = subscriptions
    .filter((_, i) => results[i].outcome === 'expired')
    .map((sub) => sub.endpoint)

  if (expired.length) {
    // Scoped to THIS user, which the version this was extracted from was not.
    // push_subscriptions is unique on (user_id, endpoint), not on endpoint
    // alone, so two accounts used in the same browser profile hold the same
    // endpoint string — an unscoped delete would sign the other account out of
    // notifications entirely. Harmless-looking in a route that ran on demand;
    // this now runs for every user on every tick.
    try {
      await service
        .from('push_subscriptions')
        .delete()
        .eq('user_id', userId)
        .in('endpoint', expired)
    } catch {
      // A prune that did not land retries itself: the endpoint answers 410
      // again on the next push and is deleted then. Not worth failing a
      // delivery that has already happened.
    }
  }

  return {
    devices: subscriptions.length,
    sent: results.filter((r) => r.outcome === 'sent').length,
    expired: expired.length,
    failed: results.filter((r) => r.outcome === 'failed').length,
  }
}
