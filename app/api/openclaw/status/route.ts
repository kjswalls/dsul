import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

export type OpenclawConnectionState = 'not-connected' | 'pull-only' | 'connected'

export interface OpenclawStatusResponse {
  /**
   * not-connected — no API key on file, so device auth was never completed.
   * pull-only     — API key on file, but no chat URL registered. The plugin
   *                 works (context injection, tools); there is just no
   *                 publicUrl, so no webhook push and no plugin chat in Ask.
   * connected     — API key + chat URL. Everything is wired up.
   */
  state: OpenclawConnectionState
  /** Only meaningful in the `connected` state — registered alongside the chat URL. */
  agentId: string | null
}

/**
 * GET /api/openclaw/status
 *
 * Connection status for the OpenClaw integration, as shown in Settings.
 *
 * The authorization signal is `user_settings.openclaw_api_key`: it is written
 * only by the device-auth flow (`/api/agent/connect/authorize`) and it is the
 * exact credential `resolveUserIdFromApiKey` matches on, under a unique index.
 * A row that has one is, by construction, a key that authenticates.
 *
 * `openclaw_chat_url` is deliberately NOT the connection signal — the plugin
 * only registers it when the user set `publicUrl` in their plugin config, so a
 * healthy pull-only install has none. It distinguishes `pull-only` from
 * `connected`, nothing more.
 *
 * The API key itself is never returned here; this route answers a status
 * question, so it hands back a state, not a secret.
 */
export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data, error } = await supabase
      .from('user_settings')
      .select('openclaw_api_key, openclaw_chat_url, openclaw_agent_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const hasApiKey = typeof data?.openclaw_api_key === 'string' && data.openclaw_api_key.length > 0
    const hasChatUrl = typeof data?.openclaw_chat_url === 'string' && data.openclaw_chat_url.length > 0

    const state: OpenclawConnectionState = !hasApiKey
      ? 'not-connected'
      : hasChatUrl
        ? 'connected'
        : 'pull-only'

    const body: OpenclawStatusResponse = {
      state,
      agentId: state === 'connected' ? (data?.openclaw_agent_id ?? null) : null,
    }

    return NextResponse.json(body)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
