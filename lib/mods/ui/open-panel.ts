import { leaveZen } from '../../open-chat';
import { useRailStore, type ModPanelRef } from '../../rail-store';
import { closeItemPanel, letGoHeldItem, useUIStore } from '../../ui-store';
import { useModSheet } from './sheet-store';

/**
 * The one door that opens a mod's panel (memory/plans/mods.md, build order 9):
 * the sheet on the phone, the rail on the desktop. ⌘K's panel commands, the
 * header opener (components/mods/mod-opener.tsx) and a held `$.ui.open`
 * (lib/mods/broker.ts) all come here.
 *
 * Which one is decided by whether the phone shell is mounted: it hosts the
 * sheet (`setModSheetHost`, a count, so StrictMode's mount, unmount, mount
 * leaves it right). Not by the window's width, which a desktop shell shares
 * with nothing that could show a sheet.
 */

export type { ModPanelRef } from '../../rail-store';

let sheetHosts = 0;

/** The phone shell mounting: counts it, and returns its own release (once). */
export function setModSheetHost(): () => void {
  sheetHosts += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    sheetHosts = Math.max(0, sheetHosts - 1);
    // Nothing left to show it: a panel kept would spring open on the next host.
    if (sheetHosts === 0) useModSheet.getState().close();
  };
}

/** Whether the phone's mod sheet is mounted, so a panel opens there and nav closes it first. */
export function isSheetHosted(): boolean {
  return sheetHosts > 0;
}

/**
 * Shows a mod's panel where this shell shows panels. On the phone the sheet
 * (a new panel replaces the one showing), and rail-store is never touched. On
 * the desktop an open item closes first, through the one flushing close (the
 * panel would only open under it), then out of Zen, which replaces the shell
 * the rail lives in, then the rail's 'mod' mode.
 *
 * An item held for the landing (lib/ui-store.ts deferredDialog, over the
 * look-only preview) is let go first: the panel is the later ask, and the
 * held item would open over the rail's panel when the fresh data lands. The
 * sheet's branch does the same as a guard only; no phone door reaches here
 * over the preview today (the opener is desktop-only, ⌘K's panel commands are
 * gated, `$.ui.open` waits for the runtime).
 */
export function openModPanel(ref: ModPanelRef): void {
  letGoHeldItem();
  if (isSheetHosted()) {
    useModSheet.getState().show(ref);
    return;
  }
  if (useUIStore.getState().activeDialog?.type === 'edit-item') closeItemPanel();
  leaveZen();
  useRailStore.getState().openModPanel(ref);
}

/** Closes the phone's mod sheet, before something else takes the screen. */
export function closeModSheet(): void {
  if (useModSheet.getState().ref) useModSheet.getState().close();
}

/** Tests only: no host counted. */
export function __resetModSheetHostsForTests(): void {
  sheetHosts = 0;
}
