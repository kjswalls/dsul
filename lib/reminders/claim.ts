/**
 * claim.ts — the three compare-and-swaps that discharge a cue, written once.
 *
 * The scan (lib/reminders/scan.ts) claims through these with the service
 * client; an open page claims through POST /api/reminders/claim with the
 * SESSION client, so RLS limits it to the user's own rows
 * (memory/plans/reminders-platforms.md §5.2, PR-1b). One spelling for both, so
 * "the exact claimCandidates compare-and-swap" the plan asks the route to run
 * is the scan's by construction rather than by copy.
 *
 *   · a cue is claimed by moving reminder_sent_key to this day+time, ONLY from
 *     a row that is not already stamped with it;
 *   · a snooze is claimed by clearing the snooze, ONLY from a row whose
 *     reminder_snooze_until is still the exact value the claimant read. That
 *     is what stops the clear from destroying a NEWER snooze armed after the
 *     read: the user's second tap becoming a silent no-op;
 *   · a release (a page whose presenter failed after it won) puts
 *     reminder_sent_key back to null, ONLY from a row that still holds the key
 *     the page wrote, so a newer key is never cleared (decision 20). The scan's
 *     next tick inside the window then claims it and pushes.
 *
 * Each answers whether the database actually changed a row, or null when it
 * refused the write outright. A blind write is not exclusive: two claimants
 * would both "succeed" and both deliver.
 *
 * Pure of any server import, so lib/reminders stays importable from the route
 * and the scan alike; the client is whichever the caller holds.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

type Client = Pick<SupabaseClient, 'from'>

/** Did the conditional write change a row? null: the database refused it. */
export type ClaimOutcome = boolean | null

async function changed(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<ClaimOutcome> {
  const { data, error } = await query
  if (error) return null
  return Array.isArray(data) && data.length > 0
}

/** Stamp `key` (sentKeyFor) on the item, unless it already carries it. */
export function claimCue(client: Client, userId: string, itemId: string, key: string): Promise<ClaimOutcome> {
  return changed(
    client
      .from('items')
      .update({ reminder_sent_key: key })
      .eq('id', itemId)
      .eq('user_id', userId)
      .or(`reminder_sent_key.is.null,reminder_sent_key.neq.${key}`)
      .select('id'),
  )
}

/** Clear the snooze, only if it is still the one held at `held`. */
export function claimSnooze(client: Client, userId: string, itemId: string, held: string): Promise<ClaimOutcome> {
  return changed(
    client
      .from('items')
      .update({ reminder_snooze_until: null, reminder_snooze_date: null })
      .eq('id', itemId)
      .eq('user_id', userId)
      .eq('reminder_snooze_until', held)
      .select('id'),
  )
}

/** Hand a won cue back: null the stamp, only while it is still `key`. */
export function releaseCue(client: Client, userId: string, itemId: string, key: string): Promise<ClaimOutcome> {
  return changed(
    client
      .from('items')
      .update({ reminder_sent_key: null })
      .eq('id', itemId)
      .eq('user_id', userId)
      .eq('reminder_sent_key', key)
      .select('id'),
  )
}
