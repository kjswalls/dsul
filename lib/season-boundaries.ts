/**
 * season-boundaries — where a run of days changes hands.
 *
 * A week that spans a season's start or end renders live and suppressed
 * columns side by side. That is the showcase for date-parameterized activation
 * (plan decision 3), and it is also the moment the grid becomes confusing: five
 * columns carry the summer routine and two do not, and the two that don't look
 * like a bug rather than a boundary.
 *
 * So the boundary gets said out loud, once, on the column where it happens.
 * Not on every column — a persistent "Summer" badge across five days is chrome,
 * and the rule everywhere else in this feature is that only the exception is
 * labelled.
 *
 * Pure and store-free, like lib/active.ts: dates in, labels out. It lives in
 * its own module rather than inside the week grid because the bucket week view
 * wants the same markers, and a second copy of this logic is how lib/overdue.ts
 * came to exist.
 */

import { isSeasonActiveOn, inactiveItemIdsOn, type ActivationContext } from './active';
import type { Item, Season } from './planner-types';

export interface SeasonBoundary {
  /** Seasons that begin carrying their members on this date. */
  started: Season[];
  /** Seasons that stopped: live on the previous date in the run, not on this one. */
  ended: Season[];
}

/**
 * Boundaries for a run of consecutive dates, indexed by date string.
 *
 * The FIRST date in the run never reports a boundary, and that is deliberate
 * rather than a missing edge case: with no previous column rendered there is
 * nothing on screen for the change to be a change FROM, so a marker there would
 * be an assertion the user cannot check. Walk to the previous week and the same
 * boundary appears in its rightful place.
 *
 * Seasons with no date range never appear here. Only `auto` seasons flip on a
 * date; the manual states apply uniformly to every column (they have no
 * recorded history to place a boundary at), so a manual flip correctly produces
 * no marker anywhere.
 */
export function seasonBoundaries(
  dateStrs: readonly string[],
  seasons: readonly Season[],
): Map<string, SeasonBoundary> {
  const boundaries = new Map<string, SeasonBoundary>();
  if (seasons.length === 0) return boundaries;

  let previous: Set<string> | null = null;
  for (const dateStr of dateStrs) {
    const live = new Set<string>();
    for (const season of seasons) {
      if (isSeasonActiveOn(season, dateStr)) live.add(season.id);
    }
    if (previous) {
      const started = seasons.filter((p) => live.has(p.id) && !previous!.has(p.id));
      const ended = seasons.filter((p) => !live.has(p.id) && previous!.has(p.id));
      if (started.length || ended.length) boundaries.set(dateStr, { started, ended });
    }
    previous = live;
  }
  return boundaries;
}

/**
 * What a SINGLE date needs said about it, if anything.
 *
 * A week can show a boundary because it renders the days on either side of it.
 * A day view cannot — there is no neighbouring column for the change to be a
 * change *from*, so "Summer ends" would be an assertion the reader has no way
 * to check. What a day view can honestly say is the consequence: this many
 * things are not here, and this is what is holding them.
 *
 * Returns null on any date where no season is hiding anything, which is the
 * overwhelming majority of days — the notice must not become furniture.
 *
 * `hidden` counts only what the seasons named here are responsible for. An
 * item the user paused by hand is their own decision and already has a home in
 * the braindump's Paused section; folding it into this count would make the
 * season look responsible for work it never touched.
 */
export interface SeasonSuppression {
  seasons: Season[];
  hidden: number;
}

export function seasonSuppressionOn(
  dateStr: string,
  items: readonly Item[],
  ctx: ActivationContext,
): SeasonSuppression | null {
  const off = (ctx.seasons ?? []).filter((p) => !isSeasonActiveOn(p, dateStr));
  if (off.length === 0) return null;

  // The difference between "hidden with seasons in play" and "hidden with them
  // all switched on" is exactly what the seasons are responsible for. Asking
  // the resolver twice beats re-deriving the path algebra here — that second
  // derivation is what lib/overdue.ts exists to warn about.
  const withSeasons = inactiveItemIdsOn(items, dateStr, ctx);
  if (withSeasons.size === 0) return null;
  const withoutSeasons = inactiveItemIdsOn(items, dateStr, { ...ctx, seasons: [] });

  let hidden = 0;
  for (const id of withSeasons) if (!withoutSeasons.has(id)) hidden += 1;
  if (hidden === 0) return null;

  return { seasons: off, hidden };
}

/**
 * The marker's words. Short enough for a 140px week column, and phrased from
 * the reader's side of the screen — "Summer starts" describes the day they are
 * looking at, where "Season activated" describes the database.
 */
export function boundaryLabel(boundary: SeasonBoundary): string {
  const names = (list: Season[]) => list.map((p) => p.name).join(' & ');
  if (boundary.started.length && boundary.ended.length) {
    return `${names(boundary.ended)} → ${names(boundary.started)}`;
  }
  if (boundary.started.length) return `${names(boundary.started)} starts`;
  return `${names(boundary.ended)} ends`;
}
