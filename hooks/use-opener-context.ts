'use client';

import { useMemo } from 'react';
import { inactiveItemIdsOn } from '@/lib/active';
import type { OpenerContext } from '@/lib/ai-openers';
import { usePlannerStore } from '@/lib/planner-store';
import { toDateStr } from '@/lib/recurrence';
import { useMinuteClock, useNowMinutes } from '@/lib/use-now-minutes';

/**
 * Today as the openers see it (lib/ai-openers.ts `OpenerContext`), on the
 * minute clock: Ask home's chips and load line, and a new chat's chips, all
 * read the one day, so no two surfaces in the rail disagree about what today
 * holds.
 *
 * `ctx` and `minutesNow` are null until the clock is known (hydration only:
 * Ask mounts behind the AI gate, after it), and a surface shows nothing
 * derived from them until then. `now` is the same clock in epoch ms, for a
 * relative label; `todayStr` the day it falls on in `tz`.
 */
export function useOpenerContext(): {
  ctx: OpenerContext | null;
  minutesNow: number | null;
  now: number | null;
  todayStr: string | null;
  tz: string;
} {
  const items = usePlannerStore((s) => s.items);
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const userTimezone = usePlannerStore((s) => s.userTimezone);

  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const minutesNow = useNowMinutes(tz);
  const now = useMinuteClock();
  const todayStr = now === null ? null : toDateStr(new Date(now), tz);

  const ctx = useMemo<OpenerContext | null>(
    () =>
      todayStr === null
        ? null
        : {
            items,
            todayStr,
            userTimezone: tz,
            inactiveIds: inactiveItemIdsOn(items, todayStr, { userTimezone: tz, routines, seasons }),
          },
    [items, routines, seasons, todayStr, tz]
  );

  return { ctx, minutesNow, now, todayStr, tz };
}
