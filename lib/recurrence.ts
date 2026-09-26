/**
 * shouldShowOnDate — pure recurrence filter
 *
 * @param dateStr Must be a YYYY-MM-DD string resolved to the user's local timezone before calling.
 */
export function shouldShowOnDate(
  item: { repeatFrequency?: string; repeatDays?: number[]; repeatMonthDay?: number },
  dateStr: string, // YYYY-MM-DD, already timezone-resolved by caller
  userTimezone: string
): boolean {
  // Parse as local date to avoid UTC offset shifting
  const d = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = d.getDay();   // 0 = Sun … 6 = Sat
  const dayOfMonth = d.getDate(); // 1–31

  switch (item.repeatFrequency) {
    case 'none':
    case undefined:
    case null:
      return false;
    case 'daily':
      return true;
    case 'weekdays':
      return dayOfWeek >= 1 && dayOfWeek <= 5;
    case 'weekends':
      return dayOfWeek === 0 || dayOfWeek === 6;
    case 'weekly':
      // Legacy — treat same as custom
      return item.repeatDays?.includes(dayOfWeek) ?? false;
    case 'monthly': {
      if (!Number.isFinite(item.repeatMonthDay)) return false;
      const targetDay = item.repeatMonthDay as number;
      const lastDayOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const clampedTarget = Math.min(targetDay, lastDayOfMonth);
      return dayOfMonth === clampedTarget;
    }
    case 'custom':
      return item.repeatDays?.includes(dayOfWeek) ?? false;
    default:
      return false;
  }
}

/**
 * Does a recurring, date-anchored series (a recurring task) fall on `dateStr`?
 *
 * Its own start date always counts, then the repeat decides. Picking a date on
 * a recurring task means "this day": a Thursday task moved to a Friday used to
 * start its series on Friday and show nowhere until the next Thursday, so the
 * move looked like it had lost the task. Writers that set an anchor on their own
 * (a new goal check-in, a habit switched to a task) snap it to a repeat day with
 * `firstRepeatDayFrom`, so this never invents an occurrence nobody picked.
 *
 * Both dates are YYYY-MM-DD in the user's zone.
 */
export function anchoredSeriesOn(
  item: { repeatFrequency?: string; repeatDays?: number[]; repeatMonthDay?: number },
  startDate: string,
  dateStr: string,
  userTimezone: string
): boolean {
  const start = startDate.slice(0, 10);
  if (start > dateStr) return false;
  return start === dateStr || shouldShowOnDate(item, dateStr, userTimezone);
}

/**
 * The first day on or after `fromStr` the repeat falls on, or `fromStr` itself
 * when none does within a year (a rule with no days, which shows nowhere anyway).
 * Walked in date-string space, never through a zone round trip; the rule reads
 * only the calendar day, so no zone is needed.
 */
export function firstRepeatDayFrom(
  item: { repeatFrequency?: string; repeatDays?: number[]; repeatMonthDay?: number },
  fromStr: string
): string {
  const [y, m, d] = fromStr.slice(0, 10).split('-').map(Number);
  for (let offset = 0; offset < 366; offset += 1) {
    const day = new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
    if (shouldShowOnDate(item, day, 'UTC')) return day;
  }
  return fromStr.slice(0, 10);
}

/**
 * Format a Date to a YYYY-MM-DD string in the given IANA timezone.
 */
export function toDateStr(date: Date, userTimezone: string): string {
  return Intl.DateTimeFormat('en-CA', { timeZone: userTimezone }).format(date);
}

/**
 * Returns true if the item was completed on the given date.
 * dateStr must be a YYYY-MM-DD string resolved to the user's local timezone before calling.
 */
export function isCompletedOnDate(
  item: { completedDates?: string[] },
  dateStr: string
): boolean {
  return item.completedDates?.includes(dateStr) ?? false;
}

/**
 * Returns true if the occurrence on the given date was explicitly skipped.
 * The skip twin of isCompletedOnDate — same per-date shape, same rule that
 * scalar `status` is never the truth for a recurring item.
 * dateStr must be a YYYY-MM-DD string resolved to the user's local timezone before calling.
 */
export function isSkippedOnDate(
  item: { skippedDates?: string[] },
  dateStr: string
): boolean {
  return item.skippedDates?.includes(dateStr) ?? false;
}

/**
 * Returns true if the item is a recurring item (has a repeat frequency other than none/undefined).
 */
export function isRecurring(item: { repeatFrequency?: string }): boolean {
  return !!item.repeatFrequency && item.repeatFrequency !== 'none';
}

/**
 * Today's day-of-week index (0 = Sun … 6 = Sat) in the given IANA timezone —
 * the same convention repeatDays / Date.getDay() use. Resolves "today" via
 * toDateStr rather than a raw `new Date().getDay()` so it reflects the user's
 * timezone, not the runtime's.
 */
export function currentDayOfWeek(userTimezone: string): number {
  const dateStr = toDateStr(new Date(), userTimezone);
  return new Date(dateStr + 'T00:00:00').getDay();
}
