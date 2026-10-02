import { getPlanner } from '@/lib/app-api';

/**
 * GET /api/app/planner — the iPhone app's read: the signed-in user's items,
 * projects, routines and seasons, plus the two settings Today needs. Bearer
 * Supabase access token only (lib/app-auth.ts); the handler is in
 * lib/app-api.ts.
 */
export const dynamic = 'force-dynamic';

export function GET(req: Request): Promise<Response> {
  return getPlanner(req);
}
