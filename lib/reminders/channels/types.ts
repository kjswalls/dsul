/**
 * channels/types.ts — the interface every delivery channel implements.
 *
 * Locked deliberately early, before there was more than one channel, because
 * the whole point of the design is that Tier 2 (a speaker, a phone call, an
 * SMS) and anything after it are ADDED rather than woven in: a channel is a
 * manifest entry, a deliver() and nothing else. The scan never learns their
 * names.
 *
 * A channel MUST NOT throw to signal a delivery failure — return a failed
 * result instead. One misconfigured integration must never be able to stop the
 * other channels, or the user's push notification (the one that always works)
 * starts depending on whether their smart-home token expired.
 */

import type { Nudge } from '../nudge'
import type { TimeFormat } from '../copy'
import type { createServiceClient } from '../../supabase-service'

export interface ChannelContext {
  userId: string
  /** Service-role client — channels may need to read or stamp their own state. */
  service: ReturnType<typeof createServiceClient>
  /** The user's 12h/24h preference, for any channel that speaks a time. */
  timeFormat: TimeFormat
  /** The user's IANA zone. */
  timezone: string
  /**
   * Non-secret per-channel settings from user_extensions.config — a base URL,
   * a phone number, a list of speakers.
   */
  config: Record<string, unknown>
  /**
   * Per-channel credentials, read service-side from user_secrets and NEVER
   * reachable by the browser. Absent keys mean "not configured".
   */
  secrets: Record<string, string>
}

export interface ChannelResult {
  ok: boolean
  /** Human-readable, logged; shown to nobody. */
  detail?: string
  /** True when the channel declined because it isn't configured — not an error. */
  skipped?: boolean
  /**
   * True when the channel had nowhere to deliver: push, with no device
   * subscribed (or no VAPID pair to push with). `ok` stays true — nothing is
   * broken, and a retry finds the same nothing — but it is not a delivery
   * either, and the scan counts a nudge that every channel left unreached.
   */
  unreached?: boolean
}

export interface NudgeChannel {
  /**
   * Stable machine name. It keys BOTH the config bag (user_extensions.config)
   * and the secrets bag (user_secrets.reminder_secrets), and for every gated
   * channel it is IDENTICAL to `extensionSlug`.
   *
   * That identity is deliberate. The two bags live in different tables for
   * security reasons, and giving a channel a short internal name alongside a
   * longer user-facing extension slug would mean every lookup had to pick the
   * right one — a silent empty-object on the wrong guess, which reads exactly
   * like "not configured" and would be diagnosed as a user error for weeks.
   */
  slug: string
  /**
   * The extension slug in lib/extension-registry.ts that gates this channel, or
   * null for one that is always on. Push is the only null: it is the delivery
   * the app's own settings toggle already governs.
   */
  extensionSlug: string | null
  /** Which nudges this channel wants. A channel may decline a kind outright. */
  accepts?: (nudge: Nudge) => boolean
  deliver: (nudge: Nudge, ctx: ChannelContext) => Promise<ChannelResult>
}
