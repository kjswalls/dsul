import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-service'
import { inQueueOf } from '@/lib/agent-assignees'
import { NO_QUEUE, resolveAgentCaller } from '@/lib/agent-caller'

/**
 * GET /api/agent/events — a feed an agent HOLDS OPEN to hear that it has work,
 * so dsul never has to reach the agent's machine.
 *
 * An agent on a tailnet or behind NAT can always call dsul, and dsul can never
 * call it. So instead of dsul pushing a hand-off, the agent keeps this request
 * open (OpenClaw does it with a stream automation, `openclaw automations add
 * --stream-command`, which starts an agent run for each line it hears; see
 * app/docs/openclaw), and a line arrives the moment something lands in its
 * queue: a hand-off, an answer to its question, a Try again. Each of those
 * writes `aiStatus: 'queued'`, which stamps `ai_status_at` (lib/db.ts).
 *
 * The line is a hint and carries nothing: `data: work`. The agent then reads
 * its queue through MCP (`dsul_my_work`), the one place that decides what is
 * open today. So a hint that turns out to be nothing costs one quiet turn,
 * never a wrong action, and nothing about an item crosses this feed.
 *
 * Auth is the MCP server's (lib/agent-caller.ts): an agent key, an OAuth app's
 * token, or the OpenClaw plugin's key, each hearing only its OWN queue
 * (`inQueueOf`). A caller with no queue (an app whose name cannot be an
 * assignee) is refused rather than left listening to silence.
 *
 * Vercel ends a function at `maxDuration`, so the feed closes itself before
 * then and the agent reconnects; a work hint is never lost to that, because on
 * connect anything queued in the last RECENT_MS is announced once. An item the
 * agent leaves queued is announced again only when it is queued again, so the
 * feed does not start a run every reconnect for work the agent has passed on.
 *
 *   200 text/event-stream   `: dsul` then `data: work` lines and `: ping`s
 *   401 unauthorized        no bearer, or not a live token
 *   403 no_queue            the caller has no queue to hear
 *   503 unavailable         the token could not be checked
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** How long one connection lives: inside `maxDuration`, so the close is ours. */
export const HOLD_MS = 270_000
/** How often the queue is read. One small indexed query per connected agent. */
export const POLL_MS = 5_000
/** A comment line now and then, so no proxy between here and the agent idles the socket out. */
export const PING_MS = 25_000
/** On connect, work queued this recently is announced: it may have landed while the agent reconnected. */
export const RECENT_MS = 10 * 60_000
/** Reads that fail in a row before the feed closes and lets the agent reconnect. */
const MAX_FAILURES = 3
/** The most queued rows one read looks at. */
const READ_LIMIT = 200

/** One-off statuses that end the item: nothing left for an agent to do. */
const FINISHED = new Set(['completed', 'cancelled'])

type Row = { id: string; assignee: string | null; ai_status: string | null; ai_status_at: string | null; status: string | null }

/** The queued items in this caller's queue, as `id@stamp` so a re-queue reads as new. */
export async function readQueued(userId: string, who: string): Promise<Map<string, number> | null> {
  const { data, error } = await createServiceClient()
    .from('items')
    .select('id, assignee, ai_status, ai_status_at, status')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .not('assignee', 'is', null)
    .or('ai_status.is.null,ai_status.eq.queued')
    .limit(READ_LIMIT)
  if (error) return null
  const out = new Map<string, number>()
  for (const row of (data ?? []) as Row[]) {
    if (!inQueueOf(row.assignee, who)) continue
    if (row.status && FINISHED.has(row.status)) continue
    const at = row.ai_status_at ? Date.parse(row.ai_status_at) : 0
    out.set(`${row.id}@${row.ai_status_at ?? ''}`, Number.isFinite(at) ? at : 0)
  }
  return out
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

export async function GET(req: Request): Promise<Response> {
  const auth = req.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  let userId: string
  let who: string
  try {
    const caller = await resolveAgentCaller(auth.slice(7))
    if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    userId = caller.userId
    who = await caller.who()
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
  if (who === NO_QUEUE) return NextResponse.json({ error: 'no_queue' }, { status: 403 })

  const encoder = new TextEncoder()
  const stop = new AbortController()
  req.signal?.addEventListener('abort', () => stop.abort(), { once: true })

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          stop.abort()
        }
      }
      send(': dsul\n\n')
      const started = Date.now()
      let seen: Set<string> | null = null
      let failures = 0
      let lastPing = started
      while (!stop.signal.aborted && Date.now() - started < HOLD_MS) {
        const queued = await readQueued(userId, who)
        if (!queued) {
          if (++failures >= MAX_FAILURES) break
        } else {
          failures = 0
          const fresh = seen
            ? [...queued.keys()].some((k) => !seen!.has(k))
            : [...queued.values()].some((at) => started - at < RECENT_MS)
          if (fresh) send('data: work\n\n')
          seen = new Set(queued.keys())
        }
        if (Date.now() - lastPing >= PING_MS) {
          send(': ping\n\n')
          lastPing = Date.now()
        }
        await sleep(POLL_MS, stop.signal)
      }
      try {
        controller.close()
      } catch {
        // Already closed by the agent going away.
      }
    },
    cancel() {
      stop.abort()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
