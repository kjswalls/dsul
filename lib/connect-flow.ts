/**
 * How an OpenRouter sign-in ended, as `/api/ai/openrouter/callback` reports it
 * back through `?connect=`, and the words for each.
 *
 * Client-safe and pure (tests/unit/ai-server-boundary.test.ts). The callback
 * lands on Settings → AI or on home (the PKCE cookie's `r`, lib/ai-types.ts);
 * the pane reads the value itself, and home hands it to the store through
 * lib/connect-return.ts. Either way the value is checked against this table's
 * own keys before anything shows it.
 */

export const CONNECT_FLOWS = [
  'ok',
  'denied',
  'expired',
  'failed',
  'busy',
  'unavailable',
  'saved',
  'no_credit',
  'daily_limit',
] as const;
export type ConnectFlow = (typeof CONNECT_FLOWS)[number];
/** A sign-in that did not end with a working connection, or ended with one that cannot answer yet. */
export type FlowResult = Exclude<ConnectFlow, 'ok'>;

export const UNAVAILABLE_COPY = 'Connecting a model isn’t available on this server yet.';

export const FLOW_COPY: Readonly<Record<ConnectFlow, string>> = Object.freeze({
  ok: 'Signed in with OpenRouter. You’re connected.',
  denied: 'OpenRouter sign-in was cancelled.',
  expired: 'That sign-in took too long or was already used. Try again.',
  failed: 'Couldn’t finish signing in to OpenRouter. Try again.',
  busy: 'Too many tries. Wait a few minutes and try again.',
  unavailable: UNAVAILABLE_COPY,
  // Saved: the key is proven, but the test question went unanswered.
  saved:
    'Signed in with OpenRouter. Its free models were busy, so the test question went unanswered. Try Ask in a minute.',
  no_credit:
    'Signed in with OpenRouter, but the account has no credit for the test question. Add credit on OpenRouter, or pick a free model in Settings.',
  daily_limit:
    'Signed in with OpenRouter, but today’s free limit on the account is used up. Ask works again once it resets.',
});

/** A `?connect=` value this build knows, or null. Own keys only: `in` would also accept 'constructor'. */
export function readFlow(raw: unknown): ConnectFlow | null {
  return typeof raw === 'string' && Object.hasOwn(FLOW_COPY, raw) ? (raw as ConnectFlow) : null;
}

/** Whether a sign-in that ended this way left a connection saved on the account. */
export function flowSaved(flow: ConnectFlow): boolean {
  return flow === 'ok' || flow === 'saved' || flow === 'no_credit' || flow === 'daily_limit';
}
