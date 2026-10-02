import { isSameOrigin, jsonError, jsonOk, readJson, requireSession } from '@/app/api/ai/_shared/guard'
import { convFailure, convThrew } from '@/app/api/ai/_shared/conversations'
import {
  deleteConversation,
  getThread,
  parsePatch,
  patchConversation,
} from '@/lib/ai-server/conversations'
import { takeToken } from '@/lib/ai-server/rate-limit'
import { UUID_RE } from '@/lib/conversation-types'

/**
 * /api/ai/conversations/<id>: one saved conversation.
 *
 *   GET     ?before=<pos>  { conversation, messages (ascending, at most 100), hasEarlier }
 *   PATCH   { title?, starred? } | { addChanges } (a tally travels alone)  { conversation }
 *   DELETE  { ok: true }: gone at once, messages and all (no trash)
 *
 * 404 `not_found` for a conversation that is not this user's or no longer
 * exists; the two are the same answer on purpose. PATCH and DELETE are
 * same-origin only. Every response is `no-store`.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PATCH_MAX_BYTES = 4_096

type Params = { params: Promise<{ id: string }> }

export async function GET(req: Request, { params }: Params): Promise<Response> {
  const session = await requireSession()
  if (!session) return jsonError(401, 'unauthorized')
  const { user, db } = session

  const { id } = await params
  if (!UUID_RE.test(id)) return jsonError(400, 'invalid')
  const rawBefore = new URL(req.url).searchParams.get('before')
  let before: number | null = null
  if (rawBefore !== null) {
    if (!/^[1-9]\d{0,8}$/.test(rawBefore)) return jsonError(400, 'invalid')
    before = Number(rawBefore)
  }
  if (!takeToken(user.id, 'conv_read')) return jsonError(429, 'busy')

  try {
    const thread = await getThread(db, user.id, id, { before })
    return thread.ok ? jsonOk(thread.value) : convFailure(thread)
  } catch (err) {
    return convThrew('thread', err)
  }
}

export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  const session = await requireSession()
  if (!session) return jsonError(401, 'unauthorized')
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden')
  const { user, db } = session

  const read = await readJson<unknown>(req, PATCH_MAX_BYTES)
  if (!read.ok) return jsonError(read.status, read.error)
  const { id } = await params
  if (!UUID_RE.test(id)) return jsonError(400, 'invalid')
  const patch = parsePatch(read.body)
  if (!patch) return jsonError(400, 'invalid')
  if (!takeToken(user.id, 'conv_write')) return jsonError(429, 'busy')

  try {
    const done = await patchConversation(db, user.id, id, patch)
    return done.ok ? jsonOk({ conversation: done.value }) : convFailure(done)
  } catch (err) {
    return convThrew('patch', err)
  }
}

export async function DELETE(req: Request, { params }: Params): Promise<Response> {
  const session = await requireSession()
  if (!session) return jsonError(401, 'unauthorized')
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden')
  const { user, db } = session

  const { id } = await params
  if (!UUID_RE.test(id)) return jsonError(400, 'invalid')
  if (!takeToken(user.id, 'conv_write')) return jsonError(429, 'busy')

  try {
    const done = await deleteConversation(db, user.id, id)
    return done.ok ? jsonOk({ ok: true }) : convFailure(done)
  } catch (err) {
    return convThrew('delete', err)
  }
}
