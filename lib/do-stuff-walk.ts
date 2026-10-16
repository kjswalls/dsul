/**
 * The walk's pure half: where today's free stretch is, for "In the day"
 * (memory/plans/power-mode.md, the polish round). While doing stuff, the
 * current item opens inside today's schedule, in the stretch between now and
 * the next thing on the clock, so the plan, the day and the thing being done
 * share one screen.
 *
 * Nothing here decides what wants doing. The blocks are the schedule's own
 * timed entries (components/views/day-schedule.tsx deriveTimedEntries), and
 * the item is do stuff's next (lib/do-stuff-plan.ts nextNow).
 */

/** A timed block on today's grid, in minutes since midnight. */
export interface WalkBlock {
  title: string;
  startMin: number;
  /** Minutes long; a block always has one (the type's default when unset). */
  duration: number;
  /** Done blocks do not hold the clock: their time is free again. */
  done?: boolean;
  /** The item's id, for the missed-block offer. */
  id?: string;
  /**
   * May the walk move this block to another time? Only a one-off task: a
   * habit's or a series' time is every day's, and a project block's is the
   * project's.
   */
  movable?: boolean;
}

export interface FreeStretch {
  /** Where it starts: now, or the end of the block running now. */
  startMin: number;
  /** Where it ends: the next block's start, or the end of the day. */
  endMin: number;
  /** The block it runs up to, if any. */
  until: { title: string; startMin: number } | null;
  /** The block running now, when the stretch waits for it to end. */
  after: { title: string; endMin: number } | null;
}

const DAY_END = 24 * 60;

/**
 * Today's next free stretch from `nowMin`. A block that is on now pushes the
 * start to its end (chained through any blocks that overlap or touch it); the
 * next block that starts after that bounds it. Done blocks are ignored either
 * way: finishing a meeting early gives the time back. Null when the day has no
 * time left at all.
 */
export function freeStretch(blocks: readonly WalkBlock[], nowMin: number): FreeStretch | null {
  const live = blocks
    .filter((b) => !b.done && b.duration > 0)
    .slice()
    .sort((a, b) => a.startMin - b.startMin);
  let start = nowMin;
  let after: FreeStretch['after'] = null;
  // Walk forward through anything that covers the start, so back-to-back
  // blocks read as one busy run.
  for (let moved = true; moved; ) {
    moved = false;
    for (const b of live) {
      const end = b.startMin + b.duration;
      if (b.startMin <= start && end > start) {
        start = end;
        after = { title: b.title, endMin: end };
        moved = true;
      }
    }
  }
  if (start >= DAY_END) return null;
  const next = live.find((b) => b.startMin >= start);
  return {
    startMin: start,
    endMin: next ? next.startMin : DAY_END,
    until: next ? { title: next.title, startMin: next.startMin } : null,
    after,
  };
}

/** "1h 20m", "45m", "2h". */
export function spanLabel(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}

/**
 * The slot's heading: how long you have, and until what. Says "free" only
 * when the stretch starts now; one that starts after a running block says so.
 */
export function stretchLabel(s: FreeStretch, nowMin: number): { lead: string; rest: string } {
  const lead = s.until ? `${spanLabel(s.endMin - s.startMin)} free` : 'free';
  const until = s.until ? `until ${s.until.title}` : 'for the rest of the day';
  return { lead, rest: s.startMin > nowMin && s.after ? `after ${s.after.title}, ${until}` : until };
}

/** How long before the next block a sprint stops: a breath to wrap up and get there. */
export const SPRINT_LEAD_MIN = 5;
/** A sprint with nothing after it on the clock is one ordinary focus block. */
export const SPRINT_OPEN_MIN = 25;
/** Below this there is no sprint worth starting. */
export const SPRINT_MIN = 10;

/**
 * The sprint the free stretch offers right now (Kirby's add-on, 2026-10-16): a
 * ring sized to the gap, stopping SPRINT_LEAD_MIN before the next block, or an
 * open SPRINT_OPEN_MIN when nothing is on the clock after now. Only while the
 * stretch is free now (not waiting on a block that is on), and only when it
 * leaves at least SPRINT_MIN.
 */
export function sprintFor(s: FreeStretch | null, nowMin: number): { minutes: number; until: string | null } | null {
  if (!s || s.startMin > nowMin) return null;
  const minutes = s.until ? s.endMin - SPRINT_LEAD_MIN - nowMin : Math.min(SPRINT_OPEN_MIN, s.endMin - nowMin);
  if (minutes < SPRINT_MIN) return null;
  return { minutes, until: s.until?.title ?? null };
}

/** How long before a block the slot says it is coming. */
export const HEADS_UP_MIN = 5;

/**
 * The block about to start (Kirby's walk, 2026-10-16): the next one not done
 * that starts within HEADS_UP_MIN of now, so the slot can say "Lunch with Ana in
 * 4m" while there is time to wrap up. Null otherwise. It never asks anything.
 */
export function headsUp(blocks: readonly WalkBlock[], nowMin: number): { title: string; inMin: number } | null {
  let best: WalkBlock | null = null;
  for (const b of blocks) {
    if (b.done || b.startMin <= nowMin || b.startMin - nowMin > HEADS_UP_MIN) continue;
    if (!best || b.startMin < best.startMin) best = b;
  }
  return best ? { title: best.title, inMin: best.startMin - nowMin } : null;
}

/** How far back a missed block is still worth offering. */
export const MISSED_WINDOW_MIN = 180;

/**
 * A block that came and went without being done, offered once with no guilt:
 * "fit it in" or "let it go". The most recent one that ended within
 * MISSED_WINDOW_MIN, is movable, and was not offered already (`seen`, ids).
 * Null when there is none.
 */
export function missedBlock(
  blocks: readonly WalkBlock[],
  nowMin: number,
  seen: ReadonlySet<string>
): (WalkBlock & { id: string }) | null {
  let best: (WalkBlock & { id: string }) | null = null;
  for (const b of blocks) {
    const end = b.startMin + b.duration;
    if (b.done || !b.movable || !b.id || seen.has(b.id)) continue;
    if (end > nowMin || nowMin - end > MISSED_WINDOW_MIN) continue;
    if (!best || end > best.startMin + best.duration) best = { ...b, id: b.id };
  }
  return best;
}

/**
 * Where "fit it in" puts a block: the free stretch's start, which is now when
 * the stretch is free now. Never rounded up: a gap of a few minutes before it
 * would be a sliver the slot covers.
 */
export function fitInStart(s: FreeStretch | null, nowMin: number): number | null {
  if (!s) return null;
  const at = Math.max(s.startMin, nowMin);
  return at < 24 * 60 ? at : null;
}
