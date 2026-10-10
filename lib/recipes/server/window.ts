import { localClock, windowOpensAt } from '@/lib/reminders/scan';
import { minutesOfDay, REMINDER_GRACE_MINUTES } from '@/lib/reminders/due';

/**
 * When a timed recipe is due (memory/plans/mods.md, "Timed triggers ride the
 * tick"). Pure, in minutes of day, never `time + interval` in SQL.
 *
 * The tick runs every five minutes, at least once, and sometimes not at all,
 * so a recipe set for `at` is due at any tick within the last `grace` REAL
 * minutes after `at` was crossed on today's local date. Real minutes, not
 * wall-clock ones, because a zone's clock jumps:
 *  - spring forward: 02:30 never happens, and the 03:00 tick is the first
 *    instant past it, so the recipe runs at 03:00;
 *  - fall back: 01:30 happens twice, so it is due at both, and the claim
 *    (`time:<day>:<at>`, lib/recipes/server/run.ts) runs it once.
 * It opens no later than the day's last tick (windowOpensAt), so 23:58 runs at
 * 23:55, and it never spills into tomorrow, which has its own `at`.
 */
export function timedRunDay(
  at: string,
  now: Date,
  tz: string,
  grace: number = REMINDER_GRACE_MINUTES
): string | null {
  const minutes = minutesOfDay(at);
  if (minutes === null) return null;
  const opens = windowOpensAt(minutes);
  const clock = localClock(now, tz);
  if (clock.nowMinutes < opens) return null;
  // Where the clock stood `grace` real minutes ago. Already past `at` on this
  // same date: an earlier tick inside the window had its turn.
  const earlier = localClock(new Date(now.getTime() - grace * 60_000), tz);
  if (earlier.dateStr === clock.dateStr && earlier.nowMinutes >= opens) return null;
  return clock.dateStr;
}

/** mod_runs claim keys for server runs, unique per recipe (061's unique (mod_id, claim_key)). */
export const timeClaimKey = (day: string, at: string) => `time:${day}:${at}`;
export const itemClaimKey = (kind: string, itemId: string, date: string | undefined) =>
  `item:${kind}:${itemId}:${date ?? 'none'}`;
