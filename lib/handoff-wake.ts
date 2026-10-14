/**
 * Wake the agent once a hand-off has LANDED (ai-vision-decisions.md, decisions
 * 2 and 4, 2026-10-11).
 *
 * Every store write that hands an item to OpenClaw (the right-click "Hand off",
 * the item panel's "Assign to OpenClaw", an undo that puts an assignment back)
 * leaves through planner-store's `dbUpdateItem`, which calls `wakeIfHandedOff`
 * after the row update resolves. A write that failed never wakes: the agent
 * would find nothing.
 *
 * A hand-off to a connected app (Claude, Cursor) wakes it the same way when
 * the person gave it a wake (lib/agent-wake.ts), through /api/agent/app-wake,
 * the ids of a burst gathered into one call.
 *
 * Fire and forget. The wake is a nudge, never the hand-off: a failed or refused
 * one surfaces nothing and undoes nothing, because the agent still finds the
 * item on its next `dsul_my_work` poll. The route
 * (app/api/agent/handoff-wake/route.ts) re-reads the item, so a stale or
 * repeated call costs a 409 or a cooldown, not a second run.
 */

export const HANDOFF_WAKE_PATH = '/api/agent/handoff-wake';

/** lib/agent-handoff.ts `DELEGATE_ASSIGNEE`; not imported, since that module imports the store. */
const DELEGATE = 'openclaw';

/** Does this patch hand the item to the agent? Key presence AND value: clearing it is a take-back. */
export function handsOffToAgent(updates: unknown): boolean {
  return (
    typeof updates === 'object' &&
    updates !== null &&
    'assignee' in updates &&
    (updates as { assignee?: unknown }).assignee === DELEGATE
  );
}

/** POST the wake for one item. Browser only; never throws, never rejects. */
export function wakeAgentFor(itemId: string): void {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return;
  try {
    fetch(HANDOFF_WAKE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId }),
      credentials: 'same-origin',
      // A hand-off just before the tab closes still wakes.
      keepalive: true,
    }).catch(() => {});
  } catch {
    // A fetch that throws synchronously is as quiet as one that rejects.
  }
}

export const APP_WAKE_PATH = '/api/agent/app-wake';

/** Assignee values that are never a connected app (lib/agent-assignees.ts RESERVED). */
const NOT_AN_APP = new Set(['openclaw', 'beacon', 'ai', 'you', 'me']);

/** Does this patch hand the item to a connected app (Claude, Cursor), not OpenClaw? */
export function handsOffToApp(updates: unknown): boolean {
  if (typeof updates !== 'object' || updates === null || !('assignee' in updates)) return false;
  const to = (updates as { assignee?: unknown }).assignee;
  return typeof to === 'string' && to.trim() !== '' && !NOT_AN_APP.has(to.trim().toLowerCase());
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
    // As quiet as OpenClaw's wake: the app still finds the items on its next read.
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

/** The store's hook: after a row update resolved, wake if it was a hand-off. */
export function wakeIfHandedOff(itemId: string, updates: unknown): void {
  if (handsOffToAgent(updates)) wakeAgentFor(itemId);
  else if (handsOffToApp(updates)) wakeAppFor(itemId);
}
