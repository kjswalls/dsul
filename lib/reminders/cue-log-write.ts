/**
 * cue-log-write.ts — the writer of `cue_log` (migration 067). Server only.
 *
 * memory/plans/reminders-platforms.md §5.2, PR-1d. One row per (user, key),
 * the key being cue-log.ts's. Three writers, all through the service role
 * (`authenticated` may only read its ledger):
 *
 *   · the scan, which opens a row the moment it wins a claim and closes it
 *     with what every channel made of the nudge (`results`, and
 *     `delivered_at` once one of them got it to someone);
 *   · the retry pass (retry.ts), which re-sends a row nothing delivered and
 *     appends what that came to;
 *   · POST /api/reminders/claim, which records a cue an open page claimed and
 *     showed itself (`results` [{ channel: 'page' }], delivered at the claim).
 *
 * The ack route writes the fourth thing, `acked_at`.
 *
 * BEST EFFORT, ALWAYS. The ledger records a delivery; it never gates one. A
 * write that fails costs a line in "did it fire", and a nudge the scan has
 * claimed is sent whether or not its row could be opened. Until 067 is
 * applied every write here is a quiet no-op (42P01 / PGRST205).
 *
 * WHY OPEN BEFORE THE SEND. A row opened at the claim and never closed is the
 * one signature of a send that was cut off (the route's maxDuration, a crash):
 * `delivered_at` null, `results` empty. That is what the retry pass looks for.
 * Opened after the send, the cut-off nudge would leave nothing at all.
 */

import type { createServiceClient } from '../supabase-service'
import type { DeliveryReport } from './deliver'
import type { Nudge } from './nudge'
import { tagOf } from './channels/push'

type ServiceClient = ReturnType<typeof createServiceClient>

/**
 * Sends a row gets in all, the first included. 067's open index stops at
 * `attempts < 5`, so this is held to the migration text by a test.
 */
export const MAX_ATTEMPTS = 5

/** How many results a row keeps: the latest, so a retried row stays well under 067's 8 KB check. */
const MAX_RESULTS = 20

/**
 * cue_log's `kind` as the scan writes it: a cue's matured snooze is its own.
 * 067's CHECK also holds 'eod', the retired review's, which only an old row
 * carries (`StoredCueLogKind`).
 */
export type CueLogKind = 'cue' | 'snooze' | 'last-call' | 'pledge'
/** A kind a stored row may carry: what is written now, or an old review row's. */
export type StoredCueLogKind = CueLogKind | 'eod'

/** One entry in `results`: a channel's answer, or a device's. Codes only, never a provider's words. */
export interface CueLogResult {
  channel: string
  ok: boolean
  /** Why it did not deliver: 'unreached', 'skipped', 'failed', or a retry's own reason. */
  code?: string
  at: string
}

/** 42P01 from Postgres, PGRST205 from PostgREST's schema cache: 067 is not applied. */
export function isMissingCueLog(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === '42P01' || code === 'PGRST205'
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message ?? error)

export function logKindOf(nudge: Nudge): CueLogKind {
  return nudge.kind === 'cue' && nudge.snoozed ? 'snooze' : nudge.kind
}

/** What every channel made of one nudge, as `results` entries. */
export function resultsOf(reports: readonly DeliveryReport[], at: string): CueLogResult[] {
  return reports.map((r) => {
    if (r.ok && !r.skipped && !r.unreached) return { channel: r.channel, ok: true, at }
    return { channel: r.channel, ok: false, code: r.unreached ? 'unreached' : r.skipped ? 'skipped' : 'failed', at }
  })
}

/** Somebody got it: a channel took it to a device, a speaker, a phone. */
export function deliveredBy(results: readonly CueLogResult[]): boolean {
  return results.some((r) => r.ok)
}

/**
 * Worth sending again: nothing delivered it and something FAILED. A nudge
 * that reached nobody because the user has no device (unreached) or turned
 * every channel down (skipped) finds the same nothing next tick, so its row
 * is closed for retries instead (habit-reminders.md decision 4: a cue with no
 * device is discharged, not held over).
 */
export function worthRetrying(results: readonly CueLogResult[]): boolean {
  return !deliveredBy(results) && results.some((r) => !r.ok && r.code === 'failed')
}

export interface OpenedRow {
  /** The row's id, or null when it could not be written (no 067, or a refused write). */
  id: string | null
  /** A write that failed for any reason but a missing table, for the tick's notes. */
  error?: string
}

/**
 * Open the row for a nudge the scan just claimed, before it is sent.
 *
 * An upsert on (user_id, key), and on a conflict it starts the row again: a
 * key already there is a cue a page claimed and then released (its presenter
 * failed, so it was never shown), now claimed by the scan. Its `acked_at` is
 * left alone. Two ticks can never both get here for one key, since each
 * claim is a compare-and-swap only one of them wins.
 */
export async function openCueLog(
  service: ServiceClient,
  userId: string,
  nudge: Nudge,
  claimedAtMs: number,
): Promise<OpenedRow> {
  if (!nudge.logKey) return { id: null }
  try {
    const { data, error } = await service
      .from('cue_log')
      .upsert(
        {
          user_id: userId,
          key: nudge.logKey,
          kind: logKindOf(nudge),
          item_id: nudge.itemId ?? null,
          date_str: nudge.dateStr,
          collapse_id: tagOf(nudge),
          window_end: new Date(nudge.expiresAtMs).toISOString(),
          claimed_at: new Date(claimedAtMs).toISOString(),
          delivered_at: null,
          attempts: 1,
          results: [],
        },
        { onConflict: 'user_id,key' },
      )
      .select('id')
      .maybeSingle()
    if (error) return isMissingCueLog(error) ? { id: null } : { id: null, error: messageOf(error) }
    return { id: (data as { id?: string } | null)?.id ?? null }
  } catch (err) {
    return { id: null, error: messageOf(err) }
  }
}

/**
 * Close a row with what a send came to: the new results after the old (the
 * latest MAX_RESULTS kept), `delivered_at` once something delivered it, and
 * `attempts` at the cap when another send would find the same nothing.
 * Returns an error line, or null.
 */
export async function closeCueLog(
  service: ServiceClient,
  userId: string,
  id: string,
  results: readonly CueLogResult[],
  options: { before?: readonly CueLogResult[]; nowMs: number },
): Promise<string | null> {
  const all = [...(options.before ?? []), ...results].slice(-MAX_RESULTS)
  const patch: Record<string, unknown> = { results: all }
  if (deliveredBy(results)) patch.delivered_at = new Date(options.nowMs).toISOString()
  else if (!worthRetrying(results)) patch.attempts = MAX_ATTEMPTS
  try {
    const { error } = await service.from('cue_log').update(patch).eq('id', id).eq('user_id', userId)
    if (error && !isMissingCueLog(error)) return messageOf(error)
    return null
  } catch (err) {
    return messageOf(err)
  }
}

/** A cue or snooze an open page won and is about to show. */
export interface PageLogEntry {
  key: string
  kind: 'cue' | 'snooze'
  itemId: string
  dateStr: string
}

/**
 * Record the cues a page claimed (POST /api/reminders/claim). Delivered at
 * the claim, by the page itself: nothing for the retry pass to pick up, and
 * the page's ack follows once it has shown it. A key already in the ledger
 * is left as it is (`ignoreDuplicates`): the first record of a cue wins.
 * Returns an error line, or null.
 */
export async function logPageClaims(
  service: ServiceClient,
  userId: string,
  entries: readonly PageLogEntry[],
  nowMs: number,
): Promise<string | null> {
  if (entries.length === 0) return null
  const at = new Date(nowMs).toISOString()
  try {
    const { error } = await service.from('cue_log').upsert(
      entries.map((e) => ({
        user_id: userId,
        key: e.key,
        kind: e.kind,
        item_id: e.itemId,
        date_str: e.dateStr,
        collapse_id: `dsul-item-${e.itemId}`,
        // A page shows a cue the minute it wins it; there is no window left
        // for anyone to deliver it in.
        window_end: at,
        claimed_at: at,
        delivered_at: at,
        attempts: 1,
        results: [{ channel: 'page', ok: true, at } satisfies CueLogResult],
      })),
      { onConflict: 'user_id,key', ignoreDuplicates: true },
    )
    if (error && !isMissingCueLog(error)) return messageOf(error)
    return null
  } catch (err) {
    return messageOf(err)
  }
}

/**
 * A page gave a cue back (its presenter failed, so it was never shown): its
 * row goes, unless a device has already acked it. Only the PAGE's row: the
 * release has already freed the cue, so the scan may have claimed it and
 * opened the row afresh in between (its `results` start empty), and that row
 * is the scan's. Returns an error line, or null.
 */
export async function forgetPageClaims(
  service: ServiceClient,
  userId: string,
  keys: readonly string[],
): Promise<string | null> {
  if (keys.length === 0) return null
  try {
    const { error } = await service
      .from('cue_log')
      .delete()
      .eq('user_id', userId)
      .in('key', [...keys])
      .is('acked_at', null)
      .contains('results', [{ channel: 'page' }])
    if (error && !isMissingCueLog(error)) return messageOf(error)
    return null
  } catch (err) {
    return messageOf(err)
  }
}
