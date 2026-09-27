import { usePlannerStore } from './planner-store';
import { isSeasonActiveOn, routineStandingOn } from './active';
import { seasonStateForSwitch } from './scope-rail';
import { toDateStr } from './recurrence';

/**
 * Turn a gate container (routine/season) on or off — the one place the pause
 * switch's write is decided, shared by the group-header switch and the Display
 * menu's "Paused scopes" list.
 *
 * `desiredOn` is the OUTCOME the control promised the user (the opposite of what
 * its switch showed), NOT recomputed from the live state — otherwise a stale
 * display would flip the wrong way. The world is then re-read at CLICK time and
 * the write is skipped when it already matches, which is what keeps the two
 * dates straight:
 *
 *  - Resolved at TODAY (toDateStr(new Date())), never a navigated column —
 *    pausing is dateless (programs-routines locked decision 3).
 *  - The no-op guard preserves a season's `auto` when the calendar already
 *    agrees. A switch rendered before midnight and clicked after — where an
 *    `auto` season's date range has flipped with no store write to re-render it —
 *    would otherwise stamp a manual `active`/`paused` and lose the season's end
 *    date. setSeasonState does not re-derive today, so this is the only guard;
 *    the palette toggle and swapToSeason reason the same way.
 *  - One container-row write, no member touched (locked decision 8): routines
 *    flip a paused flag, seasons route through seasonStateForSwitch so a binary
 *    switch over the tri-state never destroys date-following.
 */
export function setGateOn(kind: 'routine' | 'season', id: string, desiredOn: boolean): void {
  const s = usePlannerStore.getState();
  const tz = s.userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = toDateStr(new Date(), tz);

  if (kind === 'routine') {
    const routine = s.routines.find((r) => r.id === id);
    if (!routine) return;
    // The routine's OWN switch (local state), not the resolved one — a routine a
    // season is holding off still owns its stored on/off.
    if (routineStandingOn(routine, s.seasons, today, tz).localOn === desiredOn) return;
    s.setRoutinePaused(id, !desiredOn);
    return;
  }

  const season = s.seasons.find((p) => p.id === id);
  if (!season) return;
  if (isSeasonActiveOn(season, today) === desiredOn) return;
  s.setSeasonState(id, seasonStateForSwitch(season, desiredOn, today));
}
