'use client';

import { useEffect } from 'react';
import { catchUpPlanner, usePlannerStore } from '@/lib/planner-store';
import { DAY_CHECK_MS, readDay, todayIn, useDayStore } from '@/lib/day-clock';
import { heldItemIds } from '@/hooks/use-planner-catch-up';

/**
 * A planner left open across midnight moves to the new day as a reload would.
 *
 * Every DAY_CHECK_MS, and whenever the page is shown or focused again (a
 * sleeping laptop stalls timers), it re-reads the date in the user's timezone.
 * When the day has moved:
 *
 * - The view follows, but only if it was on today. Someone looking at
 *   yesterday on purpose, or at next Tuesday, is left where they are.
 * - `useDayStore.todayStr` changes, which re-runs the once-a-day jobs that
 *   depend on it (the overdue sweep, completion filing, the vacation settle).
 * - It catches up with the server, where the nightly settlement and any
 *   midnight recipe may have written.
 *
 * Mounted in AppShell beside the catch-up, once the planner's load has settled.
 */
export function useDayRollover() {
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);
  const timezone = usePlannerStore((s) => s.userTimezone);

  useEffect(() => {
    if (!userId || isLoading) return;
    if (typeof window === 'undefined') return;

    const check = () => {
      const was = readDay(timezone);
      if (was === null) return;
      const planner = usePlannerStore.getState();
      if (todayIn(timezone, planner.selectedDate) === was) planner.setSelectedDate(new Date());
      void catchUpPlanner({ heldItemIds });
    };
    // A fresh mount reads the day it loaded on; a remount after the day moved
    // (a new timezone, a re-sign-in) rolls over then.
    if (useDayStore.getState().todayStr === null) readDay(timezone);
    else check();

    const timer = setInterval(check, DAY_CHECK_MS);
    const onReturn = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [userId, isLoading, timezone]);
}
