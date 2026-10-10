import type { Habit, Priority, RepeatFrequency, Task, TimeBucket } from '@dsul/types';
import { getItemTypeConfig, type ItemTypeConfig } from './item-registry';
import { MAX_BULK_ITEMS } from './bulk-add';
import { autoCorrectBucket } from './time-bucket';
import { classifyKindForItemType, sameContainerName } from './container-registry';

/**
 * WHAT A TYPED EDIT FROM THE IPHONE MAY CHANGE, AND WHAT IT WRITES.
 *
 * The web makes these edits in the item dialog (taskUpdatesFromDraft /
 * habitUpdatesFromDraft, components/planner/item-dialog.tsx) and the planner
 * store, and a route can import neither: the dialog is a client component and
 * the store, like lib/item-verbs.ts, pulls in the browser. So the rule lives
 * here, pure, and /api/app/items/:id (lib/app-api.ts) asks it. DsulCore's
 * ItemEdit.swift ports it once, and tests/fixtures/day/edit-writes.json (written
 * by tests/unit/edit-writes-fixtures.test.ts) holds both to what the web's own
 * gesture writes through the real store.
 *
 * The split: what a BODY may say is the Zod schema's (an unknown key, a blank
 * title, a request too large to read, cue words with no time); what a ROW
 * allows is `editRefusal`'s (a type without the field, text growing past its
 * cap). Anything that passes both is `editPatch`, which is `{}` when the edit is
 * already so.
 *
 * The chips' three edits (2c):
 *  - `priority` is refused (`no_priority`) on a type whose schema has none (a
 *    habit), and writes the one column, null for None.
 *  - `timesPerDay` is refused (`no_count`) on a type without a daily count (a
 *    task, a custom item), and writes the one column. A habit with none stored
 *    counts once (the dialog seeds it as '1'), so 1 on none is already so.
 *    `TIMES_PER_DAY_MAX` bounds it, and is the web chip's list.
 *  - `reminder` is refused (`not_remindable`) where lib/item-registry.ts
 *    isRemindable says no (the type, and never a subtask), and its cue words
 *    are growth-capped like a title. It writes both columns together, as the
 *    dialog does: `reminderPatch` is the dialog's own rule, which its mappers
 *    and its add path call too. A time sent alone keeps the stored words.
 *
 * The Time chip's edit (2d), `time`: a part of day, a specific time and a
 * length, each sent only when it changed. It is refused under a subtask
 * (`not_for_subtask`), on a date-anchored item with no date (`not_dated`, a
 * 409: the dialog shows Time only once such an item is dated), with a length
 * on a type whose schema has none (`no_duration`), and when it would leave a
 * time beside Anytime or no part of day (`invalid`). `timeEditPatch` is the
 * dialog's own save, commitEdit, over the keys sent. Its pieces are the
 * store's and the dialog's, which import them back from here:
 * `scheduleTaskPatch`, `UNSCHEDULE_TASK_PATCH` and `scheduleHabitPatch` (the
 * store's schedule writes), `planTimeEdit` (commitEdit's second pass) and the
 * lengths' words (`DURATION_ORDER`, `durationLabel`). The date is not here:
 * the Date chip writes through `move`.
 *
 * The Repeat chip's edit (2e), `repeat`: a frequency, with its days for
 * Custom days alone and its day of the month for Monthly alone. It is refused
 * under a subtask (`not_for_subtask`) and with a frequency its type doesn't
 * offer (`frequency_not_allowed`, a habit's 'none'); days or a day beside the
 * wrong frequency, and days not strictly ascending, are the schema's refusal.
 * `repeatEditPatch` is the dialog's save over the keys sent, and
 * `repeatPatch` is the dialog's own rule, which its mappers and its add path
 * import back. Goal roles are not here: the route demotes any the write left
 * untrue through lib/goal-roles.ts once the write has landed.
 *
 * The project chip's edit (2f), `project`: a project by id, or null for No
 * project. It is refused under a subtask (`not_for_subtask`), on a type with no
 * project axis (`no_project`) and, for No project, on a type whose container
 * is required (`project_required`); no shipped type meets the last two. The
 * route reads the project's own name first (a project gone is its refusal,
 * since only it reads one), and `projectRefilePatch` writes it: the bulk Move
 * to project's own rule, which the store's setItemsProject imports back, and
 * whose release of a parked task (`projectBlockRelease`) the item dialog's
 * project change shares.
 *
 * Two of the sheet's writes are not edits of a field, and have their own rule:
 *  - Add a subtask (`subtaskRefusal`) is refused on a type without subtasks (a
 *    habit) and under a subtask, since one level is all there is. It writes a
 *    new row, never this one, so it has no patch: the route creates the task.
 *  - Reset streak (`resetStreakRefusal`, `resetStreakPatch`) is refused on a
 *    type without a streak counter, and writes `streak: 0` alone, never the
 *    completion history, and nothing at all when the streak is already 0.
 *
 * `EDIT_COPY` holds the sentences the web and the phone both say, so neither
 * spells them twice.
 *
 * Imports @dsul/types, lib/item-registry.ts (a type's config), lib/bulk-add.ts's
 * cap, lib/time-bucket.ts's auto-correct, and lib/container-registry.ts's
 * project kind and its case rule (pure: no store, no DOM) only, so any route
 * can use it.
 */

/** One typed edit, as the phone sends it. Each is its own server action. */
export type ItemEdit =
  | { action: 'title'; title: string }
  | { action: 'notes'; notes: string | null }
  | { action: 'priority'; priority: Priority | null }
  | { action: 'timesPerDay'; timesPerDay: number }
  /** A null time turns the reminder off. `anchor` absent keeps the stored words. */
  | { action: 'reminder'; time: string | null; anchor?: string | null }
  /**
   * The Time chip. Each key only when it changed: a part of day (null for none, a habit's only),
   * a specific time (null for none) and a length in minutes.
   */
  | { action: 'time'; timeBucket?: TimeBucket | null; startTime?: string | null; duration?: number }
  /**
   * The Repeat chip: one of the type's frequencies, with its days for Custom days alone and its
   * day of the month for Monthly alone. All three keys are written together.
   */
  | { action: 'repeat'; frequency: RepeatFrequency; days?: number[]; monthDay?: number }
  /**
   * The project chip: a project by id, or null for No project. The route reads the project's own
   * name under RLS (editPatch's `ctx`), so the phone never sends one.
   */
  | { action: 'project'; projectId: string | null };

/** The columns an edit is decided on, as the route selects them. */
export interface EditRow {
  id: string;
  type: string;
  parent_item_id: string | null;
  title?: string | null;
  notes?: string | null;
  streak?: number | null;
  priority?: string | null;
  times_per_day?: number | null;
  reminder_time?: string | null;
  reminder_anchor?: string | null;
  /** The Time chip's (2d): the first three are in every read, the rest in its own. */
  start_date?: string | null;
  time_bucket?: string | null;
  in_project_block?: boolean | null;
  start_time?: string | null;
  is_scheduled?: boolean | null;
  duration?: number | null;
  /** The Repeat chip's (2e): the frequency is in every read, the days and the day in its own. */
  repeat_frequency?: string | null;
  repeat_days?: number[] | null;
  repeat_month_day?: number | null;
  /** The project chip's (2f), in its own read; in_project_block is in every read. */
  project?: string | null;
  project_id?: string | null;
  previous_start_time?: string | null;
  previous_start_date?: string | null;
}

/**
 * That row, camelCased. A column the route didn't read is absent, never
 * null: a tick reads no notes, and "no notes read" is not "no notes".
 */
export interface EditShape {
  id: string;
  /** The stored slug ('task', 'habit' or a custom type's name), never 'custom'. */
  type: string;
  parentItemId: string | null;
  title?: string;
  notes?: string | null;
  /** Reset streak's column. Absent when not read, like `notes`. */
  streak?: number | null;
  /** The chips' columns (2c), each absent when not read, like `notes`. */
  priority?: string | null;
  timesPerDay?: number | null;
  reminderTime?: string | null;
  reminderAnchor?: string | null;
  /** The Time chip's columns (2d), each absent when not read, like `notes`. */
  startDate?: string | null;
  timeBucket?: TimeBucket | null;
  inProjectBlock?: boolean | null;
  startTime?: string | null;
  isScheduled?: boolean | null;
  duration?: number | null;
  /** The Repeat chip's columns (2e), each absent when not read, like `notes`. */
  repeatFrequency?: RepeatFrequency | null;
  repeatDays?: number[] | null;
  repeatMonthDay?: number | null;
  /** The project chip's columns (2f), each absent when not read, like `notes`. */
  project?: string | null;
  projectId?: string | null;
  previousStartTime?: string | null;
  previousStartDate?: string | null;
}

export function editShapeFromRow(row: EditRow): EditShape {
  return {
    id: row.id,
    type: row.type,
    parentItemId: row.parent_item_id ?? null,
    ...(row.title !== undefined ? { title: row.title ?? '' } : {}),
    ...(row.notes !== undefined ? { notes: row.notes ?? null } : {}),
    ...(row.streak !== undefined ? { streak: row.streak ?? null } : {}),
    ...(row.priority !== undefined ? { priority: row.priority ?? null } : {}),
    ...(row.times_per_day !== undefined ? { timesPerDay: row.times_per_day ?? null } : {}),
    ...(row.reminder_time !== undefined ? { reminderTime: row.reminder_time ?? null } : {}),
    ...(row.reminder_anchor !== undefined ? { reminderAnchor: row.reminder_anchor ?? null } : {}),
    ...(row.start_date !== undefined ? { startDate: row.start_date ?? null } : {}),
    // The cast lib/db.ts itemFromRow makes on the same text column.
    ...(row.time_bucket !== undefined ? { timeBucket: (row.time_bucket ?? null) as TimeBucket | null } : {}),
    ...(row.in_project_block !== undefined ? { inProjectBlock: row.in_project_block ?? null } : {}),
    ...(row.start_time !== undefined ? { startTime: row.start_time ?? null } : {}),
    ...(row.is_scheduled !== undefined ? { isScheduled: row.is_scheduled ?? null } : {}),
    ...(row.duration !== undefined ? { duration: row.duration ?? null } : {}),
    // The cast lib/db.ts itemFromRow makes on the same text column.
    ...(row.repeat_frequency !== undefined
      ? { repeatFrequency: (row.repeat_frequency ?? null) as RepeatFrequency | null }
      : {}),
    ...(row.repeat_days !== undefined ? { repeatDays: row.repeat_days ?? null } : {}),
    ...(row.repeat_month_day !== undefined ? { repeatMonthDay: row.repeat_month_day ?? null } : {}),
    ...(row.project !== undefined ? { project: row.project ?? null } : {}),
    ...(row.project_id !== undefined ? { projectId: row.project_id ?? null } : {}),
    ...(row.previous_start_time !== undefined ? { previousStartTime: row.previous_start_time ?? null } : {}),
    ...(row.previous_start_date !== undefined ? { previousStartDate: row.previous_start_date ?? null } : {}),
  };
}

/**
 * Growth-only caps, in UTF-16 units (JS `length`). Nothing else in dsul caps
 * these fields (the dialog, the agent API and a paste all write any length),
 * so stored text can already be longer, and a cap that refused it would make
 * an old title uneditable or, worse, cut it on a save that never touched it.
 * Text over the cap may stay as long as it is; it may never grow.
 */
export const EDIT_LIMITS = { title: 500, notes: 50_000, anchor: 500 } as const;

/** What one request may carry at all, checked by the schema before the row is read. */
export const OUTER_LIMITS = { title: 10_000, notes: 200_000, anchor: 10_000 } as const;

/**
 * The most times a day a habit may count to: the web chip's list, "1× a day"
 * to "5× a day" (item-dialog.tsx timesPerDayChip), and the schema's bound.
 */
export const TIMES_PER_DAY_MAX = 5;

/**
 * The longest one request may set a length to, in minutes: a day. The web's
 * chip offers 15 to 120 and a block resized on the grid stores any length, so
 * this is only what the schema takes.
 */
export const MAX_DURATION_MINUTES = 1440;

/**
 * The cap on NEW text: a captured task's title, and a new subtask's. There is
 * nothing stored for it to grow from, so it is the plain cap, not a growth cap,
 * and the schema checks it before the row is read.
 */
export const NEW_TITLE_LIMIT = 500;

/** `next` is no longer than `cap`, or than what is stored, whichever is longer. */
export function withinGrowthLimit(next: string, stored: string | null | undefined, cap: number): boolean {
  return next.length <= Math.max(cap, stored?.length ?? 0);
}

/**
 * Notes as the dialog saves them: trimmed, and empty is no notes at all
 * (`d.notes.trim() || undefined`, item-dialog.tsx), which lib/db.ts writes as
 * NULL.
 */
export function cleanNotes(raw: string | null): string | undefined {
  return raw?.trim() || undefined;
}

/**
 * The reminder's two columns, written together, as the dialog writes them: a
 * time turns it on with the cue words trimmed (blank is none); no time turns it
 * off and clears the words too. Both keys always, so lib/db.ts writes both
 * (undefined is NULL). Never reminder_sent_key, so a new time re-arms itself
 * (migration 032), and never the snooze columns.
 */
export function reminderPatch(
  time: string | null | undefined,
  anchor: string | null | undefined,
): { reminderTime: string | undefined; reminderAnchor: string | undefined } {
  return {
    reminderTime: time || undefined,
    reminderAnchor: time ? anchor?.trim() || undefined : undefined,
  };
}

/** The three repeat keys, always all present: undefined is written as NULL. */
export interface RepeatPatch {
  repeatFrequency: RepeatFrequency | undefined;
  repeatDays: number[] | undefined;
  repeatMonthDay: number | undefined;
}

/**
 * The Repeat chip as the item dialog writes it (components/planner/item-dialog.tsx: both
 * mappers and the add path, which import it back). The three fields are one control, so
 * touching any writes all three, each key present: the days only for Custom days, the day only
 * for Monthly. A habit keeps its frequency as given (it always repeats; the registry never
 * offers it 'none'); any other type writes 'none' as no repeat at all. `type` is the stored
 * slug, and 'habit' is the test lib/db.ts updatesToRow makes to choose habitUpdatesToRow,
 * which writes repeat_frequency only when it is set.
 */
export function repeatPatch(
  type: 'habit',
  frequency: RepeatFrequency,
  days: number[],
  monthDay: number,
): RepeatPatch & { repeatFrequency: RepeatFrequency };
export function repeatPatch(type: string, frequency: RepeatFrequency, days: number[], monthDay: number): RepeatPatch;
export function repeatPatch(type: string, frequency: RepeatFrequency, days: number[], monthDay: number): RepeatPatch {
  return {
    repeatFrequency: type === 'habit' || frequency !== 'none' ? frequency : undefined,
    repeatDays: frequency === 'custom' ? days : undefined,
    repeatMonthDay: frequency === 'monthly' ? monthDay : undefined,
  };
}

export interface EditRefusal {
  code: string;
  status: 400 | 409;
}

const INVALID: EditRefusal = { code: 'invalid', status: 400 };

/**
 * Why this row won't take this edit, or null. A code, never words: the phone
 * says it in its own.
 *
 * A title is every type's, a subtask's included. Notes are a type's only when
 * its schema has them (`fields`), which today is every type, so `no_notes` is
 * the answer a future type gets rather than one anyone gets now.
 *
 * A priority is a type's when its schema has one: `no_priority` on a habit, and
 * a subtask's is taken. A times a day is a type's with a daily count: `no_count`
 * on a task or a custom item. A reminder is `not_remindable` where
 * isRemindable says no, and its cue words, once trimmed, may not grow past
 * their cap. Cue words with no time are the schema's refusal, not this one's:
 * that is a rule about the body, and reads no row.
 *
 * A time edit is `not_for_subtask` under a subtask, `not_dated` (409) on a
 * date-anchored type with no date, and `no_duration` with a length on a type
 * whose schema has none (today every type has one). Its row rule: a time may
 * not land beside Anytime or no part of day, judged as the row will be once
 * written, the sent value or else the stored one for each. A time sent beside
 * Anytime or null in the same body is the schema's refusal.
 *
 * A repeat edit is `not_for_subtask` under a subtask and
 * `frequency_not_allowed` with a frequency its type doesn't offer; days or a
 * day beside the wrong frequency, and days out of order, are the schema's
 * refusal.
 *
 * A project edit is `not_for_subtask` under a subtask, `no_project` on a type
 * with no project axis and `project_required` when it would clear a container
 * the type requires; a project that is gone is the route's (`project_gone`),
 * since only the route reads it.
 */
export function editRefusal(row: EditShape, edit: ItemEdit, config: ItemTypeConfig): EditRefusal | null {
  switch (edit.action) {
    case 'title': {
      const title = edit.title.trim();
      if (!title || !withinGrowthLimit(title, row.title, EDIT_LIMITS.title)) return INVALID;
      return null;
    }
    case 'notes': {
      if (!config.fields.includes('notes')) return { code: 'no_notes', status: 400 };
      if (!withinGrowthLimit(cleanNotes(edit.notes) ?? '', row.notes, EDIT_LIMITS.notes)) return INVALID;
      return null;
    }
    case 'priority':
      return config.fields.includes('priority') ? null : { code: 'no_priority', status: 400 };
    case 'timesPerDay':
      return config.counters.dailyCounts ? null : { code: 'no_count', status: 400 };
    case 'reminder': {
      // lib/item-registry.ts isRemindable, on the row: the type's capability, and never a subtask.
      if (!config.remindable || row.parentItemId) return { code: 'not_remindable', status: 400 };
      if (
        edit.time !== null &&
        edit.anchor != null &&
        !withinGrowthLimit(edit.anchor.trim(), row.reminderAnchor, EDIT_LIMITS.anchor)
      ) {
        return INVALID;
      }
      return null;
    }
    case 'time': {
      if (row.parentItemId) return { code: 'not_for_subtask', status: 400 };
      if (edit.duration !== undefined && !config.fields.includes('duration')) {
        return { code: 'no_duration', status: 400 };
      }
      // The dialog shows Time only once a date-anchored item is dated (showTime).
      if (config.dateAnchored && !row.startDate) return { code: 'not_dated', status: 409 };
      // A time needs a part of day that holds one, as it will be once written: the sent bucket
      // (null included) or the stored one, and the sent time or the stored one.
      if (edit.timeBucket !== undefined || edit.startTime !== undefined) {
        const bucket = edit.timeBucket !== undefined ? edit.timeBucket : row.timeBucket;
        const time = edit.startTime !== undefined ? edit.startTime : row.startTime;
        if (time && (!bucket || bucket === 'anytime')) return INVALID;
      }
      return null;
    }
    case 'repeat': {
      // As the Time chip (2d): a subtask shows only in its parent's sheet, so a repeat there
      // would show nowhere.
      if (row.parentItemId) return { code: 'not_for_subtask', status: 400 };
      // The chip lists only the type's frequencies: a habit has no 'none'.
      if (!(config.allowedFrequencies as readonly string[]).includes(edit.frequency)) {
        return { code: 'frequency_not_allowed', status: 400 };
      }
      return null;
    }
    case 'project': {
      // As the Time and Repeat chips: a subtask shows only in its parent's sheet.
      if (row.parentItemId) return { code: 'not_for_subtask', status: 400 };
      // The bulk path's two skips (lib/bulk-edit.ts canBulkSetProject, canBulkClearProject),
      // refused rather than answered 200 having done nothing. No shipped type meets either.
      if (classifyKindForItemType(config.containerKind) !== 'project') return { code: 'no_project', status: 400 };
      if (edit.projectId === null && config.containerRequired) return { code: 'project_required', status: 400 };
      return null;
    }
  }
}

/** The fields an edit writes, keyed as `updateItem` takes them. Grows with each edit. */
export type EditPatch = Partial<
  Pick<
    Task,
    | 'title'
    | 'notes'
    | 'priority'
    | 'reminderTime'
    | 'reminderAnchor'
    | 'startTime'
    | 'timeBucket'
    | 'duration'
    | 'isScheduled'
    | 'inProjectBlock'
    | 'previousStartTime'
    | 'previousStartDate'
    | 'repeatFrequency'
    | 'repeatDays'
    | 'repeatMonthDay'
    | 'project'
    | 'projectId'
    | 'startDate'
  > &
    Pick<Habit, 'streak' | 'timesPerDay'>
>;

/**
 * The `updateItem` payload for an edit `editRefusal` allowed: the dialog's
 * mapper for that one key, or `{}` when the row already says it (answered 200
 * with no write, no event and no undo entry, as the dialog's autosave skips a
 * draft that didn't change). A key set to undefined is written as NULL
 * (lib/db.ts taskUpdatesToRow / habitUpdatesToRow).
 *
 * A column the route didn't read is never taken as already so: the edit
 * writes. A reminder writes both its columns whenever it writes, as the
 * dialog does; a time sent alone keeps the stored words, trimmed, since the
 * dialog's draft holds them, and touching either key writes both.
 *
 * `config` matters only to `time` (its seeded length is the type's default
 * block) and `repeat` (its seeded frequency is the type's default), and
 * defaults to the row's own type.
 *
 * `ctx.project` is the project a `project` edit names, as the route read it
 * (its own name and id, or null for No project); every other edit ignores it.
 */
export function editPatch(
  row: EditShape,
  edit: ItemEdit,
  config: ItemTypeConfig = getItemTypeConfig(row.type),
  ctx: { project?: { id: string; name: string } | null } = {},
): EditPatch {
  switch (edit.action) {
    case 'title': {
      const title = edit.title.trim();
      return title === row.title ? {} : { title };
    }
    case 'notes': {
      const notes = cleanNotes(edit.notes);
      return row.notes !== undefined && (notes ?? null) === row.notes ? {} : { notes };
    }
    case 'priority':
      return row.priority !== undefined && (row.priority ?? null) === (edit.priority ?? null)
        ? {}
        : { priority: edit.priority ?? undefined };
    case 'timesPerDay':
      // The dialog seeds a habit with none as '1' (draftFromItem), so none and 1 are one value.
      return row.timesPerDay !== undefined && (row.timesPerDay ?? 1) === edit.timesPerDay
        ? {}
        : { timesPerDay: edit.timesPerDay };
    case 'reminder': {
      // An anchor the route didn't read is never cleared by a time-only edit.
      if (edit.time !== null && edit.anchor === undefined && row.reminderAnchor === undefined) {
        return { reminderTime: edit.time };
      }
      const patch = reminderPatch(edit.time, edit.anchor !== undefined ? edit.anchor : row.reminderAnchor);
      const same =
        row.reminderTime !== undefined &&
        row.reminderAnchor !== undefined &&
        (patch.reminderTime ?? null) === (row.reminderTime ?? null) &&
        (patch.reminderAnchor ?? null) === (row.reminderAnchor ?? null);
      return same ? {} : patch;
    }
    case 'time':
      return timeEditPatch(row, edit, config);
    case 'repeat':
      return repeatEditPatch(row, edit, config);
    case 'project': {
      // The route's read of the project the edit names: null for No project.
      const target = ctx.project;
      if (
        target === undefined ||
        (target === null) !== (edit.projectId === null) ||
        (target !== null && target.id !== edit.projectId)
      ) {
        throw new Error('editPatch: a project edit needs the project the route read');
      }
      return projectRefilePatch(refileItemFromShape(row), target?.name, target?.id) ?? {};
    }
  }
}

/**
 * Why this row won't take a new subtask, or null. The web offers the field
 * only on a type with subtasks (SubtasksSection, components/planner/
 * item-detail-sections.tsx) and only one level deep (lib/db.ts
 * validateParentItemId): a habit is `no_subtasks`, and a subtask, which can't
 * hold one, is `nested`, a 409 since the body is fine and the row said no.
 */
export function subtaskRefusal(row: EditShape, config: ItemTypeConfig): EditRefusal | null {
  if (!config.subtasks) return { code: 'no_subtasks', status: 400 };
  if (row.parentItemId) return { code: 'nested', status: 409 };
  return null;
}

/**
 * Why this type has no streak to reset, or null: only a type with a streak
 * counter (a habit) has one. The Streaks extension isn't asked, as the store's
 * resetHabitStreak doesn't ask it: off hides the control, not the counter.
 */
export function resetStreakRefusal(config: ItemTypeConfig): EditRefusal | null {
  return config.counters.streak ? null : { code: 'no_streak', status: 400 };
}

/**
 * Reset streak's write: the counter alone, as the store's resetHabitStreak
 * writes it (lib/planner-store.ts), never completedDates or dailyCounts, which
 * are the completion history. `{}` when the stored streak is 0, null or not
 * read: already so is 200 with no write and no event. The verb is offered only
 * above 0 (lib/item-verbs.ts resetStreak), so at 0 the web's gesture writes
 * nothing either.
 */
export function resetStreakPatch(row: EditShape): EditPatch {
  return row.streak ? { streak: 0 } : {};
}

// ── The schedule writes (2d) ─────────────────────────────────────────────────

/**
 * lib/planner-store.ts scheduleTask's write, without its optional date:
 * scheduled, the bucket auto-corrected to the time, and out of any project
 * block, its remembered slot forgotten. The store's actions and the route's
 * hour drop build from it, so the release rule is stated once. The keys are in
 * the store's order.
 */
export function scheduleTaskPatch(bucket: TimeBucket, time?: string): Partial<Task> {
  return {
    isScheduled: true,
    timeBucket: autoCorrectBucket(time, bucket) ?? bucket,
    startTime: time,
    inProjectBlock: false,
    previousStartTime: undefined,
    previousStartDate: undefined,
  };
}

/**
 * unscheduleTask's and unscheduleTasks' write: back to the braindump. Frozen,
 * since both verbs share it; a caller spreads it into a patch of its own.
 */
export const UNSCHEDULE_TASK_PATCH: Readonly<Partial<Task>> = Object.freeze({
  isScheduled: false,
  timeBucket: undefined,
  startTime: undefined,
  startDate: undefined,
});

/** scheduleHabit's write: the bucket auto-corrected to the time. */
export function scheduleHabitPatch(bucket: TimeBucket, time?: string): Partial<Habit> {
  return { timeBucket: autoCorrectBucket(time, bucket) ?? bucket, startTime: time };
}

/** What commitEdit's second pass reads off the live item (the store's, before the first pass). */
export interface TimeLive {
  /** 'habit' takes the habit branch; anything else (a task, 'custom') the task branch. */
  type: string;
  timeBucket?: TimeBucket;
  startTime?: string;
  isScheduled?: boolean;
}

/** What it reads off the draft (ItemDraft's fields; only startDate's truthiness matters). */
export interface TimeDraft {
  startDate: Date | string | undefined;
  /** 'none' is the draft's own "no part of day". */
  timeBucket: TimeBucket | 'none';
  /** '' is the draft's "no specific time". */
  startTime: string;
}

/** The store call commitEdit's second pass makes, if any. */
export type TimePlan =
  | { kind: 'none' }
  | { kind: 'scheduleTask'; bucket: TimeBucket; time: string | undefined }
  | { kind: 'setTime'; time: string | undefined }
  | { kind: 'unscheduleTask' }
  | { kind: 'scheduleHabit'; bucket: TimeBucket; time: string | undefined }
  | { kind: 'clearHabitTime' };

/**
 * commitEdit's second pass (components/planner/item-dialog.tsx): scheduling
 * goes through scheduleTask / unscheduleTask / scheduleHabit, which own
 * isScheduled and the project-block clears, and only when something
 * schedule-shaped moved (`keys`, the draft keys that differ from the seed).
 * Compared against the LIVE item, read before the first pass: after the first
 * autosave the dialog's seeded snapshot is stale, and a stale comparison would
 * re-run scheduleTask, which unconditionally clears inProjectBlock and the
 * previous slot, on every save. The dialog runs the plan on the store;
 * timeEditPatch turns it into one patch for the route.
 */
export function planTimeEdit(live: TimeLive, d: TimeDraft, keys: readonly string[]): TimePlan {
  const wants = (...fields: string[]) => fields.some((f) => keys.includes(f));
  const startTime = d.startTime || undefined;

  // Habit first; task and custom items share the task-shaped save path (the
  // store's task actions operate on any task-like item).
  if (live.type !== 'habit') {
    if (!wants('startDate', 'timeBucket', 'startTime')) return { kind: 'none' };
    const effectiveTimeBucket = d.startDate ? (d.timeBucket === 'none' ? 'anytime' : d.timeBucket) : undefined;
    if (d.startDate && effectiveTimeBucket) {
      if (effectiveTimeBucket !== live.timeBucket || !live.isScheduled) {
        return { kind: 'scheduleTask', bucket: effectiveTimeBucket, time: startTime };
      }
      // `''` is the draft's sentinel for "no specific time"; the store says
      // `undefined`. Comparing them raw made this branch fire on every save for
      // every bucket-only task.
      return startTime !== live.startTime ? { kind: 'setTime', time: startTime } : { kind: 'none' };
    }
    return !d.startDate && live.isScheduled ? { kind: 'unscheduleTask' } : { kind: 'none' };
  }

  // Same second pass, and the same reason for the equality guard the task
  // branch has always had: scheduleHabit writes unconditionally.
  if (!wants('timeBucket', 'startTime')) return { kind: 'none' };
  if (d.timeBucket !== 'none') {
    return d.timeBucket !== live.timeBucket || startTime !== live.startTime
      ? { kind: 'scheduleHabit', bucket: d.timeBucket, time: startTime }
      : { kind: 'none' };
  }
  return live.timeBucket !== undefined ? { kind: 'clearHabitTime' } : { kind: 'none' };
}

/**
 * `time`: the dialog's Time chip, as commitEdit saves it, over the keys sent.
 * The draft is seeded as draftFromItem seeds it; a sent key is changed only
 * when it differs from that seed (null is 'none' for the bucket and '' for the
 * time, as the chip's rows set them). Then the two passes: the mapper
 * (startTime, duration) through updateTask / updateHabit's auto-correct
 * against the stored bucket, and planTimeEdit resolved to the store's
 * patches, a new time alone auto-corrected against the bucket as the first
 * pass left it. Merged in that order: one updateItem where the web makes up to
 * two, and the same end row. `{}` when nothing changed.
 *
 * No "equals the row" shortcut: the web writes whenever a key moved, even when
 * the end row is the one stored (a habit's Evening under 9:00 is filed back in
 * Morning by scheduleHabit's auto-correct, and written), and the fixture is
 * the web's write.
 *
 * Throws when a column it decides on wasn't read: EDIT_COLUMNS.time always
 * reads them.
 */
export function timeEditPatch(
  row: EditShape,
  edit: Extract<ItemEdit, { action: 'time' }>,
  config: ItemTypeConfig,
): EditPatch {
  const { startDate, timeBucket, startTime, isScheduled, duration } = row;
  if (
    startDate === undefined ||
    timeBucket === undefined ||
    startTime === undefined ||
    isScheduled === undefined ||
    duration === undefined
  ) {
    throw new Error('timeEditPatch: the row was read without its time columns');
  }

  // The seed, as draftFromItem seeds the dialog's draft. A habit has no date.
  const seed: TimeDraft & { duration: string } = {
    startDate: row.type === 'habit' ? undefined : startDate || undefined,
    timeBucket: timeBucket || 'none',
    startTime: startTime || '',
    duration: String(duration ?? config.schedule.defaultBlockMinutes),
  };
  const draft: TimeDraft & { duration: string } = {
    ...seed,
    ...(edit.timeBucket !== undefined ? { timeBucket: edit.timeBucket ?? 'none' } : {}),
    ...(edit.startTime !== undefined ? { startTime: edit.startTime ?? '' } : {}),
    ...(edit.duration !== undefined ? { duration: String(edit.duration) } : {}),
  };
  const keys = (['timeBucket', 'startTime', 'duration'] as const).filter((k) => draft[k] !== seed[k]);
  if (keys.length === 0) return {};

  const live: TimeLive = {
    type: row.type,
    timeBucket: timeBucket ?? undefined,
    startTime: startTime ?? undefined,
    isScheduled: isScheduled ?? undefined,
  };

  // Pass 1: the mapper, then updateTask / updateHabit's auto-correct against the stored bucket.
  const first: EditPatch = {};
  if (keys.includes('duration')) first.duration = parseInt(draft.duration);
  if (keys.includes('startTime')) {
    first.startTime = draft.startTime || undefined;
    if (first.startTime) {
      const corrected = autoCorrectBucket(first.startTime, live.timeBucket);
      if (corrected !== live.timeBucket) first.timeBucket = corrected;
    }
  }

  // Pass 2: the store call commitEdit makes, as the patch that call writes.
  const plan = planTimeEdit(live, draft, keys);
  let second: EditPatch = {};
  switch (plan.kind) {
    case 'scheduleTask':
      second = scheduleTaskPatch(plan.bucket, plan.time);
      break;
    case 'setTime': {
      // updateTask's auto-correct, against the bucket as the first pass left it.
      second = { startTime: plan.time };
      const bucket = first.timeBucket ?? live.timeBucket;
      if (plan.time) {
        const corrected = autoCorrectBucket(plan.time, bucket);
        if (corrected !== bucket) second.timeBucket = corrected;
      }
      break;
    }
    case 'unscheduleTask':
      // Unreachable: every task-like type is date-anchored, and not_dated refuses an undated
      // one. Kept so the two can't drift.
      second = { ...UNSCHEDULE_TASK_PATCH };
      break;
    case 'scheduleHabit':
      second = scheduleHabitPatch(plan.bucket, plan.time);
      break;
    case 'clearHabitTime':
      second = { timeBucket: undefined, startTime: undefined };
      break;
    case 'none':
      break;
  }
  return { ...first, ...second };
}

// ── The repeat write (2e) ────────────────────────────────────────────────────

/**
 * `repeat`: the dialog's Repeat chip as its save writes it. The draft is seeded as
 * draftFromItem seeds it (the stored frequency or the type's default, the stored days or none,
 * the stored day or the 1st), and the sent keys go over it. The three fields are one control:
 * when any differs from its seed (by JSON, as scheduleSave compares the draft) all three are
 * written (repeatPatch), and when none does nothing is ({}), so a stale day under another
 * frequency stays as it is. Throws when a repeat column wasn't read: EDIT_COLUMNS.repeat and
 * the shared read always read them.
 */
export function repeatEditPatch(
  row: EditShape,
  edit: Extract<ItemEdit, { action: 'repeat' }>,
  config: ItemTypeConfig,
): EditPatch {
  const { repeatFrequency, repeatDays, repeatMonthDay } = row;
  if (repeatFrequency === undefined || repeatDays === undefined || repeatMonthDay === undefined) {
    throw new Error('repeatEditPatch: the row was read without its repeat columns');
  }
  const seed = {
    frequency: repeatFrequency ?? config.defaultFrequency,
    days: repeatDays || [],
    monthDay: repeatMonthDay || 1,
  };
  const draft = {
    frequency: edit.frequency,
    days: edit.days ?? seed.days,
    monthDay: edit.monthDay ?? seed.monthDay,
  };
  const moved =
    draft.frequency !== seed.frequency ||
    JSON.stringify(draft.days) !== JSON.stringify(seed.days) ||
    draft.monthDay !== seed.monthDay;
  return moved ? repeatPatch(row.type, draft.frequency, draft.days, draft.monthDay) : {};
}

// ── The project write (2f) ───────────────────────────────────────────────────

/** What a re-file reads of an item: the store's Item, or a row (refileItemFromShape). */
export interface RefileItem {
  project?: string;
  projectId?: string;
  inProjectBlock?: boolean;
  previousStartTime?: string;
  previousStartDate?: string;
}

/**
 * Is `current` the project `name` names? The project kind folds case (CONTAINER_KINDS.project
 * caseFold), so 'work' is Work. With no name (No project, and '' as a `name`, which setItemsProject's
 * own `name ?` reads the same way): is there none either? A `current` of '' is a name, as the
 * store holds it: an unfiled habit reads '' (lib/db.ts itemFromRow), so its clear always writes,
 * as the web's does. So (undefined, '') is true and ('', '') is false.
 */
export function sameProjectName(current: string | undefined, name: string | undefined): boolean {
  return name ? current != null && sameContainerName('project', current, name) : current == null;
}

/**
 * A task parked in its project's block (moveTasksToProjectBlock) and moved to another project, or
 * to none: its own time and day back from the stash, and the stash cleared, as
 * moveTaskOutOfProjectBlock writes it. Left parked it would sit in a block it no longer belongs to
 * and show in none. The part of day stays the block's: the stash holds no bucket. `{}` when it isn't
 * parked, or the name doesn't move (a same-name link repair keeps it in its own block).
 */
export function projectBlockRelease(item: RefileItem, name: string | undefined): Partial<Task> {
  if (!item.inProjectBlock || sameProjectName(item.project, name)) return {};
  return {
    inProjectBlock: false,
    startTime: item.previousStartTime,
    startDate: item.previousStartDate,
    previousStartTime: undefined,
    previousStartDate: undefined,
  };
}

/**
 * The bulk Move to project's write for one item (planner-store.ts setItemsProject, which imports it
 * back; the iPhone's `project` route too): the name and the id, and the release. Null when the item
 * is already there by folded name AND id: a folded match whose id is stale, or missing (a text-only
 * reference), still writes, which repairs the link. A key set to undefined is written as NULL.
 */
export function projectRefilePatch(
  item: RefileItem,
  name: string | undefined,
  projectId: string | undefined,
): Partial<Task> | null {
  if (sameProjectName(item.project, name) && item.projectId === projectId) return null;
  return { project: name, projectId, ...projectBlockRelease(item, name) };
}

/**
 * The row as the store would hold it, for projectRefilePatch: a habit as lib/db.ts itemFromRow
 * gives it, its NULL project read as '' (and the frozen `group` column never read: CLAUDE.md keeps
 * its one read in itemFromRow), with no block; any other type with its block and its stash. The
 * branch is `type === 'habit'`, itemFromRow's own. Throws when a column it reads wasn't read:
 * EDIT_COLUMNS.project always reads them.
 */
export function refileItemFromShape(row: EditShape): RefileItem {
  const { project, projectId, previousStartTime, previousStartDate } = row;
  if (
    project === undefined ||
    projectId === undefined ||
    previousStartTime === undefined ||
    previousStartDate === undefined
  ) {
    throw new Error('refileItemFromShape: the row was read without its project columns');
  }
  if (row.type === 'habit') return { project: project ?? '', projectId: projectId ?? undefined };
  return {
    project: project ?? undefined,
    projectId: projectId ?? undefined,
    inProjectBlock: row.inProjectBlock ?? undefined,
    previousStartTime: previousStartTime ?? undefined,
    previousStartDate: previousStartDate ?? undefined,
  };
}

/** The Time chip's lengths, in its order (item-dialog.tsx's Duration rows), as the draft holds them. */
export const DURATION_ORDER = ['15', '30', '45', '60', '90', '120'];

/** Each length's words on the Time chip and in its rows. */
export const DURATION_LABELS: Record<string, string> = {
  '15': '15 min',
  '30': '30 min',
  '45': '45 min',
  '60': '1 hour',
  '90': '1.5 hours',
  '120': '2 hours',
};

/**
 * A length as the Time chip names it: its preset's words, else "N min" (a
 * length set elsewhere, such as a block resized on the grid). Takes the
 * draft's string or a number of minutes.
 */
export function durationLabel(minutes: string | number): string {
  const key = String(minutes);
  return DURATION_LABELS[key] ?? `${key} min`;
}

/**
 * The sentences the web and the phone both say, checked in both by
 * tests/fixtures/day/edit-writes.json (`copy`). DsulCore's EditCopy holds the
 * phone's copy.
 */
export const EDIT_COPY = {
  /** Reset streak's confirm (item-dialog.tsx). */
  resetStreakMessage:
    'This will reset your streak counter to 0 days. Your completion history stays, so days you already checked off remain checked.',
  /** The new-subtask field (item-detail-sections.tsx). */
  subtaskPlaceholder: 'Add subtask…',
  /** A paste past lib/bulk-add.ts's cap, into the new-subtask field. */
  subtaskPasteCapped: `Added the first ${MAX_BULK_ITEMS} subtasks. The paste had more.`,
  /** Remind's Right after field (item-dialog.tsx remindChip). */
  reminderAnchorPlaceholder: 'I pour my coffee',
  /** Under Right after: what the words are for. */
  reminderAnchorHint:
    'Optional, and worth it. Something you already do beats a time. The reminder will say what you write here.',
  /** Under the time, for a dated type with no date (lib/bulk-edit.ts reminderNeedsDate). */
  reminderNeedsDate:
    'Give this a date and it will fire. Without one there is no day for the reminder to land on.',
  /** Under Custom days' keys while none is picked (item-dialog.tsx repeatChip). */
  selectAtLeastOneDay: 'Select at least one day',
  /** Under Monthly's days (item-dialog.tsx repeatChip). */
  monthlyNote: 'For months with fewer days, it will occur on the last day.',
} as const;

/** How long a streak runs, in words: the streak flame's tooltip (components/primitives/pills.tsx). */
export function streakRunText(streak: number): string {
  return streak > 0 ? `${streak} ${streak === 1 ? 'day' : 'days'} in a row` : 'No streak yet';
}
