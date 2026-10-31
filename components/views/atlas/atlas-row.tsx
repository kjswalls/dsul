'use client';

import { memo, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { ItemContextMenu } from '@/components/planner/item-context-menu';
import { ItemTick, animateItemCheck } from '@/components/primitives/item-check';
import { useVerbs } from '@/components/planner/organize/member-row-actions';
import { useSelectionStore, rangeIds } from '@/lib/selection-store';
import { useUIStore, openEditFor } from '@/lib/ui-store';
import { setHoveredItemRef } from '@/lib/hovered-item';
import { formatShort } from '@/lib/collections';
import type { AtlasMember } from '@/lib/atlas-model';
import type { HabitItem, Task } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * One item row on an Atlas card: 28px, its own tick box, the title, an
 * optional date. Not TaskRow: TaskRow registers a dnd-kit draggable, which
 * would offer a braindump drop with no plan behind it (rows drag in PR4).
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
export const AtlasRow = memo(function AtlasRow({
  member,
  cardKey,
  cardRowIds,
  todayStr,
  milestoneIds,
}: {
  member: AtlasMember;
  cardKey: string;
  /** The ids of every row on this card, for Shift+click's range. */
  cardRowIds: readonly string[];
  todayStr: string;
  milestoneIds: ReadonlySet<string>;
}) {
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
    const selection = useSelectionStore.getState();
    if (e.metaKey || e.ctrlKey) {
      selection.toggle(item.id);
      return;
    }
    if (e.shiftKey) {
      // rangeIds walks every row in the document; keep only this card's.
      const mine = new Set(cardRowIds);
      selection.selectRange(rangeIds(selection.anchorId, item.id).filter((id) => mine.has(id)));
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
          selected ? 'bg-[var(--row-selected)]' : 'hover:bg-accent'
        )}
      >
        <button
          ref={boxRef}
          type="button"
          role="checkbox"
          aria-checked={done}
          aria-label={verbs.tick?.label ?? (done ? 'Mark incomplete' : 'Mark complete')}
          disabled={!verbs.tick}
          data-testid="atlas-row-check"
          onClick={(e) => {
            e.stopPropagation();
            if (!verbs.tick) return;
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
});
