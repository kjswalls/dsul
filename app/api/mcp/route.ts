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
import { POST as actOnItem } from '@/app/api/agent/items/[id]/act/route'
import { POST as createProject } from '@/app/api/agent/projects/route'
import { PATCH as patchProject, DELETE as deleteProject } from '@/app/api/agent/projects/[id]/route'
import { createServiceClient, resolveUserIdFromApiKey } from '@/lib/supabase-service'
import { dispatch, type ToolResult } from '@/lib/mcp/protocol'
import { READ_TOOL_DESCRIPTORS, READ_TOOL_NAMES, TOOL_DESCRIPTORS, toolByName, type ToolPlan } from '@/lib/mcp/tools'
import { ACCESS_PREFIX, originOf, wwwAuthenticate } from '@/lib/mcp-oauth/core'
import { resolveAccessToken } from '@/lib/mcp-oauth/store'
import type { Scope } from '@/lib/mcp-oauth/scopes'

/**
 * POST /api/mcp — dsul's planner as a remote MCP server.
 *
 * One endpoint, JSON-RPC 2.0 in the body, which is MCP's Streamable HTTP
 * transport minus the optional SSE half (nothing here streams, and a tools-only
 * server has nothing to push). Any MCP-capable runtime — OpenClaw via
 * `mcp.servers.<name>` with `type: "http"`, or Claude, Cursor, ChatGPT — can
 * therefore act on the planner with no per-vendor plugin.
 *
 * Auth is either of two bearers. The OpenClaw agent key, the same one the agent
 * API takes: one per user, plaintext, unscoped, no expiry, full read+write, and
 * held only by the user's own gateway. Or an OAuth access token an app got by
 * signing in (migration 069, lib/mcp-oauth/, memory/plans/mcp-oauth.md): hashed,
 * expiring, revocable from Settings, and scoped, so a read-only app is shown and
 * allowed only the tools that read. A request with neither gets a 401 whose
 * WWW-Authenticate header starts the client's sign-in.
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
  projects: { create: createProject as Handler, item: { PATCH: patchProject, DELETE: deleteProject } },
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

  // /api/agent/items/:id/{events,ask,progress,act} — the delegation verbs and
  // the one-day verbs, each with its own handler rather than a CRUD set: they
  // carry preconditions that must not be bolted onto every agent write.
  const ITEM_VERBS: Record<string, (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>> = {
    events: getItemEvents,
    ask: askUser,
    progress: reportProgress,
    act: actOnItem,
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

/** Who is calling: the OpenClaw key (everything), or an OAuth app at its scope. */
type McpCaller = { userId: string; scope: Scope }

async function resolveCaller(token: string): Promise<McpCaller | null> {
  const service = createServiceClient()
  if (token.startsWith(ACCESS_PREFIX)) {
    const caller = await resolveAccessToken(service, token)
    return caller ? { userId: caller.userId, scope: caller.scope } : null
  }
  const userId = await resolveUserIdFromApiKey(token, service)
  return userId ? { userId, scope: 'planner' } : null
}

/**
 * A 401 that starts an MCP client's sign-in: the header names this server's
 * protected-resource metadata, which names the authorization server
 * (lib/mcp-oauth/core.ts, memory/plans/mcp-oauth.md).
 */
function unauthorized(req: NextRequest, message: string, error?: 'invalid_token') {
  return NextResponse.json(
    { jsonrpc: '2.0', id: null, error: { code: -32600, message } },
    { status: 401, headers: { 'WWW-Authenticate': wwwAuthenticate(originOf(req), error) } }
  )
}

export async function POST(req: NextRequest) {
  // The key is RESOLVED here, not merely prefix-checked. A `startsWith('Bearer ')`
  // test costs nothing to satisfy, so it would let an anonymous caller reach the
  // batch loop and spend a database round-trip per element before the first
  // handler said 401. The agent handlers still authenticate independently — this
  // is the outer gate, not a replacement for theirs.
  const auth = req.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return unauthorized(req, 'Missing bearer token')
  let caller: McpCaller | null
  try {
    caller = await resolveCaller(auth.slice(7))
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Auth unavailable' } },
      { status: 503 }
    )
  }
  if (!caller) return unauthorized(req, 'Unauthorized', 'invalid_token')
  // A read-only app sees only the tools that read, and is refused the rest even
  // by name; the agent handlers refuse its token on every write besides.
  const readOnly = caller.scope === 'planner:read'

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
      tools: readOnly ? READ_TOOL_DESCRIPTORS : TOOL_DESCRIPTORS,
      serverInfo: { name: 'dsul', version: '1' },
      callTool: async (name, args) => {
        const tool = readOnly && !READ_TOOL_NAMES.has(name) ? undefined : toolByName(name)
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
