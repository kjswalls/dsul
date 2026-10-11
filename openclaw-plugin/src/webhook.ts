import type { IncomingMessage } from 'node:http'
import type { PluginConfig } from './plugin-types.js'

/** The one event this plugin registers for: the wake (wake.ts). */
export const HANDOFF_EVENT = 'items.handedOff'

export async function registerWithDsul(
  cfg: PluginConfig,
  webhookUrl: string,
  logger: { info: (s: string) => void; warn: (s: string) => void }
): Promise<void> {
  // The wake refuses anything unsigned (wake.ts), so registering without a
  // secret would only have dsul send requests this plugin turns away.
  const secret = cfg.webhookSecret?.trim()
  if (!secret) {
    logger.warn(
      'dsul-context: webhookSecret not set — the hand-off wake is off. Run `openclaw dsul-context setup` ' +
      'again (it adds one), or set webhookSecret in your dsul-context plugin config in openclaw.json.'
    )
    // An older build's registration would otherwise keep dsul POSTing change
    // events here that nothing reads.
    await deregisterFromDsul(cfg, logger)
    return
  }
  const res = await fetch(`${cfg.dsulUrl}/api/agent/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      pluginId: 'dsul-context',
      webhookUrl,
      secret,
      // Only the wake. Nothing is cached any more, so the change events this
      // used to list would only cost dsul a POST each. `notifyPlugins` sends a
      // registration nothing it did not list.
      events: [HANDOFF_EVENT],
    }),
  })
  if (res.ok) {
    logger.info(`dsul-context: hand-off wake registered → ${webhookUrl}`)
  } else {
    logger.warn(`dsul-context: webhook registration failed (${res.status}) — hand-offs wait for the agent's next poll`)
  }
}

export async function registerChatUrl(
  cfg: PluginConfig,
  chatUrl: string,
  agentId: string,
  logger: { info: (s: string) => void; warn: (s: string) => void }
): Promise<void> {
  try {
    const res = await fetch(`${cfg.dsulUrl}/api/agent/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        pluginId: 'dsul-context',
        chatUrl,
        agentId,
      }),
    })
    if (res.ok) {
      logger.info(`dsul-context: chat URL registered → ${chatUrl}`)
    } else {
      logger.warn(`dsul-context: chat URL registration failed (${res.status})`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    logger.warn(`dsul-context: chat URL registration error — ${msg}`)
  }
}

export async function deregisterFromDsul(
  cfg: PluginConfig,
  logger: { warn: (s: string) => void }
): Promise<void> {
  await fetch(`${cfg.dsulUrl}/api/agent/register`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ pluginId: 'dsul-context' }),
  }).catch((err: Error) => logger.warn(`dsul-context: deregister failed — ${err.message}`))
}

/** Read full body from a Node IncomingMessage */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
