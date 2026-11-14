import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-service'
import { resolveAgentCaller } from '@/lib/agent-caller'
import { readInbox } from '@/lib/ai-server/agent-messages'

/**
 * GET /api/agent/messages: what the user wrote to the CALLING agent from Ask
 * and it has not answered yet (MCP's dsul_my_messages; migration 089,
 * memory/plans/agent-chat.md).
 *
 *   { messages: [{ id, conversationId, text, sentAt, earlier: [{ you, agent, at }] }] }
 *
 * Oldest first, at most 20. `earlier` is what the user and this same agent said
 * before in the same conversation, so a reply can follow on: never what the
 * user said to their own model or to another agent, which no agent route reads.
 *
 * Only an agent that may change the planner (scope `planner`) has an inbox: a
 * read-only app is never offered as someone to write to.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let userId: string
  let who: string
  try {
    const caller = await resolveAgentCaller(authHeader.slice(7))
    if (!caller || caller.scope !== 'planner') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    userId = caller.userId
    who = await caller.who()
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }

  const read = await readInbox(createServiceClient(), userId, who)
  if (!read.ok) {
    // Before 089 there is simply nothing waiting: an agent that polls its
    // inbox on every run must not see an error for a feature not deployed yet.
    if (read.error === 'unavailable') return NextResponse.json({ messages: [] })
    return NextResponse.json({ error: 'Could not read messages' }, { status: 500 })
  }
  return NextResponse.json({ messages: read.messages })
}
