/**
 * `model_connections` reads and writes, on the service client, and OpenClaw
 * readiness for the gate.
 *
 * Server-only. Two hard rules (design 1.9):
 *   - A decrypt failure is computed, returned and NEVER written. Only a
 *     provider's own refusal writes `failing`, and only conditionally on the
 *     seal the caller read (matched by its IV: a filter travels in the URL,
 *     and request URLs are logged, so the ciphertext is never a filter).
 *   - DB errors never leave this module whole. A CHECK or NOT NULL failure's
 *     detail carries the whole row, ciphertext included, so every Supabase
 *     error becomes `AiDbError(op, code)` and nothing else.
 *
 * The table is SERVICE ROLE ONLY (migration 053): every read and write here
 * goes through `createServiceClient()`, and the routes have already resolved
 * the user from their session before passing a user id in.
 */

import {
  isModelId,
  isModelProviderId,
  type ConnectionStatus,
  type ModelConnectionView,
  type ModelProviderId,
  type OpenClawView,
} from '@/lib/ai-types';
import { createServiceClient } from '@/lib/supabase-service';
import { ProviderError } from './errors';
import { credentialsFor } from './providers';
import type { ModelMeta, ProviderCredentials } from './providers/types';
import { isMissingSchema } from './schema-codes';
import { loadEncryptionKey, openSecret, sealSecret, type SealContext } from './secret-box';

export interface ModelConnectionRow {
  user_id: string;
  provider: ModelProviderId;
  base_url: string | null;
  model: string | null;
  model_meta: ModelMeta;
  auth_method: 'key' | 'oauth';
  key_ciphertext: string;
  status: ConnectionStatus;
  last_error: string | null;
  checked_at: string | null;
}

export type RowRead =
  | { kind: 'unavailable'; reason: 'no_key' | 'no_table' }
  | { kind: 'none' }
  | { kind: 'row'; row: ModelConnectionRow };

/**
 * The only error connections.ts throws for a DB failure. Carries the
 * PostgREST/Postgres code and the op, nothing else — never the original
 * error, its `.details`, `.message` or `.hint`.
 */
export class AiDbError extends Error {
  readonly op: 'read' | 'save' | 'model' | 'status' | 'delete' | 'openclaw';
  /** e.g. '23514', 'PGRST301'; 'unknown' when absent. */
  readonly code: string;

  constructor(op: AiDbError['op'], code: string | undefined) {
    const c = typeof code === 'string' && code !== '' ? code : 'unknown';
    super(`db ${op} failed ${c}`);
    this.name = 'AiDbError';
    this.op = op;
    this.code = c;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const TABLE = 'model_connections';
const COLUMNS =
  'user_id, provider, base_url, model, model_meta, auth_method, key_ciphertext, status, last_error, checked_at';

type DbError = { code?: unknown } | null | undefined;

function codeOf(error: DbError): string | undefined {
  // ONLY the code is read. `.details` on a CHECK failure is the whole row,
  // ciphertext included; `.message` and `.hint` can quote it too.
  const code = error?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The schema is not there yet (053 not applied, or a stale PostgREST cache):
 * the shared set in schema-codes.ts. Everything else is a real failure.
 */
function isNoSchema(error: DbError): boolean {
  return isMissingSchema(codeOf(error));
}

function service(op: AiDbError['op']): ReturnType<typeof createServiceClient> {
  try {
    return createServiceClient();
  } catch {
    // Missing service env. The thrown message names env vars, not secrets, but
    // the rule is one error type out of this module.
    throw new AiDbError(op, 'no_service_client');
  }
}

function cleanMeta(meta: unknown): ModelMeta {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return {};
  const effortLow = (meta as Record<string, unknown>).effortLow;
  return typeof effortLow === 'boolean' ? { effortLow } : {};
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** A row as stored, narrowed field by field; anything off-shape reads as absent. */
function toRow(data: Record<string, unknown>, op: AiDbError['op']): ModelConnectionRow {
  const provider = data.provider;
  const ciphertext = data.key_ciphertext;
  if (!isModelProviderId(provider) || typeof ciphertext !== 'string' || typeof data.user_id !== 'string') {
    throw new AiDbError(op, 'bad_row');
  }
  return {
    user_id: data.user_id,
    provider,
    base_url: typeof data.base_url === 'string' ? data.base_url : null,
    model: typeof data.model === 'string' ? data.model : null,
    model_meta: cleanMeta(data.model_meta),
    auth_method: data.auth_method === 'oauth' ? 'oauth' : 'key',
    key_ciphertext: ciphertext,
    status: data.status === 'failing' ? 'failing' : 'ok',
    last_error: typeof data.last_error === 'string' ? data.last_error : null,
    checked_at: typeof data.checked_at === 'string' ? data.checked_at : null,
  };
}

function sealContext(userId: string, provider: ModelProviderId, baseUrl: string | null): SealContext {
  return { userId, purpose: 'model-key', provider, baseUrl };
}

/**
 * Missing schema (schema-codes.ts) => unavailable 'no_table'. Missing env
 * key => 'no_key'. Any other DB error THROWS (route answers 503).
 */
export async function readModelConnection(userId: string): Promise<RowRead> {
  if (!loadEncryptionKey().ok) return { kind: 'unavailable', reason: 'no_key' };
  const { data, error } = await service('read')
    .from(TABLE)
    .select(COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    if (isNoSchema(error)) return { kind: 'unavailable', reason: 'no_table' };
    throw new AiDbError('read', codeOf(error));
  }
  if (!data) return { kind: 'none' };
  return { kind: 'row', row: toRow(data as Record<string, unknown>, 'read') };
}

/** For GET: opens the key in memory only to decide readability, discards the plaintext, NEVER writes. */
export function toConnectionView(row: ModelConnectionRow, readable: boolean): ModelConnectionView {
  const failing = !readable || row.status === 'failing';
  return {
    provider: row.provider,
    model: row.model,
    baseUrl: row.provider === 'custom' ? row.base_url : null,
    authMethod: row.auth_method,
    status: failing ? 'failing' : 'ok',
    // A key this deployment cannot open is computed, never stored. The only
    // failure ever written is the provider refusing the key.
    problem: !readable ? 'key_unreadable' : row.status === 'failing' ? 'key_rejected' : null,
    checkedAt: isoOrNull(row.checked_at),
  };
}

function openKey(row: ModelConnectionRow, userId: string): string | null {
  const key = loadEncryptionKey();
  if (!key.ok) return null;
  return openSecret(row.key_ciphertext, sealContext(userId, row.provider, row.base_url), key.key);
}

export function isReadable(row: ModelConnectionRow, userId: string): boolean {
  // The plaintext is dropped on the spot: only whether it opened leaves here.
  return openKey(row, userId) !== null;
}

export type Opened =
  | { ok: true; row: ModelConnectionRow; creds: ProviderCredentials; model: string }
  | { ok: false; reason: 'unavailable' | 'none' | 'failing' | 'unreadable' | 'no_model' | 'blocked_url' };

/** What recheck and the model list need: the key, whatever the row's status or model. */
export type OpenedKey =
  | { ok: true; row: ModelConnectionRow; creds: ProviderCredentials }
  | { ok: false; reason: 'unavailable' | 'none' | 'unreadable' | 'blocked_url' };

/**
 * Opens the stored key for a call that must work on a `failing` row or one
 * with no model yet: "Check again" (PATCH recheck) and the model list. Chat
 * and propose use `openModelConnection`, which refuses both.
 *
 * Never writes: an unreadable key is reported, not stored.
 */
export async function openConnectionKey(userId: string): Promise<OpenedKey> {
  const read = await readModelConnection(userId);
  if (read.kind === 'unavailable') return { ok: false, reason: 'unavailable' };
  if (read.kind === 'none') return { ok: false, reason: 'none' };

  const row = read.row;
  const apiKey = openKey(row, userId);
  if (apiKey === null) return { ok: false, reason: 'unreadable' };
  try {
    return { ok: true, row, creds: credentialsFor(row.provider, row.base_url, apiKey) };
  } catch (err) {
    if (err instanceof ProviderError) return { ok: false, reason: 'blocked_url' };
    throw err;
  }
}

/** For chat and propose: a usable connection, or the reason there is none. Never writes. */
export async function openModelConnection(userId: string): Promise<Opened> {
  const opened = await openConnectionKey(userId);
  if (!opened.ok) return opened;
  const { row, creds } = opened;
  if (row.status === 'failing') return { ok: false, reason: 'failing' };
  if (!isModelId(row.model)) return { ok: false, reason: 'no_model' };
  return { ok: true, row, creds, model: row.model };
}

/** Seals with AAD (user, provider, baseUrl); upserts on user_id; status 'ok', last_error null, checked_at now(). */
export async function saveModelConnection(
  userId: string,
  v: {
    provider: ModelProviderId;
    baseUrl: string | null;
    model: string | null;
    modelMeta: ModelMeta;
    authMethod: 'key' | 'oauth';
    apiKey: string;
  }
): Promise<ModelConnectionRow> {
  // Fences in front of the 053 CHECKs. A CHECK violation's detail carries the
  // whole row, so no value the CHECK would refuse is ever sent.
  if (!isModelProviderId(v.provider)) throw new AiDbError('save', 'invalid_provider');
  if (v.model !== null && !isModelId(v.model)) throw new AiDbError('save', 'invalid_model');
  const baseUrl = v.provider === 'custom' ? v.baseUrl : null;
  if (v.provider === 'custom' && (typeof baseUrl !== 'string' || !baseUrl.startsWith('https://'))) {
    throw new AiDbError('save', 'invalid_base_url');
  }
  if (v.authMethod !== 'key' && !(v.authMethod === 'oauth' && v.provider === 'openrouter')) {
    throw new AiDbError('save', 'invalid_auth_method');
  }
  if (typeof v.apiKey !== 'string' || v.apiKey === '') throw new AiDbError('save', 'invalid_key');

  const key = loadEncryptionKey();
  if (!key.ok) throw new AiDbError('save', 'no_key');
  const ciphertext = sealSecret(v.apiKey, sealContext(userId, v.provider, baseUrl), key.key);

  const { data, error } = await service('save')
    .from(TABLE)
    .upsert(
      {
        user_id: userId,
        provider: v.provider,
        base_url: baseUrl,
        model: v.model,
        model_meta: cleanMeta(v.modelMeta),
        auth_method: v.authMethod,
        key_ciphertext: ciphertext,
        status: 'ok',
        last_error: null,
        checked_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    )
    .select(COLUMNS)
    .single();
  if (error) throw new AiDbError('save', codeOf(error));
  if (!data) throw new AiDbError('save', 'no_row');
  return toRow(data as Record<string, unknown>, 'save');
}

/** .eq('user_id').eq('provider', provider); returns null when no row matched (route → 409/404). */
export async function setConnectionModel(
  userId: string,
  provider: ModelProviderId,
  model: string,
  meta: ModelMeta
): Promise<ModelConnectionRow | null> {
  if (!isModelId(model)) throw new AiDbError('model', 'invalid_model');
  const { data, error } = await service('model')
    .from(TABLE)
    .update({ model, model_meta: cleanMeta(meta) })
    .eq('user_id', userId)
    .eq('provider', provider)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw new AiDbError('model', codeOf(error));
  return data ? toRow(data as Record<string, unknown>, 'model') : null;
}

/**
 * The non-secret head of a sealed key, `v1:<iv>:`, as a LIKE pattern, or null
 * when the value is not shaped like anything 053's CHECK lets into the table.
 *
 * Why not `.eq('key_ciphertext', sealed)`: supabase-js sends every filter in
 * the URL query string, and Supabase's API gateway logs request URLs. The
 * sealed key in a log line plus MODEL_KEYS_ENCRYPTION_KEY is the plaintext, and
 * that copy would outlive Disconnect and every key replacement.
 *
 * The IV is safe to send instead. GCM treats it as public: without the tag and
 * the ciphertext it opens nothing, whoever holds the env key. It also works as
 * a version id, because `sealSecret` draws a fresh random 96-bit IV for every
 * seal, so a newer key, or the same key saved again, never shares it. The
 * charset (053's CHECK: standard base64) has no LIKE metacharacter, so the
 * pattern matches only that literal head.
 */
const SEALED_HEAD_RE = /^(v[0-9]+:[A-Za-z0-9+/=]+:)[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

function sealedHeadPattern(sealed: string): string | null {
  const m = typeof sealed === 'string' ? SEALED_HEAD_RE.exec(sealed) : null;
  return m ? `${m[1]}%` : null;
}

/**
 * Conditional on the seal the caller read (by its IV, never the ciphertext,
 * see `sealedHeadPattern`): never clobbers a newer key. Returns whether a row
 * changed.
 */
export async function setConnectionStatus(
  userId: string,
  expectCiphertext: string,
  status: ConnectionStatus,
  problem: 'key_rejected' | null
): Promise<boolean> {
  const head = sealedHeadPattern(expectCiphertext);
  // No stored row can hold a value off 053's shape, so nothing would match.
  if (head === null) return false;
  const { data, error } = await service('status')
    .from(TABLE)
    .update({
      status: status === 'failing' ? 'failing' : 'ok',
      last_error: status === 'failing' ? (problem ?? 'key_rejected') : null,
      checked_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .like('key_ciphertext', head)
    .select('user_id');
  if (error) throw new AiDbError('status', codeOf(error));
  return Array.isArray(data) && data.length > 0;
}

/** Idempotent: no row, or no table yet, is already disconnected. */
export async function deleteModelConnection(userId: string): Promise<void> {
  const { error } = await service('delete').from(TABLE).delete().eq('user_id', userId);
  if (error && !isNoSchema(error)) throw new AiDbError('delete', codeOf(error));
}

function present(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * user_settings (openclaw_gateway_url, openclaw_agent_id, openclaw_chat_url)
 * + user_secrets (openclaw_gateway_token, openclaw_api_key) via the service
 * client. Booleans + agentId only. Missing schema => all false. Other errors
 * THROW.
 *
 * The agent key moved to user_secrets in migration 059. Until that is
 * applied, user_secrets has no such column (the read retries without it) and
 * the key is still in user_settings.openclaw_api_key, so a key in EITHER
 * place counts; after 059 the old column is null and CHECKed null.
 */
export async function readOpenClawStatus(userId: string): Promise<OpenClawView> {
  const svc = service('openclaw');
  const readSecrets = (columns: string) =>
    svc.from('user_secrets').select(columns).eq('user_id', userId).maybeSingle();
  const [settings, firstSecrets] = await Promise.all([
    svc
      .from('user_settings')
      .select('openclaw_gateway_url, openclaw_agent_id, openclaw_api_key, openclaw_chat_url')
      .eq('user_id', userId)
      .maybeSingle(),
    readSecrets('openclaw_gateway_token, openclaw_api_key'),
  ]);
  const secrets =
    codeOf(firstSecrets.error) === '42703' ? await readSecrets('openclaw_gateway_token') : firstSecrets;
  if (settings.error && !isNoSchema(settings.error)) throw new AiDbError('openclaw', codeOf(settings.error));
  if (secrets.error && !isNoSchema(secrets.error)) throw new AiDbError('openclaw', codeOf(secrets.error));

  const s = (settings.error ? null : settings.data) as Record<string, unknown> | null;
  const sec = (secrets.error ? null : secrets.data) as Record<string, unknown> | null;
  const apiKey = present(sec?.openclaw_api_key) || present(s?.openclaw_api_key);
  return {
    gateway: present(s?.openclaw_gateway_url) && present(sec?.openclaw_gateway_token),
    pluginChat: apiKey && present(s?.openclaw_chat_url),
    agent: apiKey,
    agentId: present(s?.openclaw_agent_id) ? (s?.openclaw_agent_id as string) : null,
  };
}
