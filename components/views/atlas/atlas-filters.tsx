'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useViewStore } from '@/lib/view-store';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * Atlas's "Show" menu, at the end of the header pill where Display sits on Day
 * and Week: whether finished and resting cards are drawn. The two settings are
 * the old "Hide finished" and "Hide resting" toggles (view-store, inert,
 * remembered on this device), folded into one menu because they are set once
 * and left. The trigger counts what is hidden, so a hidden card is never a
 * mystery. A hidden card keeps its place and its pin; it only stops being drawn.
 */
export function AtlasShowMenu() {
  const hideFinished = useViewStore((s) => s.atlasHideFinished);
  const hideResting = useViewStore((s) => s.atlasHideResting);
  const setHideFinished = useViewStore((s) => s.setAtlasHideFinished);
  const setHideResting = useViewStore((s) => s.setAtlasHideResting);
  const hidden = (hideFinished ? 1 : 0) + (hideResting ? 1 : 0);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="atlas-show"
          aria-label={ATLAS_COPY.showLabel(hidden)}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors hover:bg-accent hover:text-foreground',
            hidden > 0 ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          <SlidersHorizontal className="h-4 w-4" aria-hidden />
          <span data-narrow-sr="">{ATLAS_COPY.show}</span>
          {hidden > 0 && (
            <span
              data-testid="atlas-show-count"
              aria-hidden
              className="min-w-4 rounded-full bg-accent px-1 text-center text-[11px] leading-4 tabular-nums text-foreground"
            >
              {hidden}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]" data-testid="atlas-show-menu">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {ATLAS_COPY.showHeading}
        </DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={!hideFinished}
          onCheckedChange={(on) => setHideFinished(!on)}
          onSelect={(e) => e.preventDefault()}
          data-testid="atlas-show-finished"
          className="text-sm"
        >
          {ATLAS_COPY.showFinished}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={!hideResting}
          onCheckedChange={(on) => setHideResting(!on)}
          onSelect={(e) => e.preventDefault()}
          data-testid="atlas-show-resting"
          className="text-sm"
        >
          {ATLAS_COPY.showResting}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
