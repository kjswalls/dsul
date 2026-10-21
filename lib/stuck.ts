/**
 * STUCK: an item the person keeps moving to another day (memory/plans/
 * power-mode.md, "Unstick"). Counted from the activity feed (item_events,
 * migration 023): every update that set a new `startDate` is a move, and moves
 * on the same day count once, so a drag that lands twice is one. Kept in
 * memory only; nothing new is stored, and nothing on screen ever says the
 * number. What it changes is what prep writes: a first step so small it needs
 * no decision.
 */

/** Moves to another day, on this many different days, make an item stuck. */
export const STUCK_AT = 3;
/** How far back the feed is read. */
export const STUCK_WINDOW_DAYS = 30;

export interface MoveEvent {
  itemId: string;
  /** The day the move was made, yyyy-MM-dd (the first ten of created_at). */
  day: string;
}

/** Item id → the number of different days it was moved on. */
export function moveCounts(events: readonly MoveEvent[]): Map<string, number> {
  const days = new Map<string, Set<string>>();
  for (const e of events) {
    let set = days.get(e.itemId);
    if (!set) days.set(e.itemId, (set = new Set()));
    set.add(e.day);
  }
  return new Map([...days].map(([id, set]) => [id, set.size]));
}

export function isStuck(moves: number | undefined): boolean {
  return (moves ?? 0) >= STUCK_AT;
}
