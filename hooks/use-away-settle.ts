'use client';

import { useEffect } from 'react';
import { usePlannerStore } from '@/lib/planner-store';
import { useDayStore } from '@/lib/day-clock';
import { selectPlannerLoaded } from '@/lib/planner-ready';
import { useAwayStore } from '@/lib/away-store';
import { awayInputsNow } from '@/lib/away-actions';

/**
 * The first open after a trip: the tasks that came due while you were away
 * move to the braindump ("From the trip"), once.
 *
 * Waits for both loads, the planner's (so the move reads fresh rows) and the
 * trips' (so a trip is never missed), then hands the store the planner's
 * unschedule verb. The store claims the trip first (settled_at), so two open
 * tabs move the tasks once. Labelled so the undo toast stays down: this runs
 * on load, not because of anything just pressed, and the braindump section is
 * its receipt.
 */
export function useAwaySettle(): void {
  const userId = usePlannerStore((s) => s.userId);
  const plannerLoaded = usePlannerStore(selectPlannerLoaded);
  const awayReady = useAwayStore((s) => s.loaded && s.available && s.userId === userId);
  const periods = useAwayStore((s) => s.periods);
  // A trip that ends while the page is open settles when the day turns over.
  const today = useDayStore((s) => s.todayStr);

  useEffect(() => {
    if (!userId || !plannerLoaded || !awayReady) return;
    const inputs = awayInputsNow();
    if (!periods.some((p) => !!p.endsOn && p.endsOn <= inputs.todayStr && !p.settledAt)) return;
    void useAwayStore.getState().settle(inputs, (ids) => {
      usePlannerStore.getState().unscheduleTasks(ids, { label: 'Back from vacation' });
      const after = new Map(usePlannerStore.getState().items.map((i) => [i.id, i]));
      return ids.filter((id) => !(after.get(id) as { startDate?: string } | undefined)?.startDate);
    });
  }, [userId, plannerLoaded, awayReady, periods, today]);
}
