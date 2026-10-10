import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, resolveUserIdFromApiKey } from '@/lib/supabase-service'
import { MAX_QUESTION_OPTIONS, recordAgentQuestion, updateItem } from '@/lib/db'
import { getItemTypeConfig } from '@/lib/item-registry'

/**
 * POST /api/agent/items/:id/ask — the agent asks the user something answerable
 * in one tap.
 *
 * `dsul_report_progress` with status `blocked` already lets a worker ask a
 * question; what it cannot do is offer ANSWERS. Most of the questions that
 * actually block delegated work are choices, not essays — which Dana, which of
 * the two invoices, is Thursday still fine — and making the user retype a name
 * into a box is the difference between a loop that closes in a second and one
 * that waits until they have the energy to compose a sentence.
 *
 * Does both halves in ONE call, and — unlike every other event writer — WAITS
 * for the question to land before flipping the status. An earlier version of
 * this route claimed atomicity it did not have: `recordItemEvent` is
 * fire-and-forget by design, so the insert could be lost (or never sent at all,
 * if a serverless invocation froze the moment the response returned) while the
 * block stuck. The user would then see the question with no buttons, and the
 * tool result would have told the agent it had offered them.
 *
 * So the question is written FIRST and awaited. If it fails, nothing changed
 * and the agent gets an error it can retry. If the status flip then fails, the
 * event is an orphan — harmless, because the panel only offers buttons for a
 * question that matches the item's CURRENT `aiResult`, and nothing renders a
 * reply box at all unless `aiStatus` is `blocked`.
 *
 * Its own route rather than a field on the task PATCH, for the reason the
 * sibling events route gives: `/api/agent/context` is `safeParse`d whole by the
 * OpenClaw plugin, which THROWS on drift, and every `taskShape` field spreads
 * into that frozen projection. Options ride in `item_events.payload`, which is
 * `jsonb` and was designed to absorb exactly this.
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

    let body: { question?: unknown; options?: unknown }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const question = typeof body.question === 'string' ? body.question.trim() : ''
    if (!question) {
      return NextResponse.json(
        { error: 'question is required (it is what the user reads)' },
        { status: 400 }
      )
    }

    // Dropped rather than rejected: the question is the useful part, and a
    // malformed options array should cost the buttons, not the whole ask. The
    // user still gets the text box, which is where they were before this route
    // existed.
    const rawOptions = Array.isArray(body.options)
      ? body.options
          .filter((o): o is string => typeof o === 'string')
          .map((o) => o.trim())
          .filter((o) => o.length > 0 && o.length <= 120)
      : []
    // Deduped: two identical buttons are indistinguishable to the user and
    // collide as React keys. The text IS the answer, so duplicates carry
    // nothing that the first one did not.
    const options = Array.from(new Set(rawOptions)).slice(0, MAX_QUESTION_OPTIONS)

    // The service client bypasses RLS, so ownership is the only thing standing
    // between this and writing into another account's item. Id-only lookup for
    // the same reason the sibling events route does it this way: the shared
    // `verifyItemOwnership` filters on `.eq('type', …)`, and a caller here has
    // an id with no reason to know whether it names a task or a custom type.
    const { data: owner } = await serviceClient
      .from('items')
      .select('user_id, type, assignee')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (!owner || owner.user_id !== userId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // The guard every other agent write gets for free.
    //
    // `verifyItemOwnership` filters on `.eq('type', …)`, so `/api/agent/tasks/:id`
    // 404s on a habit; this route looks items up by id alone and so has to ask
    // the question itself. Without it a worker could block a habit — which no
    // surface can render a reply box for, because `AgentSection` is gated on
    // `agentAssignable` — leaving a question nobody can answer, an item the
    // work queue filters out, and an agent waiting forever. Registry-derived,
    // so a future delegable type opts in by config, exactly like every other
    // capability question in this codebase.
    const config = getItemTypeConfig(owner.type as string)
    if (!config.agentAssignable) {
      return NextResponse.json(
        { error: `${owner.type} items cannot be delegated, so there is nobody to ask on their behalf` },
        { status: 400 }
      )
    }
    if (!owner.assignee) {
      // Same failure in a different shape: `AgentSection` shows the assign
      // button instead of the reply box when nothing is assigned, so the
      // question would render nowhere.
      return NextResponse.json(
        { error: 'That item is not assigned to you' },
        { status: 409 }
      )
    }

    // Question first, and AWAITED — see the note at the top of this file.
    const recorded = await recordAgentQuestion(
      id,
      owner.type as string,
      question,
      options,
      userId,
      serviceClient
    )
    if (!recorded) {
      return NextResponse.json(
        { error: 'Could not record the question. Nothing was changed.' },
        { status: 500 }
      )
    }

    // Through updateItem rather than a raw update: it is what emits the
    // `tasks.updated` webhook (a permanent contract — the OpenClaw plugin
    // subscribes to it) and the `update` item_event the Activity feed reads as
    // "Agent: blocked". A direct write would make this the one status change in
    // the app that happens silently.
    try {
      await updateItem(
        id,
        owner.type as string,
        { aiStatus: 'blocked', aiResult: question },
        userId,
        serviceClient
      )
    } catch {
      return NextResponse.json({ error: 'Could not update the item' }, { status: 500 })
    }

    return NextResponse.json({ itemId: id, question, options })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
