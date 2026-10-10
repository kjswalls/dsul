import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, readAgentKey, storeAgentKey } from '@/lib/supabase-service'

/**
 * POST /api/agent/connect/authorize
 *
 * Authorizes a pending device session. Requires a valid Supabase access token
 * passed as a Bearer token in the Authorization header. Using Bearer token instead
 * of cookies because this route is called from a browser page that may have just
 * completed an OAuth login (Google), where the session lives in-memory/localStorage
 * rather than an HttpOnly cookie.
 *
 * Body: { userCode: "ABCD-1234" }
 *
 * - Looks up the session by user_code (status=pending, not expired)
 * - Reuses existing openclaw_api_key if user already has one, otherwise generates new
 * - Updates session: status='authorized', user_id, api_key
 * - Stores api_key in user_secrets (service-role only; never user_settings,
 *   which the user's browser can read)
 */
export async function POST(req: NextRequest) {
  try {
    // Require Bearer token auth — supports post-OAuth flows where cookies aren't set
    const authHeader = req.headers.get('Authorization') ?? ''
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!bearerToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Validate the token by calling getUser with it via service client
    const service = createServiceClient()
    const { data: { user }, error: authError } = await service.auth.getUser(bearerToken)
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json().catch(() => null)
    const userCode = typeof body?.userCode === 'string' ? body.userCode.trim().toUpperCase() : ''
    if (!userCode) {
      return NextResponse.json({ error: 'Missing userCode' }, { status: 400 })
    }

    // Look up the pending, unexpired session
    const { data: session, error: sessionErr } = await service
      .from('connect_sessions')
      .select('id, status, expires_at')
      .eq('user_code', userCode)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()

    if (sessionErr) {
      return NextResponse.json({ error: sessionErr.message }, { status: 500 })
    }
    if (!session) {
      return NextResponse.json(
        { error: 'Invalid or expired code. Please start setup again.' },
        { status: 404 }
      )
    }

    // Reuse existing API key if the user already has one
    let apiKey = await readAgentKey(user.id, service)

    if (!apiKey) {
      // Generate a new key: "dsul_" + 32 random hex bytes
      const raw = crypto.getRandomValues(new Uint8Array(32))
      apiKey = 'dsul_' + Array.from(raw).map((b) => b.toString(16).padStart(2, '0')).join('')

      const { error: upsertErr } = await storeAgentKey(user.id, apiKey, service)
      if (upsertErr) {
        return NextResponse.json({ error: upsertErr }, { status: 500 })
      }
    }

    // Mark session as authorized (status guard prevents double-authorization race)
    const { error: updateErr } = await service
      .from('connect_sessions')
      .update({ status: 'authorized', user_id: user.id, api_key: apiKey })
      .eq('id', session.id)
      .eq('status', 'pending')

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
