import { resolvePauseWrite, type Pausable } from './active';
import { isPausable } from './item-registry';
import { toDateStr } from './recurrence';
import type { Item } from './planner-types';

/**
 * The pause VERB on one items row the caller has already read, shared by the
 * two server doors that take it: the agent API's PATCH (lib/agent-api.ts
 * pausePatchForItem) and the iPhone app's `pause` intent (lib/app-api.ts
 * postItemWrite). Two copies of "who may be paused, and what does pausing
 * write" would answer the same request differently the first time one moved.
 *
 * Pure. Each caller reads the row and the user's zone its own way (the agent
 * API falls back to UTC on a failed settings read, the app route answers it as
 * an error) and passes them in. The interval rules themselves are
 * resolvePauseWrite's (lib/active.ts), stated once beside the predicate that
 * reads them; this module adapts a snake_case row to it and asks the registry
 * who may be paused at all.
 */

/** The columns a pause decision reads. */
export interface PauseRow {
  type: string;
  parent_item_id?: string | null;
  paused_at?: string | null;
  paused_until?: string | null;
}

/** The verb as a body carries it: `paused` and/or `pausedUntil`. */
export interface PauseRequest {
  paused?: boolean;
  pausedUntil?: string | null;
}

/**
 * The two fields isPausable/isCollectible actually read, wearing an Item's
 * shape so the REGISTRY stays the authority.
 *
 * Re-deriving "subtasks aren't collectible" from a raw row here would be a
 * second copy of a rule the registry already owns, and the copies would drift
 * the first time a capability changes. The cast is narrow on purpose — these
 * predicates touch `type`, `customType` and `parentItemId`, nothing else.
 *
 * It lives here rather than in the agent API because the pause gate below is
 * the question both doors ask of a raw row; the agent API's membership and
 * role guards ask it too, and import it from here.
 */
export function capabilityShape(row: { type: string; parent_item_id?: string | null }): Item {
  const parentItemId = row.parent_item_id ?? undefined;
  if (row.type === 'task' || row.type === 'habit') {
    return { type: row.type, parentItemId } as unknown as Item;
  }
  return { type: 'custom', customType: row.type, parentItemId } as unknown as Item;
}

/** May this row be paused? The registry's isPausable: a pausable type, and not a subtask. */
export function isPausableRow(row: PauseRow): boolean {
  return isPausable(capabilityShape(row));
}

/**
 * The column patch for `req` against the row's CURRENT pause (resolvePauseWrite
 * needs it to leave `pausedAt` alone when a pause is already running), or the
 * reason it cannot be honoured. An empty patch means already satisfied: write
 * nothing.
 *
 * `today` and a fresh `pausedAt` stamp both come off the one `now`, so they
 * cannot straddle midnight. Ask {@link isPausableRow} first; this does not.
 */
export function resolveItemPause(
  row: PauseRow,
  req: PauseRequest,
  timeZone: string,
  now: Date,
): { patch: Pausable } | { reason: string } {
  return resolvePauseWrite(
    { pausedAt: row.paused_at ?? undefined, pausedUntil: row.paused_until ?? undefined },
    req,
    toDateStr(now, timeZone),
    now.toISOString(),
    timeZone,
  );
}
