import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, resolveUserIdFromApiKey } from '@/lib/supabase-service'
import { updateItem } from '@/lib/db'
import { getItemTypeConfig } from '@/lib/item-registry'
import { AiStatusSchema } from '@dsul/types'

/**
 * POST /api/agent/items/:id/progress — a worker says where it has got to.
 *
 * Was the generic task PATCH, which verified only that the row belonged to the
 * caller's ACCOUNT. That left the delegation loop's central race wide open:
 *
 *   Worker A marks an item `working` and is slow but alive. An hour later the
 *   user, seeing no update, taps Try again — the item goes back to `queued`.
 *   Worker B picks it up and finishes it. Then A, still running, reports
 *   `done` with its own result, and the write lands unconditionally on top.
 *
 * The user opens the item and reads A's report — written against a premise they
 * had already discarded — with B's result gone from the panel. Worse if A
 * reports `blocked`: the item flips back from finished to "needs you", asking a
 * question from the run they killed.
 *
 * So this route is a COMPARE-AND-SET on `ai_status_at`. A worker passes the
 * stamp it last read; the write is refused if the item has moved since. That is
 * what makes the UI's Try again honest rather than merely rare — before it, the
 * button's whole safety argument was that a double run was unlikely.
 *
 * `lastSeenAt` is optional, because a worker taking a never-touched item has no
 * stamp to send. Absent, the write proceeds — an unconditional first report is
 * exactly what it should be.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const serviceClient = createServiceClient()
    const userId = await resolveUserIdFromApiKey(authHeader.slice(7), serviceClient, 'write')
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params

    let body: { aiStatus?: unknown; aiResult?: unknown; lastSeenAt?: unknown }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsedStatus = AiStatusSchema.safeParse(body.aiStatus)
    if (!parsedStatus.success) {
      return NextResponse.json(
        { error: `aiStatus must be one of: ${AiStatusSchema.options.join(', ')}` },
        { status: 400 }
      )
    }
    const aiStatus = parsedStatus.data
    const aiResult = typeof body.aiResult === 'string' ? body.aiResult : undefined
    const lastSeenAt = typeof body.lastSeenAt === 'string' ? body.lastSeenAt : undefined

    // The service client bypasses RLS, so ownership is the only thing between
    // this and another account's item. Id-only lookup for the same reason the
    // sibling routes give: `verifyItemOwnership` filters on `.eq('type', …)`,
    // and a caller here has an id with no reason to know the type.
    const { data: owner } = await serviceClient
      .from('items')
      .select('user_id, type, assignee, ai_status_at')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (!owner || owner.user_id !== userId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    if (!getItemTypeConfig(owner.type as string).agentAssignable) {
      return NextResponse.json(
        { error: `${owner.type} items cannot be delegated` },
        { status: 400 }
      )
    }
    if (!owner.assignee) {
      // Reporting on work nobody handed over. `AgentSection` shows the assign
      // button rather than a status block, so the report would render nowhere
      // — and an unassigned item is one the user has taken back.
      return NextResponse.json({ error: 'That item is not assigned' }, { status: 409 })
    }

    // The compare-and-set. Compared as INSTANTS, not strings: Postgres and the
    // client can spell the same moment differently ('+00:00' vs 'Z', varying
    // fractional digits), and a string compare would refuse every write for a
    // reason no worker could diagnose.
    if (lastSeenAt !== undefined) {
      const seen = Date.parse(lastSeenAt)
      const current = owner.ai_status_at ? Date.parse(String(owner.ai_status_at)) : NaN
      if (!Number.isFinite(seen) || !Number.isFinite(current) || seen !== current) {
        return NextResponse.json(
          {
            error:
              'That item has changed since you last read it: someone else has taken it, or ' +
              'the user has stepped in. Re-read it with dsul_my_work before reporting.',
            currentStatusAt: owner.ai_status_at ?? null,
          },
          { status: 409 }
        )
      }
    }

    // Through updateItem so the `tasks.updated` webhook (a permanent contract)
    // and the activity-feed entry still fire, and so `ai_status_at` is stamped
    // as the declared companion of the status.
    try {
      await updateItem(
        id,
        owner.type as string,
        { aiStatus, ...(aiResult !== undefined ? { aiResult } : {}) },
        userId,
        serviceClient
      )
    } catch {
      return NextResponse.json({ error: 'Could not update the item' }, { status: 500 })
    }

    return NextResponse.json({ itemId: id, aiStatus })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
