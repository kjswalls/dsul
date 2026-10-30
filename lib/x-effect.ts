/**
 * X effect cards — the pure half of the x-effect extension.
 *
 * A card is 49 days (7 by 7) and gets an X on each day the habit was done. It
 * never resets: a missed day is a blank square, the card runs its 49 days
 * anyway, and the next card starts the day after. So nothing about a card is
 * stored except where the FIRST one began, and even that is derived:
 *
 *   `since` (one date per account, in user_extensions.config) is the day the
 *   extension was first turned on. A habit's first card starts on its first
 *   completion on or after `since`, so every card opens with an X and a habit
 *   ticked from the phone or by an agent starts its card the same way. Card k
 *   then covers start + 49(k-1) … start + 49k - 1.
 *
 * The X's are `completedDates`, the same truth every other surface reads; the
 * stored streak counter is never consulted (it is opaque, CLAUDE.md). Missed
 * days are never counted or named anywhere — the no-guilt rule, the same one
 * Streaks starting off comes from.
 */

import { addDaysStr, daysBetween } from '@/lib/container-schedule';
import { isRecurring, shouldShowOnDate } from '@/lib/recurrence';

export const CARD_DAYS = 49;
/** user_extensions.config key: the yyyy-MM-dd the extension was first turned on. */
export const X_EFFECT_SINCE_KEY = 'since';

/**
 * - `x`: done that day.
 * - `rest`: skipped on purpose (the day-off dash).
 * - `off`: the habit's rule doesn't ask for that day, printed in from the start.
 * - `blank`: a past day it wasn't done. Drawn as plain paper, never marked.
 * - `ahead`: still to come.
 */
export type CardCellState = 'x' | 'rest' | 'off' | 'blank' | 'ahead';

export interface CardCell {
  date: string;
  state: CardCellState;
  today: boolean;
}

export interface XCard {
  /** 1-based. */
  number: number;
  start: string;
  end: string;
  cells: CardCell[];
  xs: number;
  /** How far into the card today is, 1…49; 49 for a card already filed. */
  day: number;
  filed: boolean;
}

export interface XEffectHabit {
  completedDates?: string[];
  skippedDates?: string[];
  repeatFrequency?: string;
  repeatDays?: number[];
  repeatMonthDay?: number;
}

/** The day a habit's first card begins, or null while it has no tick since `since`. */
export function firstCardStart(habit: XEffectHabit, since: string): string | null {
  let first: string | null = null;
  for (const d of habit.completedDates ?? []) {
    if (d >= since && (first === null || d < first)) first = d;
  }
  return first;
}

function buildCard(
  habit: XEffectHabit,
  number: number,
  firstStart: string,
  today: string,
  tz: string
): XCard {
  const start = addDaysStr(firstStart, (number - 1) * CARD_DAYS);
  const end = addDaysStr(start, CARD_DAYS - 1);
  const done = new Set(habit.completedDates ?? []);
  const skipped = new Set(habit.skippedDates ?? []);
  const recurring = isRecurring(habit);
  let xs = 0;
  const cells = Array.from({ length: CARD_DAYS }, (_, i): CardCell => {
    const date = addDaysStr(start, i);
    let state: CardCellState;
    // An X wins over everything: a habit done on a day off still gets its X.
    if (done.has(date)) state = 'x';
    else if (skipped.has(date)) state = 'rest';
    else if (recurring && !shouldShowOnDate(habit, date, tz)) state = 'off';
    else state = date > today ? 'ahead' : 'blank';
    if (state === 'x') xs += 1;
    return { date, state, today: date === today };
  });
  const filed = end < today;
  const day = filed ? CARD_DAYS : daysBetween(start, today) + 1;
  return { number, start, end, cells, xs, day, filed };
}

/**
 * Every card a habit has had, oldest first; the last is the current one. Empty
 * until the habit's first tick since `since`.
 *
 * `completedDates` arrives trimmed to 400 days (the items_windowed view), so a
 * card older than that shows fewer X's than it earned. That's 8 cards back, and
 * callers draw only the recent filed ones.
 */
export function habitCards(
  habit: XEffectHabit,
  since: string,
  today: string,
  tz: string
): XCard[] {
  const first = firstCardStart(habit, since);
  if (!first || first > today) return [];
  const count = Math.floor(daysBetween(first, today) / CARD_DAYS) + 1;
  return Array.from({ length: count }, (_, i) => buildCard(habit, i + 1, first, today, tz));
}

/** The one line a card wears: "Card 2 · day 31 of 49", or "Card 1 · filed". */
export function cardLine(card: XCard): string {
  return card.filed
    ? `Card ${card.number} · filed`
    : `Card ${card.number} · day ${card.day} of ${CARD_DAYS}`;
}

/** "26 X's" — the only count a card shows. */
export function xCount(n: number): string {
  return `${n} X’s`.replace(/^1 X’s$/, '1 X');
}
