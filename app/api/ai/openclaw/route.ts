import { isSameOrigin, jsonError, jsonOk, requireSessionUser } from '@/app/api/ai/_shared/guard'
import { AiDbError, readOpenClawStatus, unpairOpenClaw } from '@/lib/ai-server/connections'
import type { OpenClawView, UnpairResponse } from '@/lib/ai-types'

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
