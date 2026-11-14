import { isSameOrigin, jsonError, jsonOk, readJson, requireSession } from '@/app/api/ai/_shared/guard'
import { takeToken } from '@/lib/ai-server/rate-limit'
import { isMissingSchema } from '@/lib/ai-server/schema-codes'
import { UUID_RE } from '@/lib/conversation-types'

/**
 * POST /api/ai/agent-messages/delivered { ids }: the browser has saved these
 * agents' answers into their conversations (as replies whose id is the inbox
 * row's id, so a second device's save lands once), and no browser needs to
 * look for them again. The one column the browser may write (migration 089).
 *
 *   200 { marked: n }
 *
 * Only answered rows are stamped: 089's CHECK refuses a stamp on a waiting one,
 * so the filter is here too, and a waiting id is quietly left as it is.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_IDS = 50

export async function POST(req: Request): Promise<Response> {
  const session = await requireSession()
  if (!session) return jsonError(401, 'unauthorized')
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden')
  const read = await readJson<{ ids?: unknown }>(req, 8192)
  if (!read.ok) return jsonError(read.status, read.error)
  const raw = read.body?.ids
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IDS) return jsonError(400, 'invalid')
  if (!raw.every((id) => typeof id === 'string' && UUID_RE.test(id))) return jsonError(400, 'invalid')
  const ids = [...new Set((raw as string[]).map((id) => id.toLowerCase()))]
  const { user, db } = session
  if (!takeToken(user.id, 'conv_write')) return jsonError(429, 'busy')

  try {
    const { data, error } = await db
      .from('agent_messages')
      .update({ delivered_at: new Date().toISOString() })
      .in('id', ids)
      .eq('user_id', user.id)
      .eq('status', 'answered')
      .is('delivered_at', null)
      .select('id')
    if (error) return isMissingSchema(error.code) ? jsonError(503, 'unavailable') : jsonError(500, 'server')
    return jsonOk({ marked: Array.isArray(data) ? data.length : 0 })
  } catch {
    return jsonError(500, 'server')
  }
}
