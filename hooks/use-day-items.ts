'use client';

import { useMemo } from 'react';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { toDateStr } from '@/lib/recurrence';
import { deriveDayItems, type DayItems } from '@/lib/day-items';
import { inactiveItemIdsOn } from '@/lib/active';
import { useGoalFilterIds } from '@/lib/extension-gates';

/**
 * Store-connected wrapper around deriveDayItems — the single data path for
 * every canvas view.
 *
 * PLURAL is the real hook; `useDayItems` is the one-element case. It reads that
 * way round because of Week × Schedule: it needs all seven columns resolved
 * before it can render any of them (the shared hour range spans the union of
 * every day's items), so it cannot call a per-date hook from a column child the
 * way Week × List and Week × Buckets do. Given only a singular hook, its only
 * option was to inline deriveDayItems itself — which is what it did, as a
 * verbatim copy of this file's body including the inactiveItemIds block and its
 * comment. Two implementations of one pipeline, and the canvas filter work adds
 * a rule to it every phase.
 */
export function useDayItemsForDates(dates: Date[]): DayItems[] {
  const {
    tasks,
    habits,
    projects,
    items,
    routines,
    seasons,
    goals,
    showCompletedTasks,
    showPausedOnGrid,
    userTimezone,
  } = usePlannerStore();
  const typeFilter = useViewStore((s) => s.typeFilter);
  const canvasFilters = useViewStore((s) => s.canvasFilters);

  const timezone = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  /**
   * The goal clause, resolved to item ids ONCE for every column.
   *
   * Membership is dateless — a goal holds the same items on Monday as on
   * Friday — so unlike `inactiveItemIds` below there is nothing per-date to
   * resolve, and a week of columns shares one set. `null` means the clause is
   * inert (nothing selected, nothing selected that is still a live goal, or —
   * since the Goals extension — the whole feature switched off); see
   * lib/goals.ts and lib/extension-gates.ts.
   *
   * THE GATE IS HERE, at the canvas's one data path, rather than in each of the
   * six view mounts. Inert and not empty is what makes switching Goals off
   * safe on a surface that was filtered by one: `passesGoalFilter` reads `null`
   * as "do not narrow", so every row the clause was hiding comes straight back.
   */
  const goalMemberIds = useGoalFilterIds(goals, canvasFilters.goals);

  /**
   * The memo key for `dates`, since a fresh array every render would defeat it.
   *
   * The RESOLVED date strings, which is now exactly the derivation's input:
   * `deriveDayItems` takes a `dateStr` and nothing else that says which day this
   * is. It used to take a `Date` beside it and read `getDay()`/`getDate()` off it
   * — browser-local, while `toDateStr` resolves in `timezone` — so two instants
   * could share a dateStr and disagree on the weekday, and only an exact-instant
   * key was safe. With that gone the mapping is total: same dateStr in, same
   * derivation out, whatever instant produced it.
   *
   * Resolving them is memoized on the INSTANT key — strictly finer than the
   * dateStr key below, so it cannot serve a stale string — because `toDateStr`
   * builds an uncached `Intl.DateTimeFormat` per call (~50µs, against ~0.05µs to
   * read `getTime()`). Week × Buckets mounts 28 cells that each call this, and
   * dnd-kit re-renders every droppable on each collision-target change while the
   * planner deps are untouched. Doing it in the render body cost ~1.3ms on every
   * one of those.
   */
  const instantKey = dates.map((d) => d.getTime()).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dateStrs = useMemo(() => dates.map((d) => toDateStr(d, timezone)), [instantKey, timezone]);
  const dateKey = dateStrs.join(',');

  return useMemo(
    () =>
      dateStrs.map((dateStr) => {
        return deriveDayItems({
          tasks,
          habits,
          projects,
          dateStr,
          timezone,
          typeFilter,
          showCompletedTasks,
          filters: canvasFilters,
          goalMemberIds,
          // Resolved against THIS column's date, not the store's selectedDate: a
          // week view renders seven days at once, and a pause that ends mid-week
          // — or a season's range starting on Wednesday — must show the handoff
          // in the right column rather than blanking or filling all seven.
          //
          // `showPausedOnGrid` drops the exclusion rather than emptying the set: the
          // rows still have to KNOW they are suppressed to render greyed, and they
          // re-ask the resolver at their own rendered date (see task-row.tsx). One
          // shared set threaded through here would be resolved at whichever column
          // built it, which is the wrong-date bug Phases 1 and 3 each shipped once.
          inactiveItemIds: showPausedOnGrid
            ? undefined
            : inactiveItemIdsOn(items, dateStr, {
                userTimezone: timezone,
                routines,
                seasons,
              }),
        });
      }),
    // `dateKey` stands in for `dateStrs` — see the note above it. Listing the
    // array as well would re-derive on every render for the array-literal
    // callers, which is every caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dateKey, tasks, habits, projects, items, routines, seasons, timezone, typeFilter, showCompletedTasks, showPausedOnGrid, canvasFilters, goalMemberIds]
  );
}

/**
 * One day's items. Pass a date (defaults to the selected day) so week views can
 * call it per column.
 */
export function useDayItems(date?: Date): DayItems {
  const selectedDate = usePlannerStore((s) => s.selectedDate);
  // The array literal is rebuilt every render and that is fine — the memo
  // inside keys on the resolved dates, not on this array's identity.
  return useDayItemsForDates([date ?? selectedDate])[0];
}
