/**
 * agent-finish.ts — who ticks off work an agent was handed.
 *
 * An agent's `done` (dsul_report_progress) is its report: the item stays open
 * until the user has checked the work and ticks it (the row's "finished" chip,
 * components/primitives/pills.tsx). Kirby, 2026-10-25: agents could also tick
 * the item itself through the planner's own verbs, before anyone looked. So the
 * agent door refuses a tick on an item handed to an agent, unless the account
 * lets agents finish their own work (user_settings.agents_may_complete,
 * migration 085; Settings → AI → Connected apps).
 *
 * Items nobody handed off are untouched: an agent asked in chat to tick
 * something off still can. Unticking is always allowed, since it gives the
 * decision back rather than taking it.
 *
 * Server-only: service-role reads, from the agent routes.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** 42703 / PGRST204: the column is not there yet (085 unapplied). */
const MISSING_COLUMN = new Set(['42703', 'PGRST204'])

export const AGENT_FINISH_REFUSED =
  'This item was handed to you, so the user ticks it off once they have checked your work. ' +
  "Report what you did with dsul_report_progress, status 'done', instead. " +
  '(The user can let agents tick off handed-off items in Settings → AI.)'

/**
 * Does the account let agents tick off items handed to them? Off when the
 * column is missing, the row is missing, or the read fails: a refusal the user
 * can lift beats a tick they never saw.
 */
export async function agentsMayComplete(db: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await db
    .from('user_settings')
    .select('agents_may_complete')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return false
  return (data as { agents_may_complete?: unknown } | null)?.agents_may_complete === true
}

/** The setting for the settings pane: null while 085 is not applied. */
export async function readAgentsMayComplete(db: SupabaseClient, userId: string): Promise<boolean | null> {
  const { data, error } = await db
    .from('user_settings')
    .select('agents_may_complete')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    if (MISSING_COLUMN.has(String(error.code))) return null
    throw new Error(`agents_may_complete read failed (${error.code})`)
  }
  return (data as { agents_may_complete?: unknown } | null)?.agents_may_complete === true
}

/** Writes it, creating the row if need be. False when 085 is not applied. */
export async function writeAgentsMayComplete(db: SupabaseClient, userId: string, value: boolean): Promise<boolean> {
  const { error } = await db
    .from('user_settings')
    .upsert({ user_id: userId, agents_may_complete: value }, { onConflict: 'user_id' })
  if (error) {
    if (MISSING_COLUMN.has(String(error.code))) return false
    throw new Error(`agents_may_complete write failed (${error.code})`)
  }
  return true
}

/** Would this write tick the item off? A status, or a date added to the set. */
export function ticksOff(
  update: { status?: unknown; completedDates?: unknown },
  current: readonly string[]
): boolean {
  if (update.status === 'completed') return true
  if (!Array.isArray(update.completedDates)) return false
  const had = new Set(current)
  return update.completedDates.some((d) => typeof d === 'string' && !had.has(d))
}

/**
 * The refusal for an agent about to tick off `id`, or null when it may. Reads
 * the item's assignee (and its ticked dates, for `ticks`), then the setting
 * only when the item is handed off, so the common case costs one read.
 */
export async function refuseAgentFinish(
  db: SupabaseClient,
  userId: string,
  id: string,
  ticks: (completedDates: readonly string[]) => boolean
): Promise<string | null> {
  const { data, error } = await db
    .from('items')
    .select('assignee, completed_dates')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  // A missing row is the route's own 404 to give.
  if (error || !data) return null
  const row = data as { assignee?: string | null; completed_dates?: string[] | null }
  if (!row.assignee?.trim()) return null
  if (!ticks(row.completed_dates ?? [])) return null
  if (await agentsMayComplete(db, userId)) return null
  return AGENT_FINISH_REFUSED
}
