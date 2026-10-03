/**
 * stakes/copy.ts — the words a settled day is reported in.
 *
 * Its own module for the reason lib/reminders/copy.ts is: these sentences are
 * the intervention. The copy contract from that file applies here too and is
 * harder to keep, because this is the surface that reports failure — and a
 * ledger that editorialises is a ledger people stop opening.
 *
 * The rule that follows: STATE THE ARITHMETIC. "Missed: reading. Owed: £10." is
 * a fact the user can check and act on. "You let yourself down again" is the
 * same information plus an insult, and it is the version that gets the
 * extension switched off — which is the one outcome that guarantees the stake
 * never works.
 */

import type { DayOutcome } from './day'

/** Minor units → what a person reads. Falls back sanely on an unknown code. */
export function formatMoney(amountCents: number, currency: string): string {
  const amount = amountCents / 100
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(amount)
  } catch {
    // An unrecognised currency code must not take the whole settlement down.
    return `${amount.toFixed(2)} ${currency}`
  }
}

/** "reading, vitamins and stretching" */
export function nameList(titles: readonly string[]): string {
  if (titles.length === 0) return ''
  if (titles.length === 1) return titles[0]
  return `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`
}

/**
 * What the user is told they owe.
 *
 * Names the charity, because that is the whole mechanism — the money going
 * somewhere you actively dislike is what does the work, and a message that
 * hides it is just a fine.
 */
export function pledgeSummary(
  // Only the titles and the date are read, and the parameter says so: the
  // caller names what it CLAIMED rather than what the day missed, and those
  // differ whenever part of the day was already settled.
  outcome: { dateStr: string; misses: readonly { title: string }[] },
  totalCents: number,
  currency: string,
  charity: string | null,
): { title: string; body: string } {
  const titles = outcome.misses.map((i) => i.title)
  const money = formatMoney(totalCents, currency)
  return {
    title: `${money} owed for ${outcome.dateStr}`,
    body: charity
      ? `${nameList(titles)}, payable to ${charity}.`
      : `${nameList(titles)}.`,
  }
}

/**
 * The digest a partner receives.
 *
 * Written to be read by SOMEONE ELSE, which changes it more than it looks:
 * second person becomes third, and the tone drops any hint of scolding, because
 * the reader is a person who now has to decide how to respond. Handing them a
 * pre-written accusation shapes that badly — the mechanism that works is
 * "someone is expecting me", not "someone is disappointed in me".
 */
export function partnerDigest(outcome: DayOutcome, who: string | null): string {
  const done = outcome.hits.map((i) => i.title)
  const open = outcome.misses.map((i) => i.title)
  const subject = who ? `${who}'s` : 'dsul'
  const lines = [`${subject} ${outcome.dateStr}: ${done.length}/${done.length + open.length} done.`]
  if (done.length > 0) lines.push(`Done: ${nameList(done)}.`)
  if (open.length > 0) lines.push(`Not done: ${nameList(open)}.`)
  if (open.length === 0 && done.length > 0) lines.push('Clean sweep.')
  return lines.join(' ')
}
