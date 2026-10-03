import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { createServiceClient } from '@/lib/supabase-service'
import { assertAllowedGatewayUrl } from '@/lib/openclaw-gateway'

/**
 * /api/agent/gateway — read and write the user's OpenClaw gateway connection.
 *
 * The URL is not a secret and lives in user_settings. The token is FULL
 * OPERATOR ACCESS to the gateway, lives in user_secrets (no anon/authenticated
 * policies — service role only, migration 012), and is NEVER returned: GET
 * reports whether one is stored, never what it is.
 *
 * Contrast /api/agent/chat-url, which hands the browser an API key so it can
 * POST at the gateway itself. That is the arrangement this transport exists to
 * retire; it stays only until the plugin chat path is removed.
 */

/** PostgREST's shape for "that column/table isn't there yet". */
function isMissingSchema(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return (
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    /column\b.*\bdoes not exist/i.test(error.message ?? '')
  )
}

interface GatewayBody {
  gatewayUrl?: string | null
  token?: string | null
}

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // The URL comes back through the session client (RLS-scoped); the token's
    // presence is checked with the service client because the user's own JWT
    // deliberately cannot read user_secrets at all.
    const [settingsRes, secretsRes] = await Promise.all([
      supabase
        .from('user_settings')
        .select('openclaw_gateway_url, openclaw_agent_id')
        .eq('user_id', user.id)
        .maybeSingle(),
      createServiceClient()
        .from('user_secrets')
        .select('openclaw_gateway_token')
        .eq('user_id', user.id)
        .maybeSingle(),
    ])

    // A database without migration 040 means "nothing is configured", which is
    // true and renderable — not an error state for the settings page to
    // explain. Same contract as /api/reminders/secrets.
    if (isMissingSchema(settingsRes.error) || isMissingSchema(secretsRes.error)) {
      return NextResponse.json({
        gatewayUrl: null,
        agentId: null,
        hasToken: false,
        configured: false,
        unavailable: true,
      })
    }

    const settings = settingsRes.data
    const secrets = secretsRes.data
    const gatewayUrl = settings?.openclaw_gateway_url ?? null
    const hasToken = Boolean(secrets?.openclaw_gateway_token)

    return NextResponse.json({
      gatewayUrl,
      agentId: settings?.openclaw_agent_id ?? null,
      hasToken,
      /** Both halves present — the client uses this to pick its transport. */
      configured: Boolean(gatewayUrl && hasToken),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: GatewayBody
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    // Each field is optional so the settings UI can update the URL without
    // making the user retype a token it can never show them.
    if (body.gatewayUrl !== undefined) {
      let url: string | null = null
      if (body.gatewayUrl !== null && body.gatewayUrl.trim() !== '') {
        // Validated on the way IN as well as before each fetch: this URL is
        // one the server will make authenticated outbound requests to, so it
        // never gets stored unchecked.
        const allowed = assertAllowedGatewayUrl(body.gatewayUrl)
        if (!allowed.ok) return NextResponse.json({ error: allowed.reason }, { status: 400 })
        url = allowed.url
      }
      // upsert, not update: an account with no user_settings row yet would get
      // a successful no-op — the settings page would say saved, the transport
      // would stay on the plugin path, and nothing anywhere would disagree.
      const { error } = await supabase
        .from('user_settings')
        .upsert({ user_id: user.id, openclaw_gateway_url: url }, { onConflict: 'user_id' })
      if (isMissingSchema(error)) {
        return NextResponse.json(
          { error: 'Needs migration 040. Run pnpm db:push.', unavailable: true },
          { status: 503 }
        )
      }
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (body.token !== undefined) {
      const token = body.token === null || body.token.trim() === '' ? null : body.token.trim()
      const { error } = await createServiceClient()
        .from('user_secrets')
        .upsert({ user_id: user.id, openclaw_gateway_token: token }, { onConflict: 'user_id' })
      if (isMissingSchema(error)) {
        return NextResponse.json(
          { error: 'Needs migration 040. Run pnpm db:push.', unavailable: true },
          { status: 503 }
        )
      }
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
