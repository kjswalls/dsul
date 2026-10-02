import { isSameOrigin, jsonError, jsonOk, readJson, requireSession } from '@/app/api/ai/_shared/guard'
import { convFailure, convThrew } from '@/app/api/ai/_shared/conversations'
import { parseSearch, searchConversations } from '@/lib/ai-server/conversations'
import { takeToken } from '@/lib/ai-server/rate-limit'
import type { SearchResponse } from '@/lib/conversation-types'

/**
 * POST /api/ai/conversations/search `{ q }` (2..100 code points after trim):
 * `{ results }`, at most 50, newest first, one per conversation.
 *
 * A POST, not a GET, so what the user searched for stays out of URLs and
 * request logs. Same-origin only, like every other state-changing AI route.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 1_024

export async function POST(req: Request): Promise<Response> {
  const session = await requireSession()
  if (!session) return jsonError(401, 'unauthorized')
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden')
  const { user, db } = session

  const read = await readJson<unknown>(req, MAX_BYTES)
  if (!read.ok) return jsonError(read.status, read.error)
  const q = parseSearch(read.body)
  if (q === null) return jsonError(400, 'invalid')
  if (!takeToken(user.id, 'conv_search')) return jsonError(429, 'busy')

  try {
    const hits = await searchConversations(db, user.id, q)
    if (!hits.ok) return convFailure(hits)
    const body: SearchResponse = { results: hits.value }
    return jsonOk(body)
  } catch (err) {
    return convThrew('search', err)
  }
}
