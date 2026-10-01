import { isSameOriginNavigation, requireSessionUser } from '@/app/api/ai/_shared/guard'
import {
  createPkcePair,
  openRouterAuthUrl,
  openRouterCallbackUrl,
  PKCE_COOKIE,
  PKCE_COOKIE_PATH,
  PKCE_MAX_AGE_S,
  sealPkceCookie,
} from '@/lib/ai-server/pkce'
import { loadEncryptionKey } from '@/lib/ai-server/secret-box'

/**
 * GET /api/ai/openrouter/start: "Sign in with OpenRouter", step one.
 *
 * A top-level navigation from the settings panel's link. It arms a short-lived,
 * sealed, HttpOnly cookie holding the PKCE verifier and a random `state`, then
 * sends the browser to OpenRouter with a callback URL whose PATH carries that
 * state. The callback refuses any request whose path state does not match the
 * sealed one, before it makes a single outbound call.
 *
 * Arming the cookie is not harmless, so a start from another site (or a
 * sibling subdomain) is refused and sets nothing.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SETTINGS_PATH = '/settings/beacon'

function redirect(location: string, status: 302 | 303 = 303): Response {
  return new Response(null, {
    status,
    headers: {
      Location: location,
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    },
  })
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  // The cookie is host-scoped, so the flow must come back to the host it started on.
  const origin = url.origin
  const back = (result: string) => redirect(`${origin}${SETTINGS_PATH}?connect=${result}`)

  const user = await requireSessionUser()
  if (!user) return redirect(`${origin}/login?redirect=${encodeURIComponent(SETTINGS_PATH)}`)
  if (!isSameOriginNavigation(req)) return back('failed')

  const key = loadEncryptionKey()
  if (!key.ok) return back('unavailable')

  let location: string
  let cookie: string
  try {
    const flow = createPkcePair()
    cookie = sealPkceCookie({ verifier: flow.verifier, state: flow.state }, user.id, key.key)
    location = openRouterAuthUrl(openRouterCallbackUrl(origin, flow.state), flow.challenge)
  } catch {
    return back('failed')
  }

  const res = redirect(location, 302)
  res.headers.append(
    'Set-Cookie',
    `${PKCE_COOKIE}=${encodeURIComponent(cookie)}; Path=${PKCE_COOKIE_PATH}; Max-Age=${PKCE_MAX_AGE_S}; HttpOnly; SameSite=Lax` +
      (url.protocol === 'https:' ? '; Secure' : '')
  )
  return res
}
