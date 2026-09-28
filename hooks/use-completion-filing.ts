'use client';

import { useEffect } from 'react';
import { usePlannerStore } from '@/lib/planner-store';
import { useMorningStore } from '@/lib/morning-store';
import { toDateStr } from '@/lib/recurrence';
import { milestoneItemIds } from '@/lib/goals';
import { inactiveItemIdsOn } from '@/lib/active';
import { fetchCompletedAt } from '@/lib/db';
import { planFiling, selectFilingCandidates } from '@/lib/completion-filing';
import type { Item } from '@/lib/planner-types';

/**
 * The runs this tab has already made, as `userId:todayStr`. Module-level so
 * StrictMode's double effect and an effect re-arming on a dependency flip do
 * not query twice; the run is idempotent anyway (a filed item is no longer a
 * candidate), so this saves a request, not correctness.
 */
const ran = new Set<string>();

function candidatesFor(items: readonly Item[], todayStr: string, userTimezone: string): Item[] {
  const planner = usePlannerStore.getState();
  const inactive = inactiveItemIdsOn(items, todayStr, {
    userTimezone,
    routines: planner.routines,
    seasons: planner.seasons,
  });
  return selectFilingCandidates(items, {
    milestones: milestoneItemIds(planner.goals),
    inactive,
  });
}

/**
 * use-completion-filing — finished braindump items move to the day they were
 * finished on, once that day is over. See lib/completion-filing.ts for the
 * policy; this hook is only the when.
 *
 * Runs on load, like the overdue sweep beside it (hooks/use-overdue-sweep.ts),
 * and waits on the same proofs before it writes: items loaded for THIS user
 * (goals, routines and seasons ride the same set(), which the milestone and
 * suppression exclusions depend on), settings hydrated for this user, and a
 * resolved timezone — the day boundary has to be the user's, or a task
 * finished at 23:30 files onto the wrong day. Any doubt means file nothing.
 *
 * An app left open across midnight files on its next load, the same bargain
 * the rest of the app makes with the rollover.
 */
export function useCompletionFiling() {
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);
  const loadError = usePlannerStore((s) => s.error);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const settingsHydratedUserId = useMorningStore((s) => s.settingsHydratedUserId);

  useEffect(() => {
    if (!userId || isLoading || loadError) return;
    if (settingsHydratedUserId !== userId) return;
    if (!userTimezone) return;

    const todayStr = toDateStr(new Date(), userTimezone);
    const key = `${userId}:${todayStr}`;
    if (ran.has(key)) return;
    ran.add(key);

    const candidates = candidatesFor(usePlannerStore.getState().items, todayStr, userTimezone);
    if (candidates.length === 0) return;

    let cancelled = false;
    let settled = false;
    fetchCompletedAt(candidates.map((c) => c.id))
      .then((stamps) => {
        // Re-read everything after the await. The user may have uncompleted,
        // dated or deleted a row while the stamps were in flight, or signed
        // out — each of those must win over a plan made before it.
        const planner = usePlannerStore.getState();
        settled = true;
        if (cancelled || planner.userId !== userId) return;
        const fresh = candidatesFor(planner.items, todayStr, userTimezone);
        const entries = planFiling(fresh, stamps, todayStr, userTimezone);
        if (entries.length > 0) planner.fileCompletedToDays(entries);
      })
      .catch((err) => {
        // A database without migration 048, or a failed request: file nothing,
        // and let the next load try again.
        settled = true;
        ran.delete(key);
        console.error(err);
      });

    return () => {
      cancelled = true;
      // An effect torn down mid-flight (StrictMode, a dependency flip) has
      // written nothing, so it must not have spent the day.
      if (!settled) ran.delete(key);
    };
  }, [userId, isLoading, loadError, userTimezone, settingsHydratedUserId]);
}
