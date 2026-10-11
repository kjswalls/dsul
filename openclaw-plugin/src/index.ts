import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PluginConfig } from './plugin-types.js'
import { registerWithDsul, registerChatUrl, deregisterFromDsul } from './webhook.js'
import { handleChatRequest } from './chat.js'
import { handleWebhookRequest } from './wake.js'
import { runSetup } from './setup.js'

export default definePluginEntry({
  id: 'dsul-context',
  name: 'dsul Context',
  // Two jobs only this in-process plugin can do: chat from dsul's Ask, and the
  // hand-off wake. Every planner tool is dsul's MCP server (`openclaw mcp add`).
  description: 'Chat from dsul\'s Ask, and a wake that starts your agent the moment you hand it a dsul item',

  register(api) {
    // ── Setup CLI: openclaw dsul-context setup ──────────────────────────────
    api.registerCli(({ program }) => {
      program
        .command('dsul-context')
        .description('dsul Context plugin management')
        .addCommand(
          program
            .createCommand('setup')
            .description('Interactive setup — connect OpenClaw to your dsul account')
            .action(() => runSetup())
        )
    }, { commands: ['dsul-context'] })

    const cfg = (api.pluginConfig as Record<string, unknown>)?.['dsul-context'] as PluginConfig | undefined
    if (!cfg?.dsulUrl || !cfg?.apiKey) {
      api.logger.warn(
        'dsul-context: not configured. Run `openclaw dsul-context setup` to connect your dsul account.'
      )
      return
    }

    // ── Register the wake and the chat URL on startup ───────────────────────
    const gatewayPublicUrl = cfg.publicUrl?.replace(/\/$/, '')
    if (gatewayPublicUrl) {
      void (async () => {
        await registerWithDsul(cfg, `${gatewayPublicUrl}/plugins/dsul/webhook`, api.logger)
        const agentId = cfg.agentId?.trim() || cfg.id?.trim() || 'main'
        await registerChatUrl(cfg, `${gatewayPublicUrl}/plugins/dsul/chat`, agentId, api.logger)
      })().catch((err: Error) => {
        api.logger.warn(`dsul-context: registration with dsul failed — ${err.message}`)
      })
    } else {
      api.logger.warn(
        'dsul-context: publicUrl not set in plugin config — the hand-off wake and chat from Ask are off. ' +
        'Add publicUrl to your dsul-context plugin config in openclaw.json.'
      )
    }

    // ── Deregister on shutdown ────────────────────────────────────────────────
    api.registerService({
      id: 'dsul-context-lifecycle',
      start: async () => { /* nothing to start */ },
      stop: async () => {
        await deregisterFromDsul(cfg, api.logger)
      },
    })

    // ── Webhook listener: dsul → the hand-off wake ──────────────────────────
    // OpenClaw uses Node's IncomingMessage/ServerResponse, not the Web Fetch API.
    // Starts a run only for a SIGNED items.handedOff (wake.ts); every other
    // event is a 200 no-op.
    api.registerHttpRoute({
      path: '/plugins/dsul/webhook',
      auth: 'plugin',
      async handler(req: IncomingMessage, res: ServerResponse) {
        await handleWebhookRequest(req, res, cfg, api.runtime, api.logger)
      },
    })

    // ── Chat endpoint: browser → plugin (blocking JSON) ──────────────────────
    api.registerHttpRoute({
      path: '/plugins/dsul/chat',
      auth: 'plugin',
      async handler(req: IncomingMessage, res: ServerResponse) {
        await handleChatRequest(req, res, cfg, api.runtime, api.logger)
      },
    })

  },
})
