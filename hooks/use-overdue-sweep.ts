'use client';

import { useEffect } from 'react';
import { usePlannerStore } from '@/lib/planner-store';
import { useMorningStore, readPersistedAutoAgeLastRunDate } from '@/lib/morning-store';
import { toDateStr } from '@/lib/recurrence';
import { selectOverdue, daysOverdue, toDateOnly } from '@/lib/overdue';
import { milestoneItemIds } from '@/lib/goals';
import { inactiveItemIdsOn, type Pausable } from '@/lib/active';
import { releasedOn } from '@/lib/sweep-grace';
import type { Item, Routine, Season } from '@/lib/planner-types';

/** Did this pause interval end within the trailing `windowDays`? */
function pauseEndedRecently(x: Pausable, todayStr: string, windowDays: number): boolean {
  const until = x.pausedUntil;
  if (!x.pausedAt || !until) return false;
  const resumed = toDateOnly(until);
  if (resumed > todayStr) return true; // still paused (belt-and-braces)
  return daysOverdue({ startDate: resumed }, todayStr) <= windowDays;
}

/** Did `dateStr` fall inside the trailing `windowDays`, today included? */
function withinTrailingWindow(dateStr: string, todayStr: string, windowDays: number): boolean {
  const day = toDateOnly(dateStr);
  if (day > todayStr) return true; // boundary still ahead (belt-and-braces)
  return daysOverdue({ startDate: day }, todayStr) <= windowDays;
}

/**
 * Did this SEASON stop suppressing its members within the trailing window?
 *
 * Two arms, both deliberately over-broad:
 *
 * (b) An `auto` season's `startsOn` is a resume boundary in exactly the way a
 *     pause's `pausedUntil` is — the day the range opened is the day its members
 *     came back, and they accrued overdue age the whole time they were hidden.
 * (c) `updatedAt` on any container, as a conservative proxy for a MANUAL state
 *     flip. Nothing records when someone switched a season from paused to
 *     active — the tri-state has no history — so there is no honest date to
 *     grace against, and the only alternative to this proxy is no grace at all
 *     for the single most likely way a season gets turned back on. It is wrong
 *     in the safe direction: renaming a season merely delays sweeping its
 *     members by the window.
 */
function seasonEndedSuppressionRecently(
  season: Season,
  todayStr: string,
  windowDays: number,
): boolean {
  if (
    season.state === 'auto' &&
    season.startsOn &&
    withinTrailingWindow(season.startsOn, todayStr, windowDays)
  ) {
    return true;
  }
  return !!season.updatedAt && withinTrailingWindow(season.updatedAt.slice(0, 10), todayStr, windowDays);
}

/**
 * Did this item come off a suppression within the trailing `windowDays` — its
 * OWN, or one of its containers'?
 *
 * Reads recorded intervals where they exist: `pausedUntil` is the resume date,
 * and it survives a manual resume precisely so this is answerable. The container
 * arms matter for the same reason the item arm does — a routine's pause or a
 * season being off suppresses members just as thoroughly as an item's own
 * pause, so coming back has to earn the same window. Without them the sweep
 * unschedules a whole season the morning after it resumes: the exact disaster
 * the exclusion exists to prevent, merely relocated from the item to the
 * container.
 *
 * Every arm errs toward NOT sweeping. The cost of a false grace is one more day
 * of a stale row; the cost of a false sweep is a silent mass-unschedule of work
 * the user never stopped caring about.
 */
function resumedRecently(
  item: Item,
  todayStr: string,
  windowDays: number,
  routines: readonly Routine[],
  seasons: readonly Season[],
): boolean {
  if (pauseEndedRecently(item, todayStr, windowDays)) return true;

  // The container that was hiding this item may be GONE — deleted, or no longer
  // holding it. Then there is no resume date to read anywhere, because the row
  // it would have been read from is exactly what was removed, and the item
  // reappears carrying every day of age it accrued while hidden. lib/sweep-grace
  // records those releases as they happen; see that module for why it is
  // device-local.
  const released = releasedOn(item.id);
  if (released && withinTrailingWindow(released, todayStr, windowDays)) return true;

  const holdingRoutines = routines.filter((r) => r.itemIds.includes(item.id));
  if (holdingRoutines.some((r) => pauseEndedRecently(r, todayStr, windowDays))) return true;

  // A season reaches this item directly OR through any routine holding it —
  // the same two membership shapes the resolver walks. Missing the indirect one
  // would leave every routine-in-a-season member ungraced, which is the common
  // case once seasons are used at all.
  const routineIds = new Set(holdingRoutines.map((r) => r.id));
  return seasons.some(
    (p) =>
      (p.itemIds.includes(item.id) || p.routineIds.some((id) => routineIds.has(id))) &&
      seasonEndedSuppressionRecently(p, todayStr, windowDays),
  );
}

/**
 * use-overdue-sweep — the OPT-IN "auto-clear stale items" decay (user decision D1).
 *
 * WHAT IT DOES
 * Once per calendar day, per user, per device, it takes every past-due item
 * that has been past due for MORE than `morningAutoAgeDays` days and
 * unschedules it — the item loses its startDate/timeBucket/startTime and falls
 * into the Braindump. Nothing is deleted, nothing is marked cancelled (D2:
 * there is no archive verb), and the whole sweep is one undoable step.
 *
 * WHY IT IS OFF BY DEFAULT
 * `morningAutoAgeEnabled` defaults to FALSE. This is a background mutation of the
 * user's data that they did not initiate and may not be looking at when it
 * happens, so the out-of-the-box behaviour has to be exactly today's behaviour:
 * nothing moves unless the user touches it. Decay is something you opt into after
 * you have decided the past-due pile is noise, not something the app decides for
 * you. Every gate below is written to fail CLOSED — any doubt (settings not
 * hydrated, data not loaded, an unresolved timezone, a nonsensical threshold)
 * means "don't sweep".
 *
 * WHY EVERY INPUT IS PROVEN TO BELONG TO THIS USER BEFORE ANYTHING MOVES
 * This hook is the only unattended writer in the app, and its inputs arrive on
 * three independent, unordered channels: items (planner-store's
 * initializeStore), settings (supabase-provider's hydrateSettings), and
 * localStorage (zustand persist, browser-global, written by whoever used this
 * profile last). Nothing sequences those channels, so "the planner finished
 * loading" says NOTHING about whose auto-age settings are in memory — and on a
 * shared browser, or on a second device where the setting was switched off
 * elsewhere, the value sitting in localStorage belongs to someone else or to
 * an older decision. Every consumer of that state can afford to be briefly
 * wrong and self-correct on the next render; this one cannot, because it
 * writes. So it waits for a positive, per-user signal on each channel:
 * `settingsHydratedUserId === userId` for settings, and a non-null
 * `userTimezone` for the day boundary. Both are subscribed values, so the
 * sweep re-arms the instant they resolve rather than depending on which
 * request happened to land first.
 *
 * WHY ONCE PER DAY
 * The sweep is idempotent in outcome but not in feel: re-running it on every mount
 * or every focus would fire an undo toast repeatedly, and each run would push
 * another history entry, evicting the user's real undo stack (planner-store caps
 * history at MAX_HISTORY_SIZE=50). `morningAutoAgeLastRunByUser` is stored
 * LOCAL-ONLY on purpose — it is a "have I already bothered you today on this
 * device" flag, not a piece of account state worth syncing — but it is keyed by
 * userId, because on a shared browser a single string meant the first person to
 * sign in that day silently consumed the second person's sweep.
 *
 * WHY THE BATCHED ACTION
 * It calls `unscheduleTasks(ids)`, not a loop over `unscheduleTask(id)`. The
 * batched action does ONE `set()`, which means one history snapshot, one undo
 * toast, and one Cmd+Z to reverse the entire sweep. A loop over 40 stale items
 * would push 40 deep clones of the item array, blow away the user's earlier
 * history, and require 40 presses of Cmd+Z to put things back — which for an
 * unattended background mutation is effectively "not undoable".
 */
export function useOverdueSweep() {
  // Reactive deps, deliberately narrow.
  //
  // In particular the last-run stamp is NOT subscribed to — it is read through
  // getState() below — because writing it is the last thing this effect does,
  // and subscribing would re-run the effect immediately after it stamps.
  const morningCheckEnabled = useMorningStore((s) => s.morningCheckEnabled);
  const autoAgeEnabled = useMorningStore((s) => s.morningAutoAgeEnabled);
  const autoAgeDays = useMorningStore((s) => s.morningAutoAgeDays);
  // Hydration signals — see the long comments on gates 1–3.
  const settingsHydratedUserId = useMorningStore((s) => s.settingsHydratedUserId);
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);
  const loadError = usePlannerStore((s) => s.error);
  const userTimezone = usePlannerStore((s) => s.userTimezone);

  useEffect(() => {
    // ── Gate 1: items have actually finished hydrating from Supabase ──────────
    // `isLoading` alone is NOT a hydration signal: planner-store initialises it
    // to `false` (:431) and only flips it to `true` when initializeStore() starts
    // (:475), so `!isLoading` is also true for the entire pre-login window when
    // `items` is `[]`. `userId` is null until that same set(), so
    // `userId && !isLoading` is the real "load has started AND finished" edge.
    //
    // Sweeping an empty array is harmless in itself (selectOverdue returns []),
    // but it would still stamp the last-run date and suppress the real sweep for
    // the rest of the day. `error` is checked for the same reason: a failed
    // fetch also lands on `isLoading: false` with empty items.
    //
    // A partially-loaded array can't happen here — initializeStore does a single
    // Promise.all followed by a single set() — but if that ever changes, this
    // gate is the place that has to grow.
    //
    // That single-set() property is now load-bearing for ROUTINES and SEASONS
    // too, not just items. Both fetches ride the same Promise.all and land in
    // the same set() that clears `isLoading`, so passing this gate guarantees
    // membership is known — which the suppression exclusion and the container
    // resume-grace below both depend on. Hydrate either separately (a lazy
    // fetch, a second effect) and this sweep starts running against an empty
    // container list: every member of a paused routine or a switched-off season
    // reads as unprotected and gets unscheduled in one silent batch. If they
    // ever move out of that Promise.all, they need their own gate here FIRST.
    //
    // GOALS joined that list for a third reason, and it is the sharpest of the
    // three. This sweep clears `startDate`, and on a milestone that field is
    // not stale scheduling residue — it is the target date, the only record of
    // when the checkpoint was meant to happen. `unscheduleTasks` subtracts
    // milestone-role items before it writes, so it needs the goal list to be
    // populated; hydrate goals separately and the sweep sees none, reads every
    // milestone as an ordinary stale task, and erases a year of target dates in
    // one unattended batch that no toast even announces.
    if (!userId || isLoading || loadError) return;

    // ── Gate 2: the SETTINGS in memory demonstrably belong to THIS user ───────
    // Gate 1 is about items and says nothing about settings; the two requests
    // are fired in the same tick with no ordering and the planner one routinely
    // resolves first. Until this matches, `autoAgeEnabled`/`autoAgeDays` are
    // whatever zustand rehydrated from localStorage — which is browser-global
    // and therefore, on a shared browser, the previous account's answer, and on
    // a second device, an answer the user has since changed elsewhere.
    //
    // `settingsHydratedUserId` is set by applyServerSettings in the same set()
    // as the values it vouches for, and is not persisted, so it is null on
    // every page load until a Supabase response for the currently signed-in
    // user lands. Sign-out and account switches reset it via
    // clearUserScopedState. Equality with the planner's `userId` — not merely
    // non-null — is what rules out acting on the wrong account's settings.
    if (settingsHydratedUserId !== userId) return;

    // ── Gate 3: the day boundary is the USER's, not the machine's ────────────
    // `userTimezone` is set only by hydrateSettings and is absent from
    // planner-store's partialize, so it is null on every page load. The old
    // `|| Intl…resolvedOptions().timeZone` fallback therefore resolved to the
    // MACHINE zone whenever the items request beat the settings request, and
    // stamping the run date made that wrong day boundary permanent for the day:
    // at UTC+13 vs UTC-4 the two disagree about which calendar day it is for
    // several hours, which is the difference between "past due by 30 days" and
    // "past due by 31" — i.e. between skipping an item that should be swept and
    // unscheduling one a full day early. Every other consumer of the fallback
    // (the bar, the goto.overdue command) re-renders and self-corrects; this one
    // writes and then suppresses its own retry, so it is the one place the
    // fallback is unacceptable.
    //
    // NOTE: gate 2 does not subsume this. `timezone` is a nullable column and
    // hydrateSettings stores `settings.timezone?.trim() || null`, so a hydrated
    // user can legitimately have no zone — an account whose row has never been
    // touched by use-timezone-sync. Fail closed and skip the day; the sync
    // PATCHes the browser zone on every app load, so the next load has one.
    if (!userTimezone) return;

    // ── Gate 4: the feature is switched on ────────────────────────────────────
    // `morningCheckEnabled` is checked too, not just `morningAutoAgeEnabled`.
    // The settings UI nests both auto-age rows inside `{morningCheckEnabled &&
    // …}`, so turning the morning check off hides the auto-age switch while
    // leaving its stored value at `true`. Without this check the user would be
    // left with an invisible control silently mutating their data.
    if (!morningCheckEnabled || !autoAgeEnabled) return;

    // ── Gate 5: the threshold is sane ─────────────────────────────────────────
    // The settings Select only offers 7/14/30/60/90, but this value round-trips
    // through a nullable Supabase column and a `Number(v)` cast. A NaN or a 0
    // would turn "past due by more than N days" into "everything past due", so
    // an unusable threshold means we do nothing at all rather than guess a
    // fallback — and we deliberately do NOT stamp the run date, so fixing the
    // setting re-arms the sweep the same day.
    if (!Number.isFinite(autoAgeDays) || autoAgeDays < 1) return;

    const planner = usePlannerStore.getState();

    // The day boundary, timezone-resolved: the same helper day-items.ts and the
    // recurrence engine use, so "past due by 31 days" means the same thing here
    // as it does in the views the user is looking at.
    const todayStr = toDateStr(new Date(), userTimezone);

    // ── Gate 6: at most once per calendar day, per user, per device ───────────
    // Read fresh from getState() rather than from a subscribed value, which also
    // makes this the StrictMode guard: React 18/19 mounts effects twice in dev
    // (effect → cleanup → effect), and because the stamp below is written
    // synchronously inside the first invocation, the second invocation reads it
    // and returns here. The sweep itself is idempotent; the undo toast is not,
    // which is what this protects.
    const morning = useMorningStore.getState();
    if (morning.getAutoAgeLastRunDate(userId) === todayStr) return;

    // ── Selection ─────────────────────────────────────────────────────────────
    // selectOverdue() is the ONE definition of past due (lib/overdue.ts) — it is
    // already recurrence-safe (a recurring chore's misses are per-date state, so
    // it can never be past due as a whole and must never be swept), already
    // excludes completed/cancelled, and already respects the item-type registry's
    // carryForwardEligible/dateAnchored capabilities. Never re-implement it here.
    // `> autoAgeDays` is exactly "past due by MORE than N days".
    const routines = planner.routines;
    const seasons = planner.seasons;
    const inactive = inactiveItemIdsOn(planner.items, todayStr, {
      userTimezone,
      routines,
      seasons,
    });
    const stale = selectOverdue(planner.items, todayStr, inactive).filter(
      (item) => daysOverdue(item, todayStr) > autoAgeDays,
    );

    // ── Resume grace ─────────────────────────────────────────────────────────
    // Excluding suppressed items above is necessary but NOT sufficient, and the
    // gap is this sweep's worst failure mode. daysOverdue counts from startDate,
    // which a pause never moves, so age keeps accruing THROUGH a pause: the
    // exclusion protects an item only while it is paused. Come back from a
    // 35-day break with a 30-day threshold and every dated item resurfaces
    // already past the line, so the next morning's sweep unschedules the lot in
    // one batch — exactly the disaster the exclusion was supposed to prevent,
    // merely deferred by the length of the pause.
    //
    // So: an item whose pause ended within the trailing window gets the window
    // to be dealt with, measured from the resume rather than the due date. This
    // is why a manual resume normalizes to `pausedUntil = today` instead of
    // clearing the pause pair — the interval has to survive on the row for this
    // to be computable at all.
    const graced = stale.filter(
      (item) => !resumedRecently(item, todayStr, autoAgeDays, routines, seasons)
    );

    // Milestones are subtracted HERE, not left to unscheduleTasks to refuse.
    // The verb already declines them — a milestone's startDate is the goal's
    // target date, not stale scheduling residue — but the receipt below is
    // built from this list, and a receipt is a promise about what happened.
    // Left in, the dock would announce "N items put aside this morning"
    // counting milestones still sitting on their dates, and its "Put back"
    // would then write their PRE-SWEEP scheduling over them hours later,
    // silently reverting any deliberate reschedule made in between. When every
    // stale item is a milestone the verb writes nothing at all, so the notice
    // would be pure fiction.
    const milestones = milestoneItemIds(planner.goals);
    const sweepable = graced.filter((item) => !milestones.has(item.id));
    if (sweepable.length === 0) return;

    // ── Gate 7: no sibling tab beat us to it ─────────────────────────────────
    // Gate 6 only saw this tab's copy of the store. Two tabs open at the same
    // moment pass it together and both mutate: same outcome, but two history
    // entries evicted from a 50-deep stack and two undo toasts. Re-reading the
    // stamp off disk here — persist writes localStorage synchronously inside
    // set() — costs one getItem and shrinks the window to the gap between this
    // line and the set() below. Not a lock, and deliberately not one: a real
    // cross-tab lock is a lot of machinery for a race whose worst outcome is a
    // duplicate toast.
    if (readPersistedAutoAgeLastRunDate(userId) === todayStr) return;

    // Snapshot BEFORE the mutation — these are the fields it is about to clear,
    // and they are the only record of them that will exist afterwards. The
    // receipt is what lets the dock offer "Put them back" as a forward action
    // hours later, when popping the history stack would reverse something else
    // entirely (lib/planner-store.ts `restoreScheduling`).
    const receipt = {
      date: todayStr,
      items: sweepable.map((item) => ({
        id: item.id,
        title: item.title,
        isScheduled: 'isScheduled' in item ? !!item.isScheduled : false,
        startDate: 'startDate' in item ? item.startDate : undefined,
        timeBucket: item.timeBucket,
        startTime: item.startTime,
      })),
    };

    // ONE batched action => one history entry => one undo.
    //
    // The undo TOAST is deliberately stood down with the label override. It
    // used to fire on its own, because `Unschedule task:` is a
    // SIGNIFICANT_ACTIONS prefix in hooks/use-undo-toast.ts — but a five-second
    // toast is a confirmation of something the user just did, and this ran
    // unattended, frequently before the tab was even open. It appeared at
    // whatever instant the app happened to load and then it was gone, which is
    // why the sweep was effectively silent. The dock line replaces it and
    // persists (components/sidebar/dock-notices.tsx). ⌘Z is untouched — the
    // history entry is still written, only the toast is suppressed.
    planner.unscheduleTasks(
      sweepable.map((item) => item.id),
      { label: `Aged out: ${sweepable.length} items` },
    );
    morning.setAutoAgeReceipt(userId, receipt);

    // Stamp AFTER the mutation, never before.
    //
    // The old order stamped first to make the once-per-day guard atomic against
    // re-entrancy, but that also burned the day on any run that then failed to
    // mutate — including runs that were about to act on the wrong settings or
    // the wrong day boundary, which is precisely how a corrected setting could
    // no longer re-arm the sweep. Stamping after loses nothing: `unscheduleTasks`
    // is a single synchronous set() with fire-and-forget DB writes, so by the
    // time this line runs the mutation has either fully applied or thrown, and
    // StrictMode's second invocation still finds the stamp already written.
    morning.setAutoAgeLastRunDate(userId, todayStr);
  }, [
    morningCheckEnabled,
    autoAgeEnabled,
    autoAgeDays,
    settingsHydratedUserId,
    userId,
    isLoading,
    loadError,
    userTimezone,
  ]);
}
