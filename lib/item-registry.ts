/**
 * item-registry.ts — per-type behavior config for unified items.
 *
 * Every place the app used to ask "is this a task or a habit?" should instead
 * ask the registry what the item's type can do. Adding a new type (built-in or,
 * later, user-defined via an item_types table) means adding a config here — not
 * adding code paths.
 *
 * Values are transcribed from pre-unification behavior; changing one is a
 * product decision, not a refactor step. See memory/plans/unified-items.md.
 */

import { format } from 'date-fns'
import { TASK_FIELDS, HABIT_FIELDS } from '@dsul/types'
// The noun for the CLASSIFY axis lives there, not here. Value import in this
// direction only — container-registry takes `ItemTypeConfig` as a TYPE, which
// erases, so the runtime module graph stays acyclic.
import { CONTAINER_KINDS } from './container-registry'
import { accentColorForName } from './accent-colors'
import { selectOverdue, toDateOnly } from './overdue'

/**
 * Shared empty set for renderers whose input is pre-filtered. Named rather than
 * inlined so `selectOverdue(…, new Set())` never reads like someone shrugging
 * past the required parameter.
 */
const EMPTY_INACTIVE: ReadonlySet<string> = new Set()
import { isRecurring } from './recurrence'
import type {
  HabitItem,
  Item,
  ItemType,
  ItemTypeDef,
  KnownItemType,
  RepeatFrequency,
  TaskItem,
  TimeBucket,
} from '@dsul/types'

export interface ItemTypeConfig {
  type: ItemType
  label: string
  labelPlural: string
  /**
   * CSS color string (a var() token) for the type's identity swatch — the
   * colored square on the dialog's type chip and inside the type picker.
   * Custom types use their stored color when set, else the same name-hash
   * accent ramp projects draw from.
   */
  accent: string
  /**
   * Icon token (`icon:PascalName`) for the type's glyph, wherever an ITEM has
   * to say what kind of thing it is rather than what it is called.
   *
   * On the registry rather than in a `type === 'habit' ? … : …` at the one call
   * site, because the call sites multiply: the Organize console's member rows
   * and its add-search both need it today, and every one of them would
   * otherwise be a branch to update when a type is added.
   *
   * Optional, and safe to leave unset: {@link CategoryIcon} falls back to a
   * name-hashed glyph, so a custom type with no icon still gets a stable one
   * rather than nothing.
   */
  glyph?: string
  /** Valid values for the item's scalar `status` field. */
  allowedStatuses: readonly string[]
  /** The status meaning "finished" for one-shot (non-recurring) items. */
  doneStatus: string
  /** Recurring items track per-date completion in completedDates, never scalar status. */
  defaultFrequency: RepeatFrequency
  /** Habit UI deliberately forbids 'none' — a habit is recurring by definition. */
  allowedFrequencies: readonly RepeatFrequency[]
  /**
   * Anchored items have a startDate and gate recurring occurrences by
   * startDate <= date; un-anchored items render on every matching day.
   * Migrated habits stay un-anchored (start_date NULL) — backfilling would
   * retroactively hide historical occurrences.
   */
  dateAnchored: boolean
  /** Whether drag-and-drop may target a specific date (week-view column drops). */
  dateAddressable: boolean
  /**
   * May a single recurring occurrence be marked "not this one" — skipped —
   * without counting as done? Skips are per-DATE (`skippedDates`), exactly like
   * completions, so this capability only bites on a recurring item; a one-shot
   * item is completed, cancelled or deleted, never skipped. Ask
   * `isSkippable(item)` rather than reading this flag directly.
   */
  skippable: boolean
  /**
   * Scalar `status` value this type denormalizes a skip into, or null for
   * "skippedDates only".
   *
   * Habits keep a last-toggle snapshot in `status` and their vocabulary has a
   * 'skipped' member. Tasks must NOT: `pending|completed|cancelled` is an
   * external contract the OpenClaw plugin safeParses and throws on, so a
   * skipped task is a task with a date in `skippedDates` and nothing else.
   */
  skipStatus: string | null
  /**
   * May this type be paused — suppressed for a stretch of time without being
   * completed, skipped or deleted?
   *
   * Where a skip answers ONE occurrence, a pause answers an open-ended range,
   * so unlike `skippable` this does not require recurrence: a one-shot task
   * inside a paused stretch of life is exactly as suppressible as a habit.
   * Ask `isPausable(item)` rather than reading the flag, so the subtask rule
   * below is applied everywhere.
   */
  pausable: boolean
  /**
   * May this type be collected into routines, seasons and goals? Membership is
   * what lets a whole slice of life switch off at once — and, for goals, what
   * lets a slice of life have a reason.
   */
  collectible: boolean
  /**
   * May an item of this type be a goal's MILESTONE — an achievement checkpoint
   * whose completion moves the goal's progress?
   *
   * False for habits, and not as a slight: a milestone needs a single "done"
   * event to hang an achievement on, and a habit's whole design is that it has
   * none (per-date completion, an opaque streak, no terminal state). A habit
   * serves a goal as a plain `member`, which is the honest role for it.
   *
   * Ask `isMilestoneEligible(item)` rather than reading the flag: the capability
   * is only half the question, because the role also requires the item to be
   * one-shot. A recurring item's scalar status never moves (migration 016
   * semantics), so a recurring milestone would be permanently un-achievable and
   * progress would lie forever.
   */
  milestoneEligible: boolean
  /** Participates in manual ordering (the "order" column + reorder actions). */
  orderable: boolean
  /**
   * Which container table names this type resolves against.
   *
   * One value since migration 039 collapsed the two CLASSIFY kinds — but still
   * a field rather than a boolean, because `null` (this type carries no
   * container axis at all) is a real answer `containerRefOf` depends on, and
   * because `classifyKindForItemType` translates it into the ref grammar's
   * singular spelling.
   */
  containerKind: 'projects' | null
  containerRequired: boolean
  /** Fallback container when the referenced one is deleted (null → clear the ref). */
  orphanContainerFallback: string | null
  counters: {
    streak: boolean
    dailyCounts: boolean
  }
  /** May carry child items (items.parent_item_id) — the panel's Subtasks section. */
  subtasks: boolean
  /** May be handed to OpenClaw/Beacon (assignee / ai_status / ai_result). */
  agentAssignable: boolean
  schedule: {
    /**
     * Whether the schedule grid offers drag-to-resize handles on this type's
     * blocks. Requires `duration` in `fields` — there is nowhere to write the
     * result otherwise.
     */
    resizable: boolean
    /** Minutes a block occupies on the schedule grid when no duration is set. */
    defaultBlockMinutes: number
  }
  /**
   * May this type carry a daily cue (items.reminder_time, migration 032)?
   *
   * Capability, NOT intent: an item of a remindable type with no reminder_time
   * is the overwhelming majority and costs nothing — the reminder scan's index
   * is partial on `reminder_time is not null`. What the flag decides is whether
   * the ItemDialog offers the control at all.
   *
   * Ask {@link isRemindable}, which adds the subtask rule.
   */
  remindable: boolean
  /** May live in / return to the braindump (sidebar unschedule drop). */
  braindumpEligible: boolean
  /** Unfinished items roll forward in EOD review / morning check. */
  carryForwardEligible: boolean
  defaultTimeBucket: TimeBucket | null
  /**
   * Legacy webhook contract: the OpenClaw plugin registers exactly
   * tasks.updated/habits.updated and notifyPlugins drops unregistered event
   * names — new types must map onto one of these until a versioned contract
   * ships (Phase 5+).
   */
  webhookEvent: 'tasks.updated' | 'habits.updated'
  webhookPayloadKey: 'task' | 'habit'
  /** Schema-derived data fields for this type (excludes the discriminator). */
  fields: readonly string[]
  /** Presentation metadata for the unified ItemDialog (add/edit form). */
  form: {
    /** Title-input placeholder. "What needs to be done?" is an e2e selector. */
    titlePlaceholder: string
    /** sr-only description for the edit dialog. */
    editDescription: string
    /**
     * Label over the container select.
     *
     * MIRRORED, not authored: every type spells this `CONTAINER_KINDS.project.label`
     * so the axis has one home. The noun is provisional (see that record's note),
     * and moving it must not mean grepping for a word.
     */
    containerLabel: string
    /** Label of the create-new option — likewise `CONTAINER_KINDS.project.newLabel`. */
    newContainerLabel: string
    /** Lucide icon name seeding the inline container creator (via makeIconToken). */
    newContainerIcon: string
    /** Body copy for the delete-confirm dialog. */
    deleteDescription: (title: string) => string
  }
  ai: {
    /**
     * Renders this type's section of the Beacon chat context (markdown lines,
     * no trailing blank). Pinned presentation — byte-identical to the
     * pre-unification builder except for the past-due heading's wording (see the
     * push site): tasks are date-scoped with a "Still waiting" block, habits are
     * date-blind and streak-annotated in store order.
     */
    renderContextSection: (
      items: readonly Item[],
      ctx: { today: Date; todayStr: string }
    ) => string[]
  }
}

export const ITEM_TYPES: Record<KnownItemType, ItemTypeConfig> = {
  task: {
    type: 'task',
    label: 'Task',
    labelPlural: 'Tasks',
    accent: 'var(--primary)',
    glyph: 'icon:CircleCheck',
    allowedStatuses: ['pending', 'completed', 'cancelled'],
    doneStatus: 'completed',
    defaultFrequency: 'none',
    allowedFrequencies: ['none', 'daily', 'weekdays', 'weekends', 'monthly', 'custom'],
    dateAnchored: true,
    dateAddressable: true,
    skippable: true,
    skipStatus: null,
    pausable: true,
    collectible: true,
    milestoneEligible: true,
    orderable: true,
    containerKind: 'projects',
    containerRequired: false,
    orphanContainerFallback: null,
    counters: { streak: false, dailyCounts: false },
    subtasks: true,
    agentAssignable: true,
    // 30, not the 60 this said before it was consumed anywhere: the ItemDialog
    // seeds a new item's duration at '30' and the grid has always rendered a
    // duration-less block as 30 minutes. The 60 was aspirational config that
    // nothing read, so wiring it up would have silently doubled every such
    // block — the value follows the behavior, not the reverse.
    schedule: { resizable: true, defaultBlockMinutes: 30 },
    remindable: true,
    braindumpEligible: true,
    carryForwardEligible: true,
    defaultTimeBucket: null,
    webhookEvent: 'tasks.updated',
    webhookPayloadKey: 'task',
    fields: TASK_FIELDS,
    form: {
      titlePlaceholder: 'What needs to be done?',
      editDescription:
        'Edit the details of your task including title, priority, project, and schedule.',
      containerLabel: CONTAINER_KINDS.project.label,
      newContainerLabel: CONTAINER_KINDS.project.newLabel!,
      newContainerIcon: 'Briefcase',
      deleteDescription: (title) =>
        `This will permanently delete "${title}". This action cannot be undone.`,
    },
    ai: {
      renderContextSection: (items, { todayStr }) => {
        // Subtasks stay out of Beacon's narration — no view shows them as
        // free-floating tasks, so Beacon must not either. (The focused-item
        // section in ai-context.ts is where they speak.) Pre-subtask fixtures
        // carry no parentItemId, so the pinned byte-output is unchanged.
        const tasks = items.filter(
          (i): i is TaskItem => i.type === 'task' && !i.parentItemId
        )
        const lines: string[] = []
        lines.push("### Today's Tasks")

        const todayTasks = tasks.filter(
          (t) => t.startDate === todayStr && t.status !== 'cancelled'
        )

        // Past-due has exactly one definition (lib/overdue.ts). The copy that
        // used to live here had no recurrence guard, so Beacon was told about
        // phantom overdue items — a daily habit-shaped task anchored months ago
        // is `status: 'pending'` forever by design. Passing the already-narrowed
        // `tasks` keeps this section's task-only shape; ordering is now the
        // selector's (recent newest-first, then the long-overdue tail).
        // Empty inactive set, deliberately and not by omission: `tasks` reaches
        // this renderer ALREADY filtered of suppressed items (buildDsulContext
        // applies isOpenLoopSuppressedOn before dispatching to the per-type
        // renderers), so re-filtering here would be a no-op — and this
        // function's output is byte-pinned by tests/unit/ai-context.test.ts.
        const overdueTasks = selectOverdue(tasks, todayStr, EMPTY_INACTIVE)

        const pendingTasks = todayTasks.filter((t) => t.status === 'pending')
        const completedTasks = todayTasks.filter((t) => t.status === 'completed')

        function formatTask(t: TaskItem): string {
          const parts: string[] = []
          if (t.project) parts.push(`Project: ${t.project}`)
          if (t.timeBucket) {
            parts.push(t.timeBucket.charAt(0).toUpperCase() + t.timeBucket.slice(1))
          }
          if (t.priority) {
            parts.push(`${t.priority.charAt(0).toUpperCase() + t.priority.slice(1)} priority`)
          }
          return parts.length > 0 ? `- ${t.title} (${parts.join(', ')})` : `- ${t.title}`
        }

        if (pendingTasks.length > 0) {
          lines.push('**Pending**')
          pendingTasks.forEach((t) => lines.push(formatTask(t)))
        }

        if (completedTasks.length > 0) {
          lines.push('**Completed today**')
          completedTasks.forEach((t) => lines.push(`- ${t.title} ✓`))
        }

        if (overdueTasks.length > 0) {
          // "Still waiting", not "Overdue" — and this one IS a deliberate tone
          // decision, not a copy tidy-up. These lines are Beacon's prompt, so the
          // heading is the frame it answers in: handed a section called Overdue,
          // it opens by telling the user what they are behind on, which is the one
          // thing every other surface here has just stopped doing (see the copy
          // contract on BarCopy in components/ai/morning-check.tsx).
          //
          // No information is withheld from the model: same items, same order,
          // same dates, and "from Jul 10" carries the age exactly as well as "was
          // Jul 10" did. tests/unit/ai-context.test.ts pins this whole string as
          // the frozen pre-unification presentation and was updated in the same
          // commit — the freeze is there to catch DRIFT, and an intentional
          // rewording is not drift, so if this line changes again the test should
          // fail again and be re-read, not loosened.
          lines.push('**Still waiting**')
          overdueTasks.forEach((t) => {
            // toDateOnly: the selector admits legacy full-ISO startDates, which
            // `+ 'T00:00:00'` would turn into an Invalid Date.
            const dateLabel = `from ${format(new Date(toDateOnly(t.startDate!) + 'T00:00:00'), 'MMM d')}`
            const priority = t.priority
              ? `, ${t.priority.charAt(0).toUpperCase() + t.priority.slice(1)}`
              : ''
            lines.push(`- ${t.title} (${dateLabel}${priority})`)
          })
        }

        if (pendingTasks.length === 0 && completedTasks.length === 0 && overdueTasks.length === 0) {
          lines.push('No tasks scheduled for today.')
        }

        return lines
      },
    },
  },
  habit: {
    type: 'habit',
    label: 'Habit',
    labelPlural: 'Habits',
    // Honey is already the habit hue everywhere it has one (streak strip,
    // flame) via the warning alias — reuse it rather than minting a token.
    accent: 'var(--warning)',
    glyph: 'icon:Repeat',
    allowedStatuses: ['pending', 'done', 'skipped'],
    doneStatus: 'done',
    defaultFrequency: 'daily',
    allowedFrequencies: ['daily', 'weekdays', 'weekends', 'monthly', 'custom'],
    dateAnchored: false,
    dateAddressable: false,
    skippable: true,
    skipStatus: 'skipped',
    pausable: true,
    collectible: true,
    // A habit has no single completion to be a checkpoint — it has a per-date
    // history and a streak. It serves a goal as a member, or as a `checkin`
    // when the goal wants a recurring review.
    milestoneEligible: false,
    orderable: false,
    // 'projects' since 039 — a habit answers on the same one CLASSIFY axis as
    // everything else. `containerRequired` is what still makes a habit
    // different, and it is a capability, not a kind.
    containerKind: 'projects',
    containerRequired: true,
    orphanContainerFallback: 'Personal',
    counters: { streak: true, dailyCounts: true },
    // Habits recur; a habit "subtask" or agent handoff has no defined meaning.
    subtasks: false,
    agentAssignable: false,
    // Habits carry a real length now (`duration` joined habitShape), so their
    // blocks resize like any other — "30 minutes of reading a day" is the habit
    // itself. This was false only because there was no field to store the drag
    // into; it was never a statement that habits are momentary.
    schedule: { resizable: true, defaultBlockMinutes: 30 },
    remindable: true,
    braindumpEligible: false,
    carryForwardEligible: false,
    defaultTimeBucket: null,
    webhookEvent: 'habits.updated',
    webhookPayloadKey: 'habit',
    fields: HABIT_FIELDS,
    form: {
      titlePlaceholder: 'What habit to track?',
      editDescription:
        'Edit the details of your habit including title, project, and repeat schedule.',
      containerLabel: CONTAINER_KINDS.project.label,
      newContainerLabel: CONTAINER_KINDS.project.newLabel!,
      newContainerIcon: 'Star',
      deleteDescription: (title) =>
        `This will permanently delete "${title}" and all its history. This action cannot be undone.`,
    },
    ai: {
      renderContextSection: (items, { todayStr }) => {
        const habits = items.filter((i): i is HabitItem => i.type === 'habit')
        const lines: string[] = []
        lines.push('### Habits')

        if (habits.length === 0) {
          lines.push('No habits tracked.')
        } else {
          habits.forEach((h) => {
            const todayStatus = h.completedDates.includes(todayStr)
              ? '✓ done today'
              : h.skippedDates.includes(todayStr)
              ? 'skipped today'
              : 'pending today'
            const streakStr = h.streak > 0 ? `🔥 ${h.streak} day streak` : 'no streak'
            lines.push(`- ${h.title} — ${streakStr} — ${todayStatus}`)
          })
        }

        return lines
      },
    },
  },
}

/**
 * Key order of ITEM_TYPES is presentation-load-bearing: the Beacon context
 * sections and the system-prompt noun lists iterate this array, and their
 * output is pinned byte-for-byte (tests/unit/ai-context.test.ts). Insert new
 * types at the end.
 */
export const ALL_ITEM_TYPES = Object.keys(ITEM_TYPES) as KnownItemType[]

// ── User-defined types (Phase 6) ─────────────────────────────────────────────
// item_types rows hydrate into ItemTypeConfig via a fixed v1 template: custom
// types are task-shaped, date-anchored, container-less, counter-less. The
// `config` jsonb column is carried on the def for future capability overrides
// but is NOT applied yet — overriding capabilities is a product decision per
// capability, not a generic merge.

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

export function buildCustomTypeConfig(
  def: Pick<ItemTypeDef, 'name' | 'label' | 'labelPlural' | 'color' | 'icon'>
): ItemTypeConfig {
  const label = def.label || capitalize(def.name)
  const labelPlural = def.labelPlural || `${label}s`
  return {
    type: 'custom',
    label,
    labelPlural,
    accent: def.color?.trim() || accentColorForName(def.name),
    // The user's own pick, which the type row already stores. Left undefined
    // when unset so CategoryIcon hashes the SLUG — the same value the accent
    // ramp hashes, so a type's glyph and its colour are derived from one string.
    glyph: def.icon?.trim() || undefined,
    allowedStatuses: ['pending', 'completed', 'cancelled'],
    doneStatus: 'completed',
    defaultFrequency: 'none',
    allowedFrequencies: ['none', 'daily', 'weekdays', 'weekends', 'monthly', 'custom'],
    dateAnchored: true,
    dateAddressable: true,
    // Task-shaped in every respect, skips included: a recurring custom item
    // gets the same per-date skip + minimized row a habit does, with no code
    // path of its own.
    skippable: true,
    skipStatus: null,
    // Custom types are task-shaped, so they pause and collect exactly like
    // tasks — a new type needs no work to join a routine or a season.
    pausable: true,
    collectible: true,
    // Task-shaped here too: a one-shot custom item completes exactly like a
    // task, which is all a milestone needs.
    milestoneEligible: true,
    // Manual ordering is per-type ("order" sequences would collide); custom
    // types sort by created_at until reordering becomes a real need.
    orderable: false,
    // Project-shaped, because the rest of this config already is: `fields` is
    // TASK_FIELDS (which carries `project`), and itemFromRow/itemToRow read and
    // write row.project for custom items unconditionally. Left null, a custom
    // item carried a real project value that no container question could see —
    // the dialog never rendered the picker, and buildListGroups filed every
    // custom item under "No project". Since 039 there is nothing else it could
    // have been: one CLASSIFY kind means a custom type no longer picks a side.
    containerKind: 'projects',
    containerRequired: false,
    orphanContainerFallback: null,
    counters: { streak: false, dailyCounts: false },
    // Custom types are task-shaped (v1 template) — they grow the same way.
    subtasks: true,
    /**
     * FALSE, unlike every other task-shaped capability here, and not by
     * oversight: the agent write API does not expose custom types at all (a
     * locked v1 decision in unified-items.md), and /api/agent/tasks/:id filters
     * on `.eq('type','task')` in BOTH its ownership check and its update. So a
     * delegated custom item is a dead loop — it shows up in the agent's queue
     * and every progress report on it 404s, forever, with the badge stuck on
     * `queued`. An Assign button that leads nowhere is worse than no button.
     *
     * Flip this back the moment the agent API grows a type-agnostic item write
     * path; nothing else here needs to change.
     */
    agentAssignable: false,
    // 30 to match the built-in types — see the note on task.schedule.
    schedule: { resizable: true, defaultBlockMinutes: 30 },
    remindable: true,
    braindumpEligible: true,
    // The store's task actions operate on any task-like item (Phase 6b), so
    // dated custom items roll forward in morning check / EOD like tasks do.
    carryForwardEligible: true,
    defaultTimeBucket: null,
    // Trigger-only for the plugin: it refetches context on any event and its
    // tasks[]/habits[] projections exclude custom types (items[] carries them).
    webhookEvent: 'tasks.updated',
    webhookPayloadKey: 'task',
    fields: TASK_FIELDS,
    form: {
      titlePlaceholder: `Add a ${label.toLowerCase()}…`,
      editDescription: `Edit the details of your ${label.toLowerCase()}.`,
      containerLabel: CONTAINER_KINDS.project.label,
      newContainerLabel: CONTAINER_KINDS.project.newLabel!,
      newContainerIcon: 'Star',
      deleteDescription: (title) =>
        `This will permanently delete "${title}". This action cannot be undone.`,
    },
    ai: {
      renderContextSection: (items, _ctx) => {
        const lines: string[] = [`### ${labelPlural}`]
        const active = items.filter(
          (i) => i.type === 'custom' && i.status !== 'cancelled'
        )
        if (active.length === 0) {
          lines.push(`No ${labelPlural.toLowerCase()} yet.`)
        } else {
          active.forEach((i) =>
            lines.push(`- ${i.title}${i.status === 'completed' ? ' ✓' : ''}`)
          )
        }
        return lines
      },
    },
  }
}

let customTypeDefs: ItemTypeDef[] = []
let customTypeConfigs: Record<string, ItemTypeConfig> = {}

/** Replace the hydrated custom-type set (called by the planner store on load/CRUD). */
export function hydrateCustomTypes(defs: ItemTypeDef[]): void {
  customTypeDefs = defs
  customTypeConfigs = Object.fromEntries(
    defs.map((d) => [d.name, buildCustomTypeConfig(d)])
  )
}

export function getCustomTypeDefs(): ItemTypeDef[] {
  return customTypeDefs
}

/** All type machine names: built-ins first (order pinned), then custom. */
export function getAllItemTypeNames(): string[] {
  return [...ALL_ITEM_TYPES, ...customTypeDefs.map((d) => d.name)]
}

/** The registry name an item resolves against ('goal', not 'custom'). */
export function itemTypeName(item: Item): string {
  return item.type === 'custom' ? item.customType : item.type
}

/**
 * Never returns undefined: built-in → hydrated custom → an on-the-fly default
 * template (covers items whose item_types row was deleted — they keep working
 * with a capitalized-name label).
 */
export function getItemTypeConfig(name: string): ItemTypeConfig {
  if (name === 'task' || name === 'habit') return ITEM_TYPES[name]
  return (
    customTypeConfigs[name] ??
    buildCustomTypeConfig({ name, label: capitalize(name), labelPlural: `${capitalize(name)}s` })
  )
}

/**
 * Can this item's occurrences be skipped? Capability AND recurrence: a skip is
 * a date in `skippedDates`, which is only meaningful when the item has more
 * than one occurrence to skip. Habits pass on both counts by construction
 * (their allowed frequencies exclude 'none'), so this is the same predicate
 * the habit row has always applied — now stated once, for every type.
 */
export function isSkippable(item: Item): boolean {
  return getItemTypeConfig(itemTypeName(item)).skippable && isRecurring(item)
}

/**
 * May this item be paused?
 *
 * Capability AND not-a-subtask. A subtask has no independent presence — it
 * surfaces only inside its parent's detail panel, so pausing one would hide
 * nothing and produce an item the user cannot find to un-pause. Subtasks follow
 * their parent's state, the same reasoning that keeps them out of selectOverdue.
 *
 * Deliberately NOT AND-ed with recurrence, unlike isSkippable: a skip answers
 * one occurrence and needs another to exist, whereas a pause answers a stretch
 * of time and applies just as well to a single dated task.
 */
export function isPausable(item: Item): boolean {
  if ('parentItemId' in item && item.parentItemId) return false
  return getItemTypeConfig(itemTypeName(item)).pausable
}

/**
 * May this item carry a daily cue?
 *
 * Capability AND not-a-subtask, the isPausable rule and for the same reason: a
 * subtask surfaces only inside its parent's detail panel, so a notification
 * naming one would point at a row the user cannot navigate to.
 *
 * Deliberately NOT AND-ed with recurrence. A reminder answers "today, at this
 * hour", which a one-shot dated task wants exactly as much as a habit does —
 * the recurrence question is asked later, by the scan's due-today filter, and
 * asking it here would silently drop the reminder a user set on a real task.
 */
export function isRemindable(item: Item): boolean {
  if ('parentItemId' in item && item.parentItemId) return false
  return getItemTypeConfig(itemTypeName(item)).remindable
}

/** May this item join routines, seasons and goals? Same subtask rule as isPausable. */
export function isCollectible(item: Item): boolean {
  if ('parentItemId' in item && item.parentItemId) return false
  return getItemTypeConfig(itemTypeName(item)).collectible
}

/**
 * May this item be a goal's MILESTONE?
 *
 * Three conditions, and the last one is the one that bites: it must be
 * collectible at all (which excludes subtasks, for the reason isPausable gives
 * — a subtask has no independent presence), its type must have a terminal
 * completion (`milestoneEligible`), and it must be ONE-SHOT.
 *
 * The recurrence clause is the inverse of isSkippable's: a skip needs another
 * occurrence to exist, and a milestone needs there to be no other occurrence.
 * A recurring item never moves its scalar `status` (migration 016 — per-date
 * completion is the truth), so a recurring milestone can never be counted
 * achieved and the goal reads permanently behind, with no way for the user to
 * see why.
 *
 * This is asked at role-GRANT time. It cannot police a later edit — the item
 * dialog and the agent PATCH route can make an existing milestone recurring
 * long afterwards — so the store answers that by DEMOTING the role to 'member'
 * with a receipt, never by refusing the edit. See memory/plans/long-term-goals.md
 * locked decision 3.
 */
export function isMilestoneEligible(item: Item): boolean {
  if (!isCollectible(item)) return false
  if (!getItemTypeConfig(itemTypeName(item)).milestoneEligible) return false
  return !isRecurring(item)
}

/**
 * May this item be a goal's CHECK-IN — a recurring review of how the goal is
 * going?
 *
 * The mirror image of the rule above: any collectible type that CAN recur may
 * serve, habits included ("Weekly Chinese review" is a perfectly good habit).
 * What it cannot be is one-shot — a check-in that happens once is just a task.
 *
 * There is no `checkinEligible` flag because the registry already answers the
 * type half of the question: `allowedFrequencies` says whether the type can
 * recur at all, so a future type declaring `['none']` is refused here without
 * anyone remembering to add a capability for it. Asking the ITEM alone would
 * miss that, and would also trust a stale `repeatFrequency` on an item whose
 * type has since stopped allowing recurrence.
 */
export function isCheckinEligible(item: Item): boolean {
  if (!isCollectible(item)) return false
  const config = getItemTypeConfig(itemTypeName(item))
  if (!config.allowedFrequencies.some((f) => f !== 'none')) return false
  return isRecurring(item)
}
