import { NextRequest, NextResponse } from 'next/server'
import { postAgentItemAction } from '@/lib/app-api'
import { afterItemWrite } from '@/lib/recipes/server'
import { createServiceClient, resolveUserIdFromApiKey } from '@/lib/supabase-service'

/**
 * POST /api/agent/items/:id/act — one verb on one item, for ONE day:
 *   { action: 'complete', date, done, count? }        tick or untick the item on `date`
 *   { action: 'skip', date, skipped }                 skip or unskip the occurrence on `date`
 *   { action: 'move', date }                          carry the item to `date`
 *   { action: 'resetStreak' }                         a habit's streak back to 0, its history kept
 *   { action: 'collect', kind, containerId, member }  join or leave one routine or season
 *
 * The iPhone's intents (lib/app-api.ts), run by the same code, so a tick here
 * moves the streak, reports to a live stake and starts the user's recipes
 * exactly as the phone's does. The PATCH routes' completedDates, skippedDates
 * and itemIds are whole-set replacements: an agent that sends back a list it
 * read short un-ticks or removes everything it left out. These verbs touch one
 * date or one membership row and nothing else.
 *
 * Answers as the phone's door does: 200 { ok: true }; 400 { error: 'invalid',
 * details } for a malformed body; 404 { error: 'not_found' }; and a bare code
 * the row's state refused with (skipped, not_skippable, not_movable,
 * not_collectible, container_gone, ...).
 *
 * Auth: Bearer <agent key>. No webhook, as the phone's writes fire none.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const client = createServiceClient()
  const userId = await resolveUserIdFromApiKey(authHeader.slice(7), client)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  return postAgentItemAction(req, id, { userId, client }, { onCommitted: afterItemWrite })
}
