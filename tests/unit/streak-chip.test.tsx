import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StreakChip, streakWeek } from '@/components/planner/streak-chip';
import type { HabitItem } from '@/lib/planner-types';

/**
 * A habit's streak as a property chip (components/planner/streak-chip.tsx):
 * this week's days, and Reset behind the chip instead of in the ⋯ menu.
 */

afterEach(cleanup);

describe('the week', () => {
  // 2026-10-21 is a Wednesday.
  const habit = { completedDates: ['2026-10-19', '2026-10-20'], skippedDates: ['2026-10-18'] };

  it('starts on the first day of the week and reads each day', () => {
    const week = streakWeek(habit, '2026-10-21', 'sunday');
    expect(week.map((d) => d.date)).toEqual([
      '2026-10-18',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
    ]);
    expect(week.map((d) => d.letter).join('')).toBe('SMTWTFS');
    expect(week.map((d) => d.state)).toEqual(['skipped', 'done', 'done', 'today', 'ahead', 'ahead', 'ahead']);
  });

  it('follows a Monday start, and reads a day neither done nor skipped as missed', () => {
    const week = streakWeek({ completedDates: [], skippedDates: [] }, '2026-10-21', 'monday');
    expect(week[0].date).toBe('2026-10-19');
    expect(week.slice(0, 3).map((d) => d.state)).toEqual(['missed', 'missed', 'today']);
  });
});

describe('the chip', () => {
  const HABIT = {
    type: 'habit',
    id: 'h1',
    title: 'Morning walk',
    streak: 12,
    completedDates: ['2026-10-20'],
    skippedDates: [],
  } as unknown as HabitItem;

  it('says the stored streak, and opens the week with Reset', () => {
    const onReset = vi.fn();
    render(<StreakChip habit={HABIT} today="2026-10-21" onReset={onReset} />);
    const chip = screen.getByTestId('item-streak-chip');
    expect(chip).toHaveAccessibleName('12 day streak');
    fireEvent.click(chip);
    expect(screen.getByTestId('item-streak-week')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('item-dialog-reset-streak'));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
