/**
 * The settle epoch — a counter bumped once per preview → fresh landing.
 *
 * The settle conductor (lib/settle.ts) owns that edge: it moves every row
 * from where the cached preview drew it to where the fresh data puts it. A row
 * whose completion differs between the two was ticked ELSEWHERE, not here, so
 * the completed-sinks hold (hooks/use-sink-hold.ts) must not mistake it for a
 * live tick and slide it a second time 700ms later. It reads this counter and,
 * on a change, adopts the fresh completion with no hold.
 *
 * Its own module, dependency-free, so the hook can read it without importing
 * the conductor (and through it the planner store). Bumped inside the landing
 * set(), before React commits, so the render that first shows fresh data
 * already sees the new epoch.
 */

let epoch = 0;

/** The current epoch. Compare against a remembered value; the number itself means nothing. */
export function settleEpoch(): number {
  return epoch;
}

/** Marks a preview → fresh landing. Called by the conductor on that edge, whatever the outcome of its capture. */
export function bumpSettleEpoch(): void {
  epoch += 1;
}
