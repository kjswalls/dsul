import { requireSessionUser } from '@/app/api/ai/_shared/guard'
import {
  AiDbError,
  readModelConnection,
  saveModelConnection,
  type ModelConnectionRow,
} from '@/lib/ai-server/connections'
import { logProviderError, toProviderError } from '@/lib/ai-server/errors'
import {
  exchangeOpenRouterCode,
  openPkceCookie,
  PKCE_COOKIE,
  PKCE_COOKIE_PATH,
  pkceStateMatches,
} from '@/lib/ai-server/pkce'
import { credentialsFor, getAdapter, type VerifyResult } from '@/lib/ai-server/providers'
import { takeToken } from '@/lib/ai-server/rate-limit'
import { loadEncryptionKey } from '@/lib/ai-server/secret-box'
import { anySignal } from '@/lib/ai-server/stream'

/**
 * GET /api/ai/openrouter/callback/<state>?code=…: "Sign in with OpenRouter",
 * step two.
 *
 * Order is the security property here. Nothing before the state comparison
 * makes an outbound request: the sealed cookie must open for THIS user, and
 * the state in the path must equal the one sealed in it, or the code is never
 * exchanged. That binds the callback to the browser that started the flow, so
 * a code minted for someone else's OpenRouter account cannot be planted here.
 *
 * The issued key is verified, stored encrypted, and never sent to the browser.
 * Every exit clears the cookie and lands on the settings pane with a result
 * flag.
 *
 * "Sign in again" (a revoked or expired OpenRouter key) runs this same flow,
 * so it keeps the model the user already picked, as "Replace key" does on the
 * key path, rather than quietly swapping it for the provider's default.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SETTINGS_PATH = '/settings/beacon'
const STEP_TIMEOUT_MS = 10_000
/** RFC 3986 unreserved characters, a sane length. Anything else never leaves this server. */
const CODE_RE = /^[A-Za-z0-9._~-]{8,512}$/

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * The model an OpenRouter row already holds, when the new key can still use
 * it: listed in the catalog just fetched, and free when the key is on the free
 * tier (a paid pick would only fail there). Otherwise null, and the default
 * applies.
 */
function keptModel(existing: ModelConnectionRow | null, list: VerifyResult): string | null {
  if (!existing || existing.provider !== 'openrouter' || !existing.model) return null
  const entry = list.models.find((m) => m.id === existing.model)
  if (!entry) return null
  if (list.freeTier && entry.free !== true) return null
  return entry.id
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ state: string }> }
): Promise<Response> {
  const url = new URL(req.url)
  const origin = url.origin
  const secure = url.protocol === 'https:'

  const done = (location: string): Response => {
    const headers = new Headers({
      Location: location,
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    })
    headers.append(
      'Set-Cookie',
      `${PKCE_COOKIE}=; Path=${PKCE_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax` +
        (secure ? '; Secure' : '')
    )
    return new Response(null, { status: 303, headers })
  }
  const back = (result: string) => done(`${origin}${SETTINGS_PATH}?connect=${result}`)

  // 1-4: who, and is this the flow they started. No outbound call until all pass.
  const user = await requireSessionUser()
  if (!user) return done(`${origin}/login?redirect=${encodeURIComponent(SETTINGS_PATH)}`)

  const key = loadEncryptionKey()
  if (!key.ok) return back('unavailable')

  let verifier: string
  try {
    const flow = openPkceCookie(readCookie(req, PKCE_COOKIE), user.id, key.key)
    if (!flow) return back('expired')
    const { state } = await params
    if (!pkceStateMatches(flow.state, state)) return back('expired')
    verifier = flow.verifier
  } catch {
    return back('expired')
  }

  // 5-6: what OpenRouter sent.
  if (url.searchParams.has('error')) return back('denied')
  const code = url.searchParams.get('code')
  if (!code) return back('denied')
  if (!CODE_RE.test(code)) return back('failed')

  // The row this sign-in replaces (its model is kept, step 9), read before a
  // key is minted: a server that cannot store one should not have OpenRouter
  // issue it. Our database, not an outbound call.
  let existing: ModelConnectionRow | null
  try {
    const read = await readModelConnection(user.id)
    if (read.kind === 'unavailable') return back('unavailable')
    existing = read.kind === 'row' ? read.row : null
  } catch (err) {
    // Never the error object: a database error's details can carry the row.
    if (err instanceof AiDbError) console.warn('[ai] db', err.op, 'failed', err.code)
    else console.warn('[ai] openrouter-callback read failed')
    return back('failed')
  }

  // 7: whether this user may spend another connect.
  if (!takeToken(user.id, 'connect')) return back('busy')

  // 8: the exchange, server to server. The key never reaches the browser.
  let apiKey: string
  try {
    apiKey = await exchangeOpenRouterCode(
      code,
      verifier,
      anySignal([req.signal, AbortSignal.timeout(STEP_TIMEOUT_MS)])
    )
  } catch (err) {
    const e = toProviderError(err, 'openrouter', 'verify')
    logProviderError('openrouter-exchange', 'openrouter', e.kind, e.status)
    return back('failed')
  }

  // 9: the same check a pasted key gets, then store it, keeping the user's
  // own pick when the new key can still use it.
  try {
    const creds = credentialsFor('openrouter', null, apiKey)
    const adapter = getAdapter('openrouter')
    const signal = anySignal([req.signal, AbortSignal.timeout(STEP_TIMEOUT_MS)])
    const verified = await adapter.verify(creds, { signal })
    const list: VerifyResult = { ...(await adapter.listModels(creds, signal)), freeTier: verified.freeTier }
    const model = keptModel(existing, list) ?? adapter.pickDefaultModel(list)
    await saveModelConnection(user.id, {
      provider: 'openrouter',
      baseUrl: null,
      model,
      modelMeta: {},
      authMethod: 'oauth',
      apiKey,
    })
  } catch (err) {
    // Never the error object: a database error's details can carry the row.
    if (err instanceof AiDbError) {
      console.warn('[ai] db', err.op, 'failed', err.code)
    } else {
      const e = toProviderError(err, 'openrouter', 'verify')
      logProviderError('openrouter-callback', 'openrouter', e.kind, e.status)
    }
    return back('failed')
  }

  return back('ok')
}
