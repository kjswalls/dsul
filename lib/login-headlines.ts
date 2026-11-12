/**
 * The sign-in page's headline, picked fresh on each visit. Lowercase and
 * casual, like the rest of the page ("vin sold separately"): a little
 * encouraging, a little silly, never a guess at what the reader is up to (no
 * time of day, no day of the week). Every line has to fit two lines at 27px in
 * the 320px column, so keep new ones short.
 *
 * The iPhone's sign-in screen picks from the same pool
 * (ios/DsulCore/Sources/DsulCore/LoginHeadlines.swift). Change both together;
 * tests/unit/login-headlines.test.ts fails when they differ.
 */

/** Shown before the browser has picked a line, and as the fallback. */
export const DEFAULT_LOGIN_HEADLINE = 'ok! what are we doing today?';

export const LOGIN_HEADLINES: readonly string[] = [
  DEFAULT_LOGIN_HEADLINE,
  'what stuff should we do today?',
  'one thing at a time. maybe two.',
  'stuff won’t do itself. sadly. unless..?',
  'do some stuff first, then snacks.',
  'a plan is just a list with dreams.',
];

/** One of them. `random` is injectable so tests can pin the pick. */
export function pickLoginHeadline(random: () => number = Math.random): string {
  return LOGIN_HEADLINES[Math.floor(random() * LOGIN_HEADLINES.length)] ?? DEFAULT_LOGIN_HEADLINE;
}
