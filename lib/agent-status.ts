/**
 * agent-status.ts — how a delegated item's state reads on a row.
 *
 * Pure and store-free, like every other derivation the row layer uses. The
 * elapsed part is the whole reason this exists: "working" is not information,
 * "working for three hours" is. An agent four minutes into a task is fine; the
 * same agent three hours in has died somewhere and nobody would otherwise know
 * until they opened the item.
 *
 * COPY CONTRACT (shared with proposal-card.tsx, ai-openers.ts, morning-check's
 * `BarCopy`): nothing here names a failure of the USER's. `blocked` is the one
 * state that wants something from them, and it says so as a request — "needs
 * you" — not as a reprimand for not having noticed.
 */

/** The write vocabulary, frozen alongside the agent API. */
export type AgentState = 'queued' | 'working' | 'blocked' | 'done' | 'failed'

export interface AgentStatusView {
  /** Short label for the row. */
  label: string
  /**
   * The one state that wants something FROM the user, and the only one that
   * earns emphasis. Everything else is the agent's business, not theirs.
   */
  needsUser: boolean
  /** Whether the work is still live — a spinner is honest only while it is. */
  active: boolean
  /**
   * The run has said nothing for long enough that it has probably died.
   *
   * A DISPLAY heuristic, never a trigger: it marks the row and offers the user
   * a manual re-queue, and nothing automatic reads it. An automatic requeue
   * would be a double-run generator — nothing claims work atomically, so a
   * timer that re-queued a run which was merely slow would put two workers on
   * one task, and the second would overwrite the first's report.
   */
  stalled: boolean
  /**
   * The user could usefully step in — the run has gone quiet, or it reported a
   * failure. ONE definition, because the panel had grown its own
   * `stalled || aiStatus === 'failed'`, which meant the row's marker and the
   * panel's recovery button disagreed about a failed item.
   */
  recoverable: boolean
  /** "4m", "3h", "2d" — absent when the item carries no stamp. */
  elapsed?: string
  /** Full sentence for the tooltip and for screen readers. */
  detail: string
}

/**
 * How long a live state may go without an update before it reads as dead.
 *
 * An hour is deliberately generous. A gateway agent doing real research can run
 * for many minutes, and calling a slow run dead invites the user to re-queue
 * work that is still happening — which, with no atomic claim anywhere, is how
 * two workers end up on one task. An hour is several missed cycles on any
 * sensible schedule, so it is past "slow" and into "gone".
 */
export const AGENT_QUIET_AFTER_MS = 60 * 60 * 1000

const LABELS: Record<AgentState, string> = {
  queued: 'Queued',
  working: 'Working',
  blocked: 'Needs you',
  done: 'Done',
  failed: "Couldn't finish",
}

/**
 * Coarse on purpose: this is a glance, not a stopwatch. Seconds would churn the
 * row every render for a number nobody reads, and "3h" carries the entire
 * signal that "3h 14m" does.
 */
export function formatElapsed(fromIso: string, now: number): string | undefined {
  const started = Date.parse(fromIso)
  if (!Number.isFinite(started)) return undefined
  const seconds = Math.floor((now - started) / 1000)
  // A clock skew or a stamp from the future reads as "just now" rather than as
  // a negative number — the row should never show something impossible.
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * True for the states worth putting on a row at all.
 *
 * `Object.hasOwn`, not `in`. The read schema keeps `aiStatus` a loose string on
 * purpose — constraining it to an enum would let a future vocabulary addition
 * brick an old plugin's safeParse — so whatever an agent writes arrives here
 * unchecked. `'toString' in LABELS` is TRUE, and the lookup that followed would
 * have handed React a function to render.
 */
export function isAgentState(value: string | undefined): value is AgentState {
  return value !== undefined && Object.hasOwn(LABELS, value)
}

/**
 * What the row should say, or null when there is nothing worth saying.
 *
 * `done` returns null deliberately — see `hasAgentState`, which owns that rule
 * and every other "is there anything to say" condition, so the clockless
 * predicate and the view can never disagree.
 */
/**
 * Is there anything to say about this item at all?
 *
 * Split out from the view because it is PURE in the strict sense — no clock —
 * which is what lets a component decide whether to mount the ticking half
 * without reading `Date.now()` during render. The two must stay in step, so the
 * view delegates to it rather than repeating the conditions.
 */
export function hasAgentState(item: { aiStatus?: string; assignee?: string }): boolean {
  if (!item.assignee) return false
  if (!isAgentState(item.aiStatus)) return false
  // A row that keeps announcing finished work is the badge equivalent of a
  // notification that will not clear.
  return item.aiStatus !== 'done'
}

export function agentStatusView(
  item: { aiStatus?: string; aiStatusAt?: string; assignee?: string },
  now: number
): AgentStatusView | null {
  if (!hasAgentState(item)) return null

  const state = item.aiStatus as AgentState
  const elapsed = item.aiStatusAt ? formatElapsed(item.aiStatusAt, now) : undefined
  const active = state === 'queued' || state === 'working'

  // Only a LIVE state can go quiet. `blocked` waiting three days is not stalled
  // — it is waiting on the user exactly as designed, and calling that a
  // malfunction would blame them for it. And with no stamp there is no
  // evidence either way, so the honest answer is no.
  const since = item.aiStatusAt ? Date.parse(item.aiStatusAt) : NaN
  const stalled =
    active && Number.isFinite(since) && now - since >= AGENT_QUIET_AFTER_MS

  const label = stalled ? 'Gone quiet' : LABELS[state]

  const detail = stalled
    ? `No update for ${elapsed}, so that run has probably stopped`
    : state === 'blocked'
      ? elapsed
        ? `Waiting on your answer (asked ${elapsed === 'just now' ? 'just now' : `${elapsed} ago`})`
        : 'Waiting on your answer'
      : elapsed
        ? state === 'failed'
          ? `${LABELS[state]} (${elapsed === 'just now' ? 'just now' : `${elapsed} ago`})`
          : `${LABELS[state]} ${elapsed === 'just now' ? 'since just now' : `for ${elapsed}`}`
        : LABELS[state]

  return {
    label,
    needsUser: state === 'blocked',
    active,
    stalled,
    // `queued` is excluded even when stalled: re-queueing something already
    // queued changes nothing except refreshing the stamp, which would hide the
    // very warning the user was responding to. A queued item going quiet means
    // nothing is picking work up at all, and no button on this item fixes that.
    recoverable: (stalled && state === 'working') || state === 'failed',
    elapsed,
    detail,
  }
}
