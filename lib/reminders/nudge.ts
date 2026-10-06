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

export type NudgeKind = 'cue' | 'last-call'

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
   * the last call carry a Done button in that case and not otherwise.
   */
  itemId?: string
  /** Everything the nudge covers. One entry for a cue. */
  items: NudgeItem[]
  /** True when this delivery is a matured snooze rather than a first cue. */
  snoozed?: boolean
  /**
   * How long from now this nudge is still worth delivering, in seconds: what
   * is left of its window, never past the user's local midnight.
   *
   * Set by the scan, the one place that holds the user's clock, so channels
   * stay clock-free. A channel that can hand a message to something that waits
   * for the device (push's TTL header today) says it in that transport's terms;
   * one that speaks now (a speaker, a call, a text) has no use for it. Required,
   * so a new kind of nudge cannot reach a channel without someone deciding how
   * long it lasts.
   */
  expiresInSeconds: number
}
