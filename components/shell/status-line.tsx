'use client';

import { format } from 'date-fns';
import { useDayCounts, useMinuteClock } from '@/hooks/use-day-counts';
import { usePlannerStore } from '@/lib/planner-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useStreaksEnabled } from '@/lib/extension-gates';
import { cn } from '@/lib/utils';

/**
 * The `status-line` ornament (lib/layout-themes.ts): one constant-height line
 * across the top of the shell — the selected day, how much of it is open and
 * done, the best streak, the clock, and the braindump pane's switch.
 *
 * It reads; it never acts on the plan. The counts are useDayCounts, which
 * agrees with what is on screen (hooks/use-day-counts.ts).
 * Constant height on purpose: it sits above the header row, and everything
 * there is an input to the schedule grid's fitted hour height (desktop-shell).
 */
export function StatusLine({ className }: { className?: string }) {
  const { open, done } = useDayCounts();
  const selectedDate = usePlannerStore((s) => s.selectedDate);
  const habits = usePlannerStore((s) => s.habits);
  const streaksOn = useStreaksEnabled();
  const paneOpen = useSidebarStore((s) => s.leftSidebarOpen);
  const togglePane = useSidebarStore((s) => s.toggleLeftSidebar);
  const now = useMinuteClock();

  const bestStreak = habits.reduce((max, h) => Math.max(max, h.streak ?? 0), 0);

  return (
    <div
      data-testid="status-line"
      className={cn(
        'flex flex-shrink-0 items-center gap-5 overflow-hidden border-b border-border pr-4 font-mono text-xs whitespace-nowrap text-muted-foreground',
        // In the macOS desktop app this line IS the title bar: it sits in the
        // window's 43px drag band (app/globals.css), so it grows to the band,
        // centres its text on the traffic lights (the 11px it gains goes on top)
        // and starts 14px past the green one, as the sidebar's word does
        // (electron/lib/window-chrome.cjs: 37 - 14 = 23). Everywhere else the
        // env() is undefined and this is h-8 px-4, exactly as before.
        'h-[max(2rem,min(43px,env(titlebar-area-height,0px)))] pt-[max(0px,calc(min(43px,env(titlebar-area-height,0px))_-_2rem))] pl-[max(1rem,calc(env(titlebar-area-x,0px)_-_23px))]',
        className
      )}
    >
      <span className="font-semibold text-foreground">dsul</span>
      <span className="text-success-text">{format(selectedDate, 'EEE dd MMM').toLowerCase()}</span>
      <span data-testid="status-line-counts">
        <span className="text-foreground">{open}</span> open · <span className="text-foreground">{done}</span> done
      </span>
      {streaksOn && bestStreak > 0 && (
        <span>
          streak <span className="text-foreground">{bestStreak}</span>
        </span>
      )}
      <span className="ml-auto tabular-nums">{now ? format(now, 'HH:mm') : '--:--'}</span>
      <button
        type="button"
        data-testid="status-line-braindump"
        aria-pressed={paneOpen}
        onClick={togglePane}
        // titlebar-hole: in the desktop app the band would swallow its clicks.
        className="titlebar-hole rounded-[3px] px-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      >
        :braindump {paneOpen ? '−' : '+'}
      </button>
    </div>
  );
}
