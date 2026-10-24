'use client';

import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useDragStore } from '@/lib/drag-store';
import { registerReorderSection } from '@/lib/dnd/reorder-sections';
import { peersOf, stepPeers, type PeerKind } from '@/lib/reorder';
import type { CompletedAs, SortableRow } from '@/lib/sort-rows';
import { usePlannerStore } from '@/lib/planner-store';

/**
 * One list of rows that can be put in order by hand (lib/reorder.ts): it works
 * out who may move, registers itself for the drag's hit test, draws the
 * insertion line while a drag would land in it, and tells each TaskRow inside
 * whether it shows a grip and how it steps up or down.
 *
 * `enabled` false renders the rows plainly: a list under another Ordering, or a
 * grouping with an order of its own, is not in the user's order.
 */

interface ReorderContextValue {
  canMove: (id: string) => boolean;
  /** One step up (-1) or down (+1); null at that end. */
  step: (id: string, dir: -1 | 1) => (() => void) | null;
}

const ReorderContext = createContext<ReorderContextValue | null>(null);

export function useReorder(): ReorderContextValue | null {
  return useContext(ReorderContext);
}

interface ReorderSectionProps {
  /** Unique among the lists on screen, e.g. `list:2026-10-24:Tasks`. */
  id: string;
  rows: readonly SortableRow[];
  /** The day the rows are drawn for; null in the braindump. */
  dateStr: string | null;
  completedAs?: CompletedAs;
  enabled: boolean;
  className?: string;
  children: ReactNode;
}

export function ReorderSection({ id, rows, dateStr, completedAs, enabled, className, children }: ReorderSectionProps) {
  const ref = useRef<HTMLDivElement>(null);
  const peers = useMemo(
    () => (enabled ? peersOf(rows, dateStr, completedAs) : null),
    [enabled, rows, dateStr, completedAs]
  );

  useLayoutEffect(() => {
    if (!peers || !ref.current) return;
    return registerReorderSection(id, { el: ref.current, peers });
  }, [id, peers]);

  const value = useMemo<ReorderContextValue | null>(() => {
    if (!peers) return null;
    const listOf = (rowId: string): string[] | null =>
      (['task', 'habit'] as PeerKind[]).map((k) => peers[k]).find((l) => l.includes(rowId)) ?? null;
    return {
      canMove: (rowId) => !!listOf(rowId),
      step: (rowId, dir) => {
        const list = listOf(rowId);
        const next = list ? stepPeers(list, rowId, dir) : null;
        if (!next) return null;
        return () => usePlannerStore.getState().reorderItems(next, dir < 0 ? 'Move up' : 'Move down');
      },
    };
  }, [peers]);

  return (
    <ReorderContext.Provider value={value}>
      <div ref={ref} className={className ? `relative ${className}` : 'relative'} data-reorder-section={peers ? id : undefined}>
        {children}
        {peers && <InsertionLine sectionId={id} />}
      </div>
    </ReorderContext.Provider>
  );
}

/** The lime line where a drag would land, drawn only in the section it would land in. */
function InsertionLine({ sectionId }: { sectionId: string }) {
  const lineY = useDragStore((s) => (s.reorder?.sectionId === sectionId ? s.reorder.lineY : null));
  if (lineY === null) return null;
  return (
    <div
      aria-hidden
      data-testid="reorder-line"
      className="pointer-events-none absolute inset-x-1 z-10 h-0.5 -translate-y-1/2 rounded-full bg-primary"
      style={{ top: lineY }}
    >
      <span className="absolute -left-1 top-1/2 size-2 -translate-y-1/2 rounded-full bg-primary" />
    </div>
  );
}
