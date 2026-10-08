'use client';

import { useEffect } from 'react';
import { usePlannerStore } from '@/lib/planner-store';
import { selectPlannerLoaded, selectPlannerSettled } from '@/lib/planner-ready';
import { isWaitingPaste, openStampedEdit, useUIStore, type ActiveDialog } from '@/lib/ui-store';
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
 * Decided on the preview's true→false edge, and opened only after a SUCCESSFUL
 * landing for the account it was asked under. A failed load, a crash drop and
 * an account change all end the preview too, and each drops the request: there
 * is nothing real to open it on, or it was asked for by somebody else.
 *
 * Also decided at MOUNT, for a request deferred while no promoter was mounted
 * whose preview ended before one mounted: a door off `/` (the /settings
 * arm-then-push) whose landing beat AppShell's mount saw no edge, and the edge
 * never comes twice. The same rules apply there.
 *
 * The payload was built from cached rows, so it is re-resolved against fresh
 * ones: an edit-item reopens on the fresh row (or not at all if it is gone),
 * and a new organizer starts only with items that still exist.
 *
 * One slot, plus the confirm's: whatever claimed either since the request
 * wins, and the request is dropped.
 *
 * A pasted list (`isWaitingPaste`) is the exception to both drops. The paste
 * was consumed by the field, so the request is the only place its text
 * exists. It waits for the slot and the confirm to free, then opens; and it
 * opens over a FAILED load as well, as a paste made after the failure would
 * (lib/held-captures.ts files a capture then for the same reason). The rows
 * it files there are kept by held-captures until a landing confirms them, as
 * a capture's are (addTasksBulk reports them through lib/filed-rows.ts). It
 * waits out a crash drop's skeleton for the load to finish. Only another
 * account (or none) drops it.
 *
 * Mounted once in AppShell, so leaving `/` unmounts it and drops a pending
 * request, the way ConsoleSlotGuard drops a stranded slot.
 */
export function useDeferredDialogPromotion(): void {
  useEffect(() => {
    hosts += 1;
    // A request whose preview ended before this mounted.
    settleQuietly();
    // Optional-called: a unit test that mocks `@/lib/planner-store` with only
    // the members it needs has no `subscribe`. Inside the landing set(): a
    // throw here must never escape into the load (settleQuietly).
    const unsubscribePlanner = usePlannerStore.subscribe?.((s, prev) => {
      if (prev.isPreview && !s.isPreview) settleQuietly(prev.userId);
      // A load that finished after the preview had already gone (a crash
      // drop): only a pasted list can still be waiting by then.
      else if (!selectPlannerSettled(prev) && selectPlannerSettled(s)) settleQuietly();
    });
    // A pasted list waiting for the slot: opened once the slot and the confirm
    // are both free.
    const unsubscribeUI = useUIStore.subscribe((u) => {
      if (!u.deferredDialog || u.activeDialog || u.confirmRequest) return;
      settleQuietly();
    });
    return () => {
      unsubscribePlanner?.();
      unsubscribeUI();
      hosts -= 1;
      // Leaving `/` drops the request — but a microtask later, and only if no
      // promoter came back meanwhile. React StrictMode (on for the App Router
      // in development) runs this cleanup straight after the first mount and
      // re-mounts in the same task, which would wipe the request that a door
      // off-shell deferred and then pushed `/` to open — the trap
      // lib/console-door.ts and ConsoleSlotGuard each describe. A re-mount in
      // the same task has a host for it, so keeping it is right there too.
      queueMicrotask(() => {
        if (hosts === 0) useUIStore.setState({ deferredDialog: null, deferredFor: null });
      });
    };
  }, []);
}

/** Re-entered by the slot subscription while it opens; nothing to decide twice. */
let settling = false;

function settleQuietly(edgeFromUserId?: string | null): void {
  if (settling) return;
  settling = true;
  try {
    settle(edgeFromUserId);
  } catch {
    // Losing a deferred dialog is the safe failure.
  } finally {
    settling = false;
  }
}

/**
 * Open, keep or drop the waiting request against the planner as it is now.
 * `edgeFromUserId` is the account the preview that just ended belonged to;
 * undefined off that edge (at mount, when a load finishes, when the slot frees).
 */
function settle(edgeFromUserId?: string | null): void {
  const ui = useUIStore.getState();
  const deferred = ui.deferredDialog;
  if (!deferred) return;
  const s = usePlannerStore.getState?.();
  // Still the preview: its edge decides.
  if (!s || s.isPreview) return;

  const drop = () => {
    if (useUIStore.getState().deferredDialog === deferred) {
      useUIStore.setState({ deferredDialog: null, deferredFor: null });
    }
  };

  if (!ownedBy(s.userId, ui.deferredFor ?? null, edgeFromUserId)) return drop();
  const paste = isWaitingPaste(deferred);
  if (paste) {
    // Landed or failed, either way finished; still loading, it waits. Over a
    // failed load its rows are kept until a landing confirms them (see above).
    if (!selectPlannerSettled(s)) return;
  } else if (!selectPlannerLoaded(s)) {
    return drop();
  }
  const fresh = resolveOnFresh(deferred, s.items);
  if (!fresh) return drop();
  if (ui.activeDialog || ui.confirmRequest) return paste ? undefined : drop();
  // Opened BEFORE the request is cleared: a data slot opened on real data
  // clears it in the same set(), so a subscriber watching the request (an
  // item's conversation waiting to reveal itself, lib/open-chat.ts) sees it
  // turn into the open dialog, never into nothing first.
  // An item goes the way openEditFor sends one, so the phone's Ask tab
  // (rail-store's interceptor) still takes it over the drawer.
  if (fresh.type === 'edit-item') openStampedEdit(fresh.item);
  else ui.openDialog(fresh);
  // The interceptor took it and left the slot as it was.
  drop();
}

/**
 * Whether the request may open for the account the planner now holds. On the
 * preview's edge the account must not have changed across it, as before. The
 * request's own stamp (ui-store's `deferredFor`) must match whenever there is
 * one, and off the edge a request with no stamp never opens.
 */
function ownedBy(userId: string | null, stamp: string | null, edgeFromUserId?: string | null): boolean {
  if (!userId) return false;
  if (edgeFromUserId !== undefined && edgeFromUserId !== userId) return false;
  if (stamp !== null) return stamp === userId;
  return edgeFromUserId !== undefined;
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
