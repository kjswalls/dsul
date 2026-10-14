import { isSameOrigin, jsonError, jsonOk, requireSessionUser } from '@/app/api/ai/_shared/guard'
import { AiDbError, readOpenClawStatus, unpairOpenClaw } from '@/lib/ai-server/connections'
import type { OpenClawConnectResponse, OpenClawView, UnpairResponse } from '@/lib/ai-types'
import { createAgentKey, listAgentKeys, revokeAgentKey } from '@/lib/agent-keys'
import { OPENCLAW_KEY_NAME, queueForName } from '@/lib/agent-assignees'
import { createServiceClient } from '@/lib/supabase-service'

/**
 * DELETE /api/ai/openclaw: Unpair, from Settings → AI.
 *
 * Pairing starts on OpenClaw's side (a device code, /connect); this is the
 * way to end it from dsul's. It deletes the agent key, the plugin's webhook
 * registrations and the chat URL it registered (`unpairOpenClaw`,
 * lib/ai-server/connections.ts), so the plugin can no longer read or change
 * the planner and dsul stops sending it changes. The gateway URL and token
 * are a separate connection and stay. Conversations stay too.
 *
 * Idempotent: an account with nothing paired answers the same 200. A failure
 * part way answers 503 `server`, and asking again finishes the job. Neither
 * the key nor a database message is ever in a response or a log line.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/ai/openclaw: Connect, from Settings → AI → OpenClaw.
 *
 * Mints the agent key a plugin-free OpenClaw uses for both halves of the
 * connection (app/docs/openclaw): dsul's tools over MCP, and the work feed it
 * holds open (/api/agent/events). The key is named OpenClaw, which is what
 * puts it on OpenClaw's own queue (`queueForName`, lib/agent-assignees.ts).
 *
 * Connecting again replaces it: every live key by that name is revoked first,
 * so a lost key is fixed by pressing Connect, and there is only ever one. The
 * response is the only place the key appears; Settings shows it once inside
 * the commands to paste and forgets it.
 *
 *   201 { key }            the new key
 *   409 conflict           the account already holds the most keys it may
 *   503 server             the keys table could not be read or written
 */
export async function POST(req: Request): Promise<Response> {
  const user = await requireSessionUser()
  if (!user) return jsonError(401, 'unauthorized')
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden')

  const db = createServiceClient()
  const keys = await listAgentKeys(db, user.id)
  if (!keys) return jsonError(503, 'server')
  for (const k of keys) {
    if (queueForName(k.name) === 'openclaw' && !(await revokeAgentKey(db, user.id, k.id))) return jsonError(503, 'server')
  }
  const made = await createAgentKey(db, user.id, OPENCLAW_KEY_NAME, 'planner')
  if (!made.ok) return made.error === 'limit' ? jsonError(409, 'conflict') : jsonError(503, 'server')
  return jsonOk({ key: made.key } satisfies OpenClawConnectResponse, 201)
}

export async function DELETE(req: Request): Promise<Response> {
  const user = await requireSessionUser()
  if (!user) return jsonError(401, 'unauthorized')
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden')

  try {
    await unpairOpenClaw(user.id)
  } catch (err) {
    if (err instanceof AiDbError) console.warn('[ai] db', err.op, 'failed', err.code)
    else console.warn('[ai] unpair failed')
    return jsonError(503, 'server')
  }

  let openclaw: OpenClawView | null = null
  try {
    openclaw = await readOpenClawStatus(user.id)
  } catch {
    // Unpaired all the same; the client asks for the status instead.
  }
  return jsonOk({ openclaw } satisfies UnpairResponse)
}
