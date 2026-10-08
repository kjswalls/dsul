import type { AtomValue } from '../protocol';
import type { SettleOutcome } from '../runtime-manager';
import type { ModPanelRef } from './open-panel';

/**
 * The panels' door into the mod runtime, as a slot ModHost fills while mods
 * run (components/mods/mod-host.tsx), for ../command-run.ts's reason: the
 * panel store and the renderer must not import the runtime. With the slot
 * empty (the planner still settling, safe mode, no mod on) every call answers
 * `'unavailable'` and nothing runs; ./panel-store.ts asks again when the slot
 * fills (subscribeModPanelRunner).
 */

export interface ModPanelRunner {
  resolvePanel(modId: string, panelId: string): Promise<SettleOutcome>;
  runAction(
    modId: string,
    panelId: string,
    action: string,
    arg: string | undefined,
    atoms: Record<string, AtomValue>,
    seq: number
  ): Promise<SettleOutcome>;
  atomChanged(modId: string, key: string, value: AtomValue): Promise<SettleOutcome>;
  /** A tree the host refused: a counted `error` fault. */
  panelFault(modId: string, panelId: string, message: string): void;
}

export type PanelRunOutcome = SettleOutcome | 'unavailable';

let runner: ModPanelRunner | null = null;
const fillListeners = new Set<() => void>();

export function setModPanelRunner(r: ModPanelRunner): () => void {
  runner = r;
  for (const fn of [...fillListeners]) {
    try {
      fn();
    } catch (err) {
      console.error('[mods] panel runner listener failed:', err);
    }
  }
  return () => {
    if (runner === r) runner = null;
  };
}

/** Called each time the slot fills, so a panel waiting on it asks again. */
export function subscribeModPanelRunner(fn: () => void): () => void {
  fillListeners.add(fn);
  return () => {
    fillListeners.delete(fn);
  };
}

export function hasModPanelRunner(): boolean {
  return runner !== null;
}

export function resolvePanel(ref: ModPanelRef): Promise<PanelRunOutcome> {
  return runner ? runner.resolvePanel(ref.modId, ref.panelId) : Promise.resolve('unavailable');
}

/** A press, with the mod's atoms as they are now and the seq of the tree the person pressed. */
export function runPanelAction(
  ref: ModPanelRef,
  action: string,
  arg: string | undefined,
  seq: number,
  atoms: Record<string, AtomValue>
): Promise<PanelRunOutcome> {
  return runner ? runner.runAction(ref.modId, ref.panelId, action, arg, atoms, seq) : Promise.resolve('unavailable');
}

export function notifyAtomChanged(modId: string, key: string, value: AtomValue): Promise<PanelRunOutcome> {
  return runner ? runner.atomChanged(modId, key, value) : Promise.resolve('unavailable');
}

export function reportPanelFault(ref: ModPanelRef, message: string): void {
  runner?.panelFault(ref.modId, ref.panelId, message);
}
