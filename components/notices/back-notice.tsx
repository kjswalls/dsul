'use client';

import { useMemo } from 'react';
import { Sunrise } from 'lucide-react';
import { usePlannerStore } from '@/lib/planner-store';
import { useAwayStore } from '@/lib/away-store';
import { useViewStore } from '@/lib/view-store';
import { backOn } from '@/lib/paused-shelf';
import { toDateStr } from '@/lib/recurrence';
import { cn } from '@/lib/utils';

/**
 * What comes back from a pause on the day on screen, or null: "Back today:
 * Gym and Morning pages". Shared by the line below and the date capsule's key
 * (components/notices/day-messages.tsx), which shows a sunrise while this is
 * non-null.
 *
 * It is about this day, so it lives with the date (the messages rule in
 * day-messages.tsx), and on no other day. The rows themselves come back in
 * their ordinary places with no mark of their own: being back is not news the
 * row has to carry.
 *
 * Day scope only, for the season line's reason: in a week view `selectedDate`
 * is one column of seven.
 */
export function useBackToday(scopeOverride?: 'day' | 'week') {
  const items = usePlannerStore((s) => s.items);
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const selectedDate = usePlannerStore((s) => s.selectedDate);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const away = useAwayStore((s) => s.periods);
  const storeScope = useViewStore((s) => s.scope);
  const scope = scopeOverride ?? storeScope;

  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dateStr = toDateStr(selectedDate, tz);
  const todayStr = toDateStr(new Date(), tz);

  const names = useMemo(
    () => (scope === 'day' ? backOn(items, dateStr, { userTimezone: tz, routines, seasons, away }) : []),
    [scope, items, dateStr, tz, routines, seasons, away]
  );
  if (names.length === 0) return null;
  return { dateStr, names, when: dateStr === todayStr ? 'today' : dateStr > todayStr ? 'ahead' : 'past' } as const;
}

/** Said from today: the capsule can be walked to a return day either side of it. */
const BACK_LEAD = { today: 'Back today', ahead: 'Coming back', past: 'Came back' } as const;

/** "Gym", "Gym and Stretch", "Gym, Stretch and Journal", "Gym, Stretch and 3 more". */
export function backList(names: readonly string[]): string {
  if (names.length === 1) return names[0];
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

export function BackNotice({ scope, className }: { scope?: 'day' | 'week'; className?: string }) {
  const back = useBackToday(scope);
  if (!back) return null;
  return (
    <div
      data-testid="back-notice"
      data-date={back.dateStr}
      data-count={back.names.length}
      className={cn('text-muted-foreground flex min-w-0 items-start gap-1.5 text-xs', className)}
    >
      <Sunrise className="mt-px h-3 w-3 shrink-0" aria-hidden />
      {/* Wraps rather than truncating: the names ARE the message, and a popover
          has the height to spare. */}
      <span className="min-w-0" title={back.names.join(', ')}>
        {BACK_LEAD[back.when]}: {backList(back.names)}
      </span>
    </div>
  );
}
