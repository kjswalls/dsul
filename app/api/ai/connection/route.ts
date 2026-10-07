import type { NextResponse } from 'next/server'
import {
  isSameOrigin,
  jsonError,
  jsonOk,
  readJson,
  requireSessionUser,
} from '@/app/api/ai/_shared/guard'
import {
  isModelId,
  isModelProviderId,
  type AIConnectionResponse,
  type ConnectResponse,
  type ModelOption,
  type ModelProviderId,
} from '@/lib/ai-types'
import {
  AiDbError,
  deleteModelConnection,
  isReadable,
  openConnectionKey,
  readAIHidden,
  readModelConnection,
  readOpenClawStatus,
  saveModelConnection,
  setConnectionModel,
  setConnectionStatus,
  toConnectionView,
  writeAIHidden,
  type ModelConnectionRow,
  type OpenedKey,
  type RowRead,
} from '@/lib/ai-server/connections'
import { logProviderError, toProviderError, type ProviderErrorKind } from '@/lib/ai-server/errors'
import {
  credentialsFor,
  getAdapter,
  type ListedModel,
  type ModelMeta,
  type ProviderCredentials,
  type VerifyResult,
} from '@/lib/ai-server/providers'
import { takeToken } from '@/lib/ai-server/rate-limit'
import { loadEncryptionKey } from '@/lib/ai-server/secret-box'
import { anySignal } from '@/lib/ai-server/stream'
import { checkModelBaseUrl } from '@/lib/ai-server/url-policy'

/**
 * /api/ai/connection: the user's ONE model connection, four verbs.
 *
 *   GET     what is connected, whether OpenClaw is, and whether the account
 *           said "No AI, thanks" (the client's AI gate)
 *   PUT     connect or replace: verify the key with a free call, then store it
 *   PATCH   pick a model `{provider, model}`, check the key again `{recheck:true}`,
 *           or hide or show AI for the account `{hidden}`
 *   DELETE  forget it
 *
 * The key goes IN on a PUT and never comes back out: no response, header or log
 * line carries it, its ciphertext, a mask or a last four. A provider's error
 * text never reaches a response either; every failure answers an `ApiErrorCode`
 * the settings panel turns into its own copy. Every response is `no-store`.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PUT_MAX_BYTES = 16_384
const PATCH_MAX_BYTES = 2_048
/** verify / list / describe. */
const CHECK_TIMEOUT_MS = 10_000
/** Printable ASCII, no spaces: what every provider's keys look like, and nothing that could split a header. */
const API_KEY_RE = /^[\x21-\x7e]{8,512}$/

const unavailable = () => jsonError(503, 'unavailable', { available: false })

/**
 * A failed read or write. Logged as `[ai] db <op> failed <code>` and nothing
 * else: a database error's details can carry the whole row, ciphertext
 * included, so the error object itself is never logged.
 */
function dbFailure(err: unknown, what: string): NextResponse {
  if (err instanceof AiDbError) console.warn('[ai] db', err.op, 'failed', err.code)
  else console.warn('[ai]', what, 'failed')
  return jsonError(503, 'server')
}

/** The picker's shape, and nothing a provider listed beside it. */
function toOption(m: ListedModel): ModelOption {
  return m.free === undefined ? { id: m.id, label: m.label } : { id: m.id, label: m.label, free: m.free }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(): Promise<Response> {
  const user = await requireSessionUser()
  if (!user) return jsonError(401, 'unauthorized')

  try {
    // OpenClaw needs no encryption key, so it is answered either way.
    const key = loadEncryptionKey()
    const noKey: RowRead = { kind: 'unavailable', reason: 'no_key' }
    const [openclaw, read, aiHidden] = await Promise.all([
      readOpenClawStatus(user.id),
      key.ok ? readModelConnection(user.id) : Promise.resolve(noKey),
      readAIHidden(user.id),
    ])

    let body: AIConnectionResponse
    if (read.kind === 'unavailable') body = { available: false, model: null, openclaw, aiHidden }
    else if (read.kind === 'none') body = { available: true, model: null, openclaw, aiHidden }
    else {
      // An unreadable key (another deploy's encryption key, say) shows as
      // failing from memory. It is NEVER written: the row may be perfectly
      // good to the deploy that sealed it.
      const readable = isReadable(read.row, user.id)
      body = { available: true, model: toConnectionView(read.row, readable), openclaw, aiHidden }
    }
    return jsonOk(body)
  } catch (err) {
    return dbFailure(err, 'connection read')
  }
}

// ── PUT ──────────────────────────────────────────────────────────────────────

type ConnectBody =
  | { ok: true; provider: ModelProviderId; apiKey: string; baseUrl: string | null; model: string | null }
  | { ok: false; error: 'invalid' | 'blocked_url'; field: string }

function parseConnect(raw: unknown): ConnectBody {
  if (!isPlainObject(raw)) return { ok: false, error: 'invalid', field: 'body' }
  const { provider, apiKey, baseUrl, model } = raw
  if (!isModelProviderId(provider)) return { ok: false, error: 'invalid', field: 'provider' }

  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!API_KEY_RE.test(key)) return { ok: false, error: 'invalid', field: 'apiKey' }

  let url: string | null = null
  if (provider === 'custom') {
    if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
      return { ok: false, error: 'invalid', field: 'baseUrl' }
    }
    const policy = checkModelBaseUrl(baseUrl.trim())
    if (!policy.ok) return { ok: false, error: 'blocked_url', field: 'baseUrl' }
    url = policy.baseUrl
  }

  let wanted: string | null = null
  if (model !== undefined && model !== null) {
    const m = typeof model === 'string' ? model.trim() : model
    if (m !== '') {
      if (!isModelId(m)) return { ok: false, error: 'invalid', field: 'model' }
      wanted = m
    }
  }
  return { ok: true, provider, apiKey: key, baseUrl: url, model: wanted }
}

/**
 * A check that failed for a reason other than the key, as the panel's code.
 * Shared by connect and "Check again" so the same upstream answer reads the
 * same in both: a custom host's retired model is a model problem, not an
 * unreachable provider. Our words only.
 */
function checkFailure(kind: ProviderErrorKind): NextResponse {
  switch (kind) {
    case 'blocked_url':
      return jsonError(400, 'blocked_url', { field: 'baseUrl' })
    case 'model_required':
      return jsonError(400, 'model_required')
    case 'bad_model':
      return jsonError(400, 'invalid', { field: 'model' })
    default:
      return jsonError(502, 'unreachable')
  }
}

/** A verify that did not pass, as the panel's code. Our words only. */
function verifyFailure(err: unknown, provider: ModelProviderId, route: string): NextResponse {
  const e = toProviderError(err, provider, 'verify')
  logProviderError(route, provider, e.kind, e.status)
  return e.kind === 'auth' ? jsonError(400, 'key_rejected') : checkFailure(e.kind)
}

export async function PUT(req: Request): Promise<Response> {
  const user = await requireSessionUser()
  if (!user) return jsonError(401, 'unauthorized')
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden')

  const read = await readJson<unknown>(req, PUT_MAX_BYTES)
  if (!read.ok) return jsonError(read.status, read.error)
  const body = parseConnect(read.body)
  if (!body.ok) return jsonError(400, body.error, { field: body.field })
  const { provider, apiKey, baseUrl } = body

  if (!loadEncryptionKey().ok) return unavailable()
  try {
    if ((await readModelConnection(user.id)).kind === 'unavailable') return unavailable()
  } catch (err) {
    return dbFailure(err, 'connection read')
  }

  if (!takeToken(user.id, 'connect')) return jsonError(429, 'busy')

  let creds: ProviderCredentials
  try {
    creds = credentialsFor(provider, baseUrl, apiKey)
  } catch {
    return jsonError(400, 'blocked_url', { field: 'baseUrl' })
  }

  // A failed PUT returns before the save, so an existing connection is never
  // touched by a key that did not pass.
  const adapter = getAdapter(provider)
  const signal = anySignal([req.signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)])
  let result: VerifyResult
  try {
    const verified = await adapter.verify(creds, { signal, modelHint: body.model ?? undefined })
    // OpenRouter's key check says nothing about models; its catalog is public.
    result =
      provider === 'openrouter'
        ? { ...(await adapter.listModels(creds, signal)), freeTier: verified.freeTier }
        : verified
  } catch (err) {
    return verifyFailure(err, provider, 'connect')
  }

  // Every listed id already passed MODEL_ID_RE inside the adapter, so the
  // default can never be an id the table's CHECK would refuse.
  const model = body.model ?? adapter.pickDefaultModel(result)
  // Only a custom host that listed nothing usable needs a typed name: there is
  // nothing to pick from. One that listed several connects with no model yet,
  // like a built-in provider with no default, and the picker opens on the list.
  if (model === null && provider === 'custom' && (!result.listed || result.models.length === 0)) {
    return jsonError(400, 'model_required')
  }
  const entry = model === null ? undefined : result.models.find((m) => m.id === model)
  const modelMeta: ModelMeta = entry?.effortLow === undefined ? {} : { effortLow: entry.effortLow }

  let row: ModelConnectionRow
  try {
    row = await saveModelConnection(user.id, {
      provider,
      baseUrl,
      model,
      modelMeta,
      authMethod: 'key',
      apiKey,
    })
  } catch (err) {
    return dbFailure(err, 'connection save')
  }

  const response: ConnectResponse = {
    connection: toConnectionView(row, true),
    models: result.models.map(toOption),
    listed: result.listed,
  }
  return jsonOk(response)
}

// ── PATCH ────────────────────────────────────────────────────────────────────

async function setModel(
  req: Request,
  userId: string,
  provider: ModelProviderId,
  model: string
): Promise<NextResponse> {
  if (!loadEncryptionKey().ok) return unavailable()

  let meta: ModelMeta = {}
  if (provider === 'anthropic') {
    // One free lookup, so the call path knows whether this model takes a low
    // effort without asking on every chat. Effort is never sent to a model
    // that would reject it.
    if (!takeToken(userId, 'check')) return jsonError(429, 'busy')
    let stored: OpenedKey
    try {
      // Whatever the row's status or model: picking one is how a fresh
      // connection with none becomes usable.
      stored = await openConnectionKey(userId)
    } catch (err) {
      return dbFailure(err, 'connection read')
    }
    if (!stored.ok && stored.reason === 'unavailable') return unavailable()
    if (!stored.ok && stored.reason === 'none') return jsonError(404, 'not_connected')
    // Never hand another provider's key to Anthropic.
    if (stored.ok && stored.row.provider !== 'anthropic') return jsonError(409, 'conflict')

    // An unreadable key or a refused base URL cannot be asked; the model is
    // still stored (setConnectionModel checks the provider), without effort.
    const adapter = getAdapter('anthropic')
    if (stored.ok && adapter.describeModel) {
      try {
        meta = await adapter.describeModel(
          stored.creds,
          model,
          anySignal([req.signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)])
        )
      } catch (err) {
        const e = toProviderError(err, 'anthropic', 'verify')
        logProviderError('model', 'anthropic', e.kind, e.status)
        if (e.kind === 'bad_model') return jsonError(400, 'invalid', { field: 'model' })
        if (e.kind === 'auth') {
          await setConnectionStatus(userId, stored.row.key_ciphertext, 'failing', 'key_rejected').catch(
            () => {}
          )
          return jsonError(400, 'key_rejected')
        }
        // Couldn't ask: store the model without effort. It still works.
        meta = {}
      }
    }
  }

  try {
    const row = await setConnectionModel(userId, provider, model, meta)
    if (row) return jsonOk({ connection: toConnectionView(row, isReadable(row, userId)) })
    // Nothing matched: either another provider's row (the client is stale), or no row at all.
    const now = await readModelConnection(userId)
    return now.kind === 'row' ? jsonError(409, 'conflict') : jsonError(404, 'not_connected')
  } catch (err) {
    return dbFailure(err, 'connection model')
  }
}

async function recheck(req: Request, userId: string): Promise<NextResponse> {
  if (!takeToken(userId, 'check')) return jsonError(429, 'busy')

  // `openConnectionKey`, not `openModelConnection`: "Check again" exists for a
  // failing key, and a connection with no model yet still has a key to check.
  let stored: OpenedKey
  try {
    stored = await openConnectionKey(userId)
  } catch (err) {
    return dbFailure(err, 'connection read')
  }
  if (!stored.ok) {
    switch (stored.reason) {
      case 'unavailable':
        return unavailable()
      case 'none':
        return jsonError(404, 'not_connected')
      case 'blocked_url':
        return jsonError(400, 'blocked_url', { field: 'baseUrl' })
      case 'unreadable':
        // Shown as unreadable from memory; nothing is written (see GET).
        try {
          const now = await readModelConnection(userId)
          if (now.kind !== 'row') return jsonError(404, 'not_connected')
          return jsonOk({ connection: toConnectionView(now.row, false) })
        } catch (err) {
          return dbFailure(err, 'connection read')
        }
    }
  }

  const { row, creds } = stored
  try {
    await getAdapter(row.provider).verify(creds, {
      signal: anySignal([req.signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]),
      modelHint: row.model ?? undefined,
    })
    await setConnectionStatus(userId, row.key_ciphertext, 'ok', null)
  } catch (err) {
    if (err instanceof AiDbError) return dbFailure(err, 'connection status')
    const e = toProviderError(err, row.provider, 'verify')
    logProviderError('recheck', row.provider, e.kind, e.status)
    // Anything but a refused key says nothing about the key: the status stays
    // as it was, and the answer matches what connect would have said.
    if (e.kind !== 'auth') return checkFailure(e.kind)
    try {
      // Conditional on the ciphertext read above: a key replaced meanwhile is untouched.
      await setConnectionStatus(userId, row.key_ciphertext, 'failing', 'key_rejected')
    } catch (dbErr) {
      return dbFailure(dbErr, 'connection status')
    }
  }

  try {
    const now = await readModelConnection(userId)
    if (now.kind !== 'row') return jsonError(404, 'not_connected')
    return jsonOk({ connection: toConnectionView(now.row, isReadable(now.row, userId)) })
  } catch (err) {
    return dbFailure(err, 'connection read')
  }
}

/**
 * "No AI, thanks" for the whole account, or its undo. Touches nothing else:
 * the saved key, the OpenClaw pairing and the transcripts stay as they are. A
 * database without 060 cannot keep the choice, and says so rather than
 * answering ok for a choice that would be gone on the next load.
 */
async function setHidden(userId: string, hidden: boolean): Promise<Response> {
  try {
    const kept = await writeAIHidden(userId, hidden)
    if (!kept) return jsonError(503, 'unavailable')
    return jsonOk({ aiHidden: hidden })
  } catch (err) {
    return dbFailure(err, 'hidden write')
  }
}

export async function PATCH(req: Request): Promise<Response> {
  const user = await requireSessionUser()
  if (!user) return jsonError(401, 'unauthorized')
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden')

  const read = await readJson<unknown>(req, PATCH_MAX_BYTES)
  if (!read.ok) return jsonError(read.status, read.error)
  const body = read.body
  if (!isPlainObject(body)) return jsonError(400, 'invalid')

  // A closed union: exactly one of the three shapes, nothing beside it.
  const keys = Object.keys(body).sort().join(',')
  if (keys === 'hidden' && typeof body.hidden === 'boolean') return setHidden(user.id, body.hidden)
  if (keys === 'recheck' && body.recheck === true) return recheck(req, user.id)
  if (keys === 'model,provider' && isModelProviderId(body.provider)) {
    if (!isModelId(body.model)) return jsonError(400, 'invalid', { field: 'model' })
    return setModel(req, user.id, body.provider, body.model)
  }
  return jsonError(400, 'invalid')
}

// ── DELETE ───────────────────────────────────────────────────────────────────

/**
 * Forget the connection. Idempotent. The key itself stays valid at the
 * provider until the user revokes it there; the panel says so.
 */
export async function DELETE(req: Request): Promise<Response> {
  const user = await requireSessionUser()
  if (!user) return jsonError(401, 'unauthorized')
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden')

  try {
    await deleteModelConnection(user.id)
  } catch (err) {
    return dbFailure(err, 'connection delete')
  }
  return jsonOk({ ok: true })
}
