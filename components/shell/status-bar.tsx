'use client';

import { format } from 'date-fns';
import { useDayCounts, useMinuteClock } from '@/hooks/use-day-counts';
import { useViewStore } from '@/lib/view-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useLayoutDef } from '@/lib/look-store';
import { cn } from '@/lib/utils';

/**
 * The `status-bar` ornament (lib/layout-themes.ts): a text editor's status bar
 * along the foot of the window, counting the day the way an editor counts
 * lines. It reads and never acts. Same counts as the status-line, from
 * useDayCounts, so they agree with what is on screen.
 *
 * Constant height, like the status-line: it sits under the canvas, which the
 * schedule grid fits its hour height to (lib/use-fit-hour-px.ts).
 */
export function StatusBar({ className }: { className?: string }) {
  // The week's counts while the canvas shows a week, beside the word Week.
  const { open, done } = useDayCounts({ followScope: true });
  const scope = useViewStore((s) => s.scope);
  // The kind of file the tabs name the days as, when they name one.
  const tabs = useLayoutDef().slots.tabs;
  const kind = tabs === 'md' ? 'markdown' : tabs === 'txt' ? 'plain text' : null;
  const now = useMinuteClock();
  const timeFormat = usePlannerStore((s) => s.timeFormat);
  const items = open + done;

  return (
    <div
      data-testid="status-bar"
      className={cn(
        'flex h-7 flex-shrink-0 items-center gap-5 overflow-hidden border-t border-border px-[18px] font-mono text-[11.5px] whitespace-nowrap text-muted-foreground',
        className
      )}
    >
      <span data-testid="status-bar-counts" data-status-cell="">
        <b className="font-medium text-foreground">{items}</b> {items === 1 ? 'item' : 'items'} ·{' '}
        <b className="font-medium text-foreground">{done}</b> done
      </span>
      <span className="flex-1" />
      <span data-status-cell="">{scope === 'week' ? 'Week' : 'Day'}</span>
      {kind && <span data-status-cell="">{kind}</span>}
      <span data-status-cell="" className="tabular-nums">
        {now ? format(now, timeFormat === '24h' ? 'HH:mm' : 'h:mm a') : '--:--'}
      </span>
    </div>
  );
}
