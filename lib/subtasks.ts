/**
 * Subtasks in the item panel: their order, and where a move lands. Pure.
 *
 * A subtask is an ordinary item with `parentItemId`, so its place in the list is
 * the same `items.order` number every other list reads (lib/reorder.ts), and a
 * move writes it through `reorderItems`. A new subtask takes the next order
 * (`addTask`), so the list reads in the order they were added until the user
 * drags one. Rows with no order yet sort after the rest, in the order the store
 * holds them.
 */

export function sortSubtasks<T extends { order?: number }>(rows: readonly T[]): T[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const ao = a.row.order ?? Number.POSITIVE_INFINITY;
      const bo = b.row.order ?? Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao < bo ? -1 : 1;
      return a.i - b.i;
    })
    .map(({ row }) => row);
}

/**
 * The sequence with `id` taken out and put back in at `slot`, where a slot is a
 * gap in the ORIGINAL list: 0 is above the first row, `ids.length` below the
 * last. Null when that leaves the list as it was (the row dropped back into its
 * own gap, or an id that is not there), so a caller writes nothing.
 */
export function moveToSlot(ids: readonly string[], id: string, slot: number): string[] | null {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  const clamped = Math.max(0, Math.min(ids.length, slot));
  // The gaps directly above and below the row are where it already is.
  if (clamped === from || clamped === from + 1) return null;
  const next = ids.filter((x) => x !== id);
  next.splice(clamped > from ? clamped - 1 : clamped, 0, id);
  return next;
}

/** One step up (-1) or down (+1), or to an end; null when it cannot go. */
export function stepTo(ids: readonly string[], id: string, where: 'up' | 'down' | 'top' | 'bottom'): string[] | null {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  const slot = where === 'up' ? from - 1 : where === 'down' ? from + 2 : where === 'top' ? 0 : ids.length;
  if (slot < 0 || slot > ids.length) return null;
  return moveToSlot(ids, id, slot);
}

/**
 * The gap a pointer at `y` is over, given each row's vertical middle in order:
 * the number of rows whose middle is above it.
 */
export function slotAt(middles: readonly number[], y: number): number {
  let slot = 0;
  for (const m of middles) if (y > m) slot += 1;
  return slot;
}

/**
 * The subtask section's own words (web only; EDIT_COPY in lib/item-edit.ts is
 * shared with the iPhone app, which has no such offer or menu yet).
 */
export const SUBTASK_COPY = {
  /** After the last open subtask is ticked in the panel; it never ticks the task itself. */
  finishOffer: 'Last one done. Finish the task too?',
  /** A subtask made its own task (the subtask menu): it kept its own day. */
  promoted: 'Now its own task.',
  /** The same, for one with no day: it lands in the braindump. */
  promotedToBraindump: 'Now its own task, in the braindump.',
} as const;
