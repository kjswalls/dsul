/**
 * agent-replies-server.ts — what the user wrote to an agent while its run was
 * going (Kirby, 2026-11-14).
 *
 * The item's box talks to the agent holding the item in every state of the
 * work (lib/agent-question.ts `messageAgent`). A message to a run that is
 * `working` does not re-queue the item, since that would move the agent clock
 * under the run and get its next report refused as stale. So the run hears it
 * here instead: the progress route reads the `agent_reply` entries written
 * since the run's last report and hands them back in its answer.
 *
 * Server-only: service-role reads, from the agent routes.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** The most messages handed back at once; the rest are on dsul_item_activity. */
const MAX_REPLIES = 5

export interface UserReply {
  text: string
  at: string
}

/**
 * The user's messages on `itemId` written after `since` (the item's
 * `ai_status_at` before this report), oldest first. Empty on any failure: the
 * report itself has already been written, and the messages stay on the trail.
 */
export async function repliesSince(
  db: SupabaseClient,
  userId: string,
  itemId: string,
  since: string | null
): Promise<UserReply[]> {
  if (!since) return []
  try {
    const { data, error } = await db
      .from('item_events')
      .select('payload, created_at')
      .eq('item_id', itemId)
      .eq('user_id', userId)
      .eq('action', 'agent_reply')
      .gt('created_at', since)
      .order('created_at', { ascending: true })
      .limit(MAX_REPLIES)
    if (error || !Array.isArray(data)) return []
    const out: UserReply[] = []
    for (const row of data as { payload?: { text?: unknown } | null; created_at?: unknown }[]) {
      const text = typeof row.payload?.text === 'string' ? row.payload.text.trim() : ''
      if (text) out.push({ text, at: String(row.created_at ?? '') })
    }
    return out
  } catch {
    return []
  }
}
