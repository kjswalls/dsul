/**
 * stakes/beeminder.ts — put the day on a graph that costs money to break.
 *
 * The best evidence-to-effort ratio of anything in Tier 3, and the reason is
 * that dsul is not trying to be the commitment device here — Beeminder
 * already is one, with a payment rail, a derailment ladder and years of
 * behaviour behind it. This posts the datapoint and gets out of the way.
 *
 * TIMING. Datapoints go up TWICE over, and that is the design rather than an
 * oversight:
 *
 *   - **On completion**, the moment the box is ticked (lib/stakes/live.ts).
 *     This is the one that matters. A Beeminder goal's deadline defaults to
 *     midnight and the settlement defaults to 03:00, so a settle-only datapoint
 *     arrives three hours after the goal has already decided you missed it —
 *     with the right `daystamp`, so the graph ends up correct, and after a
 *     derailment that does not un-happen on its own.
 *   - **At settle time**, as the backstop. Not every completion goes through a
 *     browser: the lock-screen action, the agent API and an offline tick all
 *     reach the database by other routes, and a goal that silently derails
 *     because one of them did not phone home is the exact failure this feature
 *     exists to prevent.
 *
 * Both write the SAME ledger row (`stake_events`, unique on user+date+subject+
 * channel), so whichever gets there first claims it and the other finds it
 * committed and does nothing. One datapoint per habit per day, from two paths
 * that never coordinate.
 *
 * Datapoints are posted for HITS only. That is not an omission: a do-more goal
 * derails on the ABSENCE of data, which is exactly the mechanism, and posting a
 * zero would actively defeat it by satisfying the goal's rate with nothing.
 *
 * A completion that is later UN-ticked withdraws its datapoint (the ledger row
 * carries the datapoint id for exactly that) and drops the ledger row, so the
 * graph never claims a day the app does not. See retractDatapoint below.
 *
 * Config:  username, goals ("Vitamins: vitamins, Reading: read")
 * Secrets: authToken
 */

import { postToChannel, requireString } from '../reminders/channels/http'
import type { StakeAdapter, StakeEventDraft } from './types'
import { goalForTitle } from './goal-map'

// Moved to a pure module so the browser (recipes' stake lock) can read the map
// without importing server delivery code. Re-exported for existing callers.
export { parseGoalMap, goalForTitle } from './goal-map'

export const EXT_BEEMINDER = 'beeminder'

const BEEMINDER_API = 'https://www.beeminder.com/api/v1'

/**
 * The ledger's `detail` for a Beeminder row: the goal slug, and — once the
 * datapoint exists — its id, appended after a '#'.
 *
 * Encoded into the existing column rather than given one of its own, which is a
 * deliberate trade. A new column means a migration, and the id is only ever read
 * back by the code that wrote it, for one purpose: withdrawing the datapoint if
 * the completion is un-ticked. '#' is safe as the separator because a Beeminder
 * goal slug is `[a-zA-Z0-9_-]+` and cannot contain one, and decoding splits on
 * the LAST '#' so a slug that somehow did would still yield the right goal.
 *
 * A row written before this existed (goal only) decodes to a null id, which the
 * retraction reads as "nothing to withdraw" — the honest answer.
 */
export function encodeDetail(goal: string, datapointId?: string | null): string {
  return datapointId ? `${goal}#${datapointId}` : goal
}

export function decodeDetail(detail: string | null | undefined): {
  goal: string | null
  datapointId: string | null
} {
  if (!detail) return { goal: null, datapointId: null }
  const at = detail.lastIndexOf('#')
  if (at === -1) return { goal: detail, datapointId: null }
  const goal = detail.slice(0, at)
  const id = detail.slice(at + 1)
  return { goal: goal || null, datapointId: id || null }
}

export interface BeeminderCredentials {
  username: string
  authToken: string
}

/** Pull the credentials out of a stake context, or null if it is not usable. */
export function beeminderCredentials(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): BeeminderCredentials | null {
  const username = requireString(config, 'username')
  const authToken = requireString(secrets, 'authToken')
  if (!username || !authToken) return null
  return { username, authToken }
}

function goalUrl(creds: BeeminderCredentials, goal: string, suffix: string): string {
  return (
    `${BEEMINDER_API}/users/${encodeURIComponent(creds.username)}` +
    `/goals/${encodeURIComponent(goal)}/${suffix}`
  )
}

/**
 * `requestid` — Beeminder's OWN idempotency key, and belt-and-braces with the
 * ledger's unique index.
 *
 * The index stops a day being re-planned; this stops the two paths that write
 * the same row from ever producing two datapoints in the window where neither
 * has committed yet. Beeminder answers a repeat requestid with the EXISTING
 * datapoint rather than a new one, which is also what makes the live path safe
 * to retry.
 */
export function requestIdFor(dateStr: string, subject: string): string {
  return `dsul-${dateStr}-${subject}`
}

/**
 * Post one datapoint and return its Beeminder id, or null if the response did
 * not carry one.
 *
 * A null id is not a failure — the datapoint is up. It only means the row
 * cannot record what to withdraw later, so an un-tick will say so rather than
 * pretending it retracted something.
 */
export async function postDatapoint(
  creds: BeeminderCredentials,
  goal: string,
  entry: { subject: string; subjectTitle: string; dateStr: string },
): Promise<string | null> {
  const text = await postToChannel(goalUrl(creds, goal, 'datapoints.json'), {
    contentType: 'application/x-www-form-urlencoded',
    body: new URLSearchParams({
      auth_token: creds.authToken,
      value: '1',
      comment: `dsul: ${entry.subjectTitle} on ${entry.dateStr}`,
      requestid: requestIdFor(entry.dateStr, entry.subject),
      daystamp: entry.dateStr.replace(/-/g, ''),
    }).toString(),
  })
  return datapointIdFrom(text)
}

/** The `id` out of a datapoint response, tolerating anything unexpected. */
export function datapointIdFrom(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed && typeof parsed === 'object' && 'id' in parsed) {
      const id = (parsed as { id: unknown }).id
      if (typeof id === 'string' && id !== '') return id
      if (typeof id === 'number') return String(id)
    }
  } catch {
    // Beeminder answers JSON; a body that is not is a proxy or an error page,
    // and neither is worth throwing over once the POST itself returned 2xx.
  }
  return null
}

/**
 * Withdraw a datapoint that should never have counted.
 *
 * Throws only on a real failure. A 404 is treated as success: the datapoint is
 * gone, which is the state being asked for, and the alternative is a row that
 * can never be cleaned up because the thing it points at no longer exists.
 */
export async function retractDatapoint(
  creds: BeeminderCredentials,
  goal: string,
  datapointId: string,
): Promise<void> {
  try {
    await postToChannel(
      `${goalUrl(creds, goal, `datapoints/${encodeURIComponent(datapointId)}.json`)}` +
        `?auth_token=${encodeURIComponent(creds.authToken)}`,
      { method: 'DELETE', body: '' },
    )
  } catch (err) {
    if (err instanceof Error && /^404\b/.test(err.message)) return
    throw err
  }
}

export const beeminderAdapter: StakeAdapter = {
  slug: EXT_BEEMINDER,
  extensionSlug: EXT_BEEMINDER,

  plan(outcome, ctx) {
    // Every required credential is checked HERE, not only in commit(). Under
    // claim-then-act a planned row is a CLAIMED row: planning against a
    // half-configured extension burns the day permanently, because the retry
    // finds the row already there and commit's "not configured" answer is
    // reported as success. pledge and partner already gate on their own config;
    // this one did not.
    if (!beeminderCredentials(ctx.config, ctx.secrets)) return []
    const drafts: StakeEventDraft[] = []
    for (const item of outcome.hits) {
      const goal = goalForTitle(ctx.config, item.title)
      if (!goal) continue
      drafts.push({
        subject: item.id,
        subjectTitle: item.title,
        kind: 'hit',
        detail: encodeDetail(goal),
      })
    }
    return drafts
  },

  async commit(claimed, outcome, ctx) {
    if (claimed.length === 0) return { ok: true, skipped: true, detail: 'nothing new' }

    const creds = beeminderCredentials(ctx.config, ctx.secrets)
    if (!creds) return { ok: true, skipped: true, detail: 'beeminder not configured' }

    const failures: string[] = []
    for (const draft of claimed) {
      // Decoded rather than read raw: a row claimed by the LIVE path and left
      // uncommitted carries the same encoding, and treating "vitamins#12345"
      // as a goal slug would post to a goal that does not exist.
      const { goal } = decodeDetail(draft.detail)
      if (!goal) continue
      try {
        const datapointId = await postDatapoint(creds, goal, {
          subject: draft.subject,
          subjectTitle: draft.subjectTitle,
          dateStr: outcome.dateStr,
        })
        // Recorded so an un-tick can withdraw it. Best-effort on purpose — the
        // datapoint is already up, and failing the commit over the bookkeeping
        // would re-post it on the next tick. The cost of losing this write is
        // that a later retraction says it cannot find the datapoint, which is
        // true and is the honest thing to say.
        if (datapointId) {
          await ctx.service
            .from('stake_events')
            .update({ detail: encodeDetail(goal, datapointId) })
            .eq('user_id', ctx.userId)
            .eq('date', outcome.dateStr)
            .eq('subject', draft.subject)
            .eq('channel', EXT_BEEMINDER)
        }
      } catch (err) {
        failures.push(`${draft.subjectTitle}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (failures.length > 0) {
      return { ok: false, detail: failures.join('; ') }
    }
    return { ok: true, detail: `posted ${claimed.length} datapoint(s)` }
  },
}
