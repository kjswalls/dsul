'use client';

import { useEffect } from 'react';
import { catchUpPlanner, usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { useRenameStore } from '@/lib/item-rename';
import { useDragStore } from '@/lib/drag-store';
import { useRailStore } from '@/lib/rail-store';

/** The least time between two catch-ups, however often focus comes and goes. */
export const CATCH_UP_GAP_MS = 5_000;

/**
 * The items this tab is in the middle of changing, which a catch-up leaves
 * alone: the one open in the item panel (its draft saves over whatever it is
 * given), the one being renamed in place, and the one being dragged. On the
 * phone, an item opened while the Ask tab is mounted is pushed over Ask
 * (rail-store's `stacks.phone`) instead of filling the `edit-item` slot, so
 * both are asked.
 */
export function heldItemIds(): Set<string> {
  const held = new Set<string>();
  const dialog = useUIStore.getState().activeDialog;
  if (dialog?.type === 'edit-item') held.add(dialog.item.id);
  const phone = useRailStore.getState().stacks.phone;
  const top = phone[phone.length - 1];
  if (top?.kind === 'item') held.add(top.itemId);
  const renaming = useRenameStore.getState().target;
  if (renaming) held.add(renaming.id);
  const dragging = useDragStore.getState().activeId;
  if (dragging) held.add(dragging);
  return held;
}

/**
 * Catch up with other devices when the planner comes back into view: the tab
 * shown again, the window focused, the network back. A change made on the
 * phone shows here the moment this window is looked at again, without a
 * reload (catchUpPlanner in lib/planner-store.ts has the merge rule).
 *
 * Mounted in AppShell beside the cue tick, so it runs on the planner only, and
 * only once its load has settled.
 */
export function usePlannerCatchUp() {
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);

  useEffect(() => {
    if (!userId || isLoading) return;
    if (typeof window === 'undefined') return;
    // The load that just settled is as fresh as a catch-up would be.
    let last = Date.now();
    const catchUp = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - last < CATCH_UP_GAP_MS) return;
      last = now;
      void catchUpPlanner({ heldItemIds });
    };
    document.addEventListener('visibilitychange', catchUp);
    window.addEventListener('focus', catchUp);
    window.addEventListener('online', catchUp);
    return () => {
      document.removeEventListener('visibilitychange', catchUp);
      window.removeEventListener('focus', catchUp);
      window.removeEventListener('online', catchUp);
    };
  }, [userId, isLoading]);
}
