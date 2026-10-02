/**
 * ai-types.ts — the shapes the model-connection routes and the client share.
 *
 * Client-safe on purpose: nothing here imports `node:*`, an SDK, or anything
 * under `lib/ai-server`, so a component can read a provider's label or a
 * response type without dragging server code into the bundle. A boundary test
 * holds that line.
 *
 * The key itself never appears in any of these types on the way OUT. A
 * connection is write-only from the browser's side: `ConnectRequest` carries
 * the key in, and nothing the server answers with carries it back, not even
 * masked or as a last four.
 */

export const MODEL_PROVIDERS = ['openai', 'anthropic', 'gemini', 'openrouter', 'custom'] as const;
export type ModelProviderId = (typeof MODEL_PROVIDERS)[number];

export function isModelProviderId(v: unknown): v is ModelProviderId {
  return typeof v === 'string' && (MODEL_PROVIDERS as readonly string[]).includes(v);
}

/**
 * Who answers in chat, as the user CHOSE it on this device. The effective
 * target (what actually answers right now) is derived from this plus what is
 * connected; see `resolveAICapabilities` in lib/ai-registry.ts.
 */
export type ChatTarget = 'model' | 'openclaw' | 'none';
export type ConnectionStatus = 'ok' | 'failing';
export type ConnectionProblem = 'key_rejected' | 'key_unreadable';

export interface ModelConnectionView {
  provider: ModelProviderId;
  /** null until chosen. */
  model: string | null;
  /** custom only; user-typed, non-secret. */
  baseUrl: string | null;
  authMethod: 'key' | 'oauth';
  status: ConnectionStatus;
  problem: ConnectionProblem | null;
  /** ISO timestamp of the last check. */
  checkedAt: string | null;
}

export interface OpenClawView {
  /** user_settings.openclaw_gateway_url AND user_secrets.openclaw_gateway_token present. */
  gateway: boolean;
  /** user_settings.openclaw_api_key AND openclaw_chat_url present. */
  pluginChat: boolean;
  /** user_settings.openclaw_api_key present (an agent can pull delegated work). */
  agent: boolean;
  agentId: string | null;
}

export interface AIConnectionResponse {
  available: boolean;
  model: ModelConnectionView | null;
  openclaw: OpenClawView;
}

export interface ModelOption {
  id: string;
  label: string;
  free?: boolean;
}

/**
 * The ONE model-id rule: PUT/PATCH bodies, every adapter's listed ids, and the
 * picker's typed id. Strictly inside the 053 CHECK (no space, no control char,
 * ≤ 200), so no id the app produces can trip that CHECK, whose failure detail
 * would carry the whole row.
 */
export const MODEL_ID_RE = /^[\x21-\x7e]{1,200}$/;

export function isModelId(v: unknown): v is string {
  return typeof v === 'string' && MODEL_ID_RE.test(v);
}

export interface ConnectRequest {
  provider: ModelProviderId;
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export interface ConnectResponse {
  connection: ModelConnectionView;
  models: ModelOption[];
  listed: boolean;
}

export type PatchRequest = { provider: ModelProviderId; model: string } | { recheck: true };

export interface ModelsResponse {
  models: ModelOption[];
  listed: boolean;
}

/**
 * Connection routes answer `{ error: ApiErrorCode, field?: string, available?: false }`;
 * the panel maps code → copy.
 */
export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'unavailable'
  | 'invalid'
  | 'too_large'
  | 'unsupported_media'
  | 'key_rejected'
  | 'unreachable'
  | 'blocked_url'
  | 'model_required'
  | 'not_connected'
  | 'busy'
  | 'conflict'
  | 'not_found'
  | 'server';

/**
 * Chat and propose answer `{ error: <our copy>, code: ChatErrorCode }` (JSON)
 * or an SSE `{error, code}` frame.
 */
export type ChatErrorCode =
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
  | 'not_connected'
  | 'unauthorized'
  | 'invalid'
  | 'too_large'
  | 'server';

export const PROVIDER_META: Record<
  ModelProviderId,
  {
    label: 'OpenAI' | 'Anthropic' | 'Google Gemini' | 'OpenRouter' | 'Other';
    keyHelpUrl: string | null;
    keyPlaceholder: string;
  }
> = {
  openai: { label: 'OpenAI', keyHelpUrl: 'https://platform.openai.com/api-keys', keyPlaceholder: 'sk-…' },
  anthropic: { label: 'Anthropic', keyHelpUrl: 'https://console.anthropic.com/settings/keys', keyPlaceholder: 'sk-ant-…' },
  gemini: { label: 'Google Gemini', keyHelpUrl: 'https://aistudio.google.com/apikey', keyPlaceholder: 'AIza…' },
  openrouter: { label: 'OpenRouter', keyHelpUrl: 'https://openrouter.ai/settings/keys', keyPlaceholder: 'sk-or-…' },
  custom: { label: 'Other', keyHelpUrl: null, keyPlaceholder: 'Your API key' },
};
