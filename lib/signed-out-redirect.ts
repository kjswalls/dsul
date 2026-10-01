/**
 * Where a client-side SIGNED_OUT goes when nothing else navigates.
 *
 * The sign-out buttons push /login themselves, but a session can also end
 * underneath the page: a revoked refresh token ("sign out everywhere" on
 * another device, a password change) makes supabase-js emit SIGNED_OUT on
 * whatever route is open. proxy.ts only redirects on a SERVER request, so the
 * page stayed put with `userId: null` — and since lib/planner-ready.ts counts
 * "no account" as pending, the canvas and braindump sat on PlannerSkeleton's
 * "Loading your day…" for good, with nothing saying the user was signed out.
 *
 * A HARD replace, not router.push: it also drops every module-singleton store
 * the provider does not reset by name. On /login and /auth/* it does nothing —
 * those are where a signed-out browser belongs (the same exemptions proxy.ts
 * makes).
 */
export function isSignedOutPath(pathname: string): boolean {
  return pathname === '/login' || pathname.startsWith('/auth');
}

/** Indirected through an object so a test can spy on it (jsdom's location cannot be). */
export const signedOutNav = {
  replace: (url: string) => window.location.replace(url),
};

export function leaveForLoginIfSignedOutPage(): void {
  if (typeof window === 'undefined') return;
  if (isSignedOutPath(window.location.pathname)) return;
  signedOutNav.replace('/login');
}
