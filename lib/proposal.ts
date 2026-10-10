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
import type {
  Goal,
  Item,
  Project,
  Proposal,
  ProposalContainer,
  ProposalContainerOp,
  ProposalDeleteOp,
  ProposalDraft,
  ProposalMembershipOp,
  ProposalOperation,
  ProposalResetStreakOp,
  ProposalVerbOp,
  Routine,
  Season,
} from './planner-types'
import { CONTAINER_KINDS, sameContainerName } from './container-registry'
import { canBulkClearProject, canBulkSetProject } from './bulk-edit'
import { goalItemIds } from './goals'
import { getItemTypeConfig, isCollectible, isPausable, isSkippable, itemTypeName } from './item-registry'
import { selectOverdue, splitOverdueCohorts } from './overdue'
import { isRecurring } from './recurrence'
import { VERB_GATES, isHabit, occurrenceOn, type VerbContext } from './verb-gates'

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
  /**
   * Wall-clock today and the user's zone, for the verb operations (a tick, a
   * skip, a pause): with them each verb asks its own day gate
   * (lib/verb-gates.ts); without them (the server, which knows no zone) only
   * whether the verb fits the item at all. The browser always passes them,
   * and its check is the one that counts.
   */
  todayStr?: string
  tz?: string
  /**
   * The user's containers, for the container and membership operations.
   * Without it every one of those is refused, since there is nothing to check
   * a name or an id against.
   */
  containers?: ProposalContainers
  /**
   * False when the Streaks extension is off: a reset would change a number the
   * user cannot see. Like goalsEnabled, the browser knows and the server does not.
   */
  streaksEnabled?: boolean
}

export interface ProposalContainers {
  projects: Project[]
  /** Null when the kind cannot be read (its table missing, or a read failed). */
  routines: Routine[] | null
  seasons: Season[] | null
  goals: Goal[] | null
  /**
   * False when the Goals extension is off: a goal made then would be one the
   * user cannot see. The browser knows; the server leaves it out, and the
   * browser's check is the one that counts.
   */
  goalsEnabled?: boolean
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

/**
 * Types the AI (and a recipe, lib/recipes/) may CREATE: a known type that keeps
 * no streak, so neither ever creates a habit. Takes only the custom type names,
 * so a caller with no item list to hand can ask.
 */
export function canCreateType(typeName: string, ctx: Pick<ProposalContext, 'customTypeNames'>): boolean {
  if (!KNOWN_BUILTINS.includes(typeName) && !ctx.customTypeNames.includes(typeName)) return false
  // "The AI invented you a new daily commitment" is a product decision this
  // version deliberately does not make. Registry-derived, not hardcoded: a
  // streak-keeping type is that kind of commitment. (This used to ask
  // `containerRequired`, which stopped being true of habits on 2026-10-01.)
  return getItemTypeConfig(typeName).counters.streak === false
}

/**
 * Types a PROPOSAL may create: any type the user has, habits included. Wider
 * than canCreateType on purpose: a recipe or a mod writes unseen, while a
 * proposal is a card the user reads and accepts, so a new daily commitment is
 * theirs to take or leave (Kirby, 2026-10-10: the AI does anything in the app,
 * each change behind a tap).
 */
export function canProposeType(typeName: string, ctx: Pick<ProposalContext, 'customTypeNames'>): boolean {
  return KNOWN_BUILTINS.includes(typeName) || ctx.customTypeNames.includes(typeName)
}

type RepeatFields = Pick<
  Extract<ProposalOperation, { kind: 'create' }>,
  'repeatFrequency' | 'repeatDays' | 'repeatMonthDay' | 'timesPerDay'
>

/**
 * Why a repeat cannot be written to this type, or null. `merged` is the item
 * as it would stand (the op over the target), so an update that only names the
 * days of an already-custom habit passes. Registry-derived: which frequencies a
 * type takes is `allowedFrequencies` (a habit has no 'none').
 */
function repeatRefusal(
  typeName: string,
  merged: RepeatFields & { startDate?: string | null },
): string | null {
  const config = getItemTypeConfig(typeName)
  const freq = merged.repeatFrequency
  if (freq && !config.allowedFrequencies.includes(freq)) {
    return freq === 'none'
      ? `a ${config.label.toLowerCase()} always repeats`
      : `${config.label.toLowerCase()} items cannot repeat ${freq}`
  }
  if (freq === 'custom' && !merged.repeatDays?.length) return 'a custom repeat needs its days'
  // A repeating series is anchored on its first day: with none it lands on no
  // day at all (the same reason a repeating item cannot go to the Braindump).
  if (config.dateAnchored && freq && freq !== 'none' && !merged.startDate) {
    return 'a repeating item needs a first day'
  }
  return null
}

/** Drops the fields this type does not keep, so a stray one never costs the op. */
function stripForeignFields<T extends Partial<RepeatFields> & { priority?: unknown }>(typeName: string, next: T): void {
  const config = getItemTypeConfig(typeName)
  if (!config.fields.includes('priority')) delete next.priority
  if (!config.counters.dailyCounts) delete next.timesPerDay
  const freq = next.repeatFrequency
  if (freq !== undefined && freq !== 'custom') delete next.repeatDays
  if (freq !== undefined && freq !== 'monthly') delete next.repeatMonthDay
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
      if (!canProposeType(operation.itemType, ctx)) {
        reject(operation, `cannot create items of type "${operation.itemType}"`)
        continue
      }
      const config = getItemTypeConfig(operation.itemType)
      const next = { ...operation }
      stripForeignFields(operation.itemType, next)

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
        // Registry-derived: a type that only repeats (allowedFrequencies has no
        // 'none') has no one-off form to be a step in.
        if (!config.allowedFrequencies.includes('none')) {
          reject(operation, `a step cannot be a ${config.label.toLowerCase()}`)
          continue
        }
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
        // A step has no day, so it has no series either.
        delete next.repeatFrequency
        delete next.repeatDays
        delete next.repeatMonthDay
        accepted.push(next)
        continue
      }

      // A date on a date-blind type would be silently ignored by the grid.
      if (!config.dateAnchored) delete next.startDate
      // A type that only repeats starts on its own default (a habit: daily).
      if (!next.repeatFrequency && !config.allowedFrequencies.includes('none')) {
        next.repeatFrequency = config.defaultFrequency
      }
      const repeat = repeatRefusal(operation.itemType, next)
      if (repeat) {
        reject(operation, repeat)
        continue
      }
      accepted.push(next)
      continue
    }

    if (operation.kind === 'verb') {
      const why = verbRefusal(operation, ctx)
      if (why) reject(operation, why)
      else accepted.push(operation)
      continue
    }

    if (operation.kind === 'container') {
      const checked = checkContainerOp(operation, ctx)
      if (typeof checked === 'string') reject(operation, checked)
      else accepted.push(checked)
      continue
    }

    if (operation.kind === 'membership') {
      const why = membershipRefusal(operation, ctx)
      if (why) reject(operation, why)
      else accepted.push(operation)
      continue
    }

    if (operation.kind === 'delete' || operation.kind === 'resetStreak') {
      const why = operation.kind === 'delete' ? deleteRefusal(operation, ctx) : resetStreakRefusal(operation, ctx)
      if (why) reject(operation, why)
      else accepted.push(operation)
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
    stripForeignFields(itemTypeName(target), next)

    if (
      next.repeatFrequency !== undefined ||
      next.repeatDays !== undefined ||
      next.repeatMonthDay !== undefined
    ) {
      const repeat = repeatRefusal(itemTypeName(target), {
        repeatFrequency: next.repeatFrequency ?? target.repeatFrequency,
        repeatDays: next.repeatDays ?? target.repeatDays,
        startDate: next.startDate === undefined ? ('startDate' in target ? target.startDate : undefined) : next.startDate,
      })
      if (repeat) {
        reject(operation, repeat)
        continue
      }
    }

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

  // A delete or a streak reset is never one tap among others (the design's
  // safety rule 6): it stands only as the card's one change. Asked of what
  // survived, so a delete beside a change that was refused anyway still goes.
  if (accepted.length > 1 && accepted.some(isDestructive)) {
    for (const op of accepted.filter(isDestructive)) {
      reject(op, `${op.kind === 'delete' ? 'a delete' : 'a streak reset'} goes on a card of its own`)
    }
    return { accepted: accepted.filter((op) => !isDestructive(op)), rejected }
  }

  return { accepted, rejected }
}

/** A change that takes something away: a delete, or a streak back to 0. */
export function isDestructive(op: ProposalOperation): op is ProposalDeleteOp | ProposalResetStreakOp {
  return op.kind === 'delete' || op.kind === 'resetStreak'
}

const VERB_WORDS: Record<ProposalVerbOp['verb'], string> = {
  complete: 'marked done',
  skip: 'skipped',
  unskip: 'unskipped',
  pause: 'paused',
  resume: 'resumed',
}

/**
 * Why a verb operation cannot be offered, or null. Asks the verb's own gate
 * (the one every other surface asks) when the day can be known; the structural
 * questions (does it exist, is it a step, can this type be skipped or paused
 * at all) are asked either way.
 */
function verbRefusal(op: ProposalVerbOp, ctx: ProposalContext): string | null {
  const item = ctx.items.find((i) => i.id === op.itemId)
  if (!item) return 'item no longer exists'
  if ('parentItemId' in item && item.parentItemId) return 'subtasks are managed inside their parent, not scheduled'
  if ((op.verb === 'skip' || op.verb === 'unskip') && !isSkippable(item)) {
    return `${getItemTypeConfig(itemTypeName(item)).label.toLowerCase()} items that do not repeat cannot be skipped`
  }
  if ((op.verb === 'pause' || op.verb === 'resume') && !isPausable(item)) {
    return `${getItemTypeConfig(itemTypeName(item)).label.toLowerCase()} items cannot be paused`
  }
  if (op.until !== undefined && op.verb !== 'pause') return 'only a pause has a day it ends'
  if (!ctx.todayStr || !ctx.tz) return null

  // A pause that ends today or earlier is no pause: the row's own picker
  // offers only days still to come.
  if (op.until !== undefined && op.until <= ctx.todayStr) return 'a pause has to end on a day still to come'
  const dateStr = op.date ?? ctx.todayStr
  // A day can be put behind you, or skipped ahead of time, but not done ahead
  // of time: a tick on tomorrow is a streak bumped for something not yet done.
  if (op.verb === 'complete' && dateStr > ctx.todayStr) return 'a day that has not come yet cannot be marked done'
  const vctx: VerbContext = {
    dateStr,
    date: new Date(`${dateStr}T00:00:00`),
    todayStr: ctx.todayStr,
    tz: ctx.tz,
    milestoneIds: ctx.milestoneIds ?? new Set(),
    occurrence: occurrenceOn(item, dateStr, ctx.todayStr, ctx.tz),
  }
  if (VERB_GATES[op.verb](item, vctx)) return null
  return isRecurring(item) && vctx.occurrence === 'absent'
    ? `it does not fall on ${dateStr}`
    : `it cannot be ${VERB_WORDS[op.verb]} ${op.verb === 'pause' || op.verb === 'resume' ? 'now' : `on ${dateStr}`}`
}

// ── Containers ────────────────────────────────────────────────────────────────

/** Which of the op's own fields each kind keeps. */
const CONTAINER_FIELDS: Record<ProposalContainer, readonly ContainerField[]> = {
  project: ['notes'],
  routine: ['notes', 'usualTime'],
  season: ['notes', 'startsOn', 'endsOn'],
  goal: ['why', 'startsOn', 'targetOn'],
}
type ContainerField = 'notes' | 'why' | 'usualTime' | 'startsOn' | 'endsOn' | 'targetOn'
const ALL_CONTAINER_FIELDS: readonly ContainerField[] = ['notes', 'why', 'usualTime', 'startsOn', 'endsOn', 'targetOn']

type AnyContainer = Project | Routine | Season | Goal

/**
 * The planner store's containers as a ProposalContext wants them: a kind whose
 * table is not there yet (`collectionsAvailable`, `goalsAvailable`) reads as
 * unreachable, so a card never offers a write that would vanish on reload.
 */
export function proposalContainersOf(
  state: {
    projects: Project[]
    routines: Routine[]
    seasons: Season[]
    goals: Goal[]
    collectionsAvailable: boolean
    goalsAvailable: boolean
  },
  goalsEnabled?: boolean,
): ProposalContainers {
  return {
    projects: state.projects,
    routines: state.collectionsAvailable ? state.routines : null,
    seasons: state.collectionsAvailable ? state.seasons : null,
    goals: state.goalsAvailable ? state.goals : null,
    goalsEnabled,
  }
}

const kindWord = (kind: ProposalContainer) => CONTAINER_KINDS[kind].label.toLowerCase()

/** The kind's list, or why it cannot be had. */
function containerList(kind: ProposalContainer, ctx: ProposalContext): AnyContainer[] | string {
  const c = ctx.containers
  if (!c) return `${kindWord(kind)}s cannot be checked here`
  if (kind === 'goal' && c.goalsEnabled === false) return 'goals are turned off in Settings'
  const list = kind === 'project' ? c.projects : kind === 'routine' ? c.routines : kind === 'season' ? c.seasons : c.goals
  return list ?? `${kindWord(kind)}s cannot be reached just now`
}

const sameName = (kind: ProposalContainer, a: string, b: string) =>
  kind === 'project' ? sameContainerName('project', a, b) : a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * May this item go into (or come out of) this kind? The same questions the
 * multiselect bar's Move to project and Add to ask (lib/bulk-edit.ts), so a
 * card offers nothing the store would quietly skip.
 */
function joinable(kind: ProposalContainer, item: Item, member = true): boolean {
  if (kind === 'project') return member ? canBulkSetProject(item) : canBulkClearProject(item)
  return isCollectible(item)
}

function holds(kind: ProposalContainer, container: AnyContainer, item: Item): boolean {
  if (kind === 'project') {
    return item.projectId === container.id || (!!item.project && sameContainerName('project', item.project, container.name))
  }
  if (kind === 'goal') return goalItemIds(container as Goal).includes(item.id)
  return (container as Routine | Season).itemIds.includes(item.id)
}

/**
 * The op as it may be applied, or why it cannot. A field the kind does not
 * keep is dropped rather than refused, like an item's, with one kindness: a
 * goal's free text is its `why` and everything else's is `notes`, so a model
 * that wrote the other one has it moved across rather than lost.
 */
function checkContainerOp(op: ProposalContainerOp, ctx: ProposalContext): ProposalContainerOp | string {
  const kind = op.container
  const list = containerList(kind, ctx)
  if (typeof list === 'string') return list
  const next: ProposalContainerOp = { ...op }
  if (kind === 'goal' && next.why === undefined && next.notes !== undefined) next.why = next.notes
  if (kind !== 'goal' && next.notes === undefined && next.why !== undefined) next.notes = next.why
  const keeps = new Set(CONTAINER_FIELDS[kind])
  for (const field of ALL_CONTAINER_FIELDS) if (!keeps.has(field)) delete next[field]
  if (next.name !== undefined) next.name = next.name.trim()
  if (next.name === '') return 'a name cannot be blank'

  const existing = next.containerId ? list.find((c) => c.id === next.containerId) : undefined
  if (next.containerId && !existing) return `no ${kindWord(kind)} has that id`
  if (existing && next.itemIds) {
    return `an existing ${kindWord(kind)}'s members change one at a time, with membership changes`
  }
  if (!existing && !next.name) return `a new ${kindWord(kind)} needs a name`
  if (existing && !next.name && !ALL_CONTAINER_FIELDS.some((f) => next[f] !== undefined)) return 'there is nothing to change'

  if (next.name) {
    const clash = list.find((c) => c.id !== existing?.id && sameName(kind, c.name, next.name!))
    if (clash) return `there is already a ${kindWord(kind)} called "${clash.name}"`
  }

  if (next.usualTime !== undefined) {
    const [h, m] = next.usualTime.split(':').map(Number)
    if (!(h <= 23 && m <= 59)) return 'a usual time is HH:mm on a 24-hour clock'
  }
  const was = existing as Partial<Season & Goal> | undefined
  const startsOn = next.startsOn ?? was?.startsOn
  const endsOn = kind === 'season' ? (next.endsOn ?? was?.endsOn) : kind === 'goal' ? (next.targetOn ?? was?.targetOn) : undefined
  if (startsOn && endsOn && endsOn < startsOn) {
    return kind === 'season' ? 'a season cannot end before it starts' : 'a goal cannot be aimed at a day before it starts'
  }

  if (next.itemIds) {
    const ids = [...new Set(next.itemIds)]
    for (const id of ids) {
      const item = ctx.items.find((i) => i.id === id)
      if (!item) return 'an item it would start with no longer exists'
      if (!joinable(kind, item)) return `"${item.title}" cannot be in a ${kindWord(kind)}`
    }
    next.itemIds = ids
  }
  return next
}

function membershipRefusal(op: ProposalMembershipOp, ctx: ProposalContext): string | null {
  const list = containerList(op.container, ctx)
  if (typeof list === 'string') return list
  const container = list.find((c) => c.id === op.containerId)
  if (!container) return `no ${kindWord(op.container)} has that id`
  const item = ctx.items.find((i) => i.id === op.itemId)
  if (!item) return 'item no longer exists'
  if (!joinable(op.container, item, op.member !== false)) {
    return op.member === false ? `it has to stay in a ${kindWord(op.container)}` : `it cannot be in a ${kindWord(op.container)}`
  }
  const isIn = holds(op.container, container, item)
  if (op.member !== false && isIn) return `it is already in ${container.name}`
  if (op.member === false && !isIn) return `it is not in ${container.name}`
  return null
}

/** The container an op names, for its card line. */
function containerNamed(kind: ProposalContainer, id: string | undefined, ctx: ProposalContext): AnyContainer | undefined {
  if (!id) return undefined
  const list = containerList(kind, ctx)
  return typeof list === 'string' ? undefined : list.find((c) => c.id === id)
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length > 3) return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

function describeContainerOp(op: ProposalContainerOp, ctx: ProposalContext): string {
  const word = kindWord(op.container)
  const extras: string[] = []
  if (op.usualTime) extras.push(`usually at ${op.usualTime}`)
  if (op.startsOn && op.endsOn) extras.push(`${friendlyDate(op.startsOn)} to ${friendlyDate(op.endsOn)}`)
  else if (op.startsOn) extras.push(`from ${friendlyDate(op.startsOn)}`)
  else if (op.endsOn) extras.push(`until ${friendlyDate(op.endsOn)}`)
  if (op.targetOn) extras.push(`by ${friendlyDate(op.targetOn)}`)

  const existing = containerNamed(op.container, op.containerId, ctx)
  if (!op.containerId) {
    const members = (op.itemIds ?? []).map((id) => ctx.items.find((i) => i.id === id)?.title).filter((t): t is string => !!t)
    if (members.length) extras.push(`with ${joinNames(members)}`)
    return `New ${word}: ${op.name ?? ''}${extras.length ? `, ${extras.join(', ')}` : ''}`
  }
  const parts: string[] = []
  if (op.name && op.name !== existing?.name) parts.push(`rename to "${op.name}"`)
  parts.push(...extras)
  if (op.notes !== undefined) parts.push('new notes')
  if (op.why !== undefined) parts.push('new reason why')
  const title = existing ? `${existing.name} (${word})` : `This ${word}`
  return parts.length ? `${title}: ${parts.join(', ')}` : title
}

function describeMembershipOp(op: ProposalMembershipOp, ctx: ProposalContext): string {
  const item = ctx.items.find((i) => i.id === op.itemId)
  const container = containerNamed(op.container, op.containerId, ctx)
  const where = container ? `${container.name}` : `the ${kindWord(op.container)}`
  const title = item?.title ?? 'This item'
  if (op.member === false) return `${title}: take out of ${where}`
  return op.container === 'project' ? `${title}: file under ${where}` : `${title}: add to ${where}`
}

// ── Deletes and streak resets ─────────────────────────────────────────────────

const isStep = (item: Item) => 'parentItemId' in item && !!item.parentItemId

function deleteRefusal(op: ProposalDeleteOp, ctx: ProposalContext): string | null {
  if (op.what === 'item') {
    const item = ctx.items.find((i) => i.id === op.id)
    if (!item) return 'item no longer exists'
    // A step is deleted where it lives, in its task's panel.
    if (isStep(item)) return 'a step is deleted inside its task'
    return null
  }
  const list = containerList(op.what, ctx)
  if (typeof list === 'string') return list
  return list.some((c) => c.id === op.id) ? null : `no ${kindWord(op.what)} has that id`
}

function resetStreakRefusal(op: ProposalResetStreakOp, ctx: ProposalContext): string | null {
  const item = ctx.items.find((i) => i.id === op.itemId)
  if (!item) return 'item no longer exists'
  // The store's reset is the habit's: registry-asked, so a type that keeps no
  // streak is refused by what it is, not by name.
  if (item.type !== 'habit' || !getItemTypeConfig(itemTypeName(item)).counters.streak) return 'only a habit keeps a streak'
  if (ctx.streaksEnabled === false) return 'streaks are turned off in Settings'
  if (!item.streak) return 'its streak is already 0'
  return null
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The members a container holds, for the consequence line. */
function memberCount(kind: ProposalContainer, container: AnyContainer, ctx: ProposalContext): number {
  if (kind === 'project') return ctx.items.filter((i) => !isStep(i) && holds('project', container, i)).length
  if (kind === 'goal') return goalItemIds(container as Goal).length
  return (container as Routine | Season).itemIds.length
}

/**
 * A delete's line says what goes with it and what stays, the way each
 * Organize pane words its own delete: a card the user taps on trust has to
 * carry the consequence itself.
 */
function describeDeleteOp(op: ProposalDeleteOp, ctx: ProposalContext): string {
  const trash = 'It goes to the trash for 30 days.'
  if (op.what === 'item') {
    const item = ctx.items.find((i) => i.id === op.id)
    if (!item) return `Delete this item. ${trash}`
    if (item.type === 'habit') {
      const streak = item.streak ? `, its ${item.streak}-day streak` : ''
      return `Delete the habit "${item.title}"${streak} and its history. ${trash}`
    }
    const steps = ctx.items.filter((i) => 'parentItemId' in i && i.parentItemId === item.id).length
    return `Delete "${item.title}"${steps ? ` and its ${count(steps, 'step')}` : ''}. ${trash}`
  }
  const container = containerNamed(op.what, op.id, ctx)
  const word = kindWord(op.what)
  if (!container) return `Delete this ${word}. ${trash}`
  const n = memberCount(op.what, container, ctx)
  const stays =
    n === 0
      ? ''
      : op.what === 'project'
        ? ` Its ${count(n, 'item')} ${n === 1 ? 'stays' : 'stay'}, in no project.`
        : op.what === 'season'
          ? ` Its ${count(n, 'item')} ${n === 1 ? 'stays' : 'stay'}, no longer waiting on the season.`
          : op.what === 'routine'
            ? ` Its ${count(n, 'item')} ${n === 1 ? 'stays' : 'stay'}, no longer paused together.`
            : ` Its ${count(n, 'item')} ${n === 1 ? 'stays' : 'stay'}.`
  return `Delete the ${word} "${container.name}".${stays} ${trash}`
}

function describeResetStreakOp(op: ProposalResetStreakOp, ctx: ProposalContext): string {
  const item = ctx.items.find((i) => i.id === op.itemId)
  const from = item && 'streak' in item && item.streak ? ` from ${count(item.streak, 'day')}` : ''
  return `Reset the streak on "${item?.title ?? 'this habit'}"${from} to 0. Its history stays: days already ticked stay ticked.`
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

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "daily", "on weekdays", "every Mon and Thu", "monthly on the 5th". */
function repeatWords(r: { repeatFrequency?: string; repeatDays?: number[]; repeatMonthDay?: number }): string {
  switch (r.repeatFrequency) {
    case 'daily':
      return 'daily'
    case 'weekdays':
      return 'on weekdays'
    case 'weekends':
      return 'on weekends'
    case 'monthly':
      return r.repeatMonthDay ? `monthly on the ${ordinal(r.repeatMonthDay)}` : 'monthly'
    case 'custom': {
      const days = [...(r.repeatDays ?? [])].sort((a, b) => a - b).map((d) => DAY_NAMES[d])
      return days.length ? `every ${days.length > 1 ? `${days.slice(0, -1).join(', ')} and ${days.at(-1)}` : days[0]}` : 'on set days'
    }
    default:
      return 'repeating'
  }
}

function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${tail}`
}

/**
 * One scannable line per operation — the card's whole content.
 *
 * Phrased as what the user gets, not what they failed to do: "Move to Thu Aug 6",
 * never "overdue since Monday". Same copy contract as the "Still waiting"
 * heading in item-registry.ts and BarCopy in components/ai/morning-check.tsx.
 */
export function describeOperation(operation: ProposalOperation, ctx: ProposalContext): string {
  if (operation.kind === 'container') return describeContainerOp(operation, ctx)
  if (operation.kind === 'membership') return describeMembershipOp(operation, ctx)
  if (operation.kind === 'delete') return describeDeleteOp(operation, ctx)
  if (operation.kind === 'resetStreak') return describeResetStreakOp(operation, ctx)
  if (operation.kind === 'create') {
    if (operation.parentItemId) {
      const parent = ctx.items.find((i) => i.id === operation.parentItemId)
      // Naming the parent matters when a breakdown card sits beside a plan
      // card: "Step: x" alone does not say what it is a step of.
      return parent ? `${operation.title} (under ${parent.title})` : `Step: ${operation.title}`
    }
    const label = getItemTypeConfig(operation.itemType).label.toLowerCase()
    const when = operation.startDate ? ` for ${friendlyDate(operation.startDate)}` : ''
    const repeat = operation.repeatFrequency && operation.repeatFrequency !== 'none' ? `, ${repeatWords(operation)}` : ''
    const times = operation.timesPerDay && operation.timesPerDay > 1 ? `, ${operation.timesPerDay} times a day` : ''
    return `New ${label}: ${operation.title}${when}${repeat}${times}`
  }

  const target = ctx.items.find((i) => i.id === operation.itemId)
  const title = target?.title ?? 'this item'

  if (operation.kind === 'verb') {
    const day = operation.date && operation.date !== ctx.todayStr ? ` on ${friendlyDate(operation.date)}` : ''
    switch (operation.verb) {
      case 'complete':
        // A one-off has no day to be done on: it is simply done.
        return target && !isRecurring(target) && !isHabit(target) ? `${title}: mark done` : `${title}: done${day || ' today'}`
      case 'skip':
        return `${title}: skip${day || ' today'}`
      case 'unskip':
        return `${title}: unskip${day || ' today'}`
      case 'pause':
        return operation.until ? `${title}: pause until ${friendlyDate(operation.until)}` : `${title}: pause`
      case 'resume':
        return `${title}: resume`
    }
  }

  const parts: string[] = []

  if (operation.title) parts.push(`rename to "${operation.title}"`)
  if (operation.startDate === null) parts.push('move to Braindump')
  else if (operation.startDate) parts.push(`move to ${friendlyDate(operation.startDate)}`)
  if (operation.startTime === null) parts.push('clear the time')
  else if (operation.startTime) parts.push(`set ${operation.startTime}`)
  if (operation.timeBucket) parts.push(`${operation.timeBucket}`)
  if (operation.repeatFrequency === 'none') parts.push('stop repeating')
  else if (operation.repeatFrequency || operation.repeatDays || operation.repeatMonthDay) {
    parts.push(`repeat ${repeatWords({
      repeatFrequency: operation.repeatFrequency ?? target?.repeatFrequency,
      repeatDays: operation.repeatDays ?? target?.repeatDays,
      repeatMonthDay: operation.repeatMonthDay ?? target?.repeatMonthDay,
    })}`)
  }
  if (operation.timesPerDay) parts.push(`${operation.timesPerDay} times a day`)
  if (operation.priority === null) parts.push('clear priority')
  else if (operation.priority) parts.push(`${operation.priority} priority`)
  if (operation.status) {
    const config = target ? getItemTypeConfig(itemTypeName(target)) : null
    parts.push(operation.status === config?.doneStatus ? 'mark done' : `mark ${operation.status}`)
  }

  return parts.length > 0 ? `${title}: ${parts.join(', ')}` : title
}
