'use client';

import { memo } from 'react';
import { ATLAS_COPY } from '@/lib/atlas-copy';

/**
 * The card's "why" line in Momentum, By goal and Timeline: what the app read
 * ("ticked today", "next date Nov 8", "feeds Launch the channel"), never a
 * count of idle days. In Momentum a pinned card says what the app would pick
 * and offers Unpin, which hands it back.
 */
export const AtlasReason = memo(function AtlasReason({
  text,
  pinned,
  name,
  onUnpin,
}: {
  text: string | null | undefined;
  pinned?: boolean;
  name: string;
  onUnpin?: () => void;
}) {
  if (!text && !pinned) return null;
  return (
    <p data-testid="atlas-reason" className="flex items-center gap-2 text-2xs text-muted-foreground">
      {text && <span className="min-w-0 flex-1 truncate">{text}</span>}
      {pinned && onUnpin && (
        <button
          type="button"
          data-testid="atlas-unpin"
          aria-label={ATLAS_COPY.unpinLabel(name)}
          onClick={onUnpin}
          className="ml-auto flex-none rounded-md border border-border px-1.5 py-0.5 text-2xs font-medium text-foreground hover:bg-accent"
        >
          {ATLAS_COPY.unpin}
        </button>
      )}
    </p>
  );
});
