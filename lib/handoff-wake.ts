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

/** The store's hook: after a row update resolved, wake if it was a hand-off. */
export function wakeIfHandedOff(itemId: string, updates: unknown): void {
  if (handsOffToAgent(updates)) wakeAgentFor(itemId);
}
