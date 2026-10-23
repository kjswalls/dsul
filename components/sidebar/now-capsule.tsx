'use client';

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Done and skip for the item Do stuff is on, in the console's Segmented recipe
 * (components/planner/organize/primitives.tsx) at card scale: a surface-3 well,
 * done the raised surface-2 pill. Kirby's pick, 2026-10-23 (B1b,
 * do-stuff-design/focus-card/). The 4px padding is the Segmented's own reason:
 * --shadow-elev-sm drops 4px, and any less clips it on the well's corner.
 *
 * In Organize the raised pill means "selected"; here it means "the main
 * action", which the tick carries. Used by the lane's card (do-stuff.tsx) and
 * the schedule slot (do-stuff-slot.tsx), so done looks one way in both.
 */
export function NowCapsule({
  title,
  onDone,
  onSkip,
  testIds,
  className,
}: {
  title: string;
  onDone: () => void;
  onSkip: () => void;
  testIds: { done: string; skip: string };
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={`Now: ${title}`}
      className={cn('inline-flex h-[30px] shrink-0 items-center rounded-[10px] bg-surface-3 p-1', className)}
    >
      <button
        type="button"
        onClick={onDone}
        aria-label={`Done: ${title}`}
        aria-keyshortcuts="Enter"
        data-testid={testIds.done}
        className="flex h-[22px] items-center gap-1 rounded-[7px] bg-surface-2 px-2.5 text-[12.5px] font-medium text-foreground shadow-[var(--shadow-elev-sm)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Check aria-hidden strokeWidth={2.75} className="size-3 text-success-text" />
        done
      </button>
      <button
        type="button"
        onClick={onSkip}
        aria-keyshortcuts="S"
        data-testid={testIds.skip}
        className="h-[22px] rounded-[7px] px-2.5 text-[12.5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        skip
      </button>
    </div>
  );
}
