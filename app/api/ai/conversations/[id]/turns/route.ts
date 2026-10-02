import { isSameOrigin, jsonError, jsonOk, readJson, requireSession } from '@/app/api/ai/_shared/guard'
import { convFailure, convThrew } from '@/app/api/ai/_shared/conversations'
import { appendTurn, parseTurn } from '@/lib/ai-server/conversations'
import { takeToken } from '@/lib/ai-server/rate-limit'
import { UUID_RE } from '@/lib/conversation-types'

/**
 * POST /api/ai/conversations/<id>/turns: one finished turn, saved once.
 *
 *   { ownerId, create?: { itemId, title }, messages: [user] | [user, reply] | [reply] }
 *   → { conversation, inserted }
 *
 * The client is the only writer (the OpenClaw plugin path never reaches this
 * server), once per turn, never per token; `/api/chat` stays stateless. Ids
 * are minted by the client, so a retry or a pagehide keepalive re-send lands
 * once (`inserted: 0`).
 *
 *   403  cross-site, or `ownerId` is not the session user: a save queued under
 *        one account must never land in another (an account switch in another
 *        tab changes the shared cookie before this tab's queue notices).
 *   400  shape only. A length is never a 400: content and the title are
 *        clipped to the caps (8,000 a user message, 40,000 a reply).
 *   404  no such conversation and no `create`: deleted elsewhere.
 *   409  `{ error: 'conflict', conversationId }`: the item already has its one
 *        conversation; the client rebinds to it and retries.
 *   503  migration 057 is missing: the client latches "saving off".
 *
 * The body is never logged, and no failure carries it back.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Two messages at their caps fit with room to spare, even all CJK (3 bytes a character). */
const MAX_BYTES = 200_000

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await requireSession()
  if (!session) return jsonError(401, 'unauthorized')
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden')
  const { user, db } = session

  const read = await readJson<unknown>(req, MAX_BYTES)
  if (!read.ok) return jsonError(read.status, read.error)
  const { id } = await params
  if (!UUID_RE.test(id)) return jsonError(400, 'invalid')

  // The owner first, whatever the rest of the body looks like: a stale
  // account's queued save is always a 403, which the client drops.
  const body = read.body
  const ownerId = typeof body === 'object' && body !== null ? (body as { ownerId?: unknown }).ownerId : undefined
  if (typeof ownerId === 'string' && ownerId !== user.id) return jsonError(403, 'forbidden')
  const turn = parseTurn(body)
  if (!turn) return jsonError(400, 'invalid')
  if (!takeToken(user.id, 'conv_write')) return jsonError(429, 'busy')

  try {
    const saved = await appendTurn(db, user.id, id, { create: turn.create, messages: turn.messages })
    return saved.ok ? jsonOk(saved.value) : convFailure(saved)
  } catch (err) {
    return convThrew('append', err)
  }
}
