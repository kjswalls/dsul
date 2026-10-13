'use client';

import { Check, Plus } from 'lucide-react';
import { doneNext, skipNext, useDoStuffStore } from '@/lib/do-stuff';
import { openFirstSteps, useCanFirstSteps } from '@/components/sidebar/first-steps';
import { cn } from '@/lib/utils';

/** How many arriving rows the card names before it counts the rest. */
const ARRIVING_SHOWN = 2;

/**
 * The up-next card on today (Kirby's pick, 2026-10-13: one do stuff, not a
 * split). While doing stuff, do it now's next row sits in the canvas header
 * beside the date, with Done and Skip, and the braindump rows coming onto
 * today follow it as ghost "+" chips: what make it so will put on the day.
 *
 * It lives in the header row, not on the grid, because the row's height is
 * max(children) and the capsule already sets it: nothing here may grow it
 * (components/shell/desktop-shell.tsx has the rule). The plan publishes what
 * it shows (components/sidebar/do-stuff.tsx); nothing at rest.
 */
export function DoStuffToday({ className }: { className?: string }) {
  const on = useDoStuffStore((s) => s.on);
  const next = useDoStuffStore((s) => s.next);
  const arriving = useDoStuffStore((s) => s.arriving);
  const steps = useCanFirstSteps(next?.id);
  if (!on || (!next && arriving.length === 0)) return null;
  const shown = arriving.filter((a) => a.id !== next?.id);
  const rest = shown.length - ARRIVING_SHOWN;
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)} data-testid="do-stuff-today">
      {next && (
        <div
          className="flex h-8 min-w-0 items-center gap-2 rounded-[9px] border border-border bg-surface-2 pr-1 pl-3 text-[13px]"
          data-testid="do-stuff-up-next"
        >
          <span className="shrink-0 text-[11.5px] text-muted-foreground">up next</span>
          <span className="min-w-0 truncate font-medium">{next.title}</span>
          <button
            type="button"
            onClick={() => doneNext(next.id)}
            aria-label={`Done: ${next.title}`}
            data-testid="do-stuff-up-next-done"
            className="flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-2 text-xs font-medium hover:bg-accent"
          >
            <Check aria-hidden className="size-3" />
            done
          </button>
          <button
            type="button"
            onClick={() => skipNext(next.id)}
            data-testid="do-stuff-up-next-skip"
            className="h-6 shrink-0 rounded-[6px] px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            skip
          </button>
          {steps && (
            <button
              type="button"
              onClick={() => openFirstSteps(next.id)}
              data-testid="do-stuff-up-next-first-steps"
              className="h-6 shrink-0 rounded-[6px] px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              first steps
            </button>
          )}
        </div>
      )}
      {shown.slice(0, ARRIVING_SHOWN).map((a) => (
        <span
          key={a.id}
          className="flex h-8 min-w-0 max-w-[180px] items-center gap-1 rounded-[9px] border border-dashed border-border px-2.5 text-[12.5px] text-muted-foreground"
          data-testid="do-stuff-arriving"
          title={`${a.title}: onto today when you make it so`}
        >
          <Plus aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{a.title}</span>
        </span>
      ))}
      {rest > 0 && (
        <span className="shrink-0 text-[12px] text-muted-foreground" data-testid="do-stuff-arriving-more">
          +{rest} more
        </span>
      )}
    </div>
  );
}
