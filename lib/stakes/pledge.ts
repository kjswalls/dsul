/**
 * stakes/pledge.ts — the anti-charity ledger.
 *
 * A miss costs a stated amount, payable to an organisation the user actively
 * dislikes. That specificity is the mechanism: the money going somewhere you
 * would hate to fund is what makes the loss vivid, and a generic fine is a much
 * weaker version of the same idea.
 *
 * DSUL DOES NOT MOVE MONEY, and says so wherever a user can see it. There is
 * no payment rail here and no attempt to look like one — this records what is
 * owed, tells the user, and optionally tells a witness. A commitment device
 * that silently failed to collect would be worse than no device at all, because
 * the user would go on trusting it while it did nothing. Anyone who wants the
 * money to actually move is pointed at the Beeminder extension, which has the
 * rail this deliberately lacks.
 *
 * What it buys, then, is a real ledger and a real witness — which is most of
 * what a deposit contract is, minus the escrow.
 *
 * Config:  amount ("10"), currency ("GBP"), charity, witnessUrl
 * Secrets: none.
 */

import { assertSafeUrl, postToChannel, requireString } from '../reminders/channels/http'
import { sendPushToUser } from '../push-send'
import { formatMoney, pledgeSummary } from './copy'
import type { StakeAdapter, StakeEventDraft } from './types'

export const EXT_PLEDGE = 'pledge'

const DEFAULT_CURRENCY = 'USD'

/** Comfortably inside int4, and far past any honest per-miss stake. */
const MAX_AMOUNT_CENTS = 1_000_000_00

/**
 * "10", "10.50", "£10" → minor units.
 *
 * Parsed to an integer immediately and stored that way. Floats and money is the
 * oldest bug there is, and a ledger that is a penny out is a ledger someone
 * stops believing.
 */
export function parseAmountCents(raw: unknown): number | null {
  let value: number

  if (typeof raw === 'number') {
    value = raw
  } else if (typeof raw === 'string') {
    // A comma is a decimal separator to most of the world. Stripping it as
    // punctuation turns "10,50" into 1050, i.e. a hundredfold overcharge —
    // which is the single worst thing this function could do quietly. Treated
    // as the decimal point when there is no dot; as a thousands separator when
    // there is.
    const trimmed = raw.replace(/[^0-9.,]/g, '')
    const normalised = trimmed.includes('.')
      ? trimmed.replace(/,/g, '')
      : trimmed.replace(',', '.')
    if (!normalised) return null
    value = Number(normalised)
  } else {
    return null
  }

  if (!Number.isFinite(value) || value < 0) return null
  const cents = Math.round(value * 100)
  // stake_events.amount_cents is int4. An out-of-range value does not fail
  // quietly: every adapter's rows go in ONE claim insert, so a fat-fingered
  // amount would wedge that user's whole settlement — the partner digest and
  // the Beeminder datapoints included — on every tick, forever.
  if (cents > MAX_AMOUNT_CENTS) return null
  return cents
}

export const pledgeAdapter: StakeAdapter = {
  slug: EXT_PLEDGE,
  extensionSlug: EXT_PLEDGE,

  plan(outcome, ctx) {
    const amountCents = parseAmountCents(ctx.config.amount)
    if (amountCents === null || amountCents === 0) return []
    const currency = requireString(ctx.config, 'currency') ?? DEFAULT_CURRENCY
    const charity = requireString(ctx.config, 'charity')

    return outcome.misses.map<StakeEventDraft>((item) => ({
      subject: item.id,
      subjectTitle: item.title,
      kind: 'miss',
      amountCents,
      currency,
      detail: charity ?? undefined,
    }))
  },

  async commit(claimed, outcome, ctx) {
    // Empty means the day was already settled — say nothing. A second "you owe
    // £10" for a debt already recorded is how a ledger loses its authority.
    if (claimed.length === 0) return { ok: true, skipped: true, detail: 'nothing new' }

    const currency = claimed[0].currency ?? DEFAULT_CURRENCY
    const totalCents = claimed.reduce((sum, event) => sum + (event.amountCents ?? 0), 0)
    const charity = claimed[0].detail ?? null
    // Named from CLAIMED, not from outcome.misses. They differ whenever part of
    // the day was already settled — and a message whose total is computed from
    // one list and whose habit names come from the other contradicts both
    // itself and the ledger it is reporting.
    const copy = pledgeSummary(
      { ...outcome, misses: claimed.map((event) => ({ title: event.subjectTitle })) },
      totalCents,
      currency,
      charity,
    )

    const problems: string[] = []

    try {
      await sendPushToUser(ctx.service, ctx.userId, {
        title: copy.title,
        body: copy.body,
        // The ledger, not the planner. This notification asserts a number, and
        // the claim the pledge tier makes for itself is that the number is
        // backed by rows you can read — so the tap has to land on them.
        url: '/ledger',
        tag: `dsul-pledge-${outcome.dateStr}`,
      })
    } catch (err) {
      problems.push(`push: ${err instanceof Error ? err.message : String(err)}`)
    }

    // The witness. Optional, and the reason the whole thing is more than a
    // number in an app: a debt only one person knows about is a debt that
    // quietly stops being paid.
    const witnessUrl = requireString(ctx.config, 'witnessUrl')
    if (witnessUrl) {
      try {
        const text = `${copy.title}: ${copy.body}`
        await postToChannel(assertSafeUrl(witnessUrl), {
          // `text` for Slack, `content` for Discord. Sending both means one
          // pasted webhook URL works with either without the user being asked
          // to know which shape their chat app wants.
          body: JSON.stringify({ text, content: text }),
        })
      } catch (err) {
        problems.push(`witness: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const owed = formatMoney(totalCents, currency)
    if (problems.length > 0) return { ok: false, detail: `${owed} recorded; ${problems.join('; ')}` }
    return { ok: true, detail: `${owed} recorded across ${claimed.length} miss(es)` }
  },
}
