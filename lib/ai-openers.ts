/**
 * ai-openers.ts — what Beacon offers instead of an empty box.
 *
 * A blank input is the single most expensive thing this app can put in front of
 * its audience: it demands initiation, which is exactly the executive function
 * the product exists to lend. memory/plans/ai-vision.md calls chat "a hostile
 * primary interface" for that reason and keeps it as an escape hatch — but an
 * escape hatch you cannot start using is not one. So the empty state offers
 * three concrete things to say.
 *
 * They are derived from the planner, not a static list, because a generic
 * suggestion is only marginally better than no suggestion: "What can I let go
 * of?" is a real offer on a day with things sitting past due and noise on a day
 * without any.
 *
 * Pure and store-free, like everything it composes — the caller passes the day
 * and the suppressed ids, the same way lib/proposal.ts and lib/day-items.ts
 * take them.
 *
 * COPY CONTRACT (shared with proposal-card.tsx, morning-check.tsx's `BarCopy`
 * and the "Still waiting" heading in item-registry.ts): no opener may name a
 * failure, count a miss, or imply lateness. "What can I let go of?" is the
 * shape to keep — permission, phrased in the user's own voice, because they are
 * the one about to say it.
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
}

export interface OpenerContext {
  items: readonly Item[]
  /** yyyy-MM-dd, already resolved in the user's zone. */
  todayStr: string
  userTimezone: string
  /** From lib/active.ts `inactiveItemIdsOn` — work a routine or program paused. */
  inactiveIds?: ReadonlySet<string>
}

/** `selectOverdue` requires the set; only this module's callers may omit it. */
const EMPTY_IDS: ReadonlySet<string> = new Set()

/** Three fits a sidebar without becoming a menu to read. */
export const MAX_OPENERS = 3

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
 * Open loops that actually land on `todayStr`.
 *
 * `isOpenLoopOn` answers "does this still want doing", NOT "is it due today" —
 * a pending one-shot dated next Friday passes it. So the date test lives here,
 * and it deliberately mirrors `deriveDayItems` (lib/day-items.ts) rule for
 * rule, because this decides which opener the user is offered and the two
 * disagreeing means Beacon calls a day busy that the grid draws empty.
 *
 * The rule that is easy to miss, and that this got wrong at first: a recurring
 * task-like needs `startDate` AND `startDate <= today`. Recurrence says which
 * WEEKDAYS it lands on, not when the series begins — so a daily task starting
 * in December is "due today" to `shouldShowOnDate` alone, all year before it.
 * And its start day counts even off the repeat (anchoredSeriesOn): a task moved
 * to today is due today.
 */
function openToday(ctx: OpenerContext): Item[] {
  const today = toDateOnly(ctx.todayStr)

  return ctx.items.filter((item) => {
    if (ctx.inactiveIds?.has(item.id)) return false
    // Explicit, not incidental. Subtasks are excluded from every day-scoped
    // surface (selectOverdue, buildProposalContext, the tasks projection); this
    // held here only by the accident that they never carry a date.
    if ('parentItemId' in item && item.parentItemId) return false
    if (!isOpenLoopOn(item, ctx.todayStr)) return false

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

export function buildChatOpeners(ctx: OpenerContext): ChatOpener[] {
  const openers: ChatOpener[] = []
  const today = openToday(ctx)
  const overdue = selectOverdue(ctx.items, ctx.todayStr, ctx.inactiveIds ?? EMPTY_IDS)

  if (today.length >= BUSY_DAY_THRESHOLD) {
    openers.push({
      id: 'triage',
      label: "Today's a lot — what matters?",
      prompt:
        "Today has more on it than I'll get through. Help me work out what actually matters today and what can move.",
    })
  } else if (today.length === 0) {
    openers.push({
      id: 'plan',
      label: 'Help me plan today',
      prompt: "Help me put together a realistic plan for today — small enough that I'll actually do it.",
    })
  }

  if (overdue.length > 0) {
    openers.push({
      id: 'let-go',
      label: 'What can I let go of?',
      prompt:
        'Some things have been sitting for a while. Which of them still matter, and which can I let go of?',
    })
  }

  openers.push(REFLECT)
  return openers.slice(0, MAX_OPENERS)
}
