import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-service'
import { resolveAgentCaller } from '@/lib/agent-caller'
import { inQueueOf } from '@/lib/agent-assignees'
import { EXT_DO_STUFF } from '@/lib/extension-registry'
import { PREP_KIND_RULES, PREP_TONE_RULES } from '@/lib/prep-rules'
import { isStuck, moveCounts, STUCK_WINDOW_DAYS } from '@/lib/stuck'
import { writingStyleOf } from '@/lib/writing-style'

/**
 * GET /api/agent/prep-brief — what the person's own model is told before it
 * gets items ready, for an agent handed the same job (MCP's dsul_prep_brief).
 *
 *   { rules, style, stuck: [{ id, title }] }
 *
 * `rules` is lib/prep-rules.ts, the model's own list, with the two lines that
 * differ for an agent: the card goes back through dsul_save_prep, and a
 * question goes through dsul_ask_user. `style` is how the person writes
 * (lib/writing-style.ts), learned from their edits, or '' when there is none.
 * `stuck` is the items in the CALLER's own queue (`inQueueOf`, as
 * dsul_my_work) that the person keeps moving to another day (lib/stuck.ts),
 * so the agent writes a smaller first step for those. What was handed to a
 * different agent is never named here.
 *
 * Read-only, and only ever about the key holder's own account. Custom
 * instructions are not here: they live in the person's browser, never on the
 * server, so an agent follows its own.
 */

const AGENT_RULES = [
  'Hand back each card with dsul_save_prep, then report done with dsul_report_progress. One card per item.',
  'When one missing fact is all that stands between the item and a real draft, ask it with dsul_ask_user instead of guessing: one short question, with two to four likely answers when there are obvious ones.',
]

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let userId: string
  let who: string
  try {
    const caller = await resolveAgentCaller(authHeader.slice(7))
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    userId = caller.userId
    who = await caller.who()
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }

  try {
    const db = createServiceClient()

    const since = new Date(Date.now() - STUCK_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const [ext, handed, moves] = await Promise.all([
      db.from('user_extensions').select('config').eq('user_id', userId).eq('slug', EXT_DO_STUFF).maybeSingle(),
      db
        .from('items')
        .select('id, title, status, assignee')
        .eq('user_id', userId)
        .not('assignee', 'is', null)
        .is('deleted_at', null)
        .limit(500),
      db
        .from('item_events')
        .select('item_id, created_at')
        .eq('user_id', userId)
        .eq('action', 'update')
        .gte('created_at', since)
        .not('payload->>startDate', 'is', null)
        .limit(2000),
    ])

    // Each part is best-effort: a missing table or a failed read costs that
    // part of the brief, never the rest of it.
    const style = ext.error ? '' : writingStyleOf((ext.data?.config ?? undefined) as Record<string, unknown> | undefined)
    const counts = moveCounts(
      (moves.error ? [] : (moves.data ?? [])).map((r) => ({
        itemId: String(r.item_id),
        day: String(r.created_at).slice(0, 10),
      }))
    )
    const stuck = (handed.error ? [] : (handed.data ?? []))
      .filter((i) => inQueueOf(i.assignee, who))
      .filter((i) => i.status !== 'completed' && i.status !== 'cancelled' && isStuck(counts.get(String(i.id))))
      .map((i) => ({ id: String(i.id), title: String(i.title ?? '') }))

    return NextResponse.json({
      rules: [...PREP_KIND_RULES, ...AGENT_RULES, ...PREP_TONE_RULES],
      style,
      stuck,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
