/**
 * Is tonight's review still owed?
 *
 * Pure, and separate from lib/eod-store.ts on purpose: this is the question the
 * dock asks every render, and it has three inputs that are easy to get subtly
 * wrong (a clock, a saved timezone, and a date string). A predicate that owns a
 * `new Date()` cannot be tested at 21:01 versus 20:59, so the clock arrives as
 * an argument.
 *
 * THE GAP THIS EXISTS TO CLOSE. The review has never had an in-app entry point
 * that appears on its own. lib/eod-link.ts (from AppShell) opens the modal from
 * `?eod=<day>` — a tapped push notification — and lib/commands/registry.ts opens it
 * from the palette. That is the whole list. Turn the review on, deny
 * notification permission or swipe the notification away, and the app will
 * never mention it again: the setting is on, the hour has passed, and nothing
 * on screen says so. The predicate below is what a surface needs in order to.
 */

export interface EodOwedInput {
  eodReviewEnabled: boolean;
  /** HH:mm, the hour the review is due. */
  eodReviewTime: string;
  /** yyyy-MM-dd of the last completed review, or null if never. */
  lastEodReviewDate: string | null;
  /** yyyy-MM-dd the user is deferring, set when they wave the line away. */
  eodDeferredDate?: string | null;
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
 * @param todayStr today in the user's SAVED timezone (`toDateStr`), never the
 *   machine's — the same convention the waiting notice and the sweep use, so
 *   the three cannot disagree about which day it is.
 * @param nowMinutes minutes past midnight, in that same timezone.
 *
 * A malformed `eodReviewTime` reads as NOT owed. The alternative — treating an
 * unparseable hour as midnight — would put a line on the dock all day for a
 * value the user cannot see and did not choose.
 */
export function isEodOwed(
  input: EodOwedInput,
  todayStr: string,
  nowMinutes: number
): boolean {
  if (!input.eodReviewEnabled) return false;
  // Already done today. This is the only thing that RETIRES the line, as
  // opposed to hiding it — see the deferral below.
  if (input.lastEodReviewDate === todayStr) return false;
  const due = minutesOfDay(input.eodReviewTime);
  if (due === null) return false;
  return nowMinutes >= due;
}

/**
 * Owed, and not waved away for today.
 *
 * The split matters: a deferral hides the LINE, it does not settle the review.
 * Anything asking "does the user still owe tonight's review" (a future digest, a
 * streak, the push job) wants `isEodOwed`; only the dock wants this. Same shape
 * as the waiting notice's dismissal, which is deliberate — one gesture, one
 * meaning, on both of the app's unprompted lines.
 */
export function shouldShowEodNotice(
  input: EodOwedInput,
  todayStr: string,
  nowMinutes: number
): boolean {
  if (input.eodDeferredDate === todayStr) return false;
  return isEodOwed(input, todayStr, nowMinutes);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The day a `?eod=` deep link names, or null when it names none.
 *
 * The review's push opens `/?eod=<yyyy-MM-dd>`, the day it invites a review
 * of (lib/reminders/scan.ts). Pushes sent before 2026-10-06 opened `/?eod=1`,
 * and a notification can sit in the shade for a while, so the bare form still
 * opens the review; it just names no day.
 */
export function eodLinkDay(param: string): string | null {
  return DAY.test(param) ? param : null;
}

/** The calendar day before a yyyy-MM-dd, with no timezone in sight. */
function dayBefore(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * Where a night carried past midnight ends: 04:00, the hour lib/ask-home.ts's
 * dayPart starts the morning at. Before it, a review opened from the day
 * before's push is that day's review, finished late; from it on, it is today's.
 */
const NIGHT_ENDS_AT = 4 * 60;

/** When a review opened: the day and the minute, in the user's saved timezone. */
export interface ReviewOpening {
  /** yyyy-MM-dd (`toDateStr`, never the machine's day). */
  day: string;
  /** Minutes past midnight on that day. */
  minutes: number;
}

/**
 * The day a finished review is recorded against (`last_eod_review_date`).
 *
 * The day its invitation was for, when the review was opened from one on that
 * same day, or from the day before's after midnight, in the small hours;
 * otherwise the day it opened on. Never the day Done is pressed, which is what
 * it used to be, and which is wrong exactly when it matters: a 23:30 review's
 * push tapped at 00:15 stamped the NEW day as reviewed, and isEodOwed then
 * retired that evening's invitation before it was sent. The scan asks
 * isEodOwed too, so a night owl lost every other night's push, and the dock
 * its line.
 *
 * The day before is the after-midnight case and nothing wider, because the
 * review always lists the day it opened on. Each day's push has its own tag,
 * so yesterday's can sit in the shade all day: tapped at 20:30, it opens a
 * review of today, and filed under yesterday that review would leave today
 * owed. The scan would invite at 21:00 a review finished half an hour before,
 * and the dock would put its line back up straight after Done. So the day
 * before is taken only when all three hold:
 *
 *   - it opened before NIGHT_ENDS_AT: the night the push was sent, carried on;
 *   - the review hour is not itself inside those small hours. Set to 01:00,
 *     yesterday's push went out at 01:00 yesterday, a whole day before, and
 *     tonight's own (at 01:00, still to come or just sent) is the one this
 *     review answers;
 *   - nothing is recorded for the opening day already. Today reviewed (from
 *     the palette at 00:05, say), a stamp of yesterday would move it back and
 *     owe today again.
 *
 * A notification tapped days later opens a review of today, and recording a
 * day long gone would leave tonight's owed. A day after the opening one is no
 * day anyone was invited to review.
 *
 * @param invitedFor the day the deep link named (eodLinkDay), or null.
 * @param opened when the review opened, held from the opening (not Done).
 * @param settings the review's hour, and the day last recorded as reviewed.
 */
export function reviewedDay(
  invitedFor: string | null,
  opened: ReviewOpening,
  settings: Pick<EodOwedInput, 'eodReviewTime' | 'lastEodReviewDate'>
): string {
  const openedOn = opened.day;
  if (invitedFor === null || !DAY.test(invitedFor)) return openedOn;
  if (invitedFor === openedOn) return invitedFor;
  if (invitedFor !== dayBefore(openedOn)) return openedOn;
  if (opened.minutes >= NIGHT_ENDS_AT) return openedOn;
  const due = minutesOfDay(settings.eodReviewTime);
  if (due !== null && due < NIGHT_ENDS_AT) return openedOn;
  if (settings.lastEodReviewDate === openedOn) return openedOn;
  return invitedFor;
}

/** Minutes past midnight right now, in `timeZone`. */
export function nowMinutesIn(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  // Intl renders midnight as 24 in some ICU versions under hour12:false.
  return (hour % 24) * 60 + minute;
}
