/**
 * Which optional sign-in providers Supabase Auth has switched on, read on the
 * server for the login page.
 *
 * Google and the email link are always offered. Apple is offered only once it
 * is enabled in the Supabase dashboard (memory/plans/sign-in-with-apple.md),
 * so the button can ship ahead of that setup and appear on its own once the
 * provider works, instead of leading to GoTrue's "provider is not enabled"
 * error page.
 *
 * The answer is GoTrue's public `GET /auth/v1/settings`, whose `external` map
 * says which providers are on. It fails closed: no env, a slow or failed
 * request, or an unexpected body all mean "not offered", and the page still
 * has Google and email. The answer is kept per server instance for a few
 * minutes so a login render rarely waits on it, and a failure is kept only
 * briefly so a blip doesn't hide the button for long.
 */

export interface SignInProviders {
  apple: boolean;
}

const NONE: SignInProviders = { apple: false };

/** How long an answer is reused. Turning Apple on shows the button within this. */
export const PROVIDERS_TTL_MS = 5 * 60 * 1000;
/** How long a failed read is reused before asking again. */
export const PROVIDERS_RETRY_MS = 30 * 1000;
/** The longest a login render waits for GoTrue before rendering without Apple. */
export const PROVIDERS_TIMEOUT_MS = 1500;

let memo: { value: SignInProviders; until: number } | null = null;

export async function signInProviders(now: number = Date.now()): Promise<SignInProviders> {
  if (memo && now < memo.until) return memo.value;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NONE;

  let value = NONE;
  let ok = false;
  try {
    const res = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: key },
      cache: 'no-store',
      signal: AbortSignal.timeout(PROVIDERS_TIMEOUT_MS),
    });
    if (res.ok) {
      const body: unknown = await res.json();
      const external = (body as { external?: Record<string, unknown> } | null)?.external;
      value = { apple: external?.apple === true };
      ok = true;
    }
  } catch {
    // Fails closed below.
  }
  memo = { value, until: now + (ok ? PROVIDERS_TTL_MS : PROVIDERS_RETRY_MS) };
  return value;
}

/** Tests only: forget the kept answer. */
export function __resetSignInProvidersForTests(): void {
  memo = null;
}
