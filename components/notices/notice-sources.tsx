'use client';

import { useMemo, useState } from 'react';
import { CloudOff, MoonStar } from 'lucide-react';

import { usePlannerStore } from '@/lib/planner-store';
import { selectPlannerLoaded, selectPlannerSettled } from '@/lib/planner-ready';
import { useMorningStore } from '@/lib/morning-store';
import { toDateStr } from '@/lib/recurrence';
import { NOTICE_RANK, type DockNotice } from '@/lib/dock-notices';

/**
 * The notices that have an object, and the one that has none.
 *
 * Lifted out of components/sidebar/dock-notices.tsx by the "back to the object"
 * change so that a surface holding a notice IN PLACE (the braindump, the foot of
 * today's column) can raise it without importing the dock — and, more to the
 * point, without importing the dock's own sources.
 *
 * The waiting notice and the end of day line that used to sit beside these are
 * gone (ghost rows phase 2, memory/plans/ghost-rows.md): the leftovers fold at
 * the top of Today answers both.
 */

/**
 * Where the planner's load is, for a verb that acts on it.
 *
 *  - loaded: fresh data landed for this account. The verb is live.
 *  - syncing: a load is in flight (the look-only preview included), or has
 *    not started. The verb reads "Syncing…" with no onSelect.
 *  - failed: the load finished and failed. Nothing is syncing, so the verb is
 *    left off and the line keeps only its label and ✕: the "Couldn't load your
 *    data" Retry beside it is the way on.
 */
type LoadPhase = 'loaded' | 'syncing' | 'failed';

function useLoadPhase(): LoadPhase {
  return usePlannerStore((s) =>
    selectPlannerLoaded(s) ? 'loaded' : selectPlannerSettled(s) ? 'failed' : 'syncing'
  );
}

/** The verb as `phase` allows it: live once loaded, "Syncing…" while loading, none after a failure. */
function gatedVerb(
  phase: LoadPhase,
  label: string,
  onSelect: () => void
): Pick<DockNotice, 'actionLabel' | 'onSelect'> {
  if (phase === 'loaded') return { actionLabel: label, onSelect };
  // Undefined onSelect is inert in both renderers (the dock's NoticeRow, InPlaceNotice).
  return { actionLabel: phase === 'syncing' ? 'Syncing…' : undefined, onSelect: undefined };
}

/** Today, in the user's SAVED timezone — the app-wide `toDateStr` convention. */
function useToday(): { todayStr: string; tz: string } {
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { todayStr: toDateStr(new Date(), tz), tz };
}

/**
 * The one notice with no feature behind it.
 *
 * `planner-store.error` has been set on every failed load since the store was
 * written and read by precisely nothing — a silent failure mode that survived
 * because there was nowhere to put it that wasn't a modal or a toast, and
 * neither is right for a condition that persists until someone acts. That is
 * the argument for this surface in one bug.
 *
 * NO ANCHOR, and it could not have one: the failure is the store, not a row, a
 * day or a list. It is also the notice E's stated tradeoff is about — the one
 * thing that must never be somewhere you have to scroll to — so `placeNotices`
 * pins every `blocked` notice to the dock whatever anchor it grows later.
 */
export function useSyncErrorNotice(): DockNotice | null {
  // The field initializeStore's guard reads, so this row offers a Retry
  // exactly when a retry will load. `error` says the same thing today, but it
  // is a message slot: a row keyed on it would offer a Retry that does nothing
  // for any failure that was not the load's.
  const failedUserId = usePlannerStore((s) =>
    s.loadFailedUserId !== null && s.loadFailedUserId === s.userId ? s.loadFailedUserId : null
  );
  const initializeStore = usePlannerStore((s) => s.initializeStore);
  // A dismissal lasts one failure. A retry starting clears the field, and the
  // dismissal with it, so the next failure shows. It used to be keyed on the
  // message, but every failure stores the same fallback text (the fetchers
  // throw Supabase's plain error objects, not Errors), so one ✕ hid every
  // later failure, including the retries the provider makes on its own.
  const [dismissed, setDismissed] = useState(false);
  if (dismissed && !failedUserId) setDismissed(false);

  if (!failedUserId || dismissed) return null;

  return {
    id: 'sync-error',
    rank: NOTICE_RANK.blocked,
    icon: CloudOff,
    iconClassName: 'text-destructive',
    label: <span className="font-semibold">Couldn’t load your data</span>,
    actionLabel: 'Retry',
    onSelect: () => void initializeStore(failedUserId),
    onDismiss: () => setDismissed(true),
    dismissLabel: 'Dismiss this warning',
  };
}

/**
 * "12 items were put aside this morning" — the app's only unattended write,
 * finally saying so.
 *
 * Ranked `receipt`, below anything asking for a decision: nothing is blocked on
 * this and the sweep was the user's own opt-in setting doing its job. It is
 * here so the work is not silently gone, not to ask forgiveness for it.
 *
 * "Put them back" is `restoreScheduling`, NOT undo. See the note on that verb
 * in lib/planner-store.ts — by the time this line is read the sweep is buried
 * in the history stack, and popping it would reverse whatever the user did
 * last.
 *
 * ANCHORED TO THE BRAINDUMP, which is a deliberate divergence from direction E
 * as drawn ("the day whose contents it changed"): the days it changed are past
 * days and no view renders them. The braindump is where the swept items now ARE,
 * so the receipt sits directly above the rows it is a receipt for, with "Put
 * back" next to the things that would move. See the placement table.
 */
export function useSweepNotice(): DockNotice | null {
  const userId = usePlannerStore((s) => s.userId);
  const restoreScheduling = usePlannerStore((s) => s.restoreScheduling);
  // Put back restores from the LOADED rows and then clears the receipt either
  // way, so pressed over an empty store (a cold load, the preview, a failed
  // load) it would spend the only receipt on nothing. The line stays mounted —
  // nothing inserted mid-landing — and only its verb waits (useLoadPhase).
  const phase = useLoadPhase();
  const receiptsByUser = useMorningStore((s) => s.morningAutoAgeReceiptByUser);
  const clearAutoAgeReceipt = useMorningStore((s) => s.clearAutoAgeReceipt);
  const { todayStr } = useToday();

  // Date-checked here rather than through the store's getter so the component
  // re-renders when the map changes — a getState() read would not subscribe.
  const receipt = useMemo(() => {
    if (!userId) return null;
    const found = receiptsByUser[userId];
    return found && found.date === todayStr && found.items.length > 0 ? found : null;
  }, [receiptsByUser, userId, todayStr]);

  if (!receipt || !userId) return null;

  const n = receipt.items.length;

  return {
    id: 'auto-age-receipt',
    rank: NOTICE_RANK.receipt,
    anchor: 'braindump',
    icon: MoonStar,
    label: (
      <>
        <span className="font-semibold">{n === 1 ? '1 item' : `${n} items`}</span> put aside this
        morning
      </>
    ),
    ...gatedVerb(phase, 'Put back', () => {
      restoreScheduling(receipt.items);
      clearAutoAgeReceipt(userId);
    }),
    // Waving it away is not the same as putting them back — it drops the
    // receipt only. The items stay where the sweep left them, in the braindump,
    // which is where the setting the user turned on says they belong. Live
    // while syncing: dropping the receipt is the user's own call either way.
    onDismiss: () => clearAutoAgeReceipt(userId),
    dismissLabel: 'Dismiss this receipt',
  };
}

/**
 * Every notice that can render somewhere other than the dock.
 *
 * Safe to call from any surface, unlike the full dock set: none of these hooks
 * has an unmount side effect, so mounting them in a second place costs a store
 * subscription and nothing else.
 */
export function useAnchorableNotices(): DockNotice[] {
  const sweep = useSweepNotice();
  return [sweep].filter((n): n is DockNotice => n !== null);
}
