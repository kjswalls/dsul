/**
 * copy.ts — what a nudge actually says.
 *
 * Its own module, and pure, because the words ARE the intervention here. Every
 * channel this feature grows (a push notification, a speaker in the kitchen, a
 * phone call, an SMS) has to say the same thing in its own register, and the
 * moment two of them compose their own sentence the design decisions below stop
 * being decisions and become whatever each adapter's author felt like.
 *
 * THE COPY CONTRACT. dsul does not open by telling you what you are behind
 * on — see the BarCopy note in components/ai/morning-check.tsx, and the
 * "Still waiting" heading in lib/item-registry.ts that was deliberately not
 * called "Overdue". A reminder is the surface most tempted to break that rule
 * and the one where breaking it costs most: punishment reliably teaches
 * avoidance of the PUNISHER, so a scolding notification trains people to turn
 * notifications off. Two rules follow, and both are load-bearing:
 *
 *   1. Name the behavior, never the failure. "Vitamins" — not "You still
 *      haven't taken your vitamins."
 *   2. State a stake only as a fact, never as a threat. "12 days" is a number
 *      the user earned. "Don't lose your streak!" is a different sentence with
 *      a different effect.
 */

import type { ReminderCandidate } from './due'
import { streakOf } from './due'
import type { Nudge } from './nudge'
import type { Item } from '../planner-types'

/** Interpunct with hair spaces — the separator the app's chips already use. */
const DOT = ' · '

/** How many names the last call spells out before it starts counting instead. */
const LAST_CALL_NAME_LIMIT = 3

export type TimeFormat = '12h' | '24h'

/**
 * 'HH:mm' → what the user reads, honouring their time_format preference.
 *
 * Hand-rolled rather than date-fns' `format`, because there is no date here —
 * only a wall-clock time — and manufacturing a Date to format it is how a cue
 * at 00:30 becomes a cue on the wrong day in a timezone one line of code away.
 */
export function formatCueTime(hhmm: string, timeFormat: TimeFormat = '12h'): string {
  const [rawHour, minute] = hhmm.split(':')
  if (timeFormat === '24h') return `${rawHour}:${minute}`
  const hour = Number(rawHour)
  const suffix = hour < 12 ? 'am' : 'pm'
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  return `${hour12}:${minute} ${suffix}`
}

/** "12 days", "1 day" — the stake, stated as the fact it is. */
export function streakPhrase(streak: number): string {
  return `${streak} ${streak === 1 ? 'day' : 'days'}`
}

/**
 * The cue notification.
 *
 * Title is the item, alone: it is what the user has to DO, it is what a lock
 * screen truncates to, and it is what a smart speaker will read first.
 *
 * Body leads with the implementation intention when there is one, because that
 * phrase is the whole reason the field exists — "after I pour my coffee"
 * rehearses the context pairing that forms the habit, where "07:30" only names
 * a clock. The stated time is the fallback, not the preferred half.
 */
export function reminderCopy(
  candidate: ReminderCandidate,
  timeFormat: TimeFormat = '12h',
): { title: string; body: string } {
  const parts: string[] = []
  if (candidate.anchor) {
    parts.push(candidate.anchor)
  } else if (candidate.at) {
    parts.push(formatCueTime(candidate.at, timeFormat))
  }
  // `at` can be empty: a snooze tapped on a LAST CALL re-asks about an item
  // that may carry no per-item cue at all, so there is no stated time to echo.
  const streak = streakOf(candidate.item)
  if (streak > 0) parts.push(streakPhrase(streak))
  return { title: candidate.item.title, body: parts.join(DOT) }
}

/**
 * The streak-at-risk last call — ONE message, late, naming what is still open.
 *
 * Deliberately not a repeat of the cue. A second identical prompt is the fastest
 * way to teach someone to stop reading the first one; a changed frame is not.
 * So this one is allowed to do the thing the cue may not: say what today's miss
 * costs. It still says it as arithmetic rather than as an accusation.
 *
 * Returns null when nothing is open — the caller must send nothing at all
 * rather than a cheerful "all done!", which is a notification the user did not
 * ask for and cannot act on.
 *
 * Takes no TimeFormat, unlike reminderCopy: this message names items and a
 * streak and never a clock time, so a parameter for one would be an unused
 * argument that every call site has to keep passing correctly.
 */
export function lastCallCopy(
  items: readonly Item[],
): { title: string; body: string } | null {
  if (items.length === 0) return null

  const named = items.slice(0, LAST_CALL_NAME_LIMIT).map((i) => i.title)
  const rest = items.length - named.length
  const list =
    rest > 0
      ? `${named.join(', ')} and ${rest} more`
      : named.length === 1
        ? named[0]
        : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`

  const top = streakOf(items[0])
  const body =
    top > 0
      ? `${list}${DOT}${streakPhrase(top)} riding on it`
      : list

  return { title: items.length === 1 ? 'Still open today' : `${items.length} still open`, body }
}

/**
 * The end-of-day review's invitation.
 *
 * Moved here, word for word, from the cron route that used to send it on its
 * own (app/api/cron/eod-notify, folded into the scan). A constant rather than
 * a function because nothing about the user changes it: it names no item, no
 * streak and no time, only the ritual. It asks; it does not tally the day.
 * What the day held is the review's to show once it is open, and a lock
 * screen reading "3 things left" at 21:00 is the scolding the contract above
 * rules out.
 */
export const EOD_COPY = {
  title: 'End of day 🌙',
  body: "How'd today go?",
} as const

/* ── Other registers ─────────────────────────────────────────────────────── */

/**
 * The nudge as a sentence to be READ ALOUD.
 *
 * A notification and a speaker are not the same medium and must not share a
 * string. A notification has a title line and a body line and the reader
 * controls the pace; a speaker gets one shot, in passing, from across a room,
 * and the listener cannot scroll back. So this joins into one spoken sentence,
 * drops the interpunct (which a TTS engine reads as a pause at best and as
 * nothing at worst), and puts the item FIRST — by the time someone has looked
 * up from what they were doing, the first word is already gone.
 *
 * It also stays short on purpose. A speaker announcement that outstays its
 * welcome is the fastest way to have the whole extension switched off.
 */
export function spokenLine(nudge: Nudge): string {
  if (nudge.kind === 'last-call') {
    const names = nudge.items.map((i) => i.title)
    const list =
      names.length <= 1
        ? names[0] ?? ''
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    const top = nudge.items[0]?.streak ?? 0
    const stake = top > 0 ? ` ${streakPhrase(top)} on the line.` : ''
    return `Still open today: ${list}.${stake}`
  }

  const item = nudge.items[0]
  const streak = item?.streak ?? 0

  // Built from the nudge's PARTS, not from its body. The body is the
  // notification's own line and already carries the streak after an interpunct
  // — reusing it verbatim said the streak twice and read the separator aloud,
  // which is the exact thing this function's docstring says it removes.
  const [lead] = nudge.body.split(DOT)
  const clause = lead?.trim() ?? ''
  // "After 7:30 am" is not a sentence anyone says, so the prefix is only for a
  // real anchor — which never begins with a digit, where a time always does.
  const tail = clause && !/^\d/.test(clause) ? ` After ${clause}.` : ''
  const stake = streak > 0 ? ` ${streakPhrase(streak)} so far.` : ''
  return `${nudge.title}.${tail}${stake}`
}

/**
 * The nudge as a text message.
 *
 * One line, because a two-line SMS is two notifications on most phones. No link
 * by default: a shortened-looking URL in an unexpected text is exactly the shape
 * of a phishing message, and training yourself to tap those is a bad habit to
 * install while installing good ones.
 */
export function smsLine(nudge: Nudge): string {
  return nudge.body ? `${nudge.title}: ${nudge.body}` : nudge.title
}
