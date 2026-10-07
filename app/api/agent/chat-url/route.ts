import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { readAgentKey } from '@/lib/supabase-service'
import { pluginChatToken } from '@/lib/plugin-chat-token'

/**
 * GET /api/agent/chat-url
 * Returns the stored openclaw_chat_url, agentId, and the plugin CHAT TOKEN for
 * the current authenticated user: what the browser needs to POST at the
 * user's OpenClaw plugin directly.
 *
 * The token is an HMAC of the agent key (lib/plugin-chat-token.ts) that the
 * plugin accepts on its chat route and dsul's agent API does not accept at
 * all. The agent key itself never leaves the server (#123, #142).
 */
export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const [{ data, error }, apiKey] = await Promise.all([
      supabase
        .from('user_settings')
        .select('openclaw_chat_url, openclaw_agent_id')
        .eq('user_id', user.id)
        .maybeSingle(),
      readAgentKey(user.id),
    ])

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({
      chatUrl: data?.openclaw_chat_url ?? null,
      agentId: data?.openclaw_agent_id ?? null,
      chatToken: apiKey ? pluginChatToken(apiKey) : null,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
