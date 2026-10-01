'use client';

import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { useDayItems } from '@/hooks/use-day-items';
import { usePlannerStore } from '@/lib/planner-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useStreaksEnabled } from '@/lib/extension-gates';
import { flattenDayRows } from '@/lib/day-items';
import { isRowCompletedOn } from '@/lib/sort-rows';
import { isRecurring, isSkippedOnDate, toDateStr } from '@/lib/recurrence';
import { cn } from '@/lib/utils';

/**
 * Skipped for the day, or cancelled: on the list, but neither open nor done.
 * Per-date for a recurring item, `status` for a one-off — never `status` for a
 * recurring one (CLAUDE.md: completedDates, not scalar status).
 */
function isSetAside(item: { repeatFrequency?: string; skippedDates?: string[]; status?: string }, dateStr: string): boolean {
  if (isRecurring(item)) return isSkippedOnDate(item, dateStr);
  return item.status === 'skipped' || item.status === 'cancelled';
}

/** The wall clock, to the minute, re-aimed at each minute's edge. */
function useMinuteClock(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    let timer: number;
    const tick = () => {
      const d = new Date();
      setNow(d);
      timer = window.setTimeout(tick, 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 50);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, []);
  return now;
}

/**
 * The `status-line` ornament (lib/layout-themes.ts): one constant-height line
 * across the top of the shell — the selected day, how much of it is open and
 * done, the best streak, the clock, and the braindump pane's switch.
 *
 * It reads; it never acts on the plan. The counts come from the same
 * useDayItems the views draw from, so they agree with what is on screen
 * (filters, paused items hidden) rather than re-deriving "what is on today".
 * Constant height on purpose: it sits above the header row, and everything
 * there is an input to the schedule grid's fitted hour height (desktop-shell).
 */
export function StatusLine({ className }: { className?: string }) {
  const day = useDayItems();
  const selectedDate = usePlannerStore((s) => s.selectedDate);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const habits = usePlannerStore((s) => s.habits);
  const streaksOn = useStreaksEnabled();
  const paneOpen = useSidebarStore((s) => s.leftSidebarOpen);
  const togglePane = useSidebarStore((s) => s.toggleLeftSidebar);
  const now = useMinuteClock();

  const { open, done } = useMemo(() => {
    const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dateStr = toDateStr(selectedDate, tz);
    let openCount = 0;
    let doneCount = 0;
    for (const row of flattenDayRows(day)) {
      if (isRowCompletedOn(row, dateStr)) doneCount++;
      else if (!isSetAside(row.item, dateStr)) openCount++;
    }
    return { open: openCount, done: doneCount };
  }, [day, selectedDate, userTimezone]);

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
