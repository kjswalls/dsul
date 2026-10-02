'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * The wall clock, in minutes since midnight, in the user's timezone — or `null`
 * on the server and during hydration.
 *
 * Null-first is not a nicety: reading the clock during render would produce a
 * different number on the server than in the browser, so the now-marker that
 * consumes this would hydrate mismatched. useSyncExternalStore gives that for
 * free — it serves the server snapshot through hydration, then swaps to the live
 * one — and, unlike an effect that seeds state, without a cascading render.
 * Everything downstream treats `null` as "no marker", which is also the right
 * state on a day that isn't today.
 *
 * The subscription re-renders once a minute, aligned to the minute BOUNDARY
 * rather than on a free-running 60s interval, so the marker moves when the clock
 * does instead of drifting up to a minute behind it. One pixel per minute is
 * also the finest thing the grid can show, so there's nothing to gain from
 * ticking faster.
 */
export function useNowMinutes(timezone?: string): number | null {
  const getSnapshot = useCallback(() => nowMinutesIn(timezone), [timezone]);
  return useSyncExternalStore(subscribeToMinute, getSnapshot, getServerSnapshot);
}

/**
 * The wall clock as epoch milliseconds, floored to the minute, or `null` on the
 * server and during hydration. Same tick as useNowMinutes; for a view that
 * sorts by DAY (History's Today / Yesterday / Earlier), which needs the instant
 * and not the time of day. Floored so every read within a minute is the same
 * snapshot, as useSyncExternalStore requires.
 */
export function useNowMinuteMs(): number | null {
  return useSyncExternalStore(subscribeToMinute, getMinuteMs, getServerSnapshot);
}

const getMinuteMs = () => Math.floor(Date.now() / 60_000) * 60_000;

function subscribeToMinute(onChange: () => void) {
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    // +250ms of slack so we land just AFTER the boundary, never just before it
    // (which would re-read the same minute and then wait a full one).
    timer = setTimeout(() => {
      onChange();
      tick();
    }, 60_000 - (Date.now() % 60_000) + 250);
  };
  tick();
  return () => clearTimeout(timer);
}

const getServerSnapshot = () => null;

function nowMinutesIn(timezone?: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}
