import type { Task } from '@dsul/types';
import type { ItemTypeConfig } from './item-registry';

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
 * Imports @dsul/types and the registry's types only, so any route can use it.
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
}

export function editShapeFromRow(row: EditRow): EditShape {
  return {
    id: row.id,
    type: row.type,
    parentItemId: row.parent_item_id ?? null,
    ...(row.title !== undefined ? { title: row.title ?? '' } : {}),
    ...(row.notes !== undefined ? { notes: row.notes ?? null } : {}),
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
export type EditPatch = Partial<Pick<Task, 'title' | 'notes'>>;

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
