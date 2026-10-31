'use client';

import { memo, useEffect, useRef } from 'react';
import { useDndContext, useDroppable } from '@dnd-kit/core';
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
      {hint && <AtlasDropHint hint={hint} />}
    </div>
  );
});

/**
 * The line under the hovered card. The card lives in the scaled world, so the
 * hint counter-scales by the camera's zoom and reads at its own size at any
 * zoom (at 0.5 it would be 5px). Only the hovered card renders one, so the
 * camera subscription is one at a time.
 */
function AtlasDropHint({ hint }: { hint: string }) {
  const z = useAtlasUiStore((s) => s.camera.z);
  return (
    <span
      data-testid="atlas-card-drop-hint"
      style={{ scale: z > 0 ? 1 / z : 1, transformOrigin: 'top center' }}
      className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-card px-2 py-0.5 text-2xs text-foreground shadow-[var(--shadow-elev-sm)]"
    >
      {hint}
    </span>
  );
}

/**
 * Keeps every card's drop rect on the card while a drag is live and the camera
 * moves (a wheel pan or pinch, the minimap corner). The camera moves cards by
 * transform only, and dnd-kit re-measures droppables only when the list of
 * them changes or a drag starts (a ResizeObserver never fires on a
 * transform), so without this a wheel mid-drag left the pointer tested
 * against where the cards were. One measure per frame, of the `atlas:` ids
 * only; a new rect re-runs collision, so the lit card follows the camera even
 * with the mouse still.
 */
export function AtlasDropRemeasure() {
  const { active, droppableContainers, measureDroppableContainers } = useDndContext();
  const latest = useRef({ droppableContainers, measureDroppableContainers });
  useEffect(() => {
    latest.current = { droppableContainers, measureDroppableContainers };
  });
  const dragging = active !== null;

  useEffect(() => {
    if (!dragging) return;
    let frame: number | null = null;
    const unsubscribe = useAtlasUiStore.subscribe((s, prev) => {
      if (s.camera === prev.camera || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const { droppableContainers: map, measureDroppableContainers: measure } = latest.current;
        const ids = [...map.keys()].filter((id) => String(id).startsWith('atlas:'));
        // Never an empty list: dnd-kit reads [] as "measure everything, every render".
        if (ids.length > 0) measure(ids);
      });
    });
    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [dragging]);

  return null;
}
