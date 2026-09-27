import { z } from 'zod';
export declare const PrioritySchema: z.ZodEnum<["low", "medium", "high"]>;
export declare const TimeBucketSchema: z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>;
export declare const TaskStatusSchema: z.ZodEnum<["pending", "completed", "cancelled"]>;
export declare const HabitStatusSchema: z.ZodEnum<["pending", "done", "skipped"]>;
export declare const RepeatFrequencySchema: z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>;
/**
 * 24-hour local wall-clock 'HH:mm'.
 *
 * Enforced at the WRITE boundary only. Migration 032 puts the same shape in a
 * CHECK constraint, so an unvalidated agent body would 500 at Postgres instead
 * of 400 here — the reasoning TaskCreateSchema already applies to uuids and the
 * aiStatus vocabulary. The READ shapes stay plain `z.string()`: a row written
 * before the constraint existed must never fail the whole context safeParse.
 */
export declare const TimeOfDaySchema: z.ZodString;
export declare const RecurrenceFieldsSchema: z.ZodObject<{
    repeatFrequency: z.ZodOptional<z.ZodEffects<z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", unknown>>;
    repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    repeatMonthDay: z.ZodOptional<z.ZodNumber>;
    completedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    skippedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
}, {
    repeatFrequency?: unknown;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
}>;
export type RecurrenceFields = z.infer<typeof RecurrenceFieldsSchema>;
export declare const ProjectSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    emoji: z.ZodString;
    /** CSS color, usually a var(--accent-N) token; unset → name-hash ramp. */
    color: z.ZodOptional<z.ZodString>;
    repeatFrequency: z.ZodOptional<z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>>;
    repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    repeatMonthDay: z.ZodOptional<z.ZodNumber>;
    timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
    startTime: z.ZodOptional<z.ZodString>;
    duration: z.ZodOptional<z.ZodNumber>;
    /** A free-text note — what this is for (migration 046). */
    notes: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    name: string;
    emoji: string;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    color?: string | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
}, {
    id: string;
    name: string;
    emoji: string;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    color?: string | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
}>;
export declare const HabitGroupSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    emoji: z.ZodString;
    color: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    name: string;
    emoji: string;
    color?: string | undefined;
}, {
    id: string;
    name: string;
    emoji: string;
    color?: string | undefined;
}>;
export declare const ProgramStateSchema: z.ZodEnum<["auto", "active", "paused"]>;
export declare const RoutineSchema: z.ZodObject<{
    /** A free-text note — what this is for (migration 046). */
    notes: z.ZodOptional<z.ZodString>;
    /** Member item ids (routine_items), in routine-internal order. */
    itemIds: z.ZodArray<z.ZodString, "many">;
    /**
     * ISO timestamp the pause began. Load-bearing, not decorative: it is the
     * resolver's LOWER bound, without which a pause started in August would
     * retro-suppress every unmarked occurrence back through July.
     */
    pausedAt: z.ZodOptional<z.ZodString>;
    /**
     * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
     * auto-resume needs no cron. A manual resume sets this to today rather than
     * clearing pausedAt, keeping the interval on the row for the auto-age
     * sweep's resume grace.
     */
    pausedUntil: z.ZodOptional<z.ZodString>;
    id: z.ZodString;
    name: z.ZodString;
    /** icon:<LucideName> token, matching the container convention. */
    icon: z.ZodOptional<z.ZodString>;
    /** CSS color, usually a var(--accent-N) token; unset → name-hash ramp. */
    color: z.ZodOptional<z.ZodString>;
    sortOrder: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    id: string;
    name: string;
    itemIds: string[];
    color?: string | undefined;
    notes?: string | undefined;
    icon?: string | undefined;
    sortOrder?: number | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
}, {
    id: string;
    name: string;
    itemIds: string[];
    color?: string | undefined;
    notes?: string | undefined;
    icon?: string | undefined;
    sortOrder?: number | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
}>;
export declare const ProgramSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    icon: z.ZodOptional<z.ZodString>;
    color: z.ZodOptional<z.ZodString>;
    sortOrder: z.ZodOptional<z.ZodNumber>;
    /**
     * 'auto' follows startsOn/endsOn (no range = always on); 'active'/'paused'
     * are manual overrides that always win, because flipping a program by hand
     * must never be second-guessed by a date. Several programs may be active at
     * once — the resolver unions their members.
     */
    state: z.ZodEnum<["auto", "active", "paused"]>;
    /** Inclusive bounds, either end open (yyyy-MM-dd). Only read when state is 'auto'. */
    startsOn: z.ZodOptional<z.ZodString>;
    endsOn: z.ZodOptional<z.ZodString>;
    /** A free-text note — what this is for (migration 046). */
    notes: z.ZodOptional<z.ZodString>;
    /** Directly-held item ids (program_items). */
    itemIds: z.ZodArray<z.ZodString, "many">;
    /** Held routine ids (program_routines) — their members ride along. */
    routineIds: z.ZodArray<z.ZodString, "many">;
    /**
     * Trigger-maintained, READ-ONLY app-side. It exists for one consumer: the
     * overdue sweep's grace (c). A manual `paused` → `active` flip has no
     * recorded date — the tri-state keeps no history — so this is the only
     * evidence that a program recently stopped hiding its members, and without it
     * the morning after someone turns a program back on the sweep unschedules
     * every member at once.
     *
     * Deliberately NOT in db.ts updateProgram's column allowlist: it appears in
     * PROGRAM_FIELDS (which is Object.keys of this shape) and therefore in undo's
     * container diff, where a stale value would otherwise be written back over
     * the trigger's.
     */
    updatedAt: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    name: string;
    itemIds: string[];
    state: "auto" | "active" | "paused";
    routineIds: string[];
    color?: string | undefined;
    notes?: string | undefined;
    icon?: string | undefined;
    sortOrder?: number | undefined;
    startsOn?: string | undefined;
    endsOn?: string | undefined;
    updatedAt?: string | undefined;
}, {
    id: string;
    name: string;
    itemIds: string[];
    state: "auto" | "active" | "paused";
    routineIds: string[];
    color?: string | undefined;
    notes?: string | undefined;
    icon?: string | undefined;
    sortOrder?: number | undefined;
    startsOn?: string | undefined;
    endsOn?: string | undefined;
    updatedAt?: string | undefined;
}>;
export declare const GoalStateSchema: z.ZodEnum<["active", "achieved", "abandoned"]>;
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
export declare const GoalRoleSchema: z.ZodEnum<["member", "milestone", "checkin"]>;
export declare const GoalSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    /** The motivation line — why this goal exists. Rendered on the goal surface, handed to Beacon. */
    why: z.ZodOptional<z.ZodString>;
    /** icon:<LucideName> token, matching the container convention. */
    icon: z.ZodOptional<z.ZodString>;
    /** CSS color, usually a var(--accent-N) token; unset → name-hash ramp. */
    color: z.ZodOptional<z.ZodString>;
    sortOrder: z.ZodOptional<z.ZodNumber>;
    state: z.ZodEnum<["active", "achieved", "abandoned"]>;
    /** Optional horizon (yyyy-MM-dd). `targetOn` is what the countdown and the behind/ahead read measure against. */
    startsOn: z.ZodOptional<z.ZodString>;
    targetOn: z.ZodOptional<z.ZodString>;
    /**
     * Stamped when `state` becomes 'achieved', cleared when it returns to
     * 'active'.
     *
     * App-written and IN db.ts's update allowlist — the deliberate opposite of
     * Program.updatedAt, which is kept OUT of its allowlist because a trigger
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
    achievedAt: z.ZodOptional<z.ZodString>;
    /** Ordinary supporting work — the daily practice habit, the odd task. */
    memberIds: z.ZodArray<z.ZodString, "many">;
    /** Achievement checkpoints, in timeline order (goal_items.sort_order). */
    milestoneIds: z.ZodArray<z.ZodString, "many">;
    /** Recurring reviews. */
    checkinIds: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    id: string;
    name: string;
    state: "active" | "achieved" | "abandoned";
    memberIds: string[];
    milestoneIds: string[];
    checkinIds: string[];
    color?: string | undefined;
    icon?: string | undefined;
    sortOrder?: number | undefined;
    startsOn?: string | undefined;
    why?: string | undefined;
    targetOn?: string | undefined;
    achievedAt?: string | undefined;
}, {
    id: string;
    name: string;
    state: "active" | "achieved" | "abandoned";
    memberIds: string[];
    milestoneIds: string[];
    checkinIds: string[];
    color?: string | undefined;
    icon?: string | undefined;
    sortOrder?: number | undefined;
    startsOn?: string | undefined;
    why?: string | undefined;
    targetOn?: string | undefined;
    achievedAt?: string | undefined;
}>;
export declare const TaskSchema: z.ZodEffects<z.ZodObject<{
    /**
     * Local wall-clock 'HH:mm' for this item's daily cue, or absent for no
     * reminder. NOT a timestamp: see migration 032 on why the instant-shaped
     * items.reminder_at column was left alone rather than reused.
     */
    reminderTime: z.ZodOptional<z.ZodString>;
    /**
     * The implementation-intention phrase the cue is rehearsed as — "after I pour
     * my coffee". Free text, never parsed; rendered into the notification body.
     */
    reminderAnchor: z.ZodOptional<z.ZodString>;
    /**
     * ISO timestamp the pause began. Load-bearing, not decorative: it is the
     * resolver's LOWER bound, without which a pause started in August would
     * retro-suppress every unmarked occurrence back through July.
     */
    pausedAt: z.ZodOptional<z.ZodString>;
    /**
     * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
     * auto-resume needs no cron. A manual resume sets this to today rather than
     * clearing pausedAt, keeping the interval on the row for the auto-age
     * sweep's resume grace.
     */
    pausedUntil: z.ZodOptional<z.ZodString>;
    repeatFrequency: z.ZodOptional<z.ZodEffects<z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", unknown>>;
    repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    repeatMonthDay: z.ZodOptional<z.ZodNumber>;
    completedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    skippedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    id: z.ZodString;
    title: z.ZodString;
    priority: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    project: z.ZodOptional<z.ZodString>;
    startDate: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<["pending", "completed", "cancelled"]>;
    timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
    startTime: z.ZodOptional<z.ZodString>;
    duration: z.ZodOptional<z.ZodNumber>;
    isScheduled: z.ZodBoolean;
    order: z.ZodNumber;
    inProjectBlock: z.ZodOptional<z.ZodBoolean>;
    previousStartTime: z.ZodOptional<z.ZodString>;
    previousStartDate: z.ZodOptional<z.ZodString>;
    notes: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
    /** Parent item id — this item is a subtask when set (items.parent_item_id). */
    parentItemId: z.ZodOptional<z.ZodString>;
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
    projectId: z.ZodOptional<z.ZodString>;
    /** Who's working this item: 'openclaw' | 'beacon' | free text. */
    assignee: z.ZodOptional<z.ZodString>;
    /** Agent progress state — write vocabulary: queued|working|blocked|done|failed. */
    aiStatus: z.ZodOptional<z.ZodString>;
    /** Agent's latest result/summary for this item. */
    aiResult: z.ZodOptional<z.ZodString>;
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
    aiStatusAt: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}, {
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    repeatFrequency?: unknown;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}>, {
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}, {
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    repeatFrequency?: unknown;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}>;
export declare const HabitSchema: z.ZodEffects<z.ZodObject<{
    group: z.ZodString;
    /**
     * Stable id of the group named by `group` (migration 027).
     *
     * Post-039 this is the PROJECT's id — the habit_groups row it used to name
     * became a projects row keeping its uuid, which is what lets this field mean
     * the same thing to an old plugin build without a translation table.
     */
    groupId: z.ZodOptional<z.ZodString>;
    /**
     * Local wall-clock 'HH:mm' for this item's daily cue, or absent for no
     * reminder. NOT a timestamp: see migration 032 on why the instant-shaped
     * items.reminder_at column was left alone rather than reused.
     */
    reminderTime: z.ZodOptional<z.ZodString>;
    /**
     * The implementation-intention phrase the cue is rehearsed as — "after I pour
     * my coffee". Free text, never parsed; rendered into the notification body.
     */
    reminderAnchor: z.ZodOptional<z.ZodString>;
    /**
     * ISO timestamp the pause began. Load-bearing, not decorative: it is the
     * resolver's LOWER bound, without which a pause started in August would
     * retro-suppress every unmarked occurrence back through July.
     */
    pausedAt: z.ZodOptional<z.ZodString>;
    /**
     * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
     * auto-resume needs no cron. A manual resume sets this to today rather than
     * clearing pausedAt, keeping the interval on the row for the auto-age
     * sweep's resume grace.
     */
    pausedUntil: z.ZodOptional<z.ZodString>;
    id: z.ZodString;
    title: z.ZodString;
    streak: z.ZodNumber;
    status: z.ZodEnum<["pending", "done", "skipped"]>;
    completedDates: z.ZodArray<z.ZodString, "many">;
    skippedDates: z.ZodArray<z.ZodString, "many">;
    dailyCounts: z.ZodRecord<z.ZodString, z.ZodNumber>;
    timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
    startTime: z.ZodOptional<z.ZodString>;
    duration: z.ZodOptional<z.ZodNumber>;
    repeatFrequency: z.ZodEffects<z.ZodUnion<[z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, z.ZodLiteral<"weekly">]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly">;
    repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    repeatMonthDay: z.ZodOptional<z.ZodNumber>;
    timesPerDay: z.ZodOptional<z.ZodNumber>;
    currentDayCount: z.ZodOptional<z.ZodNumber>;
    notes: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
}, "strip", z.ZodTypeAny, {
    status: "pending" | "done" | "skipped";
    repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom";
    completedDates: string[];
    skippedDates: string[];
    id: string;
    title: string;
    group: string;
    streak: number;
    dailyCounts: Record<string, number>;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    groupId?: string | undefined;
    timesPerDay?: number | undefined;
    currentDayCount?: number | undefined;
}, {
    status: "pending" | "done" | "skipped";
    repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly";
    completedDates: string[];
    skippedDates: string[];
    id: string;
    title: string;
    group: string;
    streak: number;
    dailyCounts: Record<string, number>;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    groupId?: string | undefined;
    timesPerDay?: number | undefined;
    currentDayCount?: number | undefined;
}>, {
    status: "pending" | "done" | "skipped";
    repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom";
    completedDates: string[];
    skippedDates: string[];
    id: string;
    title: string;
    group: string;
    streak: number;
    dailyCounts: Record<string, number>;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    groupId?: string | undefined;
    timesPerDay?: number | undefined;
    currentDayCount?: number | undefined;
}, {
    status: "pending" | "done" | "skipped";
    repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly";
    completedDates: string[];
    skippedDates: string[];
    id: string;
    title: string;
    group: string;
    streak: number;
    dailyCounts: Record<string, number>;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    groupId?: string | undefined;
    timesPerDay?: number | undefined;
    currentDayCount?: number | undefined;
}>;
export declare const TASK_FIELDS: (keyof z.infer<typeof TaskSchema>)[];
export declare const HABIT_FIELDS: (keyof z.infer<typeof HabitItemSchema>)[];
export declare const PROJECT_FIELDS: (keyof z.infer<typeof ProjectSchema>)[];
export declare const HABIT_GROUP_FIELDS: (keyof z.infer<typeof HabitGroupSchema>)[];
export declare const ROUTINE_FIELDS: (keyof z.infer<typeof RoutineSchema>)[];
export declare const PROGRAM_FIELDS: (keyof z.infer<typeof ProgramSchema>)[];
export declare const GOAL_FIELDS: (keyof z.infer<typeof GoalSchema>)[];
export declare const TaskItemSchema: z.ZodEffects<z.ZodObject<{
    /**
     * Local wall-clock 'HH:mm' for this item's daily cue, or absent for no
     * reminder. NOT a timestamp: see migration 032 on why the instant-shaped
     * items.reminder_at column was left alone rather than reused.
     */
    reminderTime: z.ZodOptional<z.ZodString>;
    /**
     * The implementation-intention phrase the cue is rehearsed as — "after I pour
     * my coffee". Free text, never parsed; rendered into the notification body.
     */
    reminderAnchor: z.ZodOptional<z.ZodString>;
    /**
     * ISO timestamp the pause began. Load-bearing, not decorative: it is the
     * resolver's LOWER bound, without which a pause started in August would
     * retro-suppress every unmarked occurrence back through July.
     */
    pausedAt: z.ZodOptional<z.ZodString>;
    /**
     * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
     * auto-resume needs no cron. A manual resume sets this to today rather than
     * clearing pausedAt, keeping the interval on the row for the auto-age
     * sweep's resume grace.
     */
    pausedUntil: z.ZodOptional<z.ZodString>;
    repeatFrequency: z.ZodOptional<z.ZodEffects<z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", unknown>>;
    repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    repeatMonthDay: z.ZodOptional<z.ZodNumber>;
    completedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    skippedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    id: z.ZodString;
    title: z.ZodString;
    priority: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    project: z.ZodOptional<z.ZodString>;
    startDate: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<["pending", "completed", "cancelled"]>;
    timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
    startTime: z.ZodOptional<z.ZodString>;
    duration: z.ZodOptional<z.ZodNumber>;
    isScheduled: z.ZodBoolean;
    order: z.ZodNumber;
    inProjectBlock: z.ZodOptional<z.ZodBoolean>;
    previousStartTime: z.ZodOptional<z.ZodString>;
    previousStartDate: z.ZodOptional<z.ZodString>;
    notes: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
    /** Parent item id — this item is a subtask when set (items.parent_item_id). */
    parentItemId: z.ZodOptional<z.ZodString>;
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
    projectId: z.ZodOptional<z.ZodString>;
    /** Who's working this item: 'openclaw' | 'beacon' | free text. */
    assignee: z.ZodOptional<z.ZodString>;
    /** Agent progress state — write vocabulary: queued|working|blocked|done|failed. */
    aiStatus: z.ZodOptional<z.ZodString>;
    /** Agent's latest result/summary for this item. */
    aiResult: z.ZodOptional<z.ZodString>;
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
    aiStatusAt: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"task">;
}, "strip", z.ZodTypeAny, {
    type: "task";
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}, {
    type: "task";
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    repeatFrequency?: unknown;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}>, {
    type: "task";
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}, {
    type: "task";
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    repeatFrequency?: unknown;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}>;
export declare const HabitItemSchema: z.ZodEffects<z.ZodObject<{
    /**
     * Optional, exactly like the task side's — one CLASSIFY axis means one field
     * shape, and every consumer reads `item.project` off the union without
     * narrowing. "A habit must be filed somewhere" is a CAPABILITY
     * (`containerRequired`), enforced by the dialog and the seed fallback, not by
     * this field's presence: the legacy column was NOT NULL and produced '' for
     * the unset case, so making the type require a string only ever moved that ''
     * around. `toLegacyHabit` restores the required `group: string` on the way out.
     */
    project: z.ZodOptional<z.ZodString>;
    /** See taskShape.projectId: the name stays authoritative, the id survives renames. */
    projectId: z.ZodOptional<z.ZodString>;
    /**
     * Local wall-clock 'HH:mm' for this item's daily cue, or absent for no
     * reminder. NOT a timestamp: see migration 032 on why the instant-shaped
     * items.reminder_at column was left alone rather than reused.
     */
    reminderTime: z.ZodOptional<z.ZodString>;
    /**
     * The implementation-intention phrase the cue is rehearsed as — "after I pour
     * my coffee". Free text, never parsed; rendered into the notification body.
     */
    reminderAnchor: z.ZodOptional<z.ZodString>;
    /**
     * ISO timestamp the pause began. Load-bearing, not decorative: it is the
     * resolver's LOWER bound, without which a pause started in August would
     * retro-suppress every unmarked occurrence back through July.
     */
    pausedAt: z.ZodOptional<z.ZodString>;
    /**
     * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
     * auto-resume needs no cron. A manual resume sets this to today rather than
     * clearing pausedAt, keeping the interval on the row for the auto-age
     * sweep's resume grace.
     */
    pausedUntil: z.ZodOptional<z.ZodString>;
    id: z.ZodString;
    title: z.ZodString;
    streak: z.ZodNumber;
    status: z.ZodEnum<["pending", "done", "skipped"]>;
    completedDates: z.ZodArray<z.ZodString, "many">;
    skippedDates: z.ZodArray<z.ZodString, "many">;
    dailyCounts: z.ZodRecord<z.ZodString, z.ZodNumber>;
    timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
    startTime: z.ZodOptional<z.ZodString>;
    duration: z.ZodOptional<z.ZodNumber>;
    repeatFrequency: z.ZodEffects<z.ZodUnion<[z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, z.ZodLiteral<"weekly">]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly">;
    repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    repeatMonthDay: z.ZodOptional<z.ZodNumber>;
    timesPerDay: z.ZodOptional<z.ZodNumber>;
    currentDayCount: z.ZodOptional<z.ZodNumber>;
    notes: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
    type: z.ZodLiteral<"habit">;
}, "strip", z.ZodTypeAny, {
    type: "habit";
    status: "pending" | "done" | "skipped";
    repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom";
    completedDates: string[];
    skippedDates: string[];
    id: string;
    title: string;
    streak: number;
    dailyCounts: Record<string, number>;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    project?: string | undefined;
    projectId?: string | undefined;
    timesPerDay?: number | undefined;
    currentDayCount?: number | undefined;
}, {
    type: "habit";
    status: "pending" | "done" | "skipped";
    repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly";
    completedDates: string[];
    skippedDates: string[];
    id: string;
    title: string;
    streak: number;
    dailyCounts: Record<string, number>;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    project?: string | undefined;
    projectId?: string | undefined;
    timesPerDay?: number | undefined;
    currentDayCount?: number | undefined;
}>, {
    type: "habit";
    status: "pending" | "done" | "skipped";
    repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom";
    completedDates: string[];
    skippedDates: string[];
    id: string;
    title: string;
    streak: number;
    dailyCounts: Record<string, number>;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    project?: string | undefined;
    projectId?: string | undefined;
    timesPerDay?: number | undefined;
    currentDayCount?: number | undefined;
}, {
    type: "habit";
    status: "pending" | "done" | "skipped";
    repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly";
    completedDates: string[];
    skippedDates: string[];
    id: string;
    title: string;
    streak: number;
    dailyCounts: Record<string, number>;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    project?: string | undefined;
    projectId?: string | undefined;
    timesPerDay?: number | undefined;
    currentDayCount?: number | undefined;
}>;
export declare const CustomItemSchema: z.ZodEffects<z.ZodObject<{
    /**
     * Local wall-clock 'HH:mm' for this item's daily cue, or absent for no
     * reminder. NOT a timestamp: see migration 032 on why the instant-shaped
     * items.reminder_at column was left alone rather than reused.
     */
    reminderTime: z.ZodOptional<z.ZodString>;
    /**
     * The implementation-intention phrase the cue is rehearsed as — "after I pour
     * my coffee". Free text, never parsed; rendered into the notification body.
     */
    reminderAnchor: z.ZodOptional<z.ZodString>;
    /**
     * ISO timestamp the pause began. Load-bearing, not decorative: it is the
     * resolver's LOWER bound, without which a pause started in August would
     * retro-suppress every unmarked occurrence back through July.
     */
    pausedAt: z.ZodOptional<z.ZodString>;
    /**
     * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
     * auto-resume needs no cron. A manual resume sets this to today rather than
     * clearing pausedAt, keeping the interval on the row for the auto-age
     * sweep's resume grace.
     */
    pausedUntil: z.ZodOptional<z.ZodString>;
    repeatFrequency: z.ZodOptional<z.ZodEffects<z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", unknown>>;
    repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    repeatMonthDay: z.ZodOptional<z.ZodNumber>;
    completedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    skippedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    id: z.ZodString;
    title: z.ZodString;
    priority: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    project: z.ZodOptional<z.ZodString>;
    startDate: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<["pending", "completed", "cancelled"]>;
    timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
    startTime: z.ZodOptional<z.ZodString>;
    duration: z.ZodOptional<z.ZodNumber>;
    isScheduled: z.ZodBoolean;
    order: z.ZodNumber;
    inProjectBlock: z.ZodOptional<z.ZodBoolean>;
    previousStartTime: z.ZodOptional<z.ZodString>;
    previousStartDate: z.ZodOptional<z.ZodString>;
    notes: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
    /** Parent item id — this item is a subtask when set (items.parent_item_id). */
    parentItemId: z.ZodOptional<z.ZodString>;
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
    projectId: z.ZodOptional<z.ZodString>;
    /** Who's working this item: 'openclaw' | 'beacon' | free text. */
    assignee: z.ZodOptional<z.ZodString>;
    /** Agent progress state — write vocabulary: queued|working|blocked|done|failed. */
    aiStatus: z.ZodOptional<z.ZodString>;
    /** Agent's latest result/summary for this item. */
    aiResult: z.ZodOptional<z.ZodString>;
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
    aiStatusAt: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"custom">;
    /**
     * The user-defined type's machine name (item_types.name), e.g. 'errand'.
     *
     * NOT 'goal', which this example used to be: a Goal is a CONTAINER now
     * (GoalSchema above, migration 036), and an item type of the same name is a
     * different thing in a different namespace. Both keep working — the console
     * shows them in different sections — but the example should not teach the
     * collision.
     */
    customType: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "custom";
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    customType: string;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}, {
    type: "custom";
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    customType: string;
    repeatFrequency?: unknown;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}>, {
    type: "custom";
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    customType: string;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}, {
    type: "custom";
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    customType: string;
    repeatFrequency?: unknown;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}>;
export declare const ItemSchema: z.ZodEffects<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    /**
     * Local wall-clock 'HH:mm' for this item's daily cue, or absent for no
     * reminder. NOT a timestamp: see migration 032 on why the instant-shaped
     * items.reminder_at column was left alone rather than reused.
     */
    reminderTime: z.ZodOptional<z.ZodString>;
    /**
     * The implementation-intention phrase the cue is rehearsed as — "after I pour
     * my coffee". Free text, never parsed; rendered into the notification body.
     */
    reminderAnchor: z.ZodOptional<z.ZodString>;
    /**
     * ISO timestamp the pause began. Load-bearing, not decorative: it is the
     * resolver's LOWER bound, without which a pause started in August would
     * retro-suppress every unmarked occurrence back through July.
     */
    pausedAt: z.ZodOptional<z.ZodString>;
    /**
     * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
     * auto-resume needs no cron. A manual resume sets this to today rather than
     * clearing pausedAt, keeping the interval on the row for the auto-age
     * sweep's resume grace.
     */
    pausedUntil: z.ZodOptional<z.ZodString>;
    repeatFrequency: z.ZodOptional<z.ZodEffects<z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", unknown>>;
    repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    repeatMonthDay: z.ZodOptional<z.ZodNumber>;
    completedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    skippedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    id: z.ZodString;
    title: z.ZodString;
    priority: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    project: z.ZodOptional<z.ZodString>;
    startDate: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<["pending", "completed", "cancelled"]>;
    timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
    startTime: z.ZodOptional<z.ZodString>;
    duration: z.ZodOptional<z.ZodNumber>;
    isScheduled: z.ZodBoolean;
    order: z.ZodNumber;
    inProjectBlock: z.ZodOptional<z.ZodBoolean>;
    previousStartTime: z.ZodOptional<z.ZodString>;
    previousStartDate: z.ZodOptional<z.ZodString>;
    notes: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
    /** Parent item id — this item is a subtask when set (items.parent_item_id). */
    parentItemId: z.ZodOptional<z.ZodString>;
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
    projectId: z.ZodOptional<z.ZodString>;
    /** Who's working this item: 'openclaw' | 'beacon' | free text. */
    assignee: z.ZodOptional<z.ZodString>;
    /** Agent progress state — write vocabulary: queued|working|blocked|done|failed. */
    aiStatus: z.ZodOptional<z.ZodString>;
    /** Agent's latest result/summary for this item. */
    aiResult: z.ZodOptional<z.ZodString>;
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
    aiStatusAt: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"task">;
}, "strip", z.ZodTypeAny, {
    type: "task";
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}, {
    type: "task";
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    repeatFrequency?: unknown;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}>, z.ZodObject<{
    /**
     * Optional, exactly like the task side's — one CLASSIFY axis means one field
     * shape, and every consumer reads `item.project` off the union without
     * narrowing. "A habit must be filed somewhere" is a CAPABILITY
     * (`containerRequired`), enforced by the dialog and the seed fallback, not by
     * this field's presence: the legacy column was NOT NULL and produced '' for
     * the unset case, so making the type require a string only ever moved that ''
     * around. `toLegacyHabit` restores the required `group: string` on the way out.
     */
    project: z.ZodOptional<z.ZodString>;
    /** See taskShape.projectId: the name stays authoritative, the id survives renames. */
    projectId: z.ZodOptional<z.ZodString>;
    /**
     * Local wall-clock 'HH:mm' for this item's daily cue, or absent for no
     * reminder. NOT a timestamp: see migration 032 on why the instant-shaped
     * items.reminder_at column was left alone rather than reused.
     */
    reminderTime: z.ZodOptional<z.ZodString>;
    /**
     * The implementation-intention phrase the cue is rehearsed as — "after I pour
     * my coffee". Free text, never parsed; rendered into the notification body.
     */
    reminderAnchor: z.ZodOptional<z.ZodString>;
    /**
     * ISO timestamp the pause began. Load-bearing, not decorative: it is the
     * resolver's LOWER bound, without which a pause started in August would
     * retro-suppress every unmarked occurrence back through July.
     */
    pausedAt: z.ZodOptional<z.ZodString>;
    /**
     * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
     * auto-resume needs no cron. A manual resume sets this to today rather than
     * clearing pausedAt, keeping the interval on the row for the auto-age
     * sweep's resume grace.
     */
    pausedUntil: z.ZodOptional<z.ZodString>;
    id: z.ZodString;
    title: z.ZodString;
    streak: z.ZodNumber;
    status: z.ZodEnum<["pending", "done", "skipped"]>;
    completedDates: z.ZodArray<z.ZodString, "many">;
    skippedDates: z.ZodArray<z.ZodString, "many">;
    dailyCounts: z.ZodRecord<z.ZodString, z.ZodNumber>;
    timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
    startTime: z.ZodOptional<z.ZodString>;
    duration: z.ZodOptional<z.ZodNumber>;
    repeatFrequency: z.ZodEffects<z.ZodUnion<[z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, z.ZodLiteral<"weekly">]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly">;
    repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    repeatMonthDay: z.ZodOptional<z.ZodNumber>;
    timesPerDay: z.ZodOptional<z.ZodNumber>;
    currentDayCount: z.ZodOptional<z.ZodNumber>;
    notes: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
    type: z.ZodLiteral<"habit">;
}, "strip", z.ZodTypeAny, {
    type: "habit";
    status: "pending" | "done" | "skipped";
    repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom";
    completedDates: string[];
    skippedDates: string[];
    id: string;
    title: string;
    streak: number;
    dailyCounts: Record<string, number>;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    project?: string | undefined;
    projectId?: string | undefined;
    timesPerDay?: number | undefined;
    currentDayCount?: number | undefined;
}, {
    type: "habit";
    status: "pending" | "done" | "skipped";
    repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly";
    completedDates: string[];
    skippedDates: string[];
    id: string;
    title: string;
    streak: number;
    dailyCounts: Record<string, number>;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    project?: string | undefined;
    projectId?: string | undefined;
    timesPerDay?: number | undefined;
    currentDayCount?: number | undefined;
}>, z.ZodObject<{
    /**
     * Local wall-clock 'HH:mm' for this item's daily cue, or absent for no
     * reminder. NOT a timestamp: see migration 032 on why the instant-shaped
     * items.reminder_at column was left alone rather than reused.
     */
    reminderTime: z.ZodOptional<z.ZodString>;
    /**
     * The implementation-intention phrase the cue is rehearsed as — "after I pour
     * my coffee". Free text, never parsed; rendered into the notification body.
     */
    reminderAnchor: z.ZodOptional<z.ZodString>;
    /**
     * ISO timestamp the pause began. Load-bearing, not decorative: it is the
     * resolver's LOWER bound, without which a pause started in August would
     * retro-suppress every unmarked occurrence back through July.
     */
    pausedAt: z.ZodOptional<z.ZodString>;
    /**
     * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
     * auto-resume needs no cron. A manual resume sets this to today rather than
     * clearing pausedAt, keeping the interval on the row for the auto-age
     * sweep's resume grace.
     */
    pausedUntil: z.ZodOptional<z.ZodString>;
    repeatFrequency: z.ZodOptional<z.ZodEffects<z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", unknown>>;
    repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    repeatMonthDay: z.ZodOptional<z.ZodNumber>;
    completedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    skippedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    id: z.ZodString;
    title: z.ZodString;
    priority: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    project: z.ZodOptional<z.ZodString>;
    startDate: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<["pending", "completed", "cancelled"]>;
    timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
    startTime: z.ZodOptional<z.ZodString>;
    duration: z.ZodOptional<z.ZodNumber>;
    isScheduled: z.ZodBoolean;
    order: z.ZodNumber;
    inProjectBlock: z.ZodOptional<z.ZodBoolean>;
    previousStartTime: z.ZodOptional<z.ZodString>;
    previousStartDate: z.ZodOptional<z.ZodString>;
    notes: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
    /** Parent item id — this item is a subtask when set (items.parent_item_id). */
    parentItemId: z.ZodOptional<z.ZodString>;
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
    projectId: z.ZodOptional<z.ZodString>;
    /** Who's working this item: 'openclaw' | 'beacon' | free text. */
    assignee: z.ZodOptional<z.ZodString>;
    /** Agent progress state — write vocabulary: queued|working|blocked|done|failed. */
    aiStatus: z.ZodOptional<z.ZodString>;
    /** Agent's latest result/summary for this item. */
    aiResult: z.ZodOptional<z.ZodString>;
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
    aiStatusAt: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"custom">;
    /**
     * The user-defined type's machine name (item_types.name), e.g. 'errand'.
     *
     * NOT 'goal', which this example used to be: a Goal is a CONTAINER now
     * (GoalSchema above, migration 036), and an item type of the same name is a
     * different thing in a different namespace. Both keep working — the console
     * shows them in different sections — but the example should not teach the
     * collision.
     */
    customType: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "custom";
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    customType: string;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}, {
    type: "custom";
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    customType: string;
    repeatFrequency?: unknown;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}>]>, {
    type: "habit";
    status: "pending" | "done" | "skipped";
    repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom";
    completedDates: string[];
    skippedDates: string[];
    id: string;
    title: string;
    streak: number;
    dailyCounts: Record<string, number>;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    project?: string | undefined;
    projectId?: string | undefined;
    timesPerDay?: number | undefined;
    currentDayCount?: number | undefined;
} | {
    type: "task";
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
} | {
    type: "custom";
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    customType: string;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}, {
    type: "habit";
    status: "pending" | "done" | "skipped";
    repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly";
    completedDates: string[];
    skippedDates: string[];
    id: string;
    title: string;
    streak: number;
    dailyCounts: Record<string, number>;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    project?: string | undefined;
    projectId?: string | undefined;
    timesPerDay?: number | undefined;
    currentDayCount?: number | undefined;
} | {
    type: "task";
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    repeatFrequency?: unknown;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
} | {
    type: "custom";
    status: "pending" | "completed" | "cancelled";
    id: string;
    title: string;
    isScheduled: boolean;
    order: number;
    customType: string;
    repeatFrequency?: unknown;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    pausedAt?: string | undefined;
    pausedUntil?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    projectId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: string | undefined;
    aiResult?: string | undefined;
    aiStatusAt?: string | undefined;
}>;
export declare const ItemTypeDefSchema: z.ZodObject<{
    id: z.ZodString;
    /** Machine name used as items.type — lowercase slug; 'task'/'habit'/'custom' reserved. */
    name: z.ZodEffects<z.ZodString, string, string>;
    label: z.ZodString;
    labelPlural: z.ZodString;
    icon: z.ZodOptional<z.ZodString>;
    color: z.ZodOptional<z.ZodString>;
    /** Capability overrides of the app-side custom-type template. */
    config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    name: string;
    label: string;
    labelPlural: string;
    color?: string | undefined;
    icon?: string | undefined;
    config?: Record<string, unknown> | undefined;
}, {
    id: string;
    name: string;
    label: string;
    labelPlural: string;
    color?: string | undefined;
    icon?: string | undefined;
    config?: Record<string, unknown> | undefined;
}>;
/**
 * The delegation lifecycle.
 *
 * A FROZEN external contract from the moment a real agent writes it: the UI
 * renders these values, the MCP tool surface offers them, and an agent that
 * learned one spelling cannot be asked to relearn it. Extend additively, never
 * rename. Named here rather than inlined so the app, the agent API and the tool
 * surface cannot drift into three slightly different vocabularies.
 */
export declare const AiStatusSchema: z.ZodEnum<["queued", "working", "blocked", "done", "failed"]>;
export declare const TaskCreateSchema: z.ZodEffects<z.ZodObject<Omit<{
    id: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
    title: z.ZodString;
    status: z.ZodOptional<z.ZodEnum<["pending", "completed", "cancelled"]>>;
    isScheduled: z.ZodOptional<z.ZodBoolean>;
    order: z.ZodOptional<z.ZodNumber>;
    duration: z.ZodOptional<z.ZodNumber>;
    repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    repeatMonthDay: z.ZodOptional<z.ZodNumber>;
    parentItemId: z.ZodOptional<z.ZodString>;
    aiStatus: z.ZodOptional<z.ZodEnum<["queued", "working", "blocked", "done", "failed"]>>;
    reminderTime: z.ZodOptional<z.ZodString>;
    /**
     * The implementation-intention phrase the cue is rehearsed as — "after I pour
     * my coffee". Free text, never parsed; rendered into the notification body.
     */
    reminderAnchor: z.ZodOptional<z.ZodString>;
    /**
     * ISO timestamp the pause began. Load-bearing, not decorative: it is the
     * resolver's LOWER bound, without which a pause started in August would
     * retro-suppress every unmarked occurrence back through July.
     */
    pausedAt: z.ZodOptional<z.ZodString>;
    /**
     * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
     * auto-resume needs no cron. A manual resume sets this to today rather than
     * clearing pausedAt, keeping the interval on the row for the auto-age
     * sweep's resume grace.
     */
    pausedUntil: z.ZodOptional<z.ZodString>;
    repeatFrequency: z.ZodOptional<z.ZodEffects<z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", unknown>>;
    completedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    skippedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    priority: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    project: z.ZodOptional<z.ZodString>;
    startDate: z.ZodOptional<z.ZodString>;
    timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
    startTime: z.ZodOptional<z.ZodString>;
    inProjectBlock: z.ZodOptional<z.ZodBoolean>;
    previousStartTime: z.ZodOptional<z.ZodString>;
    previousStartDate: z.ZodOptional<z.ZodString>;
    notes: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
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
    projectId: z.ZodOptional<z.ZodString>;
    /** Who's working this item: 'openclaw' | 'beacon' | free text. */
    assignee: z.ZodOptional<z.ZodString>;
    /** Agent's latest result/summary for this item. */
    aiResult: z.ZodOptional<z.ZodString>;
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
    aiStatusAt: z.ZodOptional<z.ZodString>;
}, "pausedAt" | "pausedUntil" | "projectId" | "aiStatusAt">, "strip", z.ZodTypeAny, {
    title: string;
    status?: "pending" | "completed" | "cancelled" | undefined;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    id?: string | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    isScheduled?: boolean | undefined;
    order?: number | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: "done" | "queued" | "working" | "blocked" | "failed" | undefined;
    aiResult?: string | undefined;
}, {
    title: string;
    status?: "pending" | "completed" | "cancelled" | undefined;
    repeatFrequency?: unknown;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    id?: string | null | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    isScheduled?: boolean | undefined;
    order?: number | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: "done" | "queued" | "working" | "blocked" | "failed" | undefined;
    aiResult?: string | undefined;
}>, {
    title: string;
    status?: "pending" | "completed" | "cancelled" | undefined;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    id?: string | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    isScheduled?: boolean | undefined;
    order?: number | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: "done" | "queued" | "working" | "blocked" | "failed" | undefined;
    aiResult?: string | undefined;
}, {
    title: string;
    status?: "pending" | "completed" | "cancelled" | undefined;
    repeatFrequency?: unknown;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    id?: string | null | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    isScheduled?: boolean | undefined;
    order?: number | undefined;
    inProjectBlock?: boolean | undefined;
    previousStartTime?: string | undefined;
    previousStartDate?: string | undefined;
    parentItemId?: string | undefined;
    assignee?: string | undefined;
    aiStatus?: "done" | "queued" | "working" | "blocked" | "failed" | undefined;
    aiResult?: string | undefined;
}>;
export declare const HabitCreateSchema: z.ZodEffects<z.ZodObject<Omit<{
    id: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
    title: z.ZodString;
    group: z.ZodOptional<z.ZodString>;
    streak: z.ZodOptional<z.ZodNumber>;
    duration: z.ZodOptional<z.ZodNumber>;
    status: z.ZodOptional<z.ZodEnum<["pending", "done", "skipped"]>>;
    completedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    skippedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    dailyCounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    repeatFrequency: z.ZodOptional<z.ZodEffects<z.ZodUnion<[z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, z.ZodLiteral<"weekly">]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly">>;
    repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    repeatMonthDay: z.ZodOptional<z.ZodNumber>;
    timesPerDay: z.ZodOptional<z.ZodNumber>;
    currentDayCount: z.ZodOptional<z.ZodNumber>;
    reminderTime: z.ZodOptional<z.ZodString>;
    /**
     * Stable id of the group named by `group` (migration 027).
     *
     * Post-039 this is the PROJECT's id — the habit_groups row it used to name
     * became a projects row keeping its uuid, which is what lets this field mean
     * the same thing to an old plugin build without a translation table.
     */
    groupId: z.ZodOptional<z.ZodString>;
    /**
     * The implementation-intention phrase the cue is rehearsed as — "after I pour
     * my coffee". Free text, never parsed; rendered into the notification body.
     */
    reminderAnchor: z.ZodOptional<z.ZodString>;
    /**
     * ISO timestamp the pause began. Load-bearing, not decorative: it is the
     * resolver's LOWER bound, without which a pause started in August would
     * retro-suppress every unmarked occurrence back through July.
     */
    pausedAt: z.ZodOptional<z.ZodString>;
    /**
     * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
     * auto-resume needs no cron. A manual resume sets this to today rather than
     * clearing pausedAt, keeping the interval on the row for the auto-age
     * sweep's resume grace.
     */
    pausedUntil: z.ZodOptional<z.ZodString>;
    timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
    startTime: z.ZodOptional<z.ZodString>;
    notes: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
}, "pausedAt" | "pausedUntil" | "groupId">, "strip", z.ZodTypeAny, {
    title: string;
    status?: "pending" | "done" | "skipped" | undefined;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    id?: string | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    group?: string | undefined;
    streak?: number | undefined;
    dailyCounts?: Record<string, number> | undefined;
    timesPerDay?: number | undefined;
    currentDayCount?: number | undefined;
}, {
    title: string;
    status?: "pending" | "done" | "skipped" | undefined;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    id?: string | null | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    group?: string | undefined;
    streak?: number | undefined;
    dailyCounts?: Record<string, number> | undefined;
    timesPerDay?: number | undefined;
    currentDayCount?: number | undefined;
}>, {
    title: string;
    status?: "pending" | "done" | "skipped" | undefined;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    id?: string | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    group?: string | undefined;
    streak?: number | undefined;
    dailyCounts?: Record<string, number> | undefined;
    timesPerDay?: number | undefined;
    currentDayCount?: number | undefined;
}, {
    title: string;
    status?: "pending" | "done" | "skipped" | undefined;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly" | undefined;
    repeatDays?: number[] | undefined;
    repeatMonthDay?: number | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    id?: string | null | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    duration?: number | undefined;
    notes?: string | null | undefined;
    reminderTime?: string | undefined;
    reminderAnchor?: string | undefined;
    group?: string | undefined;
    streak?: number | undefined;
    dailyCounts?: Record<string, number> | undefined;
    timesPerDay?: number | undefined;
    currentDayCount?: number | undefined;
}>;
export declare const TaskUpdateSchema: z.ZodEffects<z.ZodEffects<z.ZodObject<{
    /** true → pause from now; false → resume today. Omit to leave pause state alone. */
    paused: z.ZodOptional<z.ZodBoolean>;
    /**
     * Resume date (EXCLUSIVE — live again ON this date). Sent with `paused: true`
     * it sets the end of the pause; sent alone it moves the resume date of a
     * pause already running. `null` means "paused with no end date".
     */
    pausedUntil: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    title: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<["pending", "completed", "cancelled"]>>;
    priority: z.ZodOptional<z.ZodNullable<z.ZodEnum<["low", "medium", "high"]>>>;
    project: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    startDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    timeBucket: z.ZodOptional<z.ZodNullable<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>>;
    startTime: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    duration: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    isScheduled: z.ZodOptional<z.ZodBoolean>;
    order: z.ZodOptional<z.ZodNumber>;
    inProjectBlock: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    previousStartTime: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    previousStartDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    notes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    repeatFrequency: z.ZodOptional<z.ZodNullable<z.ZodEffects<z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", unknown>>>;
    repeatDays: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodNumber, "many">>>;
    repeatMonthDay: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    completedDates: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString, "many">>>;
    skippedDates: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString, "many">>>;
    parentItemId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    assignee: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    aiStatus: z.ZodOptional<z.ZodNullable<z.ZodEnum<["queued", "working", "blocked", "done", "failed"]>>>;
    aiResult: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    reminderTime: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    reminderAnchor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    status?: "pending" | "completed" | "cancelled" | undefined;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | null | undefined;
    repeatDays?: number[] | null | undefined;
    repeatMonthDay?: number | null | undefined;
    completedDates?: string[] | null | undefined;
    skippedDates?: string[] | null | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
    startTime?: string | null | undefined;
    duration?: number | null | undefined;
    notes?: string | null | undefined;
    paused?: boolean | undefined;
    pausedUntil?: string | null | undefined;
    reminderTime?: string | null | undefined;
    reminderAnchor?: string | null | undefined;
    title?: string | undefined;
    priority?: "low" | "medium" | "high" | null | undefined;
    project?: string | null | undefined;
    startDate?: string | null | undefined;
    isScheduled?: boolean | undefined;
    order?: number | undefined;
    inProjectBlock?: boolean | null | undefined;
    previousStartTime?: string | null | undefined;
    previousStartDate?: string | null | undefined;
    parentItemId?: string | null | undefined;
    assignee?: string | null | undefined;
    aiStatus?: "done" | "queued" | "working" | "blocked" | "failed" | null | undefined;
    aiResult?: string | null | undefined;
}, {
    status?: "pending" | "completed" | "cancelled" | undefined;
    repeatFrequency?: unknown;
    repeatDays?: number[] | null | undefined;
    repeatMonthDay?: number | null | undefined;
    completedDates?: string[] | null | undefined;
    skippedDates?: string[] | null | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
    startTime?: string | null | undefined;
    duration?: number | null | undefined;
    notes?: string | null | undefined;
    paused?: boolean | undefined;
    pausedUntil?: string | null | undefined;
    reminderTime?: string | null | undefined;
    reminderAnchor?: string | null | undefined;
    title?: string | undefined;
    priority?: "low" | "medium" | "high" | null | undefined;
    project?: string | null | undefined;
    startDate?: string | null | undefined;
    isScheduled?: boolean | undefined;
    order?: number | undefined;
    inProjectBlock?: boolean | null | undefined;
    previousStartTime?: string | null | undefined;
    previousStartDate?: string | null | undefined;
    parentItemId?: string | null | undefined;
    assignee?: string | null | undefined;
    aiStatus?: "done" | "queued" | "working" | "blocked" | "failed" | null | undefined;
    aiResult?: string | null | undefined;
}>, {
    status?: "pending" | "completed" | "cancelled" | undefined;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | null | undefined;
    repeatDays?: number[] | null | undefined;
    repeatMonthDay?: number | null | undefined;
    completedDates?: string[] | null | undefined;
    skippedDates?: string[] | null | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
    startTime?: string | null | undefined;
    duration?: number | null | undefined;
    notes?: string | null | undefined;
    paused?: boolean | undefined;
    pausedUntil?: string | null | undefined;
    reminderTime?: string | null | undefined;
    reminderAnchor?: string | null | undefined;
    title?: string | undefined;
    priority?: "low" | "medium" | "high" | null | undefined;
    project?: string | null | undefined;
    startDate?: string | null | undefined;
    isScheduled?: boolean | undefined;
    order?: number | undefined;
    inProjectBlock?: boolean | null | undefined;
    previousStartTime?: string | null | undefined;
    previousStartDate?: string | null | undefined;
    parentItemId?: string | null | undefined;
    assignee?: string | null | undefined;
    aiStatus?: "done" | "queued" | "working" | "blocked" | "failed" | null | undefined;
    aiResult?: string | null | undefined;
}, {
    status?: "pending" | "completed" | "cancelled" | undefined;
    repeatFrequency?: unknown;
    repeatDays?: number[] | null | undefined;
    repeatMonthDay?: number | null | undefined;
    completedDates?: string[] | null | undefined;
    skippedDates?: string[] | null | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
    startTime?: string | null | undefined;
    duration?: number | null | undefined;
    notes?: string | null | undefined;
    paused?: boolean | undefined;
    pausedUntil?: string | null | undefined;
    reminderTime?: string | null | undefined;
    reminderAnchor?: string | null | undefined;
    title?: string | undefined;
    priority?: "low" | "medium" | "high" | null | undefined;
    project?: string | null | undefined;
    startDate?: string | null | undefined;
    isScheduled?: boolean | undefined;
    order?: number | undefined;
    inProjectBlock?: boolean | null | undefined;
    previousStartTime?: string | null | undefined;
    previousStartDate?: string | null | undefined;
    parentItemId?: string | null | undefined;
    assignee?: string | null | undefined;
    aiStatus?: "done" | "queued" | "working" | "blocked" | "failed" | null | undefined;
    aiResult?: string | null | undefined;
}>, {
    status?: "pending" | "completed" | "cancelled" | undefined;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | null | undefined;
    repeatDays?: number[] | null | undefined;
    repeatMonthDay?: number | null | undefined;
    completedDates?: string[] | null | undefined;
    skippedDates?: string[] | null | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
    startTime?: string | null | undefined;
    duration?: number | null | undefined;
    notes?: string | null | undefined;
    paused?: boolean | undefined;
    pausedUntil?: string | null | undefined;
    reminderTime?: string | null | undefined;
    reminderAnchor?: string | null | undefined;
    title?: string | undefined;
    priority?: "low" | "medium" | "high" | null | undefined;
    project?: string | null | undefined;
    startDate?: string | null | undefined;
    isScheduled?: boolean | undefined;
    order?: number | undefined;
    inProjectBlock?: boolean | null | undefined;
    previousStartTime?: string | null | undefined;
    previousStartDate?: string | null | undefined;
    parentItemId?: string | null | undefined;
    assignee?: string | null | undefined;
    aiStatus?: "done" | "queued" | "working" | "blocked" | "failed" | null | undefined;
    aiResult?: string | null | undefined;
}, {
    status?: "pending" | "completed" | "cancelled" | undefined;
    repeatFrequency?: unknown;
    repeatDays?: number[] | null | undefined;
    repeatMonthDay?: number | null | undefined;
    completedDates?: string[] | null | undefined;
    skippedDates?: string[] | null | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
    startTime?: string | null | undefined;
    duration?: number | null | undefined;
    notes?: string | null | undefined;
    paused?: boolean | undefined;
    pausedUntil?: string | null | undefined;
    reminderTime?: string | null | undefined;
    reminderAnchor?: string | null | undefined;
    title?: string | undefined;
    priority?: "low" | "medium" | "high" | null | undefined;
    project?: string | null | undefined;
    startDate?: string | null | undefined;
    isScheduled?: boolean | undefined;
    order?: number | undefined;
    inProjectBlock?: boolean | null | undefined;
    previousStartTime?: string | null | undefined;
    previousStartDate?: string | null | undefined;
    parentItemId?: string | null | undefined;
    assignee?: string | null | undefined;
    aiStatus?: "done" | "queued" | "working" | "blocked" | "failed" | null | undefined;
    aiResult?: string | null | undefined;
}>;
export declare const HabitUpdateSchema: z.ZodEffects<z.ZodEffects<z.ZodObject<{
    /** true → pause from now; false → resume today. Omit to leave pause state alone. */
    paused: z.ZodOptional<z.ZodBoolean>;
    /**
     * Resume date (EXCLUSIVE — live again ON this date). Sent with `paused: true`
     * it sets the end of the pause; sent alone it moves the resume date of a
     * pause already running. `null` means "paused with no end date".
     */
    pausedUntil: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    title: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<["pending", "done", "skipped"]>>;
    group: z.ZodOptional<z.ZodString>;
    streak: z.ZodOptional<z.ZodNumber>;
    completedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    skippedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    dailyCounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    timeBucket: z.ZodOptional<z.ZodNullable<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>>;
    startTime: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    duration: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    repeatFrequency: z.ZodOptional<z.ZodEffects<z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", unknown>>;
    repeatDays: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodNumber, "many">>>;
    repeatMonthDay: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    timesPerDay: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    currentDayCount: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    notes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    reminderTime: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    reminderAnchor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    status?: "pending" | "done" | "skipped" | undefined;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | null | undefined;
    repeatMonthDay?: number | null | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
    startTime?: string | null | undefined;
    duration?: number | null | undefined;
    notes?: string | null | undefined;
    paused?: boolean | undefined;
    pausedUntil?: string | null | undefined;
    reminderTime?: string | null | undefined;
    reminderAnchor?: string | null | undefined;
    title?: string | undefined;
    group?: string | undefined;
    streak?: number | undefined;
    dailyCounts?: Record<string, number> | undefined;
    timesPerDay?: number | null | undefined;
    currentDayCount?: number | null | undefined;
}, {
    status?: "pending" | "done" | "skipped" | undefined;
    repeatFrequency?: unknown;
    repeatDays?: number[] | null | undefined;
    repeatMonthDay?: number | null | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
    startTime?: string | null | undefined;
    duration?: number | null | undefined;
    notes?: string | null | undefined;
    paused?: boolean | undefined;
    pausedUntil?: string | null | undefined;
    reminderTime?: string | null | undefined;
    reminderAnchor?: string | null | undefined;
    title?: string | undefined;
    group?: string | undefined;
    streak?: number | undefined;
    dailyCounts?: Record<string, number> | undefined;
    timesPerDay?: number | null | undefined;
    currentDayCount?: number | null | undefined;
}>, {
    status?: "pending" | "done" | "skipped" | undefined;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | null | undefined;
    repeatMonthDay?: number | null | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
    startTime?: string | null | undefined;
    duration?: number | null | undefined;
    notes?: string | null | undefined;
    paused?: boolean | undefined;
    pausedUntil?: string | null | undefined;
    reminderTime?: string | null | undefined;
    reminderAnchor?: string | null | undefined;
    title?: string | undefined;
    group?: string | undefined;
    streak?: number | undefined;
    dailyCounts?: Record<string, number> | undefined;
    timesPerDay?: number | null | undefined;
    currentDayCount?: number | null | undefined;
}, {
    status?: "pending" | "done" | "skipped" | undefined;
    repeatFrequency?: unknown;
    repeatDays?: number[] | null | undefined;
    repeatMonthDay?: number | null | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
    startTime?: string | null | undefined;
    duration?: number | null | undefined;
    notes?: string | null | undefined;
    paused?: boolean | undefined;
    pausedUntil?: string | null | undefined;
    reminderTime?: string | null | undefined;
    reminderAnchor?: string | null | undefined;
    title?: string | undefined;
    group?: string | undefined;
    streak?: number | undefined;
    dailyCounts?: Record<string, number> | undefined;
    timesPerDay?: number | null | undefined;
    currentDayCount?: number | null | undefined;
}>, {
    status?: "pending" | "done" | "skipped" | undefined;
    repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
    repeatDays?: number[] | null | undefined;
    repeatMonthDay?: number | null | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
    startTime?: string | null | undefined;
    duration?: number | null | undefined;
    notes?: string | null | undefined;
    paused?: boolean | undefined;
    pausedUntil?: string | null | undefined;
    reminderTime?: string | null | undefined;
    reminderAnchor?: string | null | undefined;
    title?: string | undefined;
    group?: string | undefined;
    streak?: number | undefined;
    dailyCounts?: Record<string, number> | undefined;
    timesPerDay?: number | null | undefined;
    currentDayCount?: number | null | undefined;
}, {
    status?: "pending" | "done" | "skipped" | undefined;
    repeatFrequency?: unknown;
    repeatDays?: number[] | null | undefined;
    repeatMonthDay?: number | null | undefined;
    completedDates?: string[] | undefined;
    skippedDates?: string[] | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
    startTime?: string | null | undefined;
    duration?: number | null | undefined;
    notes?: string | null | undefined;
    paused?: boolean | undefined;
    pausedUntil?: string | null | undefined;
    reminderTime?: string | null | undefined;
    reminderAnchor?: string | null | undefined;
    title?: string | undefined;
    group?: string | undefined;
    streak?: number | undefined;
    dailyCounts?: Record<string, number> | undefined;
    timesPerDay?: number | null | undefined;
    currentDayCount?: number | null | undefined;
}>;
export declare const RoutineCreateSchema: z.ZodEffects<z.ZodObject<{
    /** true → pause from now; false → resume today. Omit to leave pause state alone. */
    paused: z.ZodOptional<z.ZodBoolean>;
    /**
     * Resume date (EXCLUSIVE — live again ON this date). Sent with `paused: true`
     * it sets the end of the pause; sent alone it moves the resume date of a
     * pause already running. `null` means "paused with no end date".
     */
    pausedUntil: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    id: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
    itemIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    name: z.ZodString;
    /** icon:<LucideName> token, matching the container convention. */
    icon: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    color: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sortOrder: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, "strip", z.ZodTypeAny, {
    name: string;
    id?: string | undefined;
    color?: string | null | undefined;
    paused?: boolean | undefined;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: string | null | undefined;
}, {
    name: string;
    id?: string | null | undefined;
    color?: string | null | undefined;
    paused?: boolean | undefined;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: string | null | undefined;
}>, {
    name: string;
    id?: string | undefined;
    color?: string | null | undefined;
    paused?: boolean | undefined;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: string | null | undefined;
}, {
    name: string;
    id?: string | null | undefined;
    color?: string | null | undefined;
    paused?: boolean | undefined;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: string | null | undefined;
}>;
export declare const RoutineUpdateSchema: z.ZodEffects<z.ZodObject<{
    /** true → pause from now; false → resume today. Omit to leave pause state alone. */
    paused: z.ZodOptional<z.ZodBoolean>;
    /**
     * Resume date (EXCLUSIVE — live again ON this date). Sent with `paused: true`
     * it sets the end of the pause; sent alone it moves the resume date of a
     * pause already running. `null` means "paused with no end date".
     */
    pausedUntil: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    name: z.ZodOptional<z.ZodString>;
    itemIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    /** icon:<LucideName> token, matching the container convention. */
    icon: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    color: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sortOrder: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, "strip", z.ZodTypeAny, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: boolean | undefined;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: string | null | undefined;
}, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: boolean | undefined;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: string | null | undefined;
}>, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: boolean | undefined;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: string | null | undefined;
}, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: boolean | undefined;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: string | null | undefined;
}>;
export declare const ProgramCreateSchema: z.ZodEffects<z.ZodEffects<z.ZodObject<{
    paused: z.ZodOptional<z.ZodUnknown>;
    pausedUntil: z.ZodOptional<z.ZodUnknown>;
    /**
     * 'auto' follows the range; 'active'/'paused' are manual overrides that win
     * over it. Omitted on create → 'auto', which with no range means "always on".
     */
    state: z.ZodOptional<z.ZodEnum<["auto", "active", "paused"]>>;
    /** Inclusive bounds, either end open. Only read while state is 'auto'. */
    startsOn: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    endsOn: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    itemIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    /** Held routines — their members ride along. */
    routineIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    id: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
    name: z.ZodString;
    /** icon:<LucideName> token, matching the container convention. */
    icon: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    color: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sortOrder: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, "strip", z.ZodTypeAny, {
    name: string;
    id?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: unknown;
    state?: "auto" | "active" | "paused" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: string | null | undefined;
    routineIds?: string[] | undefined;
}, {
    name: string;
    id?: string | null | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: unknown;
    state?: "auto" | "active" | "paused" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: string | null | undefined;
    routineIds?: string[] | undefined;
}>, {
    name: string;
    id?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: unknown;
    state?: "auto" | "active" | "paused" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: string | null | undefined;
    routineIds?: string[] | undefined;
}, {
    name: string;
    id?: string | null | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: unknown;
    state?: "auto" | "active" | "paused" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: string | null | undefined;
    routineIds?: string[] | undefined;
}>, {
    name: string;
    id?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: unknown;
    state?: "auto" | "active" | "paused" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: string | null | undefined;
    routineIds?: string[] | undefined;
}, {
    name: string;
    id?: string | null | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: unknown;
    state?: "auto" | "active" | "paused" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: string | null | undefined;
    routineIds?: string[] | undefined;
}>;
export declare const ProgramUpdateSchema: z.ZodEffects<z.ZodEffects<z.ZodObject<{
    paused: z.ZodOptional<z.ZodUnknown>;
    pausedUntil: z.ZodOptional<z.ZodUnknown>;
    /**
     * 'auto' follows the range; 'active'/'paused' are manual overrides that win
     * over it. Omitted on create → 'auto', which with no range means "always on".
     */
    state: z.ZodOptional<z.ZodEnum<["auto", "active", "paused"]>>;
    /** Inclusive bounds, either end open. Only read while state is 'auto'. */
    startsOn: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    endsOn: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    itemIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    /** Held routines — their members ride along. */
    routineIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    name: z.ZodOptional<z.ZodString>;
    /** icon:<LucideName> token, matching the container convention. */
    icon: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    color: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sortOrder: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, "strip", z.ZodTypeAny, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: unknown;
    state?: "auto" | "active" | "paused" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: string | null | undefined;
    routineIds?: string[] | undefined;
}, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: unknown;
    state?: "auto" | "active" | "paused" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: string | null | undefined;
    routineIds?: string[] | undefined;
}>, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: unknown;
    state?: "auto" | "active" | "paused" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: string | null | undefined;
    routineIds?: string[] | undefined;
}, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: unknown;
    state?: "auto" | "active" | "paused" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: string | null | undefined;
    routineIds?: string[] | undefined;
}>, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: unknown;
    state?: "auto" | "active" | "paused" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: string | null | undefined;
    routineIds?: string[] | undefined;
}, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: string[] | undefined;
    pausedUntil?: unknown;
    state?: "auto" | "active" | "paused" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: string | null | undefined;
    routineIds?: string[] | undefined;
}>;
export declare const GoalCreateSchema: z.ZodEffects<z.ZodEffects<z.ZodEffects<z.ZodEffects<z.ZodObject<{
    /** The motivation line. Rendered on the goal surface and handed to Beacon. */
    why: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    /** Lifecycle. Omitted on create → 'active'. */
    state: z.ZodOptional<z.ZodEnum<["active", "achieved", "abandoned"]>>;
    startsOn: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    targetOn: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    memberIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    milestoneIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    checkinIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    paused: z.ZodOptional<z.ZodUnknown>;
    pausedUntil: z.ZodOptional<z.ZodUnknown>;
    achievedAt: z.ZodOptional<z.ZodUnknown>;
    itemIds: z.ZodOptional<z.ZodUnknown>;
    routineIds: z.ZodOptional<z.ZodUnknown>;
    endsOn: z.ZodOptional<z.ZodUnknown>;
    id: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
    name: z.ZodString;
    /** icon:<LucideName> token, matching the container convention. */
    icon: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    color: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sortOrder: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, "strip", z.ZodTypeAny, {
    name: string;
    id?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}, {
    name: string;
    id?: string | null | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}>, {
    name: string;
    id?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}, {
    name: string;
    id?: string | null | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}>, {
    name: string;
    id?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}, {
    name: string;
    id?: string | null | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}>, {
    name: string;
    id?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}, {
    name: string;
    id?: string | null | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}>, {
    name: string;
    id?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}, {
    name: string;
    id?: string | null | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}>;
export declare const GoalUpdateSchema: z.ZodEffects<z.ZodEffects<z.ZodEffects<z.ZodEffects<z.ZodObject<{
    /** The motivation line. Rendered on the goal surface and handed to Beacon. */
    why: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    /** Lifecycle. Omitted on create → 'active'. */
    state: z.ZodOptional<z.ZodEnum<["active", "achieved", "abandoned"]>>;
    startsOn: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    targetOn: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    memberIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    milestoneIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    checkinIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    paused: z.ZodOptional<z.ZodUnknown>;
    pausedUntil: z.ZodOptional<z.ZodUnknown>;
    achievedAt: z.ZodOptional<z.ZodUnknown>;
    itemIds: z.ZodOptional<z.ZodUnknown>;
    routineIds: z.ZodOptional<z.ZodUnknown>;
    endsOn: z.ZodOptional<z.ZodUnknown>;
    name: z.ZodOptional<z.ZodString>;
    /** icon:<LucideName> token, matching the container convention. */
    icon: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    color: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sortOrder: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, "strip", z.ZodTypeAny, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}>, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}>, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}>, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}>, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}, {
    name?: string | undefined;
    color?: string | null | undefined;
    paused?: unknown;
    icon?: string | null | undefined;
    sortOrder?: number | null | undefined;
    itemIds?: unknown;
    pausedUntil?: unknown;
    state?: "active" | "achieved" | "abandoned" | undefined;
    startsOn?: string | null | undefined;
    endsOn?: unknown;
    routineIds?: unknown;
    why?: string | null | undefined;
    targetOn?: string | null | undefined;
    achievedAt?: unknown;
    memberIds?: string[] | undefined;
    milestoneIds?: string[] | undefined;
    checkinIds?: string[] | undefined;
}>;
export declare const DsulContextResponseSchema: z.ZodObject<{
    userId: z.ZodString;
    userTimezone: z.ZodOptional<z.ZodString>;
    fetchedAt: z.ZodString;
    tasks: z.ZodArray<z.ZodEffects<z.ZodObject<{
        /**
         * Local wall-clock 'HH:mm' for this item's daily cue, or absent for no
         * reminder. NOT a timestamp: see migration 032 on why the instant-shaped
         * items.reminder_at column was left alone rather than reused.
         */
        reminderTime: z.ZodOptional<z.ZodString>;
        /**
         * The implementation-intention phrase the cue is rehearsed as — "after I pour
         * my coffee". Free text, never parsed; rendered into the notification body.
         */
        reminderAnchor: z.ZodOptional<z.ZodString>;
        /**
         * ISO timestamp the pause began. Load-bearing, not decorative: it is the
         * resolver's LOWER bound, without which a pause started in August would
         * retro-suppress every unmarked occurrence back through July.
         */
        pausedAt: z.ZodOptional<z.ZodString>;
        /**
         * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
         * auto-resume needs no cron. A manual resume sets this to today rather than
         * clearing pausedAt, keeping the interval on the row for the auto-age
         * sweep's resume grace.
         */
        pausedUntil: z.ZodOptional<z.ZodString>;
        repeatFrequency: z.ZodOptional<z.ZodEffects<z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", unknown>>;
        repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
        repeatMonthDay: z.ZodOptional<z.ZodNumber>;
        completedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        skippedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        id: z.ZodString;
        title: z.ZodString;
        priority: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
        project: z.ZodOptional<z.ZodString>;
        startDate: z.ZodOptional<z.ZodString>;
        status: z.ZodEnum<["pending", "completed", "cancelled"]>;
        timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
        startTime: z.ZodOptional<z.ZodString>;
        duration: z.ZodOptional<z.ZodNumber>;
        isScheduled: z.ZodBoolean;
        order: z.ZodNumber;
        inProjectBlock: z.ZodOptional<z.ZodBoolean>;
        previousStartTime: z.ZodOptional<z.ZodString>;
        previousStartDate: z.ZodOptional<z.ZodString>;
        notes: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
        /** Parent item id — this item is a subtask when set (items.parent_item_id). */
        parentItemId: z.ZodOptional<z.ZodString>;
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
        projectId: z.ZodOptional<z.ZodString>;
        /** Who's working this item: 'openclaw' | 'beacon' | free text. */
        assignee: z.ZodOptional<z.ZodString>;
        /** Agent progress state — write vocabulary: queued|working|blocked|done|failed. */
        aiStatus: z.ZodOptional<z.ZodString>;
        /** Agent's latest result/summary for this item. */
        aiResult: z.ZodOptional<z.ZodString>;
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
        aiStatusAt: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    }, {
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        repeatFrequency?: unknown;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | null | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    }>, {
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    }, {
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        repeatFrequency?: unknown;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | null | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    }>, "many">;
    habits: z.ZodArray<z.ZodEffects<z.ZodObject<{
        group: z.ZodString;
        /**
         * Stable id of the group named by `group` (migration 027).
         *
         * Post-039 this is the PROJECT's id — the habit_groups row it used to name
         * became a projects row keeping its uuid, which is what lets this field mean
         * the same thing to an old plugin build without a translation table.
         */
        groupId: z.ZodOptional<z.ZodString>;
        /**
         * Local wall-clock 'HH:mm' for this item's daily cue, or absent for no
         * reminder. NOT a timestamp: see migration 032 on why the instant-shaped
         * items.reminder_at column was left alone rather than reused.
         */
        reminderTime: z.ZodOptional<z.ZodString>;
        /**
         * The implementation-intention phrase the cue is rehearsed as — "after I pour
         * my coffee". Free text, never parsed; rendered into the notification body.
         */
        reminderAnchor: z.ZodOptional<z.ZodString>;
        /**
         * ISO timestamp the pause began. Load-bearing, not decorative: it is the
         * resolver's LOWER bound, without which a pause started in August would
         * retro-suppress every unmarked occurrence back through July.
         */
        pausedAt: z.ZodOptional<z.ZodString>;
        /**
         * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
         * auto-resume needs no cron. A manual resume sets this to today rather than
         * clearing pausedAt, keeping the interval on the row for the auto-age
         * sweep's resume grace.
         */
        pausedUntil: z.ZodOptional<z.ZodString>;
        id: z.ZodString;
        title: z.ZodString;
        streak: z.ZodNumber;
        status: z.ZodEnum<["pending", "done", "skipped"]>;
        completedDates: z.ZodArray<z.ZodString, "many">;
        skippedDates: z.ZodArray<z.ZodString, "many">;
        dailyCounts: z.ZodRecord<z.ZodString, z.ZodNumber>;
        timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
        startTime: z.ZodOptional<z.ZodString>;
        duration: z.ZodOptional<z.ZodNumber>;
        repeatFrequency: z.ZodEffects<z.ZodUnion<[z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, z.ZodLiteral<"weekly">]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly">;
        repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
        repeatMonthDay: z.ZodOptional<z.ZodNumber>;
        timesPerDay: z.ZodOptional<z.ZodNumber>;
        currentDayCount: z.ZodOptional<z.ZodNumber>;
        notes: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
    }, "strip", z.ZodTypeAny, {
        status: "pending" | "done" | "skipped";
        repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom";
        completedDates: string[];
        skippedDates: string[];
        id: string;
        title: string;
        group: string;
        streak: number;
        dailyCounts: Record<string, number>;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        groupId?: string | undefined;
        timesPerDay?: number | undefined;
        currentDayCount?: number | undefined;
    }, {
        status: "pending" | "done" | "skipped";
        repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly";
        completedDates: string[];
        skippedDates: string[];
        id: string;
        title: string;
        group: string;
        streak: number;
        dailyCounts: Record<string, number>;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | null | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        groupId?: string | undefined;
        timesPerDay?: number | undefined;
        currentDayCount?: number | undefined;
    }>, {
        status: "pending" | "done" | "skipped";
        repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom";
        completedDates: string[];
        skippedDates: string[];
        id: string;
        title: string;
        group: string;
        streak: number;
        dailyCounts: Record<string, number>;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        groupId?: string | undefined;
        timesPerDay?: number | undefined;
        currentDayCount?: number | undefined;
    }, {
        status: "pending" | "done" | "skipped";
        repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly";
        completedDates: string[];
        skippedDates: string[];
        id: string;
        title: string;
        group: string;
        streak: number;
        dailyCounts: Record<string, number>;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | null | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        groupId?: string | undefined;
        timesPerDay?: number | undefined;
        currentDayCount?: number | undefined;
    }>, "many">;
    projects: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        emoji: z.ZodString;
        /** CSS color, usually a var(--accent-N) token; unset → name-hash ramp. */
        color: z.ZodOptional<z.ZodString>;
        repeatFrequency: z.ZodOptional<z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>>;
        repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
        repeatMonthDay: z.ZodOptional<z.ZodNumber>;
        timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
        startTime: z.ZodOptional<z.ZodString>;
        duration: z.ZodOptional<z.ZodNumber>;
        /** A free-text note — what this is for (migration 046). */
        notes: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        name: string;
        emoji: string;
        repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        color?: string | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
    }, {
        id: string;
        name: string;
        emoji: string;
        repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        color?: string | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
    }>, "many">;
    habitGroups: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        emoji: z.ZodString;
        color: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        name: string;
        emoji: string;
        color?: string | undefined;
    }, {
        id: string;
        name: string;
        emoji: string;
        color?: string | undefined;
    }>, "many">;
    items: z.ZodOptional<z.ZodArray<z.ZodEffects<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        /**
         * Local wall-clock 'HH:mm' for this item's daily cue, or absent for no
         * reminder. NOT a timestamp: see migration 032 on why the instant-shaped
         * items.reminder_at column was left alone rather than reused.
         */
        reminderTime: z.ZodOptional<z.ZodString>;
        /**
         * The implementation-intention phrase the cue is rehearsed as — "after I pour
         * my coffee". Free text, never parsed; rendered into the notification body.
         */
        reminderAnchor: z.ZodOptional<z.ZodString>;
        /**
         * ISO timestamp the pause began. Load-bearing, not decorative: it is the
         * resolver's LOWER bound, without which a pause started in August would
         * retro-suppress every unmarked occurrence back through July.
         */
        pausedAt: z.ZodOptional<z.ZodString>;
        /**
         * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
         * auto-resume needs no cron. A manual resume sets this to today rather than
         * clearing pausedAt, keeping the interval on the row for the auto-age
         * sweep's resume grace.
         */
        pausedUntil: z.ZodOptional<z.ZodString>;
        repeatFrequency: z.ZodOptional<z.ZodEffects<z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", unknown>>;
        repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
        repeatMonthDay: z.ZodOptional<z.ZodNumber>;
        completedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        skippedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        id: z.ZodString;
        title: z.ZodString;
        priority: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
        project: z.ZodOptional<z.ZodString>;
        startDate: z.ZodOptional<z.ZodString>;
        status: z.ZodEnum<["pending", "completed", "cancelled"]>;
        timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
        startTime: z.ZodOptional<z.ZodString>;
        duration: z.ZodOptional<z.ZodNumber>;
        isScheduled: z.ZodBoolean;
        order: z.ZodNumber;
        inProjectBlock: z.ZodOptional<z.ZodBoolean>;
        previousStartTime: z.ZodOptional<z.ZodString>;
        previousStartDate: z.ZodOptional<z.ZodString>;
        notes: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
        /** Parent item id — this item is a subtask when set (items.parent_item_id). */
        parentItemId: z.ZodOptional<z.ZodString>;
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
        projectId: z.ZodOptional<z.ZodString>;
        /** Who's working this item: 'openclaw' | 'beacon' | free text. */
        assignee: z.ZodOptional<z.ZodString>;
        /** Agent progress state — write vocabulary: queued|working|blocked|done|failed. */
        aiStatus: z.ZodOptional<z.ZodString>;
        /** Agent's latest result/summary for this item. */
        aiResult: z.ZodOptional<z.ZodString>;
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
        aiStatusAt: z.ZodOptional<z.ZodString>;
        type: z.ZodLiteral<"task">;
    }, "strip", z.ZodTypeAny, {
        type: "task";
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    }, {
        type: "task";
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        repeatFrequency?: unknown;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | null | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    }>, z.ZodObject<{
        /**
         * Optional, exactly like the task side's — one CLASSIFY axis means one field
         * shape, and every consumer reads `item.project` off the union without
         * narrowing. "A habit must be filed somewhere" is a CAPABILITY
         * (`containerRequired`), enforced by the dialog and the seed fallback, not by
         * this field's presence: the legacy column was NOT NULL and produced '' for
         * the unset case, so making the type require a string only ever moved that ''
         * around. `toLegacyHabit` restores the required `group: string` on the way out.
         */
        project: z.ZodOptional<z.ZodString>;
        /** See taskShape.projectId: the name stays authoritative, the id survives renames. */
        projectId: z.ZodOptional<z.ZodString>;
        /**
         * Local wall-clock 'HH:mm' for this item's daily cue, or absent for no
         * reminder. NOT a timestamp: see migration 032 on why the instant-shaped
         * items.reminder_at column was left alone rather than reused.
         */
        reminderTime: z.ZodOptional<z.ZodString>;
        /**
         * The implementation-intention phrase the cue is rehearsed as — "after I pour
         * my coffee". Free text, never parsed; rendered into the notification body.
         */
        reminderAnchor: z.ZodOptional<z.ZodString>;
        /**
         * ISO timestamp the pause began. Load-bearing, not decorative: it is the
         * resolver's LOWER bound, without which a pause started in August would
         * retro-suppress every unmarked occurrence back through July.
         */
        pausedAt: z.ZodOptional<z.ZodString>;
        /**
         * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
         * auto-resume needs no cron. A manual resume sets this to today rather than
         * clearing pausedAt, keeping the interval on the row for the auto-age
         * sweep's resume grace.
         */
        pausedUntil: z.ZodOptional<z.ZodString>;
        id: z.ZodString;
        title: z.ZodString;
        streak: z.ZodNumber;
        status: z.ZodEnum<["pending", "done", "skipped"]>;
        completedDates: z.ZodArray<z.ZodString, "many">;
        skippedDates: z.ZodArray<z.ZodString, "many">;
        dailyCounts: z.ZodRecord<z.ZodString, z.ZodNumber>;
        timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
        startTime: z.ZodOptional<z.ZodString>;
        duration: z.ZodOptional<z.ZodNumber>;
        repeatFrequency: z.ZodEffects<z.ZodUnion<[z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, z.ZodLiteral<"weekly">]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly">;
        repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
        repeatMonthDay: z.ZodOptional<z.ZodNumber>;
        timesPerDay: z.ZodOptional<z.ZodNumber>;
        currentDayCount: z.ZodOptional<z.ZodNumber>;
        notes: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
        type: z.ZodLiteral<"habit">;
    }, "strip", z.ZodTypeAny, {
        type: "habit";
        status: "pending" | "done" | "skipped";
        repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom";
        completedDates: string[];
        skippedDates: string[];
        id: string;
        title: string;
        streak: number;
        dailyCounts: Record<string, number>;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        project?: string | undefined;
        projectId?: string | undefined;
        timesPerDay?: number | undefined;
        currentDayCount?: number | undefined;
    }, {
        type: "habit";
        status: "pending" | "done" | "skipped";
        repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly";
        completedDates: string[];
        skippedDates: string[];
        id: string;
        title: string;
        streak: number;
        dailyCounts: Record<string, number>;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | null | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        project?: string | undefined;
        projectId?: string | undefined;
        timesPerDay?: number | undefined;
        currentDayCount?: number | undefined;
    }>, z.ZodObject<{
        /**
         * Local wall-clock 'HH:mm' for this item's daily cue, or absent for no
         * reminder. NOT a timestamp: see migration 032 on why the instant-shaped
         * items.reminder_at column was left alone rather than reused.
         */
        reminderTime: z.ZodOptional<z.ZodString>;
        /**
         * The implementation-intention phrase the cue is rehearsed as — "after I pour
         * my coffee". Free text, never parsed; rendered into the notification body.
         */
        reminderAnchor: z.ZodOptional<z.ZodString>;
        /**
         * ISO timestamp the pause began. Load-bearing, not decorative: it is the
         * resolver's LOWER bound, without which a pause started in August would
         * retro-suppress every unmarked occurrence back through July.
         */
        pausedAt: z.ZodOptional<z.ZodString>;
        /**
         * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
         * auto-resume needs no cron. A manual resume sets this to today rather than
         * clearing pausedAt, keeping the interval on the row for the auto-age
         * sweep's resume grace.
         */
        pausedUntil: z.ZodOptional<z.ZodString>;
        repeatFrequency: z.ZodOptional<z.ZodEffects<z.ZodEnum<["none", "daily", "weekdays", "weekends", "monthly", "custom"]>, "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom", unknown>>;
        repeatDays: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
        repeatMonthDay: z.ZodOptional<z.ZodNumber>;
        completedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        skippedDates: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        id: z.ZodString;
        title: z.ZodString;
        priority: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
        project: z.ZodOptional<z.ZodString>;
        startDate: z.ZodOptional<z.ZodString>;
        status: z.ZodEnum<["pending", "completed", "cancelled"]>;
        timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
        startTime: z.ZodOptional<z.ZodString>;
        duration: z.ZodOptional<z.ZodNumber>;
        isScheduled: z.ZodBoolean;
        order: z.ZodNumber;
        inProjectBlock: z.ZodOptional<z.ZodBoolean>;
        previousStartTime: z.ZodOptional<z.ZodString>;
        previousStartDate: z.ZodOptional<z.ZodString>;
        notes: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | undefined, string | null | undefined>;
        /** Parent item id — this item is a subtask when set (items.parent_item_id). */
        parentItemId: z.ZodOptional<z.ZodString>;
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
        projectId: z.ZodOptional<z.ZodString>;
        /** Who's working this item: 'openclaw' | 'beacon' | free text. */
        assignee: z.ZodOptional<z.ZodString>;
        /** Agent progress state — write vocabulary: queued|working|blocked|done|failed. */
        aiStatus: z.ZodOptional<z.ZodString>;
        /** Agent's latest result/summary for this item. */
        aiResult: z.ZodOptional<z.ZodString>;
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
        aiStatusAt: z.ZodOptional<z.ZodString>;
        type: z.ZodLiteral<"custom">;
        /**
         * The user-defined type's machine name (item_types.name), e.g. 'errand'.
         *
         * NOT 'goal', which this example used to be: a Goal is a CONTAINER now
         * (GoalSchema above, migration 036), and an item type of the same name is a
         * different thing in a different namespace. Both keep working — the console
         * shows them in different sections — but the example should not teach the
         * collision.
         */
        customType: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "custom";
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        customType: string;
        repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    }, {
        type: "custom";
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        customType: string;
        repeatFrequency?: unknown;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | null | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    }>]>, {
        type: "habit";
        status: "pending" | "done" | "skipped";
        repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom";
        completedDates: string[];
        skippedDates: string[];
        id: string;
        title: string;
        streak: number;
        dailyCounts: Record<string, number>;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        project?: string | undefined;
        projectId?: string | undefined;
        timesPerDay?: number | undefined;
        currentDayCount?: number | undefined;
    } | {
        type: "task";
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    } | {
        type: "custom";
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        customType: string;
        repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    }, {
        type: "habit";
        status: "pending" | "done" | "skipped";
        repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly";
        completedDates: string[];
        skippedDates: string[];
        id: string;
        title: string;
        streak: number;
        dailyCounts: Record<string, number>;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | null | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        project?: string | undefined;
        projectId?: string | undefined;
        timesPerDay?: number | undefined;
        currentDayCount?: number | undefined;
    } | {
        type: "task";
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        repeatFrequency?: unknown;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | null | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    } | {
        type: "custom";
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        customType: string;
        repeatFrequency?: unknown;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | null | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    }>, "many">>;
    routines: z.ZodOptional<z.ZodArray<z.ZodObject<{
        /** A free-text note — what this is for (migration 046). */
        notes: z.ZodOptional<z.ZodString>;
        /** Member item ids (routine_items), in routine-internal order. */
        itemIds: z.ZodArray<z.ZodString, "many">;
        /**
         * ISO timestamp the pause began. Load-bearing, not decorative: it is the
         * resolver's LOWER bound, without which a pause started in August would
         * retro-suppress every unmarked occurrence back through July.
         */
        pausedAt: z.ZodOptional<z.ZodString>;
        /**
         * Resume date (yyyy-MM-dd), EXCLUSIVE — live again ON this date, so
         * auto-resume needs no cron. A manual resume sets this to today rather than
         * clearing pausedAt, keeping the interval on the row for the auto-age
         * sweep's resume grace.
         */
        pausedUntil: z.ZodOptional<z.ZodString>;
        id: z.ZodString;
        name: z.ZodString;
        /** icon:<LucideName> token, matching the container convention. */
        icon: z.ZodOptional<z.ZodString>;
        /** CSS color, usually a var(--accent-N) token; unset → name-hash ramp. */
        color: z.ZodOptional<z.ZodString>;
        sortOrder: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        name: string;
        itemIds: string[];
        color?: string | undefined;
        notes?: string | undefined;
        icon?: string | undefined;
        sortOrder?: number | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
    }, {
        id: string;
        name: string;
        itemIds: string[];
        color?: string | undefined;
        notes?: string | undefined;
        icon?: string | undefined;
        sortOrder?: number | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
    }>, "many">>;
    programs: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        icon: z.ZodOptional<z.ZodString>;
        color: z.ZodOptional<z.ZodString>;
        sortOrder: z.ZodOptional<z.ZodNumber>;
        /**
         * 'auto' follows startsOn/endsOn (no range = always on); 'active'/'paused'
         * are manual overrides that always win, because flipping a program by hand
         * must never be second-guessed by a date. Several programs may be active at
         * once — the resolver unions their members.
         */
        state: z.ZodEnum<["auto", "active", "paused"]>;
        /** Inclusive bounds, either end open (yyyy-MM-dd). Only read when state is 'auto'. */
        startsOn: z.ZodOptional<z.ZodString>;
        endsOn: z.ZodOptional<z.ZodString>;
        /** A free-text note — what this is for (migration 046). */
        notes: z.ZodOptional<z.ZodString>;
        /** Directly-held item ids (program_items). */
        itemIds: z.ZodArray<z.ZodString, "many">;
        /** Held routine ids (program_routines) — their members ride along. */
        routineIds: z.ZodArray<z.ZodString, "many">;
        /**
         * Trigger-maintained, READ-ONLY app-side. It exists for one consumer: the
         * overdue sweep's grace (c). A manual `paused` → `active` flip has no
         * recorded date — the tri-state keeps no history — so this is the only
         * evidence that a program recently stopped hiding its members, and without it
         * the morning after someone turns a program back on the sweep unschedules
         * every member at once.
         *
         * Deliberately NOT in db.ts updateProgram's column allowlist: it appears in
         * PROGRAM_FIELDS (which is Object.keys of this shape) and therefore in undo's
         * container diff, where a stale value would otherwise be written back over
         * the trigger's.
         */
        updatedAt: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        name: string;
        itemIds: string[];
        state: "auto" | "active" | "paused";
        routineIds: string[];
        color?: string | undefined;
        notes?: string | undefined;
        icon?: string | undefined;
        sortOrder?: number | undefined;
        startsOn?: string | undefined;
        endsOn?: string | undefined;
        updatedAt?: string | undefined;
    }, {
        id: string;
        name: string;
        itemIds: string[];
        state: "auto" | "active" | "paused";
        routineIds: string[];
        color?: string | undefined;
        notes?: string | undefined;
        icon?: string | undefined;
        sortOrder?: number | undefined;
        startsOn?: string | undefined;
        endsOn?: string | undefined;
        updatedAt?: string | undefined;
    }>, "many">>;
    /**
     * The containers that say WHY work exists (schemaVersion 5+).
     *
     * Unlike routines and programs, a goal suppresses nothing — so an item's
     * absence from tasks[] is never explained by a goal. These are here for the
     * opposite reason: so an agent asked "how is Learn Chinese going" can answer
     * from progress and the next milestone rather than guessing from item titles.
     * Optional, like every array before it: a plugin built against an older
     * schema strips the key rather than throwing.
     */
    goals: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        /** The motivation line — why this goal exists. Rendered on the goal surface, handed to Beacon. */
        why: z.ZodOptional<z.ZodString>;
        /** icon:<LucideName> token, matching the container convention. */
        icon: z.ZodOptional<z.ZodString>;
        /** CSS color, usually a var(--accent-N) token; unset → name-hash ramp. */
        color: z.ZodOptional<z.ZodString>;
        sortOrder: z.ZodOptional<z.ZodNumber>;
        state: z.ZodEnum<["active", "achieved", "abandoned"]>;
        /** Optional horizon (yyyy-MM-dd). `targetOn` is what the countdown and the behind/ahead read measure against. */
        startsOn: z.ZodOptional<z.ZodString>;
        targetOn: z.ZodOptional<z.ZodString>;
        /**
         * Stamped when `state` becomes 'achieved', cleared when it returns to
         * 'active'.
         *
         * App-written and IN db.ts's update allowlist — the deliberate opposite of
         * Program.updatedAt, which is kept OUT of its allowlist because a trigger
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
        achievedAt: z.ZodOptional<z.ZodString>;
        /** Ordinary supporting work — the daily practice habit, the odd task. */
        memberIds: z.ZodArray<z.ZodString, "many">;
        /** Achievement checkpoints, in timeline order (goal_items.sort_order). */
        milestoneIds: z.ZodArray<z.ZodString, "many">;
        /** Recurring reviews. */
        checkinIds: z.ZodArray<z.ZodString, "many">;
    }, "strip", z.ZodTypeAny, {
        id: string;
        name: string;
        state: "active" | "achieved" | "abandoned";
        memberIds: string[];
        milestoneIds: string[];
        checkinIds: string[];
        color?: string | undefined;
        icon?: string | undefined;
        sortOrder?: number | undefined;
        startsOn?: string | undefined;
        why?: string | undefined;
        targetOn?: string | undefined;
        achievedAt?: string | undefined;
    }, {
        id: string;
        name: string;
        state: "active" | "achieved" | "abandoned";
        memberIds: string[];
        milestoneIds: string[];
        checkinIds: string[];
        color?: string | undefined;
        icon?: string | undefined;
        sortOrder?: number | undefined;
        startsOn?: string | undefined;
        why?: string | undefined;
        targetOn?: string | undefined;
        achievedAt?: string | undefined;
    }>, "many">>;
    schemaVersion: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    userId: string;
    fetchedAt: string;
    tasks: {
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    }[];
    habits: {
        status: "pending" | "done" | "skipped";
        repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom";
        completedDates: string[];
        skippedDates: string[];
        id: string;
        title: string;
        group: string;
        streak: number;
        dailyCounts: Record<string, number>;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        groupId?: string | undefined;
        timesPerDay?: number | undefined;
        currentDayCount?: number | undefined;
    }[];
    projects: {
        id: string;
        name: string;
        emoji: string;
        repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        color?: string | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
    }[];
    habitGroups: {
        id: string;
        name: string;
        emoji: string;
        color?: string | undefined;
    }[];
    userTimezone?: string | undefined;
    items?: ({
        type: "habit";
        status: "pending" | "done" | "skipped";
        repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom";
        completedDates: string[];
        skippedDates: string[];
        id: string;
        title: string;
        streak: number;
        dailyCounts: Record<string, number>;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        project?: string | undefined;
        projectId?: string | undefined;
        timesPerDay?: number | undefined;
        currentDayCount?: number | undefined;
    } | {
        type: "task";
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    } | {
        type: "custom";
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        customType: string;
        repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    })[] | undefined;
    routines?: {
        id: string;
        name: string;
        itemIds: string[];
        color?: string | undefined;
        notes?: string | undefined;
        icon?: string | undefined;
        sortOrder?: number | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
    }[] | undefined;
    programs?: {
        id: string;
        name: string;
        itemIds: string[];
        state: "auto" | "active" | "paused";
        routineIds: string[];
        color?: string | undefined;
        notes?: string | undefined;
        icon?: string | undefined;
        sortOrder?: number | undefined;
        startsOn?: string | undefined;
        endsOn?: string | undefined;
        updatedAt?: string | undefined;
    }[] | undefined;
    goals?: {
        id: string;
        name: string;
        state: "active" | "achieved" | "abandoned";
        memberIds: string[];
        milestoneIds: string[];
        checkinIds: string[];
        color?: string | undefined;
        icon?: string | undefined;
        sortOrder?: number | undefined;
        startsOn?: string | undefined;
        why?: string | undefined;
        targetOn?: string | undefined;
        achievedAt?: string | undefined;
    }[] | undefined;
    schemaVersion?: number | undefined;
}, {
    userId: string;
    fetchedAt: string;
    tasks: {
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        repeatFrequency?: unknown;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | null | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    }[];
    habits: {
        status: "pending" | "done" | "skipped";
        repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly";
        completedDates: string[];
        skippedDates: string[];
        id: string;
        title: string;
        group: string;
        streak: number;
        dailyCounts: Record<string, number>;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | null | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        groupId?: string | undefined;
        timesPerDay?: number | undefined;
        currentDayCount?: number | undefined;
    }[];
    projects: {
        id: string;
        name: string;
        emoji: string;
        repeatFrequency?: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | undefined;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        color?: string | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | undefined;
    }[];
    habitGroups: {
        id: string;
        name: string;
        emoji: string;
        color?: string | undefined;
    }[];
    userTimezone?: string | undefined;
    items?: ({
        type: "habit";
        status: "pending" | "done" | "skipped";
        repeatFrequency: "none" | "daily" | "weekdays" | "weekends" | "monthly" | "custom" | "weekly";
        completedDates: string[];
        skippedDates: string[];
        id: string;
        title: string;
        streak: number;
        dailyCounts: Record<string, number>;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | null | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        project?: string | undefined;
        projectId?: string | undefined;
        timesPerDay?: number | undefined;
        currentDayCount?: number | undefined;
    } | {
        type: "task";
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        repeatFrequency?: unknown;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | null | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    } | {
        type: "custom";
        status: "pending" | "completed" | "cancelled";
        id: string;
        title: string;
        isScheduled: boolean;
        order: number;
        customType: string;
        repeatFrequency?: unknown;
        repeatDays?: number[] | undefined;
        repeatMonthDay?: number | undefined;
        completedDates?: string[] | undefined;
        skippedDates?: string[] | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        duration?: number | undefined;
        notes?: string | null | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
        reminderTime?: string | undefined;
        reminderAnchor?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        inProjectBlock?: boolean | undefined;
        previousStartTime?: string | undefined;
        previousStartDate?: string | undefined;
        parentItemId?: string | undefined;
        projectId?: string | undefined;
        assignee?: string | undefined;
        aiStatus?: string | undefined;
        aiResult?: string | undefined;
        aiStatusAt?: string | undefined;
    })[] | undefined;
    routines?: {
        id: string;
        name: string;
        itemIds: string[];
        color?: string | undefined;
        notes?: string | undefined;
        icon?: string | undefined;
        sortOrder?: number | undefined;
        pausedAt?: string | undefined;
        pausedUntil?: string | undefined;
    }[] | undefined;
    programs?: {
        id: string;
        name: string;
        itemIds: string[];
        state: "auto" | "active" | "paused";
        routineIds: string[];
        color?: string | undefined;
        notes?: string | undefined;
        icon?: string | undefined;
        sortOrder?: number | undefined;
        startsOn?: string | undefined;
        endsOn?: string | undefined;
        updatedAt?: string | undefined;
    }[] | undefined;
    goals?: {
        id: string;
        name: string;
        state: "active" | "achieved" | "abandoned";
        memberIds: string[];
        milestoneIds: string[];
        checkinIds: string[];
        color?: string | undefined;
        icon?: string | undefined;
        sortOrder?: number | undefined;
        startsOn?: string | undefined;
        why?: string | undefined;
        targetOn?: string | undefined;
        achievedAt?: string | undefined;
    }[] | undefined;
    schemaVersion?: number | undefined;
}>;
export declare const ProposalCreateOpSchema: z.ZodObject<{
    kind: z.ZodLiteral<"create">;
    /** Registry type name: 'task', 'habit', or a user-defined slug. */
    itemType: z.ZodString;
    /** Required on create — the one field a new item cannot be missing. */
    title: z.ZodString;
    project: z.ZodOptional<z.ZodString>;
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
    parentItemId: z.ZodOptional<z.ZodString>;
    startDate: z.ZodOptional<z.ZodString>;
    timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
    startTime: z.ZodOptional<z.ZodString>;
    priority: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    notes: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    title: string;
    kind: "create";
    itemType: string;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    notes?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    parentItemId?: string | undefined;
}, {
    title: string;
    kind: "create";
    itemType: string;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    notes?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    parentItemId?: string | undefined;
}>;
export declare const ProposalUpdateOpSchema: z.ZodObject<{
    kind: z.ZodLiteral<"update">;
    itemId: z.ZodString;
    /** Null clears the field, matching the update-schema convention above. */
    startDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    timeBucket: z.ZodOptional<z.ZodNullable<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>>;
    startTime: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    priority: z.ZodOptional<z.ZodNullable<z.ZodEnum<["low", "medium", "high"]>>>;
    status: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    notes: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    kind: "update";
    itemId: string;
    status?: string | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
    startTime?: string | null | undefined;
    notes?: string | undefined;
    title?: string | undefined;
    priority?: "low" | "medium" | "high" | null | undefined;
    startDate?: string | null | undefined;
}, {
    kind: "update";
    itemId: string;
    status?: string | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
    startTime?: string | null | undefined;
    notes?: string | undefined;
    title?: string | undefined;
    priority?: "low" | "medium" | "high" | null | undefined;
    startDate?: string | null | undefined;
}>;
export declare const ProposalOperationSchema: z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
    kind: z.ZodLiteral<"create">;
    /** Registry type name: 'task', 'habit', or a user-defined slug. */
    itemType: z.ZodString;
    /** Required on create — the one field a new item cannot be missing. */
    title: z.ZodString;
    project: z.ZodOptional<z.ZodString>;
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
    parentItemId: z.ZodOptional<z.ZodString>;
    startDate: z.ZodOptional<z.ZodString>;
    timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
    startTime: z.ZodOptional<z.ZodString>;
    priority: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    notes: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    title: string;
    kind: "create";
    itemType: string;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    notes?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    parentItemId?: string | undefined;
}, {
    title: string;
    kind: "create";
    itemType: string;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
    startTime?: string | undefined;
    notes?: string | undefined;
    priority?: "low" | "medium" | "high" | undefined;
    project?: string | undefined;
    startDate?: string | undefined;
    parentItemId?: string | undefined;
}>, z.ZodObject<{
    kind: z.ZodLiteral<"update">;
    itemId: z.ZodString;
    /** Null clears the field, matching the update-schema convention above. */
    startDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    timeBucket: z.ZodOptional<z.ZodNullable<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>>;
    startTime: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    priority: z.ZodOptional<z.ZodNullable<z.ZodEnum<["low", "medium", "high"]>>>;
    status: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    notes: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    kind: "update";
    itemId: string;
    status?: string | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
    startTime?: string | null | undefined;
    notes?: string | undefined;
    title?: string | undefined;
    priority?: "low" | "medium" | "high" | null | undefined;
    startDate?: string | null | undefined;
}, {
    kind: "update";
    itemId: string;
    status?: string | undefined;
    timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
    startTime?: string | null | undefined;
    notes?: string | undefined;
    title?: string | undefined;
    priority?: "low" | "medium" | "high" | null | undefined;
    startDate?: string | null | undefined;
}>]>;
export declare const ProposalSchema: z.ZodObject<{
    id: z.ZodString;
    /** Card headline. Warm and specific — "Here's a lighter Tuesday". */
    summary: z.ZodString;
    /** Optional second line explaining the thinking. Never scolding. */
    rationale: z.ZodOptional<z.ZodString>;
    /**
     * Capped because the producer is untrusted by design — on the agent tier it
     * is somebody else's gateway. The system prompts ask for at most eight;
     * nothing enforced it, and a 5,000-operation reply would render six visible
     * lines inside a scroll box under a button reading "Do all of it", then fan
     * out 5,000 unthrottled inserts on one tap. Twenty is well clear of any
     * honest plan, so exceeding it is malformed rather than merely long.
     */
    operations: z.ZodArray<z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
        kind: z.ZodLiteral<"create">;
        /** Registry type name: 'task', 'habit', or a user-defined slug. */
        itemType: z.ZodString;
        /** Required on create — the one field a new item cannot be missing. */
        title: z.ZodString;
        project: z.ZodOptional<z.ZodString>;
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
        parentItemId: z.ZodOptional<z.ZodString>;
        startDate: z.ZodOptional<z.ZodString>;
        timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
        startTime: z.ZodOptional<z.ZodString>;
        priority: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
        notes: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        title: string;
        kind: "create";
        itemType: string;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        notes?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        parentItemId?: string | undefined;
    }, {
        title: string;
        kind: "create";
        itemType: string;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        notes?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        parentItemId?: string | undefined;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"update">;
        itemId: z.ZodString;
        /** Null clears the field, matching the update-schema convention above. */
        startDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        timeBucket: z.ZodOptional<z.ZodNullable<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>>;
        startTime: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        priority: z.ZodOptional<z.ZodNullable<z.ZodEnum<["low", "medium", "high"]>>>;
        status: z.ZodOptional<z.ZodString>;
        title: z.ZodOptional<z.ZodString>;
        notes: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        kind: "update";
        itemId: string;
        status?: string | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
        startTime?: string | null | undefined;
        notes?: string | undefined;
        title?: string | undefined;
        priority?: "low" | "medium" | "high" | null | undefined;
        startDate?: string | null | undefined;
    }, {
        kind: "update";
        itemId: string;
        status?: string | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
        startTime?: string | null | undefined;
        notes?: string | undefined;
        title?: string | undefined;
        priority?: "low" | "medium" | "high" | null | undefined;
        startDate?: string | null | undefined;
    }>]>, "many">;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    summary: string;
    operations: ({
        title: string;
        kind: "create";
        itemType: string;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        notes?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        parentItemId?: string | undefined;
    } | {
        kind: "update";
        itemId: string;
        status?: string | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
        startTime?: string | null | undefined;
        notes?: string | undefined;
        title?: string | undefined;
        priority?: "low" | "medium" | "high" | null | undefined;
        startDate?: string | null | undefined;
    })[];
    createdAt: string;
    rationale?: string | undefined;
}, {
    id: string;
    summary: string;
    operations: ({
        title: string;
        kind: "create";
        itemType: string;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        notes?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        parentItemId?: string | undefined;
    } | {
        kind: "update";
        itemId: string;
        status?: string | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
        startTime?: string | null | undefined;
        notes?: string | undefined;
        title?: string | undefined;
        priority?: "low" | "medium" | "high" | null | undefined;
        startDate?: string | null | undefined;
    })[];
    createdAt: string;
    rationale?: string | undefined;
}>;
/** What the model is asked to return; ids and timestamps are stamped locally. */
export declare const ProposalDraftSchema: z.ZodObject<Omit<{
    id: z.ZodString;
    /** Card headline. Warm and specific — "Here's a lighter Tuesday". */
    summary: z.ZodString;
    /** Optional second line explaining the thinking. Never scolding. */
    rationale: z.ZodOptional<z.ZodString>;
    /**
     * Capped because the producer is untrusted by design — on the agent tier it
     * is somebody else's gateway. The system prompts ask for at most eight;
     * nothing enforced it, and a 5,000-operation reply would render six visible
     * lines inside a scroll box under a button reading "Do all of it", then fan
     * out 5,000 unthrottled inserts on one tap. Twenty is well clear of any
     * honest plan, so exceeding it is malformed rather than merely long.
     */
    operations: z.ZodArray<z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
        kind: z.ZodLiteral<"create">;
        /** Registry type name: 'task', 'habit', or a user-defined slug. */
        itemType: z.ZodString;
        /** Required on create — the one field a new item cannot be missing. */
        title: z.ZodString;
        project: z.ZodOptional<z.ZodString>;
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
        parentItemId: z.ZodOptional<z.ZodString>;
        startDate: z.ZodOptional<z.ZodString>;
        timeBucket: z.ZodOptional<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>;
        startTime: z.ZodOptional<z.ZodString>;
        priority: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
        notes: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        title: string;
        kind: "create";
        itemType: string;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        notes?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        parentItemId?: string | undefined;
    }, {
        title: string;
        kind: "create";
        itemType: string;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        notes?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        parentItemId?: string | undefined;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"update">;
        itemId: z.ZodString;
        /** Null clears the field, matching the update-schema convention above. */
        startDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        timeBucket: z.ZodOptional<z.ZodNullable<z.ZodEnum<["anytime", "morning", "afternoon", "evening"]>>>;
        startTime: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        priority: z.ZodOptional<z.ZodNullable<z.ZodEnum<["low", "medium", "high"]>>>;
        status: z.ZodOptional<z.ZodString>;
        title: z.ZodOptional<z.ZodString>;
        notes: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        kind: "update";
        itemId: string;
        status?: string | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
        startTime?: string | null | undefined;
        notes?: string | undefined;
        title?: string | undefined;
        priority?: "low" | "medium" | "high" | null | undefined;
        startDate?: string | null | undefined;
    }, {
        kind: "update";
        itemId: string;
        status?: string | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
        startTime?: string | null | undefined;
        notes?: string | undefined;
        title?: string | undefined;
        priority?: "low" | "medium" | "high" | null | undefined;
        startDate?: string | null | undefined;
    }>]>, "many">;
    createdAt: z.ZodString;
}, "id" | "createdAt">, "strip", z.ZodTypeAny, {
    summary: string;
    operations: ({
        title: string;
        kind: "create";
        itemType: string;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        notes?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        parentItemId?: string | undefined;
    } | {
        kind: "update";
        itemId: string;
        status?: string | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
        startTime?: string | null | undefined;
        notes?: string | undefined;
        title?: string | undefined;
        priority?: "low" | "medium" | "high" | null | undefined;
        startDate?: string | null | undefined;
    })[];
    rationale?: string | undefined;
}, {
    summary: string;
    operations: ({
        title: string;
        kind: "create";
        itemType: string;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | undefined;
        startTime?: string | undefined;
        notes?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
        project?: string | undefined;
        startDate?: string | undefined;
        parentItemId?: string | undefined;
    } | {
        kind: "update";
        itemId: string;
        status?: string | undefined;
        timeBucket?: "anytime" | "morning" | "afternoon" | "evening" | null | undefined;
        startTime?: string | null | undefined;
        notes?: string | undefined;
        title?: string | undefined;
        priority?: "low" | "medium" | "high" | null | undefined;
        startDate?: string | null | undefined;
    })[];
    rationale?: string | undefined;
}>;
export declare const DsulChangeEventSchema: z.ZodObject<{
    event: z.ZodEnum<["tasks.updated", "habits.updated", "projects.updated", "habitGroups.updated"]>;
    userId: z.ZodString;
    data: z.ZodUnknown;
    timestamp: z.ZodString;
}, "strip", z.ZodTypeAny, {
    userId: string;
    event: "tasks.updated" | "habits.updated" | "projects.updated" | "habitGroups.updated";
    timestamp: string;
    data?: unknown;
}, {
    userId: string;
    event: "tasks.updated" | "habits.updated" | "projects.updated" | "habitGroups.updated";
    timestamp: string;
    data?: unknown;
}>;
//# sourceMappingURL=schemas.d.ts.map