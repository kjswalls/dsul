'use client';

import { Footprints, Maximize } from 'lucide-react';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { AtlasFilters } from '@/components/views/atlas/atlas-filters';
import { cn } from '@/lib/utils';

/**
 * The header capsule's first row on Atlas, in place of the date nav: the
 * title, the two filters, Fit, Walk, and the zoom. Walk starts Walk Atlas
 * (atlas-walk.tsx) and, while one is on, ends it and takes the camera back.
 */
export function AtlasToolbar() {
  const z = useAtlasUiStore((s) => s.camera.z);
  const requestFit = useAtlasUiStore((s) => s.requestFit);
  const walking = useAtlasUiStore((s) => s.walk !== null);
  const pct = Math.round(z * 100);
  return (
    <div className="flex items-center gap-1 px-1" data-testid="atlas-toolbar">
      <span className="px-1.5 text-base font-semibold text-foreground" data-testid="atlas-title">
        {ATLAS_COPY.name}
      </span>
      <AtlasFilters />
      <div className="mx-1 h-4 w-px bg-border" aria-hidden />
      <button
        type="button"
        onClick={requestFit}
        aria-label={ATLAS_COPY.fitLabel}
        title={ATLAS_COPY.fitLabel}
        data-testid="atlas-fit"
        className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Maximize className="size-3.5" aria-hidden />
        {ATLAS_COPY.fit}
      </button>
      <button
        type="button"
        onClick={() => {
          const ui = useAtlasUiStore.getState();
          if (ui.walk) ui.endWalk(true);
          else ui.startWalk();
        }}
        aria-pressed={walking}
        aria-label={walking ? ATLAS_COPY.walkStopLabel : ATLAS_COPY.walkButtonLabel}
        title={walking ? ATLAS_COPY.walkStopLabel : ATLAS_COPY.walkButtonLabel}
        data-testid="atlas-walk-button"
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors hover:bg-accent hover:text-foreground',
          walking ? 'bg-accent text-foreground' : 'text-muted-foreground'
        )}
      >
        <Footprints className="size-3.5" aria-hidden />
        {ATLAS_COPY.walkButton}
      </button>
      <span
        className="ml-1 min-w-[3ch] text-xs tabular-nums text-muted-foreground"
        aria-label={ATLAS_COPY.zoomLabel(pct)}
        data-testid="atlas-zoom"
      >
        {pct}%
      </span>
    </div>
  );
}
