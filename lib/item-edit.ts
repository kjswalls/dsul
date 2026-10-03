import type { Habit, Priority, Task } from '@dsul/types';
import type { ItemTypeConfig } from './item-registry';
import { MAX_BULK_ITEMS } from './bulk-add';

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
 * Imports @dsul/types, the registry's types and lib/bulk-add.ts's cap (pure:
 * no store, no DOM) only, so any route can use it.
 */

/** One typed edit, as the phone sends it. Each is its own server action. */
export type ItemEdit =
  | { action: 'title'; title: string }
  | { action: 'notes'; notes: string | null }
  | { action: 'priority'; priority: Priority | null }
  | { action: 'timesPerDay'; timesPerDay: number }
  /** A null time turns the reminder off. `anchor` absent keeps the stored words. */
  | { action: 'reminder'; time: string | null; anchor?: string | null };

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
  }
}

/** The fields an edit writes, keyed as `updateItem` takes them. Grows with each edit. */
export type EditPatch = Partial<
  Pick<Task, 'title' | 'notes' | 'priority' | 'reminderTime' | 'reminderAnchor'> & Pick<Habit, 'streak' | 'timesPerDay'>
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
 */
export function editPatch(row: EditShape, edit: ItemEdit): EditPatch {
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
} as const;

/** How long a streak runs, in words: the streak flame's tooltip (components/primitives/pills.tsx). */
export function streakRunText(streak: number): string {
  return streak > 0 ? `${streak} ${streak === 1 ? 'day' : 'days'} in a row` : 'No streak yet';
}
