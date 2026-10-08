import { parseModManifest, type ModPanel, type UserMod } from '../schema';
import type { ModPanelRef } from './open-panel';

/**
 * Which panel the braindump card shows (memory/plans/mods.md, build order 9):
 * the card panel of the earliest-created switched-on mod that declares one.
 * One slot, so a second mod's card waits, and Make says which one is showing.
 * Pure, so Make and the card read the same answer.
 */
export function cardPanelOf(rows: readonly UserMod[]): (ModPanelRef & { panel: ModPanel; row: UserMod }) | null {
  let best: (ModPanelRef & { panel: ModPanel; row: UserMod }) | null = null;
  for (const row of rows) {
    if (row.kind !== 'mod' || !row.enabled) continue;
    const panel = parseModManifest(row)?.panels.find((p) => p.card);
    if (!panel) continue;
    if (best && best.row.createdAt <= row.createdAt) continue;
    best = { modId: row.id, panelId: panel.id, panel, row };
  }
  return best;
}
