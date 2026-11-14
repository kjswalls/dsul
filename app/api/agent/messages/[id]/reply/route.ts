import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-service'
import { resolveAgentCaller } from '@/lib/agent-caller'
import { replyToMessage } from '@/lib/ai-server/agent-messages'
import { UUID_RE } from '@/lib/conversation-types'

/**
 * POST /api/agent/messages/:id/reply: the calling agent answers one message the
 * user sent it from Ask (MCP's dsul_reply; migration 089).
 *
 *   { text }  ->  200 { id, answeredAt }
 *
 * One answer per message: the write is a compare-and-set from waiting, so a
 * second run that read the same message is refused (409) rather than
 * answering twice. A message addressed to another agent, or to another
 * account, is 404, never 403, so its existence is not told.
 *
 * The browser saves the answer into the conversation the next time it looks
 * (the client stays the one writer of saved conversations).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const { id } = await params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let body: { text?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (text === '') {
    return NextResponse.json(
      { error: 'text is required: write your answer for the user, as you would reply in a chat.' },
      { status: 400 }
    )
  }

  const result = await replyToMessage(createServiceClient(), userId, who, id.toLowerCase(), text)
  if (result.ok) return NextResponse.json({ id: result.id, answeredAt: result.answeredAt })
  switch (result.error) {
    case 'not_found':
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    case 'answered':
      return NextResponse.json(
        { error: 'That message has already been answered. Read dsul_my_messages again for what is still waiting.' },
        { status: 409 }
      )
    case 'unavailable':
      return NextResponse.json({ error: 'unavailable' }, { status: 503 })
    default:
      return NextResponse.json({ error: 'Could not save the reply' }, { status: 500 })
  }
}
