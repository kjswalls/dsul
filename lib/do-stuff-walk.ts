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
