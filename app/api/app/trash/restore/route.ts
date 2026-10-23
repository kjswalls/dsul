import { postTrashRestore } from '@/lib/app-containers';

/**
 * POST /api/app/trash/restore: put one row of the Trash back where it was.
 *   { kind: 'item' | 'project' | 'routine' | 'season' | 'goal', id }
 * The web's Restore, through the same lib/db.ts call per kind: an item comes
 * back with its co-deleted subtasks, a container with the members it kept.
 * Answers 200 (restored, or already live), 400 `invalid`, 404 `not_found`
 * (no such row of the caller's), 409 `name_taken` (a live project already has
 * the name, folding case; the body names it as `project: { id, name }`) and
 * 409 `parent_gone` (a subtask whose parent is in the Trash too). No webhook,
 * no item_events. The handler is in lib/app-containers.ts.
 */
export function POST(req: Request): Promise<Response> {
  return postTrashRestore(req);
}
