'use client';

import { useMemo } from 'react';
import { Puzzle } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { useModsStore } from '@/lib/mods-store';
import { modSurfaceLabel } from '@/lib/mods/labels';
import { openablePanelsOf } from '@/lib/mods/ui/card';
import { openModPanel } from '@/lib/mods/ui/open-panel';
import { holdRailHeader, usePanelOverlays, useRailMode } from '@/lib/rail-store';
import { useCanvasWide, useViewStore } from '@/lib/view-store';
import { useLayoutDef } from '@/lib/look-store';
import { railHeaderRowOffset } from '@/lib/layout-themes';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

const LABEL = 'Your mod panels';

/**
 * The key to a mod's panels (memory/plans/mods.md, build order 9) on the
 * canvas's header row, just after the Ask button (desktop-shell.tsx). A fixed
 * 32px key with the host's mod glyph, on the date's line
 * (`railHeaderRowOffset`), so the rail's header row opens where it was.
 *
 * With one panel across the switched-on mods it opens that panel; with more,
 * a menu of them, each named by the host ("Your mod · Water: Water"). Both go
 * through the one router (lib/mods/ui/open-panel.ts).
 *
 * It takes the row's far end (`ml-auto`) itself only when the Ask button is
 * not offered; otherwise the Ask button holds it (or WeekScale in the week
 * views) and this sits just past it. AskOpener's fit counts it as one more
 * fixed sibling, so it never makes the Ask button's ladder flap.
 *
 * Nothing on the phone, in safe mode, or with no switched-on mod declaring a
 * panel. `hidden`, not gone, while the column shows or in Zen, as the Ask
 * button is: closing a panel hands focus back here (rail-store
 * `closeModPanel`), and it needs a node to land on. A click focuses it first
 * (Safari leaves a clicked button unfocused), and a pointer's click holds the
 * rail's header against a double-click's second click (`holdRailHeader`).
 */
export function ModOpener() {
  const rows = useModsStore((s) => s.rows);
  const safeMode = useModsStore((s) => s.safeMode);
  const { canChat, askInvite, askFix } = useAICapabilities();
  const isMobile = useIsMobile();
  const zen = useViewStore((s) => s.zenOpen);
  const canvasWide = useCanvasWide();
  const columnShown = useRailMode(usePanelOverlays()) !== 'hidden';
  const { slots } = useLayoutDef();
  const panels = useMemo(() => (safeMode ? [] : openablePanelsOf(rows)), [rows, safeMode]);

  if (isMobile || safeMode || panels.length === 0) return null;

  const hidden = columnShown || zen;
  const askOffered = canChat || askInvite || askFix;
  const keyClass = cn(
    'titlebar-hole text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[10px] outline-none transition-colors focus-visible:ring-2',
    railHeaderRowOffset(slots),
    !canvasWide && !askOffered && 'ml-auto'
  );
  const glyph = <Puzzle className="size-4" aria-hidden />;

  if (panels.length === 1) {
    const only = panels[0];
    return (
      <button
        type="button"
        data-mod-opener=""
        data-testid="mod-opener"
        hidden={hidden}
        aria-label={LABEL}
        title={LABEL}
        className={keyClass}
        onClick={(e) => {
          if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
          if (e.detail > 0) holdRailHeader(e.currentTarget);
          openModPanel({ modId: only.modId, panelId: only.panelId });
        }}
      >
        {glyph}
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-mod-opener=""
          data-testid="mod-opener"
          hidden={hidden}
          aria-label={LABEL}
          title={LABEL}
          className={keyClass}
        >
          {glyph}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="mod-opener-menu" className="titlebar-hole max-w-[320px]">
        {panels.map((p) => (
          <DropdownMenuItem
            key={`${p.modId}:${p.panelId}`}
            onSelect={() => openModPanel({ modId: p.modId, panelId: p.panelId })}
          >
            <Puzzle aria-hidden />
            <span className="min-w-0 truncate">
              Your mod · {modSurfaceLabel(p.row)}: {p.panel.label}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
