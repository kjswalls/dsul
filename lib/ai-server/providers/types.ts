/**
 * The one server-side interface every model provider sits behind.
 *
 * Server-only. Routes speak to a `ProviderAdapter` and never to an SDK, so
 * adding a provider is an adapter plus an entry in `providers/index.ts`.
 * Every adapter yields plain text deltas; the routes turn them into dsul's
 * own SSE frames (lib/sse.ts), so the client has one parser whoever answered.
 */

import type { ModelOption, ModelProviderId } from '@/lib/ai-types';
import type { ChatImage } from '@/lib/chat-images';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  /** A user turn's pictures (lib/chat-images.ts): only ever the newest message's. */
  images?: ChatImage[];
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
  /**
   * OpenRouter only: whether its catalog lists `tools` among the model's
   * supported parameters. Absent when the catalog does not say.
   */
  tools?: boolean;
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

// ── tool calling (AI step 3: chat tools) ───────────────────────────────────

/** A tool the model may call: its name, what it is for, and its arguments as a JSON Schema object. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * One call the model asked for. `args` is null when the model sent arguments
 * that are not a JSON object: the caller answers that call with an error
 * rather than guessing what was meant.
 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown> | null;
  /**
   * OpenAI-compatible only: the call's `extra_content`, sent back unchanged on
   * the next step. Gemini's thinking models put a thought signature there and
   * refuse a follow-up that drops it. Never read, never shown, never saved.
   */
  echo?: Record<string, unknown>;
}

/** A turn in a conversation with tools: the plain turns, plus the calls and their results. */
export type ToolTurn =
  | { role: 'user'; content: string; images?: ChatImage[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; content: string };

export interface ToolRequest extends Omit<CompletionRequest, 'messages' | 'json'> {
  messages: ToolTurn[];
  tools: ToolDef[];
}

/** One model step: what it said (may be empty) and the calls it asked for (may be none). */
export interface ToolStep {
  text: string;
  toolCalls: ToolCall[];
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
  /**
   * One non-streamed step with tools offered. Resolves with the text and the
   * calls the model asked for; throws 'refused', and 'empty' when it gave
   * neither. Never runs a tool: the caller does, and sends the results back
   * as `role: 'tool'` turns on the next step.
   */
  completeWithTools(creds: ProviderCredentials, req: ToolRequest): Promise<ToolStep>;
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
