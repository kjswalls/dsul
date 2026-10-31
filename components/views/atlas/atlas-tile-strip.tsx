'use client';

import type { AtlasCard } from '@/lib/atlas-model';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { cn } from '@/lib/utils';

/**
 * One 7px square per member, in the three states lib/atlas-model.ts
 * `memberStateOn` gives: lit in the container's colour, open as a well with a
 * faint ring, quiet as a hollow ring (not counted). No opacity anywhere: the
 * accent never dims (design D8). The "3 of 7" count is the card's footer.
 */
export function AtlasTileStrip({ card }: { card: AtlasCard }) {
  if (card.tiles.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-[3px]" data-testid="atlas-tiles">
      {card.tiles.map((state, i) => (
        <i
          key={i}
          data-tile={state}
          className={cn(
            'size-[7px] rounded-[2px]',
            state === 'open' && 'bg-surface-3 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--muted-foreground)_40%,transparent)]',
            state === 'quiet' && 'shadow-[inset_0_0_0_1px_var(--border)]'
          )}
          style={state === 'lit' ? { background: card.color } : undefined}
        />
      ))}
      {card.moreTiles > 0 && (
        <span className="ml-1 rounded-full bg-surface-3 px-1.5 text-2xs text-muted-foreground" data-testid="atlas-tiles-more">
          {ATLAS_COPY.moreTiles(card.moreTiles)}
        </span>
      )}
    </div>
  );
}
