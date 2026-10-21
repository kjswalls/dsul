import { NextResponse } from 'next/server'
import { isSameOrigin, NO_STORE, readJson, requireSessionUser } from '@/app/api/ai/_shared/guard'
import type { ChatErrorCode } from '@/lib/ai-types'
import { extractJsonObject } from '@/lib/json-extract'
import { appendInstructions, clipText, MAX_OUTPUT_TOKENS } from '@/lib/ai-limits'
import {
  AiDbError,
  openModelConnection,
  setConnectionLimit,
  setConnectionStatus,
  type Opened,
} from '@/lib/ai-server/connections'
import { httpStatusFor, logProviderError, toChatErrorCode, toProviderError, USER_MESSAGES } from '@/lib/ai-server/errors'
import { getAdapter } from '@/lib/ai-server/providers'
import { anySignal } from '@/lib/ai-server/stream'
import { MAX_SPLIT_CHARS, SPLIT_JSON_ONLY_LINE, SPLIT_SYSTEM_PROMPT, splitDrafts } from '@/lib/braindump-split'

/**
 * /api/ai/split — braindump to things (lib/braindump-split.ts).
 *
 *   POST  `{ text, customInstructions? }`: a paragraph the person pasted or
 *         typed. Their own model splits it into separate things to do and
 *         answers `{ drafts: [{ title, notes? }] }`. Nothing is kept: the
 *         bulk-add dialog shows the drafts, and Add is what writes them.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SPLIT_TIMEOUT_MS = 45_000
const MAX_BODY_BYTES = 32_000

function jsonError(status: number, error: string, code: ChatErrorCode): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE })
}

interface SplitBody {
  text?: unknown
  customInstructions?: unknown
}

export async function POST(req: Request): Promise<Response> {
  const user = await requireSessionUser()
  if (!user) return jsonError(401, 'Your session ended. Sign in again.', 'unauthorized')
  if (!isSameOrigin(req)) return jsonError(403, "That request wasn't allowed.", 'forbidden')

  const read = await readJson<SplitBody>(req, MAX_BODY_BYTES)
  if (!read.ok) {
    return read.error === 'too_large'
      ? jsonError(413, 'That request is too large.', 'too_large')
      : jsonError(read.status, "That request couldn't be read.", 'invalid')
  }
  const body: SplitBody = read.body && typeof read.body === 'object' ? read.body : {}
  const text = clipText(body.text, MAX_SPLIT_CHARS).trim()
  if (!text) return jsonError(400, "That request couldn't be read.", 'invalid')

  let conn: Opened
  try {
    conn = await openModelConnection(user.id)
  } catch (err) {
    if (err instanceof AiDbError) console.warn('[ai] db', err.op, 'failed', err.code)
    else console.warn('[ai] split connection read failed')
    return jsonError(503, USER_MESSAGES.upstream, 'server')
  }
  if (!conn.ok) {
    if (conn.reason === 'blocked_url') return jsonError(400, USER_MESSAGES.blocked_url, 'blocked_url')
    return jsonError(conn.reason === 'unavailable' ? 503 : 409, 'Connect a model in Settings first.', 'not_connected')
  }

  const { row, creds, model } = conn
  let raw: string
  try {
    raw = await getAdapter(creds.provider).completeText(creds, {
      model,
      modelMeta: row.model_meta ?? {},
      system: [[appendInstructions(SPLIT_SYSTEM_PROMPT, body.customInstructions), SPLIT_JSON_ONLY_LINE].join('\n\n')],
      messages: [{ role: 'user', content: `"""\n${text}\n"""` }],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      signal: anySignal([req.signal, AbortSignal.timeout(SPLIT_TIMEOUT_MS)]),
      json: true,
    })
  } catch (err) {
    const e = toProviderError(err, creds.provider, 'call')
    logProviderError('split', creds.provider, e.kind, e.status)
    if (e.kind === 'auth') {
      await setConnectionStatus(user.id, row.key_ciphertext, 'failing', 'key_rejected').catch(() => {})
    } else if (e.kind === 'daily_limit') {
      await setConnectionLimit(user.id, row.key_ciphertext, e.resetAt ?? null).catch(() => {})
    }
    if (e.kind === 'aborted') return new Response(null, { status: 204, headers: NO_STORE })
    return jsonError(httpStatusFor(e.kind), e.message, toChatErrorCode(e.kind))
  }

  const parsed = extractJsonObject(raw) as { drafts?: unknown } | null
  return NextResponse.json({ drafts: splitDrafts(parsed?.drafts) }, { headers: NO_STORE })
}
