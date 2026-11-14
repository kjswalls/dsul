import { after } from 'next/server'
import { isSameOrigin, jsonError, jsonOk, readJson, requireSession } from '@/app/api/ai/_shared/guard'
import { takeToken } from '@/lib/ai-server/rate-limit'
import { isMissingSchema } from '@/lib/ai-server/schema-codes'
import { agentMessageFromRow, messageFireText, parseAgentSend, type AgentMessageRow } from '@/lib/agent-messages'
import { claimWake, fireRoutine, wakeKey } from '@/lib/agent-wake'
import { getWake } from '@/lib/agent-wake-store'
import { UUID_RE } from '@/lib/conversation-types'
import { createServiceClient } from '@/lib/supabase-service'

/**
 * The browser's side of the agent inbox (migration 089, memory/plans/agent-chat.md).
 *
 * POST { id, conversationId, messageId, agent }: send a message the user has
 * just saved in a conversation (POST /api/ai/conversations/<id>/turns) to an
 * agent. The text is COPIED from that saved message through the session
 * client, so an agent reads exactly what the conversation holds and nothing
 * the body could add. Then the agent's routine is woken, when it has one.
 *
 *   200 { message: AgentMessageRow, woken: boolean }   (a retried send answers the row it made)
 *   404 no such user message in that conversation of yours
 *   503 migration 089 (or 057) is not there yet; 500 any other database failure
 *
 * GET ?conversationId=<id>: that conversation's rows, oldest first, so the
 * browser can show what is waiting and save each answer into the conversation.
 * GET ?pending=1: answers not saved into any conversation yet, account-wide,
 * newest first (at most 50), for a browser that was closed when they came.
 *
 * Every read and write goes through the SESSION client: RLS is the tenant guard.
 * The service role is used only to read the routine's wake (user_secrets).
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const COLUMNS = 'id, conversation_id, message_id, agent, status, reply, answered_at, delivered_at, created_at'

/** 503 when 089 (or 057) is not there yet, otherwise 500. */
function failed(code: unknown): Response {
  return isMissingSchema(code) ? jsonError(503, 'unavailable') : jsonError(500, 'server')
}

export async function POST(req: Request): Promise<Response> {
  const session = await requireSession()
  if (!session) return jsonError(401, 'unauthorized')
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden')
  const read = await readJson<unknown>(req, 4096)
  if (!read.ok) return jsonError(read.status, read.error)
  const send = parseAgentSend(read.body)
  if (!send) return jsonError(400, 'invalid')
  const { user, db } = session
  if (!takeToken(user.id, 'conv_write')) return jsonError(429, 'busy')

  try {
    // The message as saved: the user's own, in this conversation, from the user.
    const { data: saved, error: savedError } = await db
      .from('chat_messages')
      .select('content')
      .eq('id', send.messageId)
      .eq('conversation_id', send.conversationId)
      .eq('user_id', user.id)
      .eq('role', 'user')
      .maybeSingle()
    if (savedError) return failed(savedError.code)
    const content = typeof saved?.content === 'string' ? saved.content : ''
    if (!saved || content.trim() === '') return jsonError(404, 'not_found')

    const { error: insertError } = await db.from('agent_messages').insert({
      id: send.id,
      user_id: user.id,
      conversation_id: send.conversationId,
      message_id: send.messageId,
      agent: send.agent,
      content,
    })
    // 23505: this message was sent already (a retry). Answer the row it made.
    if (insertError && insertError.code !== '23505') {
      return failed(insertError.code)
    }
    const { data: row, error: rowError } = await db
      .from('agent_messages')
      .select(COLUMNS)
      .eq('message_id', send.messageId)
      .eq('user_id', user.id)
      .maybeSingle()
    const message = !rowError && row ? agentMessageFromRow(row as Record<string, unknown>) : null
    if (!message) return jsonError(500, 'server')

    // The nudge, after the response: a refused or missing wake changes nothing,
    // since the agent still finds the message the next time it reads its inbox.
    let woken = false
    if (!insertError && message.status === 'waiting') {
      const wake = await getWake(createServiceClient(), user.id, send.agent)
      if (wake && claimWake(`${user.id}:${wakeKey(send.agent)}`, Date.now())) {
        woken = true
        after(() => fireRoutine(wake, messageFireText(1)))
      }
    }
    return jsonOk({ message, woken })
  } catch {
    return jsonError(500, 'server')
  }
}

export async function GET(req: Request): Promise<Response> {
  const session = await requireSession()
  if (!session) return jsonError(401, 'unauthorized')
  const { user, db } = session
  if (!takeToken(user.id, 'conv_read')) return jsonError(429, 'busy')
  const url = new URL(req.url)
  const conversationId = url.searchParams.get('conversationId')
  const pending = url.searchParams.get('pending') === '1'
  if (!pending && (!conversationId || !UUID_RE.test(conversationId))) return jsonError(400, 'invalid')

  try {
    let q = db.from('agent_messages').select(COLUMNS).eq('user_id', user.id)
    q = pending
      ? q.eq('status', 'answered').is('delivered_at', null).order('answered_at', { ascending: false }).limit(50)
      : q.eq('conversation_id', (conversationId as string).toLowerCase()).order('created_at', { ascending: true }).limit(200)
    const { data, error } = await q
    if (error) return failed(error.code)
    const messages = ((data ?? []) as Record<string, unknown>[])
      .map(agentMessageFromRow)
      .filter((m): m is AgentMessageRow => m !== null)
    return jsonOk({ messages })
  } catch {
    return jsonError(500, 'server')
  }
}
