'use client';

import { create } from 'zustand';
import { usePlannerStore } from './planner-store';
import { openEditFor } from './ui-store';
import type { Item, Task } from './planner-types';

/**
 * Renaming an item, in place or in the panel — its own concern, one store per
 * concern like selection-store. Ephemeral and never persisted.
 *
 * A row renames in place: double-click its title, F2 over it (`rename_hovered`,
 * app-shell), or Rename in its right-click menu. Every other way in (a surface
 * that draws no editable row, F2 with nothing under the pointer) opens the item
 * panel with its title selected instead, so Rename always lands somewhere.
 *
 * The target is the row, not only the item: a recurring item is drawn once per
 * day in a week view, and only the copy you pointed at turns into a field. A
 * null `dateStr` means "any row of this item" (the braindump draws one).
 *
 * Rows subscribe with a boolean selector (`isRenaming(s, id, dateStr)`), so
 * starting a rename re-renders only the row that matches.
 */
interface RenameTarget {
  id: string;
  dateStr: string | null;
}

interface RenameStore {
  target: RenameTarget | null;
  /**
   * Set by `renameInPanel`; the item panel reads it when it opens on that item,
   * selects its title and clears it. A flag, not a call, because the panel is
   * not mounted yet when the rename is asked for.
   */
  panelSelectId: string | null;
  start: (id: string, dateStr?: string | null) => void;
  end: () => void;
  takePanelSelect: (id: string) => boolean;
}

export const useRenameStore = create<RenameStore>((set, get) => ({
  target: null,
  panelSelectId: null,
  start: (id, dateStr = null) => set({ target: { id, dateStr } }),
  end: () => set({ target: null }),
  takePanelSelect: (id) => {
    if (get().panelSelectId !== id) return false;
    set({ panelSelectId: null });
    return true;
  },
}));

export function isRenaming(s: Pick<RenameStore, 'target'>, id: string, dateStr: string): boolean {
  const t = s.target;
  return !!t && t.id === id && (t.dateStr === null || t.dateStr === dateStr);
}

export function startRename(id: string, dateStr?: string | null): void {
  useRenameStore.getState().start(id, dateStr);
}

/** Opens the item panel with its title selected, ready to type over. */
export function renameInPanel(item: Item): void {
  useRenameStore.setState({ panelSelectId: item.id });
  openEditFor(item as unknown as Task, item.type === 'habit' ? 'habit' : 'task');
}

/**
 * Writes a new title. Trimmed; an empty or unchanged title writes nothing, so
 * clearing the field and leaving is the same as Escape. Habits go through
 * updateHabit; every other type is task-shaped (commitEdit's split).
 */
export function renameItem(id: string, title: string): boolean {
  const next = title.trim();
  const store = usePlannerStore.getState();
  const item = store.items.find((i) => i.id === id);
  if (!item || !next || next === item.title) return false;
  if (item.type === 'habit') store.updateHabit(id, { title: next });
  else store.updateTask(id, { title: next }, { label: `Rename: ${item.title}` });
  return true;
}
