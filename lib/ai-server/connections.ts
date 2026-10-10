/**
 * `model_connections` reads and writes, on the service client, OpenClaw
 * readiness for the gate, and Unpair.
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
import { deregisterAllPlugins } from '@/lib/openclaw-registry';
import { clearAgentKey, createServiceClient } from '@/lib/supabase-service';
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
  /**
   * When a daily cap lifts (060). Null when none holds, and on a database
   * that has not got the column yet: every read of it is tolerant, so a
   * deploy landing ahead of 060 reads as "no limit" rather than no AI at all.
   */
  limited_until: string | null;
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
  readonly op: 'read' | 'save' | 'model' | 'status' | 'limit' | 'delete' | 'openclaw' | 'unpair' | 'hidden';
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
/**
 * 060's column, asked for separately. `isMissingSchema` reads 42703 and
 * PGRST204 as "no table", which would turn a deploy ahead of 060 into
 * `available: false` for everyone, so every statement that names it retries
 * without it instead.
 */
const COLUMNS_WITH_LIMIT = `${COLUMNS}, limited_until`;

function isMissingColumn(error: DbError): boolean {
  const code = codeOf(error);
  return code === '42703' || code === 'PGRST204';
}

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
  const raw = meta as Record<string, unknown>;
  const label = cleanLabel(raw.label);
  return {
    ...(typeof raw.effortLow === 'boolean' ? { effortLow: raw.effortLow } : {}),
    ...(label !== null ? { label } : {}),
  };
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The model's listed name, as `model_meta` may carry it: printable, trimmed, at most 200. */
const LABEL_MAX = 200;
const UNPRINTABLE = /[\u0000-\u001f\u007f]/u;

function cleanLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, LABEL_MAX);
  return t !== '' && !UNPRINTABLE.test(t) ? t : null;
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
    limited_until: typeof data.limited_until === 'string' ? data.limited_until : null,
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
  const svc = service('read');
  const read = (columns: string) => svc.from(TABLE).select(columns).eq('user_id', userId).maybeSingle();
  const first = await read(COLUMNS_WITH_LIMIT);
  // Before 060 the column is not there; the rest of the row still is.
  const { data, error } = isMissingColumn(first.error) ? await read(COLUMNS) : first;
  if (error) {
    if (isNoSchema(error)) return { kind: 'unavailable', reason: 'no_table' };
    throw new AiDbError('read', codeOf(error));
  }
  if (!data) return { kind: 'none' };
  return { kind: 'row', row: toRow(data as unknown as Record<string, unknown>, 'read') };
}

/** For GET: opens the key in memory only to decide readability, discards the plaintext, NEVER writes. */
export function toConnectionView(
  row: ModelConnectionRow,
  readable: boolean,
  now: number = Date.now()
): ModelConnectionView {
  const failing = !readable || row.status === 'failing';
  // A limit that has passed is no limit: the view says nothing rather than
  // asking every reader to compare it with the clock.
  const limit = row.limited_until === null ? NaN : Date.parse(row.limited_until);
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
    limitedUntil: Number.isFinite(limit) && limit > now ? new Date(limit).toISOString() : null,
    modelLabel: row.model === null ? null : (row.model_meta.label ?? null),
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

/**
 * Seals with AAD (user, provider, baseUrl); upserts on user_id; status 'ok',
 * last_error null, checked_at now(), limited_until null (a new key never
 * inherits the old one's daily cap).
 */
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

  const svc = service('save');
  const row = {
    user_id: userId,
    provider: v.provider,
    base_url: baseUrl,
    model: v.model,
    model_meta: cleanMeta(v.modelMeta),
    auth_method: v.authMethod,
    key_ciphertext: ciphertext,
    status: 'ok' as const,
    last_error: null,
    checked_at: new Date().toISOString(),
  };
  const save = (withLimit: boolean) =>
    svc
      .from(TABLE)
      .upsert(withLimit ? { ...row, limited_until: null } : row, { onConflict: 'user_id' })
      .select(withLimit ? COLUMNS_WITH_LIMIT : COLUMNS)
      .single();
  const first = await save(true);
  const { data, error } = isMissingColumn(first.error) ? await save(false) : first;
  if (error) throw new AiDbError('save', codeOf(error));
  if (!data) throw new AiDbError('save', 'no_row');
  return toRow(data as unknown as Record<string, unknown>, 'save');
}

/**
 * .eq('user_id').eq('provider', provider); returns null when no row matched
 * (route → 409/404). The limit is cleared with it: Gemini's daily quota is
 * per model, so the old model's cap says nothing about the new one.
 */
export async function setConnectionModel(
  userId: string,
  provider: ModelProviderId,
  model: string,
  meta: ModelMeta
): Promise<ModelConnectionRow | null> {
  if (!isModelId(model)) throw new AiDbError('model', 'invalid_model');
  const svc = service('model');
  const update = { model, model_meta: cleanMeta(meta) };
  const write = (withLimit: boolean) =>
    svc
      .from(TABLE)
      .update(withLimit ? { ...update, limited_until: null } : update)
      .eq('user_id', userId)
      .eq('provider', provider)
      .select(withLimit ? COLUMNS_WITH_LIMIT : COLUMNS)
      .maybeSingle();
  const first = await write(true);
  const { data, error } = isMissingColumn(first.error) ? await write(false) : first;
  if (error) throw new AiDbError('model', codeOf(error));
  return data ? toRow(data as unknown as Record<string, unknown>, 'model') : null;
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

/**
 * When a daily cap lifts, written the same conditional way as the status (by
 * the seal's IV, see `sealedHeadPattern`), so a key replaced in the meantime
 * never inherits it. `null` clears it.
 *
 * Tolerant of 060 not being applied: no column, nothing kept, `false`. The
 * limit is a nicety (the pill's "back at 7 am"), never the gate, so a
 * database without it must not fail a request.
 */
export async function setConnectionLimit(
  userId: string,
  expectCiphertext: string,
  until: string | null
): Promise<boolean> {
  const head = sealedHeadPattern(expectCiphertext);
  if (head === null) return false;
  const at = typeof until === 'string' ? Date.parse(until) : NaN;
  const { data, error } = await service('limit')
    .from(TABLE)
    .update({ limited_until: Number.isFinite(at) ? new Date(at).toISOString() : null })
    .eq('user_id', userId)
    .like('key_ciphertext', head)
    .select('user_id');
  if (error) {
    if (isMissingColumn(error)) return false;
    throw new AiDbError('limit', codeOf(error));
  }
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

/**
 * Unpair: take back the access the plugin's device authorization gave
 * OpenClaw. Idempotent, so a failure part way is fixed by asking again.
 *
 *   1. Every webhook registration: dsul stops sending item changes.
 *   2. The chat URL and agent id the plugin registered.
 *   3. Any authorized device session still holding a copy of the key, so a
 *      late poll can't hand it out.
 *   4. The agent key itself (`clearAgentKey`, either column before 059):
 *      /api/agent/*, /api/mcp and the context route stop answering it.
 *   5. The registrations once more: a plugin that registered between 1 and 4
 *      did it with the key 4 just deleted, and none can follow.
 *
 * The key goes LAST because it is what makes OpenClaw read as paired: a
 * failure before it leaves the Unpair button on screen to try again.
 * The gateway URL and token are a separate connection (Advanced), and stay.
 * Throws AiDbError('unpair', code); never a message, which can quote the row.
 */
export async function unpairOpenClaw(userId: string): Promise<void> {
  const svc = service('unpair');
  const fail = (code: string | undefined): never => {
    throw new AiDbError('unpair', code);
  };

  if (!(await deregisterAllPlugins(userId)).ok) fail('registry');

  const settings = await svc
    .from('user_settings')
    .update({ openclaw_chat_url: null, openclaw_agent_id: null })
    .eq('user_id', userId);
  if (settings.error && !isNoSchema(settings.error)) fail(codeOf(settings.error));

  const sessions = await svc
    .from('connect_sessions')
    .update({ status: 'expired', api_key: null })
    .eq('user_id', userId)
    .eq('status', 'authorized');
  if (sessions.error && !isNoSchema(sessions.error)) fail(codeOf(sessions.error));

  const key = await clearAgentKey(userId, svc);
  if (key.error !== null) fail(key.error);

  if (!(await deregisterAllPlugins(userId)).ok) fail('registry');
}

/**
 * user_settings.ai_hidden (060): the account said "No AI, thanks". `null` when
 * the column is not there yet: an unknown answer, which the gate reads as
 * "invite nobody" (lib/ai-registry.ts). No row yet is a new account that has
 * said nothing: false. Other errors THROW.
 */
export async function readAIHidden(userId: string): Promise<boolean | null> {
  const { data, error } = await service('hidden')
    .from('user_settings')
    .select('ai_hidden')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    if (isNoSchema(error)) return null;
    throw new AiDbError('hidden', codeOf(error));
  }
  return (data as Record<string, unknown> | null)?.ai_hidden === true;
}

/**
 * Writes user_settings.ai_hidden, creating the row for an account that has
 * none. Answers false when the column is not there yet (nothing written), so
 * the route can say so instead of pretending the choice was kept.
 */
export async function writeAIHidden(userId: string, hidden: boolean): Promise<boolean> {
  const { error } = await service('hidden')
    .from('user_settings')
    .upsert({ user_id: userId, ai_hidden: hidden }, { onConflict: 'user_id' });
  if (error) {
    if (isNoSchema(error)) return false;
    throw new AiDbError('hidden', codeOf(error));
  }
  return true;
}
