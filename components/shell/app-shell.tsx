'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  DndContext,
  closestCenter,
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
import {
  dragInputOf,
  NonTouchPointerSensor,
  POINTER_ACTIVATION_DISTANCE_PX,
  TOUCH_ACTIVATION_DELAY_MS,
  TOUCH_ACTIVATION_TOLERANCE_PX,
} from '@/lib/dnd/sensors';
import { ItemDialog, type ItemDialogState } from '@/components/planner/item-dialog';
import { BulkAddDialog } from '@/components/planner/bulk-add-dialog';
import { OrganizeConsole } from '@/components/planner/organize/organize-console';
import { KeyboardShortcutsModal } from '@/components/planner/keyboard-shortcuts-modal';
import { EODReview } from '@/components/ai/eod-review';
import { MobileShell } from '@/components/shell/mobile-shell';
import { ZenRoom } from '@/components/zen/zen-room';
import { OnboardingTour } from '@/components/onboarding/onboarding-tour';
import { BugReportDialog } from '@/components/bug-report/bug-report-dialog';
import { OneTimeNudge } from '@/components/primitives/one-time-nudge';
import { HelpMenu } from '@/components/shell/help-menu';

import { usePlannerStore } from '@/lib/planner-store';
import { milestoneItemIds } from '@/lib/goals';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { useEODStore } from '@/lib/eod-store';
import { useChatStore } from '@/lib/chat-store';
import { flushSettings } from '@/lib/settings-service';
import { useUIStore, openEditFor } from '@/lib/ui-store';
import { ITEM_TYPES } from '@/lib/item-registry';
import { useStreaksEnabled } from '@/lib/extension-gates';
import { useExtensionsStore } from '@/lib/extensions-store';
import { NUDGE_STREAKS_ON } from '@/lib/nudges/registry';
import { adoptLegacyViewPrefs, useViewStore } from '@/lib/view-store';
import { useDragStore } from '@/lib/drag-store';
import { useSelectionStore } from '@/lib/selection-store';
import { hoveredItem } from '@/lib/hovered-item';
import { resolveDrop } from '@/lib/dnd/handle-drag-end';
import { toDateStr } from '@/lib/recurrence';
import { useCommandShortcuts } from '@/hooks/use-command-shortcuts';
import { useCommandContext } from '@/hooks/use-command-context';
import { useUndoToast } from '@/hooks/use-undo-toast';
import { useTimezoneSync } from '@/hooks/use-timezone-sync';
import { useOverdueSweep } from '@/hooks/use-overdue-sweep';
import { useIsMobile } from '@/hooks/use-mobile';
import { isOnboardingComplete } from '@/lib/user-profile';
import { createClient } from '@/lib/supabase';
import type { MobileTab } from '@/lib/mobile-nav-store';

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
    useSensor(NonTouchPointerSensor, {
      activationConstraint: { distance: POINTER_ACTIVATION_DISTANCE_PX },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: TOUCH_ACTIVATION_DELAY_MS,
        tolerance: TOUCH_ACTIVATION_TOLERANCE_PX,
      },
    })
  );
}

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
  const setChatExpanded = useSidebarStore((s) => s.setChatExpanded);
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
  // Opt-in past-due decay (off by default). Mounted here, above the
  // desktop/mobile split, so the once-per-day sweep runs on every platform and
  // survives view changes — and declared AFTER useUndoToast so the batched
  // unschedule it fires is picked up by the already-mounted toast subscriber.
  useOverdueSweep();

  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [tourUserId, setTourUserId] = useState<string | null>(null);
  // The streak nudge fires only when streaks are provably ON: `configsLoaded`
  // means the extensions store has answered, so we never nudge "turn streaks
  // off" at someone who already did (streaksOn reads its default-true before
  // hydration), and never at all when the extensions table is undeployed
  // (configsLoaded stays false — the toggle would be a no-op there anyway).
  const streaksOn = useStreaksEnabled();
  const extReady = useExtensionsStore((s) => s.configsLoaded);

  useEffect(() => {
    setMounted(true);
    adoptLegacyViewPrefs();
    // Hydrate the chat transcript here rather than waiting for
    // ChatConversation to mount. A command ("Plan my day") can send a message
    // before the panel has ever been opened, and send() persists the message
    // list it appends to — over an empty one, that wipes the saved history.
    useChatStore.getState().hydrate();
  }, []);

  // Settings writes are debounced 500ms; closing the tab inside that window
  // would otherwise drop the patch. pagehide (not beforeunload) is the event
  // that actually fires on mobile Safari.
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
  useEffect(() => {
    document.documentElement.dataset.typeMode = typeMode;
  }, [typeMode]);

  // Check onboarding status on mount
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data }) => {
      const uid = data.user?.id;
      if (!uid) return;
      const done = await isOnboardingComplete(uid);
      if (!done) {
        setTourUserId(uid);
        setShowTour(true);
        // Published for the chat surfaces too: Beacon's own first-run Q&A
        // renders off the same answer, and on a phone its field competes with
        // the dock's. Seeding it here — the earliest place the answer exists —
        // means the dock is already standing down by the time the tour's
        // step 4 switches to the Beacon tab.
        useUIStore.getState().setChatOnboardingActive(true);
      }
    });
  }, []);

  // EOD deep link: ?eod=1 opens the EOD review modal (e.g. tapped from a push notification)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('eod') !== '1') return;

    const openAndClear = () => {
      useEODStore.getState().open();
      window.history.replaceState({}, '', '/');
    };

    // `!isLoading` alone is NOT "loaded" — the store initialises with
    // isLoading:false, and this effect runs before the load even starts:
    // initializeStore is called from SupabaseProvider, a PARENT, and React runs
    // child effects first. So the fast path used to fire against an EMPTY store,
    // and EODReview snapshots its pending list once on the isOpen transition and
    // never re-snapshots — leaving a permanently empty review for anyone who
    // arrived by tapping the push notification. `userId` is set in the same
    // set() as isLoading:true, so it is the signal that a load has begun.
    const isLoaded = (s: { userId: string | null; isLoading: boolean }) =>
      !!s.userId && !s.isLoading;

    if (isLoaded(usePlannerStore.getState())) {
      openAndClear();
    } else {
      const unsub = usePlannerStore.subscribe((state) => {
        if (isLoaded(state)) {
          openAndClear();
          unsub();
        }
      });
      return unsub;
    }
  }, []);

  // There is deliberately NO in-app EOD auto-trigger here. There used to be
  // one (open the review on load once the review time had passed), and it made
  // every refresh after that time re-open the modal until "Done for today" was
  // pressed — Esc/✕ don't count as reviewed. The review is reached on purpose
  // instead: the rituals.eod palette command, or the nightly push notification
  // (cron/eod-notify, gated on the same eod_review_enabled/eod_review_time
  // settings) whose tap lands on the ?eod=1 deep link above.

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
        const writable = taskLikeIds.filter((id) => !milestoneIds.has(id));
        if (writable.length) {
          planner.unscheduleTasks(groupIds);
          acted = true;
        }
      } else if (overId.startsWith('projectblock:')) {
        const proj = overId.slice('projectblock:'.length);
        const ids = groupIds.filter((id) => tasks.find((t) => t.id === id)?.project === proj);
        if (ids.length) {
          planner.moveTasksToProjectBlock(ids);
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
          'This will permanently delete the selected items (and any subtasks). This action cannot be undone.',
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

  // Render skeleton during SSR to avoid hydration mismatch from dnd-kit
  if (!mounted) {
    return (
      <>
        {/* Desktop skeleton */}
        <div className="hidden h-[100dvh] gap-3 bg-surface-0 p-3 md:flex">
          <div className="w-80 rounded-panel bg-sidebar" />
          <main className="flex-1 rounded-panel bg-canvas" />
        </div>
        {/* Mobile skeleton — the redesigned silhouette: one header card, content
            straight on the paper backdrop, one dock well. The content band is
            deliberately bare; drawing a panel here flashes a surface the shell
            no longer has. Geometry tracks mobile-header.tsx and
            mobile-bottom-dock.tsx — if either card's inset or radius moves, this
            moves with it or the first paint jumps. */}
        <div className="flex h-[100dvh] flex-col bg-surface-0 pt-safe md:hidden">
          {/* 106px is the real card, added up: 10 top margin + 32 (the user
              menu sets the date row's height) + 8 gap + 46.5 week strip + 8
              bottom padding + its two 1px borders. The border is not decoration
              either — surface-2 on surface-0 is ΔL 0.014 in light, four 8-bit
              levels, so without it this block is invisible in one theme and the
              skeleton shows bare paper where the card is about to appear. */}
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
      collisionDetection={closestCenter}
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
      measuring={{
        droppable: {
          strategy: MeasuringStrategy.Always,
        },
      }}
    >
      {/* One shell mounts at a time (post-hydration) so the shared view
          components don't register duplicate dnd-kit droppable ids across the
          two trees — and mobile no longer pays for the desktop tree, or v.v. */}
      {isMobile ? <MobileShell /> : zenOpen ? <ZenRoom /> : <DesktopShell />}

      <DragGhost />

      {/* Add is always the modal. Desktop EDIT is the docked panel, which
          DesktopShell mounts as a layout sibling of the canvas; mobile edit
          stays the bottom sheet, where there is no room to dock anything. */}
      {/* …and EDIT is the modal in Zen too, for the same reason it is on
          mobile: the docked panel belongs to DesktopShell, which Zen replaces.
          Without this arm, editing an item from the ⌘K palette inside Zen would
          fill the dialog slot and render nothing at all. */}
      <ItemDialog
        state={itemDialogState?.mode === 'add' || isMobile || zenOpen ? itemDialogState : null}
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
          // The tour calls handleComplete() before this fires, so navigating
          // away doesn't abandon it. Beacon is the pane the step is about.
          onOpenSettings={() => router.push('/settings/beacon')}
          onExpandChat={() => setChatExpanded(true)}
          onCollapseChat={() => setChatExpanded(false)}
          onSetActiveTab={(tab) => useMobileNavStore.getState().setActiveTab(tab as MobileTab)}
        />
      )}

      {/* First-run orientation, shown once: streaks are on, and how to quiet
          them. Persistent toast, dismissed forever server-side. */}
      <OneTimeNudge id={NUDGE_STREAKS_ON} enabled={extReady && streaksOn} />

      <EODReview />

      <BugReportDialog
        open={activeDialog?.type === 'bug-report'}
        onOpenChange={(open) => !open && closeDialog()}
      />

      <ConfirmDialog />

      {/* Both are AppShell-level siblings rather than DesktopShell children, so
          without this they float over the Zen room — the help bubble is pinned
          bottom-right on exactly the platform Zen runs on, and the bulk bar
          appears over it whenever a selection made before entering is still
          held. Unmounting the bar also settles Escape: its own window listener
          would otherwise clear the selection on the SAME keypress that leaves
          the room, so one press did two things. The selection itself is left
          alone, and is still there when you come back. */}
      {!zenOpen && <BulkActionBar />}

      {/* Floating "?" help hub — desktop only, bottom-right corner */}
      {!zenOpen && <HelpMenu />}
    </DndContext>
  );
}
