import { NextResponse } from 'next/server'
import { isSameOrigin, NO_STORE, readJson, requireSession } from '@/app/api/ai/_shared/guard'
import type { ChatErrorCode } from '@/lib/ai-types'
import { ROUTE_ERROR_COPY } from '@/lib/chat-errors'
import { clipText, MAKE_MAX_CHARS, MAKE_OUTPUT_TOKENS, MAX_MAKE_ASK_CHARS } from '@/lib/ai-limits'
import { SSE_HEADERS } from '@/lib/sse'
import {
  AiDbError,
  openModelConnection,
  readAIHidden,
  setConnectionLimit,
  setConnectionStatus,
  type Opened,
} from '@/lib/ai-server/connections'
import {
  httpStatusFor,
  logProviderError,
  toChatErrorCode,
  toProviderError,
  USER_MESSAGES,
} from '@/lib/ai-server/errors'
import { getAdapter } from '@/lib/ai-server/providers'
import { anySignal, deltasToSse } from '@/lib/ai-server/stream'
import { takeToken } from '@/lib/ai-server/rate-limit'
import { buildMakeContext } from '@/lib/ai-server/make-context'
import { isMakeKind, makeSystem } from '@/lib/ai-server/make-prompt'

/**
 * POST /api/ai/make: "Write with AI" in Settings → Make (memory/plans/mods.md,
 * "AI writes it", decision 6). One press writes one recipe, theme or Look as
 * JSON, streamed as dsul's own SSE frames (`{content}` deltas, at most one
 * `{error, code}`, then `[DONE]`), exactly as /api/chat streams.
 *
 * The person's own connected model only. Never OpenClaw, and never a key of
 * dsul's own: an account with no usable model is `not_connected`, whatever the
 * body says. The browser shows Write only while the gate's `canMake` holds;
 * the checks here are the backstop.
 *
 * The body is read for `kind` and `ask` and nothing else. What the model sees
 * besides the ask is built here: the fixed prompt (lib/ai-server/make-prompt.ts)
 * and the person's project, type, theme and Look names, read from the database
 * through the session client (lib/ai-server/make-context.ts). No item, note or
 * conversation, and no Custom instructions. A `context` in the body is ignored.
 *
 * Nothing is stored: not the ask, not the reply. The browser checks the reply
 * against the same schemas and saves it, switched off, only on Install.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Our own deadline, inside `maxDuration`, as /api/chat's. */
const MAKE_TIMEOUT_MS = 50_000

/** A kind and a 1,000-character ask, with room to spare for a body an older tab pads. */
const MAX_BODY_BYTES = 16_384

const NOT_CONNECTED = 'Connect a model in Settings to write with AI.'
const RATE_LIMITED = "You've written a lot with AI this hour. Try again later."

function jsonError(status: number, error: string, code: ChatErrorCode, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ ...extra, error, code }, { status, headers: NO_STORE })
}

const STREAM_HEADERS = { ...SSE_HEADERS, 'Cache-Control': 'no-store' }

export async function POST(req: Request): Promise<Response> {
  const session = await requireSession()
  if (!session) return jsonError(401, ROUTE_ERROR_COPY.unauthorized, 'unauthorized')
  if (!isSameOrigin(req)) return jsonError(403, ROUTE_ERROR_COPY.forbidden, 'forbidden')
  const { user, db } = session

  const read = await readJson<{ kind?: unknown; ask?: unknown }>(req, MAX_BODY_BYTES)
  if (!read.ok) {
    return read.error === 'too_large'
      ? jsonError(413, ROUTE_ERROR_COPY.too_large, 'too_large')
      : jsonError(read.status, ROUTE_ERROR_COPY.invalid, 'invalid')
  }
  const body = read.body && typeof read.body === 'object' ? read.body : {}

  // Only these two. `context`, `target`, `model`, `systemPrompt` and
  // `customInstructions` are never read.
  const kind = body.kind
  if (!isMakeKind(kind)) return jsonError(400, ROUTE_ERROR_COPY.invalid, 'invalid')
  // Clipped, not refused: the box stops at the same length.
  const ask = clipText(body.ask, MAX_MAKE_ASK_CHARS).trim()
  if (!ask) return jsonError(400, ROUTE_ERROR_COPY.invalid, 'invalid')

  if (!takeToken(user.id, 'make')) return jsonError(429, RATE_LIMITED, 'rate_limit')

  let hidden: boolean | null
  let conn: Opened
  try {
    ;[hidden, conn] = await Promise.all([readAIHidden(user.id), openModelConnection(user.id)])
  } catch (err) {
    if (err instanceof AiDbError) console.warn('[ai] db', err.op, 'failed', err.code)
    else console.warn('[ai] make connection read failed')
    return jsonError(503, USER_MESSAGES.upstream, 'server')
  }
  // "No AI, thanks" holds here too, though the browser never offers Write then.
  if (hidden === true) return jsonError(409, NOT_CONNECTED, 'not_connected')
  if (!conn.ok) {
    switch (conn.reason) {
      case 'unavailable':
        return jsonError(503, NOT_CONNECTED, 'not_connected', { available: false })
      case 'blocked_url':
        return jsonError(400, USER_MESSAGES.blocked_url, 'blocked_url')
      default:
        return jsonError(409, NOT_CONNECTED, 'not_connected')
    }
  }

  const context = await buildMakeContext(db, user.id)

  const { row, creds, model } = conn
  const abort = new AbortController()
  const signal = anySignal([req.signal, abort.signal, AbortSignal.timeout(MAKE_TIMEOUT_MS)])
  const adapter = getAdapter(creds.provider)
  const onFailure = async (err: unknown) => {
    const e = toProviderError(err, creds.provider, 'call')
    logProviderError('make', creds.provider, e.kind, e.status)
    if (e.kind === 'auth') {
      // Conditional on the ciphertext this request read, as chat's.
      await setConnectionStatus(user.id, row.key_ciphertext, 'failing', 'key_rejected').catch(() => {})
    } else if (e.kind === 'daily_limit') {
      // So the connection says when the free day's limit lifts, as chat's.
      await setConnectionLimit(user.id, row.key_ciphertext, e.resetAt ?? null).catch(() => {})
    }
    return e
  }

  let source: AsyncIterable<string>
  try {
    source = await adapter.openStream(creds, {
      model,
      modelMeta: row.model_meta ?? {},
      system: makeSystem(kind, context),
      messages: [{ role: 'user', content: ask }],
      maxOutputTokens: MAKE_OUTPUT_TOKENS,
      signal,
      json: true,
    })
  } catch (err) {
    const e = await onFailure(err)
    if (e.kind === 'aborted') return new Response(null, { status: 204, headers: NO_STORE })
    return jsonError(httpStatusFor(e.kind), e.message, toChatErrorCode(e.kind))
  }

  return new Response(
    deltasToSse(source, {
      abort,
      maxChars: MAKE_MAX_CHARS,
      onError: async (err) => {
        const e = await onFailure(err)
        return { error: e.message, code: toChatErrorCode(e.kind) }
      },
    }),
    { headers: STREAM_HEADERS }
  )
}
