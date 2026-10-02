/**
 * ask-home.ts — what Ask home says, worked out: the greeting, the day's load,
 * what needs you, and the AI's recent activity.
 *
 * Pure and client-safe (tests/unit/ai-server-boundary.test.ts): the caller
 * passes the clock, the day and the stores' rows, so every line can be pinned
 * by a test over a matrix of inputs. Every number on Ask home comes from data
 * the client already holds, or from one narrow refetch
 * (hooks/use-agent-freshness.ts); nothing here asks the server anything.
 *
 * COPY CONTRACT (lib/ai-openers.ts, shared with proposal-card.tsx, morning-
 * check's `BarCopy` and agent-status.ts). The load line in particular never
 * names a miss, implies lateness, or counts what is undone against the user:
 * no "left", no "yet", no "still", no "more" without a time. It says what the
 * day holds, as a total, and what is done; the hours free are offered only
 * when the user has said when their day ends (the end-of-day review's time),
 * because a bedtime the app made up would be a judgement, not a fact.
 */

import { assigneeLabel } from './chat-utils'
import { agentStatusView, isAgentState } from './agent-status'
import { openToday, todaysItems, type OpenerContext } from './ai-openers'
import { isDoneOn, isTaskLike } from './item-verbs'
import { toDateStr } from './recurrence'
import type { ConversationSummary } from './conversation-types'
import type { Item } from './planner-types'

// ── Greeting ─────────────────────────────────────────────────────────────────

export type DayPart = 'morning' | 'afternoon' | 'evening'

/** 04:00–11:59 morning, 12:00–16:59 afternoon, otherwise evening. */
export function dayPart(minutes: number): DayPart {
  if (minutes >= 4 * 60 && minutes < 12 * 60) return 'morning'
  if (minutes >= 12 * 60 && minutes < 17 * 60) return 'afternoon'
  return 'evening'
}

const DAY_PART_WORD: Record<DayPart, string> = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
}

/** Longer than this, a "first name" is a handle or an address, and is left out. */
const MAX_NAME_CHARS = 24

/**
 * The name a greeting uses: the first word of the account's display name. No
 * fallback to the email's local part: "Morning, itstoughbeingkirby" is worse
 * than "Morning".
 */
export function greetingName(displayName: string | null | undefined): string | null {
  const first = displayName?.trim().split(/\s+/)[0]
  return first && first.length <= MAX_NAME_CHARS ? first : null
}

/**
 * "Morning, Kirby"; "Morning" with no name; "Hello" before the clock is known
 * (only through hydration, which Ask never mounts during). The caller adds the
 * period Ask home's line carries; a new chat's does not.
 */
export function greeting(minutes: number | null, displayName: string | null): string {
  const word = minutes === null ? 'Hello' : DAY_PART_WORD[dayPart(minutes)]
  const name = greetingName(displayName)
  return name ? `${word}, ${name}` : word
}

// ── The day's load ───────────────────────────────────────────────────────────

export interface DayLoad {
  /** Today's open items: the openers' own definition (lib/ai-openers.ts `openToday`). */
  open: number
  /** Today's items done today. Skipped and cancelled ones count as neither. */
  done: number
  /** Minutes planned across the open items; null unless at least half have a duration and they total 30 or more. */
  plannedMin: number | null
  /** The day's end less now less `plannedMin`; null without a day's end, or under 30. */
  freeMin: number | null
}

/** Under this, "planned" and "free" are noise, not a shape for the day. */
export const LOAD_FLOOR_MIN = 30

function durationOf(item: Item): number {
  const d = (item as { duration?: number }).duration
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 0
}

/**
 * What today holds, by the openers' own day (`todaysItems`), so the load line
 * and the chips can never disagree about it: subtasks and paused work are out,
 * exactly as they are there.
 *
 * `plannedMin` needs at least half the open items to carry a duration: a sum
 * over the two of eight that have one would call an eight-thing day "About 1h
 * planned". `freeMin` needs `dayEndMin`, which is the end-of-day review's time
 * while the review is on (`dayEndFromReview`) and null otherwise.
 */
export function dayLoad(
  ctx: OpenerContext,
  o: { minutesNow: number; dayEndMin: number | null }
): DayLoad {
  const open = openToday(ctx)
  const done = todaysItems(ctx).filter((item) => isDoneOn(item, ctx.todayStr)).length

  const timed = open.filter((item) => durationOf(item) > 0)
  const total = timed.reduce((sum, item) => sum + durationOf(item), 0)
  const plannedMin =
    open.length > 0 && timed.length * 2 >= open.length && total >= LOAD_FLOOR_MIN ? total : null

  const free = plannedMin !== null && o.dayEndMin !== null ? o.dayEndMin - o.minutesNow - plannedMin : null
  const freeMin = free !== null && free >= LOAD_FLOOR_MIN ? free : null

  return { open: open.length, done, plannedMin, freeMin }
}

/**
 * "45m" under an hour; from an hour up, to the half hour: "5h", "5.5h". Not
 * "5½h", which a screen reader says as "five one half h".
 */
export function formatLoadMinutes(minutes: number): string {
  const m = Math.round(minutes)
  if (m < 60) return `${m}m`
  const hours = Math.round(m / 30) / 2
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
}

/**
 * The line under the greeting: the first that applies.
 *
 *   planned and free   "About 5h planned, 6h free."
 *   planned            "About 5h planned."
 *   anything open      "8 things today · 2 done."  (the TOTAL, open + done)
 *   only done          "2 done today."
 *   nothing            null: no line
 *
 * The total, not the open count: "6 things today · 2 done" reads as four
 * left, and Notepad's status bar counts the same day as "8 items · 2 done"
 * in the same window.
 */
export function loadLine(load: DayLoad): string | null {
  if (load.plannedMin !== null && load.freeMin !== null) {
    return `About ${formatLoadMinutes(load.plannedMin)} planned, ${formatLoadMinutes(load.freeMin)} free.`
  }
  if (load.plannedMin !== null) return `About ${formatLoadMinutes(load.plannedMin)} planned.`
  if (load.open > 0) {
    const total = load.open + load.done
    const things = total === 1 ? 'thing' : 'things'
    return `${total} ${things} today${load.done > 0 ? ` · ${load.done} done` : ''}.`
  }
  if (load.done > 0) return `${load.done} done today.`
  return null
}

/**
 * Where the day ends, for "free": the end-of-day review's time, only while the
 * review is on (it is off by default). With it off there is no day's end, and
 * dsul never invents one.
 */
export function dayEndFromReview(enabled: boolean, time: string | null | undefined): number | null {
  if (!enabled || !time) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

// ── Needs you ────────────────────────────────────────────────────────────────

/** An item an agent holds: task-shaped, with an assignee. */
export type AgentItem = Exclude<Item, { type: 'habit' }>

function stampOf(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}

/**
 * The items an agent is waiting on the user for (`blocked`), longest-waiting
 * first. One with no stamp predates the stamp column, so it has waited longest
 * of all and leads.
 */
export function needsYou(items: readonly Item[]): AgentItem[] {
  return items
    .filter((item): item is AgentItem => isTaskLike(item) && !!item.assignee && item.aiStatus === 'blocked')
    .sort((a, b) => stampOf(a.aiStatusAt) - stampOf(b.aiStatusAt))
}

// ── With AI activity ─────────────────────────────────────────────────────────

/** How long a finished or failed run stays in the list. */
export const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000

/** Rows at most: a glance, not a log. History is one tap away for the rest. */
export const MAX_ACTIVITY_ROWS = 5

export type ActivityRow =
  | {
      kind: 'agent'
      itemId: string
      title: string
      /**
       *   working  queued or working: a spinner, "OpenClaw · 12m"
       *   quiet    the same, gone quiet past AGENT_QUIET_AFTER_MS: no spinner
       *   back     done in the last 24h: the lime dot, "back"
       *   failed   failed in the last 24h: "Couldn't finish"
       */
      state: 'working' | 'quiet' | 'back' | 'failed'
      /** The right-hand side, already worded. */
      meta: string
      at: number
    }
  | {
      kind: 'conversation'
      conversationId: string
      /** The item it is about, or null for a general conversation. */
      itemId: string | null
      /** Its item is done today (☑, as History draws it); false for a general one. */
      done: boolean
      title: string
      /** Its last message; the row shows it as a clock time. */
      at: number
    }

/**
 * The AI's recent work, newest first, at most MAX_ACTIVITY_ROWS: runs in
 * flight, runs that came back or failed in the last 24h, and conversations
 * that moved today.
 *
 *  - An item shows once. With a run and a conversation today, it is the run.
 *  - A blocked item is not repeated here: it is in Needs you.
 *  - `hasAgentState` is not the test: it hides `done` on purpose, which is a
 *    rule for rows on the grid, not for a list of what came back.
 *  - An item conversation is titled with the item's live title while the item
 *    exists, else the title it was saved with.
 */
export function activityRows(input: {
  items: readonly Item[]
  conversations: readonly ConversationSummary[]
  now: number
  todayStr: string
  userTimezone: string
}): ActivityRow[] {
  const { items, now } = input
  const rows: ActivityRow[] = []
  const shown = new Set<string>()
  const waiting = new Set<string>()

  for (const item of items) {
    if (!isTaskLike(item) || !item.assignee || !isAgentState(item.aiStatus)) continue
    const state = item.aiStatus
    if (state === 'blocked') {
      waiting.add(item.id)
      continue
    }
    const at = stampOf(item.aiStatusAt)
    const who = assigneeLabel(item.assignee)
    if (state === 'queued' || state === 'working') {
      const view = agentStatusView(item, now)
      const stalled = !!view?.stalled
      rows.push({
        kind: 'agent',
        itemId: item.id,
        title: item.title,
        state: stalled ? 'quiet' : 'working',
        meta: stalled ? (view?.label ?? 'Gone quiet') : view?.elapsed ? `${who} · ${view.elapsed}` : who,
        at,
      })
      shown.add(item.id)
      continue
    }
    // Done and failed: only with a stamp, and only for a day. No stamp is no
    // evidence that it was recent.
    if (!at || now - at > ACTIVITY_WINDOW_MS) continue
    rows.push({
      kind: 'agent',
      itemId: item.id,
      title: item.title,
      state: state === 'done' ? 'back' : 'failed',
      meta: state === 'done' ? 'back' : (agentStatusView(item, now)?.label ?? "Couldn't finish"),
      at,
    })
    shown.add(item.id)
  }

  const byId = new Map(items.map((item) => [item.id, item]))
  // Today's, newest first, so an item with two conversations today shows the
  // one that moved last.
  const today = input.conversations
    .map((c) => ({ c, at: Date.parse(c.lastMessageAt) }))
    .filter(({ at }) => Number.isFinite(at) && toDateStr(new Date(at), input.userTimezone) === input.todayStr)
    .sort((a, b) => b.at - a.at)
  for (const { c, at } of today) {
    if (c.itemId && (shown.has(c.itemId) || waiting.has(c.itemId))) continue
    const item = c.itemId ? byId.get(c.itemId) : undefined
    rows.push({
      kind: 'conversation',
      conversationId: c.id,
      itemId: c.itemId,
      done: !!item && isDoneOn(item, input.todayStr),
      title: item?.title.trim() || c.title,
      at,
    })
    if (c.itemId) shown.add(c.itemId)
  }

  return rows.sort((a, b) => b.at - a.at).slice(0, MAX_ACTIVITY_ROWS)
}
