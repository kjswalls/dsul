import { createServiceClient } from '@/lib/supabase-service'
import { inQueueOf } from '@/lib/agent-assignees'

/**
 * The work feed's timing and its one read (app/api/agent/events/route.ts).
 * Here rather than in the route, which may export only what Next.js reads.
 */

/** How long one connection lives: inside `maxDuration`, so the close is ours. */
export const HOLD_MS = 270_000
/** How often the queue is read. One small indexed query per connected agent. */
export const POLL_MS = 5_000
/** A comment line now and then, so no proxy between here and the agent idles the socket out. */
export const PING_MS = 25_000
/** On connect, work queued this recently is announced: it may have landed while the agent reconnected. */
export const RECENT_MS = 10 * 60_000
/** Reads that fail in a row before the feed closes and lets the agent reconnect. */
export const MAX_FAILURES = 3
/** The most queued rows one read looks at. */
const READ_LIMIT = 200

/** One-off statuses that end the item: nothing left for an agent to do. */
const FINISHED = new Set(['completed', 'cancelled'])

type Row = { id: string; assignee: string | null; ai_status: string | null; ai_status_at: string | null; status: string | null }

/** The queued items in this caller's queue, as `id@stamp` so a re-queue reads as new. */
export async function readQueued(userId: string, who: string): Promise<Map<string, number> | null> {
  const { data, error } = await createServiceClient()
    .from('items')
    .select('id, assignee, ai_status, ai_status_at, status')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .not('assignee', 'is', null)
    .or('ai_status.is.null,ai_status.eq.queued')
    .limit(READ_LIMIT)
  if (error) return null
  const out = new Map<string, number>()
  for (const row of (data ?? []) as Row[]) {
    if (!inQueueOf(row.assignee, who)) continue
    if (row.status && FINISHED.has(row.status)) continue
    const at = row.ai_status_at ? Date.parse(row.ai_status_at) : 0
    out.set(`${row.id}@${row.ai_status_at ?? ''}`, Number.isFinite(at) ? at : 0)
  }
  return out
}
