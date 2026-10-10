import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, resolveUserIdFromApiKey } from '@/lib/supabase-service'
import { fetchItemEvents } from '@/lib/db'

/**
 * GET /api/agent/items/:id/events — one item's activity trail.
 *
 * The agent's read side of the delegation loop. When a worker marks something
 * `blocked` and asks a question, the user's answer is appended here as an
 * `agent_reply` event; this is where the worker comes back for it. Also lets an
 * agent see what has happened to an item it is picking up mid-flight, rather
 * than starting from a title and a status.
 *
 * Deliberately its own route rather than an addition to /api/agent/context:
 * that response is `safeParse`d whole by the OpenClaw plugin, which THROWS on
 * drift — one bad field there bricks the plugin's entire cached context. A new
 * route can only break the caller that asks for it.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const serviceClient = createServiceClient()
    const userId = await resolveUserIdFromApiKey(authHeader.slice(7), serviceClient, 'read')
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params

    // The service client bypasses RLS, so ownership is the only thing standing
    // between this and another account's history.
    //
    // Checked HERE rather than by widening verifyItemOwnership to accept a null
    // type: that helper filters on `.eq('type', …)` and is the single guard on
    // every service-client write path, so making its type argument optional
    // would make it trivially easy for a future route to omit the check by
    // accident. A caller here has an id and no reason to know whether it names
    // a task, a habit or a goal — so this route does the id-only lookup itself
    // and leaves the shared guard exactly as strict as it was.
    const { data: owner } = await serviceClient
      .from('items')
      .select('user_id')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (!owner || owner.user_id !== userId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const events = await fetchItemEvents(id, serviceClient)
    return NextResponse.json({ itemId: id, events })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
