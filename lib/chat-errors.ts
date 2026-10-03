import type { ChatErrorCode } from './ai-types';
import type { Answerer } from './conversation-types';

/**
 * A failed reply's code, in our words. The one copy.
 *
 * Client-safe (tests/unit/ai-server-boundary.test.ts). A saved conversation
 * stores a failed reply as `status: 'error'` plus a short `errorCode`, never as
 * words (migration 057's CHECK), so the transcript asks this module what to
 * say at render time, and a model never sees the text again: it is not in the
 * reply's content to be re-sent.
 *
 * The provider half is also what the server answers with:
 * lib/ai-server/errors.ts builds `USER_MESSAGES` from `MODEL_ERROR_COPY`, so a
 * rewording here reaches both the route's JSON and a saved reply's note.
 */

/** Codes only the browser can produce: the plugin path never reaches dsul's server. */
export type ClientChatErrorCode =
  | 'plugin_setup'
  | 'plugin_unreachable'
  | 'plugin_error'
  | 'no_response'
  | 'client';

/** Every code a saved reply can carry. Each matches ERROR_CODE_RE (lib/conversation-types.ts). */
export type ReplyErrorCode = ChatErrorCode | ClientChatErrorCode;

/** The provider kinds a chat or propose call can fail with, as the routes name them. */
export type ModelErrorCode = Extract<
  ChatErrorCode,
  | 'auth'
  | 'forbidden'
  | 'quota'
  | 'rate_limit'
  | 'bad_model'
  | 'bad_request'
  | 'upstream'
  | 'timeout'
  | 'network'
  | 'blocked_url'
  | 'empty'
  | 'refused'
>;

/**
 * A provider's failure. No em dashes. Each line names a next step, and one that
 * needs a field says it is in Settings: the chat surface has no key, model or
 * address field of its own.
 */
export const MODEL_ERROR_COPY: Readonly<Record<ModelErrorCode, string>> = Object.freeze({
  auth: 'Your AI key stopped working. Reconnect it in Settings.',
  forbidden: "Your provider refused this request. Check your account's access to this model.",
  quota: 'Your provider account is out of credit or over its limit. Check your plan with your provider.',
  rate_limit: 'Your provider is limiting requests right now. Try again in a minute.',
  bad_model: "That model isn't available to your key. Pick another in Settings.",
  bad_request: "Your provider couldn't process this request. Try a shorter message, or pick another model in Settings.",
  upstream: 'Your provider is having trouble right now. Try again in a moment.',
  timeout: 'Your provider took too long to answer. Try again.',
  network: "Couldn't reach your provider. Try again, or check the connection in Settings.",
  blocked_url: "Your provider's address isn't allowed. Change the base URL in Settings to a public https address.",
  empty:
    "The model ran out of room before it answered. Try a shorter message, or pick a model that doesn't reason first.",
  refused: 'The model declined to answer that. Try rephrasing it.',
});

/**
 * What /api/chat says itself, before any provider is asked (app/api/chat/route.ts).
 * `not_connected`, the gateway's `upstream` and `forbidden` depend on who was
 * asked, so they live in `chatErrorCopy` below.
 */
export const ROUTE_ERROR_COPY = Object.freeze({
  unauthorized: 'Your session ended. Sign in again.',
  forbidden: "That request wasn't allowed.",
  invalid: "That request couldn't be read.",
  too_large: 'That message is too long to send.',
  notConnectedModel: 'Connect a model in Settings to chat.',
  notConnectedGateway: 'Connect your OpenClaw gateway in Settings to chat.',
  gatewayUnreachable: "Couldn't reach your OpenClaw gateway.",
});

export const CLIENT_ERROR_COPY: Readonly<Record<ClientChatErrorCode, string>> = Object.freeze({
  plugin_setup:
    "OpenClaw isn't reachable yet. Run `openclaw dsul-context setup` and set publicUrl in openclaw.json.",
  plugin_unreachable: "Couldn't reach OpenClaw. Check that it is running.",
  plugin_error: "OpenClaw couldn't answer that. Try again.",
  no_response: 'No response received.',
  client: 'Something went wrong. Try again.',
});

const CHAT_CODES: ReadonlySet<string> = new Set<ChatErrorCode>([
  'auth',
  'forbidden',
  'quota',
  'rate_limit',
  'bad_model',
  'bad_request',
  'upstream',
  'timeout',
  'network',
  'blocked_url',
  'empty',
  'refused',
  'not_connected',
  'unauthorized',
  'invalid',
  'too_large',
  'server',
]);

export function isChatErrorCode(v: unknown): v is ChatErrorCode {
  return typeof v === 'string' && CHAT_CODES.has(v);
}

export function isReplyErrorCode(v: unknown): v is ReplyErrorCode {
  return isChatErrorCode(v) || (typeof v === 'string' && Object.hasOwn(CLIENT_ERROR_COPY, v));
}

/**
 * A code as a saved reply may carry it: a known code passes, and anything else
 * (missing, a non-JSON platform error, a code this build has never heard of)
 * becomes `'client'`, before it can reach a save or a CHECK.
 */
export function replyErrorCode(v: unknown): ReplyErrorCode {
  return isReplyErrorCode(v) ? v : 'client';
}

/** The words for a failed reply, by its code and who was asked. Never empty. */
export function chatErrorCopy(code: string | null | undefined, answerer: Answerer | null): string {
  const c = replyErrorCode(code);
  switch (c) {
    case 'not_connected':
      return answerer === 'openclaw' ? ROUTE_ERROR_COPY.notConnectedGateway : ROUTE_ERROR_COPY.notConnectedModel;
    case 'upstream':
      return answerer === 'openclaw' ? ROUTE_ERROR_COPY.gatewayUnreachable : MODEL_ERROR_COPY.upstream;
    // One code, two speakers: on the model path it is almost always the
    // provider's 403; OpenClaw has no provider, so there it can only be the
    // route's own origin check.
    case 'forbidden':
      return answerer === 'openclaw' ? ROUTE_ERROR_COPY.forbidden : MODEL_ERROR_COPY.forbidden;
    // The route answers a failed connection read with the provider's
    // "having trouble" line; a reply saved with it reads the same.
    case 'server':
      return MODEL_ERROR_COPY.upstream;
    case 'unauthorized':
    case 'invalid':
    case 'too_large':
      return ROUTE_ERROR_COPY[c];
    default:
      return Object.hasOwn(CLIENT_ERROR_COPY, c)
        ? CLIENT_ERROR_COPY[c as ClientChatErrorCode]
        : MODEL_ERROR_COPY[c as ModelErrorCode];
  }
}
