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
  /**
   * While a daily cap holds (model_connections.limited_until, 060): when it
   * lifts, as an ISO time. Null once it has passed, and whenever none is set.
   * A limited connection is still connected: it comes back by itself.
   */
  limitedUntil: string | null;
  /**
   * The name the provider listed the model under when it was saved (model_meta,
   * never a raw id). Null when none was listed, and after a model change.
   */
  modelLabel: string | null;
}

export interface OpenClawView {
  /** user_settings.openclaw_gateway_url AND user_secrets.openclaw_gateway_token present. */
  gateway: boolean;
  /** The agent key (user_secrets, 059) AND user_settings.openclaw_chat_url present. */
  pluginChat: boolean;
  /** The agent key present (an agent can pull delegated work). */
  agent: boolean;
  agentId: string | null;
}

export interface AIConnectionResponse {
  available: boolean;
  model: ModelConnectionView | null;
  openclaw: OpenClawView;
  /**
   * user_settings.ai_hidden: the account said "No AI, thanks". Null when the
   * database cannot say (060 not applied), which invites nobody.
   */
  aiHidden: boolean | null;
}

/**
 * DELETE /api/ai/openclaw (Unpair): what is still there afterwards, read back
 * once the writes landed. `null` when that read failed; the unpair itself did
 * not, and a status read fills it in.
 */
export interface UnpairResponse {
  openclaw: OpenClawView | null;
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
  /** OpenRouter only: the key is on the free tier (its /key said so). */
  freeTier?: boolean;
}

export type PatchRequest =
  | { provider: ModelProviderId; model: string }
  | { recheck: true }
  | { hidden: boolean };

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
  /** The key's prefix names another company (lib/ai-key-prefix.ts); nothing was sent. Carries `detected`. */
  | 'wrong_provider'
  /** The key authenticated, but the account has no credit (or no free use) for the test question. */
  | 'no_credit'
  /** The key authenticated, but today's quota is used up. Carries `limitedUntil`. */
  | 'daily_limit'
  /** The provider won't serve requests from where dsul's server is. */
  | 'region'
  /** The provider could not be reached, or did not answer in time. */
  | 'network'
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
  /** The provider's daily quota is used up (lib/ai-server/error-hints.ts). */
  | 'daily_limit'
  /** The provider won't serve requests from where dsul's server is. */
  | 'region'
  | 'not_connected'
  | 'unauthorized'
  | 'invalid'
  | 'too_large'
  | 'server';

export const PROVIDER_META: Record<
  ModelProviderId,
  {
    label: 'OpenAI' | 'Anthropic' | 'Google Gemini' | 'OpenRouter' | 'Other';
    /** The company, as copy names it ("Google didn't accept that key"). Null for custom: its host is the name. */
    company: string | null;
    /** The short form ("New Gemini key"). Null for custom. */
    short: string | null;
    keyHelpUrl: string | null;
    keyPlaceholder: string;
  }
> = {
  openai: {
    label: 'OpenAI',
    company: 'OpenAI',
    short: 'OpenAI',
    keyHelpUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-…',
  },
  anthropic: {
    label: 'Anthropic',
    company: 'Anthropic',
    short: 'Anthropic',
    keyHelpUrl: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-…',
  },
  // AI Studio has issued `AQ.` auth keys since 2026-05-28; older standard keys start `AIza`.
  gemini: {
    label: 'Google Gemini',
    company: 'Google',
    short: 'Gemini',
    keyHelpUrl: 'https://aistudio.google.com/apikey',
    keyPlaceholder: 'AQ.…',
  },
  openrouter: {
    label: 'OpenRouter',
    company: 'OpenRouter',
    short: 'OpenRouter',
    keyHelpUrl: 'https://openrouter.ai/settings/keys',
    keyPlaceholder: 'sk-or-…',
  },
  custom: { label: 'Other', company: null, short: null, keyHelpUrl: null, keyPlaceholder: 'Your API key' },
};

/**
 * Where "Sign in with OpenRouter" returns: the Settings pane, or home with the
 * setup column. Sealed into the PKCE cookie (lib/ai-server/pkce.ts) as a closed
 * enum, so the callback can only ever land on one of these two paths.
 */
export const OPENROUTER_RETURNS = ['settings', 'home'] as const;
export type OpenRouterReturn = (typeof OPENROUTER_RETURNS)[number];

export function isOpenRouterReturn(v: unknown): v is OpenRouterReturn {
  return typeof v === 'string' && (OPENROUTER_RETURNS as readonly string[]).includes(v);
}

/** The AI pane, by its user-facing alias (`/settings/beacon` stays a permanent id). */
export const AI_SETTINGS_PATH = '/settings/ai';

/** The path a return lands on, before its `?connect=` result. */
export function openRouterReturnPath(r: OpenRouterReturn): string {
  return r === 'home' ? '/' : AI_SETTINGS_PATH;
}
