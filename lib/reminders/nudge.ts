/**
 * nudge.ts — the payload contract every delivery channel consumes.
 *
 * One resolved nudge, already worded, already deduped, already checked against
 * suppression. A channel's job is to say it in its own register — a push
 * notification, a sentence read aloud in the kitchen, a phone call, an SMS —
 * and NEVER to re-derive whether it should be said. That decision belongs to
 * lib/reminders/due.ts and is made once, so that adding a fifth channel cannot
 * add a fifth opinion about whether a paused habit deserves a nudge.
 *
 * `items` is on the payload for the channels that speak a list rather than show
 * one: a speaker reading "reading, vitamins and stretching are still open" needs
 * the names, and a channel that had to look them up would need the store, the
 * suppression context and the timezone — i.e. all of the scan, again.
 */

/**
 * Every kind of nudge the scan sends. `eod` is the end-of-day review's
 * invitation, folded into the scan from its own cron route; it is about the
 * day as a whole, never an item, so it carries no `itemId` and no `items`.
 */
export type NudgeKind = 'cue' | 'last-call' | 'eod'

/**
 * The kinds an outward channel takes when the user has not listed any: the
 * habit reminders, and nothing else.
 *
 * Explicit rather than "blank means every kind", which is what voice and SMS
 * used to read a blank `kinds` as. That reading was harmless while there were
 * two kinds, and it is a trap the moment there is a third: widening NudgeKind
 * would have texted "How'd today go?" to every SMS user and read it aloud in
 * every kitchen, without anyone deciding either. A new kind now reaches those
 * channels only by being added here: a user's own `kinds` can narrow this list
 * and never widen it (channelKinds below). The EOD review is push only
 * (memory/plans/reminders-platforms.md §7, decision 12).
 */
export const REMINDER_KINDS: readonly NudgeKind[] = ['cue', 'last-call']

/**
 * The kinds an outward channel (voice, SMS, a call) takes, from what the user
 * typed into its `kinds` field: the ones listed, narrowed to REMINDER_KINDS,
 * or `fallback` when nothing is listed.
 *
 * Narrowed, never widened. The field is free text, and a list is there to
 * quiet a channel ("last-call" alone keeps a house silent all day), not to add
 * a kind the channel has no words for. Typed into Speak, "eod" would read the
 * review out through spokenLine, which has no branch for it and says "End of
 * day 🌙. After How'd today go?."; typed into Call me for, it would ring at
 * the review's hour to say it twice. Decision 12 kept the review on push, and
 * its alternative (opting a channel in) starts with that copy, not here.
 */
export function channelKinds(
  listed: readonly string[],
  fallback: readonly NudgeKind[] = REMINDER_KINDS,
): readonly NudgeKind[] {
  if (listed.length === 0) return fallback
  return REMINDER_KINDS.filter((kind) => listed.includes(kind))
}

/** The minimum a channel needs to name an item out loud. */
export interface NudgeItem {
  id: string
  title: string
  /** 0 for types with no streak counter. */
  streak: number
}

export interface Nudge {
  kind: NudgeKind
  /** Short line — a notification title, or the first thing a speaker says. */
  title: string
  /** The supporting line. May be empty. */
  body: string
  /** Deep link into dsul for a channel that can carry one. */
  url: string
  /** The user's local day this nudge is about, yyyy-MM-dd. */
  dateStr: string
  /**
   * The single item this is about, when it is about exactly one. A cue always
   * has it; a last call has it only when one thing is left, which is what lets
   * the last call carry a Done button in that case and not otherwise. The EOD
   * review never has it.
   */
  itemId?: string
  /** Everything the nudge covers. One entry for a cue; none for the EOD review. */
  items: NudgeItem[]
  /** True when this delivery is a matured snooze rather than a first cue. */
  snoozed?: boolean
  /**
   * The instant (epoch milliseconds) this nudge stops being worth delivering:
   * the end of its window, never past the user's local midnight.
   *
   * Set by the scan, the one place that holds the user's clock, so channels
   * never need the user's day. An instant rather than a number of seconds,
   * because seconds have to be counted from somewhere and the tick's start is
   * the wrong place: users are served one after another, each behind a few
   * round trips, so a push for a 23:55 review could leave at 23:55:10 with
   * five minutes on it and be held until 00:00:10. A channel that can hand a
   * message to something that waits for the device (push's TTL header today)
   * turns this into that transport's terms as it sends; one that speaks now
   * (a speaker, a call, a text) has no use for it. Required, so a new kind of
   * nudge cannot reach a channel without someone deciding how long it lasts.
   */
  expiresAtMs: number
}
