'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import {
  DndContext,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  MeasuringStrategy,
} from '@dnd-kit/core';
import { GripVertical, Circle } from 'lucide-react';
import { DesktopShell } from '@/components/shell/desktop-shell';
import { ConfirmDialog } from '@/components/shell/confirm-dialog';
import { BulkActionBar } from '@/components/shell/bulk-action-bar';
import { OmniLauncher } from '@/components/shell/omni-launcher';
import { inferDropTime } from '@/lib/dnd/infer-drop-time';
import { plannerCollision } from '@/lib/dnd/collision';
import {
  dragInputOf,
  NonTouchPointerSensor,
  POINTER_ACTIVATION_DISTANCE_PX,
  TOUCH_ACTIVATION_DELAY_MS,
  TOUCH_ACTIVATION_TOLERANCE_PX,
} from '@/lib/dnd/sensors';
import { ItemDialog, type ItemDialogState } from '@/components/planner/item-dialog';
import { ContainerDialog } from '@/components/planner/container-dialog';
import { BulkAddDialog } from '@/components/planner/bulk-add-dialog';
import { OrganizeConsole } from '@/components/planner/organize/organize-console';
import { KeyboardShortcutsModal } from '@/components/planner/keyboard-shortcuts-modal';
import { EODReview } from '@/components/ai/eod-review';
import { MobileShell } from '@/components/shell/mobile-shell';
import { ZenStage } from '@/components/zen/zen-stage';
import { OnboardingTour } from '@/components/onboarding/onboarding-tour';
import { BugReportDialog } from '@/components/bug-report/bug-report-dialog';
import { OneTimeNudge } from '@/components/primitives/one-time-nudge';
import { SettleHost } from '@/components/shell/settle-host';

import { batchHistory, usePlannerStore } from '@/lib/planner-store';
import { milestoneItemIds } from '@/lib/goals';
import { tourHideAsk, tourShowAsk, usePanelOverlays, useRailMode } from '@/lib/rail-store';
import { setupPageShown, useMobileNavStore } from '@/lib/mobile-nav-store';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { useUndoStripStore } from '@/lib/undo-strip-store';
import { useItWorksShown } from '@/components/ai/ask/it-works-card';
import { openReviewFromLink } from '@/lib/eod-link';
import { takeConnectReturn } from '@/lib/connect-return';
import { watchKeptQuestion } from '@/lib/ask-pending';
import { flushSettings } from '@/lib/settings-service';
import { useUIStore, openEditFor } from '@/lib/ui-store';
import { ITEM_TYPES } from '@/lib/item-registry';
import { useStreaksEnabled } from '@/lib/extension-gates';
import { useExtensionsStore } from '@/lib/extensions-store';
import { NUDGE_RITUALS_INTRO, NUDGE_STREAKS_ON, ritualsNudgeReady } from '@/lib/nudges/registry';
import { streakNudgeEnabled } from '@/lib/nudges/streak-gate';
import { useMorningStore } from '@/lib/morning-store';
import { useEODStore } from '@/lib/eod-store';
import { settingsBelongToUser } from '@/lib/settings/hydration';
import { adoptLegacyViewPrefs, useViewStore } from '@/lib/view-store';
import { useDragStore } from '@/lib/drag-store';
import { useSelectionStore } from '@/lib/selection-store';
import { hoveredItem } from '@/lib/hovered-item';
import { listGroupMovers, parseProjectBlockId, placementOf, resolveDrop } from '@/lib/dnd/handle-drag-end';
import { sidebarDropPlan } from '@/lib/dnd/sidebar-drop';
import { toDateStr } from '@/lib/recurrence';
import { useCommandShortcuts } from '@/hooks/use-command-shortcuts';
import { useCommandContext } from '@/hooks/use-command-context';
import { useUndoToast } from '@/hooks/use-undo-toast';
import { useTimezoneSync } from '@/hooks/use-timezone-sync';
import { useDeviceRegistration } from '@/hooks/use-device-registration';
import { useOverdueSweep } from '@/hooks/use-overdue-sweep';
import { useCompletionFiling } from '@/hooks/use-completion-filing';
import { useDeferredDialogPromotion } from '@/hooks/use-deferred-dialog';
import { useIsMobile } from '@/hooks/use-mobile';
import { useOneTimeNudge } from '@/hooks/use-one-time-nudge';
import { isOnboardingComplete } from '@/lib/user-profile';
import { watchOnboardingAfterLoad } from '@/lib/onboarding-watch';
import type { MobileTab } from '@/lib/mobile-nav-store';
import { BOOT_SIDEBAR_VAR } from '@/lib/shell-prepaint';

function DraggableTaskOverlay({ title, count = 0 }: { title: string; count?: number }) {
  return (
    <div className="relative flex min-w-48 items-start gap-2 rounded-lg border border-border bg-card p-3 shadow-soft-lg">
      {/* Group drag: a count badge over the primary row, so you see what you
          grabbed AND how many travel with it. */}
      {count > 1 && (
        <span className="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-xs font-medium text-primary-foreground shadow-soft-sm">
          {count}
        </span>
      )}
      <GripVertical className="mt-0.5 h-4 w-4 text-muted-foreground" />
      <Circle className="mt-0.5 h-4 w-4 text-muted-foreground/40" />
      <div className="min-w-0 flex-1">
        <p className="font-content text-content text-foreground">{title}</p>
      </div>
    </div>
  );
}

/** Own subscriber so mounting the ghost never waits on an AppShell render. */
function DragGhost() {
  const activeId = useDragStore((s) => s.activeId);
  // Count travels only when the dragged row is itself part of a multi-selection.
  const groupCount = useSelectionStore((s) =>
    activeId && s.selectedIds.has(activeId) && s.selectedIds.size >= 2 ? s.selectedIds.size : 0
  );
  const title = usePlannerStore((s) =>
    activeId
      ? (s.tasks.find((t) => t.id === activeId) ?? s.habits.find((h) => h.id === activeId))?.title ??
        null
      : null
  );
  return (
    <DragOverlay>
      {title !== null && <DraggableTaskOverlay title={title} count={groupCount} />}
    </DragOverlay>
  );
}

/**
 * The first-run toasts, "Streaks are on" and the rituals intro, with their own
 * subscribers like DragGhost, so the stores they wait on never re-render
 * AppShell. When each may show is streakNudgeEnabled (lib/nudges/streak-gate.ts)
 * and ritualsNudgeReady (lib/nudges/registry.ts). The rituals intro also waits
 * out what the tour's last card can leave on screen: AI setup (the column, or
 * the phone's setup page), the "It works." a connect there ends on, and an undo
 * row such as No AI's. It reads those here, not through a prop, so the mount
 * line below stays as it is. Exported for tests/unit/first-run-nudges.test.tsx,
 * which mounts this rather than a copy of its wiring.
 */
export function FirstRunNudges({
  tourAnsweredFor,
  tourShowing,
}: {
  tourAnsweredFor: string | null;
  tourShowing: boolean;
}) {
  const streaksOn = useStreaksEnabled();
  const extReady = useExtensionsStore((s) => s.configsLoaded);
  const userId = usePlannerStore((s) => s.userId);
  const hasHabit = usePlannerStore((s) => s.habits.length > 0);
  const hasTasks = usePlannerStore((s) => s.tasks.length > 0);
  const settingsHydratedUserId = useMorningStore((s) => s.settingsHydratedUserId);
  const morningCheckEnabled = useMorningStore((s) => s.morningCheckEnabled);
  const eodReviewEnabled = useEODStore((s) => s.eodReviewEnabled);
  // Setup is read per shell, as each shell shows it: the column's own mode on
  // the desktop, the Ask tab holding the setup page on the phone. A `chat` tab
  // left in the store says nothing about a desktop, so it never holds one.
  const isMobile = useIsMobile();
  const railMode = useRailMode(usePanelOverlays());
  const offer = useAICapabilities();
  const onChatTab = useMobileNavStore((s) => s.activeTab === 'chat');
  const setupShowing = isMobile ? onChatTab && setupPageShown(offer) : railMode === 'setup';
  // Both are spent when the person moves on: "It works." by Ask closing, a
  // first send or leaving the phone's Ask tab (lib/rail-store.ts
  // spendJustConnected), an undo row by its own clock. So the intro still
  // comes, after them.
  const itWorks = useItWorksShown();
  const undoUp = useUndoStripStore((s) => s.entry !== null);
  const streakNudgeOn = streakNudgeEnabled({
    extReady,
    streaksOn,
    userId,
    tourAnsweredFor,
    tourShowing,
    hasHabit,
  });
  const ritualsNudgeOn = ritualsNudgeReady({
    settingsHydrated: settingsBelongToUser(userId, settingsHydratedUserId),
    tourAnswered: !!userId && tourAnsweredFor === userId,
    tourShowing,
    hasTasks,
    morningCheckEnabled,
    eodReviewEnabled,
    setupOrUndoUp: setupShowing || itWorks || undoUp,
  });
  // One first-run toast at a time: while the streak nudge is up (or about to
  // be), the rituals one waits its turn rather than stacking under it. An
  // account with no habit gets no streak nudge, so its rituals one never waits.
  const streaksNudgeUp = useOneTimeNudge(NUDGE_STREAKS_ON).active && streakNudgeOn;
  // The gates only decide when a toast first shows. One already up, left from
  // before a Replay tour brought this shell back, would sit over the tour, so
  // both come down while the tour shows. A programmatic dismiss records
  // nothing, and the fresh mount's latch lets each fire again after.
  useEffect(() => {
    if (!tourShowing) return;
    toast.dismiss(NUDGE_STREAKS_ON);
    toast.dismiss(NUDGE_RITUALS_INTRO);
  }, [tourShowing]);
  return (
    <>
      <OneTimeNudge id={NUDGE_STREAKS_ON} enabled={streakNudgeOn} />
      <OneTimeNudge id={NUDGE_RITUALS_INTRO} enabled={ritualsNudgeOn && !streaksNudgeUp} />
    </>
  );
}

/**
 * The one sensor set the app drags with. Two sensors, split by INPUT TYPE and
 * never by viewport — see lib/dnd/sensors.ts for why the plain PointerSensor
 * that used to sit here swallowed every touch gesture before the TouchSensor
 * could see it, and why that made a 5px flick drag a row instead of scrolling
 * the list. Order matters only in that both must be present: the pointer sensor
 * declines fingers, the touch sensor takes them after a hold.
 *
 * Exported because the arbitration between the two is the thing worth testing
 * and it only exists once they are both mounted in a real DndContext —
 * tests/unit/dnd-sensor-pipeline.test.tsx drives this exact hook through
 * pointerdown/touchstart. A test that rebuilt the same `useSensors` call would
 * pass against a shell that had gone back to the plain PointerSensor.
 */
export function useShellSensors() {
  return useSensors(
    useSensor(NonTouchPointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(TouchSensor, TOUCH_SENSOR_OPTIONS)
  );
}

/*
 * The sensors' options, and the shell's measuring config below, live at module
 * scope because dnd-kit memoizes on their IDENTITY. Written inline, every
 * AppShell render minted new objects, so new sensors, new activators and a new
 * DndContext value, which re-rendered every draggable and droppable on the
 * page: two full passes over every row on a warm load, as the AI gate and the
 * extensions answered. The values are the same constants as ever.
 */
const POINTER_SENSOR_OPTIONS = {
  activationConstraint: { distance: POINTER_ACTIVATION_DISTANCE_PX },
};
const TOUCH_SENSOR_OPTIONS = {
  activationConstraint: {
    delay: TOUCH_ACTIVATION_DELAY_MS,
    tolerance: TOUCH_ACTIVATION_TOLERANCE_PX,
  },
};
const SHELL_MEASURING = {
  droppable: {
    strategy: MeasuringStrategy.Always,
  },
};

/**
 * Drag start: the two facts the rest of the app reads off a live drag.
 *
 * Drag state lives in lib/drag-store (NOT useState here): a shell-level
 * setState re-rendered the whole app tree before the ghost could paint.
 *
 * The second fact is the INPUT TYPE, read from this gesture's activator event
 * (`dragInputOf`, lib/dnd/sensors.ts) and held for the drag's lifetime. Views
 * decide which drop targets to mount off it (lib/dnd/drop-targets.ts), so it
 * has to be known before the first collision pass — which is the render this
 * `set` schedules.
 *
 * At module scope, closing over nothing, and exported for the same reason
 * `useShellSensors` is: a test that rebuilt this two-liner would pass against a
 * shell that had gone back to recording the id alone, or to hard-coding
 * `'pointer'`. `tests/unit/dnd-touch-drop-targets.test.tsx` drives THIS.
 */
export function beginDrag(event: DragStartEvent) {
  useDragStore.getState().startDrag(event.active.id as string, dragInputOf(event.activatorEvent));
}

/**
 * App shell: owns the DndContext, global keyboard shortcuts, the EOD deep
 * link, the dialog mount point, and the desktop/mobile split.
 * Extracted from app/page.tsx (P2 of the redesign plan).
 */
export function AppShell() {
  // No planner-store subscription here. Every planner value this shell touches
  // is consumed inside event handlers (drag end, hovered-item shortcuts), so
  // they read usePlannerStore.getState() at event time instead — a reactive
  // subscription made every item write re-render the whole app tree, the same
  // failure mode the DragGhost and hovered-item comments below record.
  // The launcher slot is masked out: AppShell never renders it (OmniLauncher
  // subscribes to it itself), so ⌘K must not re-render the shell tree. The
  // mask maps launcher → null, and Object.is(null, null) skips the render
  // when the launcher opens over an empty slot.
  const activeDialog = useUIStore((s) =>
    s.activeDialog?.type === 'launcher' ? null : s.activeDialog
  );
  // Actions are stable references on the store; selecting them never
  // re-renders. `confirm` is read via getState() at event time below.
  const openDialog = useUIStore((s) => s.openDialog);
  const closeDialog = useUIStore((s) => s.closeDialog);
  const isMobile = useIsMobile();
  const commandContext = useCommandContext();

  useUndoToast();
  useTimezoneSync();
  // This browser re-registers its push subscription once per account per load
  // (the device registry, migration 064).
  useDeviceRegistration();
  // Opt-in past-due decay (off by default). Mounted here, above the
  // desktop/mobile split, so the once-per-day sweep runs on every platform and
  // survives view changes — and declared AFTER useUndoToast so the batched
  // unschedule it fires is picked up by the already-mounted toast subscriber.
  useOverdueSweep();
  // Finished braindump items move onto the day they were finished on, once
  // that day is over (lib/completion-filing.ts). Always on; same mount point
  // and the same load-time gates as the sweep above.
  useCompletionFiling();
  // A data dialog asked for during the look-only preview opens once fresh data
  // lands (lib/ui-store.ts). Here, above the desktop/mobile/Zen swap, so no
  // shell change drops the request; leaving `/` does. <SettleHost /> below is
  // mounted at the same level for the same reason.
  useDeferredDialogPromotion();

  const [mounted, setMounted] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [tourUserId, setTourUserId] = useState<string | null>(null);
  // Whose onboarding answer has come back, either way. Both first-run toasts
  // wait for it, so neither can fire in the gap before a brand-new account's
  // tour opens (FirstRunNudges).
  const [tourAnsweredFor, setTourAnsweredFor] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    adoptLegacyViewPrefs();
  }, []);

  // Settings writes are debounced 500ms; closing the tab inside that window
  // would otherwise drop the patch. pagehide (not beforeunload) is the event
  // that actually fires on mobile Safari. (Saved conversations flush on their
  // own pagehide, registered once by lib/conversations-store.ts.)
  useEffect(() => {
    const onPageHide = () => void flushSettings();
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  // Content typeface toggle — stamp <html data-type-mode> so the CSS token
  // pair in globals.css flips item-title family/weight/size app-wide.
  const typeMode = useViewStore((s) => s.typeMode);
  // Zen REPLACES the desktop shell rather than covering it: an overlay would
  // leave a full second tree mounted and measuring underneath (the schedule
  // grid derives its hour height from live layout), and every TaskRow under it
  // would still be writing lib/hovered-item.ts on mouseenter.
  const zenOpen = useViewStore((s) => s.zenOpen);
  // True for the second both surfaces are mounted (components/zen/zen-stage.tsx):
  // everything below that swaps with the room waits for it to land.
  const zenMoving = useViewStore((s) => s.zenMoving);
  useEffect(() => {
    document.documentElement.dataset.typeMode = typeMode;
  }, [typeMode]);

  // Onboarding status, once the planner load has settled. The account comes
  // off planner-store (identifyUser) rather than a getUser() round trip of its
  // own, and the read waits for the load so it stays out of the cold-start
  // burst. Child effects run before the provider's (see the EOD effect below),
  // so the first check sees no userId and the subscription catches the rest.
  // BOTH answers are applied: a "done" for a newly identified account clears
  // whatever an earlier account left up — see lib/onboarding-watch.ts.
  useEffect(
    () =>
      watchOnboardingAfterLoad({
        getState: usePlannerStore.getState,
        subscribe: usePlannerStore.subscribe,
        isComplete: isOnboardingComplete,
        onResult: (uid, needed) => {
          setTourAnsweredFor(uid);
          if (needed) {
            setTourUserId(uid);
            setShowTour(true);
          } else {
            setShowTour(false);
            setTourUserId(null);
          }
        },
      }),
    []
  );

  // EOD deep link: ?eod=<yyyy-MM-dd> opens the EOD review modal for the day the
  // review's push invited, once the planner has loaded (lib/eod-link.ts, which
  // says why "loaded" is not `!isLoading`). The bare ?eod=1 of older pushes
  // still opens it, naming no day.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    return openReviewFromLink(window.location.search, {
      getState: usePlannerStore.getState,
      subscribe: usePlannerStore.subscribe,
      clearLink: () => window.history.replaceState({}, '', '/'),
    });
  }, []);

  // OpenRouter sign-in's home return: ?connect=<result> says how a sign-in
  // begun in the setup column ended, once the AI gate has answered, and opens
  // the column again (lib/connect-return.ts, which says why it waits). Only
  // this parameter comes off the address bar, at once.
  useEffect(() => {
    if (typeof window === 'undefined' || window.location.pathname !== '/') return;
    return takeConnectReturn(window.location.search, {
      clearLink: () => {
        const url = new URL(window.location.href);
        url.searchParams.delete('connect');
        window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
      },
      // useIsMobile's own test (hooks/use-mobile.ts), read when the gate
      // answers: at mount the hook has not measured yet.
      isPhone: () => window.innerWidth < 768,
    });
  }, []);

  // A question kept from `?` while nothing answered is asked once something
  // does, or left in Ask home's box when the connection is not the one its
  // consent line named (lib/ask-pending.ts, which says why it waits a tick).
  // On `/` only, and the shell's width is read when it asks, as above.
  useEffect(() => {
    if (typeof window === 'undefined' || window.location.pathname !== '/') return;
    return watchKeptQuestion({ isPhone: () => window.innerWidth < 768 });
  }, []);

  // There is deliberately NO in-app EOD auto-trigger here. There used to be
  // one (open the review on load once the review time had passed), and it made
  // every refresh after that time re-open the modal until "Done for today" was
  // pressed — Esc/✕ don't count as reviewed. The review is reached on purpose
  // instead: the rituals.eod palette command, or the nightly push notification
  // (the reminder scan's EOD tier, lib/reminders/scan.ts, gated on the same
  // eod_review_enabled/eod_review_time settings) whose tap lands on the
  // ?eod=<day> deep link above.

  const sensors = useShellSensors();

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    useDragStore.getState().endDrag();
    if (!over) return;

    // Event-time snapshot — the drop resolves against whatever the store holds
    // at release, and reading it here is what lets AppShell go without a
    // planner subscription at all.
    const planner = usePlannerStore.getState();
    const { tasks, habits, selectedDate, userTimezone } = planner;

    const itemId = active.id as string;
    const draggedTask = tasks.find((t) => t.id === itemId);
    const draggedHabit = habits.find((h) => h.id === itemId);

    // One timezone-correct day string, shared by resolveDrop and the group
    // branch below — the user's saved tz, matching how days are derived.
    const userTz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

    const command = resolveDrop(itemId, over.id as string, {
      itemType: draggedTask ? 'task' : draggedHabit ? 'habit' : null,
      // Re-derived from the same activator event the store was seeded with, not
      // read back from the store: one source, so the gate that mounted the
      // targets and the gate that resolves the drop cannot disagree.
      input: dragInputOf(event.activatorEvent),
      draggedTaskProject: draggedTask?.project,
      draggedPlacement: placementOf(draggedTask ?? draggedHabit ?? {}),
      selectedDate,
      userTimezone: userTz,
      getRefTime: (refType, refId) =>
        refType === 'task'
          ? tasks.find((t) => t.id === refId)?.startTime
          : habits.find((h) => h.id === refId)?.startTime,
      inferDropTime,
    });

    // Group drag: when the dragged row is part of a multi-selection (>=2), the
    // whole selection moves. Routed by drop target; each verb is one undo.
    // Timed drops degrade to the target's bucket (untimed) — N items can't share
    // one clock time. Only task-likes are date-addressable/braindump-eligible,
    // so the bulk verbs quietly skip habits where that applies.
    const selection = useSelectionStore.getState();
    if (selection.selectedIds.has(itemId) && selection.selectedIds.size >= 2) {
      const overId = over.id as string;
      const groupIds = [...selection.selectedIds];
      // Task-likes are the only date-addressable / braindump-eligible members;
      // unschedule and date-move no-op on habits, so gate `acted` on this so a
      // fully-ineligible group falls through instead of silently clearing.
      const taskLikeIds = groupIds.filter((id) => tasks.some((t) => t.id === id));
      // DELIBERATELY NOT GATED on the Goals extension, unlike every other
      // goal read in the app. This set is what stops a bulk date verb from
      // overwriting a milestone's target date, and that write is not
      // recoverable by switching the extension back on — the date it replaced
      // is gone. A gate here would make "off" destructive, which is the one
      // thing off must never be. See lib/extension-gates.ts.
      const milestoneIds = milestoneItemIds(planner.goals);
      // What the primary drop resolved to: a bucket always, and — for a TIMED
      // slot (an hour cell) — a clock time. A timed target schedules the whole
      // group AT that time so they land as visible blocks; an untimed target
      // (bare bucket / Anytime / week column) assigns the bucket untimed.
      const targetBucket = command && 'bucket' in command ? command.bucket : undefined;
      const targetTime = command && 'time' in command ? command.time : undefined;
      const selectedDayStr = toDateStr(selectedDate, userTz);
      let acted = false;
      if (overId === 'sidebar') {
        // `acted` gates the selection clear and the drop animation, so it has
        // to mean "something was written". unscheduleTasks refuses milestones
        // (their startDate is a goal's target date), so an all-milestone
        // selection dragged here would have cleared the selection and animated
        // a success over zero writes.
        //
        // Habits on the canvas pause instead (see sidebarDropPlan). A mixed
        // selection is one history entry, so one Undo takes back both halves.
        const plan = sidebarDropPlan(
          groupIds,
          tasks,
          habits,
          milestoneIds,
          toDateStr(new Date(), userTz),
          userTz
        );
        const writable = taskLikeIds.filter((id) => !milestoneIds.has(id));
        const pauseAll = () => plan.pause.forEach((id) => planner.setItemPaused(id, true));
        if (writable.length && plan.pause.length) {
          const n = writable.length + plan.pause.length;
          batchHistory(`Set aside: ${n} items`, n, () => {
            planner.unscheduleTasks(groupIds);
            pauseAll();
          });
          acted = true;
        } else if (writable.length) {
          planner.unscheduleTasks(groupIds);
          acted = true;
        } else if (plan.pause.length > 1) {
          batchHistory(`Pause habit: ${plan.pause.length} items`, plan.pause.length, pauseAll);
          acted = true;
        } else if (plan.pause.length) {
          pauseAll();
          acted = true;
        }
      } else if (overId.startsWith('projectblock:')) {
        const proj = parseProjectBlockId(overId)?.projectName;
        const ids = proj ? groupIds.filter((id) => tasks.find((t) => t.id === id)?.project === proj) : [];
        if (ids.length) {
          planner.moveTasksToProjectBlock(ids);
          acted = true;
        }
      } else if (overId.startsWith('list:')) {
        // A list day: carry to that date, each keeping its own bucket (the
        // bulk verb's rule; it clears clock times, see moveTasksToDate). Only
        // the ones not already on that day move, so a selection dragged within
        // its own day keeps its times; see listGroupMovers for who else stays.
        const dateStr = overId.slice('list:'.length);
        const ids = listGroupMovers(groupIds, dateStr, tasks, milestoneIds);
        if (ids.length) {
          planner.moveTasksToDate(ids, dateStr);
          acted = true;
        }
      } else if (overId.startsWith('week:') || overId.startsWith('weekhour:')) {
        const dateStr = overId.split(':')[1];
        if (dateStr && targetBucket && targetTime) {
          // Timed week cell (weekhour): schedule the group AT that time on that
          // day so they show as blocks.
          planner.scheduleItemsAt(groupIds, targetBucket, targetTime, dateStr);
          acted = true;
        } else if (dateStr && targetBucket && taskLikeIds.length) {
          // Untimed week column: carry to the date + bucket (habits excluded).
          planner.moveTasksToDate(groupIds, dateStr, targetBucket);
          acted = true;
        }
      } else if (targetBucket && targetTime) {
        // Day-grid hour slot: schedule AT that time on the viewed day, so a
        // multi-drop shows up where it was dropped (not untimed in Anytime).
        planner.scheduleItemsAt(groupIds, targetBucket, targetTime, selectedDayStr);
        acted = true;
      } else if (targetBucket) {
        planner.assignItemsToBucket(groupIds, targetBucket);
        acted = true;
      }
      if (acted) {
        // Same reason as the single-item path below: a group that lands in a
        // shut bucket has to be visible where it landed. This branch returns
        // early, so it needs its own call.
        if (targetBucket) useViewStore.getState().expandBucket(targetBucket);
        selection.clear();
        return;
      }
      // Target wasn't actionable for a group — fall through to single-item.
    }

    if (!command) return;

    // A shut bucket still takes drops (see bucket-card's collapse note), so it
    // has to open to show what just landed — otherwise the count ticks up
    // on a shut bucket and the drag reads as having failed. Placed before
    // the switch so it covers every bucket-bearing verb, and it no-ops (same
    // array back) when the bucket was already open.
    if ('bucket' in command) {
      useViewStore.getState().expandBucket(command.bucket);
    }

    switch (command.kind) {
      case 'schedule-task':
        planner.scheduleTask(command.taskId, command.bucket, command.time, command.dateStr);
        break;
      case 'schedule-habit':
        planner.scheduleHabit(command.habitId, command.bucket, command.time);
        break;
      case 'assign-habit-bucket':
        planner.assignHabitToBucket(command.habitId, command.bucket);
        break;
      case 'unschedule':
        planner.unscheduleTask(command.itemId);
        break;
      case 'move-task-to-project-block':
        planner.moveTaskToProjectBlock(command.taskId);
        break;
      case 'move-task-to-date':
        planner.moveTaskToDate(command.taskId, command.dateStr);
        break;
      case 'pause-item':
        // setItemPaused refuses an item that cannot pause or already is.
        planner.setItemPaused(command.itemId, true);
        break;
    }
  };


  // Keyboard shortcut handlers — hovered item comes from the module ref
  // (lib/hovered-item), read at keypress time. Not store state: a store write
  // per row-hover re-rendered the whole shell tree (see lib/hovered-item.ts).
  const handleShortcutEdit = useCallback(() => {
    const { id, type } = hoveredItem;
    if (!id || !type) return;
    const { tasks, habits } = usePlannerStore.getState();
    if (type === 'task') {
      const task = tasks.find((t) => t.id === id);
      if (task) openEditFor(task, 'task');
    } else {
      const habit = habits.find((h) => h.id === id);
      if (habit) openEditFor(habit, 'habit');
    }
  }, []);

  const handleShortcutDelete = useCallback(() => {
    // A genuine multi-selection (>=2) wins over the hovered item: Backspace
    // deletes the whole selection (one confirm, one undo). A single selected row
    // is just the "current / open row" (every plain click selects one), so at
    // size 1 we fall through to the hovered-item path as before.
    const { confirm } = useUIStore.getState();
    const { tasks, habits, deleteTask, deleteHabit } = usePlannerStore.getState();
    const selection = useSelectionStore.getState();
    if (selection.selectedIds.size >= 2) {
      const ids = [...selection.selectedIds];
      const n = ids.length;
      confirm({
        title: `Delete ${n} ${n === 1 ? 'item' : 'items'}?`,
        description:
          'Moves the selected items (and any subtasks) to Trash for 30 days, then deletes them for good.',
        confirmLabel: 'Delete',
        destructive: true,
        onConfirm: () => {
          usePlannerStore.getState().deleteItems(ids);
          selection.clear();
        },
      });
      return;
    }
    const { id, type } = hoveredItem;
    if (!id || !type) return;
    const item =
      type === 'task'
        ? tasks.find((t) => t.id === id)
        : habits.find((h) => h.id === id);
    if (!item) return;
    const config = ITEM_TYPES[type];
    confirm({
      title: `Delete ${config.label}?`,
      description: config.form.deleteDescription(item.title),
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => (type === 'task' ? deleteTask(item.id) : deleteHabit(item.id)),
    });
  }, []);

  // Every other binding is owned by its command in lib/commands/registry.ts.
  // These two stay here because they act on the item under the mouse, which
  // only the shell can resolve.
  useCommandShortcuts(commandContext, {
    edit_hovered: handleShortcutEdit,
    delete_hovered: handleShortcutDelete,
  });

  // Dialog state — memoized so ItemDialog's internal anti-flicker latch sees a
  // stable reference per open (a fresh object per render would loop it).
  const itemDialogState = useMemo<ItemDialogState | null>(() => {
    if (activeDialog?.type === 'add') {
      return {
        mode: 'add',
        type: activeDialog.tab,
        bucket: activeDialog.bucket,
        date: activeDialog.date,
        title: activeDialog.title,
      };
    }
    if (activeDialog?.type === 'edit-item') {
      return { mode: 'edit', item: activeDialog.item };
    }
    return null;
  }, [activeDialog]);

  // Render skeleton during SSR to avoid hydration mismatch from dnd-kit. This
  // is the pre-mount half; PlannerSkeleton (inside ViewRouter and the
  // braindump) is the post-mount half that knows the persisted scope/layout.
  if (!mounted) {
    return (
      <>
        {/* Desktop skeleton. The column is as wide as the braindump will be,
            0 when it is closed (lib/shell-prepaint.ts stamps it before
            paint; --sidebar-w's default if storage could not be read), so
            the canvas's left edge does not jump when the shell mounts. */}
        <div className="hidden h-[100dvh] gap-3 bg-surface-0 p-3 md:flex">
          <div
            className="rounded-panel bg-sidebar"
            style={{ width: `var(${BOOT_SIDEBAR_VAR}, var(--sidebar-w))` }}
          />
          <main className="flex-1 rounded-panel bg-canvas" />
        </div>
        {/* Mobile skeleton — the redesigned silhouette: one header card, content
            straight on the paper backdrop, one dock well. The content band is
            deliberately bare; drawing a panel here flashes a surface the shell
            no longer has. Geometry tracks mobile-header.tsx and
            mobile-bottom-dock.tsx — if either card's inset or radius moves, this
            moves with it or the first paint jumps. */}
        <div className="flex h-[100dvh] flex-col bg-surface-0 pt-safe md:hidden">
          {/* 106px is the real card at rest (106.5, rounded down), added up:
              10 top padding + 32 (the user menu sets the date row's height) + 8
              gap + 46.5 week strip + 8 bottom padding + its two 1px borders; its
              10px top margin is this block's own mt-[10px]. The review notice
              and the Display shelf add to it when they show, which a skeleton
              rendered on the server cannot know, so a first paint with either
              up grows the card downward by that much; the date and its week
              never move. The border is not decoration either — surface-2 on
              surface-0 is ΔL 0.014 in light, four 8-bit levels, so without it
              this block is invisible in one theme and the skeleton shows bare
              paper where the card is about to appear. */}
          <div className="mx-[10px] mt-[10px] h-[106px] flex-shrink-0 rounded-[20px] border border-surface-3 bg-surface-2" />
          <div className="flex-1" />
          <div className="mx-[10px] mb-3 h-[72px] flex-shrink-0 rounded-[10px] bg-surface-3" />
        </div>
      </>
    );
  }

  return (
    <DndContext
      id="planner-dnd"
      sensors={sensors}
      collisionDetection={plannerCollision}
      onDragStart={beginDrag}
      onDragEnd={handleDragEnd}
      // dnd-kit dispatches CANCEL, not end, on Escape / `touchcancel` /
      // `cancelDrop` — so without this the store kept `activeId` (and now
      // `input`) set after an abandoned drag, leaving every drop slot in the
      // canvas open until the next one. Pre-existing: `setActiveId(null)` only
      // ever lived in the end handler. Both fields clear together, here as
      // there, so a cancelled drag can never leave one gesture's input beside
      // another's id.
      onDragCancel={() => useDragStore.getState().endDrag()}
      measuring={SHELL_MEASURING}
    >
      {/* One shell mounts at a time (post-hydration) so the shared view
          components don't register duplicate dnd-kit droppable ids across the
          two trees — and mobile no longer pays for the desktop tree, or v.v.
          Planner and Zen are one slot: ZenStage mounts one of them at rest and
          both only for the second the Relay Lift switch takes. Zen has no
          droppables, so the brief overlap registers no duplicate ids. */}
      {isMobile ? <MobileShell /> : <ZenStage planner={<DesktopShell />} />}

      {/* The cached → fresh settle's React end and the preview's one
          announcement (settle-host.tsx). A sibling of the shell swap, not a
          child of either shell, so a desktop⇄mobile or Zen switch mid-preview
          neither drops the landing edge nor announces it twice. */}
      <SettleHost />

      <DragGhost />

      {/* Add is always the modal. Desktop EDIT is the docked panel, which
          DesktopShell mounts as a layout sibling of the canvas; mobile edit
          stays the bottom sheet, where there is no room to dock anything. */}
      {/* …and EDIT is the modal in Zen too, for the same reason it is on
          mobile: the docked panel belongs to DesktopShell, which Zen replaces.
          Without this arm, editing an item from the ⌘K palette inside Zen would
          fill the dialog slot and render nothing at all. */}
      <ItemDialog
        state={
          itemDialogState?.mode === 'add' || isMobile || (zenOpen && !zenMoving)
            ? itemDialogState
            : null
        }
        onOpenChange={(open) => !open && closeDialog()}
      />

      {/* The same "new" dialog when it is making an organizer rather than an
          item — its own slot and component, the same shell (see
          components/planner/container-dialog.tsx). Mounted beside the add
          modal, and like it on every shell: the palette's New goal / routine /
          season reaches it on mobile and in Zen too. */}
      <ContainerDialog
        state={activeDialog?.type === 'new-container' ? activeDialog : null}
        onOpenChange={(open) => !open && closeDialog()}
      />

      {/* Two unconditional mounts became one. The console is a component rather
          than a route so it keeps the shell's services — the DndContext, the
          undo toast, and ⌘Z, which every delete confirm's copy now explicitly
          promises. */}
      <OrganizeConsole
        open={activeDialog?.type === 'organize'}
        section={activeDialog?.type === 'organize' ? activeDialog.section : undefined}
        focusId={activeDialog?.type === 'organize' ? activeDialog.focusId : undefined}
        focusNew={activeDialog?.type === 'organize' ? activeDialog.focusNew : undefined}
        onOpenChange={(open) => !open && closeDialog()}
      />

      <KeyboardShortcutsModal
        open={activeDialog?.type === 'keyboard-shortcuts'}
        onOpenChange={(open) => !open && closeDialog()}
      />

      <BulkAddDialog
        open={activeDialog?.type === 'bulk-add'}
        seed={activeDialog?.type === 'bulk-add' ? activeDialog : null}
        onOpenChange={(open) => !open && closeDialog()}
      />

      {/* ⌘K launcher — reads its own `launcher` slot off activeDialog. */}
      <OmniLauncher />

      {showTour && tourUserId && (
        <OnboardingTour
          userId={tourUserId}
          onComplete={() => setShowTour(false)}
          // The tour shows Ask for its step and puts it back, never writing
          // `askOpen` (lib/rail-store.ts tourShowAsk, tourHideAsk).
          onExpandChat={tourShowAsk}
          onCollapseChat={tourHideAsk}
          onSetActiveTab={(tab) => useMobileNavStore.getState().setActiveTab(tab as MobileTab)}
        />
      )}

      {/* First-run orientation, each shown once: streaks are on and how to
          quiet them, and the two rituals. Persistent toasts, dismissed forever
          server-side. */}
      <FirstRunNudges tourAnsweredFor={tourAnsweredFor} tourShowing={showTour} />

      <EODReview />

      <BugReportDialog
        open={activeDialog?.type === 'bug-report'}
        onOpenChange={(open) => !open && closeDialog()}
      />

      <ConfirmDialog />

      {/* An AppShell-level sibling rather than a DesktopShell child, so
          without this it floats over the Zen room: the bulk bar appears over it
          whenever a selection made before entering is still held. Unmounting
          the bar also settles Escape: its own window listener would otherwise
          clear the selection on the SAME keypress that leaves the room, so one
          press did two things. The selection itself is left alone, and is
          still there when you come back. (The "?" help bubble is DesktopShell's
          now, inside <main>, so Zen, which replaces that shell, has none.) */}
      {!zenOpen && !zenMoving && <BulkActionBar />}
    </DndContext>
  );
}
