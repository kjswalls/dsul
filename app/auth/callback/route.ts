import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { safeNext } from '@/lib/safe-next';
import { loginPathFor } from '@/lib/signed-out-redirect';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = safeNext(searchParams.get('next'), origin);

  // Which of the login page's own messages a failure shows (lib/auth-redirect.ts).
  let kind = 'auth';
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    // GoTrue's PKCE flow state lives 300s. The desktop app's handoff can
    // outlast it (the browser's "Open dsul?" prompt waits on the user), and the
    // login page has its own words for that. Only the code is read, never text.
    if (error.code === 'flow_state_expired') kind = 'expired';
  }

  // Auth error — back to the login page with the error, and with `next` as its
  // `redirect` so a retry still goes where this attempt was going: a magic link
  // a mail scanner already spent, or a cancelled Google sign-in, otherwise
  // retried /connect?code=… onto '/' with the pairing code gone. loginPathFor
  // carries it as proxy.ts does, encoded in one parameter so a carried `code`
  // never surfaces top-level. The desktop app's callback has no `next`, so its
  // failures stay bare /login?error=.
  const login = new URL(loginPathFor(next, origin), origin);
  login.searchParams.set('error', kind);
  return NextResponse.redirect(login);
}
