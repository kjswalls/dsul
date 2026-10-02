import { jsonError, jsonOk, requireSession } from '@/app/api/ai/_shared/guard'
import { convFailure, convThrew } from '@/app/api/ai/_shared/conversations'
import {
  conversationForItem,
  decodeCursor,
  listConversations,
  type Cursor,
} from '@/lib/ai-server/conversations'
import { takeToken } from '@/lib/ai-server/rate-limit'
import { CHAT_LIMITS, UUID_RE, type ItemConversationResponse } from '@/lib/conversation-types'

/**
 * GET /api/ai/conversations: History.
 *
 *   ?limit=1..50 (30) &cursor=<opaque>
 *       { conversations, starred?, nextCursor }: non-starred conversations,
 *       newest first. The first page (no cursor) also carries every starred one.
 *   ?itemId=<uuid>
 *       { conversations: [summary] | [] }: that item's one conversation.
 *
 * Reads only, through the session's own client: RLS is the tenant guard, and
 * no service role is involved. Every response is `no-store`; every failure is
 * an `ApiErrorCode` (503 `unavailable` while migration 057 is missing).
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Query =
  | { kind: 'item'; itemId: string }
  | { kind: 'page'; limit: number; cursor: Cursor | null }

/** The query string, or null for a 400. `itemId` wins over paging. */
function parseQuery(params: URLSearchParams): Query | null {
  const itemId = params.get('itemId')
  if (itemId !== null) return UUID_RE.test(itemId) ? { kind: 'item', itemId } : null

  let limit: number = CHAT_LIMITS.pageSize
  const rawLimit = params.get('limit')
  if (rawLimit !== null) {
    if (!/^\d{1,2}$/.test(rawLimit)) return null
    limit = Number(rawLimit)
    if (limit < 1 || limit > CHAT_LIMITS.maxPageSize) return null
  }

  const rawCursor = params.get('cursor')
  if (rawCursor === null) return { kind: 'page', limit, cursor: null }
  const cursor = decodeCursor(rawCursor)
  return cursor ? { kind: 'page', limit, cursor } : null
}

export async function GET(req: Request): Promise<Response> {
  const session = await requireSession()
  if (!session) return jsonError(401, 'unauthorized')
  const { user, db } = session

  const query = parseQuery(new URL(req.url).searchParams)
  if (!query) return jsonError(400, 'invalid')
  if (!takeToken(user.id, 'conv_read')) return jsonError(429, 'busy')

  try {
    if (query.kind === 'item') {
      const found = await conversationForItem(db, user.id, query.itemId)
      if (!found.ok) return convFailure(found)
      const body: ItemConversationResponse = { conversations: found.value ? [found.value] : [] }
      return jsonOk(body)
    }
    const page = await listConversations(db, user.id, { limit: query.limit, cursor: query.cursor })
    return page.ok ? jsonOk(page.value) : convFailure(page)
  } catch (err) {
    return convThrew(query.kind === 'item' ? 'item' : 'list', err)
  }
}
