/**
 * channels/voice.ts — say it out loud, in the room where the habit happens.
 *
 * Delivers through Home Assistant's TTS service to whichever media players the
 * user names. Behind the `voice-announcements` extension, off by default.
 *
 * WHY THIS IS NOT JUST A LOUDER NOTIFICATION. The evidence this whole feature
 * rests on says habits form by pairing a behavior with a stable CONTEXT, and a
 * phone is the least context-bound object a person owns — it is in the same
 * pocket in the kitchen, on the train and at a desk. A speaker is not: the
 * kitchen speaker only ever fires in the kitchen, which makes it a better cue
 * for a kitchen habit than any notification can be.
 *
 * Config (user_extensions.config, browser-readable):
 *   baseUrl   — e.g. https://home.example.com  (Nabu Casa or your own domain)
 *   players   — comma-separated media_player entity ids
 *   ttsEntity — the tts.* entity to speak through (default tts.google_translate_say)
 *   kinds     — which nudges to speak (default REMINDER_KINDS: cue, last call;
 *               a list narrows them and never adds to them)
 * Secret (user_secrets.reminder_secrets.voice, service-role only):
 *   token     — a Home Assistant long-lived access token
 */

import { spokenLine } from '../copy'
import { channelKinds } from '../nudge'
import { assertSafeUrl, postToChannel, requireString } from './http'
import type { NudgeChannel } from './types'

export const EXT_VOICE_ANNOUNCEMENTS = 'voice-announcements'

/** Home Assistant's own default; overridable because most people change it. */
const DEFAULT_TTS_ENTITY = 'tts.google_translate_say'

function parseList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string')
  if (typeof raw !== 'string') return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

export const voiceChannel: NudgeChannel = {
  slug: EXT_VOICE_ANNOUNCEMENTS,
  extensionSlug: EXT_VOICE_ANNOUNCEMENTS,

  async deliver(nudge, ctx) {
    const baseUrl = requireString(ctx.config, 'baseUrl')
    const token = requireString(ctx.secrets, 'token')
    const players = parseList(ctx.config.players)

    // Not configured is NOT an error. The extension can be switched on before
    // the details are filled in, and a nightly log full of red for a half-built
    // integration teaches people to stop reading the log.
    if (!baseUrl || !token || players.length === 0) {
      return { ok: true, skipped: true, detail: 'voice not configured' }
    }

    // The `kinds` filter is what stops a speaker announcing every single cue in
    // a household where that would be intolerable. Absent means the habit
    // reminders, named rather than "everything", and a list can only narrow
    // them: the EOD review is not read out in the kitchen, even when someone
    // types it in (see channelKinds).
    const kinds = channelKinds(parseList(ctx.config.kinds))
    if (!kinds.includes(nudge.kind)) {
      return { ok: true, skipped: true, detail: `voice declines ${nudge.kind}` }
    }

    let endpoint: URL
    try {
      endpoint = assertSafeUrl(`${baseUrl.replace(/\/+$/, '')}/api/services/tts/speak`)
    } catch (err) {
      return { ok: false, detail: `bad baseUrl — ${(err as Error).message}` }
    }

    try {
      await postToChannel(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          entity_id: requireString(ctx.config, 'ttsEntity') ?? DEFAULT_TTS_ENTITY,
          media_player_entity_id: players,
          message: spokenLine(nudge),
        }),
      })
      return { ok: true, detail: `spoke on ${players.length} player(s)` }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  },
}
