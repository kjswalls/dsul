/**
 * scope-rail.ts — the scope (routine/season) view-model.
 *
 * One row per gate container: the switch the user set on it, the state that
 * actually resolves today, and a line saying what that switch is currently
 * doing. Everything hard is here, pure and date-parameterized.
 *
 * It powers the Display menu's "Paused scopes" list — the off scopes, each one
 * click from back on. The sidebar rail that first grew this is gone (its two
 * jobs moved onto the group-header switch and that menu list), but the
 * view-model it needed outlived it.
 *
 * The load-bearing rule, out of the path algebra rather than out of taste:
 *
 *   **Local state on the switch, effective state in the luminance.** A routine
 *   keeps its own `pausedAt` while a season suppresses it. Render that routine
 *   as "off" and resuming the season hands back a routine the user believes
 *   they turned off — so the switch always shows the STORED value and the row's
 *   dimming shows the RESOLVED one. They never merge. Only routines can
 *   disagree; a season has nothing above it.
 *
 * See memory/plans/programs-routines.md, Phase 5.
 */

import {
  formatDay,
  isPausedOn,
  isSeasonActiveOn,
  seasonResumeDate,
  routineStandingOn,
  type RoutineStanding,
} from './active';
import type { Season, Routine } from './planner-types';
import type { GateKind } from './container-registry';

/**
 * A scope row's container is exactly a GATE container — the kinds whose
 * membership switches work off rather than describing it.
 *
 * Aliased rather than re-declared so the seam is one fact: a kind that starts
 * gating gets a scope row by declaring `role: 'gate'`, and a classify kind can
 * never acquire one by someone widening a string union here.
 */
export type ScopeKind = GateKind;

export interface ScopeRow {
  kind: ScopeKind;
  id: string;
  name: string;
  icon?: string;
  /** The switch: what the user set on THIS container. Never the resolved answer. */
  localOn: boolean;
  /** What resolves today, once the containers above have had their say. */
  effectiveOn: boolean;
  /** The right-hand line — "On · follows dates", "Off · back Sep 8". */
  state: string;
}

/**
 * The season state a binary switch should write — the rule that keeps a switch
 * from quietly destroying date-following.
 *
 * Prefer `auto` whenever `auto` already gives the answer being asked for; write
 * a manual override only when the user is genuinely overruling the calendar.
 *
 * This matters in both directions and the plugin notes only caught one of them.
 * Turning a live summer off with `paused` and back on with `active` leaves a
 * season that no longer ends on Aug 31 and that nobody will remember to switch
 * off (the Phase 4d note). But the mirror is just as bad: a term switched on
 * early with `active` and then off again with `paused` has also lost its Sep 1
 * start, and the row that used to say "back Sep 1" now says nothing. Under this
 * rule both round-trip exactly, because in each case `auto` was already
 * producing the requested state and no override was needed.
 */
export function seasonStateForSwitch(
  season: Season,
  on: boolean,
  todayStr: string,
): Season['state'] {
  if (isSeasonActiveOn({ ...season, state: 'auto' }, todayStr) === on) return 'auto';
  return on ? 'active' : 'paused';
}

function seasonStateLine(season: Season, todayStr: string): string {
  if (season.state === 'active') return 'On · you turned it on';
  if (season.state === 'paused') return 'Off · you turned it off';
  if (isSeasonActiveOn(season, todayStr)) {
    return season.endsOn ? `On · until ${formatDay(season.endsOn)}` : 'On';
  }
  const back = seasonResumeDate(season, todayStr);
  if (back) return `Off · back ${formatDay(back)}`;
  // An INVERTED range gets neither half of this. It is live on no date, so its
  // start is not a return (which `seasonResumeDate` already refuses) and its
  // end never arrived — "ended Aug 1" would report a season that never ran.
  const inverted = !!season.startsOn && !!season.endsOn && season.startsOn > season.endsOn;
  if (!inverted && season.endsOn && todayStr > season.endsOn) {
    return `Off · ended ${formatDay(season.endsOn)}`;
  }
  return 'Off';
}

/**
 * The line for a routine, including the one case the whole local/effective
 * split exists for: the routine's own switch says on, and it still is not
 * carrying anything, because every season holding it is off.
 *
 * The blocking season is NAMED but its return date is not repeated — that
 * season has its own row, already carrying it. Holders are ranked by the
 * disjunctive rule (the routine comes back when the FIRST of them does), which
 * is why `seasonResumeDate` is shared with `active.ts` rather than re-derived
 * here.
 */
function routineStateLine(
  routine: Routine,
  standing: RoutineStanding,
  todayStr: string,
  tz: string,
): string {
  if (!standing.localOn) {
    return isPausedOn(routine, todayStr, tz) && routine.pausedUntil
      ? `Off · back ${formatDay(routine.pausedUntil)}`
      : 'Off';
  }
  // A blocked holder is only worth naming when it is actually blocking. Under
  // the disjunctive rule one live season carries the routine regardless of how
  // many others are off, and naming them there would report a suppression that
  // is not happening.
  if (standing.effectiveOn || !standing.soonestBlocker) return 'On';
  const more = standing.blockers.length - 1;
  return `On · held with ${standing.soonestBlocker.name}${more > 0 ? ` +${more}` : ''}`;
}

/**
 * Build the scope rows — one per season and routine, resolved at TODAY.
 *
 * Today only, never per rendered column: pausing is a dateless question (locked
 * decision 3) and the one surface that reads these, the Display menu, is
 * dateless too. The old rail also computed a resolver DELTA per row (how many
 * items a flip would move) for its away-count and hover ghost; the minimal
 * group-header switch that replaced it shows neither, so that machinery — and
 * the per-container `inactiveItemIdsOn` passes it cost — is gone.
 */
export function buildScopeRows(
  routines: readonly Routine[],
  seasons: readonly Season[],
  todayStr: string,
  tz: string,
): ScopeRow[] {
  const seasonRows: ScopeRow[] = seasons.map((season) => {
    const on = isSeasonActiveOn(season, todayStr);
    return {
      kind: 'season',
      id: season.id,
      name: season.name,
      icon: season.icon,
      localOn: on,
      // A season has nothing above it, so its stored switch IS its effect.
      effectiveOn: on,
      state: seasonStateLine(season, todayStr),
    };
  });

  const routineRows: ScopeRow[] = routines.map((routine) => {
    // Shared with the Organize console's routine detail — see routineStandingOn.
    // The two surfaces used to derive this separately and disagreed about the
    // same routine, which is only visible with both open.
    const standing = routineStandingOn(routine, seasons, todayStr, tz);
    return {
      kind: 'routine',
      id: routine.id,
      name: routine.name,
      icon: routine.icon,
      localOn: standing.localOn,
      effectiveOn: standing.effectiveOn,
      state: routineStateLine(routine, standing, todayStr, tz),
    };
  });

  // Off ranks last but never leaves the list — Linear's rule, and it is what
  // makes turning something off feel reversible rather than like a disposal.
  // Seasons before routines within each half: a season can switch a whole
  // routine, so the thing with the wider reach reads first.
  const rank = (row: ScopeRow) => (row.effectiveOn ? 0 : 2) + (row.kind === 'season' ? 0 : 1);
  return [...seasonRows, ...routineRows].sort((a, b) => rank(a) - rank(b));
}
