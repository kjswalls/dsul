import { NextResponse } from 'next/server'
import { ProposalDraftSchema } from '@dsul/types'
import { isSameOrigin, NO_STORE, readJson, requireSessionUser } from '@/app/api/ai/_shared/guard'
import type { ChatErrorCode } from '@/lib/ai-types'
import {
  extractJsonObject,
  gatewayCompletion,
  GatewayConfigReadError,
  getGatewayConfig,
  proposeSessionKey,
  type GatewayConfig,
} from '@/lib/openclaw-gateway'
import { appendInstructions, clipText, MAX_CONTEXT_CHARS, MAX_OUTPUT_TOKENS } from '@/lib/ai-limits'
import { AiDbError, openModelConnection, setConnectionStatus, type Opened } from '@/lib/ai-server/connections'
import {
  httpStatusFor,
  logProviderError,
  toChatErrorCode,
  toProviderError,
  USER_MESSAGES,
} from '@/lib/ai-server/errors'
import { getAdapter } from '@/lib/ai-server/providers'
import { anySignal } from '@/lib/ai-server/stream'

/**
 * POST /api/ai/propose — turn a free-form ask into a planner diff.
 *
 * Returns `{ proposal }` (a ProposalDraft: summary + rationale + operations) or
 * `{ proposal: null, message }` when the model has nothing to suggest. The
 * client stamps the id/timestamp and re-validates every operation against the
 * type registry before showing the card, so this route is allowed to be
 * optimistic — a partly-wrong response degrades to a shorter card, never to a
 * bad write.
 *
 * Not streamed: a proposal is worthless until it is complete and validated, so
 * there is nothing to show token by token.
 *
 * Who answers is the user's own: the model they connected in Settings, or their
 * OpenClaw gateway. There is no key of dsul's own to fall back to. Failures
 * answer `{ error, code }` in our own words; a provider's text never reaches
 * the response.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Comfortably inside `maxDuration` so the deadline is OURS — a platform-killed
 * function returns no body at all, and the card would have nothing to show.
 * Applied to both answerers.
 */
const PROPOSE_TIMEOUT_MS = 45_000

/** Ceilings on caller-controlled input are shared with /api/chat; see lib/ai-limits.ts. */
const MAX_PROMPT_CHARS = 8_000
const MAX_BODY_BYTES = 128_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Last, after the user's own instructions, so nothing they wrote can talk the
 * model out of the one format this route can parse.
 */
const JSON_ONLY_LINE = 'Whatever the instructions above say, reply with the JSON object only.'

const SYSTEM_PROMPT = `You are the planning assistant inside dsul, a daily planner for neurodivergent people.

You turn a request into a PROPOSAL: a small set of concrete changes the user accepts with one tap. You never make changes yourself.

Reply with a JSON object and nothing else — no prose before or after it, no markdown fences.

The shape, exactly:
{
  "summary": "short headline, max ~8 words",
  "rationale": "one warm sentence explaining the thinking",
  "operations": [
    { "kind": "update", "itemId": "<id from the list>", "startDate": "yyyy-MM-dd", "timeBucket": "morning|afternoon|evening|anytime", "startTime": "HH:mm", "priority": "low|medium|high", "title": "new title", "status": "<a status this item's type allows>" },
    { "kind": "update", "itemId": "<id from the list>", "startDate": null },
    { "kind": "create", "itemType": "task", "title": "...", "startDate": "yyyy-MM-dd", "timeBucket": "...", "priority": "...", "notes": "..." }
  ]
}

Rules:
- Only include the fields you actually want to change. Omit everything else.
- "itemId" MUST be an id from the provided list, copied exactly.
- "startDate": null moves an item to the Braindump — off the calendar, still on the list, no date attached. Reach for it when something genuinely should not have a day yet: the user has said it is not happening this week, or the day is crowded and this is the piece with no real deadline. It is a kinder answer than shuffling something to a date nobody believes in, and it is often what "I can't face this right now" actually asks for. Not available for repeating items.
- "startTime": null keeps the day and drops the clock time. "priority": null stops flagging it.
- Create "task" items unless the user names a different type from the list.
- Never create habits.
- Task statuses are pending, completed or cancelled. Habit statuses are pending, done or skipped. Never mix them.
- Keep it to at most 8 operations. A short plan someone will actually do beats a complete one they won't.
- Tone: warm, specific, never judgmental. Never mention how late anything is.
- If you have nothing useful to propose, return {"summary":"","operations":[]}.`

/**
 * The steps-inside-one-thing prompt.
 *
 * A separate prompt rather than a paragraph bolted onto the planning one,
 * because the two want opposite instincts: planning moves existing work around
 * a week and must not invent; breakdown invents and must not touch anything
 * else. The size guidance is the load-bearing part — a fifteen-step decomposition
 * of a task someone is already avoiding is a fresh source of dread, not help.
 */
const BREAKDOWN_PROMPT = `You are the planning assistant inside dsul, a daily planner for neurodivergent people.

The user has one thing that feels too big. Break it into the few concrete steps that would actually get it moving.

Reply with a JSON object and nothing else — no prose before or after it, no markdown fences.

The shape, exactly:
{
  "summary": "short headline, max ~8 words",
  "rationale": "one warm sentence explaining the thinking",
  "operations": [
    { "kind": "create", "itemType": "task", "title": "the step", "parentItemId": "<the id you were given>" }
  ]
}

Rules:
- EVERY operation must be a create with "parentItemId" set to the id you were given, copied exactly.
- Propose no changes to anything else. No updates, no other parents, no dates.
- Three to six steps. Fewer, larger steps beat a long checklist — this is for someone who is already avoiding the task, and a fifteen-item list is a new thing to dread.
- The first step must be small enough to start in under five minutes.
- Each step names a concrete action ("Draft the three bullet points", not "Think about structure").
- Do not repeat steps the item already has.
- Tone: warm, plain, never judgmental. Never mention how late anything is.
- If the item is already small enough to just do, return {"summary":"","operations":[]}.`

const NOT_CONNECTED_MODEL = 'Connect a model in Settings to ask for a plan.'
const NOT_CONNECTED_GATEWAY = 'Connect your OpenClaw gateway in Settings to ask it for a plan.'

function jsonChatError(
  status: number,
  error: string,
  code: ChatErrorCode,
  extra?: Record<string, unknown>
): NextResponse {
  return NextResponse.json({ ...extra, error, code }, { status, headers: NO_STORE })
}

const ok = (body: unknown) => NextResponse.json(body, { headers: NO_STORE })

/** The model's raw text, as the card's answer: a proposal, or a calm "nothing". */
function proposalFrom(raw: string): NextResponse {
  const parsed = extractJsonObject(raw)
  if (!parsed) return ok({ proposal: null, message: 'No suggestion came back.' })

  const result = ProposalDraftSchema.safeParse(parsed)
  if (!result.success || result.data.operations.length === 0) {
    // An empty or malformed draft is a normal outcome ("nothing to suggest"),
    // not an error the user should have to read about.
    return ok({ proposal: null, message: 'Nothing worth changing right now.' })
  }
  return ok({ proposal: result.data })
}

interface ProposeBody {
  prompt?: unknown
  target?: unknown
  provider?: unknown
  mode?: unknown
  itemContext?: unknown
  todayStr?: unknown
  customInstructions?: unknown
}

export async function POST(req: Request): Promise<Response> {
  // Authenticated, always: every branch spends the user's own key or gateway,
  // and the id that picks which one comes from the session, never the body.
  const user = await requireSessionUser()
  if (!user) return jsonChatError(401, 'Your session ended. Sign in again.', 'unauthorized')
  if (!isSameOrigin(req)) return jsonChatError(403, "That request wasn't allowed.", 'forbidden')

  const read = await readJson<ProposeBody>(req, MAX_BODY_BYTES)
  if (!read.ok) {
    return read.error === 'too_large'
      ? jsonChatError(413, 'That request is too large.', 'too_large')
      : jsonChatError(read.status, "That request couldn't be read.", 'invalid')
  }
  const body: ProposeBody = read.body && typeof read.body === 'object' ? read.body : {}

  // `provider`, `apiKey` and `model` are never read, except `provider` to place
  // an older tab (deploy skew) that sends no target.
  const target =
    body.target === 'model' || body.target === 'openclaw'
      ? body.target
      : body.provider === 'openclaw'
        ? 'openclaw'
        : 'model'

  // Unknown modes fall back to planning rather than erroring: an older client
  // sending nothing is the normal case, and this is not a security boundary —
  // both prompts are ours, and both outputs go through the same validation.
  const mode = body.mode === 'breakdown' ? 'breakdown' : 'plan'
  const systemPrompt = [
    appendInstructions(mode === 'breakdown' ? BREAKDOWN_PROMPT : SYSTEM_PROMPT, body.customInstructions),
    JSON_ONLY_LINE,
  ].join('\n\n')

  const today =
    typeof body.todayStr === 'string' && DATE_RE.test(body.todayStr)
      ? body.todayStr
      : new Date().toISOString().slice(0, 10)

  // A caller controls `prompt` and `itemContext` completely. Truncating rather
  // than rejecting keeps the honest oversized case (a very long chat reply)
  // working while bounding what the user's own bill can be charged.
  const userTurn = [
    `Today is ${today}.`,
    clipText(body.itemContext, MAX_CONTEXT_CHARS),
    '',
    clipText(body.prompt, MAX_PROMPT_CHARS).trim() ||
      (mode === 'breakdown'
        ? 'Break this into a few concrete steps.'
        : 'Suggest a realistic plan for today.'),
  ].join('\n')

  const timeout = AbortSignal.timeout(PROPOSE_TIMEOUT_MS)
  const signal = anySignal([req.signal, timeout])

  // ── OpenClaw gateway ───────────────────────────────────────────────────────
  // Proposes through the user's OWN gateway. Falling through to their model
  // here would quietly send an OpenClaw user's planner somewhere they did not
  // choose for it: not a degraded mode, a broken promise about where their data
  // goes. So this branch either works or fails; it never reroutes.
  if (target === 'openclaw') {
    let config: GatewayConfig | null
    try {
      config = await getGatewayConfig(user.id)
    } catch (err) {
      console.warn('[ai] propose gateway config', err instanceof GatewayConfigReadError ? 'unreadable' : 'failed')
      return jsonChatError(503, USER_MESSAGES.upstream, 'server')
    }
    if (!config) return jsonChatError(409, NOT_CONNECTED_GATEWAY, 'not_connected')

    try {
      const raw = await gatewayCompletion({
        config,
        sessionKey: proposeSessionKey(user.id),
        signal,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userTurn },
        ],
      })
      return proposalFrom(raw)
    } catch {
      if (timeout.aborted) {
        return jsonChatError(
          504,
          "Your gateway didn't answer in time. Is it reachable from the internet?",
          'timeout'
        )
      }
      return jsonChatError(502, "Couldn't reach your OpenClaw gateway.", 'upstream')
    }
  }

  // ── The user's connected model ─────────────────────────────────────────────
  let conn: Opened
  try {
    conn = await openModelConnection(user.id)
  } catch (err) {
    if (err instanceof AiDbError) console.warn('[ai] db', err.op, 'failed', err.code)
    else console.warn('[ai] propose connection read failed')
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
  try {
    const raw = await getAdapter(creds.provider).completeText(creds, {
      model,
      modelMeta: row.model_meta ?? {},
      system: [systemPrompt],
      messages: [{ role: 'user', content: userTurn }],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      signal,
      // json_object where the provider supports it, rather than a strict
      // schema: the client drops individual bad operations anyway, so
      // tolerance beats brittleness here. extractJsonObject covers the rest.
      json: true,
    })
    return proposalFrom(raw)
  } catch (err) {
    const e = toProviderError(err, creds.provider, 'call')
    logProviderError('propose', creds.provider, e.kind, e.status)
    if (e.kind === 'auth') {
      await setConnectionStatus(user.id, row.key_ciphertext, 'failing', 'key_rejected').catch(() => {})
    }
    if (e.kind === 'aborted') return new Response(null, { status: 204, headers: NO_STORE })
    return jsonChatError(httpStatusFor(e.kind), e.message, toChatErrorCode(e.kind))
  }
}
