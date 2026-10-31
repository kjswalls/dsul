'use client';

import { memo, useEffect, useRef, type KeyboardEvent, type MouseEvent, type MutableRefObject } from 'react';
import { useDraggable, type DraggableSyntheticListeners } from '@dnd-kit/core';
import { ItemContextMenu } from '@/components/planner/item-context-menu';
import { ItemTick, animateItemCheck } from '@/components/primitives/item-check';
import { useVerbs } from '@/components/planner/organize/member-row-actions';
import { useSelectionStore, rangeIds } from '@/lib/selection-store';
import { useUIStore, openEditFor } from '@/lib/ui-store';
import { setHoveredItemRef } from '@/lib/hovered-item';
import { formatShort } from '@/lib/collections';
import type { AtlasMember } from '@/lib/atlas-model';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { atlasRowDragId, type AtlasDropKind } from '@/lib/dnd/atlas-ids';
import type { HabitItem, Task } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

interface AtlasRowProps {
  member: AtlasMember;
  cardKey: string;
  /** The ids of every row on this card, for Shift+click's range. */
  cardRowIds: readonly string[];
  todayStr: string;
  milestoneIds: ReadonlySet<string>;
  /**
   * Called just before the tick runs, so the card can hold this row where it
   * is while the model re-picks (a ticked row leaving at once would put the
   * next item's box under a second click).
   */
  onTicked?: (itemId: string) => void;
  /**
   * The card's kind and id: the row is a drag source, `atlasrow:{kind}:{id}:{item}`
   * (lib/dnd/atlas-ids.ts), dropped on another card or on the braindump. The
   * focus sheet's rows leave it out: the card under the sheet already owns
   * that id, and dnd-kit keys its registry by id.
   */
  drag?: AtlasDropKind;
  containerId?: string;
}

interface RowDnd {
  setNodeRef: (el: HTMLElement | null) => void;
  listeners: DraggableSyntheticListeners;
  isDragging: boolean;
  wasDragged: MutableRefObject<boolean>;
}

/**
 * One item row on an Atlas card: 28px, its own tick box, the title, an
 * optional date. Not TaskRow: its draggable carries the raw item id, which is
 * one id for an item shown on four cards and in the braindump at once. A card's
 * row drags under its own `atlasrow:` id instead (PR4).
 *
 * The box is this surface's own button, with the shared tick and motion
 * (components/primitives/item-check.tsx). Its verb is the shared declaration
 * (lib/item-verbs.ts through useVerbs), acting on TODAY, with the day's state
 * handed down from the card's model rather than derived here.
 *
 * One item can show on several cards (a project's and a goal's), so the row
 * carries `data-atlas-card-key` beside `data-item-id`, and never a
 * `data-settle-key`.
 */
export const AtlasRow = memo(function AtlasRow(props: AtlasRowProps) {
  return props.drag && props.containerId ? (
    <DraggableAtlasRow {...props} drag={props.drag} containerId={props.containerId} />
  ) : (
    <AtlasRowBody {...props} />
  );
});

function DraggableAtlasRow(props: AtlasRowProps & { drag: AtlasDropKind; containerId: string }) {
  const { listeners, setNodeRef, isDragging } = useDraggable({
    id: atlasRowDragId(props.drag, props.containerId, props.member.item.id),
  });
  // After a drop the browser fires a click on the row: swallow it so a drag
  // never opens the item. Cleared on a macrotask, since a drop elsewhere fires
  // no click at all (TaskRow's pattern).
  const wasDragged = useRef(false);
  useEffect(() => {
    if (isDragging) {
      wasDragged.current = true;
      return;
    }
    if (wasDragged.current) {
      const t = setTimeout(() => {
        wasDragged.current = false;
      }, 0);
      return () => clearTimeout(t);
    }
  }, [isDragging]);
  return <AtlasRowBody {...props} dnd={{ setNodeRef, listeners, isDragging, wasDragged }} />;
}

function AtlasRowBody({
  member,
  cardKey,
  cardRowIds,
  todayStr,
  milestoneIds,
  onTicked,
  dnd,
}: AtlasRowProps & { dnd?: RowDnd }) {
  const { item, state, todayState } = member;
  const boxRef = useRef<HTMLButtonElement>(null);
  const kind = item.type === 'habit' ? 'habit' : 'task';
  const selected = useSelectionStore((s) => s.selectedIds.has(item.id));
  // useVerbs reads an undefined day state as 'absent'; a one-off ignores it.
  const verbs = useVerbs(item, todayState === 'absent' ? undefined : todayState, todayStr, milestoneIds);
  const done = state === 'lit';
  const startDate = 'startDate' in item ? item.startDate : undefined;

  const open = () => {
    useSelectionStore.getState().replace([item.id]);
    openEditFor(item as unknown as Task | HabitItem, kind);
  };

  const onClick = (e: MouseEvent) => {
    if (dnd?.wasDragged.current) return;
    const selection = useSelectionStore.getState();
    if (e.metaKey || e.ctrlKey) {
      selection.toggle(item.id);
      return;
    }
    if (e.shiftKey) {
      // With the anchor on this card, the range runs along this card's own
      // rows: rangeIds walks the document and counts an item once, at its
      // first row, so an item that also shows on an earlier card would bend
      // the range out of this one. With the anchor elsewhere, the document
      // range is clipped to this card's rows.
      const a = selection.anchorId ? cardRowIds.indexOf(selection.anchorId) : -1;
      const t = cardRowIds.indexOf(item.id);
      if (a !== -1 && t !== -1) {
        selection.selectRange(cardRowIds.slice(Math.min(a, t), Math.max(a, t) + 1));
      } else {
        const mine = new Set(cardRowIds);
        selection.selectRange(rangeIds(selection.anchorId, item.id).filter((id) => mine.has(id)));
      }
      return;
    }
    open();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
    e.preventDefault();
    e.stopPropagation();
    open();
    useUIStore.getState().focusItemPanel();
  };

  return (
    <ItemContextMenu item={item} date="today" occurrence={todayState}>
      <div
        ref={dnd?.setNodeRef}
        {...dnd?.listeners}
        data-testid="atlas-row"
        data-item-id={item.id}
        data-item-kind={kind}
        data-atlas-card-key={cardKey}
        data-selected={selected ? 'true' : 'false'}
        data-completed={done ? 'true' : 'false'}
        tabIndex={0}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onMouseEnter={() => setHoveredItemRef(item.id, kind, todayStr)}
        onMouseLeave={() => setHoveredItemRef(null, null)}
        className={cn(
          'flex h-7 w-full cursor-pointer items-center gap-[9px] rounded-[6px] px-[7px] text-xs leading-[17px] outline-none',
          'focus-visible:ring-2 focus-visible:ring-ring',
          selected ? 'bg-[var(--row-selected)]' : 'hover:bg-accent',
          // The twin is away (components/shell/drag-ghost.tsx): a hollow slot,
          // never a faded copy, so the lime tick is never under an opacity.
          dnd?.isDragging && 'drag-source'
        )}
      >
        <button
          ref={boxRef}
          type="button"
          role="checkbox"
          aria-checked={done}
          aria-label={verbs.tick?.label ?? (done ? ATLAS_COPY.markOpen : ATLAS_COPY.markDone)}
          disabled={!verbs.tick}
          data-testid="atlas-row-check"
          onClick={(e) => {
            e.stopPropagation();
            // The second click of a double click is not a second tick.
            if (!verbs.tick || e.detail > 1) return;
            onTicked?.(item.id);
            animateItemCheck(boxRef.current, done);
            verbs.tick.run();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className={cn(
            'relative flex size-4 flex-shrink-0 items-center justify-center overflow-hidden rounded-[5px] inset-ring transition-[background-color,box-shadow]',
            done
              ? 'inset-ring-check-fill bg-check-fill shadow-[var(--check-shadow)]'
              : 'inset-ring-muted-foreground/45 bg-surface-3 hover:inset-ring-muted-foreground'
          )}
        >
          {done && <ItemTick />}
        </button>
        <span className={cn('min-w-0 flex-1 truncate', done ? 'text-muted-foreground' : 'text-foreground')}>
          {item.title}
        </span>
        {startDate && (
          <span className="flex-none text-2xs tabular-nums text-muted-foreground">{formatShort(startDate)}</span>
        )}
      </div>
    </ItemContextMenu>
  );
}
