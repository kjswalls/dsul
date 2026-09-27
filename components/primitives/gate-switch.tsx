'use client';

import { Switch } from '@/components/ui/switch';
import { usePlannerStore } from '@/lib/planner-store';
import { isSeasonActiveOn, routineStandingOn } from '@/lib/active';
import { setGateOn } from '@/lib/gate-toggle';
import { toDateStr } from '@/lib/recurrence';

/**
 * The pause switch a gate group header (routine/season) carries — the Scope
 * Rail's switch, moved onto the section it governs.
 *
 * Flipping it off pauses the whole container, which takes its members off every
 * surface (locked decision 1), so the group empties itself. Turning a fully-off
 * scope back on happens from the Display menu's "Paused scopes" list, not here —
 * a paused scope has no visible members and so no header to host a switch.
 *
 * DISPLAY is resolved at today and shows the LOCAL (stored) state, never the
 * effective one: a routine whose own switch is on but that a season is holding
 * off still reads on, or resuming the season hands back a routine the user
 * believes they turned off. The WRITE lives in setGateOn, which re-resolves at
 * click time and is dateless — see its header for the date-following contract.
 */
export function GateSwitch({ kind, id }: { kind: 'routine' | 'season'; id: string }) {
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const userTimezone = usePlannerStore((s) => s.userTimezone);

  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayStr = toDateStr(new Date(), tz);

  let name: string;
  let on: boolean;
  if (kind === 'routine') {
    const routine = routines.find((r) => r.id === id);
    if (!routine) return null;
    name = routine.name;
    on = routineStandingOn(routine, seasons, todayStr, tz).localOn;
  } else {
    const season = seasons.find((p) => p.id === id);
    if (!season) return null;
    name = season.name;
    on = isSeasonActiveOn(season, todayStr);
  }

  return (
    <Switch
      checked={on}
      onCheckedChange={() => setGateOn(kind, id, !on)}
      // aria-checked is already announced by role=switch, so the label is the
      // OBJECT, not the verb — "Turn off Morning … checked" would read as its own
      // negation. The verb lives in the title tooltip for pointer users.
      aria-label={name}
      title={`${on ? 'Turn off' : 'Turn on'} ${name}`}
      data-testid="gate-switch"
      data-gate-on={on ? 'on' : 'off'}
      // shrink-0 so a long section label never squeezes it. The lime "on" fill is
      // the Switch's own bg-primary on its own element, so a dimmed header can
      // never fade it (CLAUDE.md's accent law). Stop the click from bubbling to
      // the header's collapse control.
      className="ml-1 shrink-0"
      onClick={(e) => e.stopPropagation()}
    />
  );
}
