import { createServiceClient } from './supabase-service'
import { sseFrame } from './sse'

/**
 * openclaw-gateway.ts — dsul's side of the OpenClaw gateway conversation.
 *
 * SERVER ONLY. The gateway token is full operator access to the user's gateway
 * — the docs are blunt about it — so it must never reach a client component or
 * the browser bundle. The browser talks to dsul; dsul talks to the gateway.
 * That is a CONVENTION here, not a guarantee, and it is worth being honest
 * about which: `createServiceClient()` throws without SUPABASE_SECRET_KEY, but
 * only when called — importing this module into a client component would
 * bundle it silently and fail at runtime, not at build. The token itself is
 * never in the bundle (it is read from the database, server-side), so what the
 * mistake would cost is a broken screen rather than a leak. The `server-only`
 * package would make it a build error; it is not a dependency of this
 * workspace, and adding one for a single import is the trade not yet taken.
 *
 * Transport is the gateway's OpenAI-compatible surface
 * (`POST /v1/chat/completions`, opt-in via
 * `gateway.http.endpoints.chatCompletions.enabled`), chosen over the WebSocket
 * protocol because it streams real SSE, fits a Next route handler, and needs no
 * per-browser Ed25519 device pairing. The tradeoff is no tool-call events — an
 * acceptable one while chat is an escape hatch rather than the main surface.
 */

export interface GatewayConfig {
  baseUrl: string
  token: string
  agentId: string | null
}

/** Trailing slashes break `${base}/v1/...` concatenation. */
const normalizeBaseUrl = (url: string) => url.trim().replace(/\/+$/, '')

/**
 * The gateway settings could not be READ, as opposed to not being there.
 *
 * The difference matters to the user: "not configured" sends them to Settings
 * to set up something they already set up, while a failed read is a moment to
 * try again. Carries no database text: an error's details can echo the row,
 * and `user_secrets` holds the operator token.
 */
export class GatewayConfigReadError extends Error {
  constructor() {
    super('Could not read the OpenClaw gateway settings')
    this.name = 'GatewayConfigReadError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** The table or column is not there yet (a build ahead of its migration): nothing configured. */
const MISSING_SCHEMA_CODES = new Set(['42P01', 'PGRST205', '42703', 'PGRST204'])

/**
 * Resolve a user's gateway config, or null when they have not set one up.
 *
 * Uses the service client because `user_secrets` is deliberately unreachable
 * with a user JWT (migration 012) — callers must have already authenticated the
 * user through their session before passing a userId in here.
 *
 * A missing row, a missing value or a missing schema is null. Any other failure
 * to read either table (or to build the service client at all) throws
 * `GatewayConfigReadError`, never the database's own error.
 */
export async function getGatewayConfig(userId: string): Promise<GatewayConfig | null> {
  type Read<T> = { data: T | null; error: { code?: string } | null }
  let settingsRes: Read<{ openclaw_gateway_url?: string | null; openclaw_agent_id?: string | null }>
  let secretsRes: Read<{ openclaw_gateway_token?: string | null }>
  try {
    const service = createServiceClient()
    ;[settingsRes, secretsRes] = await Promise.all([
      service
        .from('user_settings')
        .select('openclaw_gateway_url, openclaw_agent_id')
        .eq('user_id', userId)
        .maybeSingle(),
      service
        .from('user_secrets')
        .select('openclaw_gateway_token')
        .eq('user_id', userId)
        .maybeSingle(),
    ])
  } catch {
    throw new GatewayConfigReadError()
  }

  const errors = [settingsRes.error, secretsRes.error].filter(
    (e): e is { code?: string } => e !== null && e !== undefined
  )
  if (errors.some((e) => !MISSING_SCHEMA_CODES.has(e.code ?? ''))) throw new GatewayConfigReadError()
  if (errors.length > 0) return null

  const settings = settingsRes.data
  const secrets = secretsRes.data
  const baseUrl = settings?.openclaw_gateway_url
  const token = secrets?.openclaw_gateway_token
  if (!baseUrl || !token) return null

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    token,
    agentId: settings?.openclaw_agent_id ?? null,
  }
}

/**
 * One gateway session per saved conversation, keyed SERVER-SIDE.
 *
 * Sessions have no TTL by default, so a stable key is what gives a
 * conversation durable gateway-side memory across reloads and devices, and a
 * new chat is a new id, so it really is new on OpenClaw.
 *
 * Never accept a session key from the client. `subagent:`, `cron:` and `acp:`
 * are reserved namespaces the gateway rejects from external callers, and a
 * caller-supplied key would also let one browser address another user's
 * session. Both are structurally impossible here because the key is built
 * from the fixed `dsul:` literal, the AUTHENTICATED user id and a UUID the
 * route validated (app/api/chat/route.ts) — so there is no denylist to
 * maintain and nothing to keep in sync with the gateway. No ownership read:
 * the uid prefix already scopes the key, and the conversation's row does not
 * exist before its first turn ends.
 */
export function conversationSessionKey(userId: string, conversationId: string): string {
  return `dsul:u:${userId}:chat:${conversationId}`
}

/**
 * The key proposals are asked on — deliberately NOT the user's chat key.
 *
 * A proposal request is a one-shot machine exchange: a system prompt demanding
 * JSON, the whole planner as context, and a JSON object back. Putting that on
 * a `conversationSessionKey` would splice it into the middle of a conversation
 * the user is actually having, and the next thing they said would be answered
 * by a model that had just been told to reply in JSON only.
 *
 * The honest cost: this session accumulates too, and there is no documented way
 * to ask the gateway for a stateless turn. It grows slowly (one short exchange
 * per proposal) and it grows somewhere harmless. If it ever becomes a problem
 * the fix is a gateway-side session cap, not a per-request key — minting a
 * fresh key each time would leave an unbounded trail of sessions behind.
 */
export function proposeSessionKey(userId: string): string {
  return `dsul:u:${userId}:propose`
}

/**
 * Guard for the one place dsul fetches a URL the user typed.
 *
 * Deliberately does NOT block RFC1918 or CGNAT 100.64/10: a Tailscale address
 * is the intended, normal deployment, and blocking private ranges here would
 * reject the correct configuration. What it does block is the cloud metadata
 * endpoint, and it requires TLS anywhere but local development.
 */
/**
 * Does this IPv6 spelling actually carry a 169.254.x.x address?
 *
 * The WHATWG parser folds octal, decimal, hex and trailing-dot IPv4 back to a
 * dotted quad, so those are caught by the plain string test. What it does NOT
 * fold is IPv4 riding inside IPv6, and there is more than one way to write
 * that:
 *   ::ffff:a9fe:a9fe    IPv4-mapped (the well-known one)
 *   ::a9fe:a9fe         IPv4-compatible (deprecated, still routable)
 *   64:ff9b::a9fe:a9fe  the NAT64 well-known prefix — on IPv6-only egress
 *                       behind a NAT64 gateway this IS translated to the v4
 *                       address, which makes it the one that could really bite
 * So the last two hextets are decoded for any of those prefixes rather than
 * matching one literal string.
 */
function isMappedLinkLocal(host: string): boolean {
  const prefixes = ['::ffff:', '::', '64:ff9b::']

  for (const prefix of prefixes) {
    if (!host.startsWith(prefix)) continue
    const tail = host.slice(prefix.length)

    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
    if (hex) {
      const high = parseInt(hex[1], 16)
      if (((high >> 8) & 0xff) === 169 && (high & 0xff) === 254) return true
      continue
    }
    // Some parsers keep the dotted tail; handle that spelling too.
    const dotted = /^(\d{1,3}(?:\.\d{1,3}){3})$/.exec(tail)
    if (dotted && /^169\.254\./.test(dotted[1])) return true
  }
  return false
}

/**
 * Hostnames that resolve to a metadata service by NAME rather than by address.
 *
 * `metadata.google.internal` is the documented alias for 169.254.169.254, and
 * no literal-IP test will ever catch it. `.internal` is not a public TLD, so
 * refusing the whole suffix costs a legitimate gateway nothing.
 */
function isMetadataHostname(host: string): boolean {
  return host === 'metadata' || host.endsWith('.internal')
}

/**
 * The host rules, without a TLS policy.
 *
 * Split out because dsul now fetches TWO user-supplied URLs and they differ
 * on exactly one axis. A gateway URL must be https outside local development —
 * it carries a bearer token that is full operator access. A plugin WEBHOOK URL
 * is the plugin's own listener, typically plain http on the tailnet that
 * already encrypts it, so demanding TLS there would reject the ordinary
 * deployment. Everything else — metadata addresses, credentials in the URL,
 * the protocol allowlist — is identical and must not be reimplemented per
 * caller, which is how one of two copies quietly stops blocking something.
 */
export function assertSafeOutboundUrl(
  raw: string,
  opts: { requireTls: boolean }
): { ok: true; url: string } | { ok: false; reason: string } {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, reason: 'Enter a full URL, including http:// or https://' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https URLs are supported' }
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1'

  // Credentials in the URL would be written to user_settings, which the browser
  // CAN read — the token column exists precisely so secrets stay out of there.
  if (url.username || url.password) {
    return { ok: false, reason: 'Put the token in the token field, not in the URL' }
  }

  // 169.254.0.0/16 — cloud instance metadata lives at 169.254.169.254, and a
  // server-side fetch of it would hand over instance credentials.
  //
  // The WHATWG parser folds octal, decimal and trailing-dot IPv4 spellings back
  // to a dotted quad, so those are caught by the plain test. What it does NOT
  // fold away is the IPv4-mapped IPv6 form: `[::ffff:169.254.169.254]` becomes
  // `[::ffff:a9fe:a9fe]`, hex rather than dotted, and reaches the same address.
  // So the mapped form is decoded back to an IPv4 rather than matched as a
  // literal — one hard-coded address would only block the one everybody knows.
  if (
    /^169\.254\./.test(host) ||
    host === 'fd00:ec2::254' ||
    isMappedLinkLocal(host) ||
    isMetadataHostname(host)
  ) {
    return { ok: false, reason: 'That address range is not allowed' }
  }

  if (
    opts.requireTls &&
    url.protocol === 'http:' &&
    !(isLoopback && process.env.NODE_ENV !== 'production')
  ) {
    return { ok: false, reason: 'Use https (http is only allowed for localhost in development)' }
  }

  return { ok: true, url: url.toString().replace(/\/+$/, '') }
}

/**
 * The gateway URL — the one dsul sends an operator-access bearer token to, so
 * TLS is not optional.
 */
export function assertAllowedGatewayUrl(
  raw: string
): { ok: true; url: string } | { ok: false; reason: string } {
  return assertSafeOutboundUrl(raw, { requireTls: true })
}

export interface GatewayChatRequest {
  config: GatewayConfig
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  sessionKey: string
  signal?: AbortSignal
}

/**
 * THE UNVERIFIED ASSUMPTION — the first thing to test against a real gateway.
 *
 * A keyed session on the gateway holds its own history. What the docs do not
 * say is whether posting a full transcript to an existing session key APPENDS
 * the messages or REPLACES the turn, and the two behaviours differ sharply:
 * if the gateway already remembers the conversation, resending it every turn
 * duplicates history and the model sees each message twice.
 *
 * `false` (send only the newest turn) is the safer default: under-sending
 * costs context the gateway already has, while over-sending corrupts it. If a
 * gateway turns out to be stateless per request, flip this to true.
 */
export const SEND_FULL_TRANSCRIPT_TO_GATEWAY = false

/** The messages to actually put on the wire, per the assumption above. */
export function gatewayTurnMessages(
  messages: GatewayChatRequest['messages']
): GatewayChatRequest['messages'] {
  if (SEND_FULL_TRANSCRIPT_TO_GATEWAY) return messages
  const system = messages.filter((m) => m.role === 'system')
  const latest = messages.filter((m) => m.role !== 'system').slice(-1)
  return [...system, ...latest]
}

/**
 * Extracts the incremental text from one OpenAI-shaped streaming chunk.
 *
 * Exported for tests: this is the only place that knows the gateway's wire
 * shape, and everything downstream sees dsul frames.
 */
export function deltaFromChunk(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const delta = (choices[0] as { delta?: unknown })?.delta
  if (!delta || typeof delta !== 'object') return ''
  const content = (delta as { content?: unknown }).content
  return typeof content === 'string' ? content : ''
}

/**
 * Opens a streaming chat against the gateway and returns a ReadableStream of
 * dsul frames (`data: {"content":…}` … `data: [DONE]`), so the browser parser
 * is identical for every tier and provider.
 */
export async function streamGatewayChat({
  config,
  messages,
  sessionKey,
  signal,
}: GatewayChatRequest): Promise<ReadableStream<Uint8Array>> {
  const allowed = assertAllowedGatewayUrl(config.baseUrl)
  if (!allowed.ok) throw new Error(allowed.reason)

  const res = await fetch(`${allowed.url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
      // Explicit routing beats the OpenAI `user` field: the gateway derives a
      // key from `user` only as a fallback, and we want the exact key back.
      'x-openclaw-session-key': sessionKey,
    },
    signal,
    // A redirect could bounce this authenticated request — bearer token and
    // all — at a host the URL guard never saw.
    redirect: 'error',
    body: JSON.stringify({
      model: config.agentId ?? 'default',
      messages: gatewayTurnMessages(messages),
      stream: true,
    }),
  })

  if (!res.ok || !res.body) {
    // Status only. The upstream body can carry configuration detail, and a
    // message from here must be safe to show in Ask's transcript.
    throw new Error(`Gateway responded ${res.status}`)
  }

  return translateGatewayStream(res.body)
}

/** OpenAI-shaped SSE in, dsul frames out. */
export function translateGatewayStream(
  body: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''

  return new ReadableStream({
    // Loops until it enqueues something or the source ends. A pull that
    // returns having enqueued nothing is NOT pulled again — the stream just
    // stalls — and gateway streams are full of content-free chunks (role
    // openers, finish_reason, usage, keepalives), so "read one chunk per pull"
    // deadlocks on the first one of them.
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read()

        if (done) {
          // Flush a trailing frame that arrived without its newline.
          for (const text of framesIn(buffer, true)) {
            if (text) controller.enqueue(encoder.encode(sseFrame({ content: text })))
          }
          // Always terminate, even if the gateway didn't: dsul's client
          // parser stops on [DONE], and without one it reads to EOF.
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
          return
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        let enqueued = false
        for (const line of lines) {
          for (const text of framesIn(line, false)) {
            if (text) {
              controller.enqueue(encoder.encode(sseFrame({ content: text })))
              enqueued = true
            }
          }
        }
        if (enqueued) return
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {})
    },
  })
}

/** Yields the delta text of one SSE line, skipping anything unparseable. */
function framesIn(line: string, isTail: boolean): string[] {
  const trimmed = isTail ? line.trim() : line
  if (!trimmed.startsWith('data:')) return []
  const payload = trimmed.slice(5).trim()
  if (!payload || payload === '[DONE]') return []
  try {
    return [deltaFromChunk(JSON.parse(payload))]
  } catch {
    return []
  }
}

/**
 * One non-streaming turn against the gateway, returning the raw assistant text.
 *
 * Proposals are the caller: there is nothing to show token by token, because a
 * diff is worthless until it is complete and validated.
 *
 * `response_format` is deliberately NOT sent. It is an OpenAI parameter that an
 * arbitrary agent behind an OpenAI-compatible facade may ignore or reject, and
 * a rejected request produces nothing at all — whereas an unconstrained one
 * produces text that `extractJsonObject` can usually still recover. Tolerance
 * beats brittleness here for the same reason the OpenAI branch chose
 * `json_object` over a strict schema.
 */
export async function gatewayCompletion({
  config,
  messages,
  sessionKey,
  signal,
}: GatewayChatRequest): Promise<string> {
  const allowed = assertAllowedGatewayUrl(config.baseUrl)
  if (!allowed.ok) throw new Error(allowed.reason)

  const res = await fetch(`${allowed.url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
      'x-openclaw-session-key': sessionKey,
    },
    signal,
    redirect: 'error',
    body: JSON.stringify({
      model: config.agentId ?? 'default',
      messages,
      stream: false,
    }),
  })

  // Status only — the upstream body can carry gateway configuration detail, and
  // this message reaches the browser.
  if (!res.ok) throw new Error(`Gateway responded ${res.status}`)

  const payload: unknown = await res.json()
  const choices = (payload as { choices?: unknown })?.choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const content = (choices[0] as { message?: { content?: unknown } })?.message?.content
  return typeof content === 'string' ? content : ''
}

/**
 * Best-effort JSON object out of whatever a model actually said.
 *
 * The OpenAI branch can demand `json_object` and get it. A gateway agent is
 * some model behind some system prompt the user configured, and it may fence
 * the JSON, preface it ("Sure! Here's the plan:"), or append a sign-off. All
 * three are recoverable and all three would otherwise read to the user as "the
 * assistant is broken".
 *
 * Returns null rather than throwing: upstream treats "nothing to suggest" as a
 * normal outcome, and an unparseable reply is indistinguishable from one.
 */
export function extractJsonObject(raw: string): unknown | null {
  const text = raw.trim()
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    // Fall through to the substring attempt.
  }

  // Widest span that could be an object. Slicing to the LAST brace rather than
  // scanning for a balanced one keeps this to a few lines, and a trailing
  // sign-off after the JSON is far more common than a second object after it.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}
