import { getTrash } from '@/lib/app-containers';

/**
 * GET /api/app/trash: the iPhone app's Trash, the last 30 days of deleted
 * items, projects, routines, seasons and goals, newest first, as the web's
 * Trash lists them (lib/db.ts listDeleted). Each row is trimmed to what the
 * phone draws: `{ entries: [{ kind, id, name, deletedAt, icon?, color?,
 * itemType?, childCount?, memberCount? }] }` (AppTrashRow in
 * lib/app-containers.ts). Never cached. Bearer Supabase access token only
 * (lib/app-auth.ts); the handler is in lib/app-containers.ts.
 */
export const dynamic = 'force-dynamic';

export function GET(req: Request): Promise<Response> {
  return getTrash(req);
}
