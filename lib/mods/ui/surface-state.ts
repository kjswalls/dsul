import { parseModManifest, type ModPanel, type UserMod } from '../schema';
import type { SandboxStatus } from '../sandbox-host';
import type { ModPanelRef } from './open-panel';
import type { PanelStatus } from './panel-store';

/**
 * What a mod surface (components/mods/mod-surface.tsx) shows, read from the
 * mod's row and the sandbox, never from the runner slot (memory/plans/mods.md,
 * build order 9). Pure.
 *
 * - `absent`: safe mode, no ref, or a panel the mod no longer declares. Draw nothing.
 * - `off`: the row is gone or switched off.
 * - `unavailable`: the sandbox cannot run here, or this tab is older than the deploy.
 * - otherwise the panel's own status. A panel the runtime has not answered
 *   yet (the planner still settling) is just `loading`.
 */
export type SurfaceState = 'absent' | 'off' | 'unavailable' | PanelStatus;

export function surfaceStateOf(
  ref: ModPanelRef | null,
  ctx: {
    rows: readonly UserMod[];
    safeMode: boolean;
    sandboxStatus: SandboxStatus;
    panel: PanelStatus | undefined;
  }
): SurfaceState {
  if (ctx.safeMode || !ref) return 'absent';
  const row = ctx.rows.find((r) => r.id === ref.modId && r.kind === 'mod');
  if (!row || !row.enabled) return 'off';
  if (!panelOf(row, ref.panelId)) return 'absent';
  if (ctx.sandboxStatus === 'unavailable' || ctx.sandboxStatus === 'outdated') return 'unavailable';
  return ctx.panel ?? 'loading';
}

/** The panel as the row's stored manifest declares it, or null. */
export function panelOf(row: UserMod, panelId: string): ModPanel | null {
  return parseModManifest(row)?.panels.find((p) => p.id === panelId) ?? null;
}
