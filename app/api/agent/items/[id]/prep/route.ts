import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, resolveUserIdFromApiKey } from '@/lib/supabase-service'
import { getItemTypeConfig } from '@/lib/item-registry'
import { tagClientActor } from '@/lib/event-actor'
import { packBody, packFromRow, PackSchema } from '@/lib/prep-packs'
import { packLimitHit, savePacks, type PackRow } from '@/lib/prep-packs-save'

/**
 * POST /api/agent/items/:id/prep — an agent hands back what it got ready as a
 * real prep card (MCP's `dsul_save_prep`).
 *
 * Background prep hands an item to OpenClaw or a connected app with aiMode
 * 'prepare' (lib/background-prep.ts). Before this route the agent could only
 * answer in `dsul_report_progress`'s text, so its work read as a report, with
 * none of the card's buttons: no Open in mail, no Share, no "Sent it?". Now it
 * sends the same shapes the person's own model writes (lib/prep-packs.ts,
 * checked by the same schema), and the item gets the same card. Nothing is
 * sent from here; the card is the draft, and the person's tap is the send.
 *
 *   body: `{ pack: { kind, ...fields } }`
 *
 * One card per item, as for the model: a second save replaces the first. The
 * service client bypasses RLS, so the ownership check is the only thing between
 * a key and another account's item, and `user_id` is written from the key,
 * never from the body. The item must be handed to an agent: a card on an item
 * nobody handed over would be an agent writing where it was not asked.
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
    const serviceClient = tagClientActor(createServiceClient(), 'agent')
    const userId = await resolveUserIdFromApiKey(authHeader.slice(7), serviceClient, 'write')
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params

    let body: { pack?: unknown }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = PackSchema.safeParse(body.pack)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
      return NextResponse.json(
        { error: `That card does not fit its shape${where}: ${issue?.message ?? 'invalid'}` },
        { status: 400 }
      )
    }

    // A question card's answer re-asks the person's own model, not the agent:
    // an agent asks through dsul_ask_user, which comes back to it.
    if (parsed.data.kind === 'question') {
      return NextResponse.json(
        { error: 'Ask the user with dsul_ask_user instead: its answer comes back to you.' },
        { status: 400 }
      )
    }

    // Id-only lookup, as the sibling ask and progress routes do it.
    const { data: owner } = await serviceClient
      .from('items')
      .select('user_id, type, assignee, title')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (!owner || owner.user_id !== userId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    if (!getItemTypeConfig(owner.type as string).agentAssignable) {
      return NextResponse.json({ error: `${owner.type} items cannot be handed to an agent` }, { status: 400 })
    }
    if (!owner.assignee) {
      return NextResponse.json({ error: 'That item is not assigned to you' }, { status: 409 })
    }

    const rows = new Map<string, PackRow>([
      [
        id,
        {
          item_id: id,
          user_id: userId,
          kind: parsed.data.kind,
          body: packBody(parsed.data),
          made_for: String(owner.title ?? '').slice(0, 500),
          model: String(owner.assignee).slice(0, 200),
        },
      ],
    ])
    const { saved, error } = await savePacks(serviceClient, rows)
    if (error) {
      if (error.code === '42P01' || error.code === 'PGRST205') {
        return NextResponse.json({ error: 'Prep cards are not set up on this account yet' }, { status: 503 })
      }
      if (packLimitHit(error)) {
        return NextResponse.json(
          { error: 'The user has 200 things ready already. Report your work with dsul_report_progress instead.' },
          { status: 409 }
        )
      }
      return NextResponse.json({ error: 'Could not save the card' }, { status: 500 })
    }
    if (rows.size === 0) {
      return NextResponse.json(
        { error: `This account cannot show a ${parsed.data.kind} card yet. Use another kind, or report with dsul_report_progress.` },
        { status: 409 }
      )
    }
    const stored = saved.map((r) => packFromRow(r as Parameters<typeof packFromRow>[0])).find((p) => p !== null)
    return NextResponse.json({ itemId: id, kind: parsed.data.kind, saved: !!stored })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
