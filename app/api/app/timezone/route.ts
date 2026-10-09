import { postTimezone } from '@/lib/app-api';

/**
 * POST /api/app/timezone — the iPhone's zone, stored as the account's: the
 * twin of the web's PATCH /api/user/timezone, behind the bearer. Bearer
 * Supabase access token only (lib/app-auth.ts); the handler is in
 * lib/app-api.ts.
 */
export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return postTimezone(req);
}
