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

import { sendToUser } from '../../devices/send'
import type { SendReport } from '../../devices/types'
import { isPushConfigured, type PushPayload } from '../../push-send'
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

/**
 * The topic for a push about one day as a whole: `lc-20260810`.
 *
 * The date drops its dashes to fit the 32 characters a topic may have, and the
 * prefix keeps the kinds apart, so a day's last call never replaces its review.
 * Two kinds and no more, one each a day: the pledge notice has no topic either
 * (lib/stakes/pledge.ts), because a catch-up sends one per day it settles.
 */
export function dayTopic(prefix: 'lc' | 'eod', dateStr: string): string {
  return `${prefix}-${dateStr.replace(/-/g, '')}`
}

/**
 * How each kind travels: how hard the push service may wake a phone for it,
 * and which queued push it replaces (RFC 8030 §5.3, §5.4).
 *
 * The two reminder kinds are 'high'. A cue is the minute the user chose and a
 * last call is the day's final chance at a streak, so a push service that
 * holds either until the phone next wakes on its own has delivered it late.
 * What can wait for the phone is 'normal': the EOD review, an invitation that
 * stays good until midnight and is no worse for arriving when the phone is
 * next picked up, and the pledge notice after it.
 *
 * A last call's topic is its day, whether it names one habit or three, and so
 * is the review's: two topics a day at most, whatever the user has set, and
 * each gone by its midnight.
 *
 * A cue has NO topic. Chrome's push service is FCM, which holds at most four
 * collapse keys per device and makes no promise which four it keeps
 * (memory/plans/reminders-platforms.md §2.4 quotes the limit). Whether FCM
 * reads a web push's Topic as one of those keys is not confirmed here, and the
 * cost if it does is silent: keyed by item, a morning of six habits cued at
 * 07:00 to a phone out of signal until 07:20 is six topics, and two cues never
 * arrive while every send came back 201, the claims spent and the tick
 * reporting six delivered. Without a topic a push is non-collapsible and
 * waits beside the others. All the item topic bought was a snooze maturing
 * while the phone was still off replacing its cue in the queue, and the
 * `dsul-item-<id>` tag already does that in the shade, where two would show.
 *
 * Keyed by kind and total, so a new kind cannot ship without someone choosing.
 */
const DELIVERY: Record<
  NudgeKind,
  { urgency: NonNullable<PushPayload['urgency']>; topic: (nudge: Nudge) => string | undefined }
> = {
  cue: { urgency: 'high', topic: () => undefined },
  'last-call': { urgency: 'high', topic: (nudge) => dayTopic('lc', nudge.dateStr) },
  eod: { urgency: 'normal', topic: (nudge) => dayTopic('eod', nudge.dateStr) },
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
 * "No device" is every device the registry HELD as well as none at all: a
 * phone whose last-call switch is off, or one the iPhone app covers, is not a
 * device this push went to (lib/devices/select.ts).
 *
 * A read that failed is a failure too, not "no devices": the zero it carries
 * is a question nobody answered, and calling it unreached would file a
 * database blip under "this user has no phone".
 */
function channelResultOf(result: SendReport, kind: Nudge['kind']): ChannelResult {
  if (result.detail) return { ok: false, detail: `push ${result.detail}` }
  if (result.eligible === 0) {
    const detail =
      result.devices === 0
        ? isPushConfigured()
          ? 'push: no device subscribed'
          : 'push: no VAPID pair configured'
        : isPushConfigured()
          ? `push: no device takes ${kind} (held=${result.held})`
          : 'push: no VAPID pair configured'
    return { ok: true, unreached: true, detail }
  }
  const held = result.held > 0 ? ` held=${result.held}` : ''
  const counts = `expired=${result.pruned} failed=${result.failed}${held}`
  if (result.accepted === 0) {
    return { ok: false, detail: `push failed: 0 of ${result.eligible} accepted (${counts})` }
  }
  return { ok: true, detail: `push sent=${result.accepted}/${result.eligible} ${counts}` }
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
      // Collapse on the item (or on the day, for a multi-item last call and
      // for the EOD review, whose `dsul-eod-<date>` is the tag its old route
      // sent) so a re-delivery REPLACES rather than stacks. A shade with four
      // copies of the same cue is how someone learns to swipe the whole app
      // away.
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
        // What the service worker acks once it has shown this (cue_log, 067).
        ...(nudge.logKey ? { key: nudge.logKey } : {}),
      },
      // Worked out by the scan, which holds the user's clock, and passed on as
      // the instant it is: push-send turns it into a TTL as each device's
      // request leaves, so the device read in between is not added on after
      // midnight. Without one the push service would hand a phone switched on
      // at noon its 07:30 cue, or yesterday's last call.
      expiresAtMs: nudge.expiresAtMs,
      urgency: DELIVERY[nudge.kind].urgency,
      topic: DELIVERY[nudge.kind].topic(nudge),
    }

    let result: SendReport
    try {
      // Through the device registry, which picks the devices that take this
      // kind (lib/devices/select.ts) and sends on each one's transport.
      result = await sendToUser(ctx.service, ctx.userId, { kind: nudge.kind, payload })
    } catch (err) {
      // sendToUser answers rather than throws. Caught anyway, because the
      // channel contract (types.ts) is this channel's to keep, not a promise
      // borrowed from the function it calls.
      return { ok: false, detail: `push threw: ${err instanceof Error ? err.message : String(err)}` }
    }
    return channelResultOf(result, nudge.kind)
  },
}
