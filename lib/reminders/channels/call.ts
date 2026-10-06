/**
 * channels/call.ts — the phone rings.
 *
 * Behind the `phone-call` extension, off by default, and the only channel here
 * that can genuinely interrupt someone.
 *
 * WHY IT EXISTS. A notification can be dismissed without being processed —
 * that is most of why reminder features plateau. A ringing phone cannot: you
 * have to decide. That is also exactly why it is dangerous, so two defaults do
 * the work of keeping it usable:
 *
 *   1. It declines ordinary cues. `kinds` defaults to ['last-call'] — once a
 *      day, at the point where the day is nearly spent, about something with a
 *      streak on it. A call for every morning cue is how this gets uninstalled
 *      in a week, and a channel whose default setting makes people hate it is
 *      not a feature.
 *   2. It says the thing and hangs up. No menu, no "press 1" — a call that
 *      demands navigation while you are holding something is worse than the
 *      notification it replaced.
 *
 * Config:  to, from, kinds (default last-call only), voice (Twilio TTS voice)
 * Secrets: accountSid, authToken
 */

import { spokenLine } from '../copy'
import { escapeXml, twilioCredentials, twilioPost } from './twilio'
import type { NudgeChannel } from './types'
import { channelKinds, type Nudge, type NudgeKind } from '../nudge'

export const EXT_PHONE_CALL = 'phone-call'

/** Deliberately narrow. See the note above on why this is not both kinds. */
const DEFAULT_KINDS: readonly NudgeKind[] = ['last-call']

/**
 * What the user listed, narrowed to the reminder kinds (channelKinds): "cue"
 * is theirs to add, and the EOD review is not, so a phone never rings at the
 * review's hour to read out a line written for a notification.
 */
function kindsFor(config: Record<string, unknown>): readonly NudgeKind[] {
  const raw = config.kinds
  const listed = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === 'string')
    : typeof raw === 'string'
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : []
  return channelKinds(listed, DEFAULT_KINDS)
}

/**
 * The TwiML the call plays.
 *
 * Said TWICE, with a pause. Someone who answers a phone has usually missed the
 * first second of it, and a call that delivers its only copy of the message
 * into that second has rung for nothing.
 */
export function callTwiml(nudge: Nudge, voice: string): string {
  const line = escapeXml(spokenLine(nudge))
  const attr = `voice="${escapeXml(voice)}"`
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    `<Say ${attr}>${line}</Say>` +
    '<Pause length="1"/>' +
    `<Say ${attr}>${line}</Say>` +
    '</Response>'
  )
}

export const callChannel: NudgeChannel = {
  slug: EXT_PHONE_CALL,
  extensionSlug: EXT_PHONE_CALL,

  async deliver(nudge, ctx) {
    if (!kindsFor(ctx.config).includes(nudge.kind)) {
      return { ok: true, skipped: true, detail: `call declines ${nudge.kind}` }
    }

    const credentials = twilioCredentials(ctx.config, ctx.secrets)
    if (!credentials) return { ok: true, skipped: true, detail: 'call not configured' }

    const voice = typeof ctx.config.voice === 'string' && ctx.config.voice ? ctx.config.voice : 'alice'

    try {
      await twilioPost(credentials, 'Calls', {
        To: credentials.to,
        From: credentials.from,
        Twiml: callTwiml(nudge, voice),
      })
      return { ok: true, detail: `called ${credentials.to}` }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  },
}
