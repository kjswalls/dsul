/**
 * channels/sms.ts — a text message.
 *
 * Behind the `sms-nudge` extension, off by default.
 *
 * The middle of the range, and the reason it is worth having alongside push:
 * an SMS lands in the one inbox people still read reflexively, on a device that
 * does not need dsul installed, with no permission prompt to have accepted
 * months ago and no service worker to have been evicted. It is what still works
 * on the day push quietly stopped.
 *
 * Unlike the call, it accepts both reminder kinds by default (REMINDER_KINDS:
 * the cue and the last call) — a text costs a fraction of a cent and is
 * glanceable, so the argument that keeps calls to once a day does not apply.
 * The EOD review is not one of them: it is push only unless the user lists it.
 *
 * Config:  to, from, kinds (default: REMINDER_KINDS)
 * Secrets: accountSid, authToken
 */

import { smsLine } from '../copy'
import { REMINDER_KINDS } from '../nudge'
import { twilioCredentials, twilioPost } from './twilio'
import type { NudgeChannel } from './types'

export const EXT_SMS_NUDGE = 'sms-nudge'

export const smsChannel: NudgeChannel = {
  slug: EXT_SMS_NUDGE,
  extensionSlug: EXT_SMS_NUDGE,

  async deliver(nudge, ctx) {
    const raw = ctx.config.kinds
    const listed =
      typeof raw === 'string' && raw.trim()
        ? raw.split(',').map((s) => s.trim()).filter(Boolean)
        : Array.isArray(raw)
          ? raw.filter((v): v is string => typeof v === 'string')
          : []
    // Blank is the named default, never "every kind there is": a kind added
    // to NudgeKind does not start texting anyone by being added.
    const kinds: readonly string[] = listed.length > 0 ? listed : REMINDER_KINDS
    if (!kinds.includes(nudge.kind)) {
      return { ok: true, skipped: true, detail: `sms declines ${nudge.kind}` }
    }

    const credentials = twilioCredentials(ctx.config, ctx.secrets)
    if (!credentials) return { ok: true, skipped: true, detail: 'sms not configured' }

    try {
      await twilioPost(credentials, 'Messages', {
        To: credentials.to,
        From: credentials.from,
        Body: smsLine(nudge),
      })
      return { ok: true, detail: `texted ${credentials.to}` }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  },
}
