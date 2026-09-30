'use client';

import { useDroppable } from '@dnd-kit/core';
import { useDragStore } from '@/lib/drag-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useSelectionStore } from '@/lib/selection-store';
import { listDropCommand, listGroupMovers, placementOf } from '@/lib/dnd/handle-drag-end';
import { milestoneItemIds } from '@/lib/goals';
import { cn } from '@/lib/utils';

/**
 * Would a drop of the active drag on `list:{dateStr}` write anything?
 *
 * Asked only while the pointer is over the target, so the store reads happen at
 * enter and leave and never per pointer move. A multi-selection follows the
 * group branch in app-shell.tsx's handleDragEnd.
 */
function dropActs(activeId: string, dateStr: string): boolean {
  const { tasks, habits, goals } = usePlannerStore.getState();
  const { selectedIds } = useSelectionStore.getState();
  if (selectedIds.has(activeId) && selectedIds.size >= 2) {
    // An unactionable group falls through to the dragged row alone, as the
    // shell's drop does.
    if (listGroupMovers(selectedIds, dateStr, tasks, milestoneItemIds(goals)).length) return true;
  }
  const task = tasks.find((t) => t.id === activeId);
  const habit = task ? undefined : habits.find((h) => h.id === activeId);
  const item = task ?? habit;
  if (!item) return false;
  return listDropCommand(activeId, task ? 'task' : 'habit', placementOf(item), dateStr) !== null;
}

/**
 * The `list:{yyyy-MM-dd}` droppable: Day × List's whole body, or one day of
 * Week × List. See `listDropCommand` for what a drop here does.
 *
 * Its own component so a hover re-renders this wrapper and nothing under it:
 * `children` arrive as elements the parent already built, so React keeps them
 * as they are when only this component's state changes.
 *
 * It lights only when the drop would act. A list row is a drag source sitting
 * inside its own day, and a target that lit under every drag would claim a
 * drop it is about to ignore.
 */
export function ListDropZone({
  dateStr,
  className,
  children,
  as: Tag = 'div',
}: {
  dateStr: string;
  className?: string;
  children: React.ReactNode;
  as?: 'div' | 'section';
}) {
  const id = `list:${dateStr}`;
  const { isOver, setNodeRef } = useDroppable({ id });
  const activeId = useDragStore((s) => s.activeId);
  const lit = isOver && !!activeId && dropActs(activeId, dateStr);

  return (
    <Tag
      ref={setNodeRef}
      data-dnd-id={id}
      data-dnd-over={isOver ? 'true' : 'false'}
      data-dnd-acts={lit ? 'true' : 'false'}
      className={cn(
        'rounded-card transition-colors',
        lit && 'bg-primary/5 ring-2 ring-ring/50',
        className
      )}
    >
      {children}
    </Tag>
  );
}
