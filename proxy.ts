import { createServerClient } from '@supabase/ssr';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { canonicalRedirect } from '@/lib/canonical-host';
import { marketingRewrite, SIGNED_IN_HINT, signedInHintOptions } from '@/lib/marketing-site';
import { isSignedOutPath, loginPathFor } from '@/lib/signed-out-redirect';

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // A production request on a *.vercel.app alias goes to do.dsul.app, and an
  // auth code dropped at the root goes to /auth/callback — both before any
  // cookie is read or written on the wrong domain. See lib/canonical-host.ts.
  // 307, not 308, for the reason next.config gives its apex redirect: a
  // permanent redirect sticks in the browser and cannot be taken back.
  const canonical = canonicalRedirect(new URL(request.url), process.env.VERCEL_ENV);
  if (canonical) {
    return NextResponse.redirect(canonical, 307);
  }

  // dsul.app's root (and /welcome on any host, for previews) is the marketing
  // page, a static file with no account behind it: served before the gate, so
  // a visitor with no session sees it instead of being sent to /login. Every
  // other apex path never gets here; next.config.mjs sends it to do.dsul.app.
  // See lib/marketing-site.ts.
  const marketing = marketingRewrite(new URL(request.url));
  if (marketing) {
    return NextResponse.rewrite(new URL(marketing, request.url));
  }

  // Allow disabling auth for v0 preview / local dev. The server gate only: a
  // page with no session stored still leaves for /login from the browser,
  // which reads no flag (lib/signed-out-redirect.ts leaveForLoginIfNoSession).
  if (process.env.NEXT_PUBLIC_DISABLE_AUTH === 'true') {
    return NextResponse.next({ request });
  }

  // If env vars are missing, skip auth checks entirely (e.g. build/preview without vars)
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value)
            );
            supabaseResponse = NextResponse.next({ request });
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options)
            );
          },
        },
      }
    );

    // Refresh session if expired
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    // Redirect unauthenticated users to /login, carrying where they were going
    // as ?redirect= (lib/signed-out-redirect.ts). This used to keep only the
    // query: /connect?code=… (the OpenClaw pairing link) arrived as
    // /login?code=…, a sign-in then landed on '/' with the code gone, and the
    // desktop shell dropped the redirect outright, reading a top-level `code` as
    // an auth code (electron/lib/policy.cjs carriesAuthCode).
    // Skip API routes — they use Bearer auth and return their own 401s.
    const isApiRoute = pathname === '/api' || pathname.startsWith('/api/');
    // dsul.app's "log in" reads "open your planner" while this flag is set
    // (lib/marketing-site.ts SIGNED_IN_HINT). A page request answers it; an API
    // route never does. Cleared only when the session is really gone: a network
    // failure says nothing about the session, and the next good request heals it.
    const hint: SignedInHint = isApiRoute
      ? 'keep'
      : user
        ? 'set'
        : isAuthRetryableFetchError(userError)
          ? 'keep'
          : 'clear';

    if (!user && !isSignedOutPath(pathname) && !isApiRoute) {
      const login = loginPathFor(`${pathname}${request.nextUrl.search}`, request.nextUrl.origin);
      return withSignedInHint(NextResponse.redirect(new URL(login, request.url)), request, hint);
    }

    // Redirect authenticated users away from /login
    if (user && pathname === '/login') {
      const url = request.nextUrl.clone();
      url.pathname = '/';
      return withSignedInHint(NextResponse.redirect(url), request, hint);
    }

    return withSignedInHint(supabaseResponse, request, hint);
  } catch (err) {
    console.error('[middleware] Supabase error:', err);
    // On error, allow the request through rather than blocking with a 404
    return NextResponse.next({ request });
  }
}

type SignedInHint = 'set' | 'clear' | 'keep';

/**
 * Writes or drops the signed-in hint on `res`, only when it would change: a
 * signed-in browser that already carries it gets no Set-Cookie at all. Read on
 * this host, a Domain=dsul.app cookie arrives here too, so the check sees one
 * do.dsul.app wrote for the whole domain.
 */
function withSignedInHint(res: NextResponse, request: NextRequest, hint: SignedInHint): NextResponse {
  const has = request.cookies.get(SIGNED_IN_HINT)?.value === '1';
  const options = signedInHintOptions(new URL(request.url));
  if (hint === 'set' && !has) res.cookies.set(SIGNED_IN_HINT, '1', options);
  if (hint === 'clear' && request.cookies.has(SIGNED_IN_HINT)) {
    res.cookies.set(SIGNED_IN_HINT, '', { ...options, maxAge: 0 });
  }
  return res;
}

// /manifest.json and /sw.js are left out with the icons, because the browser
// fetches them on its own and the gate cannot tell who is asking. A
// <link rel=manifest> goes out WITHOUT cookies unless it says
// crossorigin="use-credentials", so the gate took every visitor, signed in
// included, for a signed-out one and answered with the login page's HTML:
// Chrome, Edge and Android never got a manifest to parse, so no install prompt
// and no app name or icons. A service worker's update check from a browser
// whose session has ended met the same redirect and failed as one. Neither file
// holds anything an account owns.
//
// /site/ is the marketing page's folder under public/ (lib/marketing-site.ts):
// the page and its fonts, which hold nothing of anyone's. Left out so a font
// fetch costs no getUser() and never meets the login redirect. The page itself
// is reached by a rewrite from / on the apex, which does run here.
//
// /mods/sandbox/<version> is the mod sandbox frame (app/mods/sandbox/[v]),
// which holds no account data either: left out so a frame load costs no
// getUser() and a signed-out moment cannot put the login page inside the
// frame. The exact segment, not a mods/ prefix, so any later /mods/* page is
// still gated (tests/unit/proxy-matcher.test.ts).
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|mods/sandbox/|site/|favicon.ico|icon|apple-icon|manifest\\.json$|sw\\.js$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
