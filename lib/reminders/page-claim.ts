/**
 * page-claim.ts — what POST /api/reminders/claim does with a page's candidates.
 * Server only (the route is its one caller).
 *
 * An open page that is in use claims a due cue before the scan does, shows it,
 * and so silences the push to every other device and every outward channel
 * for that cue (decision 4; memory/plans/reminders-platforms.md §3.5). The
 * claim is the scan's own compare-and-swap (lib/reminders/claim.ts), run with
 * the SESSION client, so RLS limits it to the user's rows and a foreign itemId
 * changes nothing.
 *
 * BUT THE PAGE IS NOT TRUSTED TO SAY WHAT IS DUE. Its items may be hours old
 * (nothing pushes a tick made on the phone into an open browser yet) and its
 * clock may be wrong. A claim made on that word alone would consume the cue
 * for a habit already done, or tomorrow's cue tonight, and silence the server
 * for it. So each cue or snooze candidate is re-asked of lib/reminders/due.ts's
 * dueReminders here, against the item as the database holds it now, the
 * account's stored zone and the server's clock, exactly as the scan would ask
 * it at this minute, and only one that comes back due is claimed. Nothing is
 * re-derived: the same predicate, a second caller.
 *
 * A release is not re-asked: it only ever gives back a key the page wrote,
 * and its compare-and-swap makes sure the key is still that one.
 *
 * The answer splits the rest in two. `lost`: someone else discharged it, or
 * there is nothing to discharge (done, paused, reminders off, no zone stored).
 * `later`: the server's clock has not reached the cue's minute (a page clock a
 * few seconds fast), a snooze that has not matured here yet, or a write the
 * database refused; the page asks again at its next tick.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ActivationContext } from '../active'
import { fetchItemById, fetchRoutines, fetchSeasons } from '../db'
import type { Item } from '../planner-types'
import { claimCue, claimSnooze, releaseCue } from './claim'
import type { ClaimAnswer, ClaimCandidate } from './claim-wire'
import { localClock, type LocalClock } from './clock'
import { dueReminders, minutesOfDay, REMINDER_GRACE_MINUTES, sentKeyFor, type ScanRow } from './due'

type Client = SupabaseClient

interface BookRow {
  id: string
  reminder_sent_key: string | null
  reminder_snooze_until: string | null
  reminder_snooze_date: string | null
}

/** A read failed: the route answers 500 and nothing was claimed. */
export class PageClaimError extends Error {}

export async function claimForPage(
  client: Client,
  userId: string,
  candidates: readonly ClaimCandidate[],
  now: Date = new Date(),
): Promise<ClaimAnswer> {
  const answer: ClaimAnswer = { won: [], lost: [], later: [] }

  for (const c of candidates) {
    if (c.kind !== 'release') continue
    const released = await releaseCue(client, userId, c.itemId, sentKeyFor(c.dateStr, c.at))
    if (released === null) answer.later.push(c)
    else (released ? answer.won : answer.lost).push(c)
  }

  const asks = candidates.filter((c) => c.kind !== 'release')
  if (asks.length === 0) return answer

  const { data: settings, error: settingsError } = await client
    .from('user_settings')
    .select('timezone, habit_reminders_enabled')
    .eq('user_id', userId)
    .maybeSingle()
  if (settingsError) throw new PageClaimError(settingsError.message)
  const zone = (settings as { timezone?: string | null } | null)?.timezone?.trim()
  // The scan's two gates on a user: a stored zone, and the master switch.
  // Without either it sends nothing, so there is nothing for a page to claim.
  if (!zone || (settings as { habit_reminders_enabled?: boolean | null }).habit_reminders_enabled !== true) {
    answer.lost.push(...asks)
    return answer
  }

  let clock: LocalClock
  try {
    clock = localClock(now, zone)
  } catch {
    answer.lost.push(...asks)
    return answer
  }

  const ids = [...new Set(asks.map((c) => c.itemId))]
  const { data: bookData, error: bookError } = await client
    .from('items')
    .select('id, reminder_sent_key, reminder_snooze_until, reminder_snooze_date')
    .in('id', ids)
    .eq('user_id', userId)
    .is('deleted_at', null)
  if (bookError) throw new PageClaimError(bookError.message)
  const book = new Map(((bookData ?? []) as BookRow[]).map((r) => [r.id, r]))

  let items: (Item | null)[]
  let ctx: ActivationContext
  try {
    const [found, routines, seasons] = await Promise.all([
      Promise.all(ids.filter((id) => book.has(id)).map((id) => fetchItemById(userId, id, client))),
      fetchRoutines(userId, client),
      fetchSeasons(userId, client),
    ])
    items = found
    // Unreachable containers read as "no memberships known", the scan's
    // contract: item-level pause is still honoured.
    ctx = { userTimezone: zone, routines: routines ?? undefined, seasons: seasons ?? undefined }
  } catch (err) {
    throw new PageClaimError(err instanceof Error ? err.message : String(err))
  }

  const rows: ScanRow[] = items
    .filter((item): item is Item => item !== null)
    .map((item) => {
      const row = book.get(item.id)
      return {
        item,
        sentKey: row?.reminder_sent_key ?? undefined,
        snoozeUntil: row?.reminder_snooze_until ?? undefined,
        snoozeDate: row?.reminder_snooze_date ?? undefined,
      }
    })
  // No latestOpening: the page ticks every minute, so a 23:58 cue has a tick
  // inside its own window (ScanClock.latestOpening says why the scan sets one).
  const due = dueReminders(rows, { ...clock, graceMinutes: REMINDER_GRACE_MINUTES }, ctx)

  for (const c of asks) {
    if (c.kind === 'cue') {
      const today = c.dateStr === clock.dateStr
      const isDue = today && due.some((d) => !d.snoozed && d.item.id === c.itemId && d.at === c.at)
      if (!isDue) {
        const target = minutesOfDay(c.at)
        const notYet = today && target !== null && clock.nowMinutes < target && book.get(c.itemId)?.reminder_sent_key !== sentKeyFor(c.dateStr, c.at)
        ;(notYet ? answer.later : answer.lost).push(c)
        continue
      }
      const claimed = await claimCue(client, userId, c.itemId, sentKeyFor(c.dateStr, c.at))
      if (claimed === null) answer.later.push(c)
      else (claimed ? answer.won : answer.lost).push(c)
      continue
    }

    if (c.kind !== 'snooze') continue
    // The snooze the page holds must be the one the row holds: a newer tap
    // (another device's) is that device's to ring, never this one's.
    const held = book.get(c.itemId)?.reminder_snooze_until
    const same = held != null && Date.parse(held) === Date.parse(c.held)
    const today = c.dateStr === clock.dateStr && book.get(c.itemId)?.reminder_snooze_date === c.dateStr
    const isDue = same && today && due.some((d) => d.snoozed && d.item.id === c.itemId)
    if (!isDue) {
      const notYet = same && today && Date.parse(c.held) > clock.nowMs
      ;(notYet ? answer.later : answer.lost).push(c)
      continue
    }
    const claimed = await claimSnooze(client, userId, c.itemId, held as string)
    if (claimed === null) answer.later.push(c)
    else (claimed ? answer.won : answer.lost).push(c)
  }

  return answer
}
