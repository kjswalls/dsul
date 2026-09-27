import { format } from 'date-fns'
import { getAllItemTypeNames, getItemTypeConfig, itemTypeName } from './item-registry'
import { isOpenLoopSuppressedOn, suppressionLabel, suppressionReason } from './active'
import { toDateStr } from './recurrence'
import { goalProgress, goalRolesByItem, nextMilestoneVisible } from './goals'
import type { Item, Project, Routine, Season, Goal } from './planner-types'

/** Per cause, before the list collapses to a count. */
const MAX_PAUSED_TITLES = 5

/**
 * Builds the Beacon chat context. Each item type contributes its own section
 * via the registry's `ai.renderContextSection` — the per-type presentations
 * (task: date-scoped with Overdue; habit: date-blind, streak-annotated) are
 * pinned there, byte-identical to the pre-unification builder.
 *
 * `focusItemId` (per-item threads) prepends a focused-item section; the base
 * output without it stays byte-identical — the pinned tests parse that shape.
 */
export function buildDsulContext(state: {
  items: Item[]
  projects: Project[]
  focusItemId?: string
  /** Optional: the five test call sites pass bare literals, and the store's value is nullable. */
  userTimezone?: string | null
  /** Live routines, so a routine's pause suppresses its members here too. */
  routines?: Routine[]
  /** Live seasons, same reason — a switched-off season hides its members here too. */
  seasons?: Season[]
  /**
   * Live goals. NOT for suppression — a goal hides nothing — but for the
   * opposite question: asked how something long-running is going, Beacon should
   * answer from progress and the next checkpoint rather than inferring from
   * item titles.
   */
  goals?: Goal[]
}): string {
  const today = new Date()
  // tz first: `todayStr` is compared against pause intervals that isPausedOn
  // resolves in the USER's zone, so deriving the day in the RUNTIME's zone
  // (which is all date-fns `format` can do) made the two disagree across a date
  // boundary — Beacon would answer differently from the grid and the braindump
  // beside it on the pause-start day. Every other surface passes
  // toDateStr(new Date(), tz); this one now does too.
  const tz = state.userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const todayStr = toDateStr(today, tz)
  const lines: string[] = []

  lines.push('## dsul Context')
  lines.push(`Date: ${format(today, 'EEEE, MMMM d yyyy')}`)
  lines.push('')

  if (state.focusItemId) {
    const focus = state.items.find((i) => i.id === state.focusItemId)
    if (focus) {
      const config = getItemTypeConfig(itemTypeName(focus))
      const subtasks = state.items.filter(
        (i) => i.type !== 'habit' && i.parentItemId === focus.id
      )
      lines.push('### Focused item')
      lines.push(
        'This conversation is about ONE item. Prioritize it; the rest of the ' +
          'context is background.'
      )
      lines.push(`- ${focus.title} [id: ${focus.id}] (${config.label}, status: ${focus.status})`)
      if (focus.type !== 'habit') {
        const parts: string[] = []
        if (focus.project) parts.push(`Project: ${focus.project}`)
        if (focus.startDate) parts.push(`Date: ${focus.startDate}`)
        if (focus.priority) parts.push(`Priority: ${focus.priority}`)
        if (focus.assignee) parts.push(`Assigned to: ${focus.assignee} (${focus.aiStatus ?? 'no status'})`)
        if (parts.length > 0) lines.push(`- ${parts.join(' · ')}`)
      }
      // Outside the non-habit branch on purpose: habits carry notes too (they
      // are in habitShape, and the panel renders the field for them), and a
      // per-item thread about a habit is exactly where that context is wanted.
      if (focus.notes) lines.push(`- Notes: ${focus.notes}`)
      // What this item is FOR, when it serves a goal. A per-item thread about
      // "HSK 3 exam" that does not know it is the next checkpoint of Learn
      // Chinese is missing the single most relevant fact about it — and the
      // base output is unchanged for every item that serves none, so the pinned
      // no-focus tests stay byte-exact.
      const roles = goalRolesByItem(state.goals ?? []).get(focus.id) ?? []
      if (roles.length > 0) {
        const said = roles
          .map((r) =>
            r.role === 'milestone'
              ? `a milestone of ${r.goalName}`
              : r.role === 'checkin'
                ? `the check-in for ${r.goalName}`
                : `part of ${r.goalName}`
          )
          .join(', ')
        lines.push(`- Serves: ${said}`)
      }
      if (subtasks.length > 0) {
        lines.push('- Subtasks:')
        subtasks.forEach((s) =>
          lines.push(`  - [${s.status === 'completed' ? 'x' : ' '}] ${s.title} [id: ${s.id}]`)
        )
      }
      lines.push('')
    }
  }

  // Suppressed open loops are filtered HERE, before dispatch — one edit covers
  // task, habit and every hydrated custom type, and it keeps the byte-pinned
  // renderers pure (their output is unchanged for unchanged input).
  //
  // Note this is deliberately NOT applied to the focused-item lookup above:
  // opening a thread on a paused item is explicit intent, and filtering it
  // would leave Beacon unable to see the very item the thread is about — and
  // silently, since an unresolvable focus id just omits the section.
  const activation = {
    userTimezone: tz,
    routines: state.routines,
    seasons: state.seasons,
  }
  // Resolved ONCE and shared with the Paused section below, so the two can
  // never disagree about which items are hidden — the section's whole job is to
  // account for exactly what the sections above dropped.
  const suppressed = state.items.filter((i) => isOpenLoopSuppressedOn(i, todayStr, activation))
  const suppressedIds = new Set(suppressed.map((i) => i.id))

  for (const type of getAllItemTypeNames()) {
    lines.push(
      ...getItemTypeConfig(type).ai.renderContextSection(
        state.items.filter((i) => itemTypeName(i) === type && !suppressedIds.has(i.id)),
        { today, todayStr }
      )
    )
    lines.push('')
  }

  // --- Goals ---
  //
  // ACTIVE goals only, and double-guarded on the RENDERED set the way Paused
  // is: a user whose only goals are achieved would otherwise get a heading over
  // nothing. Emitted only when there is something to say, so every byte-pinned
  // context test stays exact for inputs that have none.
  //
  // The lines are suppression-AWARE even though goals never suppress. An item
  // can sit in a goal and a paused season at once — that is the plan's own
  // headline example — and naming a suppressed milestone as "next" here would
  // recommend the exact work the ### Paused section three lines down forbids.
  // Two contradictory instructions in one prompt is worse than one fewer fact.
  if (state.goals && state.goals.length > 0) {
    const suppressedIds = new Set(suppressed.map((i) => i.id))
    const itemsById = new Map(state.items.map((i) => [i.id, i]))
    const active = state.goals.filter((g) => g.state === 'active')
    const goalLines: string[] = []
    for (const goal of active) {
      const { achieved, total } = goalProgress(goal, itemsById)
      const parts: string[] = [total > 0 ? `${achieved}/${total} milestones` : 'no milestones yet']
      // ADVANCE past a suppressed milestone rather than dropping the line.
      // Skipping the candidate and taking the next one is what the plan asks
      // for; dropping it left a goal reading "0/2 milestones" with no name for
      // either, and a future-dated second milestone appears in no other section
      // — so Beacon was told the goal exists and given nothing to say about it.
      const next = nextMilestoneVisible(goal, itemsById, suppressedIds)
      if (next) {
        const when = 'startDate' in next && next.startDate ? ` by ${next.startDate}` : ''
        parts.push(`next: ${next.title}${when}`)
      }
      if (goal.targetOn) parts.push(`target ${goal.targetOn}`)
      goalLines.push(`- ${goal.name} — ${parts.join(' · ')}`)
      // The WHY, indented under its goal. It is the one line the user wrote
      // about why any of this matters, and it is what lets an answer be about
      // the point rather than the schedule.
      if (goal.why) goalLines.push(`  why: ${goal.why}`)
    }
    if (goalLines.length > 0) {
      // NOT '### Goals'. A user may define a custom item TYPE whose plural is
      // "Goals" — the registry renders one section per hydrated type as
      // `### ${labelPlural}` — and two identical headings in one prompt, one
      // listing items and one listing containers, is worse than a longer name.
      lines.push('### Long-term goals')
      lines.push(
        'What the work is FOR. A goal hides nothing and is never overdue — do ' +
          'not treat a missed milestone as a failure or suggest abandoning one.'
      )
      lines.push(...goalLines)
      lines.push('')
    }
  }

  // --- Paused ---
  //
  // Filtering suppressed work out of the sections above is right — Beacon must
  // not plan around a habit the user put down for the summer. But silence has
  // its own failure mode: asked "what happened to my gym habit?", Beacon could
  // only answer from an absence, and the fluent thing to say about an absence
  // is that it was finished, dropped, or never existed. All three are wrong,
  // and the last two invite the repair (recreate it) that duplicates the row.
  //
  // So the work is named, with its cause, under a heading that says plainly it
  // is not a backlog. Emitted only when something IS suppressed, which keeps
  // the byte-pinned context tests exact for every input that has none.
  if (suppressed.length > 0) {
    const byCause = new Map<string, string[]>()
    for (const item of suppressed) {
      const reason = suppressionReason(item, todayStr, activation)
      if (!reason) continue
      const label = suppressionLabel(reason, { long: true })
      const titles = byCause.get(label)
      if (titles) titles.push(item.title)
      else byCause.set(label, [item.title])
    }
    if (byCause.size > 0) {
      lines.push('### Paused')
      lines.push(
        'Deliberately set aside — NOT overdue, not missed, and not on the lists ' +
          'above. Do not suggest these, schedule them, or count them as slipping. ' +
          'They come back on their own.'
      )
      for (const [label, titles] of byCause) {
        // Titles, not just a count: "3 items are away" cannot answer a question
        // about one of them by name, which is the question this section exists
        // for. Capped so a large season cannot crowd out the live list.
        const shown = titles.slice(0, MAX_PAUSED_TITLES).join(', ')
        const rest = titles.length - MAX_PAUSED_TITLES
        lines.push(`- ${label} (${titles.length}): ${shown}${rest > 0 ? `, +${rest} more` : ''}`)
      }
      lines.push('')
    }
  }

  // --- Projects ---
  lines.push('### Projects')
  if (state.projects.length === 0) {
    lines.push('No projects.')
  } else {
    lines.push(state.projects.map((p) => p.name).join(', '))
  }

  return lines.join('\n')
}
