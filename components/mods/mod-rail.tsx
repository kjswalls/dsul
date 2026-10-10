'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useModsStore } from '@/lib/mods-store';
import { useLayoutDef } from '@/lib/look-store';
import { canvasHeaderPad, railHeaderRowOffset } from '@/lib/layout-themes';
import { railHeaderHeld, useRailStore, type ModPanelRef } from '@/lib/rail-store';
import { panelOf } from '@/lib/mods/ui/surface-state';
import { cn } from '@/lib/utils';
import { ModSurface } from './mod-surface';

/** A field that keeps its own Escape: anything typed into. */
function ownsEscape(el: HTMLElement): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    el.isContentEditable
  );
}

const close = () => useRailStore.getState().closeModPanel();

/**
 * A mod's panel in the right column (memory/plans/mods.md, build order 9):
 * rail-store's 'mod' mode, opened only through lib/mods/ui/open-panel.ts.
 * ModSurface draws the host's chrome (the panel's icon, the mod's name, the
 * "Your mod" badge and the panel's label) as the header row, on the date's
 * line as Ask's header is (`railHeaderRowOffset`), with ✕ at its end.
 *
 * MOUNTED UNDER THE ITEM, as Ask is: an item opened over the panel leaves it
 * `hidden` and `inert`, asking for no draws (ModSurface's `active`), so Back
 * finds it as it was, its typed fields included.
 *
 * ESCAPE, while it shows, gives an overlay back (parkOverlay) and does
 * nothing to a docked panel, a resting surface. It yields to anything that
 * consumed the key first, a Radix popper (a mod's Select), focus outside the
 * rail, and a field being typed in.
 *
 * A STALE REF CLOSES. The mod deleted, or its panel gone from a saved
 * manifest: the panel closes. Switched off, it stays and says so (the
 * surface's `off` state) until closed. Watched here rather than in ModHost,
 * whose effects are gone once no mod is on.
 *
 * Focus is never moved into it: the opener keeps focus, and the panel's own
 * controls are a Tab away.
 */
export function ModRail({
  visible,
  leaving = false,
  overlays,
  panelRef,
}: {
  visible: boolean;
  /** Closing out of a docked column: still painted while the column eases shut, and inert. */
  leaving?: boolean;
  overlays: boolean;
  panelRef: ModPanelRef;
}) {
  const { slots } = useLayoutDef();
  const stale = useModsStore((s) => {
    const row = s.rows.find((r) => r.id === panelRef.modId && r.kind === 'mod');
    return !row || !panelOf(row, panelRef.panelId);
  });

  useEffect(() => {
    if (!stale) return;
    const open = useRailStore.getState().modPanel;
    if (open && open.modId === panelRef.modId && open.panelId === panelRef.panelId) close();
  }, [stale, panelRef.modId, panelRef.panelId]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // A mod's Select open inside the panel owns Escape while it is up.
      if (document.querySelector('[data-radix-popper-content-wrapper]')) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body && (!el.closest('[data-rail]') || ownsEscape(el))) return;
      if (overlays) useRailStore.getState().parkOverlay(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, overlays]);

  return (
    <aside
      // Never `data-rail-view`, which means Ask.
      data-mod-rail=""
      aria-label="Your mod's panel"
      hidden={!visible && !leaving}
      inert={!visible}
      className="flex h-full w-[420px] flex-col overflow-hidden outline-none"
    >
      <ModSurface
        panelRef={panelRef}
        presentation="rail"
        active={visible}
        onLeave={close}
        headerClassName={cn(
          // The rail header's own geometry (rail-header.tsx): the canvas
          // header's top padding, then the 32px row on the date's line.
          'titlebar-hole box-content h-8 px-5 py-0 pb-2',
          canvasHeaderPad(slots),
          railHeaderRowOffset(slots)
        )}
        trailing={
          <button
            type="button"
            data-testid="mod-rail-close"
            aria-label="Close"
            title="Close"
            onClick={(e) => {
              // The opener's own click a moment ago lands here at an overlay;
              // a double-click must not close what it just opened.
              if (e.detail > 0 && railHeaderHeld()) return;
              close();
            }}
            className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-md transition-colors"
          >
            <X className="size-4" aria-hidden />
          </button>
        }
      />
    </aside>
  );
}
