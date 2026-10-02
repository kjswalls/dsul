import { NextResponse } from 'next/server'
import { isSameOrigin, NO_STORE, readJson, requireSessionUser } from '@/app/api/ai/_shared/guard'
import type { ChatErrorCode } from '@/lib/ai-types'
import {
  clipText,
  composeChatSystem,
  MAX_CHAT_CONTEXT_CHARS,
  MAX_OUTPUT_TOKENS,
  sanitizeChatMessages,
} from '@/lib/ai-limits'
import {
  chatSessionKey,
  GatewayConfigReadError,
  getGatewayConfig,
  itemSessionKey,
  streamGatewayChat,
  type GatewayConfig,
} from '@/lib/openclaw-gateway'
import { SSE_HEADERS } from '@/lib/sse'
import { AiDbError, openModelConnection, setConnectionStatus, type Opened } from '@/lib/ai-server/connections'
import {
  httpStatusFor,
  logProviderError,
  toChatErrorCode,
  toProviderError,
  USER_MESSAGES,
} from '@/lib/ai-server/errors'
import { getAdapter } from '@/lib/ai-server/providers'
import { anySignal, deltasToSse } from '@/lib/ai-server/stream'

/**
 * POST /api/chat: one chat turn, streamed as dsul's own SSE frames
 * (`{content}` deltas, at most one `{error, code}`, then `[DONE]`).
 *
 * Two answerers, both the user's own: the model they connected in Settings, or
 * their OpenClaw gateway. dsul has no key of its own, so there is no fallback
 * and nothing here reads one from the environment. Which answers is the body's
 * `target`; the key, the model and the base URL come from the server-side
 * connection, never from the body.
 *
 * Every failure before a stream exists answers JSON `{error, code}` with our
 * own copy. A provider's text, a database error and the key never reach the
 * response or the logs.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Our own deadline, inside `maxDuration`, so a hung upstream ends in an error
 * frame rather than a platform-killed stream.
 */
const CHAT_TIMEOUT_MS = 50_000

/** 40 turns of 8k characters plus 60k of context, in UTF-8, with room to spare. */
const MAX_BODY_BYTES = 2_000_000

const NOT_CONNECTED_MODEL = 'Connect a model in Settings to chat.'
const NOT_CONNECTED_GATEWAY = 'Connect your OpenClaw gateway in Settings to chat.'

function jsonChatError(
  status: number,
  error: string,
  code: ChatErrorCode,
  extra?: Record<string, unknown>
): NextResponse {
  return NextResponse.json({ ...extra, error, code }, { status, headers: NO_STORE })
}

const STREAM_HEADERS = { ...SSE_HEADERS, 'Cache-Control': 'no-store' }

interface ChatBody {
  messages?: unknown
  context?: unknown
  target?: unknown
  provider?: unknown
  customInstructions?: unknown
  typeNouns?: unknown
  threadItemId?: unknown
}

export async function POST(req: Request): Promise<Response> {
  const user = await requireSessionUser()
  if (!user) return jsonChatError(401, 'Your session ended. Sign in again.', 'unauthorized')
  if (!isSameOrigin(req)) return jsonChatError(403, "That request wasn't allowed.", 'forbidden')

  const read = await readJson<ChatBody>(req, MAX_BODY_BYTES)
  if (!read.ok) {
    return read.error === 'too_large'
      ? jsonChatError(413, 'That message is too long to send.', 'too_large')
      : jsonChatError(read.status, "That request couldn't be read.", 'invalid')
  }
  const body: ChatBody = read.body && typeof read.body === 'object' ? read.body : {}

  // `provider`, `apiKey`, `model` and `systemPrompt` are never read. `provider`
  // is consulted only to place an older tab (deploy skew) that sends no target.
  const target =
    body.target === 'model' || body.target === 'openclaw'
      ? body.target
      : body.provider === 'openclaw'
        ? 'openclaw'
        : 'model'

  const messages = sanitizeChatMessages(body.messages)
  if (messages.length === 0) return jsonChatError(400, "That request couldn't be read.", 'invalid')
  const context = clipText(body.context, MAX_CHAT_CONTEXT_CHARS)
  const system = composeChatSystem({
    typeNouns: body.typeNouns,
    customInstructions: body.customInstructions,
    context,
  })

  // ── OpenClaw gateway ───────────────────────────────────────────────────────
  // Proxied here rather than called from the browser: the gateway token is full
  // operator access and stays server-side. No output cap: it is the user's own
  // agent.
  if (target === 'openclaw') {
    let config: GatewayConfig | null
    try {
      config = await getGatewayConfig(user.id)
    } catch (err) {
      console.warn('[ai] chat gateway config', err instanceof GatewayConfigReadError ? 'unreadable' : 'failed')
      return jsonChatError(503, USER_MESSAGES.upstream, 'server')
    }
    if (!config) return jsonChatError(409, NOT_CONNECTED_GATEWAY, 'not_connected')

    try {
      const stream = await streamGatewayChat({
        config,
        // Derived from the authenticated user, never taken from the body. The
        // client names which THREAD it is (an item id, or nothing for the global
        // conversation); the key itself is built here, so a browser cannot
        // address another user's thread or a reserved gateway namespace.
        sessionKey:
          typeof body.threadItemId === 'string' && body.threadItemId
            ? itemSessionKey(user.id, body.threadItemId)
            : chatSessionKey(user.id),
        messages: [{ role: 'system', content: system.join('\n\n') }, ...messages],
        signal: anySignal([req.signal, AbortSignal.timeout(CHAT_TIMEOUT_MS)]),
      })
      return new Response(stream, { headers: STREAM_HEADERS })
    } catch {
      return jsonChatError(502, "Couldn't reach your OpenClaw gateway.", 'upstream')
    }
  }

  // ── The user's connected model ─────────────────────────────────────────────
  let conn: Opened
  try {
    conn = await openModelConnection(user.id)
  } catch (err) {
    if (err instanceof AiDbError) console.warn('[ai] db', err.op, 'failed', err.code)
    else console.warn('[ai] chat connection read failed')
    return jsonChatError(503, USER_MESSAGES.upstream, 'server')
  }
  if (!conn.ok) {
    switch (conn.reason) {
      case 'unavailable':
        return jsonChatError(503, NOT_CONNECTED_MODEL, 'not_connected', { available: false })
      case 'blocked_url':
        return jsonChatError(400, USER_MESSAGES.blocked_url, 'blocked_url')
      default:
        return jsonChatError(409, NOT_CONNECTED_MODEL, 'not_connected')
    }
  }

  const { row, creds, model } = conn
  const abort = new AbortController()
  const signal = anySignal([req.signal, abort.signal, AbortSignal.timeout(CHAT_TIMEOUT_MS)])
  const adapter = getAdapter(creds.provider)
  const onFailure = async (err: unknown) => {
    const e = toProviderError(err, creds.provider, 'call')
    logProviderError('chat', creds.provider, e.kind, e.status)
    if (e.kind === 'auth') {
      // Conditional on the ciphertext this request read: a key replaced in the
      // meantime is never marked failing for the old one's rejection.
      await setConnectionStatus(user.id, row.key_ciphertext, 'failing', 'key_rejected').catch(() => {})
    }
    return e
  }

  let source: AsyncIterable<string>
  try {
    source = await adapter.openStream(creds, {
      model,
      modelMeta: row.model_meta ?? {},
      system,
      messages,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      signal,
    })
  } catch (err) {
    const e = await onFailure(err)
    if (e.kind === 'aborted') return new Response(null, { status: 204, headers: NO_STORE })
    return jsonChatError(httpStatusFor(e.kind), e.message, toChatErrorCode(e.kind))
  }

  return new Response(
    deltasToSse(source, {
      abort,
      onError: async (err) => {
        const e = await onFailure(err)
        return { error: e.message, code: toChatErrorCode(e.kind) }
      },
    }),
    { headers: STREAM_HEADERS }
  )
}
