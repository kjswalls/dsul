import { createHmac } from 'node:crypto'

/**
 * The credential the browser sends to the OpenClaw plugin's chat endpoint.
 *
 * The plugin path is the one place the browser calls the user's OpenClaw
 * directly (a plugin on a tailnet is reachable from the user's browser and not
 * from Vercel), so the browser has to hold SOMETHING. It used to be the agent
 * key itself (#123, #142): full read+write on /api/agent/* and /api/mcp, from
 * anywhere. This is an HMAC of that key instead, which the plugin derives the
 * same way and accepts on its chat route only. dsul's agent API never accepts
 * it, and it does not lead back to the key.
 *
 * MUST stay byte-identical to openclaw-plugin/src/chat-token.ts (a unit test
 * compares the two). Changing the label is a coordinated plugin release.
 */
export const PLUGIN_CHAT_TOKEN_LABEL = 'dsul-plugin-chat-v1'

export function pluginChatToken(apiKey: string): string {
  return 'dsulchat_' + createHmac('sha256', apiKey).update(PLUGIN_CHAT_TOKEN_LABEL).digest('hex')
}
