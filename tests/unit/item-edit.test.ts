import { describe, expect, it } from 'vitest';
import {
  EDIT_COPY,
  EDIT_LIMITS,
  NEW_TITLE_LIMIT,
  OUTER_LIMITS,
  cleanNotes,
  editPatch,
  editRefusal,
  editShapeFromRow,
  resetStreakPatch,
  resetStreakRefusal,
  streakRunText,
  subtaskRefusal,
  withinGrowthLimit,
  type EditShape,
} from '@/lib/item-edit';
import { getItemTypeConfig, type ItemTypeConfig } from '@/lib/item-registry';

/**
 * lib/item-edit.ts: what the iPhone's typed edits may change and what they
 * write. The cases the web's own gestures produce are pinned end to end in
 * edit-writes-fixtures.test.ts; these are the rule's edges, including the ones
 * no shipped type reaches (a type without notes).
 */

const ID = '0b7e4a52-9c1d-4f3e-8a2b-5d6c7e8f9a0b';
const task = getItemTypeConfig('task');
const habit = getItemTypeConfig('habit');
/** A type whose schema has no notes: none ships, but the gate is the schema's. */
const noNotes: ItemTypeConfig = { ...task, fields: task.fields.filter((f) => f !== 'notes') };

const shape = (over: Partial<EditShape> = {}): EditShape => ({
  id: ID,
  type: 'task',
  parentItemId: null,
  title: 'Call the bank',
  notes: null,
  ...over,
});

describe('withinGrowthLimit', () => {
  it('takes up to the cap over short or missing text', () => {
    for (const stored of [null, undefined, '', 'short']) {
      expect(withinGrowthLimit('x'.repeat(500), stored, 500)).toBe(true);
      expect(withinGrowthLimit('x'.repeat(501), stored, 500)).toBe(false);
    }
  });

  it('lets text already over the cap keep its length, and never grow', () => {
    const stored = 's'.repeat(700);
    expect(withinGrowthLimit('x'.repeat(650), stored, 500)).toBe(true);
    expect(withinGrowthLimit('x'.repeat(700), stored, 500)).toBe(true);
    expect(withinGrowthLimit('x'.repeat(701), stored, 500)).toBe(false);
  });

  it('counts UTF-16 units, as the phone clamps them', () => {
    // An emoji is two units: 250 of them are the whole cap.
    expect(withinGrowthLimit('😀'.repeat(250), null, 500)).toBe(true);
    expect(withinGrowthLimit(`${'😀'.repeat(250)}x`, null, 500)).toBe(false);
  });
});

describe('cleanNotes', () => {
  it('trims, and saves nothing for nothing', () => {
    expect(cleanNotes('  Ask about the fee.\n')).toBe('Ask about the fee.');
    expect(cleanNotes('line one\n\nline two')).toBe('line one\n\nline two');
    expect(cleanNotes(' \n\t ')).toBeUndefined();
    expect(cleanNotes('')).toBeUndefined();
    expect(cleanNotes(null)).toBeUndefined();
  });
});

describe('editShapeFromRow', () => {
  it('camelCases the row and keeps a column it did not read absent', () => {
    expect(editShapeFromRow({ id: ID, type: 'errand', parent_item_id: null })).toEqual({
      id: ID,
      type: 'errand',
      parentItemId: null,
    });
    expect(
      editShapeFromRow({ id: ID, type: 'task', parent_item_id: 'p', title: 'Call', notes: null }),
    ).toEqual({ id: ID, type: 'task', parentItemId: 'p', title: 'Call', notes: null });
  });

  it('carries the streak when it was read, null included', () => {
    expect(editShapeFromRow({ id: ID, type: 'habit', parent_item_id: null, streak: 41 })).toEqual({
      id: ID,
      type: 'habit',
      parentItemId: null,
      streak: 41,
    });
    expect(editShapeFromRow({ id: ID, type: 'habit', parent_item_id: null, streak: null }).streak).toBeNull();
    expect('streak' in editShapeFromRow({ id: ID, type: 'habit', parent_item_id: null })).toBe(false);
  });
});

describe('title', () => {
  it('writes the trimmed title, for every type, a subtask’s included', () => {
    expect(editRefusal(shape(), { action: 'title', title: 'Call' }, task)).toBeNull();
    expect(editPatch(shape(), { action: 'title', title: '  Call the bank today ' })).toEqual({
      title: 'Call the bank today',
    });
    expect(editRefusal(shape({ type: 'habit' }), { action: 'title', title: 'Stretch' }, habit)).toBeNull();
    expect(editRefusal(shape({ parentItemId: ID }), { action: 'title', title: 'Oat milk' }, task)).toBeNull();
  });

  it('writes nothing for the title it already has', () => {
    expect(editPatch(shape(), { action: 'title', title: 'Call the bank' })).toEqual({});
    expect(editPatch(shape(), { action: 'title', title: ' Call the bank ' })).toEqual({});
  });

  it('writes when the stored title was not read, rather than guessing it', () => {
    expect(editPatch(shape({ title: undefined }), { action: 'title', title: 'Call the bank' })).toEqual({
      title: 'Call the bank',
    });
  });

  it('refuses a blank title, and growth past the cap', () => {
    expect(editRefusal(shape(), { action: 'title', title: '  ' }, task)).toEqual({ code: 'invalid', status: 400 });
    const over = 'x'.repeat(EDIT_LIMITS.title + 1);
    expect(editRefusal(shape(), { action: 'title', title: over }, task)).toEqual({ code: 'invalid', status: 400 });
    expect(editRefusal(shape({ title: 'y'.repeat(EDIT_LIMITS.title + 1) }), { action: 'title', title: over }, task)).toBeNull();
  });
});

describe('notes', () => {
  it('writes them trimmed, or clears them with undefined, which lib/db.ts writes as NULL', () => {
    expect(editPatch(shape(), { action: 'notes', notes: ' Ask about the fee. ' })).toEqual({
      notes: 'Ask about the fee.',
    });
    const cleared = editPatch(shape({ notes: 'Ask.' }), { action: 'notes', notes: null });
    expect(cleared).toEqual({ notes: undefined });
    expect('notes' in cleared).toBe(true);
    expect(editPatch(shape({ notes: 'Ask.' }), { action: 'notes', notes: '  ' })).toEqual({ notes: undefined });
  });

  it('writes nothing when the notes already say it', () => {
    expect(editPatch(shape({ notes: 'Ask.' }), { action: 'notes', notes: 'Ask.\n' })).toEqual({});
    expect(editPatch(shape({ notes: null }), { action: 'notes', notes: null })).toEqual({});
    expect(editPatch(shape({ notes: null }), { action: 'notes', notes: '' })).toEqual({});
  });

  it('clears when the stored notes were not read, rather than calling them empty', () => {
    expect(editPatch(shape({ notes: undefined }), { action: 'notes', notes: null })).toEqual({ notes: undefined });
  });

  it('refuses a type whose schema has no notes', () => {
    expect(editRefusal(shape(), { action: 'notes', notes: 'x' }, noNotes)).toEqual({ code: 'no_notes', status: 400 });
    // Even a clear: the type has nothing to clear.
    expect(editRefusal(shape(), { action: 'notes', notes: null }, noNotes)).toEqual({ code: 'no_notes', status: 400 });
    for (const config of [task, habit, getItemTypeConfig('errand')]) {
      expect(editRefusal(shape(), { action: 'notes', notes: 'x' }, config), config.label).toBeNull();
    }
  });

  it('caps growth after the trim, and lets long notes keep their length', () => {
    const at = 'n'.repeat(EDIT_LIMITS.notes);
    expect(editRefusal(shape(), { action: 'notes', notes: ` ${at}\n` }, task)).toBeNull();
    expect(editRefusal(shape(), { action: 'notes', notes: `${at}n` }, task)).toEqual({ code: 'invalid', status: 400 });
    const long = 'm'.repeat(EDIT_LIMITS.notes + 10_000);
    expect(editRefusal(shape({ notes: long }), { action: 'notes', notes: 'k'.repeat(long.length) }, task)).toBeNull();
    expect(editRefusal(shape({ notes: long }), { action: 'notes', notes: `${long}k` }, task)).toEqual({
      code: 'invalid',
      status: 400,
    });
  });
});

describe('the limits', () => {
  it('lets a request carry more than any cap allows to grow to, so stored text can come back', () => {
    expect(OUTER_LIMITS.title).toBeGreaterThan(EDIT_LIMITS.title);
    expect(OUTER_LIMITS.notes).toBeGreaterThan(EDIT_LIMITS.notes);
  });
});

describe('Add a subtask', () => {
  it('goes under a task or a custom item', () => {
    expect(subtaskRefusal(shape(), task)).toBeNull();
    expect(subtaskRefusal(shape({ type: 'errand' }), getItemTypeConfig('errand'))).toBeNull();
  });

  it('is refused on a habit, which holds no subtasks', () => {
    expect(subtaskRefusal(shape({ type: 'habit' }), habit)).toEqual({ code: 'no_subtasks', status: 400 });
  });

  it('is refused under a subtask, as a 409: one level is all there is', () => {
    expect(subtaskRefusal(shape({ parentItemId: ID }), task)).toEqual({ code: 'nested', status: 409 });
  });

  it('caps new text at 500, the plain cap', () => {
    expect(NEW_TITLE_LIMIT).toBe(500);
  });
});

describe('Reset streak', () => {
  it('is a habit’s, and no task’s', () => {
    expect(resetStreakRefusal(habit)).toBeNull();
    expect(resetStreakRefusal(task)).toEqual({ code: 'no_streak', status: 400 });
    expect(resetStreakRefusal(getItemTypeConfig('errand'))).toEqual({ code: 'no_streak', status: 400 });
  });

  it('writes the counter alone, back to 0', () => {
    expect(resetStreakPatch(shape({ type: 'habit', streak: 41 }))).toEqual({ streak: 0 });
  });

  it('writes nothing at 0, at null, or when the streak was not read', () => {
    expect(resetStreakPatch(shape({ type: 'habit', streak: 0 }))).toEqual({});
    expect(resetStreakPatch(shape({ type: 'habit', streak: null }))).toEqual({});
    expect(resetStreakPatch(shape({ type: 'habit' }))).toEqual({});
  });
});

describe('the shared sentences', () => {
  it('are the web’s words, character for character', () => {
    expect(EDIT_COPY).toEqual({
      resetStreakMessage:
        'This will reset your streak counter to 0 days. Your completion history stays, so days you already checked off remain checked.',
      subtaskPlaceholder: 'Add subtask\u2026',
      subtaskPasteCapped: 'Added the first 500 subtasks. The paste had more.',
    });
  });

  it('say how long a streak runs, as the flame’s tooltip does', () => {
    expect(streakRunText(0)).toBe('No streak yet');
    expect(streakRunText(1)).toBe('1 day in a row');
    expect(streakRunText(2)).toBe('2 days in a row');
  });
});
