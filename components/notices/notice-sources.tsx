'use client';

import { useEffect, useMemo, useState } from 'react';
import { CloudOff, MoonStar, Sunset } from 'lucide-react';

import { usePlannerStore } from '@/lib/planner-store';
import { useMorningStore } from '@/lib/morning-store';
import { useEODStore } from '@/lib/eod-store';
import { minutesOfDay, nowMinutesIn, shouldShowEodNotice } from '@/lib/eod';
import { toDateStr } from '@/lib/recurrence';
import { NOTICE_RANK, type DockNotice } from '@/lib/dock-notices';

/**
 * The notices that have an object, and the one that has none.
 *
 * Lifted out of components/sidebar/dock-notices.tsx by the "back to the object"
 * change so that a surface holding a notice IN PLACE (the braindump, the foot of
 * today's column) can raise it without importing the dock — and, more to the
 * point, without importing the waiting notice, whose hook closes its tray on
 * unmount and must therefore be called from exactly one place.
 *
 * The waiting notice stays in components/ai/morning-check.tsx: it is dock-only,
 * for the reasons in memory/plans/notices-in-place.md.
 */

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
    actionLabel: 'Put back',
    onSelect: () => {
      restoreScheduling(receipt.items);
      clearAutoAgeReceipt(userId);
    },
    // Waving it away is not the same as putting them back — it drops the
    // receipt only. The items stay where the sweep left them, in the braindump,
    // which is where the setting the user turned on says they belong.
    onDismiss: () => clearAutoAgeReceipt(userId),
    dismissLabel: 'Dismiss this receipt',
  };
}

/**
 * "Today's review is waiting" — the review's first in-app entry point.
 *
 * Ranked `decision` alongside the waiting pile: the review is a thing only the
 * user can do, and it is the one surface in the app that was reachable ONLY
 * through a push notification. Deny the permission or swipe the notification
 * away and, before this line, nothing on screen ever mentioned it again.
 *
 * Deliberately not a modal that opens itself. The review is a ritual, not an
 * interruption, and the case for the line is precisely that it can wait there
 * instead of ambushing whatever the user was doing at 21:00.
 *
 * ANCHORED BESIDE THE DATE, in the canvas header row. The review's object is the
 * day, and a day's handle is its date — the same argument ProgramNotice makes
 * from the same address. The slot is live only on today, so arrowing to Thursday
 * puts the line back on the dock rather than beside a date it is not about.
 *
 * It was briefly at the FOOT of the day column, which is where direction E drew
 * it. That is wrong for a reason the drawing could not know: lib/use-fit-hour-px.ts
 * keeps 24px below the schedule grid and counts only the chrome above it, so a
 * row down there is invisible to the fit and makes a compressed day scroll.
 */
export function useEodNotice(): DockNotice | null {
  const eodReviewEnabled = useEODStore((s) => s.eodReviewEnabled);
  const eodReviewTime = useEODStore((s) => s.eodReviewTime);
  const lastEodReviewDate = useEODStore((s) => s.lastEodReviewDate);
  const eodDeferredDate = useEODStore((s) => s.eodDeferredDate);
  const hasHydrated = useEODStore((s) => s._hasHydrated);
  const open = useEODStore((s) => s.open);
  const deferToday = useEODStore((s) => s.deferToday);
  const { todayStr, tz } = useToday();

  const nowMinutes = nowMinutesIn(new Date(), tz);
  const due = minutesOfDay(eodReviewTime);

  /**
   * Wake up ONCE, at the review hour.
   *
   * Everything else on this surface is driven by a store write, so it re-renders
   * when its answer changes. This one is driven by a clock: sit with the app
   * open from 20:00 and nothing at all happens at 21:00, so the line would only
   * appear whenever some unrelated state next moved it. A single timeout for the
   * exact crossing beats a minute-interval that re-renders the notice stack all
   * day to catch one moment.
   *
   * Only the crossing. Midnight rollover is left alone deliberately — the
   * waiting notice resolves `todayStr` at render for the same reason, and an app
   * left open across midnight is a rarer case than an app left open all evening.
   */
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasHydrated || !eodReviewEnabled || due === null) return;
    if (nowMinutes >= due) return;
    const ms = (due - nowMinutes) * 60_000;
    const timer = setTimeout(() => setTick((n) => n + 1), ms);
    return () => clearTimeout(timer);
  }, [hasHydrated, eodReviewEnabled, due, nowMinutes]);

  // Pre-hydration the store holds its defaults, and `eodReviewEnabled` defaults
  // false — so this is belt and braces rather than load-bearing. It costs one
  // boolean and it means the line can never flash in on a rehydrate that is
  // about to say "already reviewed".
  if (!hasHydrated) return null;

  const owed = shouldShowEodNotice(
    { eodReviewEnabled, eodReviewTime, lastEodReviewDate, eodDeferredDate },
    todayStr,
    nowMinutes
  );
  if (!owed) return null;

  return {
    id: 'eod-review',
    rank: NOTICE_RANK.decision,
    anchor: 'day-header',
    icon: Sunset,
    iconClassName: 'text-sunrise-glyph',
    label: <span className="font-semibold">Today’s review is waiting</span>,
    actionLabel: 'Start',
    onSelect: open,
    onDismiss: () => deferToday(todayStr),
    dismissLabel: 'Not tonight',
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
  const eod = useEodNotice();
  const sweep = useSweepNotice();
  return [eod, sweep].filter((n): n is DockNotice => n !== null);
}
