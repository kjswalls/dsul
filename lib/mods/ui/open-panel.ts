/**
 * The one door that opens a mod's panel (memory/plans/mods.md, build order 9):
 * the sheet on the phone, the rail on the desktop. ⌘K's panel commands, the
 * header opener and a held `$.ui.open` (lib/mods/broker.ts) all come here.
 *
 * Build order 9 lands in parts. This part holds the names the broker needs;
 * the router, the sheet host count and the sheet's close come with the rail
 * and the sheet (lib/rail-store.ts, ./sheet-store.ts). Until then no sheet is
 * hosted and an open goes nowhere.
 */

export interface ModPanelRef {
  modId: string;
  panelId: string;
}

/** Whether the phone's mod sheet is mounted, so a panel opens there and nav closes it first. */
export function isSheetHosted(): boolean {
  return false;
}

/** Shows a mod's panel where this shell shows panels. */
export function openModPanel(ref: ModPanelRef): void {
  void ref;
}

/** Closes the phone's mod sheet, before something else takes the screen. */
export function closeModSheet(): void {}
