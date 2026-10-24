'use client';

import { useEffect } from 'react';
import { catchUpPlanner, storeHoldsItem, usePlannerStore } from '@/lib/planner-store';
import { itemFromChangeRow } from '@/lib/db';
import { createClient } from '@/lib/supabase';
import { subscribePlannerChanges, type LiveChange } from '@/lib/planner-live';
import { useUIStore } from '@/lib/ui-store';
import { useRenameStore } from '@/lib/item-rename';
import { useDragStore } from '@/lib/drag-store';
import { useRailStore } from '@/lib/rail-store';

/** The least time between two catch-ups, however often focus comes and goes. */
export const CATCH_UP_GAP_MS = 5_000;

/**
 * How long a live change waits for the ones behind it. A drag, a batch or a
 * recipe on another device writes several rows at once, and one read takes
 * them all.
 */
export const LIVE_SETTLE_MS = 800;

/**
 * Whether a live change can be news to this tab. This tab's own save comes
 * back too, and an item that already reads exactly as the change says is
 * that echo: nothing to read. Everything else (a container, a membership, an
 * item that differs) is asked of the server.
 */
export function isNews(change: LiveChange): boolean {
  if (change.table !== 'items') return true;
  const item = itemFromChangeRow(change.row);
  return !item || !storeHoldsItem(item);
}

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
 * Keep this planner in step with other devices. Two ways in, one merge
 * (catchUpPlanner in lib/planner-store.ts):
 *
 * - **Live.** While the planner is open it hears every change to its owner's
 *   rows (lib/planner-live.ts, migration 084) and catches up a moment later,
 *   so a tick on the phone shows on the laptop without a reload. A change heard
 *   while the tab is hidden waits for it to be shown.
 * - **On return.** The tab shown again, the window focused, the network back,
 *   or the live channel rejoined after a drop: whatever was missed is read
 *   then. At most once every CATCH_UP_GAP_MS unless a live change is waiting.
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
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    // A live change heard and not yet read.
    let waiting = false;
    let stopped = false;

    const run = () => {
      timer = null;
      if (stopped) return;
      if (document.visibilityState !== 'visible' || running) {
        waiting = true;
        return;
      }
      waiting = false;
      running = true;
      last = Date.now();
      void catchUpPlanner({ heldItemIds }).finally(() => {
        running = false;
        if (waiting && !stopped) settle();
      });
    };
    const settle = () => {
      waiting = true;
      timer ??= setTimeout(run, LIVE_SETTLE_MS);
    };
    const onReturn = () => {
      if (document.visibilityState !== 'visible') return;
      if (waiting) return settle();
      if (Date.now() - last < CATCH_UP_GAP_MS) return;
      run();
    };

    let stopLive: (() => void) | null = null;
    try {
      stopLive = subscribePlannerChanges(createClient(), userId, {
        onChange: (change) => {
          if (isNews(change)) settle();
        },
        onJoined: (rejoin) => {
          if (rejoin) settle();
        },
      });
    } catch (err) {
      // Live is an extra: without it the planner still catches up on return.
      console.warn('[planner] live sync unavailable', err);
    }

    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    window.addEventListener('online', onReturn);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stopLive?.();
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('online', onReturn);
    };
  }, [userId, isLoading]);
}
