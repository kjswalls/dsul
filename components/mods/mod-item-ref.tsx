'use client';

import { TypeGlyph, memberMeta } from '@/components/planner/organize/member-list';
import { usePlannerStore } from '@/lib/planner-store';
import { openEditFor } from '@/lib/ui-store';
import { isHabit } from '@/lib/verb-gates';
import { closeModSheet } from '@/lib/mods/ui/open-panel';
import { cn } from '@/lib/utils';
import { useSettledPress } from './settled-press';
import type { Task } from '@/lib/planner-types';

/**
 * A mod panel's `itemRef` node (memory/plans/mods.md, build order 9): one of
 * the person's items, drawn by the host from the planner as it is now, never
 * from anything the mod sent but the id. Read-only: a type glyph, the title
 * and its time, as one button that opens the item, exactly as a held
 * `$.ui.openItem` does (lib/mods/broker.ts). No drag, no tick, no AI fields.
 * In the phone's sheet the sheet closes first, so two drawers never stack.
 * A click counts only as a press the person saw (./settled-press.ts), like
 * the tree's buttons; `look` is the node's place in the tree.
 */
export function ModItemRef({
  id,
  inSheet = false,
  seq,
  look,
}: {
  id: string;
  inSheet?: boolean;
  seq: number;
  look: string;
}) {
  const item = usePlannerStore((s) => s.items.find((i) => i.id === id));
  const { ref, press, take } = useSettledPress<HTMLButtonElement>(seq, `${look}\u0000${id}\u0000${item?.title ?? ''}`);
  if (!item) {
    return (
      <p data-testid="mod-item-ref-missing" className="text-muted-foreground text-sm">
        Item not found
      </p>
    );
  }
  const meta = memberMeta(item);
  return (
    <button
      type="button"
      data-testid="mod-item-ref"
      className="hover:bg-accent focus-visible:ring-ring flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none focus-visible:ring-2"
      ref={ref}
      onPointerDown={press}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') press();
      }}
      onClick={() => {
        if (!take()) return;
        if (inSheet) closeModSheet();
        openEditFor(item as unknown as Task, isHabit(item) ? 'habit' : 'task');
      }}
    >
      <TypeGlyph item={item} />
      <span className="text-foreground min-w-0 flex-1 truncate">{item.title}</span>
      {meta.text && (
        <span className={cn('text-muted-foreground shrink-0 text-xs', meta.numeric && 'font-num')}>{meta.text}</span>
      )}
    </button>
  );
}
