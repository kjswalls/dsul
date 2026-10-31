/**
 * What is left of the end of day review on the web: its hour's parser and its
 * "owed" question, both pure.
 *
 * The review itself is retired (ghost rows phase 2, memory/plans/ghost-rows.md):
 * no modal, no dock line, no push from the server. These two stay because the
 * iPhone app still plans the review's local notification until phase 3, and its
 * Swift port cites them (ios/DsulCore ReminderPlan.swift: `eodMinutesOfDay` is
 * this `minutesOfDay`, and its "owed" rule is `isEodOwed` minus the hour).
 * lib/reminders/plan.ts, the TS original of that port, still imports the parser,
 * and the shared fixtures in tests/fixtures/day/ hold both sides to it. Phase 3
 * deletes this file with the iPhone's review.
 */

export interface EodOwedInput {
  eodReviewEnabled: boolean;
  /** HH:mm, the hour the review is due. */
  eodReviewTime: string;
  /** yyyy-MM-dd of the last completed review, or null if never. */
  lastEodReviewDate: string | null;
}

/** Minutes past local midnight, or null if the stored time is malformed. */
export function minutesOfDay(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Was the review still owed at `nowMinutes` on `todayStr`? On, not already
 * recorded for today, and past its hour. A malformed `eodReviewTime` reads as
 * NOT owed: an unparseable hour is no hour.
 */
export function isEodOwed(
  input: EodOwedInput,
  todayStr: string,
  nowMinutes: number
): boolean {
  if (!input.eodReviewEnabled) return false;
  if (input.lastEodReviewDate === todayStr) return false;
  const due = minutesOfDay(input.eodReviewTime);
  if (due === null) return false;
  return nowMinutes >= due;
}
