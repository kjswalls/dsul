'use client';

import { useEffect } from 'react';
import { usePlannerStore } from '@/lib/planner-store';
import { selectPlannerLoaded } from '@/lib/planner-ready';
import { useUIStore, type ActiveDialog } from '@/lib/ui-store';
import type { Item } from '@/lib/planner-types';

/**
 * Mounted promoters. Counted, not flagged, so StrictMode's mount → cleanup →
 * mount can't leave it reading "none" under a live one (lib/console-door.ts's
 * `hosts`, for the same reason).
 */
let hosts = 0;

/**
 * Opens the data dialog asked for during the look-only preview, the moment the
 * data is real (lib/ui-store.ts defers it; this promotes it).
 *
 * Fires on the preview's true→false edge and opens only after a SUCCESSFUL
 * landing for the same account. A failed load, a crash drop and an account
 * change all end the preview too, and each drops the request: there is nothing
 * real to open it on, or it was asked for by somebody else.
 *
 * The payload was built from cached rows, so it is re-resolved against fresh
 * ones: an edit-item reopens on the fresh row (or not at all if it is gone),
 * and a new organizer starts only with items that still exist.
 *
 * Mounted once in AppShell, so leaving `/` unmounts it and drops a pending
 * request, the way ConsoleSlotGuard drops a stranded slot.
 */
export function useDeferredDialogPromotion(): void {
  useEffect(() => {
    hosts += 1;
    // Optional-called: a unit test that mocks `@/lib/planner-store` with only
    // the members it needs has no `subscribe`.
    const unsubscribe = usePlannerStore.subscribe?.((s, prev) => {
      if (!prev.isPreview || s.isPreview) return;
      // Inside the landing set(): a throw here must never escape into the load.
      try {
        const deferred = useUIStore.getState().deferredDialog;
        if (!deferred) return;
        useUIStore.setState({ deferredDialog: null });
        if (!selectPlannerLoaded(s) || s.userId !== prev.userId) return;
        // One slot, plus the confirm's: whatever claimed either since wins.
        const { activeDialog, confirmRequest, openDialog } = useUIStore.getState();
        if (activeDialog || confirmRequest) return;
        const fresh = resolveOnFresh(deferred, s.items);
        if (fresh) openDialog(fresh);
      } catch {
        // Losing a deferred dialog is the safe failure.
      }
    });
    return () => {
      unsubscribe?.();
      hosts -= 1;
      // Leaving `/` drops the request — but a microtask later, and only if no
      // promoter came back meanwhile. React StrictMode (on for the App Router
      // in development) runs this cleanup straight after the first mount and
      // re-mounts in the same task, which would wipe the request that a door
      // off-shell deferred and then pushed `/` to open — the trap
      // lib/console-door.ts and ConsoleSlotGuard each describe. A re-mount in
      // the same task has a host for it, so keeping it is right there too.
      queueMicrotask(() => {
        if (hosts === 0) useUIStore.setState({ deferredDialog: null });
      });
    };
  }, []);
}

/** The deferred payload against fresh rows, or null when what it named is gone. */
function resolveOnFresh(dialog: ActiveDialog, items: Item[]): ActiveDialog | null {
  if (dialog.type === 'edit-item') {
    const fresh = items.find((i) => i.id === dialog.item.id);
    if (!fresh) return null;
    // The payload's type is the projection stamp openEditFor chose; keep it.
    return { type: 'edit-item', item: { ...fresh, type: dialog.item.type } as Item };
  }
  if (dialog.type === 'new-container' && dialog.itemIds) {
    const live = new Set(items.map((i) => i.id));
    return { ...dialog, itemIds: dialog.itemIds.filter((id) => live.has(id)) };
  }
  return dialog;
}
