'use client';

import { type MouseEvent as ReactMouseEvent } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { ItemContextMenu } from '@/components/planner/item-context-menu';
import { ContainerContextMenu } from '@/components/planner/container-context-menu';
import { Check, GripVertical, ChevronsRight, ArrowRight, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePlannerStore } from '@/lib/planner-store';
import { useSelectionStore, rangeIds } from '@/lib/selection-store';
import { isRecurring, isCompletedOnDate, toDateStr } from '@/lib/recurrence';
import type { Task, Project } from '@/lib/planner-types';
import { CategoryIcon } from '@/lib/category-icons';
import { WEEK_PROJECT_BLOCK_MAX_H } from '@/lib/schedule-constants';
import { cn } from '@/lib/utils';

/**
 * Recurring project time block (ported from timeline.tsx in P5b, compact
 * mode retired). Droppable id stays `projectblock:{name}` per
 * lib/dnd/CONTRACT.md — only tasks of the same project may drop in.
 */

function BlockTask({ task, onClick, date }: { task: Task; onClick: () => void; date?: Date }) {
  const { toggleTaskStatus, selectedDate, userTimezone } = usePlannerStore();
  const timezone = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Same rule as TaskRow's `date` prop: a block rendered inside a week column
  // belongs to THAT column's day, not the globally selected one. Without it a
  // check in Friday's column would read (and write) Tuesday's completion.
  const blockDate = date ?? selectedDate;
  const dateStr = toDateStr(blockDate, timezone);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  const recurring = isRecurring(task);
  const done = recurring ? isCompletedOnDate(task, dateStr) : task.status === 'completed';

  // Multi-select: a plain click selects this row (replacing the selection) and
  // opens it; Cmd/Ctrl adds/removes without opening; Shift extends a range.
  // Selected shows as a persistent highlight, same as the list rows.
  const isMultiSelected = useSelectionStore((s) => s.selectedIds.has(task.id));
  const handleClick = (e: ReactMouseEvent) => {
    const selection = useSelectionStore.getState();
    if (e.metaKey || e.ctrlKey) {
      selection.toggle(task.id);
      return;
    }
    if (e.shiftKey) {
      selection.selectRange(rangeIds(selection.anchorId, task.id));
      return;
    }
    selection.replace([task.id]);
    onClick();
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-item-id={task.id}
      data-item-kind="task"
      data-multiselected={isMultiSelected ? 'true' : 'false'}
      className={cn('group/blocktask relative flex items-center gap-1', isDragging && 'z-50 opacity-50')}
    >
      <button
        {...attributes}
        {...listeners}
        // touch-manipulation, not touch-none — same rule as TaskRow
        // (components/primitives/task-row.tsx). `touch-action: none` is a
        // browser-level surrender of the gesture, so it applies no matter which
        // sensor ends up claiming it: a finger landing here could neither scroll
        // nor, for the TouchSensor's first 250ms, drag. And it lands here more
        // often than the styling suggests — the grip is `opacity-0` until hover,
        // which a phone has none of, but it still occupies layout and still
        // hit-tests, and this block renders on mobile through DayBuckets.
        className="flex cursor-grab touch-manipulation items-center text-muted-foreground opacity-0 transition-opacity active:cursor-grabbing group-hover/blocktask:opacity-100"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <ItemContextMenu item={task} date={blockDate}>
        <div
          onClick={handleClick}
          // No done-fade on this container — it would composite the lime check down
          // with everything else, and 60% lime on the dark ramp is olive. The title
          // carries the fade instead (below).
          className={cn(
            'flex flex-1 cursor-pointer items-center gap-2 rounded-lg px-3 py-2 transition-colors',
            // Selected keeps a latched wash, a notch above hover — the same
            // --row-selected highlight the list rows use (reads over surface-3).
            isMultiSelected ? 'bg-[var(--row-selected)]' : 'bg-surface-3/70 hover-wash'
          )}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleTaskStatus(task.id, undefined, recurring ? blockDate : undefined);
            }}
            className={cn(
              'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors',
              done ? 'border-primary bg-primary' : 'border-muted-foreground/40 hover:border-primary'
            )}
          >
            {done && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
          </button>
          <span
            className={cn('flex-1 font-content text-content', done && 'text-muted-foreground line-through opacity-60')}
          >
            {task.title}
          </span>
        </div>
      </ItemContextMenu>
    </div>
  );
}

interface ProjectBlockProps {
  project: Project;
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  activeId?: string | null;
  /** Day view sizes nothing here — the block just grows with its content.
   *  Week × Buckets (issue #193) is a ~240px mini column stacked four buckets
   *  deep, where an unbounded block can push the rest of the day column off
   *  screen, so 'week' caps the body and scrolls it instead. Defaults to
   *  'day' so the shared day-buckets usage is untouched. */
  variant?: 'day' | 'week';
  /** The day this block is rendered for (week columns); defaults to the
   *  selected day, which is what day-buckets wants. */
  date?: Date;
}

/** How many not-yet-in-block tasks the "available" panel previews before it
 *  collapses into "+N more". A week column is ~240px wide and the block body
 *  is capped at WEEK_PROJECT_BLOCK_MAX_H, so five previews there would be all
 *  anyone ever saw of the block — the tasks actually IN the block would sit
 *  above the fold. Same panel, fewer rows; no layout of its own. */
const PREVIEW_LIMIT = { day: 5, week: 2 } as const;

export function ProjectBlock({
  project,
  tasks,
  onTaskClick,
  activeId,
  variant = 'day',
  date,
}: ProjectBlockProps) {
  const { getProjectColor, tasks: allTasks, moveTaskToProjectBlock, moveTasksToProjectBlock } =
    usePlannerStore();

  const tasksInBlock = tasks.filter((t) => t.inProjectBlock);
  const availableTasks = allTasks.filter(
    (t) => t.project === project.name && t.status !== 'completed' && !t.inProjectBlock
  );

  const projectColor = getProjectColor(project.name);
  const { isOver, setNodeRef } = useDroppable({ id: `projectblock:${project.name}` });
  const draggedTask = activeId ? allTasks.find((t) => t.id === activeId) : null;
  const canAcceptDrop = draggedTask && draggedTask.project === project.name;
  const previewLimit = PREVIEW_LIMIT[variant];

  return (
    <div
      ref={setNodeRef}
      data-testid="project-block"
      data-dnd-id={`projectblock:${project.name}`}
      data-dnd-over={isOver ? 'true' : 'false'}
      // A project block only accepts a task whose project matches, so a test
      // asserting the reject path needs to see the distinction.
      data-dnd-accepts={canAcceptDrop ? 'true' : 'false'}
      // A settle frame (lib/settle.ts). By id, not by the name the droppable
      // uses: a rename elsewhere is the same block, retitled.
      data-settle-key={`project:${project.id}`}
      data-settle-role="frame"
      // A card floating ON the bucket's card, not a dashed outline drawn on it.
      // The dashed 2px project-coloured border was the loudest edge inside a
      // bucket — heavier than the bucket's own — and it read as a dropzone
      // placeholder rather than as a thing that exists. Now it is a real plate:
      // ring + cast shadow in light (where the card underneath is already
      // 1.000 and there is no value left to climb), a surface step plus a
      // specular edge in dark. See --bkt-block in globals.css.
      //
      // The project's colour survives as a 3px rule down the left edge — the
      // schedule view's accent rail, which is where colour belongs in this app:
      // a mark, never a container.
      className={cn(
        'relative mb-3 overflow-hidden rounded-[10px] p-3 pl-[15px] transition-all',
        'bg-[var(--bkt-block)] shadow-[var(--bkt-block-shadow)]',
        isOver && canAcceptDrop && 'bg-[var(--bkt-tray-armed)]',
        isOver && !canAcceptDrop && 'bg-destructive/5'
      )}
    >
      {/* The accent rail. Its own element rather than a border so it follows the
          radius without the box model moving, and so the armed state can light
          it without touching the plate's geometry. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: isOver ? 'var(--primary)' : projectColor }}
      />
      <ContainerContextMenu kind="project" id={project.id}>
        <div className="mb-2 flex items-center gap-2">
          <CategoryIcon glyph={project.emoji} name={project.name} className="h-4 w-4 flex-shrink-0" />
          {/* Truncation is a no-op at day width; in a ~240px week column it is the
              difference between "name pushes the time out of the clipped card" and
              "name ellipsises, time stays". No sizing of its own. */}
          <span className="min-w-0 truncate font-content text-content text-foreground">{project.name}</span>
          <span className="flex flex-shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {project.startTime}
            {project.duration ? ` · ${project.duration}m` : ''}
          </span>
        </div>
      </ContainerContextMenu>

      {/* Week caps the body and scrolls it — see the `variant` doc above. Day
          stays unbounded, exactly as before. Plain overflow-y-auto, not
          <ScrollArea> — the Radix wrapper silently drops max-h. */}
      <div
        className={cn(variant === 'week' && 'overflow-y-auto')}
        style={variant === 'week' ? { maxHeight: WEEK_PROJECT_BLOCK_MAX_H } : undefined}
      >
        {tasksInBlock.length > 0 && (
          <div className="mb-3 space-y-1.5">
            {tasksInBlock.map((task) => (
              <BlockTask key={task.id} task={task} onClick={() => onTaskClick(task)} date={date} />
            ))}
          </div>
        )}

        {availableTasks.length > 0 ? (
          <div className="rounded-lg border border-dashed border-border/50 p-2">
            <div className="mb-2 flex items-center justify-between">
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {availableTasks.length} task{availableTasks.length !== 1 ? 's' : ''} available
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 flex-shrink-0 px-2 text-xs text-success-text hover:text-success-text"
                onClick={() => moveTasksToProjectBlock(availableTasks.map((t) => t.id))}
              >
                <ChevronsRight className="mr-1 h-3 w-3" />
                Move all
              </Button>
            </div>
            <div className="space-y-1.5">
              {availableTasks.slice(0, previewLimit).map((task) => (
                <div
                  key={task.id}
                  onClick={() => onTaskClick(task)}
                  className="group/preview flex cursor-pointer items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-2 transition-colors hover-wash"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-content text-content text-foreground">{task.title}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 flex-shrink-0 p-0 text-muted-foreground opacity-0 hover:text-success-text group-hover/preview:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      moveTaskToProjectBlock(task.id);
                    }}
                    title="Move to block"
                  >
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              {availableTasks.length > previewLimit && (
                <p className="py-1 text-center text-xs text-muted-foreground/70">
                  +{availableTasks.length - previewLimit} more
                </p>
              )}
            </div>
          </div>
        ) : tasksInBlock.length === 0 ? (
          <div
            className={cn(
              'rounded-lg border border-dashed border-border/50 py-3 text-center text-xs text-muted-foreground',
              isOver && canAcceptDrop && 'border-primary bg-primary/5'
            )}
          >
            {isOver && canAcceptDrop ? (
              <span className="text-success-text">Drop to add to block</span>
            ) : isOver && !canAcceptDrop ? (
              <span className="text-destructive/70">Only {project.name} tasks allowed</span>
            ) : (
              <span>No tasks for this project yet</span>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
