import {
  MOD_HISTORY_ALL_PER_WINDOW,
  MOD_HISTORY_PER_WINDOW,
  MOD_HISTORY_WINDOW_MS,
  MOD_HOOKS_PER_DAY,
  MOD_HOOKS_PER_MINUTE,
} from './limits';

/**
 * A mod's two rate limits (memory/plans/mods.md, build order 8). Pure, and
 * per tab, in memory, as the recipe rate limit is.
 *
 * - Hooks: every hook dispatched counts (item, command and timer). More than
 *   MOD_HOOKS_PER_MINUTE in a minute or MOD_HOOKS_PER_DAY in a day is a
 *   `rate` fault, which switches the mod off at once.
 * - History: a mod may add MOD_HISTORY_PER_WINDOW real undo entries in the
 *   window, and every mod together MOD_HISTORY_ALL_PER_WINDOW, so mods can
 *   never push the user's own entries out of the 50 kept.
 */

export type RateBreach = 'minute' | 'day';

export const hookRateReason = (over: RateBreach) =>
  over === 'minute'
    ? `It ran more than ${MOD_HOOKS_PER_MINUTE} times in a minute.`
    : `It ran more than ${MOD_HOOKS_PER_DAY} times today.`;

export interface HookRate {
  /** Counts this hook, or says which limit it would break (and counts nothing). */
  take(modId: string, nowMs: number, today: string): RateBreach | null;
  clear(modId: string): void;
}

export function createHookRate(perMinute = MOD_HOOKS_PER_MINUTE, perDay = MOD_HOOKS_PER_DAY): HookRate {
  const minute = new Map<string, number[]>();
  const day = new Map<string, { day: string; n: number }>();
  return {
    take(modId, nowMs, today) {
      const recent = (minute.get(modId) ?? []).filter((t) => nowMs - t < 60_000);
      const d = day.get(modId);
      const todayCount = d && d.day === today ? d.n : 0;
      if (recent.length >= perMinute) return 'minute';
      if (todayCount >= perDay) return 'day';
      recent.push(nowMs);
      minute.set(modId, recent);
      day.set(modId, { day: today, n: todayCount + 1 });
      return null;
    },
    clear(modId) {
      minute.delete(modId);
      day.delete(modId);
    },
  };
}

export interface HistoryWindow {
  /** True when one more entry from this mod stays under both caps. */
  allows(modId: string, nowMs: number): boolean;
  /** A real entry landed. */
  record(modId: string, nowMs: number): void;
}

export function createHistoryWindow(
  perMod = MOD_HISTORY_PER_WINDOW,
  all = MOD_HISTORY_ALL_PER_WINDOW,
  windowMs = MOD_HISTORY_WINDOW_MS
): HistoryWindow {
  let entries: { modId: string; at: number }[] = [];
  const live = (nowMs: number) => (entries = entries.filter((e) => nowMs - e.at < windowMs));
  return {
    allows(modId, nowMs) {
      const recent = live(nowMs);
      return recent.length < all && recent.filter((e) => e.modId === modId).length < perMod;
    },
    record(modId, nowMs) {
      live(nowMs).push({ modId, at: nowMs });
    },
  };
}
