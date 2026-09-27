import { NextRequest, NextResponse } from 'next/server'
import {
  makeAgentCreateHandler,
  makeAgentItemHandlers,
  makeContainerCreateHandler,
  makeContainerItemHandlers,
  makeGoalCreateHandler,
  makeGoalItemHandlers,
} from '@/lib/agent-api'
import { GET as getContext } from '@/app/api/agent/context/route'
import { GET as getItemEvents } from '@/app/api/agent/items/[id]/events/route'
import { POST as askUser } from '@/app/api/agent/items/[id]/ask/route'
import { POST as reportProgress } from '@/app/api/agent/items/[id]/progress/route'
import { createServiceClient, resolveUserIdFromApiKey } from '@/lib/supabase-service'
import { dispatch, type ToolResult } from '@/lib/mcp/protocol'
import { TOOL_DESCRIPTORS, toolByName, type ToolPlan } from '@/lib/mcp/tools'

/**
 * POST /api/mcp — dsul's planner as a remote MCP server.
 *
 * One endpoint, JSON-RPC 2.0 in the body, which is MCP's Streamable HTTP
 * transport minus the optional SSE half (nothing here streams, and a tools-only
 * server has nothing to push). Any MCP-capable runtime — OpenClaw via
 * `mcp.servers.<name>` with `type: "http"`, or Claude, Cursor, ChatGPT — can
 * therefore act on the planner with no per-vendor plugin.
 *
 * Auth is the SAME bearer key the agent API already takes, deliberately: this
 * is a second protocol over one surface, not a second surface. That also means
 * it inherits that key's properties, and they are worth naming — one key per
 * user, plaintext, unscoped, no expiry, full read+write. Acceptable while the
 * only holder is the user's own gateway; it is the thing to fix before handing
 * the key to a third-party runtime, and it is why this route does not widen
 * what a key can reach.
 *
 * Tool calls are executed IN-PROCESS against the same handler factories the
 * /api/agent routes are built from — not by re-implementing their rules and not
 * by dsul calling itself over HTTP. Every validation, refinement and error
 * string stays in lib/agent-api.ts, so the two protocols can never disagree.
 */

// Built once. These are the exact handlers the /api/agent/* routes export.
const taskItem = makeAgentItemHandlers('task')
const habitItem = makeAgentItemHandlers('habit')
const routineItem = makeContainerItemHandlers('routine')
const seasonItem = makeContainerItemHandlers('season')
const goalItem = makeGoalItemHandlers()

type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>

const COLLECTION: Record<string, { create: Handler; item: { PATCH: Handler; DELETE: Handler } }> = {
  tasks: { create: makeAgentCreateHandler('task') as Handler, item: taskItem as never },
  habits: { create: makeAgentCreateHandler('habit') as Handler, item: habitItem as never },
  routines: { create: makeContainerCreateHandler('routine') as Handler, item: routineItem as never },
  seasons: { create: makeContainerCreateHandler('season') as Handler, item: seasonItem as never },
  goals: { create: makeGoalCreateHandler() as Handler, item: goalItem as never },
}

/** Rebuilds a request for the in-process handler, carrying auth through. */
function proxyRequest(original: NextRequest, plan: ToolPlan): NextRequest {
  const url = new URL(plan.path, original.nextUrl.origin)
  const headers = new Headers()
  const auth = original.headers.get('authorization')
  if (auth) headers.set('authorization', auth)
  const timezone = original.headers.get('x-timezone')
  if (timezone) headers.set('x-timezone', timezone)
  if (plan.body !== undefined) headers.set('content-type', 'application/json')

  return new NextRequest(url, {
    method: plan.method,
    headers,
    ...(plan.body !== undefined ? { body: JSON.stringify(plan.body) } : {}),
  })
}

async function runPlan(original: NextRequest, plan: ToolPlan): Promise<Response> {
  const segments = plan.path.replace(/^\/api\/agent\/?/, '').split('/').filter(Boolean)
  const [collection, id] = segments

  if (collection === 'context') return getContext(proxyRequest(original, plan))

  // /api/agent/items/:id/{events,ask,progress} — the delegation verbs, each
  // with its own handler rather than a CRUD set: they carry preconditions and
  // an assignee check that must not be bolted onto every agent write.
  const ITEM_VERBS: Record<string, (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>> = {
    events: getItemEvents,
    ask: askUser,
    progress: reportProgress,
  }
  if (collection === 'items' && segments[2] && ITEM_VERBS[segments[2]]) {
    if (!id || id.includes('/') || id.includes('..') || id.includes('%')) {
      return NextResponse.json({ error: 'id must be a single path segment' }, { status: 400 })
    }
    return ITEM_VERBS[segments[2]](proxyRequest(original, plan), {
      params: Promise.resolve({ id }),
    })
  }

  const entry = COLLECTION[collection]
  if (!entry) return NextResponse.json({ error: `Unroutable path: ${plan.path}` }, { status: 400 })

  // An id is one path segment and nothing else. Dispatch reads the RAW path
  // while proxyRequest hands the handler a normalised URL, so a traversal in an
  // id would make those two disagree about what is being addressed — harmless
  // today (handlers read ctx.params, not the URL) and exactly the kind of
  // disagreement that stops being harmless later.
  if (id !== undefined && (id.includes('/') || id.includes('..') || id.includes('%'))) {
    return NextResponse.json({ error: 'id must be a single path segment' }, { status: 400 })
  }
  if (segments.length > 2) {
    return NextResponse.json({ error: `Unroutable path: ${plan.path}` }, { status: 400 })
  }


  const req = proxyRequest(original, plan)
  if (!id) {
    if (plan.method !== 'POST') {
      return NextResponse.json({ error: `${plan.method} needs an id` }, { status: 400 })
    }
    return entry.create(req, { params: Promise.resolve({ id: '' }) })
  }

  const ctx = { params: Promise.resolve({ id }) }
  if (plan.method === 'PATCH') return entry.item.PATCH(req, ctx)
  if (plan.method === 'DELETE') return entry.item.DELETE(req, ctx)
  return NextResponse.json({ error: `Unsupported method ${plan.method}` }, { status: 400 })
}

/** Response body → the text a model reads back. */
async function toToolResult(
  res: Response,
  transform?: (body: unknown) => unknown
): Promise<ToolResult> {
  const text = await res.text()
  if (res.ok) {
    if (transform) {
      try {
        const narrowed = JSON.stringify(transform(JSON.parse(text)))
        // JSON.stringify returns undefined for a function or a bare undefined;
        // a content block with no text is not a valid tool result.
        if (typeof narrowed === 'string') {
          return { content: [{ type: 'text', text: narrowed }] }
        }
      } catch {
        /* fall through to the error below */
      }
      // Deliberately NOT falling back to the raw body. A tool that narrows does
      // so because the raw answer is the entire planner, and quietly handing
      // that over on failure is the precise outcome the narrowing exists to
      // prevent — a silent, enormous, unasked-for context dump.
      return {
        content: [{ type: 'text', text: 'Could not summarise the response. Try dsul_get_context.' }],
        isError: true,
      }
    }
    return { content: [{ type: 'text', text: text || '{"success":true}' }] }
  }
  // Failures come back as tool errors, not protocol errors: agent-api writes
  // its 400s for a model to read (field-level details, and long instructional
  // strings on the goal-role predicates), and a JSON-RPC error would deny the
  // model the chance to correct itself.
  return {
    content: [{ type: 'text', text: `dsul returned ${res.status}: ${text}` }],
    isError: true,
  }
}

/**
 * The most work one request may ask for.
 *
 * A JSON-RPC batch is an array of any length and every element here becomes at
 * least one database round-trip. Without a cap, a single request is an
 * amplifier — and the cap matters more than it looks because the batch is
 * expanded before any tool runs.
 */
const MAX_BATCH = 32

export async function POST(req: NextRequest) {
  // The key is RESOLVED here, not merely prefix-checked. A `startsWith('Bearer ')`
  // test costs nothing to satisfy, so it would let an anonymous caller reach the
  // batch loop and spend a database round-trip per element before the first
  // handler said 401. The agent handlers still authenticate independently — this
  // is the outer gate, not a replacement for theirs.
  const auth = req.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Missing bearer token' } },
      { status: 401 }
    )
  }
  try {
    const userId = await resolveUserIdFromApiKey(auth.slice(7), createServiceClient())
    if (!userId) {
      return NextResponse.json(
        { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Unauthorized' } },
        { status: 401 }
      )
    }
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Auth unavailable' } },
      { status: 503 }
    )
  }

  let message: unknown
  try {
    message = await req.json()
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400 }
    )
  }

  // A batch is a JSON array. Notifications inside it produce no response, and a
  // batch of only notifications produces no body at all.
  const batch = Array.isArray(message)
  const messages: unknown[] = batch ? (message as unknown[]) : [message]

  // JSON-RPC 2.0 §6: an empty batch is an Invalid Request, not an empty result.
  if (batch && messages.length === 0) {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Empty batch' } },
      { status: 400 }
    )
  }
  if (messages.length > MAX_BATCH) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: `Batch too large: ${messages.length} > ${MAX_BATCH}` },
      },
      { status: 400 }
    )
  }

  const responses: unknown[] = []
  for (const one of messages) {
    const response = await dispatch(one, {
      tools: TOOL_DESCRIPTORS,
      serverInfo: { name: 'dsul', version: '1' },
      callTool: async (name, args) => {
        const tool = toolByName(name)
        if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
        const plan = tool.plan(args)
        if ('error' in plan) {
          return { content: [{ type: 'text', text: plan.error }], isError: true }
        }
        return toToolResult(await runPlan(req, plan), plan.transform)
      },
    })
    if (response) responses.push(response)
  }

  if (responses.length === 0) {
    // Every message was a notification. The spec wants an empty 202, not null.
    return new NextResponse(null, { status: 202 })
  }
  return NextResponse.json(batch ? responses : responses[0])
}

/**
 * Streamable HTTP uses GET to open a server->client SSE stream. This server has
 * nothing to push, and the spec says a server that will not provide that stream
 * MUST answer 405 — a friendly 200 makes a conformant client sit waiting for
 * events that will never arrive.
 */
export async function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } })
}
