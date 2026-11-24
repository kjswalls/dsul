'use client';

import type { ReactNode } from 'react';
import { ChevronDown, Footprints, Maximize, Minus, Plus } from 'lucide-react';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { openNewContainer, type NewContainerKind } from '@/lib/ui-store';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * Atlas's controls on the board itself (Kirby's pick A, 2026-11-21), not in the
 * header capsule: the canvas apps' corners.
 *
 * - Bottom middle, the tools: New (a project, goal, routine or season, through
 *   the same "new" dialog the palette opens) and Walk.
 * - Bottom left, the camera: zoom out, the zoom (a click goes to 100%), zoom in,
 *   Fit, and the minimap's pin. Left, not right as in the mock: the canvas's
 *   bottom right is the "?" help bubble (desktop-shell.tsx), and the minimap
 *   already lived bottom left, so it now stands on this cluster.
 *
 * Both stand down while a walk is on: the walk's panel takes the bottom middle
 * and its veil the board, and Escape or Done ends it.
 */

/** Height of a cluster plus its inset, which the minimap stands on. */
export const ATLAS_CONTROLS_RESERVE_PX = 60;

const shell =
  'pointer-events-auto flex items-center gap-0.5 rounded-xl border border-border bg-card p-1 text-card-foreground shadow-[var(--shadow-elev-sm)]';
const key =
  'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const iconKey = cn(key, 'w-8 justify-center px-0 text-muted-foreground');

export function AtlasBoardControls({
  onZoomBy,
  onZoomReset,
  minimap,
  goalsShown,
  collectionsShown,
}: {
  onZoomBy: (factor: number) => void;
  onZoomReset: () => void;
  /** The layout draws a minimap (every layout but By goal). */
  minimap: boolean;
  goalsShown: boolean;
  collectionsShown: boolean;
}) {
  const z = useAtlasUiStore((s) => s.camera.z);
  const walking = useAtlasUiStore((s) => s.walk !== null);
  const pinned = useAtlasUiStore((s) => s.minimapPinned);
  const pct = Math.round(z * 100);
  if (walking) return null;

  const kinds: { kind: NewContainerKind; label: string }[] = [
    { kind: 'project', label: ATLAS_COPY.newProject },
    ...(goalsShown ? [{ kind: 'goal' as const, label: ATLAS_COPY.newGoal }] : []),
    ...(collectionsShown
      ? [
          { kind: 'routine' as const, label: ATLAS_COPY.newRoutine },
          { kind: 'season' as const, label: ATLAS_COPY.newSeason },
        ]
      : []),
  ];

  return (
    <>
      <div
        role="toolbar"
        aria-label={ATLAS_COPY.boardTools}
        data-testid="atlas-tools"
        // Roomier than the zoom cluster's p-1, and deeper below than above:
        // New's lime skirt (2px, 3px lifted) hangs under its face and needs
        // its own room inside the bar, or the key reads as jammed into it.
        // 4 + 28 + 8 (and the border) keeps the bar the zoom cluster's 42px, so the two
        // bottom edges line up.
        className={cn(shell, 'absolute bottom-3 left-1/2 z-20 -translate-x-1/2 gap-1 px-1.5 pt-1 pb-2')}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* The lime keycap: New makes something (#711's keep list). The
                `key key-main` face by hand, not <Button variant="key">, whose
                base carries a disabled:opacity class, and nothing in the
                island may hold one (lime is never faded through an opacity). */}
            <button
              type="button"
              data-testid="atlas-new"
              title={ATLAS_COPY.newLabel}
              className="key key-main inline-flex h-7 items-center gap-1.5 rounded-[calc(var(--radius)*0.5)] px-3 text-[13px] font-semibold text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Plus className="size-4" aria-hidden />
              {ATLAS_COPY.newButton}
              <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" sideOffset={8} className="min-w-[180px]">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {ATLAS_COPY.newHeading}
            </DropdownMenuLabel>
            {kinds.map((k) => (
              <DropdownMenuItem
                key={k.kind}
                data-testid={`atlas-new-${k.kind}`}
                onSelect={() => openNewContainer(k.kind)}
                className="text-sm"
              >
                {k.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={() => useAtlasUiStore.getState().startWalk()}
          aria-label={ATLAS_COPY.walkButtonLabel}
          title={ATLAS_COPY.walkButtonLabel}
          data-testid="atlas-walk-button"
          className={cn(key, 'h-7 text-foreground')}
        >
          <Footprints className="size-4" aria-hidden />
          {ATLAS_COPY.walkButton}
        </button>
      </div>

      <div
        role="toolbar"
        aria-label={ATLAS_COPY.zoomControls}
        data-testid="atlas-zoom-controls"
        className={cn(shell, 'absolute bottom-3 left-3 z-20')}
      >
        <IconKey label={ATLAS_COPY.zoomOut} testId="atlas-zoom-out" onClick={() => onZoomBy(1 / 1.25)}>
          <Minus className="size-4" aria-hidden />
        </IconKey>
        <button
          type="button"
          onClick={onZoomReset}
          aria-label={ATLAS_COPY.zoomLabel(pct)}
          title={ATLAS_COPY.zoomLabel(pct)}
          data-testid="atlas-zoom"
          className={cn(key, 'min-w-12 justify-center px-1 text-xs tabular-nums text-muted-foreground')}
        >
          {pct}%
        </button>
        <IconKey label={ATLAS_COPY.zoomIn} testId="atlas-zoom-in" onClick={() => onZoomBy(1.25)}>
          <Plus className="size-4" aria-hidden />
        </IconKey>
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <IconKey
          label={ATLAS_COPY.fitLabel}
          testId="atlas-fit"
          onClick={() => useAtlasUiStore.getState().requestFit()}
        >
          <Maximize className="size-4" aria-hidden />
        </IconKey>
        {minimap && (
          <IconKey
            label={pinned ? ATLAS_COPY.minimapUnpin : ATLAS_COPY.minimapPin}
            testId="atlas-minimap-pin"
            pressed={pinned}
            onClick={() => useAtlasUiStore.getState().toggleMinimapPinned()}
          >
            <MinimapGlyph />
          </IconKey>
        )}
      </div>
    </>
  );
}

function IconKey({
  label,
  testId,
  onClick,
  pressed,
  children,
}: {
  label: string;
  testId: string;
  onClick: () => void;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      data-testid={testId}
      className={cn(iconKey, pressed && 'bg-accent text-foreground')}
    >
      {children}
    </button>
  );
}

/** A frame with a smaller frame in its corner: the minimap. */
function MinimapGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <rect x="12" y="12" width="6" height="6" rx="1" />
    </svg>
  );
}
