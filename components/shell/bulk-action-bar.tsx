'use client';

import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, CheckCircle2, Circle, Inbox, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { usePlannerStore } from '@/lib/planner-store';
import { milestoneItemIds } from '@/lib/goals';
import { useUIStore } from '@/lib/ui-store';
import { useSelectionStore } from '@/lib/selection-store';
import { getItemTypeConfig, itemTypeName } from '@/lib/item-registry';
import { isRecurring, isCompletedOnDate, toDateStr } from '@/lib/recurrence';
import type { Item } from '@/lib/planner-types';
import { cn } from '@/lib/utils';
import { BulkEditMenu } from './bulk-edit-menu';

/**
 * Floating multi-select toolbar. Mounts once in the shell and shows only while
 * a selection exists. Actions are gated per selection COMPOSITION off the type
 * registry — a mixed task+habit+custom selection is fine, each action just
 * applies to its eligible subset (habits aren't date/braindump eligible; only
 * one-off task-likes carry a date). Every verb it calls does one set() ⇒ one
 * undo, so a single ⌘/Ctrl+Z reverses the whole gesture. Property edits live
 * behind Edit (./bulk-edit-menu.tsx).
 */

function isItemDone(item: Item, dateStr: string): boolean {
  if (item.type === 'habit') return item.completedDates.includes(dateStr);
  if (isRecurring(item)) return isCompletedOnDate(item, dateStr);
  return item.status === getItemTypeConfig(itemTypeName(item)).doneStatus;
}

export function BulkActionBar() {
  const selectedIds = useSelectionStore((s) => s.selectedIds);
  const clear = useSelectionStore((s) => s.clear);
  const prune = useSelectionStore((s) => s.prune);

  const items = usePlannerStore((s) => s.items);
  const goals = usePlannerStore((s) => s.goals);
  const selectedDate = usePlannerStore((s) => s.selectedDate);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const deleteItems = usePlannerStore((s) => s.deleteItems);
  const setItemsCompleted = usePlannerStore((s) => s.setItemsCompleted);
  const moveTasksToDate = usePlannerStore((s) => s.moveTasksToDate);
  const unscheduleTasks = usePlannerStore((s) => s.unscheduleTasks);
  const confirm = useUIStore((s) => s.confirm);

  const [dateOpen, setDateOpen] = useState(false);

  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dateStr = toDateStr(selectedDate, tz);

  // Drop ids whose item was deleted elsewhere (row control, agent, undo), so a
  // bulk action never fans out over ghosts and the count stays honest.
  const liveIds = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  useEffect(() => {
    prune((id) => liveIds.has(id));
  }, [liveIds, prune]);

  // Escape clears the selection. This bar mounts for the whole session (it just
  // renders null below the threshold), so the listener guards hard against
  // stealing Escape from something else:
  //   - defaultPrevented → a Radix layer (its own date popover, Settings dialog,
  //     shortcuts modal, …) already consumed this Escape in the capture phase to
  //     close itself; clearing the selection on the same keypress would wipe it
  //     out from under an unrelated dismiss.
  //   - an open confirm dialog owns Escape (cancelling a delete must not also
  //     clear what was about to be deleted).
  //   - a focused text field owns its own Escape (omnibar, inputs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (useUIStore.getState().confirmRequest) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return;
      clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clear]);

  const selected = useMemo(
    () => items.filter((i) => selectedIds.has(i.id)),
    [items, selectedIds]
  );
  const count = selected.length;

  // Movable = one-off (a recurring startDate is the recurrence anchor, not a
  // due date) task-likes whose type is date-addressable. Braindumpable = types
  // that can return to the sidebar. Both computed off the registry.
  //
  // Milestones are excluded from BOTH, because the store's bulk verbs now
  // refuse them — a milestone's startDate is a goal's target date, not a
  // scheduling intention. Counted here they would inflate the bar's own
  // honesty affordance ("Move to date · 2") with items it is about to fail to
  // move, and the sidebar drop would animate a success that wrote nothing.
  const milestones = useMemo(() => milestoneItemIds(goals), [goals]);
  const movable = useMemo(
    () =>
      selected.filter(
        (i) =>
          getItemTypeConfig(itemTypeName(i)).dateAddressable &&
          !isRecurring(i) &&
          !milestones.has(i.id)
      ),
    [selected, milestones]
  );
  const braindumpable = useMemo(
    () =>
      selected.filter(
        (i) => getItemTypeConfig(itemTypeName(i)).braindumpEligible && !milestones.has(i.id)
      ),
    [selected, milestones]
  );
  const allDone = count > 0 && selected.every((i) => isItemDone(i, dateStr));

  // Only a genuine MULTI-selection (>=2) raises the bar. A plain click selects
  // exactly one row (and opens it in the edit pane, which is the single-item
  // action surface), so a >=1 threshold would pop the bar on every normal click.
  if (count < 2) return null;

  const ids = selected.map((i) => i.id);

  const handleDelete = () => {
    confirm({
      title: `Delete ${count} ${count === 1 ? 'item' : 'items'}?`,
      description:
        'This will permanently delete the selected items (and any subtasks). This action cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => {
        deleteItems(ids);
        clear();
      },
    });
  };

  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      data-testid="bulk-action-bar"
      className={cn(
        'fixed bottom-20 left-1/2 z-40 -translate-x-1/2 md:bottom-6',
        'flex items-center gap-1 rounded-full border border-border bg-card p-1 pl-3 shadow-soft-lg',
        // A phone is narrower than the full row of actions: cap the pill to the
        // viewport's 16px gutters and let it scroll sideways instead of being
        // clipped at both ends by the centring translate.
        'max-w-[calc(100vw-32px)] overflow-x-auto scrollbar-hide [&>*]:shrink-0'
      )}
    >
      <span className="mr-1 whitespace-nowrap text-sm font-medium text-foreground" data-testid="bulk-count">
        {count} selected
      </span>

      <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />

      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 rounded-full px-2.5 text-xs"
        data-testid="bulk-complete"
        onClick={() => setItemsCompleted(ids, !allDone, selectedDate)}
      >
        {allDone ? <Circle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
        {allDone ? 'Mark incomplete' : 'Complete'}
      </Button>

      <Popover open={dateOpen} onOpenChange={setDateOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 rounded-full px-2.5 text-xs"
            data-testid="bulk-move"
            disabled={movable.length === 0}
          >
            <CalendarDays className="h-3.5 w-3.5" />
            Move to date
            {movable.length < count && <span className="text-muted-foreground">· {movable.length}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="center" className="w-auto p-0">
          <Calendar
            mode="single"
            selected={selectedDate}
            onSelect={(date) => {
              if (!date) return;
              moveTasksToDate(
                movable.map((i) => i.id),
                toDateStr(date, tz)
              );
              setDateOpen(false);
              clear();
            }}
            initialFocus
          />
        </PopoverContent>
      </Popover>

      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 rounded-full px-2.5 text-xs"
        data-testid="bulk-unschedule"
        disabled={braindumpable.length === 0}
        onClick={() => {
          unscheduleTasks(braindumpable.map((i) => i.id));
          clear();
        }}
      >
        <Inbox className="h-3.5 w-3.5" />
        Braindump
        {braindumpable.length < count && (
          <span className="text-muted-foreground">· {braindumpable.length}</span>
        )}
      </Button>

      {/* Properties — priority, reminder, and every container role — in one
          drill-in menu. It hides itself when nothing selected can take any. */}
      <BulkEditMenu selected={selected} />

      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground hover:text-destructive"
        data-testid="bulk-delete"
        onClick={handleDelete}
      >
        <Trash2 className="h-3.5 w-3.5" />
        Delete
      </Button>

      <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />

      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 rounded-full text-muted-foreground"
        aria-label="Clear selection"
        data-testid="bulk-clear"
        onClick={clear}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
