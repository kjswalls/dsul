'use client';

import { Palmtree } from 'lucide-react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { usePlannerStore } from '@/lib/planner-store';
import { useAwayStore } from '@/lib/away-store';
import { activeTrip, openVacationCard } from '@/lib/away-actions';
import { shortAwayDay } from '@/lib/away-dates';
import { toDateStr } from '@/lib/recurrence';

/**
 * "Vacation mode…" in the user menu, above Settings: the way in that is not a
 * command. While a trip is on it reads "Vacation until Tue", and opens the same
 * card, which then holds End vacation. Hidden until trips have loaded (and for
 * good when migration 071 is missing), so nothing starts over an unseen trip.
 */
export function VacationMenuItem() {
  const available = useAwayStore((s) => s.available);
  const periods = useAwayStore((s) => s.periods);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  if (!available) return null;

  const todayStr = toDateStr(new Date(), userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const trip = activeTrip(periods, todayStr);
  const label = !trip
    ? 'Vacation mode…'
    : trip.startsOn > todayStr
      ? `Vacation from ${shortAwayDay(trip.startsOn, todayStr)}`
      : trip.endsOn
        ? `Vacation until ${shortAwayDay(trip.endsOn, todayStr)}`
        : 'On vacation';

  return (
    <DropdownMenuItem
      onClick={() => openVacationCard()}
      className="cursor-pointer"
      data-testid="vacation-menu-item"
    >
      <Palmtree className="mr-2 h-4 w-4" />
      <span>{label}</span>
    </DropdownMenuItem>
  );
}
