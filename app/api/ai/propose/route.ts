import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { ProposalDraftSchema } from '@dsul/types'
import { createClient } from '@/lib/supabase-server'
import {
  extractJsonObject,
  gatewayCompletion,
  getGatewayConfig,
  proposeSessionKey,
} from '@/lib/openclaw-gateway'
import { MAX_CONTEXT_CHARS, resolveModel, SERVER_KEY_MAX_OUTPUT_TOKENS } from '@/lib/ai-limits'

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
 */

/**
 * Comfortably inside `maxDuration` so the deadline is OURS — a platform-killed
 * function returns no body at all, and the card would have nothing to show.
 * Applied to BOTH providers: the OpenAI SDK's own default is ten minutes.
 */
const PROPOSE_TIMEOUT_MS = 45_000

/**
 * Ceilings on caller-controlled input and the models the deployment's key may
 * be spent on are shared with /api/chat — see lib/ai-limits.ts.
 */
const MAX_PROMPT_CHARS = 8_000

export const maxDuration = 60

const SYSTEM_PROMPT = `You are Beacon, the planning assistant inside dsul — a daily planner for neurodivergent people.

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
const BREAKDOWN_PROMPT = `You are Beacon, the planning assistant inside dsul — a daily planner for neurodivergent people.

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

export async function POST(req: NextRequest) {
  // Authenticated, always. This route can fall back to the deployment's own
  // OPENAI_API_KEY, so leaving it open would let anyone on the internet spend
  // the owner's money by POSTing a prompt at it. The browser always has a
  // session here — the chat surfaces live inside the authenticated shell.
  //
  // The id is kept, not just checked: the gateway branch resolves the user's
  // own gateway from it, and it must come from the session rather than the
  // body — a userId a caller could name is a caller who can spend someone
  // else's gateway.
  let userId: string
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    userId = user.id
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: {
    prompt?: string
    provider?: string
    apiKey?: string
    model?: string
    mode?: string
    itemContext?: string
    todayStr?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { prompt, provider, apiKey, model, mode, itemContext, todayStr } = body

  // Unknown modes fall back to planning rather than erroring: an older client
  // sending nothing is the normal case, and this is not a security boundary —
  // both prompts are ours, and both outputs go through the same validation.
  const systemPrompt = mode === 'breakdown' ? BREAKDOWN_PROMPT : SYSTEM_PROMPT

  if (provider === 'anthropic') {
    return NextResponse.json(
      { error: 'Claude support is coming soon — use OpenAI for now.' },
      { status: 400 }
    )
  }

  // Nothing below is free — every branch spends either the user's key, their
  // gateway, or the deployment's own key. A caller controls `prompt` and
  // `itemContext` completely, and neither had a ceiling: a six-figure-token
  // body billed straight through. Truncating rather than rejecting keeps the
  // honest oversized case (a very long chat reply) working.
  const clip = (text: string | undefined, max: number) =>
    text && text.length > max ? text.slice(0, max) : (text ?? '')

  const userTurn = [
    `Today is ${todayStr ?? new Date().toISOString().slice(0, 10)}.`,
    clip(itemContext, MAX_CONTEXT_CHARS),
    '',
    clip(prompt, MAX_PROMPT_CHARS).trim() ||
      (mode === 'breakdown'
        ? 'Break this into a few concrete steps.'
        : 'Suggest a realistic plan for today.'),
  ].join('\n')

  // The agent tier proposes through the user's OWN gateway. Falling through to
  // OpenAI here would quietly send an OpenClaw user's planner to a provider
  // they deliberately did not choose — not a degraded mode, a broken promise
  // about where their data goes. So this branch either works or fails; it never
  // reroutes.
  if (provider === 'openclaw') {
    // Inside a try: createServiceClient() throws outright when
    // SUPABASE_SECRET_KEY is unset, and an escaped rejection returns a 500 with
    // NO BODY — which the client then fails to parse, so the card shows a JSON
    // syntax error instead of a sentence. The same failure the gateway timeout
    // above exists to avoid.
    let config: Awaited<ReturnType<typeof getGatewayConfig>>
    try {
      config = await getGatewayConfig(userId)
    } catch {
      return NextResponse.json(
        { error: 'Could not read your gateway settings. Try again in a moment.' },
        { status: 500 }
      )
    }
    if (!config) {
      return NextResponse.json(
        { error: 'Connect your OpenClaw gateway in Settings → Beacon to ask it for a plan.' },
        { status: 400 }
      )
    }

    // A gateway is a machine on someone's tailnet, and this call is not
    // streamed — a hung one is a spinner with no output and no end. Without a
    // deadline the failure mode is a platform-level 504 with no body, which
    // reaches the card as a blank error; with one it is a sentence.
    const timeout = AbortSignal.timeout(PROPOSE_TIMEOUT_MS)

    try {
      const raw = await gatewayCompletion({
        config,
        sessionKey: proposeSessionKey(userId),
        signal: timeout,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userTurn },
        ],
      })

      const parsed = extractJsonObject(raw)
      if (!parsed) {
        return NextResponse.json({ proposal: null, message: 'No suggestion came back.' })
      }

      const result = ProposalDraftSchema.safeParse(parsed)
      if (!result.success || result.data.operations.length === 0) {
        return NextResponse.json({ proposal: null, message: 'Nothing worth changing right now.' })
      }

      return NextResponse.json({ proposal: result.data })
    } catch (err) {
      if (timeout.aborted) {
        return NextResponse.json(
          { error: 'Your gateway did not answer in time. Is it reachable from the internet?' },
          { status: 504 }
        )
      }
      const message = err instanceof Error ? err.message : 'Unknown error'
      return NextResponse.json({ error: message }, { status: 502 })
    }
  }

  const key = apiKey || process.env.OPENAI_API_KEY
  if (!key) {
    return NextResponse.json(
      { error: 'Add an OpenAI API key in Settings → Beacon to ask for a plan.' },
      { status: 400 }
    )
  }

  // Whose money is this? A user's own key buys them any model they name. The
  // deployment's key does not — `model` arrives verbatim from the request body,
  // and a session only proves SOME account, not the owner's.
  const onOwnKey = Boolean(apiKey)
  const resolvedModel = resolveModel(onOwnKey, model)

  // Same deadline the gateway branch takes, and for the same reason: the SDK
  // defaults to a TEN MINUTE timeout with retries, and a hung call here leaves
  // "Thinking it through…" on screen with no output and no end. maxDuration
  // only saves us on Vercel; this saves us everywhere.
  const openai = new OpenAI({ apiKey: key, timeout: PROPOSE_TIMEOUT_MS, maxRetries: 1 })

  try {
    const completion = await openai.chat.completions.create({
      model: resolvedModel,
      // json_object rather than a strict json_schema: the client drops
      // individual bad operations anyway, so tolerance beats brittleness here.
      response_format: { type: 'json_object' },
      ...(onOwnKey ? {} : { max_tokens: SERVER_KEY_MAX_OUTPUT_TOKENS }),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userTurn },
      ],
    })

    const raw = completion.choices[0]?.message?.content
    if (!raw) return NextResponse.json({ proposal: null, message: 'No suggestion came back.' })

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return NextResponse.json({ proposal: null, message: 'No suggestion came back.' })
    }

    const result = ProposalDraftSchema.safeParse(parsed)
    if (!result.success || result.data.operations.length === 0) {
      // An empty or malformed draft is a normal outcome ("nothing to suggest"),
      // not an error the user should have to read a stack trace about.
      return NextResponse.json({ proposal: null, message: 'Nothing worth changing right now.' })
    }

    return NextResponse.json({ proposal: result.data })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
