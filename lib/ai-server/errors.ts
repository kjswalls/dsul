/**
 * Provider failures, in our words.
 *
 * Server-only (imported from app/api/** and lib/ai-server/** alone). A provider
 * error never reaches the user as the provider wrote it: upstream bodies can
 * echo the key, the prompt, or account details, so `ProviderError.message` is
 * always `USER_MESSAGES[kind]` and nothing else.
 *
 * Classification reads only an error's `.status`, `.code`, `.name` and
 * `.cause`, never its `.message`, body or headers, so nothing a provider wrote
 * can ride through into a response or a log line.
 */

import {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicConnectionTimeoutError,
  APIError as AnthropicAPIError,
  APIUserAbortError as AnthropicUserAbortError,
} from '@anthropic-ai/sdk';
import {
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAIConnectionTimeoutError,
  APIError as OpenAIAPIError,
  APIUserAbortError as OpenAIUserAbortError,
} from 'openai';
import type { ChatErrorCode, ModelProviderId } from '@/lib/ai-types';

export type ProviderErrorKind =
  | 'auth'
  | 'forbidden'
  | 'quota'
  | 'rate_limit'
  | 'bad_model'
  | 'bad_request'
  | 'upstream'
  | 'timeout'
  | 'network'
  | 'aborted'
  | 'blocked_url'
  | 'empty'
  | 'refused'
  | 'model_required';

/**
 * Our copy for each kind. No em dashes. `aborted` is never shown.
 *
 * Where it shows: chat and propose put `ProviderError.message` in the reply
 * verbatim, a surface with no key, model or address field. The Settings panel
 * never shows these; it maps the routes' codes to its own copy. So every line
 * names a next step, and one that needs a field says it is in Settings.
 */
export const USER_MESSAGES: Record<ProviderErrorKind, string> = {
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
  model_required: "This server doesn't list its models. Enter the model name to use.",
  aborted: '',
};

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;

  /** message = USER_MESSAGES[kind]; NEVER upstream text. */
  constructor(kind: ProviderErrorKind, status?: number) {
    super(USER_MESSAGES[kind]);
    this.name = 'ProviderError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * An HTTP status from a provider, in our vocabulary (design 1.5).
 *
 * The verify phase is the key check itself, so a 403 there means the key was
 * refused; at call time a 403 is a per-model or per-region refusal that the key
 * survives (D9). Gemini's OpenAI-compatible layer answers a bad key with a 400,
 * which is only read as `auth` on verify (R7).
 */
export function classifyStatus(
  status: number,
  p: ModelProviderId,
  phase: 'verify' | 'call',
  code?: string
): ProviderErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return phase === 'verify' ? 'auth' : 'forbidden';
  if (status === 400) return p === 'gemini' && phase === 'verify' ? 'auth' : 'bad_request';
  if (status === 402) return 'quota';
  if (status === 404) return 'bad_model';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 413) return 'bad_request';
  if (status === 429) return code === 'insufficient_quota' ? 'quota' : 'rate_limit';
  if (status >= 500) return 'upstream';
  if (status >= 400) return 'bad_request';
  return 'upstream';
}

function field(err: unknown, key: 'status' | 'code' | 'name' | 'cause'): unknown {
  if (typeof err !== 'object' || err === null) return undefined;
  try {
    return (err as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** A ProviderError given directly, or carried as `.cause` (a few levels deep). */
function carriedProviderError(err: unknown): ProviderError | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur != null; depth++) {
    if (cur instanceof ProviderError) return cur;
    cur = field(cur, 'cause');
  }
  return null;
}

/**
 * Any thrown value, as a ProviderError. Reads only `.status`, `.code`, `.name`
 * and `.cause` (design 1.5).
 *
 * A ProviderError, direct or as a cause, passes through first: that is how the
 * body cap's `upstream`, the URL policy's `blocked_url` and the DNS check's
 * `network` survive both SDKs, which wrap whatever their `fetch` threw.
 */
export function toProviderError(
  err: unknown,
  p: ModelProviderId,
  phase: 'verify' | 'call'
): ProviderError {
  const carried = carriedProviderError(err);
  if (carried) return carried;

  if (err instanceof OpenAIUserAbortError || err instanceof AnthropicUserAbortError) {
    return new ProviderError('aborted');
  }
  if (err instanceof OpenAIConnectionTimeoutError || err instanceof AnthropicConnectionTimeoutError) {
    return new ProviderError('timeout');
  }
  if (err instanceof OpenAIConnectionError || err instanceof AnthropicConnectionError) {
    return new ProviderError('network');
  }

  const name = field(err, 'name');
  if (name === 'AbortError') return new ProviderError('aborted');
  if (name === 'TimeoutError') return new ProviderError('timeout');

  const status = field(err, 'status');
  if (
    err instanceof OpenAIAPIError ||
    err instanceof AnthropicAPIError ||
    typeof status === 'number'
  ) {
    if (typeof status === 'number' && Number.isFinite(status)) {
      const code = field(err, 'code');
      return new ProviderError(
        classifyStatus(status, p, phase, typeof code === 'string' ? code : undefined),
        status
      );
    }
    // An API error with no status is an `error` event inside a stream.
    return new ProviderError('upstream');
  }

  // undici rejects a failed connection (refused, reset, DNS, a redirect under
  // `redirect: 'error'`) with a bare TypeError.
  if (name === 'TypeError') return new ProviderError('network');
  return new ProviderError('upstream');
}

/** True when an AbortSignal's reason is a deadline (`AbortSignal.timeout`), not a cancel. */
export function isDeadlineAbort(signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) return false;
  return field(signal.reason, 'name') === 'TimeoutError';
}

/**
 * `toProviderError`, told which signal the call ran under. The SDKs report any
 * abort of the caller's signal as a user abort, so a route's deadline
 * (`AbortSignal.timeout`, combined with `anySignal`) would otherwise read as
 * `aborted` and never reach the user as "took too long".
 */
export function toProviderErrorFor(
  err: unknown,
  p: ModelProviderId,
  phase: 'verify' | 'call',
  signal?: AbortSignal
): ProviderError {
  const e = toProviderError(err, p, phase);
  if (e.kind === 'aborted' && isDeadlineAbort(signal)) return new ProviderError('timeout');
  return e;
}

/** 'aborted' → 'network', 'model_required' → 'bad_model'. */
export function toChatErrorCode(kind: ProviderErrorKind): ChatErrorCode {
  switch (kind) {
    case 'aborted':
      return 'network';
    case 'model_required':
      return 'bad_model';
    default:
      return kind;
  }
}

/** blocked_url 400, timeout 504, model_required 400, else 502. */
export function httpStatusFor(kind: ProviderErrorKind): number {
  if (kind === 'blocked_url' || kind === 'model_required') return 400;
  if (kind === 'timeout') return 504;
  return 502;
}

/**
 * console.warn('[ai]', …) only: the route, the provider id, our kind and the
 * bare status. Never an error object, a message, a body or a header.
 */
export function logProviderError(
  route: string,
  p: ModelProviderId,
  kind: ProviderErrorKind,
  status?: number
): void {
  if (typeof status === 'number' && Number.isFinite(status)) {
    console.warn('[ai]', route, p, kind, status);
  } else {
    console.warn('[ai]', route, p, kind);
  }
}
