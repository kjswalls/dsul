/**
 * The one domain production is served on. Supabase Auth falls back to its
 * project "Site URL" whenever a `redirectTo` isn't on its allow list, and a
 * Site URL left on the `*.vercel.app` alias lands a fresh login there instead
 * of here. The proxy sends any production request that arrives on a Vercel
 * alias back to this host, path and query intact, so the code is exchanged on
 * the domain whose cookie holds the PKCE verifier.
 */
export const CANONICAL_HOST = 'do.dsul.app';

/**
 * Where a request on `url` should go instead, or null to serve it as is.
 *
 * Two moves, either or both:
 * - Production on a `*.vercel.app` alias goes to `CANONICAL_HOST`. Preview
 *   deployments live on `*.vercel.app` by design and stay put.
 * - The Site URL fallback returns to the site ROOT (`/?code=…`), not to
 *   `/auth/callback`, and nothing at `/` exchanges a code — the auth gate
 *   bounces it to /login and the login is lost. A code at the root is sent to
 *   the callback, which is where every `redirectTo` we build points anyway.
 *
 * API routes are left alone so a Bearer client or a cron hitting the alias
 * never has a POST bounced through a redirect.
 */
export function canonicalRedirect(url: URL, vercelEnv: string | undefined): URL | null {
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return null;

  const target = new URL(url.toString());
  let moved = false;

  if (vercelEnv === 'production' && url.hostname.endsWith('.vercel.app')) {
    target.protocol = 'https:';
    target.hostname = CANONICAL_HOST;
    target.port = '';
    moved = true;
  }

  if (url.pathname === '/' && url.searchParams.has('code')) {
    target.pathname = '/auth/callback';
    moved = true;
  }

  return moved ? target : null;
}
