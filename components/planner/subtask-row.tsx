'use client';

import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Pencil, X } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ItemTick } from '@/components/primitives/item-check';
import { RowRenameInput } from '@/components/primitives/row-rename-input';
import { setHoveredItemRef } from '@/lib/hovered-item';
import { isRenaming, startRename, useRenameStore } from '@/lib/item-rename';
import type { TaskItem } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

export type SubtaskMove = 'up' | 'down' | 'top' | 'bottom';

/** The drag a grip is in charge of: where the row has been pulled to. */
export interface SubtaskDragHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * One subtask in the item panel (the subtasks round, layout A): a box on the
 * title's first line, a title that wraps instead of being cut, a grip in the
 * margin and a ✕ at the end that show on hover, and a right-click menu.
 *
 * Only an open row moves. `canMove` says which ways it can go right now (null:
 * a finished row, which has no place in the order on screen), so the menu's
 * Move rows grey out at the ends rather than doing nothing.
 */
export function SubtaskRow({
  child,
  onToggle,
  onDelete,
  onPromote,
  move,
  canMove,
  drag,
  dragging,
}: {
  child: TaskItem;
  /** The box when ticked from it (the tick animates there); null from the menu. */
  onToggle: (box: HTMLElement | null) => void;
  onDelete: () => void;
  onPromote: () => void;
  move: (where: SubtaskMove) => void;
  canMove: { up: boolean; down: boolean } | null;
  drag: SubtaskDragHandlers | null;
  dragging: boolean;
}) {
  const completed = child.status === 'completed';

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Alt+↑/↓ moves the row the focus is in (its box or its title), the
    // keyboard's way to do what the grip does.
    if (!e.altKey || !canMove || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'ArrowUp' && canMove.up) move('up');
    if (e.key === 'ArrowDown' && canMove.down) move('down');
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group relative -mx-1.5 flex items-start gap-2.5 rounded-md px-1.5 py-[5px] transition-colors',
            // The held row stays in its place, faded (it holds no lime), and the
            // lime line alone says where it will land.
            dragging ? 'bg-accent opacity-50' : 'hover:bg-accent'
          )}
          data-testid="subtask-row"
          data-subtask-id={child.id}
          data-subtask-open={canMove ? '' : undefined}
          onKeyDown={onKeyDown}
          // F2 over a subtask renames it in place, as over a planner row
          // (rename_hovered reads this ref; so do E and Backspace).
          onMouseEnter={() => setHoveredItemRef(child.id, 'task')}
          onMouseLeave={() => setHoveredItemRef(null, null)}
        >
          {drag && (
            // In the margin, so showing it moves nothing. Pointer only: a
            // phone has no hover, and long press is a drag of its own there.
            <span
              aria-hidden
              data-testid="subtask-grip"
              className={cn(
                'text-muted-foreground absolute top-[7px] -left-3 flex h-4 w-3 cursor-grab touch-none items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing',
                dragging && 'opacity-100'
              )}
              {...drag}
            >
              <GripDots />
            </span>
          )}
          <span className="flex h-5 shrink-0 items-center">
            <button
              type="button"
              onClick={(e) => onToggle(e.currentTarget)}
              aria-label={completed ? 'Mark not done' : 'Mark done'}
              className={cn(
                'relative flex size-4 shrink-0 items-center justify-center rounded-[5px] inset-ring transition-[background-color,box-shadow]',
                'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                completed
                  ? 'inset-ring-check-fill bg-check-fill shadow-[var(--check-shadow)]'
                  : 'inset-ring-muted-foreground/45 hover:inset-ring-muted-foreground'
              )}
            >
              {completed && <ItemTick />}
            </button>
          </span>
          <SubtaskTitle child={child} />
          <span className="flex h-5 shrink-0 items-center">
            <button
              type="button"
              onClick={onDelete}
              aria-label={`Delete subtask ${child.title}`}
              className="text-muted-foreground hover:text-destructive opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52" data-testid="subtask-menu">
        <ContextMenuItem onSelect={() => onToggle(null)}>
          {completed ? 'Mark not done' : 'Mark done'}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => startRename(child.id)}>
          Rename
          <ContextMenuShortcut>F2</ContextMenuShortcut>
        </ContextMenuItem>
        {canMove && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!canMove.up} onSelect={() => move('up')}>
              Move up
              <ContextMenuShortcut>Alt ↑</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem disabled={!canMove.down} onSelect={() => move('down')}>
              Move down
              <ContextMenuShortcut>Alt ↓</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem disabled={!canMove.up} onSelect={() => move('top')}>
              Move to top
            </ContextMenuItem>
            <ContextMenuItem disabled={!canMove.down} onSelect={() => move('bottom')}>
              Move to bottom
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onPromote} data-testid="subtask-promote">
          Make it its own task
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function GripDots() {
  return (
    <svg viewBox="0 0 12 16" className="h-4 w-3 fill-current" aria-hidden>
      <circle cx="3.5" cy="3" r="1.3" />
      <circle cx="8.5" cy="3" r="1.3" />
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8.5" cy="8" r="1.3" />
      <circle cx="3.5" cy="13" r="1.3" />
      <circle cx="8.5" cy="13" r="1.3" />
    </svg>
  );
}

/**
 * A subtask's title, renamed in place (lib/item-rename.ts) with the planner
 * rows' field. One click is enough here, unlike a row's double-click: a row's
 * click opens the panel, but a subtask's title does nothing else, and a click
 * is the only way in on a phone, where a double tap zooms. A pencil on hover
 * says it is a field (the row's own tint is the hover). A long title
 * wraps (the subtasks round): the list is read, not scanned, and a cut title
 * hid the part that said what the step was.
 */
function SubtaskTitle({ child }: { child: TaskItem }) {
  // Any target with no day (F2 over the row, or the click below) is this one.
  const renaming = useRenameStore((s) => isRenaming(s, child.id, ''));
  const completed = child.status === 'completed';
  if (renaming) {
    // The title's own 20px line, so the words stay put when the field opens.
    return <RowRenameInput itemId={child.id} title={child.title} className="h-5 py-0 font-sans text-sm leading-5" />;
  }
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`Rename subtask ${child.title}`}
      data-testid="subtask-title"
      onClick={() => startRename(child.id)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== 'F2') return;
        e.preventDefault();
        e.stopPropagation();
        startRename(child.id);
      }}
      className={cn(
        'group/subtitle relative -mx-1 min-w-0 flex-1 cursor-text rounded-[3px] px-1 pr-5 text-sm leading-5 [overflow-wrap:anywhere]',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        completed && 'text-muted-foreground line-through'
      )}
    >
      {child.title}
      <Pencil
        aria-hidden="true"
        className="text-muted-foreground pointer-events-none absolute top-1 right-1 size-3 opacity-0 transition-opacity group-hover/subtitle:opacity-100"
      />
    </span>
  );
}
