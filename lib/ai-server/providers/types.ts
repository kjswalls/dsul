/**
 * The one server-side interface every model provider sits behind.
 *
 * Server-only. Routes speak to a `ProviderAdapter` and never to an SDK, so
 * adding a provider is an adapter plus an entry in `providers/index.ts`.
 * Every adapter yields plain text deltas; the routes turn them into dsul's
 * own SSE frames (lib/sse.ts), so the client has one parser whoever answered.
 */

import type { ModelOption, ModelProviderId } from '@/lib/ai-types';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** baseUrl is always set: a built-in provider's constant, or the checked custom URL. */
export interface ProviderCredentials {
  provider: ModelProviderId;
  apiKey: string;
  baseUrl: string;
}

export interface ModelMeta {
  /** The model accepts a low reasoning effort (Anthropic `output_config.effort`). */
  effortLow?: boolean;
  /**
   * The name the provider listed the model under when it was saved
   * (Anthropic's display name, OpenRouter's catalog name). Display only:
   * dropped when the model changes, never sent to a provider.
   */
  label?: string;
}

export interface CompletionRequest {
  model: string;
  modelMeta: ModelMeta;
  /** Joined '\n\n' into ONE system message / Anthropic `system`. */
  system: string[];
  /** Already capped by sanitizeChatMessages. */
  messages: ChatTurn[];
  /** MAX_OUTPUT_TOKENS */
  maxOutputTokens: number;
  signal: AbortSignal;
  /** propose */
  json?: boolean;
}

export interface ListedModel extends ModelOption {
  effortLow?: boolean;
  created?: number;
  contextLength?: number;
}

export interface ModelList {
  models: ListedModel[];
  listed: boolean;
}

export interface VerifyResult extends ModelList {
  freeTier?: boolean;
}

export interface ProviderAdapter {
  readonly id: ModelProviderId;
  /**
   * Resolves ONLY after the upstream answered 2xx; any earlier failure REJECTS
   * with ProviderError, so routes can answer JSON before a stream exists. The
   * iterable yields non-empty text deltas; at the end it throws
   * ProviderError('refused') for a refusal stop reason.
   */
  openStream(creds: ProviderCredentials, req: CompletionRequest): Promise<AsyncIterable<string>>;
  /** Throws 'refused' / 'empty'. */
  completeText(creds: ProviderCredentials, req: CompletionRequest): Promise<string>;
  verify(
    creds: ProviderCredentials,
    opts: { signal: AbortSignal; modelHint?: string }
  ): Promise<VerifyResult>;
  listModels(creds: ProviderCredentials, signal: AbortSignal): Promise<ModelList>;
  /**
   * One test question to `model`, capped at one output token: resolves once
   * the model answered, rejects with ProviderError otherwise (classified as a
   * call, so a 403 is the model's or the region's, not the key's). Never
   * retried by the SDK; lib/ai-server/check.ts decides what a failure means.
   */
  ping(creds: ProviderCredentials, model: string, signal: AbortSignal): Promise<void>;
  /** anthropic only */
  describeModel?(creds: ProviderCredentials, model: string, signal: AbortSignal): Promise<ModelMeta>;
  pickDefaultModel(result: VerifyResult): string | null;
}
