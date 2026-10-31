'use client';

import { memo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { atlasCardDropId, atlasSourceOf, dragItemIdOf, type AtlasDropKind } from '@/lib/dnd/atlas-ids';
import { planFiling, type FilingPlan } from '@/lib/atlas-file';
import { usePlannerStore } from '@/lib/planner-store';
import { usePlannerPreviewing } from '@/lib/planner-ready';
import { useSelectionStore } from '@/lib/selection-store';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { cn } from '@/lib/utils';

/**
 * What a drop of the active drag here would do, asked only while the pointer
 * is over this card (one card at a time), so the store reads happen on enter
 * and leave and never per move. A multi-selection the grabbed row belongs to
 * files as a group, as the shell's drop does.
 */
function verdict(activeId: string, kind: AtlasDropKind, id: string): FilingPlan {
  const itemId = dragItemIdOf(activeId);
  const { selectedIds } = useSelectionStore.getState();
  const ids = selectedIds.has(itemId) && selectedIds.size >= 2 ? [...selectedIds] : [itemId];
  return planFiling(usePlannerStore.getState(), ids, { kind, id }, atlasSourceOf(activeId));
}

/**
 * An Atlas card as a drop target (`atlas:{kind}:{id}`, lib/dnd/CONTRACT.md).
 *
 * Its own element, laid over the card and taking no pointer events, for two
 * reasons. dnd-kit's default measure undoes the measured element's OWN
 * transform, and the card's transform is its place on the board, so measuring
 * the card would put every card at the board's origin; this element has no
 * transform of its own, so its box is the card's box on screen, the camera's
 * scale included. And the ring that says "this will take it" is drawn here,
 * not on the card, so nothing on the card changes and the lime is never
 * under an opacity.
 *
 * It lights lime only when the drop would write. Already there, or a type
 * that can't join, gets a quiet outline and the reason, and the drop springs
 * back. Off while the focus sheet is open or the planner is previewing.
 */
export const AtlasCardDrop = memo(function AtlasCardDrop({
  kind,
  id,
  name,
  disabled = false,
}: {
  kind: AtlasDropKind;
  id: string;
  name: string;
  disabled?: boolean;
}) {
  const sheetOpen = useAtlasUiStore((s) => s.sheet !== null);
  const previewing = usePlannerPreviewing();
  const dropId = atlasCardDropId(kind, id);
  const { isOver, active, setNodeRef } = useDroppable({ id: dropId, disabled: disabled || sheetOpen || previewing });
  const plan = isOver && active ? verdict(String(active.id), kind, id) : null;
  const acts = plan?.kind === 'file';
  const hint =
    plan?.kind === 'file'
      ? ATLAS_COPY.dropToFile(name)
      : plan?.kind === 'already'
        ? ATLAS_COPY.alreadyHere
        : plan?.kind === 'refused'
          ? plan.message
          : null;

  return (
    <div
      ref={setNodeRef}
      aria-hidden
      data-dnd-id={dropId}
      data-dnd-over={isOver ? 'true' : 'false'}
      data-dnd-acts={acts ? 'true' : 'false'}
      data-testid="atlas-card-drop"
      className={cn(
        'pointer-events-none absolute inset-0 rounded-2xl',
        acts ? 'atlas-drop-ring' : plan && 'outline-2 outline-offset-2 outline-dashed outline-muted-foreground/60'
      )}
    >
      {hint && (
        <span
          data-testid="atlas-card-drop-hint"
          className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-card px-2 py-0.5 text-2xs text-foreground shadow-[var(--shadow-elev-sm)]"
        >
          {hint}
        </span>
      )}
    </div>
  );
});
