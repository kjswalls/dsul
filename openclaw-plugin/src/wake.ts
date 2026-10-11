import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PluginRuntime } from 'openclaw/plugin-sdk'
import type { PluginConfig } from './plugin-types.js'
import { HANDOFF_EVENT, readBody } from './webhook.js'

/**
 * The wake: dsul tells this plugin an item was just handed to the agent, and
 * the plugin starts a run that does it.
 *
 * dsul sends `items.handedOff` from POST /api/agent/handoff-wake once a
 * hand-off has landed. The run gets a short brief and uses dsul's MCP tools
 * (the dsul server added with `openclaw mcp add`), never tools of this plugin:
 * MCP is the one tool surface. The wake only saves waiting for the next poll,
 * so anything that goes wrong here is logged and dropped.
 *
 * SIGNED OR NOTHING. A run spends the user's model budget, so it starts only
 * when `webhookSecret` is set AND the request's X-Dsul-Signature verifies. An
 * unsigned request is refused even when the rest of the config is fine.
 */

export { HANDOFF_EVENT }

export interface HandoffWake {
  itemId: string
  title: string
  type: string
  /** The event's own timestamp: a redelivery of the same event is the same run. */
  timestamp: string
}

type Logger = { info: (s: string) => void; warn: (s: string) => void; error: (s: string) => void }

/** Constant-time check of `X-Dsul-Signature: sha256=<hex>` against the body. */
export function verifySignature(secret: string, body: string, sigHeader: string): boolean {
  if (!secret || !sigHeader) return false
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)
  const given = Buffer.from(sigHeader)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** The event name, or null for a body that is not a dsul event at all. */
export function eventNameOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { event?: unknown }
    return typeof parsed?.event === 'string' ? parsed.event : null
  } catch {
    return null
  }
}

/** A hand-off event's item, or null when it is not one or is malformed. */
export function parseHandoff(body: string): HandoffWake | null {
  try {
    const parsed = JSON.parse(body) as { event?: unknown; data?: unknown; timestamp?: unknown }
    if (parsed?.event !== HANDOFF_EVENT) return null
    const data = parsed.data as { itemId?: unknown; title?: unknown; type?: unknown } | null
    if (!data || typeof data.itemId !== 'string' || !/^[0-9a-f-]{36}$/i.test(data.itemId)) return null
    return {
      itemId: data.itemId,
      title: typeof data.title === 'string' ? data.title : '',
      type: typeof data.type === 'string' ? data.type : 'task',
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
    }
  } catch {
    return null
  }
}

/** One OpenClaw session per handed-off item. */
export function handoffSessionKey(itemId: string): string {
  return `dsul:handoff:${itemId}`
}

/** What the run is told. The item's title is the user's words, so it is quoted, not obeyed. */
export function handoffMessage(wake: HandoffWake): string {
  const title = JSON.stringify(wake.title.slice(0, 200))
  return [
    `The user just handed you a dsul ${wake.type || 'task'}: ${title} (id ${wake.itemId}).`,
    'Use your dsul MCP tools. Call dsul_my_work to see the item, then follow its loop: mark it ' +
      "working with dsul_report_progress, do the work, and report the outcome with dsul_report_progress " +
      "(status 'done', or 'failed' with why).",
    'If you are blocked on something only the user can answer, ask with dsul_ask_user and stop.',
    'If dsul_my_work does not list this item, it was taken back or already picked up: do nothing.',
  ].join('\n')
}

/**
 * The webhook route: dsul → plugin.
 *
 * 401 for a bad or missing signature (and for a hand-off while no secret is
 * set); 200 for every other event, which is a no-op now that nothing is cached.
 * A hand-off answers 202 as soon as the run is admitted; the run is never awaited.
 */
export async function handleWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: PluginConfig,
  runtime: Pick<PluginRuntime, 'subagent'>,
  logger: Logger
): Promise<void> {
  const reply = (status: number, text: string) => {
    if (res.headersSent) return
    res.writeHead(status)
    res.end(text)
  }

  let body: string
  try {
    body = await readBody(req)
  } catch {
    reply(400, 'Bad request')
    return
  }
  const eventName = eventNameOf(body)

  if (!cfg.webhookSecret) {
    if (eventName === HANDOFF_EVENT) {
      logger.warn('dsul-context: refused a hand-off wake — webhookSecret is not set, so it cannot be verified')
      reply(401, 'Unauthorized')
      return
    }
    reply(200, 'ok')
    return
  }

  const sig = (req.headers['x-dsul-signature'] as string | undefined) ?? ''
  if (!verifySignature(cfg.webhookSecret, body, sig)) {
    reply(401, 'Unauthorized')
    return
  }

  if (eventName !== HANDOFF_EVENT) {
    reply(200, 'ok')
    return
  }

  const wake = parseHandoff(body)
  if (!wake) {
    reply(400, 'Bad request')
    return
  }

  const sessionKey = handoffSessionKey(wake.itemId)
  try {
    const { runId } = await runtime.subagent.run({
      sessionKey,
      message: handoffMessage(wake),
      idempotencyKey: `dsul-handoff-${wake.itemId}-${wake.timestamp || Date.now()}`,
    })
    logger.info(`dsul-context: hand-off wake — run ${runId}, session ${sessionKey}`)
    reply(202, 'started')
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    logger.warn(`dsul-context: hand-off wake failed to start — ${msg}`)
    // Not dsul's problem to retry: the agent finds the item on its next poll.
    reply(200, 'not started')
  }
}
