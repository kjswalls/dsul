import { expect } from 'vitest';

/**
 * The copy contract (lib/reminders/copy.ts), as something a test can hold
 * copy to: one pattern, and one assertion over every line a person reads.
 *
 * It is the union of what the suites each checked on their own (the cue's
 * streak, the last call, the partner digest), so moving any of them onto it
 * only tightens what they check. The phrases are substrings on purpose:
 * `lose` also catches "close", and a false positive there costs a word chosen
 * differently, which is cheaper than a threat that got through. Both
 * apostrophes, because copy in this repo is typed with either.
 *
 * Plain alternation and one character class, so the same source string means
 * the same thing to whichever regex engine it is handed to.
 */
export const NEVER_SCOLDS = new RegExp(
  [
    // Rule 1: name the behaviour, never the failure.
    "still haven['’]t",
    "you didn['’]t",
    'failed',
    'behind',
    'should have',
    'let .* down',
    'disappoint',
    // Rule 2: state a stake as a fact, never as a threat.
    'lose',
    "don['’]t",
    '!',
  ].join('|'),
  'i',
);

/**
 * Fails on any line of `copy` the contract rules out: the title and the body
 * of a notification, or one string (a digest, a spoken line, a text).
 *
 * A null copy fails too. It is the caller choosing to send nothing, which
 * keeps the contract trivially and proves nothing, so a test that reaches here
 * holding one has lost the copy it meant to check.
 */
export function assertContract(copy: string | { title: string; body: string } | null | undefined): void {
  expect(copy == null, 'no copy to hold to the contract').toBe(false);
  const lines = typeof copy === 'string' ? [copy] : [copy!.title, copy!.body];
  for (const line of lines) expect(line, `"${line}" breaks the copy contract`).not.toMatch(NEVER_SCOLDS);
}
