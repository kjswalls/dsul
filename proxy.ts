import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { canonicalRedirect } from '@/lib/canonical-host';

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

  // Allow disabling auth for v0 preview / local dev without a real session
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
    const { data: { user } } = await supabase.auth.getUser();

    // Redirect unauthenticated users to /login.
    // Skip API routes — they use Bearer auth and return their own 401s.
    const isApiRoute = pathname === '/api' || pathname.startsWith('/api/');
    if (!user && pathname !== '/login' && !pathname.startsWith('/auth') && !isApiRoute) {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      return NextResponse.redirect(url);
    }

    // Redirect authenticated users away from /login
    if (user && pathname === '/login') {
      const url = request.nextUrl.clone();
      url.pathname = '/';
      return NextResponse.redirect(url);
    }
  } catch (err) {
    console.error('[middleware] Supabase error:', err);
    // On error, allow the request through rather than blocking with a 404
    return NextResponse.next({ request });
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon|apple-icon|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
