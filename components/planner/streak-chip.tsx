'use client';

import { Flame, RotateCcw } from 'lucide-react';
import { PropertyChip } from '@/components/primitives/property-chip';
import { addDaysStr, weekStartOf } from '@/lib/container-schedule';
import { isCompletedOnDate, isSkippedOnDate } from '@/lib/recurrence';
import { usePlannerStore } from '@/lib/planner-store';
import type { HabitItem } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * A habit's streak as one property chip (the item conversations design,
 * round 5): the flame, the count, and this week as seven tiny dots, sitting
 * with the other properties instead of taking a row of its own. Tapping it
 * opens the week at full size, with Reset, which is why Reset is no longer in
 * the panel's ⋯ menu.
 *
 * The count is the habit's stored `streak`, never recounted from its days
 * (CLAUDE.md: the counter is opaque), so the dots show the week and the
 * number shows the streak, and the two may honestly differ.
 */

type DayState = 'done' | 'skipped' | 'today' | 'missed' | 'ahead';

export interface StreakDay {
  date: string;
  /** "M", "T", …, in the week's own order. */
  letter: string;
  state: DayState;
}

const LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** This week's seven days for a habit, from the user's first day of the week. */
export function streakWeek(
  habit: Pick<HabitItem, 'completedDates' | 'skippedDates'>,
  today: string,
  weekStartDay: 'sunday' | 'monday' | 'saturday'
): StreakDay[] {
  const start = weekStartOf(today, weekStartDay);
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDaysStr(start, i);
    const [y, m, d] = date.split('-').map(Number);
    const letter = LETTERS[new Date(y, m - 1, d).getDay()];
    const state: DayState = isCompletedOnDate(habit, date)
      ? 'done'
      : isSkippedOnDate(habit, date)
        ? 'skipped'
        : date === today
          ? 'today'
          : date > today
            ? 'ahead'
            : 'missed';
    return { date, letter, state };
  });
}

export function StreakChip({
  habit,
  today,
  onReset,
}: {
  habit: HabitItem;
  /** yyyy-MM-dd, in the zone the panel reads "today" in. */
  today: string;
  /** Opens the panel's Reset streak confirm. */
  onReset: () => void;
}) {
  const weekStartDay = usePlannerStore((s) => s.weekStartDay);
  const week = streakWeek(habit, today, weekStartDay);
  const count = habit.streak ?? 0;
  const words = `${count} day streak`;

  return (
    <PropertyChip
      label="Streak"
      value={words}
      ariaLabel={words}
      testId="item-streak-chip"
      contentClassName="w-64"
      display={
        <span className="text-warning-text inline-flex items-center gap-1.5 font-semibold">
          <Flame className="size-3.5" aria-hidden />
          {count}
          <span className="flex items-center gap-[3px]" aria-hidden>
            {week.map((day) => (
              <span
                key={day.date}
                data-state={day.state}
                className={cn('box-border size-[5px] rounded-full', dotClass(day.state))}
              />
            ))}
          </span>
        </span>
      }
    >
      {(close) => (
        <div className="flex flex-col gap-3 p-1" data-testid="item-streak-week">
          <p className="text-warning-text flex items-center gap-1.5 text-sm font-semibold">
            <Flame className="size-4" aria-hidden />
            {words}
          </p>
          <ol className="flex justify-between" aria-label="This week">
            {week.map((day) => (
              <li
                key={day.date}
                className="flex flex-col items-center gap-1"
                aria-label={`${day.date}: ${STATE_WORDS[day.state]}`}
              >
                <span
                  data-state={day.state}
                  className={cn('box-border size-[18px] rounded-full', circleClass(day.state))}
                />
                <span className="text-muted-foreground text-[10px]">{day.letter}</span>
              </li>
            ))}
          </ol>
          <button
            type="button"
            data-testid="item-dialog-reset-streak"
            onClick={() => {
              close();
              onReset();
            }}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 self-start text-xs transition-colors"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Reset streak
          </button>
        </div>
      )}
    </PropertyChip>
  );
}

const STATE_WORDS: Record<DayState, string> = {
  done: 'done',
  skipped: 'skipped',
  today: 'today',
  missed: 'not done',
  ahead: 'still to come',
};

/** The row's own dot vocabulary (DayDots): a done day solid, a miss a ring. */
function dotClass(state: DayState): string {
  switch (state) {
    case 'done':
      return 'bg-warning-text';
    case 'skipped':
      return 'border border-dashed border-warning-text';
    case 'today':
      return 'border border-warning-text';
    case 'missed':
      return 'border border-day-off';
    case 'ahead':
      return 'bg-day-off/40';
  }
}

function circleClass(state: DayState): string {
  switch (state) {
    case 'done':
      return 'bg-warning-text';
    case 'skipped':
      return 'border-[1.5px] border-dashed border-warning-text';
    case 'today':
      return 'border-[1.5px] border-warning-text';
    case 'missed':
      return 'border-[1.5px] border-day-off';
    case 'ahead':
      return 'border-[1.5px] border-day-off/40';
  }
}
