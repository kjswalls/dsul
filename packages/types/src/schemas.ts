import { z } from 'zod'

// ── Primitives ─────────────────────────────────────────────────────────────────

export const PrioritySchema = z.enum(['low', 'medium', 'high'])
export const TimeBucketSchema = z.enum(['anytime', 'morning', 'afternoon', 'evening'])
export const TaskStatusSchema = z.enum(['pending', 'completed', 'cancelled'])
export const HabitStatusSchema = z.enum(['pending', 'done', 'skipped'])
export const RepeatFrequencySchema = z.enum([
  'none', 'daily', 'weekdays', 'weekends', 'monthly', 'custom',
])

/**
 * 24-hour local wall-clock 'HH:mm'.
 *
 * Enforced at the WRITE boundary only. Migration 032 puts the same shape in a
 * CHECK constraint, so an unvalidated agent body would 500 at Postgres instead
 * of 400 here — the reasoning TaskCreateSchema already applies to uuids and the
 * aiStatus vocabulary. The READ shapes stay plain `z.string()`: a row written
 * before the constraint existed must never fail the whole context safeParse.
 */
export const TimeOfDaySchema = z
  .string()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Must be a 24-hour HH:mm time')

// Normalize legacy "weekly" (removed in migration 014) to "custom" before enum validation
const normalizeWeekly = (val: unknown) => val === 'weekly' ? 'custom' : val

// Pre-unification schemas silently stripped `notes` as an unknown key, so a
// third-party payload with notes:null must keep parsing — accept and coalesce.
const NotesSchema = z.string().nullish().transform((v) => v ?? undefined)

// ── Shared recurrence fields ───────────────────────────────────────────────────

export const RecurrenceFieldsSchema = z.object({
  repeatFrequency: z.preprocess(normalizeWeekly, RepeatFrequencySchema).optional(),
  repeatDays: z.array(z.number()).optional(),
  repeatMonthDay: z.number().optional(),
  completedDates: z.array(z.string()).optional(),
  // Per-date "not this occurrence" — the skip twin of completedDates, and the
  // ONLY place a skip may live: 'skipped' is not in the task status vocabulary
  // and the OpenClaw plugin throws on drift there (see the habit branch, which
  // has carried this field since before unification). Optional and additive,
  // so a plugin built against the older TaskSchema still parses tasks[] — it
  // strips the key as unknown.
  skippedDates: z.array(z.string()).optional(),
})
export type RecurrenceFields = z.infer<typeof RecurrenceFieldsSchema>

// ── Shared pause fields ────────────────────────────────────────────────────────
// Suppression state for seasons & routines (migration 024). It lives here and
// NEVER in `status`: task pending|completed|cancelled and habit
// pending|done|skipped are frozen external contracts — an unknown enum value
// makes the OpenClaw plugin's whole-context safeParse throw and bricks its
// cache. Same shape skippedDates took for per-date skips.
//
// Spread into BOTH taskShape and habitShape below. That is two edit sites, not
// one: habitShape declares its recurrence fields inline and does not consume
// RecurrenceFieldsSchema (compare skippedDates, which appears in both places),
// so a single shared-block edit would silently reach task + custom only.
//
// Additive-optional, so an already-deployed plugin build strips both keys
// rather than rejecting them.
const pauseFields = {
  /**
   * ISO timestamp the pause began. Load-bearing, not decorative: it is the
   * resolver's LOWER bound, without which a pause started in August would
   * retro-suppress every unmarked occurrence back through July.
   */
  pausedAt: z.string().optional(),
  /**
   * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
   * auto-resume needs no cron. A manual resume sets this to today rather than
   * clearing pausedAt, keeping the interval on the row for the auto-age
   * sweep's resume grace.
   */
  pausedUntil: z.string().optional(),
}

// ── Shared reminder fields (migration 032) ─────────────────────────────────────
// A recurring cue for one item. Spread into BOTH taskShape and habitShape for
// the same reason pauseFields is — habitShape declares its own recurrence block
// and consumes no shared schema, so one edit site would silently reach task +
// custom only.
//
// Additive-optional, so an already-deployed OpenClaw build strips both keys off
// the legacy projections rather than rejecting them (the drift rule in
// CLAUDE.md: tasks[]/habits[] are external contracts, and `safeParse` throws on
// a REQUIRED field it has never seen, not on an unknown one).
const reminderFields = {
  /**
   * Local wall-clock 'HH:mm' for this item's daily cue, or absent for no
   * reminder. NOT a timestamp: see migration 032 on why the instant-shaped
   * items.reminder_at column was left alone rather than reused.
   */
  reminderTime: z.string().optional(),
  /**
   * The implementation-intention phrase the cue is rehearsed as — "after I pour
   * my coffee". Free text, never parsed; rendered into the notification body.
   */
  reminderAnchor: z.string().optional(),
}

// custom frequency requires at least one repeat day — shared by every item shape
const requireCustomDays = (
  data: { repeatFrequency?: string | null; repeatDays?: number[] | null },
  ctx: z.RefinementCtx,
) => {
  if (data.repeatFrequency === 'custom' && (!data.repeatDays || data.repeatDays.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Must select at least one day when using custom repeat frequency',
      path: ['repeatDays'],
    });
  }
}

// ── Core entities ──────────────────────────────────────────────────────────────

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string(),
  /** CSS color, usually a var(--accent-N) token; unset → name-hash ramp. */
  color: z.string().optional(),
  repeatFrequency: RepeatFrequencySchema.optional(),
  repeatDays: z.array(z.number()).optional(),
  repeatMonthDay: z.number().optional(),
  timeBucket: TimeBucketSchema.optional(),
  startTime: z.string().optional(),
  duration: z.number().optional(),
  /** A free-text note — what this is for (migration 049). */
  notes: z.string().optional(),
})

export const HabitGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string(),
  color: z.string().optional(),
})

// ── Seasons & routines (migration 024) ────────────────────────────────────────
// Collections that gate visibility rather than describe an item. A ROUTINE is a
// small reusable set (a morning routine); a SEASON is a period of life (summer,
// school year) holding items and/or routines. Membership is many-to-many and
// referenced BY ID — the older containers (items.project, items."group") hold
// container NAMES, which is exactly why renaming them is still parked.
//
// The member arrays are the app-side view of the join tables; the DB keeps them
// normalized in routine_items / season_items / season_routines.

export const SeasonStateSchema = z.enum(['auto', 'active', 'paused'])

export const RoutineSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** icon:<LucideName> token, matching the container convention. */
  icon: z.string().optional(),
  /** CSS color, usually a var(--accent-N) token; unset → name-hash ramp. */
  color: z.string().optional(),
  sortOrder: z.number().optional(),
  /**
   * When the routine usually happens, as a local wall-clock 'HH:mm' — "Morning,
   * usually at 7:00". A routine is things done regularly, together; this is the
   * "regularly" said out loud. It moves nothing: members keep their own timing
   * (a routine never writes a member's fields), and this only labels the
   * routine and orders it among the others. Plain string on the READ shape, as
   * every time here is — see TimeOfDaySchema.
   */
  usualTime: z.string().optional(),
  ...pauseFields,
  /** A free-text note — what this is for (migration 049). */
  notes: z.string().optional(),
  /** Member item ids (routine_items), in routine-internal order. */
  itemIds: z.array(z.string()),
})

export const SeasonSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().optional(),
  color: z.string().optional(),
  sortOrder: z.number().optional(),
  /**
   * 'auto' follows startsOn/endsOn (no range = always on); 'active'/'paused'
   * are manual overrides that always win, because flipping a season by hand
   * must never be second-guessed by a date. Several seasons may be active at
   * once — the resolver unions their members.
   */
  state: SeasonStateSchema,
  /** Inclusive bounds, either end open (yyyy-MM-dd). Only read when state is 'auto'. */
  startsOn: z.string().optional(),
  endsOn: z.string().optional(),
  /** A free-text note — what this is for (migration 049). */
  notes: z.string().optional(),
  /** Directly-held item ids (season_items). */
  itemIds: z.array(z.string()),
  /** Held routine ids (season_routines) — their members ride along. */
  routineIds: z.array(z.string()),
  /**
   * Trigger-maintained, READ-ONLY app-side. It exists for one consumer: the
   * overdue sweep's grace (c). A manual `paused` → `active` flip has no
   * recorded date — the tri-state keeps no history — so this is the only
   * evidence that a season recently stopped hiding its members, and without it
   * the morning after someone turns a season back on the sweep unschedules
   * every member at once.
   *
   * Deliberately NOT in db.ts updateSeason's column allowlist: it appears in
   * SEASON_FIELDS (which is Object.keys of this shape) and therefore in undo's
   * container diff, where a stale value would otherwise be written back over
   * the trigger's.
   */
  updatedAt: z.string().optional(),
})

// ── Goals (migration 036) ──────────────────────────────────────────────────────
// The third container role. Projects and habit groups CLASSIFY (what an item is
// about); routines and seasons GATE (when it counts); a goal ASPIRES — it says
// why the work matters and switches nothing off. See lib/container-registry.ts,
// which states that seam in types, and memory/plans/long-term-goals.md.
//
// Members are ids carrying a ROLE, split app-side into three arrays because
// every consumer wants one role's ids at a time: progress counts milestones,
// the timeline orders them, the check-in bridge asks for checkins. The DB keeps
// one normalized table (goal_items) whose primary key guarantees the arrays are
// disjoint on read — the WRITE side must reconcile them as one union, or a
// milestone demoted to member races itself. See lib/db.ts reconcileGoalMembers.

export const GoalStateSchema = z.enum(['active', 'achieved', 'abandoned'])

/**
 * What a member does for its goal.
 *
 * A `milestone` is a one-shot item whose `startDate` IS its target date, so it
 * renders on the grid that day and goes past due when missed; a `checkin` is a
 * recurring review. Both requirements are capability questions the registry
 * answers (`isMilestoneEligible` / recurrence), and a later item edit that
 * invalidates a held role DEMOTES it to 'member' rather than blocking the edit
 * — a recurring item's scalar status is frozen by design, so a recurring
 * "milestone" would make progress lie forever.
 */
export const GoalRoleSchema = z.enum(['member', 'milestone', 'checkin'])

export const GoalSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The motivation line — why this goal exists. Rendered on the goal surface, handed to Beacon. */
  why: z.string().optional(),
  /** icon:<LucideName> token, matching the container convention. */
  icon: z.string().optional(),
  /** CSS color, usually a var(--accent-N) token; unset → name-hash ramp. */
  color: z.string().optional(),
  sortOrder: z.number().optional(),
  state: GoalStateSchema,
  /** Optional horizon (yyyy-MM-dd). `targetOn` is what the countdown and the behind/ahead read measure against. */
  startsOn: z.string().optional(),
  targetOn: z.string().optional(),
  /**
   * Stamped when `state` becomes 'achieved', cleared when it returns to
   * 'active'.
   *
   * App-written and IN db.ts's update allowlist — the deliberate opposite of
   * Season.updatedAt, which is kept OUT of its allowlist because a trigger
   * owns it. The reason is undo: this field rides GOAL_FIELDS into the
   * container diff, which is what makes one ⌘Z after "Mark achieved" restore
   * `state: 'active'` AND clear the stamp together. Left out, undo would
   * restore the state and strand the timestamp.
   *
   * A write that does not CHANGE the state must never restamp it: re-achieving
   * an achieved goal would drag a multi-year achievement date forward, and
   * retried PATCHes are expected traffic (whole-array membership replacement is
   * designed for retry idempotence). The rule lives beside the state verb.
   */
  achievedAt: z.string().optional(),
  /** Ordinary supporting work — the daily practice habit, the odd task. */
  memberIds: z.array(z.string()),
  /** Achievement checkpoints, in timeline order (goal_items.sort_order). */
  milestoneIds: z.array(z.string()),
  /** Recurring reviews. */
  checkinIds: z.array(z.string()),
})

// Field shapes are shared between the legacy per-kind schemas (TaskSchema /
// HabitSchema — the pinned external contract the OpenClaw plugin validates
// against) and the unified ItemSchema branches. Task and Habit deliberately
// keep their own status vocabularies; unification happens via the `type`
// discriminator, never by merging enums.

const taskShape = {
  id: z.string(),
  title: z.string(),
  priority: PrioritySchema.optional(),
  project: z.string().optional(),
  startDate: z.string().optional(),   // yyyy-MM-dd
  status: TaskStatusSchema,
  timeBucket: TimeBucketSchema.optional(),
  startTime: z.string().optional(),   // HH:mm
  duration: z.number().optional(),    // minutes
  isScheduled: z.boolean(),
  order: z.number(),
  inProjectBlock: z.boolean().optional(),
  previousStartTime: z.string().optional(),
  previousStartDate: z.string().optional(),
  notes: NotesSchema,
  // ── Item-surface growth (memory/plans/item-surface-growth.md) ────────────
  // Waking the migration-007/019 future-proofing columns. All four are
  // additive-optional: old plugin builds strip unknown keys, so the pinned
  // legacy projections keep parsing. Reads are deliberately LOOSE strings —
  // constraining aiStatus to an enum here would let a future vocabulary
  // addition brick an old plugin's safeParse; the write-side schemas
  // (TaskUpdateSchema) carry the strict enum instead.
  /** Parent item id — this item is a subtask when set (items.parent_item_id). */
  parentItemId: z.string().optional(),
  /**
   * Stable id of the project named by `project` (migration 027).
   *
   * `project` STAYS the name and stays authoritative for display — this pair is
   * deliberately redundant, because the legacy projection has to emit a name
   * and a uuid would still `safeParse` past it (both are `z.string()`), failing
   * silently and feeding ids to a model with no id↔name map. The id is what
   * survives a rename; the fan-out keeps the name correct.
   *
   * It has to live in the SHAPE, not merely in the DB: `diffItem` iterates
   * `getItemTypeConfig(...).fields`, which is `Object.keys(taskShape)`, so a
   * field outside it never enters an undo patch — undo would send the old name
   * back while the id still pointed at the new container.
   */
  projectId: z.string().optional(),
  /** Who's working this item: 'openclaw' | 'beacon' | free text. */
  assignee: z.string().optional(),
  /** Agent progress state — write vocabulary: queued|working|blocked|done|failed. */
  aiStatus: z.string().optional(),
  /** Agent's latest result/summary for this item. */
  aiResult: z.string().optional(),
  /**
   * When `aiStatus` last changed (migration 041). Read-only client-side —
   * stamped by lib/db.ts as a companion of the status write, never on its own,
   * so it cannot drift from the state it timestamps.
   *
   * Same "small and stable" class as the three fields above it: it changes
   * exactly as often as `aiStatus` does, which is a handful of times over a
   * delegated task's life. That is what keeps it out of the hazard the schema
   * note names — a field that changes OFTEN entering the frozen `tasks[]`
   * projection and the 50-entry undo stack.
   */
  aiStatusAt: z.string().optional(),
  ...RecurrenceFieldsSchema.shape,
  ...pauseFields,
  ...reminderFields,
}

/**
 * Everything a habit carries EXCEPT the container it answers with.
 *
 * Split out because the two shapes built from it disagree about exactly that
 * one field, and about nothing else (migration 039). The legacy `HabitSchema`
 * — the pinned external contract — keeps `group`/`groupId`; the unified
 * ItemSchema's habit branch carries `project`/`projectId` like every other
 * type, because there is one CLASSIFY kind now.
 *
 * So `habits[]` is no longer a plain field subset of an item: it is a
 * projection that RENAMES one field on the way out. That rename is the entire
 * cost of the collapse at this boundary, and it is paid in one place
 * (`legacyHabit` in app/api/agent/context/route.ts) rather than spread.
 */
const habitCoreShape = {
  id: z.string(),
  title: z.string(),
  streak: z.number(),
  status: HabitStatusSchema,
  completedDates: z.array(z.string()),
  skippedDates: z.array(z.string()),
  dailyCounts: z.record(z.string(), z.number()),
  timeBucket: TimeBucketSchema.optional(),
  startTime: z.string().optional(),
  // Minutes. Habits carry a length for the same reason tasks do — "30 minutes
  // of reading" is the habit, not a 30-minute default someone has to accept —
  // which is also what makes a habit block resizable on the schedule grid
  // (registry `schedule.resizable`). Optional: a habit with no duration falls
  // back to the type's defaultBlockMinutes, and the column already existed as
  // nullable in `items` (migration 019), so nothing needed backfilling.
  duration: z.number().optional(),    // minutes
  // Required (a habit is recurring by definition); .or().transform() rather
  // than z.preprocess so z.input keeps the field required and enum-typed.
  repeatFrequency: RepeatFrequencySchema
    .or(z.literal('weekly'))
    .transform((v) => v === 'weekly' ? 'custom' as const : v),
  repeatDays: z.array(z.number()).optional(),
  repeatMonthDay: z.number().optional(),
  timesPerDay: z.number().optional(),
  currentDayCount: z.number().optional(),
  notes: NotesSchema,
  ...pauseFields,
  ...reminderFields,
}

/**
 * The legacy habit shape — `group` is a NAME, exactly as it has always been.
 *
 * FROZEN. `HabitSchema` is what the OpenClaw plugin `safeParse`s (it throws on
 * drift), `HabitCreateSchema`/`HabitUpdateSchema` are the agent's write
 * vocabulary, and `DsulContextResponseSchema.habits` is typed off it. The
 * collapse happened underneath this, not to it.
 */
const habitShape = {
  ...habitCoreShape,
  group: z.string(),
  /**
   * Stable id of the group named by `group` (migration 027).
   *
   * Post-039 this is the PROJECT's id — the habit_groups row it used to name
   * became a projects row keeping its uuid, which is what lets this field mean
   * the same thing to an old plugin build without a translation table.
   */
  groupId: z.string().optional(),
}

/** The unified habit branch — one CLASSIFY kind, so it answers with `project`. */
const habitItemShape = {
  ...habitCoreShape,
  /**
   * Optional, exactly like the task side's — one CLASSIFY axis means one field
   * shape, and every consumer reads `item.project` off the union without
   * narrowing. "A habit must be filed somewhere" is a CAPABILITY
   * (`containerRequired`), enforced by the dialog and the seed fallback, not by
   * this field's presence: the legacy column was NOT NULL and produced '' for
   * the unset case, so making the type require a string only ever moved that ''
   * around. `toLegacyHabit` restores the required `group: string` on the way out.
   */
  project: z.string().optional(),
  /** See taskShape.projectId: the name stays authoritative, the id survives renames. */
  projectId: z.string().optional(),
}

export const TaskSchema = z.object(taskShape).superRefine(requireCustomDays)
export const HabitSchema = z.object(habitShape).superRefine(requireCustomDays)

// Canonical field lists (schema-derived, so they can never drift from the
// shapes) — used for per-type diffing/patching, e.g. undo/redo sync.
export const TASK_FIELDS = Object.keys(taskShape) as (keyof z.infer<typeof TaskSchema>)[]
// The ITEM shape, not the legacy one: this list drives `diffItem` and the
// per-type update allowlists, both of which speak in items. Keyed off the
// legacy shape it would put `group` into every undo patch and drop `project`.
export const HABIT_FIELDS = Object.keys(habitItemShape) as (keyof z.infer<typeof HabitItemSchema>)[]
export const PROJECT_FIELDS = Object.keys(ProjectSchema.shape) as (keyof z.infer<typeof ProjectSchema>)[]
export const HABIT_GROUP_FIELDS = Object.keys(HabitGroupSchema.shape) as (keyof z.infer<typeof HabitGroupSchema>)[]
export const ROUTINE_FIELDS = Object.keys(RoutineSchema.shape) as (keyof z.infer<typeof RoutineSchema>)[]
export const SEASON_FIELDS = Object.keys(SeasonSchema.shape) as (keyof z.infer<typeof SeasonSchema>)[]
export const GOAL_FIELDS = Object.keys(GoalSchema.shape) as (keyof z.infer<typeof GoalSchema>)[]

// ── Unified Item ───────────────────────────────────────────────────────────────
// One entity, discriminated by `type`. The task branch is structurally
// identical to Task, so that projection (item → legacy shape) is a plain field
// subset. The HABIT branch is not, and has not been since migration 039: an
// item answers with `project` on the one CLASSIFY axis, while `habits[]` must
// keep emitting `group`. That single rename is the projection.
// User-defined types (errand, …) travel under a CLOSED 'custom'
// envelope with the type's machine name in `customType` — an open type: string
// branch would destroy TypeScript's discriminated narrowing at every
// `item.type === '…'` site in the app. The DB stores the slug itself in
// items.type; the app maps slug ↔ envelope at the row boundary.

const taskItemObject = z.object({ type: z.literal('task'), ...taskShape })
const habitItemObject = z.object({ type: z.literal('habit'), ...habitItemShape })
const customItemObject = z.object({
  type: z.literal('custom'),
  /**
   * The user-defined type's machine name (item_types.name), e.g. 'errand'.
   *
   * NOT 'goal', which this example used to be: a Goal is a CONTAINER now
   * (GoalSchema above, migration 036), and an item type of the same name is a
   * different thing in a different namespace. Both keep working — the console
   * shows them in different sections — but the example should not teach the
   * collision.
   */
  customType: z.string(),
  ...taskShape,
})

export const TaskItemSchema = taskItemObject.superRefine(requireCustomDays)
export const HabitItemSchema = habitItemObject.superRefine(requireCustomDays)
export const CustomItemSchema = customItemObject.superRefine(requireCustomDays)

export const ItemSchema = z
  .discriminatedUnion('type', [taskItemObject, habitItemObject, customItemObject])
  .superRefine(requireCustomDays)

// ── Item type definitions (user-defined types, migration 021) ─────────────────

export const ItemTypeDefSchema = z.object({
  id: z.string(),
  /** Machine name used as items.type — lowercase slug; 'task'/'habit'/'custom' reserved. */
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,31}$/)
    .refine((n) => !['task', 'habit', 'custom'].includes(n), {
      message: 'reserved type name',
    }),
  label: z.string().min(1),
  labelPlural: z.string().min(1),
  icon: z.string().optional(),
  color: z.string().optional(),
  /** Capability overrides of the app-side custom-type template. */
  config: z.record(z.string(), z.unknown()).optional(),
})

// ── Agent API write-body schemas ───────────────────────────────────────────────
// Validate POST/PATCH bodies at the route boundary so bad payloads get a 400
// instead of surfacing as Postgres CHECK-constraint 500s. Unknown keys are
// stripped (Zod default — matches the old field-pick/allowlist behavior).
//
// Update schemas: `null` is accepted only on fields whose DB column is
// nullable, where it means "clear the field" (the db-layer allowlists pass it
// through as a NULL write). Fields with legacy NOT-NULL semantics (title,
// status, habit group/streak/arrays/repeatFrequency) reject null — the old
// routes let those reach Postgres and 500.

const clearable = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().optional()

// id: null falls through to a server-generated UUID (legacy route behavior).
const OptionalIdSchema = z
  .string()
  .uuid()
  .nullish()
  .transform((v) => v ?? undefined)

/**
 * yyyy-MM-dd, enforced.
 *
 * Deliberately NOT retrofitted onto the older loose fields (`startDate` and
 * friends stay `z.string()`) — tightening those could 400 a deployed agent that
 * has been sending something sloppy-but-workable for months. New fields carry
 * the constraint from birth, and pause/range dates in particular need it: they
 * are compared LEXICALLY against `toDateStr` output, so "Sep 1" or an ISO
 * timestamp does not error, it silently resolves to the wrong side of every
 * boundary.
 */
const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a yyyy-MM-dd date')

/**
 * Pausing, expressed as the VERB the UI offers rather than the two columns it
 * writes.
 *
 * `pausedAt` is absent on purpose and is derived server-side. It is the
 * resolver's lower bound, and a value an agent picks is wrong in both
 * directions: backdated, it retro-suppresses history that actually happened;
 * postdated, the item stays visible and the pause looks like it silently
 * failed. `paused: true/false` cannot be incoherent, so the API only accepts
 * that. See resolvePauseWrite in lib/active.ts for the translation.
 */
const pauseVerbShape = {
  /** true → pause from now; false → resume today. Omit to leave pause state alone. */
  paused: z.boolean().optional(),
  /**
   * Resume date (EXCLUSIVE — live again ON this date). Sent with `paused: true`
   * it sets the end of the pause; sent alone it moves the resume date of a
   * pause already running. `null` means "paused with no end date".
   */
  pausedUntil: clearable(DateOnlySchema),
}

/**
 * `paused: false` says "resume now", which leaves no resume date to set — so a
 * body carrying both is not a partially-honoured request, it is two
 * instructions that contradict. Rejecting beats picking one, because the
 * plausible reading ("resume ON this date") is the one thing it does NOT do.
 */
const rejectResumeWithDate = (
  data: { paused?: boolean | null; pausedUntil?: string | null },
  ctx: z.RefinementCtx,
) => {
  if (data.paused === false && data.pausedUntil !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'pausedUntil cannot accompany paused: false — resuming happens now. ' +
        'To schedule a later resume, send paused: true with pausedUntil.',
      path: ['pausedUntil'],
    })
  }
}

/**
 * The delegation lifecycle.
 *
 * A FROZEN external contract from the moment a real agent writes it: the UI
 * renders these values, the MCP tool surface offers them, and an agent that
 * learned one spelling cannot be asked to relearn it. Extend additively, never
 * rename. Named here rather than inlined so the app, the agent API and the tool
 * surface cannot drift into three slightly different vocabularies.
 */
export const AiStatusSchema = z.enum(['queued', 'working', 'blocked', 'done', 'failed'])

export const TaskCreateSchema = z
  .object({
    ...taskShape,
    id: OptionalIdSchema,
    title: z.string().min(1),
    status: TaskStatusSchema.optional(),
    isScheduled: z.boolean().optional(),
    order: z.number().int().optional(),
    duration: z.number().int().optional(),
    repeatDays: z.array(z.number().int()).optional(),
    repeatMonthDay: z.number().int().optional(),
    // Growth fields are strict at the create boundary too (taskShape's reads
    // stay loose) — a bad uuid or status must 400 here, not 500 at Postgres.
    parentItemId: z.string().uuid().optional(),
    aiStatus: AiStatusSchema.optional(),
    // Strict here, loose in taskShape — same split as aiStatus above.
    reminderTime: TimeOfDaySchema.optional(),
  })
  // Create schemas SPREAD the shapes, so anything added to taskShape becomes an
  // accepted create-body field automatically (that propagation is how habit
  // `duration` reached the agent API for free). Pause is different: an agent
  // could otherwise POST a born-paused item — invisible on every surface the
  // moment it exists — and the 201 echo would report pause state back. Agent
  // write access to pausing is a deliberate Phase 4 decision, so strip it here.
  // PATCH needs no equivalent: TaskUpdateSchema/HabitUpdateSchema are
  // hand-enumerated and drop unknown keys.
  //
  // projectId is stripped for a different reason, and permanently. The agent
  // surface speaks in NAMES — that is the entire point of the legacy projection
  // — and an agent holds no id↔name map, so a body carrying both could only
  // disagree with itself. Accepting one would mean choosing which half wins on
  // every drifted POST. `project` stays the agent's field; `lookupContainerId`
  // in lib/db.ts resolves the id from it on the create AND update paths, so an
  // agent-filed item is linked correctly without ever naming an id. That
  // resolver is what makes this omission safe rather than lossy — omitting the
  // field without it silently strips every agent write out of the rename
  // fan-out, which is the bug Phase 0 exists to remove.
  //
  // `aiStatusAt` is omitted on the same principle as `projectId`: it is derived,
  // not declared. Spreading `taskShape` makes every new field an accepted create
  // body field automatically, which handed an agent two ways to be wrong — an
  // unvalidated string reaching a `timestamptz` column 500s at Postgres instead
  // of 400ing here (the rule the `aiStatus` line beside it states outright), and
  // a well-formed past value manufactures a fake "Working 3h". The stamp is
  // written by lib/db.ts alongside the status it describes, and by nothing else.
  .omit({ pausedAt: true, pausedUntil: true, projectId: true, aiStatusAt: true })
  .superRefine(requireCustomDays)

export const HabitCreateSchema = z
  .object({
    ...habitShape,
    id: OptionalIdSchema,
    title: z.string().min(1),
    group: z.string().optional(),
    streak: z.number().int().optional(),
    // int, like the task side: items.duration is an integer column, so a
    // fractional body should 400 at the boundary rather than 500 on the insert.
    duration: z.number().int().optional(),
    status: HabitStatusSchema.optional(),
    completedDates: z.array(z.string()).optional(),
    skippedDates: z.array(z.string()).optional(),
    dailyCounts: z.record(z.string(), z.number()).optional(),
    repeatFrequency: RepeatFrequencySchema
      .or(z.literal('weekly'))
      .transform((v) => (v === 'weekly' ? ('custom' as const) : v))
      .optional(),
    repeatDays: z.array(z.number().int()).optional(),
    repeatMonthDay: z.number().int().optional(),
    timesPerDay: z.number().int().optional(),
    currentDayCount: z.number().int().optional(),
    reminderTime: TimeOfDaySchema.optional(),
  })
  // See TaskCreateSchema — pause is not agent-writable in v1, and groupId is
  // resolved server-side from `group` rather than accepted.
  .omit({ pausedAt: true, pausedUntil: true, groupId: true })
  .superRefine(requireCustomDays)

// Update schemas keep requireCustomDays too: a PATCH that sets
// repeatFrequency 'custom' (or legacy 'weekly') without non-empty repeatDays
// would store an item the plugin's context safeParse rejects — one bad item
// bricks the WHOLE cached context. The refine can't see stored state, so a
// "switch back to custom, days already stored" patch must resend repeatDays.

export const TaskUpdateSchema = z
  .object({
    title: z.string().min(1).optional(),
    status: TaskStatusSchema.optional(),
    priority: clearable(PrioritySchema),
    project: clearable(z.string()),
    startDate: clearable(z.string()),
    timeBucket: clearable(TimeBucketSchema),
    startTime: clearable(z.string()),
    duration: clearable(z.number().int()),
    isScheduled: z.boolean().optional(),
    order: z.number().int().optional(),
    inProjectBlock: clearable(z.boolean()),
    previousStartTime: clearable(z.string()),
    previousStartDate: clearable(z.string()),
    notes: clearable(z.string()),
    repeatFrequency: clearable(z.preprocess(normalizeWeekly, RepeatFrequencySchema)),
    repeatDays: clearable(z.array(z.number().int())),
    repeatMonthDay: clearable(z.number().int()),
    completedDates: clearable(z.array(z.string())),
    skippedDates: clearable(z.array(z.string())),
    // Item-surface growth fields — strict on the write side (see taskShape
    // note): agents may only set the pinned aiStatus vocabulary.
    parentItemId: clearable(z.string().uuid()),
    assignee: clearable(z.string()),
    // 'blocked' means the agent is waiting on a decision from the user — added
    // BEFORE anything real writes this vocabulary, because the moment an
    // independently-deployed agent does, renaming a value costs a coordinated
    // release (the plugin safeParses and throws on drift). Growing the set
    // stays cheap forever; the read side is deliberately loose.
    aiStatus: clearable(AiStatusSchema),
    aiResult: clearable(z.string()),
    // Clearable both: null is how a reminder is turned OFF (migration 032's
    // null-means-off contract), which a plain .optional() could not express.
    reminderTime: clearable(TimeOfDaySchema),
    reminderAnchor: clearable(z.string()),
    ...pauseVerbShape,
  })
  .superRefine(requireCustomDays)
  .superRefine(rejectResumeWithDate)

export const HabitUpdateSchema = z
  .object({
    title: z.string().min(1).optional(),
    status: HabitStatusSchema.optional(),
    group: z.string().optional(),
    streak: z.number().int().optional(),
    completedDates: z.array(z.string()).optional(),
    skippedDates: z.array(z.string()).optional(),
    dailyCounts: z.record(z.string(), z.number()).optional(),
    timeBucket: clearable(TimeBucketSchema),
    startTime: clearable(z.string()),
    // Clearable: items.duration is nullable, so null means "back to the type's
    // default block length" rather than being rejected.
    duration: clearable(z.number().int()),
    repeatFrequency: z.preprocess(normalizeWeekly, RepeatFrequencySchema).optional(),
    repeatDays: clearable(z.array(z.number().int())),
    repeatMonthDay: clearable(z.number().int()),
    timesPerDay: clearable(z.number().int()),
    currentDayCount: clearable(z.number().int()),
    notes: clearable(z.string()),
    // See TaskUpdateSchema — clearable is the off switch, not a nicety.
    reminderTime: clearable(TimeOfDaySchema),
    reminderAnchor: clearable(z.string()),
    ...pauseVerbShape,
  })
  .superRefine(requireCustomDays)
  .superRefine(rejectResumeWithDate)

// ── Agent API: routines & seasons ─────────────────────────────────────────────
// Containers are agent-writable from schemaVersion 4. v1 deliberately shipped no
// write surface here (same posture custom types took); the call is that an agent
// acting for the user should reach what the user reaches, and hiding/unhiding a
// block of work is squarely that.
//
// Membership arrives as whole id ARRAYS, not add/remove deltas, matching
// db.ts reconcileMembership and the store. It costs a read-before-write on the
// caller, and buys idempotence: a retried PATCH cannot double-add, and two
// agents converge on the last full state rather than interleaving into a set
// neither asked for.
//
// The composite (id, user_id) foreign keys on the join tables make a
// cross-user member reference impossible at the DB level, so the route's own
// membership checks are about the rules Postgres CANNOT state: a subtask is not
// collectible (plan decision 7), and a 23503 should read as a 400 naming the
// offending id rather than a 500.

const containerIdentityShape = {
  name: z.string().min(1),
  /** icon:<LucideName> token, matching the container convention. */
  icon: clearable(z.string()),
  color: clearable(z.string()),
  sortOrder: clearable(z.number().int()),
}

export const RoutineCreateSchema = z
  .object({
    ...containerIdentityShape,
    usualTime: clearable(TimeOfDaySchema),
    id: OptionalIdSchema,
    itemIds: z.array(z.string().uuid()).optional(),
    ...pauseVerbShape,
  })
  .superRefine(rejectResumeWithDate)

export const RoutineUpdateSchema = z
  .object({
    ...containerIdentityShape,
    name: z.string().min(1).optional(),
    usualTime: clearable(TimeOfDaySchema),
    itemIds: z.array(z.string().uuid()).optional(),
    ...pauseVerbShape,
  })
  .superRefine(rejectResumeWithDate)

/**
 * An `auto` season whose range starts after it ends is live on no date at all,
 * so it hides every member permanently while reading as "seasonal, currently
 * out of season" — indistinguishable from a season that will come back. The
 * pickers bound each other in the UI; the API has to say so itself.
 */
const rejectInvertedRange = (
  data: { startsOn?: string | null; endsOn?: string | null },
  ctx: z.RefinementCtx,
) => {
  if (data.startsOn && data.endsOn && data.startsOn > data.endsOn) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'startsOn must not be after endsOn — that range is active on no date',
      path: ['endsOn'],
    })
  }
}

/**
 * A season does not pause; it switches. Say so instead of dropping the keys.
 *
 * Zod strips unknown keys, which is the right default for a field that means
 * nothing — but `paused` means something everywhere else in this API, so an
 * agent that learned it on routines will reasonably try it here and get
 * 200 {success:true} with the season still live. That is precisely the failure
 * a bare `pausedUntil` on a live item is rejected for: a write with no effect
 * that reports success is how an agent concludes the job is done and moves on.
 * The keys are in the shape ONLY so this refine can see them.
 */
const rejectSeasonPauseVerb = (
  data: { paused?: unknown; pausedUntil?: unknown; state?: unknown },
  ctx: z.RefinementCtx,
) => {
  if (data.paused === undefined && data.pausedUntil === undefined) return
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      'seasons switch through `state`, not paused/pausedUntil — use ' +
      "state: 'paused' to turn one off, 'active' to force it on, or 'auto' to " +
      'hand it back to its date range.',
    path: ['state'],
  })
}

const seasonRangeShape = {
  // Present only to be refused with a pointer to `state` — see
  // rejectSeasonPauseVerb. z.unknown() rather than the real types so a
  // malformed value still produces THAT message rather than a type error that
  // reads as though the field were supported.
  paused: z.unknown().optional(),
  pausedUntil: z.unknown().optional(),
  /**
   * 'auto' follows the range; 'active'/'paused' are manual overrides that win
   * over it. Omitted on create → 'auto', which with no range means "always on".
   */
  state: SeasonStateSchema.optional(),
  /** Inclusive bounds, either end open. Only read while state is 'auto'. */
  startsOn: clearable(DateOnlySchema),
  endsOn: clearable(DateOnlySchema),
  itemIds: z.array(z.string().uuid()).optional(),
  /** Held routines — their members ride along. */
  routineIds: z.array(z.string().uuid()).optional(),
}

export const SeasonCreateSchema = z
  .object({
    ...containerIdentityShape,
    id: OptionalIdSchema,
    ...seasonRangeShape,
  })
  .superRefine(rejectInvertedRange)
  .superRefine(rejectSeasonPauseVerb)

export const SeasonUpdateSchema = z
  .object({
    ...containerIdentityShape,
    name: z.string().min(1).optional(),
    ...seasonRangeShape,
  })
  // Sees only what the PATCH carries, so it catches a body that INTRODUCES an
  // inverted range. Half a range patched against a stored other half still
  // reaches the store unchecked — the same limitation requireCustomDays has,
  // and for the same reason: a refine cannot read the row.
  .superRefine(rejectInvertedRange)
  .superRefine(rejectSeasonPauseVerb)

// ── Agent API: goals ──────────────────────────────────────────────────────────
// Same posture as routines and seasons: an agent acting for the user should
// reach what the user reaches. Membership arrives as whole id ARRAYS per ROLE,
// matching db.ts's union reconcile and the store, and for the same idempotence
// reason — a retried PATCH cannot double-add.

/**
 * A goal switches through `state`, and `achievedAt` is DERIVED from it.
 *
 * Both keys are carried in the shape only so this refine can see them and
 * refuse with a pointer, the way `rejectSeasonPauseVerb` does. Zod strips
 * unknown keys, so without this an agent sending the verb it has learned
 * everywhere else — `paused: true`, or a hand-picked `achievedAt` — gets
 * `200 {success:true}` and a goal that did not move. A write with no effect
 * that reports success is how an agent concludes the job is done.
 *
 * The `achievedAt` half is the `pausedAt` argument exactly: an agent-chosen
 * timestamp is wrong in both directions — backdated it claims an achievement
 * that had not happened, postdated it leaves a goal that reads achieved with no
 * date. The server derives it from the state change.
 */
const rejectGoalDerivedFields = (
  data: { paused?: unknown; pausedUntil?: unknown; achievedAt?: unknown },
  ctx: z.RefinementCtx,
) => {
  if (data.paused !== undefined || data.pausedUntil !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'goals do not pause — they suppress nothing, so there is nothing to hide. ' +
        "Use state: 'achieved' or 'abandoned' to close one, or put the work in a " +
        'season if the intent is to hide it for a season.',
      path: ['state'],
    })
  }
  if (data.achievedAt !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "achievedAt is derived from `state` — send state: 'achieved' and the server " +
        'stamps it (and clears it when the goal reopens).',
      path: ['state'],
    })
  }
}

/**
 * The keys a goal does not have, because the OTHER containers do.
 *
 * Same argument as the pause verb, and stronger on every axis. `itemIds` is the
 * membership key on both routines and seasons; goals are the only container
 * that renamed it; and membership is the commonest goal write there is. A
 * model asked to "add these tasks to my Learn Chinese goal" reaches for
 * `itemIds`, Zod strips it, `updateGoal` finds an empty patch and issues no
 * statement at all — and the caller is told 200 for a write that did nothing.
 * A refusal that names the right key is the only outcome that ends the loop.
 *
 * `endsOn` is the same mistake one field over: a season's range ends, a goal
 * has a target it may well pass.
 */
const rejectForeignContainerKeys = (
  data: { itemIds?: unknown; routineIds?: unknown; endsOn?: unknown },
  ctx: z.RefinementCtx,
) => {
  if (data.itemIds !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'goals do not have itemIds — membership carries a ROLE. Use memberIds for ' +
        'ordinary work the goal contains, milestoneIds for one-shot targets, or ' +
        'checkinIds for a recurring review.',
      path: ['memberIds'],
    })
  }
  if (data.routineIds !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'goals hold items, not routines. Put the routine in a season, or add the ' +
        "routine's items to the goal directly.",
      path: ['memberIds'],
    })
  }
  if (data.endsOn !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'goals have a targetOn, not an endsOn — a target is when it is MEANT to be ' +
        'done, and passing it does not end the goal.',
      path: ['targetOn'],
    })
  }
}

/**
 * A goal whose target precedes its start describes a window that never opens.
 * `timeElapsed` returns null for it, so every ahead/behind reading on the goal
 * surface silently disappears while the header still promises a target date.
 */
const rejectInvertedGoalWindow = (
  data: { startsOn?: string | null; targetOn?: string | null },
  ctx: z.RefinementCtx,
) => {
  if (data.startsOn && data.targetOn && data.startsOn > data.targetOn) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'startsOn must not be after targetOn — that window never opens',
      path: ['targetOn'],
    })
  }
}

/**
 * One item, one role per goal — the primary key says so, and a body naming the
 * same id twice is two contradictory instructions rather than a preference.
 * Rejecting beats picking, the same call `rejectResumeWithDate` makes.
 */
const rejectOverlappingGoalRoles = (
  data: { memberIds?: string[]; milestoneIds?: string[]; checkinIds?: string[] },
  ctx: z.RefinementCtx,
) => {
  const seen = new Map<string, string>()
  for (const key of ['milestoneIds', 'checkinIds', 'memberIds'] as const) {
    for (const id of data[key] ?? []) {
      const already = seen.get(id)
      if (already && already !== key) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `item ${id} was given two roles at once (${already} and ${key}) — an item holds exactly one role per goal`,
          path: [key],
        })
        return
      }
      seen.set(id, key)
    }
  }
}

const goalShape = {
  /** The motivation line. Rendered on the goal surface and handed to Beacon. */
  why: clearable(z.string()),
  /** Lifecycle. Omitted on create → 'active'. */
  state: GoalStateSchema.optional(),
  startsOn: clearable(DateOnlySchema),
  targetOn: clearable(DateOnlySchema),
  memberIds: z.array(z.string().uuid()).optional(),
  milestoneIds: z.array(z.string().uuid()).optional(),
  checkinIds: z.array(z.string().uuid()).optional(),
  // Carried only to be refused, with a pointer — see rejectGoalDerivedFields
  // and rejectForeignContainerKeys.
  paused: z.unknown().optional(),
  pausedUntil: z.unknown().optional(),
  achievedAt: z.unknown().optional(),
  itemIds: z.unknown().optional(),
  routineIds: z.unknown().optional(),
  endsOn: z.unknown().optional(),
}

export const GoalCreateSchema = z
  .object({
    ...containerIdentityShape,
    id: OptionalIdSchema,
    ...goalShape,
  })
  .superRefine(rejectInvertedGoalWindow)
  .superRefine(rejectOverlappingGoalRoles)
  .superRefine(rejectGoalDerivedFields)
  .superRefine(rejectForeignContainerKeys)

export const GoalUpdateSchema = z
  .object({
    ...containerIdentityShape,
    name: z.string().min(1).optional(),
    ...goalShape,
  })
  // Sees only what the PATCH carries, so it catches a body that INTRODUCES an
  // inverted window. Half a window patched against a stored other half still
  // reaches the store unchecked — the same limitation SeasonUpdateSchema has.
  .superRefine(rejectInvertedGoalWindow)
  .superRefine(rejectOverlappingGoalRoles)
  .superRefine(rejectGoalDerivedFields)
  .superRefine(rejectForeignContainerKeys)

// ── API response schemas ───────────────────────────────────────────────────────

export const DsulContextResponseSchema = z.object({
  userId: z.string(),
  userTimezone: z.string().optional(),
  fetchedAt: z.string(),
  tasks: z.array(TaskSchema),
  habits: z.array(HabitSchema),
  projects: z.array(ProjectSchema),
  habitGroups: z.array(HabitGroupSchema),
  // Unified items (schemaVersion 3+). MUST stay optional: plugin builds parse
  // the whole response with one safeParse and would brick the cache against an
  // older server if this were required. Old builds strip it as an unknown key.
  items: z.array(ItemSchema).optional(),
  // The containers that decide whether an item is suppressed (schemaVersion 4+).
  // Same optionality rule as items[], and for a second reason here: the route
  // OMITS these keys when the tables are unreachable, because `[]` would assert
  // "you have no seasons" to a consumer that might helpfully offer to create
  // one. Absent means "this server did not say".
  routines: z.array(RoutineSchema).optional(),
  seasons: z.array(SeasonSchema).optional(),
  /**
   * The containers that say WHY work exists (schemaVersion 5+).
   *
   * Unlike routines and seasons, a goal suppresses nothing — so an item's
   * absence from tasks[] is never explained by a goal. These are here for the
   * opposite reason: so an agent asked "how is Learn Chinese going" can answer
   * from progress and the next milestone rather than guessing from item titles.
   * Optional, like every array before it: a plugin built against an older
   * schema strips the key rather than throwing.
   */
  goals: z.array(GoalSchema).optional(),
  // Additive (old clients strip unknown keys). 2 = tasks/habits are
  // projections of the unified items table; 3 = items[] present; 4 = routines[]
  // and seasons[] present, so a consumer can explain WHY an item it remembers
  // is missing from tasks[] instead of concluding it was deleted; 5 = goals[]
  // present, so a consumer can say what the work is FOR — progress, the next
  // milestone, the target — instead of inferring purpose from item titles;
  // 6 = programs[] renamed seasons[] (migration 049). Pre-6 builds read the
  // old key, find it absent, and fall back to "the server did not say" — the
  // optionality above is what makes that a quiet loss rather than a throw.
  schemaVersion: z.number().optional(),
})

// ── Proposals ──────────────────────────────────────────────────────────────────
// A proposal is a planner diff the AI suggests and the user accepts with one
// tap — the core interaction grammar (memory/plans/ai-vision.md). It lives here
// rather than app-side because both tiers emit it: the assistant tier via a
// structured completion, the agent tier via a gateway tool call.
//
// Two deliberate holes in the validation, both filled app-side by the type
// registry (lib/item-registry.ts), which is the only authority on per-type
// capability:
//   - `itemType` is an open string (custom types are user-defined slugs).
//   - `status` is an open string, NOT a union of the task/habit enums. The
//     vocabularies are frozen and per-type; merging them here would invent a
//     status vocabulary that no type actually accepts. validateProposal()
//     checks each value against that type's allowedStatuses.

const proposalFields = {
  title: z.string().min(1).max(500).optional(),
  startDate: z.string().optional(),
  timeBucket: TimeBucketSchema.optional(),
  startTime: z.string().optional(),
  priority: PrioritySchema.optional(),
  notes: z.string().max(10_000).optional(),
}

export const ProposalCreateOpSchema = z.object({
  ...proposalFields,
  kind: z.literal('create'),
  /** Registry type name: 'task', 'habit', or a user-defined slug. */
  itemType: z.string().min(1).max(100),
  /** Required on create — the one field a new item cannot be missing. */
  title: z.string().min(1).max(500),
  project: z.string().max(200).optional(),
  /**
   * Create this as a child of an existing item (the panel's Subtasks section).
   *
   * The breakdown verb: "this is too big" → a handful of steps under it. Only
   * valid on create — an EXISTING subtask may never be the target of an update
   * operation, because no view outside its parent's panel shows it, so a
   * change to one has no visible effect and no way to undo from where the user
   * is looking. Validation additionally requires that the parent's type allows
   * children and is not itself a child; nesting has no UI.
   */
  parentItemId: z.string().min(1).optional(),
})

export const ProposalUpdateOpSchema = z.object({
  ...proposalFields,
  kind: z.literal('update'),
  itemId: z.string().min(1).max(200),
  /** Null clears the field, matching the update-schema convention above. */
  startDate: z.string().nullable().optional(),
  timeBucket: TimeBucketSchema.nullable().optional(),
  startTime: z.string().nullable().optional(),
  priority: PrioritySchema.nullable().optional(),
  status: z.string().optional(),
})

export const ProposalOperationSchema = z.discriminatedUnion('kind', [
  ProposalCreateOpSchema,
  ProposalUpdateOpSchema,
])

export const ProposalSchema = z.object({
  id: z.string(),
  /** Card headline. Warm and specific — "Here's a lighter Tuesday". */
  summary: z.string().min(1).max(200),
  /** Optional second line explaining the thinking. Never scolding. */
  rationale: z.string().max(1000).optional(),
  /**
   * Capped because the producer is untrusted by design — on the agent tier it
   * is somebody else's gateway. The system prompts ask for at most eight;
   * nothing enforced it, and a 5,000-operation reply would render six visible
   * lines inside a scroll box under a button reading "Do all of it", then fan
   * out 5,000 unthrottled inserts on one tap. Twenty is well clear of any
   * honest plan, so exceeding it is malformed rather than merely long.
   */
  operations: z.array(ProposalOperationSchema).min(1).max(20),
  createdAt: z.string(),
})

/** What the model is asked to return; ids and timestamps are stamped locally. */
export const ProposalDraftSchema = ProposalSchema.omit({ id: true, createdAt: true })

export const DsulChangeEventSchema = z.object({
  event: z.enum([
    'tasks.updated',
    'habits.updated',
    'projects.updated',
    'habitGroups.updated',
  ]),
  userId: z.string(),
  data: z.unknown(),
  timestamp: z.string(),
})

// ── Devices (reminders Phase 1, migration 065) ─────────────────────────────────
//
// Every device dsul can reach: one `devices` row per device per account. Not
// agent data: nothing here reaches /api/agent/context, and schemaVersion does
// not move. The shapes mirror 065's CHECKs, so a body that would fail one is a
// 400 at the route rather than a 500 at Postgres.

export const DevicePlatformSchema = z.enum(['web', 'ios', 'watchos', 'android', 'wearos', 'electron'])
export const DeviceTransportSchema = z.enum(['webpush', 'apns', 'fcm', 'none'])
/** Who schedules this device's cues: the server ('push') or the device itself ('local'). Never both. */
export const DeviceDeliverySchema = z.enum(['push', 'local'])
export const DeviceFormSchema = z.enum(['phone', 'tablet', 'desktop', 'watch'])
/** What a send is about, for a device's per-kind switches. `other` is a push with no kind (/api/push/send). */
export const DeviceSendKindSchema = z.enum(['cue', 'snooze', 'last-call', 'eod', 'pledge', 'other'])

const DEVICE_ID = /^[A-Za-z0-9:._-]{8,128}$/
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * A device's own switches, edited by its owner (065 grants UPDATE on `prefs`
 * and `label` and nothing else). Every key is optional: an absent kind is ON,
 * so a device registered before a kind existed still gets it.
 */
export const DevicePrefsSchema = z.object({
  kinds: z.record(DeviceSendKindSchema, z.boolean()).optional(),
  quiet: z.object({ start: z.string().regex(HHMM), end: z.string().regex(HHMM) }).nullable().optional(),
  muted: z.boolean().optional(),
  claimsLocally: z.boolean().optional(),
})

/**
 * POST /api/devices. Strict: an unknown key is a 400, never ignored. The token
 * rules are 065's: `none` carries no token, `webpush` carries its keys, and
 * nothing else does.
 */
export const DeviceRegistrationSchema = z
  .object({
    deviceId: z.string().regex(DEVICE_ID),
    platform: DevicePlatformSchema,
    transport: DeviceTransportSchema,
    delivery: DeviceDeliverySchema.optional(),
    os: z.string().regex(/^[a-z]{2,16}$/).optional(),
    form: DeviceFormSchema.optional(),
    token: z.string().min(16).max(2048).regex(/^[^\s\x00-\x1f\x7f]+$/).optional(),
    keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }).strict().optional(),
    apnsEnvironment: z.enum(['production', 'sandbox']).optional(),
    parentDeviceId: z.string().regex(DEVICE_ID).optional(),
    label: z.string().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
    appVersion: z.string().max(64).optional(),
    osVersion: z.string().max(64).optional(),
    timezone: z.string().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if ((d.transport === 'none') !== (d.token === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['token'], message: 'a token goes with every transport but none' })
    }
    if ((d.transport === 'webpush') !== (d.keys !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keys'], message: 'keys go with webpush and nothing else' })
    }
    if ((d.transport === 'apns') !== (d.apnsEnvironment !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apnsEnvironment'], message: 'an APNs environment goes with apns and nothing else' })
    }
  })

/** A row of the owner's roster: what 065 grants `authenticated`. Never `token` or `keys`. */
export const DeviceSchema = z.object({
  id: z.string(),
  deviceId: z.string(),
  platform: DevicePlatformSchema,
  transport: DeviceTransportSchema,
  delivery: DeviceDeliverySchema,
  os: z.string().nullable(),
  form: DeviceFormSchema.nullable(),
  label: z.string().nullable(),
  timezone: z.string().nullable(),
  prefs: DevicePrefsSchema,
  registeredAt: z.string(),
  lastSeenAt: z.string(),
  lastSentAt: z.string().nullable(),
  lastFailure: z.string().nullable(),
})
