import type { Habit, Task } from '@dsul/types';
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
 * title, a request too large to read); what a ROW allows is `editRefusal`'s (a
 * type without the field, text growing past its cap). Anything that passes both
 * is `editPatch`, which is `{}` when the edit is already so.
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
export type ItemEdit = { action: 'title'; title: string } | { action: 'notes'; notes: string | null };

/** The columns an edit is decided on, as the route selects them. */
export interface EditRow {
  id: string;
  type: string;
  parent_item_id: string | null;
  title?: string | null;
  notes?: string | null;
  streak?: number | null;
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
}

export function editShapeFromRow(row: EditRow): EditShape {
  return {
    id: row.id,
    type: row.type,
    parentItemId: row.parent_item_id ?? null,
    ...(row.title !== undefined ? { title: row.title ?? '' } : {}),
    ...(row.notes !== undefined ? { notes: row.notes ?? null } : {}),
    ...(row.streak !== undefined ? { streak: row.streak ?? null } : {}),
  };
}

/**
 * Growth-only caps, in UTF-16 units (JS `length`). Nothing else in dsul caps
 * these fields (the dialog, the agent API and a paste all write any length),
 * so stored text can already be longer, and a cap that refused it would make
 * an old title uneditable or, worse, cut it on a save that never touched it.
 * Text over the cap may stay as long as it is; it may never grow.
 */
export const EDIT_LIMITS = { title: 500, notes: 50_000 } as const;

/** What one request may carry at all, checked by the schema before the row is read. */
export const OUTER_LIMITS = { title: 10_000, notes: 200_000 } as const;

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
  }
}

/** The fields an edit writes, keyed as `updateItem` takes them. Grows with each edit. */
export type EditPatch = Partial<Pick<Task, 'title' | 'notes'> & Pick<Habit, 'streak'>>;

/**
 * The `updateItem` payload for an edit `editRefusal` allowed: the dialog's
 * mapper for that one key, or `{}` when the row already says it (answered 200
 * with no write, no event and no undo entry, as the dialog's autosave skips a
 * draft that didn't change). A key set to undefined is written as NULL
 * (lib/db.ts taskUpdatesToRow / habitUpdatesToRow).
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
} as const;

/** How long a streak runs, in words: the streak flame's tooltip (components/primitives/pills.tsx). */
export function streakRunText(streak: number): string {
  return streak > 0 ? `${streak} ${streak === 1 ? 'day' : 'days'} in a row` : 'No streak yet';
}
