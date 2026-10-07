/**
 * deliver.ts — fan one nudge out to every channel the user has turned on.
 *
 * The registry below is the extension point: a new delivery route is an entry
 * in CHANNELS plus a manifest entry in lib/extension-registry.ts. The scan does
 * not know how many channels exist and never has to.
 *
 * ISOLATION IS THE CONTRACT. Channels are dispatched concurrently and every
 * rejection is caught here, so a smart-home token that expired last week cannot
 * stop the push notification that has worked every day. A channel that throws
 * is reported as failed and nothing else happens — which is why `deliverNudge`
 * resolves rather than rejects, always.
 */

import { resolveEnabled } from '../extension-registry'
import { pushChannel } from './channels/push'
import { voiceChannel } from './channels/voice'
import { callChannel } from './channels/call'
import { smsChannel } from './channels/sms'
import type { ChannelContext, ChannelResult, NudgeChannel } from './channels/types'
import type { Nudge } from './nudge'

/**
 * Every known channel, in the order their results are reported.
 *
 * Push is first and always on. Everything after it is gated behind an
 * extension the user has to switch on themselves — the default for a feature
 * that can phone you is off.
 */
export const CHANNELS: NudgeChannel[] = [pushChannel, voiceChannel, smsChannel, callChannel]

export interface DeliveryReport {
  channel: string
  ok: boolean
  skipped: boolean
  /** The channel had nowhere to deliver (ChannelResult.unreached). */
  unreached: boolean
  detail?: string
}

export interface DeliverOptions {
  /**
   * Sparse per-user extension toggles (the user_extensions rows). Resolved
   * against the manifest default, exactly as the app's own store does — so a
   * user who never touched a toggle gets the manifest's answer and not `false`
   * by accident.
   */
  extensionEnabled: Record<string, boolean>
  /**
   * Per-channel non-secret settings — user_extensions.config, keyed by slug.
   * Browser-readable by RLS, which is what lets the settings page show them.
   */
  configs: Record<string, Record<string, unknown>>
  /**
   * Per-channel credentials — user_secrets.reminder_secrets, keyed by the same
   * slug. service_role only; this map must never be serialised to a client.
   */
  secrets: Record<string, Record<string, string>>
}

/** Is this channel switched on for this user? */
export function channelIsOn(
  channel: NudgeChannel,
  extensionEnabled: Record<string, boolean>,
): boolean {
  if (channel.extensionSlug === null) return true
  return resolveEnabled(extensionEnabled, channel.extensionSlug)
}

export async function deliverNudge(
  nudge: Nudge,
  base: Omit<ChannelContext, 'config' | 'secrets'>,
  options: DeliverOptions,
): Promise<DeliveryReport[]> {
  const active = CHANNELS.filter(
    (channel) =>
      channelIsOn(channel, options.extensionEnabled) &&
      (channel.accepts?.(nudge) ?? true),
  )

  const settled = await Promise.allSettled(
    active.map(async (channel): Promise<ChannelResult> =>
      channel.deliver(nudge, {
        ...base,
        config: options.configs[channel.slug] ?? {},
        secrets: options.secrets[channel.slug] ?? {},
      }),
    ),
  )

  return settled.map((outcome, i) => {
    const channel = active[i]
    if (outcome.status === 'fulfilled') {
      return {
        channel: channel.slug,
        ok: outcome.value.ok,
        skipped: outcome.value.skipped ?? false,
        unreached: outcome.value.unreached ?? false,
        detail: outcome.value.detail,
      }
    }
    const reason = outcome.reason
    return {
      channel: channel.slug,
      ok: false,
      skipped: false,
      unreached: false,
      detail: reason instanceof Error ? reason.message : String(reason),
    }
  })
}
