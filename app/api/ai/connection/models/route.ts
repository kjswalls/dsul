import { jsonError, jsonOk, requireSessionUser } from '@/app/api/ai/_shared/guard'
import type { ModelOption, ModelsResponse } from '@/lib/ai-types'
import {
  AiDbError,
  openConnectionKey,
  setConnectionStatus,
  type OpenedKey,
} from '@/lib/ai-server/connections'
import { logProviderError, toProviderError } from '@/lib/ai-server/errors'
import { getAdapter, type ListedModel } from '@/lib/ai-server/providers'
import { takeToken } from '@/lib/ai-server/rate-limit'
import { anySignal } from '@/lib/ai-server/stream'

/**
 * GET /api/ai/connection/models: the models the connected key can use, for the
 * settings picker.
 *
 * Answers whatever the connection's status or model, because the picker is
 * opened exactly when no model is chosen yet. OpenRouter lists its public
 * catalog without the key. Our error codes only; never a provider's text.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const LIST_TIMEOUT_MS = 10_000

/** The picker's shape, and nothing a provider listed beside it. */
function toOption(m: ListedModel): ModelOption {
  return m.free === undefined ? { id: m.id, label: m.label } : { id: m.id, label: m.label, free: m.free }
}

export async function GET(req: Request): Promise<Response> {
  const user = await requireSessionUser()
  if (!user) return jsonError(401, 'unauthorized')
  if (!takeToken(user.id, 'check')) return jsonError(429, 'busy')

  // `openConnectionKey`, not `openModelConnection`: the picker opens exactly
  // when no model is chosen yet, and listing must work on a failing key too.
  let opened: OpenedKey
  try {
    opened = await openConnectionKey(user.id)
  } catch (err) {
    // Never the error object: a database error's details can carry the row.
    if (err instanceof AiDbError) console.warn('[ai] db', err.op, 'failed', err.code)
    else console.warn('[ai] models read failed')
    return jsonError(503, 'server')
  }
  if (!opened.ok) {
    switch (opened.reason) {
      case 'unavailable':
        return jsonError(503, 'unavailable', { available: false })
      case 'none':
        return jsonError(404, 'not_connected')
      case 'unreadable':
        // Reported, never written.
        return jsonError(409, 'not_connected')
      case 'blocked_url':
        return jsonError(400, 'blocked_url', { field: 'baseUrl' })
    }
  }
  const { row, creds } = opened

  try {
    const list = await getAdapter(row.provider).listModels(
      creds,
      anySignal([req.signal, AbortSignal.timeout(LIST_TIMEOUT_MS)])
    )
    const body: ModelsResponse = { models: list.models.map(toOption), listed: list.listed }
    return jsonOk(body)
  } catch (err) {
    const e = toProviderError(err, row.provider, 'verify')
    logProviderError('models', row.provider, e.kind, e.status)
    if (e.kind === 'auth') {
      // Conditional on the ciphertext read above: a key replaced meanwhile is untouched.
      await setConnectionStatus(user.id, row.key_ciphertext, 'failing', 'key_rejected').catch(() => {})
      return jsonError(400, 'key_rejected')
    }
    if (e.kind === 'blocked_url') return jsonError(400, 'blocked_url', { field: 'baseUrl' })
    return jsonError(502, 'unreachable')
  }
}
