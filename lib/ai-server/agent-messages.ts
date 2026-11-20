/**
 * ai-server/agent-messages.ts: the agent's side of `agent_messages` (migration 089,
 * memory/plans/agent-chat.md).
 *
 * Server-only: service-role reads and writes, from /api/agent/messages. Every
 * query filters on the caller's account AND its queue name (`inQueueOf`, as
 * dsul_my_work): an agent reads only what was sent to it, and answers only
 * that. Nothing here reads chat_conversations or chat_messages, ever.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { inQueueOf } from '../agent-assignees'
import { cleanText } from '../conversation-types'
import { isMissingSchema } from './schema-codes'
import {
  AGENT_HISTORY_CHARS,
  AGENT_HISTORY_TURNS,
  AGENT_INBOX_PAGE,
  AGENT_REPLY_MAX,
} from '../agent-messages'

/** An earlier exchange in the same conversation, with the same agent. */
export interface InboxTurn {
  you: string
  agent: string | null
  at: string
}

/** One waiting message, as an agent reads it. */
export interface InboxMessage {
  id: string
  conversationId: string
  text: string
  sentAt: string
  /** What the user and this agent said earlier in the same conversation, oldest first. */
  earlier: InboxTurn[]
}

export type InboxRead = { ok: true; messages: InboxMessage[] } | { ok: false; error: 'unavailable' | 'server' }

type Row = Record<string, unknown>

/**
 * The caller's name as an ILIKE pattern that matches it exactly, without case:
 * `%`, `_` and `\\` escaped. Names are stored collapsed (lib/agent-assignees.ts
 * assigneeForName), so this finds every row `inQueueOf` would, and the database
 * never hands back another agent's rows to be filtered out here.
 */
function exactly(name: string): string {
  return name.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * The caller's waiting messages, oldest first, each with its earlier exchanges.
 * The name filter runs here, folded, as dsul_my_work's does: two apps named
 * "Claude" and "claude" are one agent.
 */
export async function readInbox(db: SupabaseClient, userId: string, who: string): Promise<InboxRead> {
  try {
    const { data, error } = await db
      .from('agent_messages')
      .select('id, conversation_id, agent, content, created_at')
      .eq('user_id', userId)
      .eq('status', 'waiting')
      .ilike('agent', exactly(who))
      .order('created_at', { ascending: true })
      .limit(AGENT_INBOX_PAGE)
    if (error) return { ok: false, error: isMissingSchema(error.code) ? 'unavailable' : 'server' }
    const mine = ((data ?? []) as Row[]).filter((r) => inQueueOf(r.agent, who))
    if (mine.length === 0) return { ok: true, messages: [] }

    // The earlier exchanges: rows in the same conversations, answered, for this agent.
    const convs = [...new Set(mine.map((r) => String(r.conversation_id)))]
    const { data: past, error: pastError } = await db
      .from('agent_messages')
      .select('conversation_id, agent, content, reply, created_at')
      .eq('user_id', userId)
      .eq('status', 'answered')
      .ilike('agent', exactly(who))
      .in('conversation_id', convs)
      .order('created_at', { ascending: false })
      .limit(200)
    const history = new Map<string, InboxTurn[]>()
    if (!pastError) {
      for (const r of (past ?? []) as Row[]) {
        if (!inQueueOf(r.agent, who)) continue
        const key = String(r.conversation_id)
        const list = history.get(key) ?? []
        if (list.length >= AGENT_HISTORY_TURNS) continue
        list.unshift({
          you: cleanText(String(r.content ?? ''), AGENT_HISTORY_CHARS),
          agent: typeof r.reply === 'string' ? cleanText(r.reply, AGENT_HISTORY_CHARS) : null,
          at: String(r.created_at ?? ''),
        })
        history.set(key, list)
      }
    }

    return {
      ok: true,
      messages: mine.map((r) => ({
        id: String(r.id),
        conversationId: String(r.conversation_id),
        text: String(r.content ?? ''),
        sentAt: String(r.created_at ?? ''),
        earlier: (history.get(String(r.conversation_id)) ?? []).filter((t) => t.at < String(r.created_at ?? '')),
      })),
    }
  } catch {
    return { ok: false, error: 'server' }
  }
}

export type ReplyResult =
  | { ok: true; id: string; answeredAt: string }
  | { ok: false; error: 'not_found' | 'answered' | 'unavailable' | 'server' }

/**
 * Answer one message: the compare-and-set waiting -> answered, on a row of this
 * account addressed to this caller. A second reply to the same message is
 * refused ('answered'), so two runs never both answer it.
 */
export async function replyToMessage(
  db: SupabaseClient,
  userId: string,
  who: string,
  id: string,
  text: string
): Promise<ReplyResult> {
  try {
    const { data: row, error } = await db
      .from('agent_messages')
      .select('id, agent, status')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle()
    if (error) return { ok: false, error: isMissingSchema(error.code) ? 'unavailable' : 'server' }
    if (!row || !inQueueOf((row as Row).agent, who)) return { ok: false, error: 'not_found' }
    if ((row as Row).status !== 'waiting') return { ok: false, error: 'answered' }

    const answeredAt = new Date().toISOString()
    const { data: updated, error: updateError } = await db
      .from('agent_messages')
      .update({ status: 'answered', reply: cleanText(text, AGENT_REPLY_MAX), answered_at: answeredAt })
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', 'waiting')
      .select('id')
    if (updateError) return { ok: false, error: 'server' }
    if (!Array.isArray(updated) || updated.length === 0) return { ok: false, error: 'answered' }
    return { ok: true, id, answeredAt }
  } catch {
    return { ok: false, error: 'server' }
  }
}
