'use client';

import { Maximize } from 'lucide-react';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { AtlasFilters } from '@/components/views/atlas/atlas-filters';

/**
 * The header capsule's first row on Atlas, in place of the date nav: the
 * title, the two filters, Fit, and the zoom. PR4 adds Walk.
 */
export function AtlasToolbar() {
  const z = useAtlasUiStore((s) => s.camera.z);
  const requestFit = useAtlasUiStore((s) => s.requestFit);
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
