import { NextResponse } from 'next/server';

/**
 * GET /api/app/config — where the iPhone app finds Supabase Auth.
 *
 * The app talks to GoTrue (/auth/v1/*) directly for sign-in and refresh, and
 * to /api/app/* for data. Serving the two values from here keeps every
 * environment-specific value out of ios/, and the app asks only when it first
 * needs Auth, so a signed-out launch makes no request at all.
 *
 * No auth, and nothing here is secret: both values are NEXT_PUBLIC_ and ship in
 * the web bundle already. The service-role key is never read in this file.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
  return NextResponse.json(
    { supabaseUrl, anonKey },
    { headers: { 'Cache-Control': 'public, max-age=3600' } },
  );
}
