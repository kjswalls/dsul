/**
 * act.ts — a notification's buttons, as writes. Server only.
 *
 * Extracted from app/api/reminders/act/route.ts (memory/plans/reminders-platforms.md
 * §3.3, PR-1b) so the route is auth and parsing and nothing else, and `skip`
 * joins Done and Snooze for the third button a native notification carries.
 * The callers are the service worker's notificationclick (app/sw.ts) and, from
 * PR-1c, the desktop bridge; every one is a cookie session, so `client` is the
 * session client and RLS scopes each statement to the signed-in user: an
 * itemId belonging to someone else finds nothing rather than being trusted
 * because the caller knew the id.
 *
 * Done: per-date completion on a recurring item (never scalar status), the
 * scalar status on a one-off; the snooze columns cleared; the live stake
 * report, awaited and never fatal; the "I tick an item" recipes after the
 * response, only on a real transition.
 *
 * Snooze: `reminder_snooze_until` = now + SNOOZE_MINUTES, and
 * `reminder_snooze_date` = the day the notification was about. Held to that
 * day when the account has a zone, as the phone's snooze is
 * (lib/reminders/snooze.ts): one that would ring past that day's local
 * midnight writes nothing and answers `snoozedUntil: null`.
 *
 * Skip: lib/item-intents.ts applySkip, the phone's `skip` intent and the
 * web's Skip today, with its stake report and its `item.skipped` recipe.
 */

import { setItemCompletion, updateItem } from '../db'
import { getItemTypeConfig } from '../item-registry'
import { applySkip, readWriteRow, writeContextFor } from '../item-intents'
import { afterItemWrite } from '@/lib/recipes/server'
import { reportLiveCompletion } from '../stakes/live'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '../supabase-service'
import { ACTION_DONE, ACTION_SNOOZE, SNOOZE_MINUTES } from './channels/push'
import { snoozeFireInstant } from './snooze'

/** The caller's cookie-session client: RLS is what scopes every write here. */
type SessionClient = SupabaseClient

/** The native notification's third button. Matched in lib/sw/handlers.ts. */
export const ACTION_SKIP = 'skip'

export const REMINDER_ACTIONS = [ACTION_DONE, ACTION_SNOOZE, ACTION_SKIP] as const
export type ReminderAction = (typeof REMINDER_ACTIONS)[number]

export interface ActRequest {
  action: ReminderAction
  itemId: string
  /** The day the notification was about, yyyy-MM-dd. */
  dateStr: string
}

/** What the route sends: a status and a JSON body. */
export interface ActAnswer {
  status: number
  body: Record<string, unknown>
}

const ok = (body: Record<string, unknown> = {}): ActAnswer => ({ status: 200, body: { ok: true, ...body } })
const fail = (status: number, error: string): ActAnswer => ({ status, body: { error } })

/** Parse a body; a string is the 400's message. */
export function parseActRequest(raw: unknown): ActRequest | string {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const { action, itemId, dateStr } = body
  if (typeof itemId !== 'string' || !itemId || !REMINDER_ACTIONS.includes(action as ReminderAction)) {
    return 'action and itemId are required'
  }
  // Required for every action. The date comes off a notification that may
  // have sat on a lock screen overnight, so it is data, not a formality:
  // completing "today" server-side would credit the wrong day for exactly the
  // user who most needs the credit, and a snooze without its day cannot be
  // expired.
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return 'dateStr must be yyyy-MM-dd'
  }
  return { action: action as ReminderAction, itemId, dateStr }
}

/** The account's stored zone, or null (none stored, or unreadable). */
async function storedZone(client: SessionClient, userId: string): Promise<string | null> {
  try {
    const { data, error } = await client.from('user_settings').select('timezone').eq('user_id', userId).maybeSingle()
    if (error) return null
    const zone = (data as { timezone?: string | null } | null)?.timezone?.trim()
    return zone || null
  } catch {
    return null
  }
}

export async function runReminderAction(
  client: SessionClient,
  userId: string,
  req: ActRequest,
  nowMs: number = Date.now(),
): Promise<ActAnswer> {
  const { action, itemId, dateStr } = req

  if (action === ACTION_SKIP) return skip(client, userId, req)

  const { data: row, error } = await client
    .from('items')
    .select('id, type, repeat_frequency, status, start_date')
    .eq('id', itemId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) return fail(500, error.message)
  if (!row) return fail(404, 'Not found')

  const type = row.type as string

  if (action === ACTION_SNOOZE) {
    // Held to its day when there is a day to hold it to. With no stored zone
    // the scan never runs for this account, and the snooze is stored as it
    // always was, for whichever clock reads it first.
    const zone = await storedZone(client, userId)
    let untilMs: number | null = nowMs + SNOOZE_MINUTES * 60_000
    if (zone) untilMs = snoozeFireInstant(nowMs, SNOOZE_MINUTES, zone, dateStr)
    if (untilMs === null) return ok({ snoozedUntil: null })
    const until = new Date(untilMs).toISOString()
    const { error: snoozeError } = await client
      .from('items')
      .update({
        reminder_snooze_until: until,
        // The day the snooze BELONGS to — the day the notification was about,
        // not the day it happens to mature on. The scan refuses a snooze whose
        // day is not today (dueReminders' day gate).
        reminder_snooze_date: dateStr,
      })
      .eq('id', itemId)
    if (snoozeError) return fail(500, snoozeError.message)
    return ok({ snoozedUntil: until })
  }

  // Resolved through the REGISTRY, not read raw. items.repeat_frequency has no
  // column default, so a habit can be stored with NULL, and a raw read would
  // send it down the one-shot branch and mark it done via scalar `status`,
  // the write CLAUDE.md forbids for a recurring item. itemFromRow applies the
  // same fallback.
  const frequency = (row.repeat_frequency as string | null) ?? getItemTypeConfig(type).defaultFrequency
  const recurring = Boolean(frequency) && frequency !== 'none'

  // Whether the day was already done, read before the write, so only a real
  // transition starts a recipe. A failed read is "done": no recipe, the tick
  // itself goes ahead.
  let wasDone = true
  if (recurring) {
    const { data: done, error: doneError } = await client
      .from('items')
      .select('id')
      .eq('id', itemId)
      .eq('user_id', userId)
      .contains('completed_dates', [dateStr])
      .maybeSingle()
    wasDone = !!doneError || !!done
  } else {
    wasDone = row.status === getItemTypeConfig(type).doneStatus
  }

  try {
    if (recurring) {
      // Per-date completion, never scalar status, and the RPC owns the streak.
      await setItemCompletion(itemId, type, dateStr, true, true, client)
    } else {
      await updateItem(itemId, type, { status: getItemTypeConfig(type).doneStatus } as never, userId, client)
    }
  } catch (err) {
    return fail(500, err instanceof Error ? err.message : 'Update failed')
  }

  // A completed item must not be re-asked by a snooze that was armed before it.
  await client.from('items').update({ reminder_snooze_until: null, reminder_snooze_date: null }).eq('id', itemId)

  // The lock-screen Done is the completion that happens without the app being
  // opened, so it gets the live stake report rather than waiting for the
  // settlement. Awaited but never fatal: the completion is already written.
  const stake = await reportLiveCompletion(createServiceClient(), { userId, itemId, dateStr, completed: true })
  if (!stake.ok) console.error('[reminders/act] stake report failed:', stake.detail)

  if (!wasDone) {
    afterItemWrite({
      kind: 'item.completed',
      userId,
      itemId,
      type,
      // A one-off has one occurrence: its start date, or the day acted on.
      date: recurring ? dateStr : ((row.start_date as string | null) ?? dateStr),
    })
  }

  return ok()
}

/**
 * Skip, through the phone's own intent (lib/item-intents.ts applySkip): the
 * registry's skippable gate, never a subtask, the day's completion cleared
 * before the skip is set, and the stake told that the day is not done.
 */
async function skip(client: SessionClient, userId: string, req: ActRequest): Promise<ActAnswer> {
  let row
  try {
    row = await readWriteRow(client, userId, req.itemId)
  } catch (err) {
    return fail(500, err instanceof Error ? err.message : 'Read failed')
  }
  if (!row) return fail(404, 'Not found')
  const ctx = writeContextFor(userId, client, row)
  const stakes: Promise<unknown>[] = []
  let result
  try {
    result = await applySkip(
      ctx,
      { date: req.dateStr, skipped: true },
      {
        onStake: (itemId, dateStr, completed) => {
          stakes.push(
            reportLiveCompletion(createServiceClient(), { userId, itemId, dateStr, completed }).then((r) => {
              if (!r.ok) console.error('[reminders/act] stake report failed:', r.detail)
            }),
          )
        },
      },
    )
  } catch (err) {
    return fail(500, err instanceof Error ? err.message : 'Update failed')
  }
  if ('refused' in result) return fail(result.status, result.refused)
  if ('invalid' in result) return fail(400, 'invalid')
  await Promise.allSettled(stakes)

  // A skipped day must not be re-asked by a snooze armed before it.
  await client
    .from('items')
    .update({ reminder_snooze_until: null, reminder_snooze_date: null })
    .eq('id', req.itemId)
    .eq('reminder_snooze_date', req.dateStr)

  if (result.changed) {
    afterItemWrite({ kind: 'item.skipped', userId, itemId: req.itemId, type: row.type, date: req.dateStr })
  }
  return ok()
}
