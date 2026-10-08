'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePlannerStore } from '@/lib/planner-store';
import { selectPlannerSettled } from '@/lib/planner-ready';
import { useModsStore } from '@/lib/mods-store';
import { runClock, startRecipeEngine } from '@/lib/recipes/engine';

/**
 * Runs the signed-in person's recipes in this tab (lib/recipes/engine.ts).
 *
 * Route-level, in app/layout.tsx, not AppShell: a tick on /routine/[id]'s Today
 * checklist or on /item/[id] is the user's own action too, and those routes load
 * the items. It switches on only once the planner has settled for this account,
 * so a lean route (/settings) never settles, never starts the engine, and never
 * holds the clock.
 *
 * The clock (a new day, a part of day starting) runs in ONE tab per browser,
 * the holder of the `dsul:recipe-clock` Web Lock. Without Web Locks every tab
 * ticks; the mod_runs claim still keeps a run to once.
 */

const CLOCK_LOCK = 'dsul:recipe-clock';
const CLOCK_EVERY_MS = 60_000;

export function RecipeHost() {
  const router = useRouter();
  const userId = usePlannerStore((s) => s.userId);
  const settled = usePlannerStore(selectPlannerSettled);
  const loadFailed = usePlannerStore((s) => !!s.userId && s.loadFailedUserId === s.userId);
  const modsReady = useModsStore((s) => s.available && s.loaded && s.hydratedUserId === userId);
  const safeMode = useModsStore((s) => s.safeMode);
  const anyOn = useModsStore((s) => s.rows.some((r) => r.kind === 'recipe' && r.enabled));
  const hasClock = useModsStore((s) =>
    s.rows.some((r) => {
      if (r.kind !== 'recipe' || !r.enabled) return false;
      const on = (r.manifest as { trigger?: { on?: unknown } } | null)?.trigger?.on;
      return on === 'day.opened' || on === 'bucket.changed';
    })
  );

  useEffect(() => {
    if (userId && settled && !loadFailed) void useModsStore.getState().hydrate(userId);
  }, [userId, settled, loadFailed]);

  const active = !!userId && settled && !loadFailed && modsReady && !safeMode && anyOn;
  const push = router.push;

  useEffect(() => {
    if (!active) return;
    return startRecipeEngine({ navigate: (href) => push(href) });
  }, [active, push]);

  useEffect(() => {
    if (!active || !hasClock) return;
    const stop = new AbortController();
    const tick = () => void runClock().catch((err) => console.error('[recipes] clock:', err));
    const holdClock = () => {
      tick();
      const timer = setInterval(tick, CLOCK_EVERY_MS);
      const onVisible = () => {
        if (document.visibilityState === 'visible') tick();
      };
      document.addEventListener('visibilitychange', onVisible);
      stop.signal.addEventListener('abort', () => {
        clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisible);
      });
    };

    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (locks?.request) {
      locks
        .request(CLOCK_LOCK, { signal: stop.signal }, () => {
          holdClock();
          // Held until this effect is cleaned up.
          return new Promise<void>((resolve) => stop.signal.addEventListener('abort', () => resolve()));
        })
        .catch(() => {
          // AbortError while still waiting for the lock: nothing to undo.
        });
    } else {
      holdClock();
    }
    return () => stop.abort();
  }, [active, hasClock]);

  return null;
}
