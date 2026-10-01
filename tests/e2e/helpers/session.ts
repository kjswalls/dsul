import type { Cookie } from '@playwright/test';

/**
 * Encode a Supabase session the way @supabase/ssr stores it, so a session
 * obtained in Node can be injected into a browser context as cookies.
 *
 * Extracted from the old helpers/auth.ts so globalSetup and per-test login share
 * ONE implementation — a drift here breaks the entire suite, and not always
 * loudly. A cookie the app finds no session in is sent to /login, by proxy.ts
 * (its gate is live under .env.test, which sets no NEXT_PUBLIC_DISABLE_AUTH; a
 * local `next dev` also reads .env.local, which can switch it off) and by the
 * provider's own no-session check (lib/signed-out-redirect.ts). A cookie the
 * decoder throws on is quieter: proxy.ts fails open, the browser client rejects
 * it too, and every page sits on its loading skeleton.
 *
 * Cookie encoding (matches @supabase/ssr v0.9 defaults):
 *   name:  sb-<project-ref>-auth-token   (ref = the URL's first hostname label)
 *   value: "base64-" + base64url(UTF-8(JSON.stringify(session)))
 *   chunked into `<name>.0`, `.1`, … when the URI-encoded value exceeds 3180 B.
 */

const MAX_CHUNK_SIZE = 3180;

export interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  user?: { id?: string };
  [key: string]: unknown;
}

/** Exchange email/password for a session via the Supabase REST API. */
export async function passwordGrant(
  supabaseUrl: string,
  anonKey: string,
  email: string,
  password: string
): Promise<SupabaseSession> {
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.text();
    // 429 is the one worth calling out: Supabase rate-limits the token endpoint
    // to ~30 requests / 5 min / IP, which a per-test grant blows through.
    const hint =
      res.status === 429
        ? ' — Supabase auth rate limit. The suite is meant to authenticate ONCE in globalSetup; a per-test grant will hit this.'
        : '';
    throw new Error(`Supabase password grant failed (${res.status}): ${body}${hint}`);
  }

  return (await res.json()) as SupabaseSession;
}

/** Cookie name base for a project URL, e.g. sb-abcdef-auth-token. */
export function cookieBaseName(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
}

/**
 * Encode a session as browser cookies for `localhost`.
 *
 * `httpOnly: false` because @supabase/ssr's browser client reads them from JS;
 * `secure: false` because local dev and CI both serve plain http.
 */
export function sessionCookies(supabaseUrl: string, session: SupabaseSession): Cookie[] {
  const name = cookieBaseName(supabaseUrl);
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;

  const base = {
    domain: 'localhost',
    path: '/',
    httpOnly: false,
    secure: false,
    sameSite: 'Lax' as const,
    // ~400 days, matching DEFAULT_COOKIE_OPTIONS.maxAge in @supabase/ssr.
    expires: Math.floor(Date.now() / 1000) + 400 * 24 * 60 * 60,
  };

  // The library measures the URI-ENCODED length before deciding to chunk. The
  // base64url alphabet is entirely URL-safe so encoding never inflates it, but
  // measure the encoded form anyway to stay faithful to the library.
  const encoded = encodeURIComponent(value);
  if (encoded.length <= MAX_CHUNK_SIZE) {
    return [{ ...base, name, value }];
  }

  const cookies: Cookie[] = [];
  let remaining = encoded;
  let i = 0;
  while (remaining.length > 0) {
    let head = remaining.slice(0, MAX_CHUNK_SIZE);
    // Never cut inside a %-escape.
    const lastPct = head.lastIndexOf('%');
    if (lastPct > MAX_CHUNK_SIZE - 3) head = head.slice(0, lastPct);
    cookies.push({ ...base, name: `${name}.${i}`, value: decodeURIComponent(head) });
    remaining = remaining.slice(head.length);
    i++;
  }
  return cookies;
}

/**
 * Whose local state the seed below is.
 *
 * lib/local-state.ts stamps this key with the signed-in account and clears the
 * browser's per-user stores whenever what it finds disagrees — including when
 * it finds NOTHING, because an unstamped browser holding state is a browser
 * where nothing on disk records who wrote it, and that is exactly the shared-
 * machine case the stamp exists for.
 *
 * WITHOUT this, the fixture is self-contradictory: `seededViewState()` puts one
 * account's view prefs on disk and `sessionCookies()` signs that same account
 * in, but nothing on disk says the two belong together — so the app treats a
 * legitimately-seeded browser as an orphaned one and clears what it can before
 * the first assertion runs.
 *
 * SEEDED HERE RATHER THAN PER-SPEC, deliberately. This fixture's job is to
 * present the browser of a user who has signed in on this machine before, and
 * as of lib/local-state.ts that state includes the stamp exactly as much as it
 * includes the auth cookie. An unstamped browser is a real state, but it is the
 * one-time transitional one — the first load after the feature ships — not the
 * steady state 119 specs should each be re-establishing by hand. Seeding it
 * beside the view prefs also keeps the two in step: a spec that seeded prefs and
 * forgot the stamp would silently get them half-cleared, which is precisely the
 * N-copies-to-keep-in-step problem the feature under test was written to end.
 */
export function seededOwnerState(userId: string): { name: string; value: string } {
  return { name: 'dsul-local-state-owner', value: userId };
}

/**
 * Everything the fixture puts in localStorage, in one list.
 *
 * globalSetup writes it into `storageState`; `injectFreshSession` replays the
 * same list through an init script for the few specs that mint their own
 * session. One source so the two can never drift.
 */
export function seededLocalStorage(userId: string): Array<{ name: string; value: string }> {
  return [seededViewState(), seededOwnerState(userId)];
}

/**
 * The view-store's persisted shape, seeded so every test starts in Day ×
 * Buckets regardless of what another test left behind.
 *
 * `adoptedLegacy: true` is the load-bearing field: without it, adoptLegacyViewPrefs
 * (lib/view-store.ts) copies the SERVER-side user_settings.default_view into the
 * store on first mount — and setScope mirrors into that column — so one spec
 * switching to Week leaks into every other spec's fresh context, where it makes
 * the date chevrons step 7 days and removes [data-dnd-bucket] entirely.
 */
export function seededViewState(): { name: string; value: string } {
  return {
    name: 'dsul-view',
    value: JSON.stringify({
      version: 1,
      state: {
        scope: 'day',
        layout: 'buckets',
        typeFilter: 'all',
        canvasGroupBy: 'none',
        braindumpGroupBy: 'none',
        typeMode: 'sans',
        adoptedLegacy: true,
      },
    }),
  };
}
