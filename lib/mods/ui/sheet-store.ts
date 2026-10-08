'use client';

import { create } from 'zustand';
import type { ModPanelRef } from '../../rail-store';

/**
 * The phone's mod sheet (components/mods/mod-sheet.tsx): which panel it shows,
 * if any. Kept out of ui-store's dialog union, as the schedule sheet is
 * (lib/schedule-sheet-store.ts), so it never displaces an item or a dialog
 * there. Memory only. Opened through lib/mods/ui/open-panel.ts, never here.
 */
interface ModSheetStore {
  ref: ModPanelRef | null;
  /** A new panel replaces the one showing. */
  show: (ref: ModPanelRef) => void;
  close: () => void;
}

export const useModSheet = create<ModSheetStore>((set) => ({
  ref: null,
  show: (ref) => set({ ref: { modId: ref.modId, panelId: ref.panelId } }),
  close: () => set({ ref: null }),
}));
