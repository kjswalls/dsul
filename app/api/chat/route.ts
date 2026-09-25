import { NextRequest } from 'next/server'
import OpenAI from 'openai'
import { BEACON_SYSTEM_PROMPT } from '@/lib/beacon-system-prompt'
import { createClient } from '@/lib/supabase-server'
import {
  clipText,
  framedPlannerContext,
  MAX_CHAT_CONTEXT_CHARS,
  resolveModel,
  sanitizeChatMessages,
  SERVER_KEY_MAX_OUTPUT_TOKENS,
  serverKeySystemPrompt,
} from '@/lib/ai-limits'
import {
  chatSessionKey,
  getGatewayConfig,
  itemSessionKey,
  streamGatewayChat,
} from '@/lib/openclaw-gateway'

const COMING_SOON_MESSAGE =
  'This provider is coming soon! For now, add an OpenAI API key in Settings → Beacon.'

const MOCK_RESPONSE =
  "Hi! I'm your dsul AI assistant. (AI not configured — add your OpenAI API key in Settings → Beacon to enable me.)"

function streamText(text: string, encoder: TextEncoder) {
  return new ReadableStream({
    async start(controller) {
      for (const char of text) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: char })}\n\n`))
        await new Promise((r) => setTimeout(r, 18))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }

function streamChars(text: string, delayMs = 18): ReadableStream {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      for (const char of text) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: char })}\n\n`))
        await new Promise((r) => setTimeout(r, delayMs))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}

/**
 * Our own deadline, inside `maxDuration`, so a hung upstream ends in an error
 * frame rather than a platform-killed stream. The OpenAI SDK defaults to ten
 * minutes with retries.
 */
const CHAT_TIMEOUT_MS = 50_000
export const maxDuration = 60

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return new Response(streamChars('That request could not be read.', 0), { headers: SSE_HEADERS })
  }
  const { provider, model, systemPrompt, customInstructions, typeNouns, threadItemId } = body
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey : ''
  // Who pays decides what the caller controls. On the deployment's key (the
  // OpenAI branch with no key of the caller's own) every size is capped and the
  // prompt is built here; on the caller's own key or gateway only the roles are
  // narrowed. See lib/ai-limits.ts.
  const onServerKey = provider !== 'openclaw' && !apiKey
  const messages = sanitizeChatMessages(body.messages, onServerKey)
  const rawContext = typeof body.context === 'string' ? body.context : ''
  const context = onServerKey ? clipText(rawContext, MAX_CHAT_CONTEXT_CHARS) : rawContext
  const ownPrompt = typeof systemPrompt === 'string' ? systemPrompt : ''

  const encoder = new TextEncoder()

  // ── OpenClaw gateway ───────────────────────────────────────────────────────
  // Proxied here rather than called from the browser: the gateway token is full
  // operator access and stays server-side. Chunks are translated into dsul's
  // own frames, so the client parser is the same one the OpenAI path feeds.
  if (provider === 'openclaw') {
    try {
      const supabase = await createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        return new Response(streamChars('Sign in to use your OpenClaw gateway.'), {
          headers: SSE_HEADERS,
        })
      }

      const config = await getGatewayConfig(user.id)
      if (!config) {
        // Not an error: this account simply has not moved off the plugin chat
        // path yet, and the client only routes here when it believes a gateway
        // is configured.
        return new Response(
          streamChars('No OpenClaw gateway configured — add one in Settings → Beacon.'),
          { headers: SSE_HEADERS }
        )
      }

      // The user's own gateway: their prompt, their bill.
      const resolvedPrompt = ownPrompt || BEACON_SYSTEM_PROMPT
      const stream = await streamGatewayChat({
        config,
        // Derived from the authenticated user, never taken from the body. The
        // client names which THREAD it is (an item id, or nothing for the
        // global conversation); the key itself is built here, so a browser
        // cannot address another user's thread or a reserved gateway
        // namespace. Per-item threads get their own durable gateway session.
        sessionKey:
          typeof threadItemId === 'string' && threadItemId
            ? itemSessionKey(user.id, threadItemId)
            : chatSessionKey(user.id),
        messages: [
          { role: 'system', content: context ? `${resolvedPrompt}\n\n${context}` : resolvedPrompt },
          ...messages,
        ],
      })
      return new Response(stream, { headers: SSE_HEADERS })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      return new Response(streamChars(`Could not reach your gateway — ${msg}`, 0), {
        headers: SSE_HEADERS,
      })
    }
  }

  // ── Anthropic (coming soon) / none ─────────────────────────────────────────
  if (provider === 'anthropic') {
    return new Response(streamChars(COMING_SOON_MESSAGE), { headers: SSE_HEADERS })
  }

  if (provider === 'none' || (!apiKey && !process.env.OPENAI_API_KEY)) {
    return new Response(streamChars(MOCK_RESPONSE), { headers: SSE_HEADERS })
  }

  // ── No API key — stream a friendly mock response ───────────────────────────
  if (!process.env.OPENAI_API_KEY && !apiKey) {
    return new Response(streamChars(MOCK_RESPONSE), { headers: SSE_HEADERS })
  }

  // ── OpenAI provider ────────────────────────────────────────────────────────
  // A caller's OWN key is self-funded and needs no session. Falling back to the
  // deployment's key does: without this, anyone could POST here and spend the
  // owner's OpenAI budget. Pre-dates the gateway work; same hole, same fix.
  if (!apiKey && process.env.OPENAI_API_KEY) {
    try {
      const supabase = await createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        return new Response(streamChars('Sign in to use the assistant.'), { headers: SSE_HEADERS })
      }
    } catch {
      return new Response(streamChars('Sign in to use the assistant.'), { headers: SSE_HEADERS })
    }
  }

  // On the deployment's key the prompt is built HERE, never taken from the
  // body — otherwise any signed-in account holds a general-purpose proxy to the
  // owner's OpenAI account. Custom instructions are appended, not substituted.
  const onOwnKey = Boolean(apiKey)
  const openaiMessages = onOwnKey
    ? [
        {
          role: 'system',
          content: context
            ? `${ownPrompt || BEACON_SYSTEM_PROMPT}\n\n${context}`
            : ownPrompt || BEACON_SYSTEM_PROMPT,
        },
        ...messages,
      ]
    : [
        { role: 'system', content: serverKeySystemPrompt(typeNouns, customInstructions) },
        ...(context ? [{ role: 'system', content: framedPlannerContext(context) }] : []),
        ...messages,
      ]

  const openai = new OpenAI({
    apiKey: apiKey || process.env.OPENAI_API_KEY,
    timeout: CHAT_TIMEOUT_MS,
    maxRetries: 1,
  })

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const completion = await openai.chat.completions.create({
          model: resolveModel(onOwnKey, model),
          messages: openaiMessages as OpenAI.Chat.ChatCompletionMessageParam[],
          ...(onOwnKey ? {} : { max_tokens: SERVER_KEY_MAX_OUTPUT_TOKENS }),
          stream: true,
        })

        for await (const chunk of completion) {
          const content = chunk.choices[0]?.delta?.content ?? ''
          if (content) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`))
          }
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ content: `\n\n[Error: ${msg}]` })}\n\n`)
        )
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, { headers: SSE_HEADERS })
}
