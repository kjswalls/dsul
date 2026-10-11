/**
 * away-dates.ts — the words "until tue" and "back on Oct 20", both ways.
 *
 * Vacation mode asks one question, "back on?", in the ⌘K line and in its card.
 * {@link parseBackOn} reads what people type there into the trip's EXCLUSIVE
 * end day (lib/away.ts): "until tue" means you are back, and everything with
 * you, on Tuesday. Pure and string-based like away.ts: callers pass today.
 */

import { addDays } from './away';

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;

const pad = (n: number) => String(n).padStart(2, '0');

/** Day of the week of a yyyy-MM-dd, 0 = Sunday, on Date.UTC so no zone can move it. */
function weekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The next yyyy-MM-dd with this month and day, today or later. */
function nextMonthDay(todayStr: string, month: number, day: number): string | null {
  if (day < 1 || day > 31 || month < 0 || month > 11) return null;
  const year = Number(todayStr.slice(0, 4));
  for (const y of [year, year + 1]) {
    const dt = new Date(Date.UTC(y, month, day));
    if (dt.getUTCMonth() !== month) return null; // Feb 30
    const s = `${y}-${pad(month + 1)}-${pad(day)}`;
    if (s > todayStr) return s;
  }
  return null;
}

/**
 * The day you are back, from what was typed, or null when it can't be read or
 * is not after today.
 *
 * Reads: a weekday ("tue", "next friday"), "tomorrow", a span ("3 days",
 * "2 weeks", "a week"), a month and day ("oct 20", "20 oct", "10/20") or an
 * ISO date. A leading "until", "till", "back" or "on" is ignored.
 */
export function parseBackOn(text: string, todayStr: string): string | null {
  let s = text.trim().toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ');
  s = s.replace(/^(until|till|til|back on|back|on|for)\s+/, '').replace(/^(until|till|on)\s+/, '').trim();
  if (!s) return null;

  const ok = (d: string | null) => (d && d > todayStr ? d : null);

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCMonth() === m - 1 ? ok(s) : null;
  }
  if (s === 'tomorrow' || s === 'tmrw') return addDays(todayStr, 1);

  const span = s.match(/^(a|an|one|\d{1,3})\s*(d|day|days|w|wk|wks|week|weeks)$/);
  if (span) {
    const n = /^\d/.test(span[1]) ? Number(span[1]) : 1;
    const days = span[2].startsWith('w') ? n * 7 : n;
    return days > 0 ? addDays(todayStr, days) : null;
  }

  const wd = s.match(/^(next\s+)?([a-z]+)$/);
  if (wd) {
    const idx = WEEKDAYS.findIndex((w) => wd[2].startsWith(w) && wd[2].length >= 3);
    if (idx !== -1) {
      // The next one after today, a week on when it is today's name. "next
      // tue" reads the same: people say it for the coming one as often as not.
      return addDays(todayStr, (idx - weekdayOf(todayStr) + 7) % 7 || 7);
    }
  }

  const monthIdx = (w: string) => MONTHS.findIndex((m) => w.startsWith(m) && w.length >= 3);
  const md = s.match(/^([a-z]+)\s*(\d{1,2})(st|nd|rd|th)?$/) ?? null;
  if (md && monthIdx(md[1]) !== -1) return ok(nextMonthDay(todayStr, monthIdx(md[1]), Number(md[2])));
  const dm = s.match(/^(\d{1,2})(st|nd|rd|th)?\s*([a-z]+)$/);
  if (dm && monthIdx(dm[3]) !== -1) return ok(nextMonthDay(todayStr, monthIdx(dm[3]), Number(dm[1])));
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (slash) return ok(nextMonthDay(todayStr, Number(slash[1]) - 1, Number(slash[2])));

  return null;
}

/** "Tue, Oct 20". */
export function formatAwayDay(dateStr: string): string {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** "Tue" within the coming week, else "Oct 20": the short form for a line. */
export function shortAwayDay(dateStr: string, todayStr: string): string {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const near = dateStr > todayStr && dateStr <= addDays(todayStr, 6);
  return dt.toLocaleDateString(
    'en-US',
    near ? { weekday: 'short', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' },
  );
}
