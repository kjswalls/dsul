'use client';

import { isToday } from 'date-fns';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { SCOPE_OPTIONS } from '@/lib/view-options';
import { cn } from '@/lib/utils';

/**
 * The `page-tabs` ornament (lib/layout-themes.ts): Day / Week as index tabs
 * standing off the right page's edge, the way a planner's sections stick out
 * of the paper. A second door to the scope, never the only one — the masthead
 * keeps the full view controls, so navigation stays pinned.
 */
export function PageTabs({ className }: { className?: string }) {
  const scope = useViewStore((s) => s.scope);
  const setScope = useViewStore((s) => s.setScope);
  return (
    <div
      role="tablist"
      aria-label="Scope"
      aria-orientation="vertical"
      data-testid="page-tabs"
      className={cn('flex flex-col gap-1.5', className)}
    >
      {SCOPE_OPTIONS.map((o) => {
        const on = o.value === scope;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => setScope(o.value)}
            className={cn(
              'rounded-r-[6px] py-2 pr-2.5 pl-2 text-left font-sans text-2xs font-semibold tracking-wide transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              on
                ? 'bg-[var(--nb-ribbon)] text-[var(--nb-ribbon-ink)]'
                : 'bg-[var(--nb-tab)] text-muted-foreground hover:text-foreground'
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The `ribbon` ornament: a bookmark hanging over the page while it shows
 * today, and gone on any other day — where you are, said the way paper says it.
 */
export function Ribbon({ className }: { className?: string }) {
  const selectedDate = usePlannerStore((s) => s.selectedDate);
  if (!isToday(selectedDate)) return null;
  return (
    <span
      aria-hidden
      data-testid="page-ribbon"
      className={cn('pointer-events-none h-16 w-4 bg-[var(--nb-ribbon)]', className)}
      style={{ clipPath: 'polygon(0 0, 100% 0, 100% 100%, 50% 82%, 0 100%)' }}
    />
  );
}
