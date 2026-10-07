/**
 * The sign-in page's headline, picked fresh on each visit from lines that fit
 * the hour and the day. Lowercase and casual, like the rest of the page
 * ("vin sold separately"). Every line has to fit two lines at 27px in the
 * 320px column, so keep new ones short.
 */

/** Shown before the browser has picked a line, and as the fallback. */
export const DEFAULT_LOGIN_HEADLINE = 'what stuff should we do today?';

const ANY_TIME = [DEFAULT_LOGIN_HEADLINE, 'ok, what are we doing?'];

const BY_PART: Record<'morning' | 'afternoon' | 'evening' | 'late', string[]> = {
  morning: ['good morning. what’s the plan?', 'coffee first, then stuff?', 'fresh day. what goes in it?'],
  afternoon: ['afternoon. still time for stuff.', 'what’s left on today’s list?', 'second half of the day. let’s go.'],
  evening: ['evening. tomorrow’s stuff, maybe?', 'wind down, or one more thing?', 'let’s line up tomorrow.'],
  late: ['up late? we can plan that.', 'can’t sleep? tomorrow’s stuff, then.', 'night owl hours. what’s on your mind?'],
};

/** By getDay(): Sunday is 0. */
const BY_DAY: Partial<Record<number, string[]>> = {
  0: ['sunday. light stuff only.'],
  1: ['monday again. what stuff this week?'],
  5: ['friday! what’s left before the weekend?'],
  6: ['weekend stuff counts too.'],
};

function partOfDay(hour: number): keyof typeof BY_PART {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'late';
}

/** Every line that suits this moment, in the reader's local time. */
export function loginHeadlinesFor(now: Date): string[] {
  return [...ANY_TIME, ...BY_PART[partOfDay(now.getHours())], ...(BY_DAY[now.getDay()] ?? [])];
}

/** One of them. `random` is injectable so tests can pin the pick. */
export function pickLoginHeadline(now: Date, random: () => number = Math.random): string {
  const pool = loginHeadlinesFor(now);
  return pool[Math.floor(random() * pool.length)] ?? DEFAULT_LOGIN_HEADLINE;
}
