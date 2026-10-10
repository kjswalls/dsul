'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { usePlannerStore } from '@/lib/planner-store';
import { selectPlannerSettled } from '@/lib/planner-ready';
import { useModsStore } from '@/lib/mods-store';
import { subscribeModEvents, subscribeModOnlyEvents } from '@/lib/mod-events';
import { applyHeld, modRuntimeReady, realBrokerEnv } from '@/lib/mods/broker';
import { setModCommandRunner } from '@/lib/mods/command-run';
import { setModPanelRunner } from '@/lib/mods/ui/panel-run';
import { anyPanelVisible, panelBridge, usePanelStore } from '@/lib/mods/ui/panel-store';
import { logFault } from '@/lib/mods/faults-log';
import { modDisplayLabel } from '@/lib/mods/labels';
import { createModRuntime, setActiveModRuntime } from '@/lib/mods/runtime-manager';
import { modSandbox } from '@/lib/mods/sandbox-host';
import { modStoreSet } from '@/lib/mods/store-rpc';
import type { UserMod } from '@/lib/mods/schema';

/**
 * Runs the signed-in person's mods in this tab (lib/mods/runtime-manager.ts,
 * memory/plans/mods.md build order 8). Route-level, in app/layout.tsx beside
 * RecipeHost, for RecipeHost's reason: a tick on any route that loads the
 * planner is the user's own action.
 *
 * Active only while modRuntimeReady() holds (signed in, planner settled for
 * this account, Make's rows loaded, not safe mode) and some mod is on.
 * Leaving that state, or switching account, flushes the store writes still
 * waiting (best effort), unloads every mod, clears its timers, empties the
 * ⌘K slot and lets the sandbox go unless the editor holds it.
 *
 * It also re-reads Make's rows on focus and when the tab comes back, at most
 * once every 30s, which is how a switch-off on another device arrives here.
 *
 * The panels (build order 9) reach the runtime through the panel runner slot
 * (lib/mods/ui/panel-run.ts), and the runtime reaches them through the panel
 * store's bridge and onPanelsStale. A change to the planner's items redraws
 * the panels of mods that draw any, a second after it settles and only while
 * a panel shows. Stopping, or another account, empties the panel store.
 */

const REFRESH_EVERY_MS = 30_000;
/** The planner's items settle in bursts (a sync, a drag): one redraw a second after the last. */
const ITEMS_DEBOUNCE_MS = 1000;

const enabledMods = (rows: UserMod[]) => rows.filter((r) => r.kind === 'mod' && r.enabled);

export function ModHost() {
  const router = useRouter();
  const userId = usePlannerStore((s) => s.userId);
  const settled = usePlannerStore(selectPlannerSettled);
  const loadFailed = usePlannerStore((s) => !!s.userId && s.loadFailedUserId === s.userId);
  const modsReady = useModsStore((s) => s.available && s.loaded && s.hydratedUserId === userId);
  const safeMode = useModsStore((s) => s.safeMode);
  const anyOn = useModsStore((s) => s.rows.some((r) => r.kind === 'mod' && r.enabled));

  const ready = !!userId && settled && !loadFailed && modsReady;
  const active = ready && !safeMode && anyOn;
  const push = router.push;

  useEffect(() => {
    if (!ready || !userId) return;
    let last = 0;
    const refresh = () => {
      const t = Date.now();
      if (t - last < REFRESH_EVERY_MS) return;
      last = t;
      void useModsStore.getState().refresh(userId);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ready, userId]);

  useEffect(() => {
    if (!active) return;
    const release = modSandbox.hold();
    const runtime = createModRuntime({
      sandbox: modSandbox,
      env: realBrokerEnv,
      ready: modRuntimeReady,
      userId: () => usePlannerStore.getState().userId,
      rows: () => enabledMods(useModsStore.getState().rows),
      loadCode: (id) => useModsStore.getState().loadModCode(id),
      storeSet: modStoreSet,
      logFault: (u, id, summary) => void logFault(u, id, summary),
      disable: (id, reason) => void useModsStore.getState().disable(id, reason),
      switchedOff: (row) => toast('A mod was switched off', { description: `Your mod: ${modDisplayLabel(row)}` }),
      apply: applyHeld,
      uiDeps: { navigate: (href) => push(href) },
      hidden: () => document.visibilityState === 'hidden',
      // Past the focus throttle: a mod whose row disagrees with the database waits on this.
      refresh: () => {
        if (userId) void useModsStore.getState().refresh(userId);
      },
      panels: panelBridge,
      onPanelsStale: (id, why) => usePanelStore.getState().invalidate(id, why),
      onUserHooksSlowed: (id) => usePanelStore.getState().slowDown(id),
    });
    const unslotActive = setActiveModRuntime(runtime);
    const unsubscribe = subscribeModEvents((e) => runtime.dispatch(e));
    const unsubscribeUndo = subscribeModOnlyEvents((e) => runtime.dispatchUndo(e));
    const unslot = setModCommandRunner((modId, commandId) => runtime.runCommand(modId, commandId));
    const unslotPanels = setModPanelRunner({
      resolvePanel: (modId, panelId) => runtime.resolvePanel(modId, panelId),
      runAction: (modId, panelId, action, arg, atoms, seq) => runtime.runAction(modId, panelId, action, arg, atoms, seq),
      atomChanged: (modId, key, value) => runtime.atomChanged(modId, key, value),
      panelFault: (modId, panelId, message) => runtime.panelFault(modId, panelId, message),
    });

    let rows = useModsStore.getState().rows;
    const unsubscribeRows = useModsStore.subscribe((s) => {
      if (s.rows === rows) return;
      const wasOn = new Set(enabledMods(rows).map((r) => r.id));
      rows = s.rows;
      const isOn = new Set(enabledMods(rows).map((r) => r.id));
      for (const r of enabledMods(rows)) if (!wasOn.has(r.id)) runtime.enabled(r.id);
      for (const id of wasOn) if (!isOn.has(id)) usePanelStore.getState().forgetMod(id);
      runtime.rowsChanged();
    });

    let itemsTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribeItems = usePlannerStore.subscribe((s, prev) => {
      if (s.items === prev.items || !anyPanelVisible()) return;
      if (itemsTimer) clearTimeout(itemsTimer);
      itemsTimer = setTimeout(() => {
        itemsTimer = null;
        if (!anyPanelVisible()) return;
        for (const r of enabledMods(useModsStore.getState().rows)) {
          if (runtime.resolvesPanels(r.id)) usePanelStore.getState().invalidate(r.id, 'items');
        }
      }, ITEMS_DEBOUNCE_MS);
    });

    const onHidden = () => {
      if (document.visibilityState !== 'hidden') return;
      runtime.noteHidden();
      void runtime.flushAll();
    };
    const onPageHide = () => void runtime.flushAll();
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
      if (itemsTimer) clearTimeout(itemsTimer);
      unsubscribeItems();
      unsubscribeRows();
      unslotPanels();
      unslot();
      unsubscribeUndo();
      unsubscribe();
      unslotActive();
      void runtime.stop();
      usePanelStore.getState().reset();
      release();
    };
  }, [active, userId, push]);

  // Another account sees none of this one's trees or atoms, runtime or not.
  useEffect(() => () => usePanelStore.getState().reset(), [userId]);

  return null;
}
