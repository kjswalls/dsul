import { getPlanner } from '@/lib/app-api';

/**
 * GET /api/app/planner — the iPhone app's read: the signed-in user's items,
 * projects, routines, seasons and goals, plus the settings and extension
 * switches the phone reads (AppPlannerPayload in lib/app-api.ts). Bearer
 * Supabase access token only (lib/app-auth.ts); the handler is in
 * lib/app-api.ts.
 */
export const dynamic = 'force-dynamic';

export function GET(req: Request): Promise<Response> {
  return getPlanner(req);
}
