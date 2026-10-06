/**
 * channels/push.ts — the built-in channel: a web push notification.
 *
 * Always available (no extension gate) and the only channel that can put a
 * BUTTON in front of the user. That matters more than it sounds: the single
 * biggest friction cut available here is marking a habit done from the lock
 * screen without opening the app, and every study of this kind of prompt says
 * the gap between "saw the reminder" and "did the thing" is where the day is
 * lost. The Done action closes it in one tap.
 */

import { isPushConfigured, sendPushToUser, type PushPayload, type PushResult } from '../../push-send'
import type { Nudge, NudgeKind } from '../nudge'
import type { ChannelResult, NudgeChannel } from './types'

/** Matched in app/sw.ts. Changing either string breaks deployed notifications. */
export const ACTION_DONE = 'done'
export const ACTION_SNOOZE = 'snooze'

/**
 * How long Snooze defers a cue.
 *
 * Lives here, beside the button that promises it, so the label and the
 * behaviour cannot drift — /api/reminders/act imports this rather than picking
 * its own number, and a notification that says "15m" and means 30 is a small
 * lie the user has no way to check.
 *
 * Short on purpose. A snooze long enough to leave the moment is a dismissal
 * with extra steps.
 */
export const SNOOZE_MINUTES = 15

/** The topic for a push about one item: its UUID's 32 hex digits. */
export function itemTopic(itemId: string): string {
  return itemId.replace(/-/g, '')
}

/**
 * The topic for a push about one day as a whole: `lc-20260810`.
 *
 * The date drops its dashes to fit the 32 characters a topic may have. The
 * prefix keeps its own, which is what keeps every day topic apart from every
 * item topic: an item's is hex digits with no dash at all.
 */
export function dayTopic(prefix: 'lc' | 'eod' | 'pl', dateStr: string): string {
  return `${prefix}-${dateStr.replace(/-/g, '')}`
}

/**
 * How each kind travels: how hard the push service may wake a phone for it,
 * and which queued push it replaces (RFC 8030 §5.3, §5.4).
 *
 * Both kinds here are 'high'. A cue is the minute the user chose and a last
 * call is the day's final chance at a streak, so a push service that holds
 * either until the phone next wakes on its own has delivered it late. A
 * summary that can wait for the phone (the pledge notice) is 'normal'.
 *
 * A cue's topic is its item, so a snooze that matures while the phone is still
 * off replaces the cue it snoozed rather than queueing behind it. A last call's
 * is its day, whether it names one habit or three.
 *
 * Keyed by kind and total, so a new kind cannot ship without someone choosing.
 */
const DELIVERY: Record<
  NudgeKind,
  { urgency: NonNullable<PushPayload['urgency']>; topic: (nudge: Nudge) => string | undefined }
> = {
  cue: { urgency: 'high', topic: (nudge) => (nudge.itemId ? itemTopic(nudge.itemId) : undefined) },
  'last-call': { urgency: 'high', topic: (nudge) => dayTopic('lc', nudge.dateStr) },
}

/**
 * What a push came to, in the channel's terms.
 *
 * Three answers, and the middle one is why this exists. A push with no device
 * to go to used to report `ok: true` ("sent=0", read by nobody), so a user
 * whose only subscription had expired, or a deployment with no VAPID pair, got
 * a cue that reached no one and a tick that called it delivered. It is now
 * `unreached`: still ok (nothing is broken, and a retry finds the same
 * nothing), but no longer a delivery. Devices that all refused it are a
 * failure; one that took it is a delivery.
 *
 * A read that failed is a failure too, not "no devices": the zero it carries
 * is a question nobody answered, and calling it unreached would file a
 * database blip under "this user has no phone".
 */
function channelResultOf(result: PushResult): ChannelResult {
  if (result.detail) return { ok: false, detail: `push ${result.detail}` }
  if (result.devices === 0) {
    return {
      ok: true,
      unreached: true,
      detail: isPushConfigured() ? 'push: no device subscribed' : 'push: no VAPID pair configured',
    }
  }
  const counts = `expired=${result.expired} failed=${result.failed}`
  if (result.sent === 0) {
    return { ok: false, detail: `push failed: 0 of ${result.devices} accepted (${counts})` }
  }
  return { ok: true, detail: `push sent=${result.sent}/${result.devices} ${counts}` }
}

export const pushChannel: NudgeChannel = {
  slug: 'push',
  extensionSlug: null,
  async deliver(nudge, ctx) {
    // A Done button only makes sense when there is exactly one thing it could
    // mean. A last call naming three habits gets a plain click-through instead
    // of a button that silently picks one of them.
    const actionable = Boolean(nudge.itemId)
    const payload: PushPayload = {
      title: nudge.title,
      body: nudge.body,
      url: nudge.url,
      // Collapse on the item (or on the day, for a multi-item last call) so a
      // re-delivery REPLACES rather than stacks. A shade with four copies of
      // the same cue is how someone learns to swipe the whole app away.
      tag: nudge.itemId ? `dsul-item-${nudge.itemId}` : `dsul-${nudge.kind}-${nudge.dateStr}`,
      actions: actionable
        ? [
            { action: ACTION_DONE, title: 'Done' },
            { action: ACTION_SNOOZE, title: `Snooze ${SNOOZE_MINUTES}m` },
          ]
        : undefined,
      data: {
        url: nudge.url,
        itemId: nudge.itemId,
        dateStr: nudge.dateStr,
        kind: nudge.kind,
      },
      // Worked out by the scan, which holds the user's clock; this channel
      // only says it as a TTL. Without one the push service would hand a phone
      // switched on at noon its 07:30 cue, or yesterday's last call.
      ttl: nudge.expiresInSeconds,
      urgency: DELIVERY[nudge.kind].urgency,
      topic: DELIVERY[nudge.kind].topic(nudge),
    }

    let result: PushResult
    try {
      result = await sendPushToUser(ctx.service, ctx.userId, payload)
    } catch (err) {
      // sendPushToUser answers rather than throws. Caught anyway, because the
      // channel contract (types.ts) is this channel's to keep, not a promise
      // borrowed from the function it calls.
      return { ok: false, detail: `push threw: ${err instanceof Error ? err.message : String(err)}` }
    }
    return channelResultOf(result)
  },
}
