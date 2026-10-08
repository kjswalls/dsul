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

/** Ask home: two, under everything else it shows. */
export const HOME_OPENERS = 2

/** A new chat's empty state: three, then "Help me start…" as a fourth. */
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
  prompt: "How's this week going? Give me an honest read. I'd rather hear it straight than be cheered on.",
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
        label: "Today's a lot. What matters?",
        prompt:
          "Today has more on it than I'll get through. Help me work out what actually matters today and what can move.",
      })
    } else {
      openers.push({
        id: 'plan',
        label: 'Plan my day',
        prompt: "Help me put together a realistic plan for today, small enough that I'll actually do it.",
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

/**
 * An opener as a preview: what the setup column (components/ai/rail/
 * ask-setup.tsx) shows someone with nothing connected, so they see what they
 * could ask before connecting anything. The chip's own words, quoted, and one
 * line on what it would do, built from the same planner and hour as Ask's
 * chips, so the preview is what the chip will be once AI answers.
 */
export interface OpenerPreview {
  id: string
  label: string
  description: string
}

/** A title quoted in a description: whole when short, else cut at a word. */
export const PREVIEW_TITLE_MAX = 40

function quoteTitle(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim()
  if (t.length <= PREVIEW_TITLE_MAX) return t
  const cut = t.slice(0, PREVIEW_TITLE_MAX)
  const atWord = cut.lastIndexOf(' ')
  return `${(atWord > PREVIEW_TITLE_MAX / 2 ? cut.slice(0, atWord) : cut).trimEnd()}…`
}

/**
 * Each opener's line, under the COPY CONTRACT above: what it does, never what
 * went undone. `let-go` names one real thing that has been sitting (the first
 * `selectOverdue` returns), so the offer is about the user's own list.
 */
function describe(id: string, sitting: string | null): string {
  switch (id) {
    case 'plan':
      return "Drafts today from what's on it and your braindump. You keep, move or drop each line."
    case 'triage':
      return 'Sorts today into what matters now and what can move to another day.'
    case 'plan-tomorrow':
      return "Drafts tomorrow from what's on it and your braindump. You keep, move or drop each line."
    case 'let-go':
      return sitting
        ? `Goes through things that have waited a while, like “${sitting}”, and helps you keep them or let them go.`
        : 'Goes through things that have waited a while, and helps you keep them or let them go.'
    case 'review':
      return "Looks back at today with you: what got done, and what you'd carry into tomorrow."
    case 'reflect':
      return "An honest read on how your week is going, from what you've done and what's still open."
    default:
      return ''
  }
}

/**
 * The previews for `buildChatOpeners(ctx, o)`, in its order. Never "Help me
 * start…" (`includeStart`): a sentence only the user can finish has nothing
 * to preview.
 */
export function buildOpenerPreviews(ctx: OpenerContext, o: Omit<OpenerOptions, 'includeStart'>): OpenerPreview[] {
  const openers = buildChatOpeners(ctx, { max: o.max, minutesNow: o.minutesNow })
  const first = openers.some((x) => x.id === 'let-go')
    ? selectOverdue(ctx.items, ctx.todayStr, ctx.inactiveIds ?? EMPTY_IDS)[0]
    : undefined
  const sitting = first?.title?.trim() ? quoteTitle(first.title) : null
  return openers.map((x) => ({ id: x.id, label: x.label, description: describe(x.id, sitting) }))
}

/**
 * The tour's last card (components/onboarding/onboarding-tour.tsx): Ask
 * home's first two offers as previews, the same ones the setup column opens
 * on, with shorter lines that fit a coach mark and name the task typed at
 * step 2, so the first thing someone sees AI offer is about their own list.
 *
 * The example is read by id from the planner, never from what was typed: a
 * step 2 that was skipped added nothing, and an item deleted since has
 * nothing to quote. Either way, and for a blank title, the line drops the
 * example rather than quoting nothing. One closing `.`, `!` or `?` comes off
 * the title, so the sentence never ends `“Call the dentist.”.`.
 *
 * Only the lines change. The ids, labels and order are `buildOpenerPreviews`'s,
 * so the card previews exactly the chips Ask home will offer; `triage`,
 * `let-go` and `reflect` keep the column's line, and `let-go` keeps quoting
 * what has been sitting, never the example.
 */
export function buildTourOpenerPreviews(
  ctx: OpenerContext,
  o: { minutesNow: number; exampleId: string | null }
): OpenerPreview[] {
  const item = o.exampleId ? ctx.items.find((i) => i.id === o.exampleId) : undefined
  const bare = (item?.title ?? '').replace(/\s+/g, ' ').trim().replace(/[.!?]$/, '').trim()
  const example = bare ? quoteTitle(bare) : null
  return buildOpenerPreviews(ctx, { max: HOME_OPENERS, minutesNow: o.minutesNow }).map((p) => {
    const line = tourDescribe(p.id, example)
    return line ? { ...p, description: line } : p
  })
}

/** The tour's shorter line for an opener, or null to keep `describe`'s. Same COPY CONTRACT. */
function tourDescribe(id: string, example: string | null): string | null {
  switch (id) {
    case 'plan-tomorrow':
      return example
        ? `Drafts tomorrow from your braindump, like “${example}”.`
        : 'Drafts tomorrow from your braindump.'
    case 'plan':
      return example ? `Drafts today from your braindump, like “${example}”.` : 'Drafts today from your braindump.'
    case 'review':
      return "Looks back at today with you, and what you'd carry into tomorrow."
    default:
      return null
  }
}
