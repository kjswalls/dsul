'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { PictureInPicture2 } from 'lucide-react';
import { doneNext, skipNext, useDoStuffStore } from '@/lib/do-stuff';
import { desktopPocket, getDesktopBridge, type DesktopPocket, type PocketState } from '@/lib/desktop';
import { cn } from '@/lib/utils';

/**
 * Pocket (Kirby's pick, 2026-10-16; memory/plans/power-mode.md, the polish
 * round): in the desktop app, the current item in a small window that floats
 * over every app, with done and skip, so it stays in view while the work
 * happens somewhere else. The window is the shell's own (electron/main.cjs
 * "Pocket"); this page stays the only thing that decides what is current and
 * does every write. In a browser none of this renders.
 */

const noopSubscribe = () => () => {};

/**
 * The bridge's pocket, read so the server render and the first client render
 * agree. The snapshot is the bridge itself, which never changes; the pocket's
 * members are bound once per bridge.
 */
function usePocketBridge(): DesktopPocket | null {
  const bridge = useSyncExternalStore(noopSubscribe, getDesktopBridge, () => null);
  return useMemo(() => desktopPocket(bridge), [bridge]);
}

/** What the pocket should show now, or null. */
function pocketState(): PocketState | null {
  const { on, next, doneCount, sprint } = useDoStuffStore.getState();
  if (!on || !next) return null;
  return { id: next.id, title: next.title, done: doneCount, sprint };
}

/**
 * Keeps an open pocket current, and does what its buttons ask. Mounted once,
 * route-level (components/providers/desktop-bridge.tsx).
 */
export function PocketSync() {
  const bridge = usePocketBridge();
  useEffect(() => {
    if (!bridge) return;
    let last = '';
    const publish = () => {
      const state = pocketState();
      const key = JSON.stringify(state);
      if (key === last) return;
      last = key;
      bridge.setPocket(state);
    };
    publish();
    const unsubscribe = useDoStuffStore.subscribe(publish);
    const off = bridge.onPocketAction(({ action, id }) => {
      // Pressed on the item it showed; the walk may have moved on since.
      if (useDoStuffStore.getState().next?.id !== id) return;
      if (action === 'done') doneNext(id);
      else if (action === 'skip') skipNext(id);
    });
    return () => {
      unsubscribe();
      off();
      bridge.setPocket(null);
    };
  }, [bridge]);
  return null;
}

/** "pocket": opens it, in the desktop app only. */
export function PocketButton({ className }: { className?: string }) {
  const bridge = usePocketBridge();
  if (!bridge) return null;
  return (
    <button
      type="button"
      onClick={() => void bridge.openPocket()}
      aria-label="Keep it on top in a pocket"
      title="Keep it on top in a pocket"
      data-testid="do-stuff-pocket"
      className={cn(
        'flex size-7 items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground',
        className
      )}
    >
      <PictureInPicture2 aria-hidden className="size-3.5" />
    </button>
  );
}
