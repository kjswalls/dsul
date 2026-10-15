/**
 * Wake a connected app (Claude, Cursor) once a hand-off to it has LANDED, when
 * the person gave it a wake (lib/agent-wake.ts), through /api/agent/app-wake,
 * the ids of a burst gathered into one call.
 *
 * Every store write that hands an item over (the right-click "Hand off", the
 * item panel's assignee, an undo that puts an assignment back) leaves through
 * planner-store's `dbUpdateItem`, which calls `wakeIfHandedOff` after the row
 * update resolves. A write that failed never wakes: the app would find nothing.
 *
 * OpenClaw is never woken from here. It holds GET /api/agent/events open and
 * hears its own work (lib/openclaw-setup.ts); the plugin's webhook wake
 * (/api/agent/handoff-wake) is retired.
 *
 * Fire and forget. The wake is a nudge, never the hand-off: a failed or refused
 * one surfaces nothing and undoes nothing, because the app still finds the item
 * the next time it reads `dsul_my_work`. The route re-reads the items, so a
 * stale or repeated call costs a cooldown, not a second run.
 */

export const APP_WAKE_PATH = '/api/agent/app-wake';

/** Assignee values that are never a connected app (lib/agent-assignees.ts RESERVED). */
const NOT_AN_APP = new Set(['openclaw', 'beacon', 'ai', 'you', 'me']);

/** Is this assignee a connected app (Claude, Cursor), the kind a wake reaches? */
export function isAppAssignee(assignee: string | undefined | null): boolean {
  return typeof assignee === 'string' && assignee.trim() !== '' && !NOT_AN_APP.has(assignee.trim().toLowerCase());
}

/** Does this patch hand the item to a connected app (Claude, Cursor), not OpenClaw? */
export function handsOffToApp(updates: unknown): boolean {
  if (typeof updates !== 'object' || updates === null || !('assignee' in updates)) return false;
  const to = (updates as { assignee?: unknown }).assignee;
  return typeof to === 'string' && isAppAssignee(to);
}

/**
 * A connected app's wake starts a whole run (lib/agent-wake.ts), and make it so
 * hands a lane over as a burst of writes, so the ids gather here and leave as
 * one call once the burst has gone quiet. The server groups them by app.
 */
const GATHER_MS = 800;
const MAX_IDS = 50;
let gathered: string[] = [];
let gatherTimer: ReturnType<typeof setTimeout> | null = null;

function flushAppWake(): void {
  gatherTimer = null;
  const ids = gathered;
  gathered = [];
  if (ids.length === 0) return;
  try {
    fetch(APP_WAKE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: ids }),
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => {});
  } catch {
    // A fetch that throws synchronously is as quiet as one that rejects: the
    // app still finds the items on its next read.
  }
}

/** Queue one item for its app's wake. Browser only; never throws. */
export function wakeAppFor(itemId: string): void {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return;
  if (!gathered.includes(itemId)) gathered.push(itemId);
  if (gathered.length >= MAX_IDS) {
    if (gatherTimer) clearTimeout(gatherTimer);
    flushAppWake();
    return;
  }
  if (gatherTimer) clearTimeout(gatherTimer);
  gatherTimer = setTimeout(flushAppWake, GATHER_MS);
}

/**
 * Does this patch put the item back in its agent's queue without naming the
 * agent? Answering a blocked question (lib/agent-question.ts) and Try again
 * write only `{aiStatus: 'queued'}`. OpenClaw hears that on its event feed, but
 * a connected app runs only when woken, so without this an answer to Claude
 * sat on the trail and nothing ever read it. The patch cannot say whose queue
 * it is; the route re-reads the row and wakes only an app, so a re-queue for
 * OpenClaw costs one call that wakes nothing.
 */
export function requeues(updates: unknown): boolean {
  return (
    typeof updates === 'object' &&
    updates !== null &&
    !('assignee' in updates) &&
    (updates as { aiStatus?: unknown }).aiStatus === 'queued'
  );
}

/** The store's hook: after a row update resolved, wake if it handed the item to an app, or re-queued it. */
export function wakeIfHandedOff(itemId: string, updates: unknown): void {
  if (handsOffToApp(updates) || requeues(updates)) wakeAppFor(itemId);
}
