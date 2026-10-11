/**
 * build.ts — the three nudges the scan sends, worded and named in one place.
 *
 * Two callers say the same nudge: the scan, the first time, and the retry pass
 * (lib/reminders/retry.ts), when a claimed nudge reached no device. Built
 * twice by hand, the retry's copy, link or cue_log key would drift from the
 * first send's, and a retried cue would collapse into nothing in the shade or
 * be acked under a key no row has. So both build here, and neither decides
 * WHETHER to send: that is due.ts's, asked by each caller.
 */

import type { Item } from '../planner-types'
import { EOD_COPY, lastCallCopy, reminderCopy, type TimeFormat } from './copy'
import { cueKey, dayKey, snoozeKey } from './cue-log'
import { streakOf, type ReminderCandidate } from './due'
import type { Nudge, NudgeItem } from './nudge'

export function toNudgeItem(item: Item): NudgeItem {
  return { id: item.id, title: item.title, streak: streakOf(item) }
}

/**
 * One item's cue, or its matured snooze. `held` is the snooze's instant as the
 * row held it when it was claimed: the snooze's cue_log name.
 */
export function cueNudge(
  candidate: ReminderCandidate,
  dateStr: string,
  timeFormat: TimeFormat,
  expiresAtMs: number,
  held: string | null,
): Nudge {
  const { title, body } = reminderCopy(candidate, timeFormat)
  return {
    kind: 'cue',
    title,
    body,
    url: `/item/${candidate.item.id}`,
    dateStr,
    itemId: candidate.item.id,
    items: [toNudgeItem(candidate.item)],
    snoozed: candidate.snoozed,
    expiresAtMs,
    logKey: candidate.snoozed
      ? (snoozeKey(candidate.item.id, held ?? '') ?? undefined)
      : cueKey(candidate.item.id, dateStr, candidate.at),
  }
}

/** The streak-at-risk last call naming `open`, or null when nothing is open (send nothing). */
export function lastCallNudge(open: readonly Item[], dateStr: string, expiresAtMs: number): Nudge | null {
  const copy = lastCallCopy(open)
  if (!copy) return null
  return {
    kind: 'last-call',
    title: copy.title,
    body: copy.body,
    url: '/',
    dateStr,
    itemId: open.length === 1 ? open[0].id : undefined,
    items: open.map(toNudgeItem),
    expiresAtMs,
    logKey: dayKey('last-call', dateStr),
  }
}

/** The end-of-day review's invitation for `dateStr`. */
export function eodNudge(dateStr: string, expiresAtMs: number): Nudge {
  return {
    kind: 'eod',
    title: EOD_COPY.title,
    body: EOD_COPY.body,
    // The day it invites a review of, so a tap after midnight is recorded as
    // that day's review and not the new one's, which would retire the new
    // day's invitation before it is sent (lib/eod.ts's reviewedDay). The app
    // still opens the bare ?eod=1 of older pushes.
    url: `/?eod=${dateStr}`,
    dateStr,
    items: [],
    expiresAtMs,
    logKey: dayKey('eod', dateStr),
  }
}
