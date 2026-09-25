'use client';

import { Clock, Sunrise, Sun, Sunset, ArrowLeftToLine, Redo2, SkipForward, Trash2, Undo2, ListChecks, Pause, Play } from 'lucide-react';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerFooter,
  DrawerClose,
} from '@/components/ui/drawer';
import { Button } from '@/components/ui/button';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { useScheduleSheet } from '@/lib/schedule-sheet-store';
import { useSelectionStore } from '@/lib/selection-store';
import { getItemTypeConfig, isPausable } from '@/lib/item-registry';
import { BUCKET_ORDER } from '@/lib/day-items';
import { isRecurring, isSkippedOnDate, toDateStr } from '@/lib/recurrence';
import { isPausedOn, suppressionReason, suppressionLabel } from '@/lib/active';
import { milestoneItemIds } from '@/lib/goals';
import { canMoveToNextDay, canSendToBraindump, nextDayLabel, nextDayTarget } from '@/lib/row-moves';
import type { TimeBucket, Task } from '@/lib/planner-types';

const BUCKET_META: Record<TimeBucket, { label: string; icon: typeof Clock }> = {
  anytime: { label: 'Anytime', icon: Clock },
  morning: { label: 'Morning', icon: Sunrise },
  afternoon: { label: 'Afternoon', icon: Sun },
  evening: { label: 'Evening', icon: Sunset },
};

/**
 * Mobile tap-to-schedule sheet. A row's ellipsis opens it; picking a bucket
 * schedules the item for the currently selected day (tasks) or assigns its
 * bucket (habits) — the same store commands a drop emits, so undo works. Also
 * offers skip/unskip (recurring items of a skippable type), unschedule
 * (scheduled tasks) and delete.
 */
export function ScheduleSheet() {
  const row = useScheduleSheet((s) => s.row);
  const close = useScheduleSheet((s) => s.close);
  const rowDateStr = useScheduleSheet((s) => s.dateStr);
  const {
    scheduleTask,
    assignHabitToBucket,
    unscheduleTask,
    moveTaskToDate,
    setItemSkipped,
    setItemPaused,
    deleteTask,
    deleteHabit,
    selectedDate,
    userTimezone,
    items,
    routines,
    programs,
    goals,
  } = usePlannerStore();
  const confirm = useUIStore((s) => s.confirm);
  // Mobile multi-select entry: no long-press (that gesture belongs to dnd-kit's
  // TouchSensor drag), so selection is toggled here from the action sheet. Two+
  // selected raises the same bulk bar as desktop.
  const isMultiSelected = useSelectionStore((s) => (row ? s.selectedIds.has(row.item.id) : false));

  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const task = row?.itemType === 'task' ? (row.item as Task) : null;
  const taskScheduled = !!task && (task.isScheduled || !!task.timeBucket);

  // Skip/unskip lives here because touch has no hover: the row's control
  // cluster is desktop-only, so without this the capability simply does not
  // exist on mobile (#195). Same registry gate the row uses.
  const dateStr = toDateStr(selectedDate, tz);
  const projected = row?.item as { type?: string; customType?: string } | undefined;
  const typeName = projected?.type === 'custom' ? projected.customType! : row?.itemType;
  const canSkip =
    !!row && !!typeName && getItemTypeConfig(typeName).skippable && isRecurring(row.item);
  const isSkipped = canSkip && isSkippedOnDate(row.item, dateStr);

  // Pause, same parity reasoning as skip above. Two deliberate differences:
  //
  // The live item is re-resolved from the store rather than read off `row`,
  // which is a snapshot taken when the sheet opened and never refreshed. Every
  // other row here closes the sheet immediately so nobody notices; pause state
  // has to be right the moment it is read.
  //
  // And it resolves at TODAY, not `dateStr`. That variable is the navigated
  // day, which is correct for a per-occurrence skip and wrong for a pause —
  // Resume would disappear whenever the user walked to a day outside the pause
  // interval, and the sheet also opens from braindump rows, which have no date
  // at all.
  const liveItem = row ? items.find((i) => i.id === row.item.id) : undefined;
  const todayStr = toDateStr(new Date(), tz);
  const canPause = !!liveItem && isPausable(liveItem);
  const isPaused = !!liveItem && isPausedOn(liveItem, todayStr, tz);
  // The button above stays ITEM-level on purpose — it is what Pause/Resume can
  // actually act on, and offering Resume for a container-caused hide would be a
  // genuine no-op. But the sheet is the only place a paused row is reachable on
  // touch, so when the cause is a container it has to SAY so: otherwise the
  // user taps Resume, the row stays hidden, and nothing anywhere explains it.
  const reason = liveItem
    ? suppressionReason(liveItem, todayStr, { userTimezone: tz, routines, programs })
    : null;
  const containerReason = reason && reason.kind !== 'paused' ? reason : null;

  // Put-it-off verbs, gated exactly as the desktop row's (lib/row-moves.ts),
  // off the live item. The next day is only offered for a dated row: a
  // braindump row opens with no date, and has no day to put off.
  // Asked at the row's own day (a week column's, not the selected one) — the
  // same date the desktop row carries from.
  const moveDateStr = rowDateStr ?? dateStr;
  const nextDay = nextDayTarget(moveDateStr, todayStr);
  const canNextDay =
    !!rowDateStr && !!liveItem && !!row && canMoveToNextDay(liveItem, row.itemType, moveDateStr);
  const canBraindump =
    taskScheduled &&
    !!liveItem &&
    !!row &&
    canSendToBraindump(liveItem, row.itemType, moveDateStr, milestoneItemIds(goals ?? []));

  const schedule = (bucket: TimeBucket) => {
    if (!row) return;
    if (row.itemType === 'task') scheduleTask(row.item.id, bucket, undefined, toDateStr(selectedDate, tz));
    else assignHabitToBucket(row.item.id, bucket);
    close();
  };

  const onDelete = () => {
    if (!row) return;
    const { id, title } = row.item;
    const isTask = row.itemType === 'task';
    close();
    confirm({
      title: `Delete ${isTask ? 'Task' : 'Habit'}?`,
      description: `This will permanently delete "${title}".`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => (isTask ? deleteTask(id) : deleteHabit(id)),
    });
  };

  return (
    <Drawer open={!!row} onOpenChange={(o) => !o && close()}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="truncate text-left">{row?.item.title}</DrawerTitle>
        </DrawerHeader>

        <div className="grid grid-cols-2 gap-2 px-4">
          {BUCKET_ORDER.map((b) => {
            const { label, icon: Icon } = BUCKET_META[b];
            return (
              <Button
                key={b}
                variant="outline"
                className="h-16 flex-col gap-1.5"
                onClick={() => schedule(b)}
              >
                <Icon className="h-5 w-5 text-muted-foreground" />
                <span className="text-sm font-medium">{label}</span>
              </Button>
            );
          })}
        </div>

        <DrawerFooter>
          <Button
            variant="ghost"
            className="justify-start"
            onClick={() => {
              if (row) useSelectionStore.getState().toggle(row.item.id);
              close();
            }}
          >
            <ListChecks className="mr-2 h-4 w-4" /> {isMultiSelected ? 'Deselect' : 'Select'}
          </Button>
          {canSkip && (
            <Button
              variant="ghost"
              className="justify-start"
              data-testid={isSkipped ? 'sheet-unskip-button' : 'sheet-skip-button'}
              onClick={() => {
                if (row) setItemSkipped(row.item.id, !isSkipped, selectedDate);
                close();
              }}
            >
              {isSkipped ? (
                <>
                  <Undo2 className="mr-2 h-4 w-4" /> Unskip today
                </>
              ) : (
                <>
                  <SkipForward className="mr-2 h-4 w-4" /> Skip today
                </>
              )}
            </Button>
          )}
          {canPause && (
            <Button
              variant="ghost"
              className="justify-start"
              data-testid={isPaused ? 'sheet-resume-button' : 'sheet-pause-button'}
              onClick={() => {
                if (row) setItemPaused(row.item.id, !isPaused);
                close();
              }}
            >
              {isPaused ? (
                <>
                  <Play className="mr-2 h-4 w-4" /> Resume
                </>
              ) : (
                <>
                  <Pause className="mr-2 h-4 w-4" /> Pause
                </>
              )}
            </Button>
          )}
          {containerReason && (
            <p
              className="text-muted-foreground px-3 py-1 text-xs"
              data-testid="sheet-suppression-note"
            >
              {suppressionLabel(containerReason, { long: true })}
            </p>
          )}
          {canNextDay && (
            <Button
              variant="ghost"
              className="justify-start"
              data-testid="sheet-tomorrow-button"
              onClick={() => {
                if (row) moveTaskToDate(row.item.id, nextDay);
                close();
              }}
            >
              <Redo2 className="mr-2 h-4 w-4" /> {nextDayLabel(nextDay, todayStr)}
            </Button>
          )}
          {canBraindump && (
            <Button
              variant="ghost"
              className="justify-start"
              onClick={() => {
                if (row) unscheduleTask(row.item.id);
                close();
              }}
            >
              <ArrowLeftToLine className="mr-2 h-4 w-4" /> Move to Braindump
            </Button>
          )}
          <Button variant="ghost" className="justify-start text-destructive hover:text-destructive" onClick={onDelete}>
            <Trash2 className="mr-2 h-4 w-4" /> Delete
          </Button>
          <DrawerClose asChild>
            <Button variant="outline">Cancel</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
