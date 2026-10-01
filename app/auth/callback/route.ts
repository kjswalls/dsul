import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { safeNext } from '@/lib/safe-next';

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

  // Auth error — redirect to login with error param
  return NextResponse.redirect(`${origin}/login?error=${kind}`);
}
