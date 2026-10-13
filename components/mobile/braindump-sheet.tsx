'use client';

import { useEffect } from 'react';
import { useSwipeable } from 'react-swipeable';

import { Braindump } from '@/components/sidebar/braindump';
import { SectionBoundary } from '@/components/primitives/section-boundary';
import { useDragStore } from '@/lib/drag-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { cn } from '@/lib/utils';

/**
 * The braindump, as a sheet over Today (mobile web round 3, the iPhone app's
 * braindump sheet). Opened by the capture bar's count, `goto.braindump` and
 * the onboarding tour (lib/mobile-nav-store.ts `showMobileSurface`); closed
 * by its handle, a swipe down on its top edge, Escape, the count again, or
 * any tab change.
 *
 * It sits in the content area, over the view and above the dock, so the
 * capture bar, its count and the tabs stay in reach while it is open.
 *
 * No scrim: the schedule above stays live, because the point of the sheet is
 * dragging a thought onto an hour. While a drag is under way the sheet drops
 * to a peek, so the whole day is a drop target, and comes back when it ends.
 *
 * It holds the real `<Braindump variant="mobile" />`, header capsule, Display
 * menu and shelf included, so nothing the braindump tab could do is lost.
 */
function closeBraindump(): void {
  useMobileNavStore.getState().setBraindumpOpen(false);
}

export function BraindumpSheet() {
  const open = useMobileNavStore((s) => s.braindumpOpen);
  const dragging = useDragStore((s) => s.activeId !== null);

  // Escape closes it, unless something on top of it (a menu, a dialog) took
  // the key first.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) closeBraindump();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const swipe = useSwipeable({
    onSwipedDown: closeBraindump,
    trackMouse: false,
    delta: 40,
    preventScrollOnSwipe: true,
  });

  if (!open) return null;

  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-label="Braindump"
      data-testid="braindump-sheet"
      data-peek={dragging ? 'true' : 'false'}
      className={cn(
        'absolute inset-x-0 bottom-0 z-20 flex h-[78%] flex-col rounded-t-[22px] bg-[var(--paper-3)]',
        'shadow-[0_-6px_30px_rgb(0_0_0/18%)] dark:shadow-[0_-6px_30px_rgb(0_0_0/45%)]',
        'animate-in slide-in-from-bottom duration-200',
        'transition-transform duration-200 ease-[var(--ease-out-soft)]',
        // A peek of the header while an item is dragged out of it.
        dragging && 'translate-y-[calc(100%-88px)]'
      )}
    >
      <div {...swipe} className="flex-none touch-none pt-2 pb-1">
        <button
          type="button"
          onClick={closeBraindump}
          aria-label="Close braindump"
          data-testid="braindump-sheet-close"
          className="mx-auto flex h-5 w-16 items-center justify-center"
        >
          <span aria-hidden className="h-[5px] w-10 rounded-full bg-muted-foreground/40" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <SectionBoundary label="braindump">
          <Braindump variant="mobile" />
        </SectionBoundary>
      </div>
    </section>
  );
}
