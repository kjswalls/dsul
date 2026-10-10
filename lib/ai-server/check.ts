/**
 * The check a key gets before dsul keeps it, and when "Check again" asks:
 * the key authenticates (the adapter's `verify`: a model list, or
 * OpenRouter's `/key`), then one model answers a test question capped at one
 * output token. "Working" means a model answered.
 *
 * Server-only. Each check spends one provider request on the test question
 * (two at most, on a retry or a fallback, a default that won't stream among
 * them; three only on Anthropic, when a picked model's retry gets a 400 and
 * the default is asked): it counts against a free OpenRouter account's daily
 * free requests and against Gemini's requests per day. The
 * SDK's own retry is off for it (META, maxRetries 0), because it would obey
 * an uncapped retry-after and retry a hint thrown from the fetch layer; the
 * one retry here waits a fixed, abortable second, inside the caller's
 * deadline.
 *
 * A verify that fails THROWS, as it always has. What the test question said
 * comes back as `ping`, and the caller decides what it means: connect saves
 * nothing on any failure, the OpenRouter callback keeps a key it has already
 * minted, and "Check again" writes what it learned.
 */

import { ProviderError, toProviderErrorFor, type ProviderErrorKind } from './errors';
import type { ProviderAdapter, ProviderCredentials, VerifyResult } from './providers/types';

export type PingOutcome = { ok: true } | { ok: false; error: ProviderError };

export interface CheckResult {
  result: VerifyResult;
  /**
   * The model the test question went to, which is the one to save: the chosen
   * one, or on OpenRouter's free tier the next free default that answered.
   * Null when there was none to ask (the picker opens on the list).
   */
  model: string | null;
  ping: PingOutcome;
}

export interface CheckOptions {
  signal: AbortSignal;
  /** Handed to `verify` as it is (a custom host's own probe uses it), and the default choice. */
  modelHint?: string;
  /** Which model to ask once the list is in. Default: the hint, else the adapter's default. */
  choose?: (result: VerifyResult) => string | null;
  /** When the caller's budget ends, in ms since the epoch. A second ask starts only with RETRY_MIN_MS left. */
  deadline: number;
}

/**
 * The key answered; what is wrong is the model or the request, which is the
 * picker's business, not the key's. A 403 at call time is a model's or a
 * region's refusal (D9), and asking again never fixes it.
 */
const PASSES: ReadonlySet<ProviderErrorKind> = new Set(['bad_request', 'bad_model', 'empty', 'refused', 'forbidden']);
/** Worth one more ask, when the provider gave no reset time. */
const TRANSIENT: ReadonlySet<ProviderErrorKind> = new Set(['rate_limit', 'upstream', 'timeout', 'network']);

/** The fixed wait before asking a second time. */
export const RETRY_PAUSE_MS = 1_000;
/** A second ask starts only with a whole META attempt's time left (providers' 10 s). */
export const RETRY_MIN_MS = 10_000;

const isTransient = (e: ProviderError) => TRANSIENT.has(e.kind) && e.resetAt === undefined;

/** Resolves after `ms`, or at once when `signal` aborts. Never rejects. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function checkConnection(
  adapter: ProviderAdapter,
  creds: ProviderCredentials,
  opts: CheckOptions
): Promise<CheckResult> {
  const { signal, modelHint, deadline } = opts;
  const provider = creds.provider;

  const verified = await adapter.verify(creds, { signal, modelHint });
  // OpenRouter's key check says nothing about models; its catalog is public.
  const result: VerifyResult =
    provider === 'openrouter' ? { ...(await adapter.listModels(creds, signal)), freeTier: verified.freeTier } : verified;

  const model = opts.choose ? opts.choose(result) : (modelHint ?? adapter.pickDefaultModel(result));
  // A custom host's verify already asked its model, when it knew one. With no
  // model there is nothing to ask: the connection waits for the picker.
  if (model === null || provider === 'custom') return { result, model, ping: { ok: true } };

  const answered = (m: string): CheckResult => ({ result, model: m, ping: { ok: true } });
  const failed = (error: ProviderError): CheckResult => ({ result, model, ping: { ok: false, error } });
  const judged = (e: ProviderError): CheckResult => (PASSES.has(e.kind) ? answered(model) : failed(e));
  const room = (extra = 0) => !signal.aborted && deadline - Date.now() >= RETRY_MIN_MS + extra;
  const ask = async (m: string): Promise<ProviderError | null> => {
    try {
      await adapter.ping(creds, m, signal);
      return null;
    } catch (err) {
      return toProviderErrorFor(err, provider, 'call', signal);
    }
  };

  const first = await ask(model);
  if (first === null) return answered(model);
  const fallback = adapter.pickDefaultModel(result);

  // Anthropic answers a console account with no credit, or one over its spend
  // limit, with a 400 like any bad request. The test question is a fixed,
  // minimal message to a model from the account's own list, so a 400 there is
  // the account's, unless it is the model's: a model the person picked gets
  // one more try on the default before the account is blamed. A retried
  // answer goes through the same rule, so a transient first answer can't let
  // the 400 pass.
  const noCredit = async (e: ProviderError): Promise<CheckResult | null> => {
    if (provider !== 'anthropic' || e.kind !== 'bad_request') return null;
    if (fallback !== null && fallback !== model && room()) {
      const second = await ask(fallback);
      // The default answered, or balked at itself: either way the account is
      // fine, and the model the person picked is theirs to keep.
      if (second === null || (second.kind !== 'bad_request' && PASSES.has(second.kind))) return answered(model);
      // Anything else the default says is about the key or the account.
      if (second.kind !== 'bad_request') return failed(second);
    }
    return failed(new ProviderError('quota', e.status));
  };
  const credit = await noCredit(first);
  if (credit) return credit;

  // A model that won't stream for this account (OpenAI's newer ones, for an
  // organization it has not verified) would fail Ask on every send, so it
  // never passes. When it was the adapter's default, not a model the person
  // picked, the next default is asked once: an older model often streams for
  // the same account, and the one that answers is the one saved.
  if (first.kind === 'stream_refused') {
    if (model === fallback && room()) {
      const rest = { ...result, models: result.models.filter((m) => m.id !== model) };
      const next = adapter.pickDefaultModel(rest);
      if (next !== null && next !== model) {
        const second = await ask(next);
        if (second === null) return answered(next);
      }
    }
    return failed(first);
  }

  // OpenRouter throttles its free models one by one: on the free tier, with
  // the default picked (not a model the person kept), the next free default
  // is likelier to answer than the same one again. The one that answers is
  // the one saved.
  const freeDefault = provider === 'openrouter' && result.freeTier === true && model === fallback;
  if (freeDefault && (isTransient(first) || first.kind === 'bad_model')) {
    const rest = { ...result, models: result.models.filter((m) => m.id !== model) };
    const next = adapter.pickDefaultModel(rest);
    if (next !== null && next !== model && rest.models.some((m) => m.id === next && m.free === true)) {
      if (room()) {
        const second = await ask(next);
        if (second === null) return answered(next);
      }
      return judged(first);
    }
  }

  if (isTransient(first) && room(RETRY_PAUSE_MS)) {
    await pause(RETRY_PAUSE_MS, signal);
    if (room()) {
      const second = await ask(model);
      if (second === null) return answered(model);
      return (await noCredit(second)) ?? judged(second);
    }
  }
  return judged(first);
}
