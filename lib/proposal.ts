/**
 * proposal.ts — validating and describing AI planner proposals.
 *
 * A proposal is a diff the AI suggests and the user accepts with one tap
 * (memory/plans/ai-vision.md). The model producing it is not trusted: it can
 * name a type that does not exist, put a date on a type that is not
 * date-anchored, or invent a status from the wrong vocabulary. Everything it
 * proposes is checked against the type registry here, BEFORE the card is shown,
 * so the user is never offered a change that would fail or corrupt a row.
 *
 * Invalid operations are dropped rather than failing the whole proposal — one
 * hallucinated field should not throw away a good six-item plan.
 */

import { format } from 'date-fns'
import type { Item, Proposal, ProposalDraft, ProposalOperation } from './planner-types'
import { getItemTypeConfig, itemTypeName } from './item-registry'
import { selectOverdue, splitOverdueCohorts } from './overdue'
import { isRecurring } from './recurrence'

export interface ProposalContext {
  items: Item[]
  /** Hydrated custom type slugs (planner-store's itemTypes). */
  customTypeNames: string[]
  /**
   * Ids suppressed today (lib/active.ts `inactiveItemIdsOn`) — work paused by a
   * routine or a season window. Optional here because most proposal work does
   * not need it, but `buildCatchUpProposal` REQUIRES it: offering to drag
   * deliberately-paused work back into today is the app arguing with a decision
   * the user already made.
   */
  inactiveIds?: ReadonlySet<string>
  /**
   * Milestone ids (lib/goals.ts `milestoneItemIds`) — the set every bulk date
   * verb subtracts, because a milestone's `startDate` is not stale scheduling
   * residue, it is the TARGET DATE. `unscheduleTasks`, `moveTasksToDate` and
   * `scheduleItemsAt` all guard it; a proposal that clears a date is the same
   * kind of verb and needs the same guard.
   *
   * Optional because most proposal work never touches a date, but a caller that
   * omits it on a planner WITH goals is one accepted card away from erasing a
   * checkpoint's date — see the refusal below.
   */
  milestoneIds?: ReadonlySet<string>
}

export interface RejectedOperation {
  operation: ProposalOperation
  reason: string
}

export interface ValidatedProposal {
  accepted: ProposalOperation[]
  rejected: RejectedOperation[]
}

const KNOWN_BUILTINS = ['task', 'habit']

/** Types the AI may CREATE: anything that doesn't require a container. */
function canCreateType(typeName: string, ctx: ProposalContext): boolean {
  if (!KNOWN_BUILTINS.includes(typeName) && !ctx.customTypeNames.includes(typeName)) return false
  // "The AI invented you a new daily commitment" is a product decision this
  // version deliberately does not make. Registry-derived, not hardcoded: a
  // streak-keeping type is that kind of commitment. (This used to ask
  // `containerRequired`, which stopped being true of habits on 2026-10-01.)
  return getItemTypeConfig(typeName).counters.streak === false
}

/**
 * Drops operations the registry says are impossible for their target type.
 * Pure — callers pass the current items; nothing here reads a store.
 */
export function validateProposalOperations(
  operations: ProposalOperation[],
  ctx: ProposalContext
): ValidatedProposal {
  const accepted: ProposalOperation[] = []
  const rejected: RejectedOperation[] = []
  const reject = (operation: ProposalOperation, reason: string) =>
    rejected.push({ operation, reason })

  for (const operation of operations) {
    if (operation.kind === 'create') {
      if (!canCreateType(operation.itemType, ctx)) {
        reject(operation, `cannot create items of type "${operation.itemType}"`)
        continue
      }
      const config = getItemTypeConfig(operation.itemType)
      const next = { ...operation }

      // Trimmed and re-read, not just truthiness-checked. `parentItemId: ""`
      // used to slip the whole branch below — so a "step" was created with a
      // blank parent, rendered as a top-level task (the projection filters on
      // `!parentItemId`), kept its scheduling fields, and then failed to
      // persist because Postgres rejects '' as a uuid. The schema now demands
      // min(1), and this makes the invariant local to the validator too, which
      // is what tests and any hand-built operation actually go through.
      if (next.parentItemId !== undefined && !next.parentItemId.trim()) {
        reject(operation, 'parentItemId was blank')
        continue
      }

      if (next.parentItemId) {
        const parent = ctx.items.find((i) => i.id === next.parentItemId)
        if (!parent) {
          reject(operation, 'the item to break down no longer exists')
          continue
        }
        if (!getItemTypeConfig(itemTypeName(parent)).subtasks) {
          // Registry-derived, never a type check: habits set `subtasks: false`
          // because a recurring commitment has no defined pieces, and any
          // future type that says the same is excluded for the same reason.
          reject(operation, `${itemTypeName(parent)} items cannot have subtasks`)
          continue
        }
        if ('parentItemId' in parent && parent.parentItemId) {
          // One level, because one level is all the panel renders. A grandchild
          // would be written to a row nothing displays and nothing can reach.
          reject(operation, 'subtasks cannot themselves be broken down')
          continue
        }
        // A subtask is invisible outside its parent's panel — the same fact
        // that stops an update operation from touching one. Scheduling fields
        // on it would be written and then never shown, so they are dropped
        // rather than rejected: the SUBTASK is the useful part of the
        // operation, and one stray date should not cost it.
        delete next.startDate
        delete next.startTime
        delete next.timeBucket
        accepted.push(next)
        continue
      }

      // A date on a date-blind type would be silently ignored by the grid.
      if (!config.dateAnchored) delete next.startDate
      accepted.push(next)
      continue
    }

    const target = ctx.items.find((i) => i.id === operation.itemId)
    if (!target) {
      reject(operation, 'item no longer exists')
      continue
    }

    // Subtasks live inside their parent's detail surface and are excluded from
    // the tasks projection, so the grid, braindump, buckets and EOD never show
    // them. Rescheduling one would move something the user cannot see, on a day
    // it will not appear — a change with no visible effect and no way to undo
    // it from where they are looking.
    if ('parentItemId' in target && target.parentItemId) {
      reject(operation, 'subtasks are managed inside their parent, not scheduled')
      continue
    }

    const config = getItemTypeConfig(itemTypeName(target))
    const next = { ...operation }

    if (next.status !== undefined) {
      if (!config.allowedStatuses.includes(next.status)) {
        // Status vocabularies are frozen and per-type — 'done' is a habit word,
        // 'completed' is a task word, and neither is translatable into the other.
        reject(operation, `"${next.status}" is not a valid status for ${config.label.toLowerCase()}`)
        continue
      }
      if (ctx.milestoneIds?.has(target.id)) {
        // For a milestone the date IS the commitment — the one piece of a
        // checkpoint that says when it was meant to happen. Nothing in the
        // card would have said so either: `buildProposalContext` emits no
        // goal-membership signal, so the model cannot know, and the line would
        // have read "Ship the beta — move to Braindump" like any other row.
        reject(operation, 'a goal milestone keeps its target date')
        continue
      }
      if (isRecurring(target)) {
        // Recurring items track completion per-DATE in completedDates and never
        // through scalar status — a daily chore is `pending` forever by design.
        // Writing status here would mark the whole series done, and the store's
        // patch path has no way to turn it back into a single date's toggle.
        reject(operation, 'recurring items are completed per-date, not by status')
        continue
      }
    }
    if (!config.dateAnchored && next.startDate != null) delete next.startDate

    // CLEARING a field — locked decision 3's first step, and the reason it was
    // held back: "move it back to the Braindump" has real semantics beyond
    // writing NULL. `unscheduleTask` clears startTime, timeBucket and
    // isScheduled along with the date, and a generic patch that wrote only the
    // date would leave an item the grid cannot place — scheduled, bucketed, and
    // on no day. `applyProposal` now expands it the same way the store's own
    // verb does; this decides only WHETHER it is allowed.
    if (next.startDate === null) {
      // Registry-derived, not a type check. `braindumpEligible` is exactly the
      // question "can this item exist with no date", which is what the
      // Braindump is.
      if (!config.braindumpEligible) {
        reject(operation, `${itemTypeName(target)} items cannot go to the Braindump`)
        continue
      }
      if (ctx.milestoneIds?.has(target.id)) {
        // For a milestone the date IS the commitment — the one piece of a
        // checkpoint that says when it was meant to happen. Nothing in the
        // card would have said so either: `buildProposalContext` emits no
        // goal-membership signal, so the model cannot know, and the line would
        // have read "Ship the beta — move to Braindump" like any other row.
        reject(operation, 'a goal milestone keeps its target date')
        continue
      }
      if (isRecurring(target)) {
        // A recurring series with no start date lands on no day at all — every
        // day-scoped surface requires `startDate <= today` before recurrence is
        // even consulted. The row's own unschedule control does not guard this,
        // but a suggestion the user accepts sight-unseen should not be the way
        // they discover it.
        reject(operation, 'a repeating item cannot be moved to the Braindump')
        continue
      }
    }

    // The bucket is the one field that may NOT be cleared on its own: an item
    // with a date and no bucket is exactly the unplaceable row above, and
    // "clear the bucket" is not a request anyone makes — unscheduling is.
    if (next.timeBucket === null) delete next.timeBucket

    accepted.push(next)
  }

  return { accepted, rejected }
}

/** Convenience wrapper returning a proposal with only its viable operations. */
export function validateProposal(
  proposal: Proposal,
  ctx: ProposalContext
): { proposal: Proposal; rejected: RejectedOperation[] } {
  const { accepted, rejected } = validateProposalOperations(proposal.operations, ctx)
  return { proposal: { ...proposal, operations: accepted }, rejected }
}

// ── Producing proposals ───────────────────────────────────────────────────────

/** The most a single card may ask the user to decide on at once. */
export const MAX_CATCH_UP_OPERATIONS = 5

/**
 * The catch-up proposal, computed locally — no model, no API key, no network.
 *
 * This is the guilt-free reschedule, and it deliberately does not need AI: the
 * hard part was never choosing dates, it was making the pile approachable. So
 * it offers only the RECENT cohort (≤7 days, per lib/overdue.ts) and caps the
 * card at five, because a card listing thirty forgotten things recreates
 * exactly the shame spiral the feature exists to defuse. The long tail is left
 * alone on purpose — it is not hidden, it is simply not today's problem.
 */
export function buildCatchUpProposal(
  ctx: ProposalContext & { todayStr: string; inactiveIds: ReadonlySet<string> }
): ProposalDraft | null {
  const overdue = selectOverdue(ctx.items, ctx.todayStr, ctx.inactiveIds)
  const { recent } = splitOverdueCohorts(overdue, ctx.todayStr)
  const picked = recent.slice(0, MAX_CATCH_UP_OPERATIONS)
  if (picked.length === 0) return null

  const remaining = overdue.length - picked.length
  return {
    summary: picked.length === 1 ? 'Pick one thing back up' : `Pick ${picked.length} things back up`,
    rationale:
      remaining > 0
        ? `Moving these to today. The other ${remaining} can keep waiting. They're not going anywhere.`
        : 'Moving these to today. Nothing else is waiting on you.',
    operations: picked.map((item) => ({
      kind: 'update' as const,
      itemId: item.id,
      startDate: ctx.todayStr,
    })),
  }
}

/**
 * A compact, id-bearing index of the user's actionable items.
 *
 * Separate from buildDsulContext (lib/ai-context.ts) on purpose: that blob is
 * pinned byte-for-byte by tests as Beacon's chat context and carries no ids,
 * but a proposal has to reference items by id to update them.
 */
export function buildProposalContext(
  ctx: ProposalContext & { todayStr: string },
  limit = 60
): string {
  const lines: string[] = ['## Items you can reference (use the bracketed id)']
  const actionable = ctx.items.filter((item) => {
    const config = getItemTypeConfig(itemTypeName(item))
    if (item.status === config.doneStatus || item.status === 'cancelled') return false
    // Not offered to the model at all: validation would reject an operation on
    // one anyway, and a model that can see an item it may not touch will keep
    // proposing it.
    if ('parentItemId' in item && item.parentItemId) return false
    return true
  })

  for (const item of actionable.slice(0, limit)) {
    const typeName = itemTypeName(item)
    const bits = [typeName]
    // Recurrence is emitted because the prompt now states a rule that depends
    // on it ("not available for repeating items"), and a recurring task was
    // byte-identical to a one-shot here — so the model was being asked to obey
    // something it could not see, and the refusal is silent when it fails.
    if (isRecurring(item)) bits.push('repeats')
    if (item.type !== 'habit' && item.startDate) bits.push(item.startDate)
    if (item.timeBucket) bits.push(item.timeBucket)
    // The clock time and length, so a plan (or "Find a time for this", which
    // asks for a time around what is already planned) can see what is booked.
    // A task inside a project block has none of its own: the block's is drawn.
    if (item.startTime && !('inProjectBlock' in item && item.inProjectBlock)) {
      bits.push(item.duration ? `at ${item.startTime} for ${item.duration} min` : `at ${item.startTime}`)
    }
    if (item.type !== 'habit' && item.priority) bits.push(`${item.priority} priority`)
    lines.push(`- [${item.id}] ${item.title} — ${bits.join(', ')}`)
  }

  if (actionable.length === 0) lines.push('(nothing open right now)')
  return lines.join('\n')
}

/** yyyy-MM-dd → "Thu Aug 6", leaving anything unparseable alone. */
function friendlyDate(dateStr: string): string {
  const parsed = new Date(`${dateStr.slice(0, 10)}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? dateStr : format(parsed, 'EEE MMM d')
}

/**
 * One scannable line per operation — the card's whole content.
 *
 * Phrased as what the user gets, not what they failed to do: "Move to Thu Aug 6",
 * never "overdue since Monday". Same copy contract as the "Still waiting"
 * heading in item-registry.ts and BarCopy in components/ai/morning-check.tsx.
 */
export function describeOperation(operation: ProposalOperation, ctx: ProposalContext): string {
  if (operation.kind === 'create') {
    if (operation.parentItemId) {
      const parent = ctx.items.find((i) => i.id === operation.parentItemId)
      // Naming the parent matters when a breakdown card sits beside a plan
      // card: "Step: x" alone does not say what it is a step of.
      return parent ? `${operation.title} (under ${parent.title})` : `Step: ${operation.title}`
    }
    const label = getItemTypeConfig(operation.itemType).label.toLowerCase()
    const when = operation.startDate ? ` for ${friendlyDate(operation.startDate)}` : ''
    return `New ${label}: ${operation.title}${when}`
  }

  const target = ctx.items.find((i) => i.id === operation.itemId)
  const title = target?.title ?? 'this item'
  const parts: string[] = []

  if (operation.title) parts.push(`rename to "${operation.title}"`)
  if (operation.startDate === null) parts.push('move to Braindump')
  else if (operation.startDate) parts.push(`move to ${friendlyDate(operation.startDate)}`)
  if (operation.startTime === null) parts.push('clear the time')
  else if (operation.startTime) parts.push(`set ${operation.startTime}`)
  if (operation.timeBucket) parts.push(`${operation.timeBucket}`)
  if (operation.priority === null) parts.push('clear priority')
  else if (operation.priority) parts.push(`${operation.priority} priority`)
  if (operation.status) {
    const config = target ? getItemTypeConfig(itemTypeName(target)) : null
    parts.push(operation.status === config?.doneStatus ? 'mark done' : `mark ${operation.status}`)
  }

  return parts.length > 0 ? `${title}: ${parts.join(', ')}` : title
}
