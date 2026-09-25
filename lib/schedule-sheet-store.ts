'use client';

import { create } from 'zustand';
import type { Task, HabitItem } from '@/lib/planner-types';

/** A row the mobile schedule sheet acts on (mirror of TaskRow's RowItem). */
export type SheetRow = { itemType: 'task'; item: Task } | { itemType: 'habit'; item: HabitItem };

/**
 * Drives the mobile tap-to-schedule sheet: a row's ellipsis opens it, the sheet
 * assigns a time bucket (or deletes / unschedules) via the planner store. Kept
 * out of ui-store so it doesn't touch the desktop dialog union.
 */
interface ScheduleSheetStore {
  row: SheetRow | null;
  /**
   * The day the row was drawn for (YYYY-MM-DD), when it was drawn for one. A
   * week column's row is not on the selected day, and a braindump row is on no
   * day at all — both of which the sheet's per-date actions need to know.
   */
  dateStr: string | null;
  open: (row: SheetRow, dateStr?: string | null) => void;
  close: () => void;
}

export const useScheduleSheet = create<ScheduleSheetStore>((set) => ({
  row: null,
  dateStr: null,
  open: (row, dateStr = null) => set({ row, dateStr }),
  close: () => set({ row: null, dateStr: null }),
}));
