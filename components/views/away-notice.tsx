'use client';

import { Palmtree } from 'lucide-react';
import { usePlannerStore } from '@/lib/planner-store';
import { useAwayStore } from '@/lib/away-store';
import { currentAway, easingAway, lastReturnDay, upcomingAway } from '@/lib/away';
import { formatAwayDay, shortAwayDay } from '@/lib/away-dates';
import { awayInputsNow, endVacation, openVacationCard, stillRunning } from '@/lib/away-actions';
import { toDateStr } from '@/lib/recurrence';
import { cn } from '@/lib/utils';

/**
 * Vacation mode's one line, beside the date: "Away until Tue, Oct 20 · 2 still
 * running · I'm back".
 *
 * Like SeasonNotice it is a statement of where things are, never a warning:
 * muted, no count badge, no colour. Unlike it, it shows on every date and in
 * every scope, because a trip is about you rather than about a day. Before a
 * trip it says when it starts; after one, while habits are still easing back,
 * it offers to bring everything back now. The words open the card; the verb
 * at the end does the one thing the line is for.
 */
export function AwayNotice({ className }: { className?: string }) {
  const periods = useAwayStore((s) => s.periods);
  const available = useAwayStore((s) => s.available);
  const items = usePlannerStore((s) => s.items);
  const routines = usePlannerStore((s) => s.routines);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  if (!available || periods.length === 0) return null;

  const todayStr = toDateStr(new Date(), userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const now = currentAway(periods, todayStr);
  const next = now ? undefined : upcomingAway(periods, todayStr);
  const easing = now || next ? undefined : easingAway(periods, todayStr);

  let text: string;
  let verb: { label: string; run: () => void } | undefined;
  let state: 'away' | 'upcoming' | 'easing';
  if (now) {
    const running = stillRunning(now, items, routines);
    text = `${now.endsOn ? `Away until ${formatAwayDay(now.endsOn)}` : 'Away'}${running > 0 ? ` · ${running} still running` : ''}`;
    verb = { label: 'I’m back', run: endVacation };
    state = 'away';
  } else if (next) {
    text = `Vacation from ${formatAwayDay(next.startsOn)}`;
    state = 'upcoming';
  } else if (easing) {
    text = `Welcome back. Habits return a few a day, all back by ${shortAwayDay(lastReturnDay(easing), todayStr)}.`;
    verb = {
      label: 'Bring everything back',
      run: () => useAwayStore.getState().bringEverythingBack(awayInputsNow().todayStr),
    };
    state = 'easing';
  } else {
    return null;
  }

  return (
    <div
      data-testid="away-notice"
      data-away-state={state}
      className={cn('flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground', className)}
    >
      <button
        type="button"
        onClick={() => openVacationCard()}
        className="flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground"
      >
        <Palmtree className="h-3 w-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{text}</span>
      </button>
      {verb && (
        <>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={verb.run}
            className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
            data-testid="away-notice-verb"
          >
            {verb.label}
          </button>
        </>
      )}
    </div>
  );
}
