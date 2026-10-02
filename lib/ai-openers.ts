/**
 * ai-openers.ts — what Beacon offers instead of an empty box.
 *
 * A blank input is the single most expensive thing this app can put in front of
 * its audience: it demands initiation, which is exactly the executive function
 * the product exists to lend. memory/plans/ai-vision.md calls chat "a hostile
 * primary interface" for that reason and keeps it as an escape hatch — but an
 * escape hatch you cannot start using is not one. So the empty state offers
 * concrete things to say: two on Ask home, four on a new chat.
 *
 * They are derived from the planner and the hour, not a static list, because a
 * generic suggestion is only marginally better than no suggestion: "What's been
 * sitting?" is a real offer on a day with things sitting past due and noise on
 * a day without any, and "Plan my day" at nine at night is a day mostly gone.
 *
 * Pure and store-free, like everything it composes — the caller passes the day,
 * the clock and the suppressed ids, the same way lib/proposal.ts and
 * lib/day-items.ts take them.
 *
 * COPY CONTRACT (shared with proposal-card.tsx, morning-check.tsx's `BarCopy`
 * and the "Still waiting" heading in item-registry.ts): no opener may name a
 * failure, count a miss, or imply lateness. "What's been sitting?" is the
 * shape to keep — permission, phrased in the user's own voice, because they are
 * the one about to say it. Ask home's load line (lib/ask-home.ts) joins it.
 */

import { isOpenLoopOn } from './active'
import { getItemTypeConfig, itemTypeName } from './item-registry'
import { selectOverdue, toDateOnly } from './overdue'
import { anchoredSeriesOn, isRecurring, shouldShowOnDate } from './recurrence'
import type { Item } from './planner-types'

export interface ChatOpener {
  /** Stable across renders and states — used as the React key and in tests. */
  id: string
  /** Chip text. Short enough for a narrow sidebar, and phrased as the user. */
  label: string
  /** What is actually sent, which can afford to be longer than the chip. */
  prompt: string
  /**
   * 'send' (the default): a tap sends `prompt`. 'prefill': a tap puts `prompt`
   * in the box and focuses it, and sends nothing ("Help me start…" is the start
   * of a sentence only the user can finish).
   */
  mode?: 'send' | 'prefill'
}

/**
 * What a surface asks for. EVERY caller passes these: how many chips fit is the
 * surface's to say (two on Ask home, three and "Help me start…" on a new chat),
 * and which ones are offered depends on the hour, which only the caller's clock
 * knows. There is no default, so no surface gets another's count by omission.
 */
export interface OpenerOptions {
  /** How many candidates to take, before `start`. */
  max: number
  /** The wall clock in the user's zone, minutes since midnight (lib/use-now-minutes.ts). */
  minutesNow: number
  /** Append "Help me start…" (a prefill) after the `max` taken. */
  includeStart?: boolean
}

export interface OpenerContext {
  items: readonly Item[]
  /** yyyy-MM-dd, already resolved in the user's zone. */
  todayStr: string
  userTimezone: string
  /** From lib/active.ts `inactiveItemIdsOn` — work a routine or season paused. */
  inactiveIds?: ReadonlySet<string>
}

/** `selectOverdue` requires the set; only this module's callers may omit it. */
const EMPTY_IDS: ReadonlySet<string> = new Set()

/** Ask home: two, under everything else it shows (the approved mock 1). */
export const HOME_OPENERS = 2

/** A new chat's empty state: three, then "Help me start…" as a fourth (mock 6). */
export const NEW_CHAT_OPENERS = 3

/**
 * Where the day turns from "what's today" to "what's tomorrow": from 16:00 the
 * offers look back at today and ahead to tomorrow instead of planning a day
 * that is mostly gone.
 */
export const EVENING_FROM_MIN = 16 * 60

/**
 * At what point today reads as "a lot".
 *
 * Deliberately a plain count and deliberately low. This does not gate anything
 * destructive — it picks which of two friendly sentences to offer — so the cost
 * of being wrong is one slightly-off suggestion, and the audience this is for
 * hits overwhelm well before a nominally full day.
 */
export const BUSY_DAY_THRESHOLD = 6

/**
 * Everything that lands on `todayStr`, open or not: the day as the grid draws
 * it. `openToday` is this less what is already discharged; Ask home's load line
 * (lib/ask-home.ts) counts both halves, so "8 things today · 2 done" and the
 * openers can never disagree about what "today" holds.
 *
 * The date test deliberately mirrors `deriveDayItems` (lib/day-items.ts) rule
 * for rule, because this decides which opener the user is offered and the two
 * disagreeing means the AI calls a day busy that the grid draws empty.
 *
 * The rule that is easy to miss, and that this got wrong at first: a recurring
 * task-like needs `startDate` AND `startDate <= today`. Recurrence says which
 * WEEKDAYS it lands on, not when the series begins — so a daily task starting
 * in December is "due today" to `shouldShowOnDate` alone, all year before it.
 * And its start day counts even off the repeat (anchoredSeriesOn): a task moved
 * to today is due today.
 *
 * `inactiveIds` holds only suppressed OPEN loops (lib/active.ts: suppression
 * hides open loops, never history), so a paused habit already ticked today
 * still counts here, as done.
 */
export function todaysItems(ctx: OpenerContext): Item[] {
  const today = toDateOnly(ctx.todayStr)

  return ctx.items.filter((item) => {
    if (ctx.inactiveIds?.has(item.id)) return false
    // Explicit, not incidental. Subtasks are excluded from every day-scoped
    // surface (selectOverdue, buildProposalContext, the tasks projection); this
    // held here only by the accident that they never carry a date.
    if ('parentItemId' in item && item.parentItemId) return false

    // Date-blind types (habits) carry no startDate at all — recurrence alone
    // decides, exactly as the grid's habit filter does.
    if (!getItemTypeConfig(itemTypeName(item)).dateAnchored) {
      return isRecurring(item) && shouldShowOnDate(item, ctx.todayStr, ctx.userTimezone)
    }

    if (!('startDate' in item) || !item.startDate) return false
    const start = toDateOnly(item.startDate)
    if (isRecurring(item)) {
      return anchoredSeriesOn(item, start, today, ctx.userTimezone)
    }
    return start === today
  })
}

/**
 * Open loops that actually land on `todayStr`.
 *
 * `isOpenLoopOn` answers "does this still want doing", NOT "is it due today" —
 * a pending one-shot dated next Friday passes it. So the date test is
 * `todaysItems`, and this keeps only what is still open there.
 */
export function openToday(ctx: OpenerContext): Item[] {
  return todaysItems(ctx).filter((item) => isOpenLoopOn(item, ctx.todayStr))
}

/**
 * The one opener that is always available, and always last.
 *
 * Everything above it depends on the planner having something in it. A brand
 * new account, or a genuinely clear day, still gets an offer — and this is the
 * one that works when nothing else is true.
 */
const REFLECT: ChatOpener = {
  id: 'reflect',
  label: "How's this week going?",
  prompt: "How's this week going? Give me an honest read — I'd rather hear it straight than be cheered on.",
}

/** "Help me start…": the start of a sentence, put in the box for the user to finish. */
const START: ChatOpener = {
  id: 'start',
  label: 'Help me start…',
  prompt: 'Help me start ',
  mode: 'prefill',
}

/**
 * The candidates in order of preference; the first `o.max` that apply are
 * offered, then "Help me start…" when the surface asks for it.
 *
 * The hour decides the first offer. Before 16:00 it is about today: plan it
 * while it is not busy, triage it once it is (never both: they contradict each
 * other). From 16:00 it is about tomorrow and a look back at today. Whatever
 * has been sitting is offered at any hour, and the reflective one is always
 * there, because a brand new account has nothing else to offer.
 */
export function buildChatOpeners(ctx: OpenerContext, o: OpenerOptions): ChatOpener[] {
  const openers: ChatOpener[] = []
  const evening = o.minutesNow >= EVENING_FROM_MIN
  const overdue = selectOverdue(ctx.items, ctx.todayStr, ctx.inactiveIds ?? EMPTY_IDS)

  if (!evening) {
    if (openToday(ctx).length >= BUSY_DAY_THRESHOLD) {
      openers.push({
        id: 'triage',
        label: "Today's a lot — what matters?",
        prompt:
          "Today has more on it than I'll get through. Help me work out what actually matters today and what can move.",
      })
    } else {
      openers.push({
        id: 'plan',
        label: 'Plan my day',
        prompt: "Help me put together a realistic plan for today — small enough that I'll actually do it.",
      })
    }
  } else {
    openers.push({
      id: 'plan-tomorrow',
      label: 'Plan tomorrow',
      prompt: "Help me set up tomorrow: a realistic plan I'll actually want to start.",
    })
  }

  if (overdue.length > 0) {
    // The id is the old label's ("What can I let go of?"), kept stable for
    // tests and keys. The offer is the same permission, asked as a question
    // about the pile rather than about the user.
    openers.push({
      id: 'let-go',
      label: "What's been sitting?",
      prompt:
        'Some things have been sitting for a while. Which of them still matter, and which can I let go of?',
    })
  }

  if (evening) {
    openers.push({
      id: 'review',
      label: 'Review today',
      prompt:
        "Let's look back at today together: what got done, and what I want to carry into tomorrow.",
    })
  }

  openers.push(REFLECT)
  const taken = openers.slice(0, Math.max(0, o.max))
  return o.includeStart ? [...taken, START] : taken
}
