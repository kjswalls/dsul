/**
 * The service worker's event handlers, out of app/sw.ts so a unit test can
 * drive them (memory/plans/reminders-platforms.md §2.1, PR-1b).
 *
 * app/sw.ts is the thin half: it registers listeners and hands each event to
 * one of these with an `SwContext` built on `self`. Everything that decides
 * something (which envelope a push came in, what the notification looks like,
 * which route a button calls, what is acked and what the page is told) is
 * here, against that context, never against `self`.
 *
 * IMPORTS NOTHING. This file is bundled into the worker, and pulling in the
 * app's module graph to share a few string literals would drag Supabase and
 * the whole registry in behind it. The action ids below are mirrored from
 * lib/reminders/channels/push.ts and lib/reminders/act.ts, and are effectively
 * frozen: a notification on a lock screen was written by a build that may be
 * days older than the worker handling its click.
 */

export const ACTION_DONE = 'done'
export const ACTION_SNOOZE = 'snooze'
/** The native notification's third button (lib/reminders/act.ts). No web push offers it yet. */
export const ACTION_SKIP = 'skip'

const ACTIONS: readonly string[] = [ACTION_DONE, ACTION_SNOOZE, ACTION_SKIP]

/**
 * What the Snooze button promises, mirrored from lib/reminders/channels/push.ts
 * for the page tick, which builds the same notification without the sender.
 * tests/unit/sw-handlers.test.ts holds the two equal.
 */
export const SNOOZE_MINUTES = 15

/** What the page tick hears when a Snooze tapped here was stored (hooks/use-local-cue-tick.ts). */
export const SNOOZED_MESSAGE = 'dsul:snoozed'

export interface SnoozedMessage {
  type: typeof SNOOZED_MESSAGE
  itemId: string
  dateStr: string
  /** reminder_snooze_until as the act route stored it. */
  until: string
}

export interface PushPayload {
  title?: string
  body?: string
  url?: string
  tag?: string
  actions?: { action: string; title: string }[]
  data?: Record<string, unknown>
}

/**
 * `actions` and `renotify` are real on ServiceWorkerRegistration.showNotification
 * but absent from the DOM lib's NotificationOptions, the type that resolves
 * here. Declared rather than left to `any`, so a typo in an action id is still
 * caught.
 */
export interface SwNotificationOptions extends NotificationOptions {
  actions?: { action: string; title: string }[]
  /**
   * Alert again when replacing a notification that shares this one's tag.
   * Without it a replacement lands SILENTLY (the Notifications spec), and the
   * cue's tag is item-scoped (`dsul-item-<id>`), so yesterday's cue sitting
   * unread in the shade would swallow today's.
   */
  renotify?: boolean
}

export interface ClientLike {
  url: string
  focus?: () => Promise<unknown>
  navigate?: (url: string) => Promise<unknown>
  postMessage?: (message: unknown) => void
}

/** Everything a handler may touch, built on `self` by app/sw.ts and faked by the test. */
export interface SwContext {
  origin: string
  showNotification(title: string, options: SwNotificationOptions): Promise<void>
  fetch(input: string, init: RequestInit): Promise<{ ok: boolean; json(): Promise<unknown> }>
  matchClients(): Promise<readonly ClientLike[]>
  openWindow(url: string): Promise<unknown>
  /** This worker's push endpoint, or null; it stands in for a device id the worker cannot read. */
  pushEndpoint(): Promise<string | null>
}

const ICON = '/icons/icon-192.png'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function actionsOf(v: unknown): PushPayload['actions'] {
  if (!Array.isArray(v)) return undefined
  const out = v
    .filter(isRecord)
    .map((a) => ({ action: str(a.action) ?? '', title: str(a.title) ?? '' }))
    .filter((a) => a.action && a.title)
  return out.length > 0 ? out : undefined
}

/**
 * A push's payload, in either envelope.
 *
 *   · dsul's own: `{ title, body, url, tag, actions, data }` (lib/push-send.ts).
 *   · the declarative one (RFC 8030 magic `web_push: 8030`, Safari 18.4+):
 *     `{ web_push: 8030, notification: { title, body, navigate, tag, actions, data } }`.
 *     A browser that runs no worker for it shows it itself; one that does
 *     hands it here, and it must come out as the same notification.
 *
 * Anything else, or text that is not JSON, is a bare notification.
 */
export function payloadFromPush(raw: unknown): PushPayload {
  if (typeof raw === 'string') return { title: 'dsul', body: raw }
  if (!isRecord(raw)) return {}
  if (raw.web_push === 8030 && isRecord(raw.notification)) {
    const n = raw.notification
    const url = str(n.navigate)
    return {
      title: str(n.title),
      body: str(n.body),
      url,
      tag: str(n.tag),
      actions: actionsOf(n.actions),
      data: isRecord(n.data) ? n.data : url ? { url } : undefined,
    }
  }
  return {
    title: str(raw.title),
    body: str(raw.body),
    url: str(raw.url),
    tag: str(raw.tag),
    actions: actionsOf(raw.actions),
    data: isRecord(raw.data) ? raw.data : undefined,
  }
}

/** The notification a payload becomes. The page tick builds its own through this too. */
export function notificationFor(payload: PushPayload): { title: string; options: SwNotificationOptions } {
  return {
    title: payload.title ?? 'dsul',
    options: {
      body: payload.body ?? '',
      icon: ICON,
      badge: ICON,
      // Collapse key: a re-delivered cue REPLACES the one already on screen.
      tag: payload.tag,
      // Only meaningful with a tag, and only correct with one: renotify
      // without a tag throws a TypeError.
      renotify: Boolean(payload.tag),
      actions: payload.actions,
      data: { url: payload.url ?? '/', ...(payload.data ?? {}) },
    },
  }
}

/**
 * Tell the server this device showed the cue (POST /api/reminders/ack), when
 * the push named one. Never throws: an ack is a measurement, not a delivery.
 */
async function ack(ctx: SwContext, key: unknown): Promise<void> {
  if (typeof key !== 'string' || !key) return
  try {
    const endpoint = await ctx.pushEndpoint()
    if (!endpoint) return
    await ctx.fetch('/api/reminders/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ key, endpoint }),
    })
  } catch {
    // Offline, or signed out. The cue was shown; only the measurement is lost.
  }
}

/** `push`: show it, then ack it. */
export async function handlePush(ctx: SwContext, raw: unknown): Promise<void> {
  const payload = payloadFromPush(raw)
  const { title, options } = notificationFor(payload)
  await ctx.showNotification(title, options)
  await ack(ctx, payload.data?.key)
}

/**
 * Tell the user when an action button did NOT do what it promised. Without
 * this a failed Done is indistinguishable from a successful one, and the user
 * believes the day is handled. `requireInteraction` keeps the correction up.
 */
export async function reportActionFailure(ctx: SwContext, itemTitle: string | undefined): Promise<void> {
  await ctx.showNotification("Couldn't save that", {
    body: itemTitle ? `${itemTitle} is still open. Tap to mark it in dsul.` : 'Tap to mark it in dsul.',
    icon: ICON,
    badge: ICON,
    tag: 'dsul-action-failed',
    requireInteraction: true,
    data: { url: '/' },
  })
}

/** Focus an existing tab on this URL if there is one, else steer one, else open one. */
export async function openOrFocus(ctx: SwContext, url: string): Promise<void> {
  // client.url is absolute; `url` is a path off our own origin.
  const target = new URL(url, ctx.origin).href
  const clients = await ctx.matchClients()
  for (const client of clients) {
    if (client.url === target && client.focus) return void (await client.focus())
  }
  for (const client of clients) {
    if (!client.navigate || !client.focus) continue
    try {
      await client.focus()
      await client.navigate(target)
      return
    } catch {
      // navigate() rejects on a client this worker does not control, which
      // matchAll({includeUncontrolled: true}) deliberately returns.
      break
    }
  }
  await ctx.openWindow(target)
}

export interface ClickEvent {
  action: string
  title: string | undefined
  data: unknown
}

/** `notificationclick`: a plain click opens the app; a button calls the act route. */
export async function handleNotificationClick(ctx: SwContext, event: ClickEvent): Promise<void> {
  const data = (isRecord(event.data) ? event.data : {}) as { url?: string; itemId?: string; dateStr?: string }
  if (!ACTIONS.includes(event.action)) return openOrFocus(ctx, data.url ?? '/')
  if (!data.itemId) return reportActionFailure(ctx, event.title)
  try {
    const res = await ctx.fetch('/api/reminders/act', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Same-origin, and the session cookie is what authorises the write.
      credentials: 'include',
      body: JSON.stringify({ action: event.action, itemId: data.itemId, dateStr: data.dateStr }),
    })
    if (!res.ok) return reportActionFailure(ctx, event.title)
    if (event.action === ACTION_SNOOZE) await tellPagesOfSnooze(ctx, res, data.itemId, data.dateStr)
  } catch {
    // Offline, most likely. Say so rather than swallowing it.
    await reportActionFailure(ctx, event.title)
  }
}

/**
 * A snooze stored, told to every open page, so a page tick that is in use
 * can claim it when it matures and ring it there (hooks/use-local-cue-tick.ts).
 * Never throws: the snooze is stored, and the scan rings it if no page does.
 */
async function tellPagesOfSnooze(
  ctx: SwContext,
  res: { json(): Promise<unknown> },
  itemId: string,
  dateStr: string | undefined,
): Promise<void> {
  try {
    const body = await res.json()
    const until = isRecord(body) ? str(body.snoozedUntil) : undefined
    if (!until || !dateStr) return
    const message: SnoozedMessage = { type: SNOOZED_MESSAGE, itemId, dateStr, until }
    for (const client of await ctx.matchClients()) client.postMessage?.(message)
  } catch {
    // Nothing to tell.
  }
}

/**
 * `pushsubscriptionchange`: the browser replaced this worker's subscription.
 * `next` is often absent (Chrome has never filled it in), and the caller
 * re-subscribes with the old key first. Tells /api/devices/rotate with the
 * cookie, which moves the row holding the old endpoint onto the new one. A
 * rotation the server cannot place is left to the app's next boot. Never throws.
 */
export async function handleSubscriptionChange(
  ctx: SwContext,
  oldEndpoint: string | null,
  next: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | null,
): Promise<void> {
  try {
    if (!next?.endpoint || !next.keys?.p256dh || !next.keys?.auth) return
    await ctx.fetch('/api/devices/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        oldToken: oldEndpoint,
        token: next.endpoint,
        keys: { p256dh: next.keys.p256dh, auth: next.keys.auth },
      }),
    })
  } catch {
    // Offline, or the push service refused. The next boot heals it.
  }
}
