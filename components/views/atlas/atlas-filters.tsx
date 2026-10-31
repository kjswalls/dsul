'use client';

import type { ReactNode } from 'react';
import { CheckCheck, Moon } from 'lucide-react';
import { useViewStore } from '@/lib/view-store';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { cn } from '@/lib/utils';

/**
 * "Hide finished" and "Hide resting" in the Atlas toolbar. They carry across
 * layouts and are remembered on this device (view-store, inert). A hidden
 * card keeps its place and its pin; it only stops being drawn.
 */
export function AtlasFilters() {
  const hideFinished = useViewStore((s) => s.atlasHideFinished);
  const hideResting = useViewStore((s) => s.atlasHideResting);
  const setHideFinished = useViewStore((s) => s.setAtlasHideFinished);
  const setHideResting = useViewStore((s) => s.setAtlasHideResting);
  return (
    <div className="flex items-center gap-0.5" data-testid="atlas-filters">
      <Toggle
        on={hideFinished}
        onChange={setHideFinished}
        label={ATLAS_COPY.hideFinished}
        testId="atlas-hide-finished"
        icon={<CheckCheck className="size-3.5" aria-hidden />}
      />
      <Toggle
        on={hideResting}
        onChange={setHideResting}
        label={ATLAS_COPY.hideResting}
        testId="atlas-hide-resting"
        icon={<Moon className="size-3.5" aria-hidden />}
      />
    </div>
  );
}

function Toggle({
  on,
  onChange,
  label,
  testId,
  icon,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  testId: string;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      data-testid={testId}
      onClick={() => onChange(!on)}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors',
        on ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      {icon}
      <span data-narrow-sr="">{label}</span>
    </button>
  );
}
