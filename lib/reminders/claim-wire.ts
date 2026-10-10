/**
 * claim-wire.ts — POST /api/reminders/claim's body and answer, shared by the
 * route and the page tick (hooks/use-local-cue-tick.ts). Client-safe.
 *
 * memory/plans/reminders-platforms.md §5.2, PR-1b:
 *
 *   { candidates: [ { kind:'cue',     itemId, dateStr, at }
 *                 | { kind:'snooze',  itemId, dateStr, held }
 *                 | { kind:'release', itemId, dateStr, at } ] }
 *
 * answered `{ won, lost, later }`. The plan names `{ won }` alone; `lost` and
 * `later` are the rest of it said out loud. A lost claim is never asked again
 * (someone else discharged that cue, or the server's own reading says there is
 * nothing to discharge); a `later` one is asked again at the next tick (the
 * server's clock has not reached the cue's minute yet, or the write was
 * refused).
 */

import { z } from 'zod'

const ITEM_ID = z.string().uuid()
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
/** An instant as PostgREST or toISOString writes it. */
const INSTANT = z
  .string()
  .max(40)
  .refine((s) => Number.isFinite(Date.parse(s)), 'not an instant')

export const ClaimCandidateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cue'), itemId: ITEM_ID, dateStr: DAY, at: HHMM }).strict(),
  z.object({ kind: z.literal('snooze'), itemId: ITEM_ID, dateStr: DAY, held: INSTANT }).strict(),
  z.object({ kind: z.literal('release'), itemId: ITEM_ID, dateStr: DAY, at: HHMM }).strict(),
])

/** A page asks about a minute's worth of cues at most; 25 is far past any real morning. */
export const MAX_CLAIM_CANDIDATES = 25

export const ClaimBodySchema = z
  .object({ candidates: z.array(ClaimCandidateSchema).min(1).max(MAX_CLAIM_CANDIDATES) })
  .strict()

export type ClaimCandidate = z.infer<typeof ClaimCandidateSchema>

export interface ClaimAnswer {
  won: ClaimCandidate[]
  lost: ClaimCandidate[]
  later: ClaimCandidate[]
}

/** One candidate's identity, for the page's shown/lost sets and for matching an answer. */
export function candidateId(c: ClaimCandidate): string {
  return c.kind === 'snooze' ? `snooze:${c.itemId}:${Date.parse(c.held)}` : `${c.kind}:${c.itemId}:${c.dateStr}T${c.at}`
}
