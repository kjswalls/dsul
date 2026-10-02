import type { HabitItem, Task } from './planner-types';

/**
 * Braindump MEMBERSHIP: which items belong in the braindump at all, before any
 * Display narrowing.
 *
 * Lifted out of components/sidebar/braindump.tsx (`braindumpRows`, whose `base`
 * this was) so a second reader can ask the same question without importing a
 * `'use client'` component: the iPhone's DsulCore port
 * (ios/DsulCore/Sources/DsulCore/DayItems.swift `braindumpMembers`) is checked
 * against it through tests/fixtures/day/braindump.json. The sidebar still owns
 * the narrowing (`rows`), which reads view-store filters the phone has none of.
 *
 * - Tasks (the task-LIKE projection: custom types in, subtasks out) with no
 *   `isScheduled` and no bucket. `startDate` is not consulted.
 * - Habits with no bucket AND no recurrence, which in practice is never.
 * - Minus `suppressedIds`, which the caller resolves at TODAY, not at the
 *   selected day: the braindump carries no date of its own, so a paused row
 *   must not appear and vanish as the user walks the week (programs-routines.md
 *   decision 3).
 *
 * Tasks come first, then habits, each in the order given.
 */

/**
 * Structurally `RowItem` (components/primitives/task-row.tsx), declared here so
 * this module stays free of component imports.
 */
export type BraindumpMember =
  | { itemType: 'task'; item: Task }
  | { itemType: 'habit'; item: HabitItem };

export function braindumpMembers(
  tasks: readonly Task[],
  habits: readonly HabitItem[],
  suppressedIds: ReadonlySet<string>
): BraindumpMember[] {
  const unscheduledTasks = tasks.filter((task) => {
    if (suppressedIds.has(task.id)) return false;
    if (task.isScheduled || task.timeBucket) return false;
    return true;
  });

  const unscheduledHabits = habits.filter((habit) => {
    if (suppressedIds.has(habit.id)) return false;
    if (habit.timeBucket) return false;
    if (habit.repeatFrequency && habit.repeatFrequency !== 'none') return false;
    return true;
  });

  return [
    ...unscheduledTasks.map((task) => ({ itemType: 'task' as const, item: task })),
    ...unscheduledHabits.map((habit) => ({ itemType: 'habit' as const, item: habit })),
  ];
}
