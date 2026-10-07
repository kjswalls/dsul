import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-service'

const DSUL_URL = 'https://do.dsul.app'
const POLL_RATE_LIMIT_MS = 2000 // 1 poll per 2s per session

/**
 * GET /api/agent/connect/poll?session=<sessionId>
 *
 * Polls a connect session for status. No authentication required.
 * Session ID is a UUID (128-bit entropy) — unguessable.
 *
 * Rate limit: 1 request per 2 seconds per session (tracked via last_polled_at).
 *
 * Returns:
 *   { status: "pending" }
 *   { status: "expired" }
 *   { status: "authorized", apiKey: string, dsulUrl: string }  — one-shot, marks consumed
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const sessionId = searchParams.get('session')
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing session parameter' }, { status: 400 })
    }

    const service = createServiceClient()

    const { data: session, error } = await service
      .from('connect_sessions')
      .select('id, status, expires_at, api_key, last_polled_at')
      .eq('id', sessionId)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    // Check expiry
    if (new Date(session.expires_at) <= new Date()) {
      return NextResponse.json({ status: 'expired' })
    }

    // Poll rate limit: reject if polled too recently
    if (session.last_polled_at) {
      const msSinceLast = Date.now() - new Date(session.last_polled_at).getTime()
      if (msSinceLast < POLL_RATE_LIMIT_MS) {
        return NextResponse.json(
          { error: 'Polling too fast. Wait 2 seconds between polls.' },
          { status: 429 }
        )
      }
    }

    // Update last_polled_at
    const { error: pollUpdateErr } = await service
      .from('connect_sessions')
      .update({ last_polled_at: new Date().toISOString() })
      .eq('id', sessionId)

    if (pollUpdateErr) {
      console.warn('[poll] Failed to update last_polled_at:', pollUpdateErr.message)
    }

    if (session.status === 'pending') {
      return NextResponse.json({ status: 'pending' })
    }

    if (session.status === 'authorized') {
      // One-shot: mark consumed atomically, then return the key. The row's
      // copy of the key goes with it: a consumed session has no further use
      // for it, and it should not outlive the hand-off.
      const { error: consumeErr } = await service
        .from('connect_sessions')
        .update({ status: 'consumed', consumed_at: new Date().toISOString(), api_key: null })
        .eq('id', sessionId)
        .eq('status', 'authorized') // guard against double-consumption

      if (consumeErr) {
        return NextResponse.json({ error: consumeErr.message }, { status: 500 })
      }

      return NextResponse.json({
        status: 'authorized',
        apiKey: session.api_key,
        dsulUrl: DSUL_URL,
      })
    }

    // consumed or other terminal state
    return NextResponse.json({ status: session.status })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
