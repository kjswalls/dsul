import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The chat endpoint's credential: an HMAC of the dsul API key, never the key.
 *
 * dsul's server derives the same value (lib/plugin-chat-token.ts in the dsul
 * repo) and hands only that to the browser, so a script on the dsul page can
 * talk to this chat route and nothing else. The API key itself stays in this
 * plugin's config and dsul's server.
 *
 * MUST stay byte-identical to dsul's lib/plugin-chat-token.ts.
 */
export const PLUGIN_CHAT_TOKEN_LABEL = "dsul-plugin-chat-v1";

export function pluginChatToken(apiKey: string): string {
  return "dsulchat_" + createHmac("sha256", apiKey).update(PLUGIN_CHAT_TOKEN_LABEL).digest("hex");
}

/** Constant-time check of a presented bearer against the derived token. */
export function isValidChatToken(presented: string, apiKey: string): boolean {
  if (!presented || !apiKey) return false;
  const expected = Buffer.from(pluginChatToken(apiKey));
  const given = Buffer.from(presented);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
