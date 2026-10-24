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
  /**
   * Move up / Move down, when the row sits in a list in the user's own order
   * (lib/reorder.ts). The phone's way to reorder: long press there is a move,
   * never a reorder (Kirby, 2026-10-24).
   */
  moves: SheetMoves | null;
  open: (row: SheetRow, dateStr?: string | null, moves?: SheetMoves | null) => void;
  close: () => void;
}

export interface SheetMoves {
  up: (() => void) | null;
  down: (() => void) | null;
}

export const useScheduleSheet = create<ScheduleSheetStore>((set) => ({
  row: null,
  dateStr: null,
  moves: null,
  open: (row, dateStr = null, moves = null) => set({ row, dateStr, moves }),
  close: () => set({ row: null, dateStr: null, moves: null }),
}));
