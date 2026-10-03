import { describe, expect, it } from 'vitest';
import {
  EDIT_COPY,
  EDIT_LIMITS,
  NEW_TITLE_LIMIT,
  OUTER_LIMITS,
  TIMES_PER_DAY_MAX,
  cleanNotes,
  editPatch,
  editRefusal,
  editShapeFromRow,
  reminderPatch,
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
 * no shipped type reaches (a type without notes, a type that can't be
 * reminded).
 */

const ID = '0b7e4a52-9c1d-4f3e-8a2b-5d6c7e8f9a0b';
const task = getItemTypeConfig('task');
const habit = getItemTypeConfig('habit');
const errand = getItemTypeConfig('errand');
/** A type whose schema has no notes: none ships, but the gate is the schema's. */
const noNotes: ItemTypeConfig = { ...task, fields: task.fields.filter((f) => f !== 'notes') };
/** A type that can't be reminded: none ships, but the gate is the capability's. */
const unremindable: ItemTypeConfig = { ...task, remindable: false };
const INVALID = { code: 'invalid', status: 400 };

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

  it('carries the chips’ columns when they were read, null included, and leaves the rest absent', () => {
    expect(
      editShapeFromRow({
        id: ID,
        type: 'habit',
        parent_item_id: null,
        priority: null,
        times_per_day: 3,
        reminder_time: '08:00',
        reminder_anchor: null,
      }),
    ).toEqual({
      id: ID,
      type: 'habit',
      parentItemId: null,
      priority: null,
      timesPerDay: 3,
      reminderTime: '08:00',
      reminderAnchor: null,
    });
    const unread = editShapeFromRow({ id: ID, type: 'task', parent_item_id: null });
    for (const key of ['priority', 'timesPerDay', 'reminderTime', 'reminderAnchor']) {
      expect(key in unread, key).toBe(false);
    }
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

describe('reminderPatch', () => {
  it('always names both columns, so lib/db.ts writes both', () => {
    for (const [time, anchor] of [
      ['08:00', 'I pour my coffee'],
      ['08:00', null],
      [null, 'I pour my coffee'],
      [undefined, undefined],
    ] as const) {
      expect(Object.keys(reminderPatch(time, anchor)).sort()).toEqual(['reminderAnchor', 'reminderTime']);
    }
  });

  it('turns it on with the cue words trimmed, and blank words are none', () => {
    expect(reminderPatch('08:00', '  I pour my coffee ')).toEqual({
      reminderTime: '08:00',
      reminderAnchor: 'I pour my coffee',
    });
    for (const blank of ['', '  \n', null, undefined]) {
      expect(reminderPatch('08:00', blank)).toEqual({ reminderTime: '08:00', reminderAnchor: undefined });
    }
  });

  it('turns it off with no time, and clears the words whatever they say', () => {
    for (const none of ['', null, undefined]) {
      const patch = reminderPatch(none, 'I pour my coffee');
      expect(patch.reminderTime).toBeUndefined();
      expect(patch.reminderAnchor).toBeUndefined();
    }
    // A draft with no reminder fields at all (item-panel-writes.test.ts saves one).
    expect(() => reminderPatch(undefined, undefined)).not.toThrow();
  });
});

describe('priority', () => {
  it('writes the value, and clears it with undefined, which lib/db.ts writes as NULL', () => {
    expect(editRefusal(shape({ priority: null }), { action: 'priority', priority: 'high' }, task)).toBeNull();
    expect(editPatch(shape({ priority: null }), { action: 'priority', priority: 'high' })).toEqual({ priority: 'high' });
    const cleared = editPatch(shape({ priority: 'high' }), { action: 'priority', priority: null });
    expect(cleared).toEqual({ priority: undefined });
    expect('priority' in cleared).toBe(true);
  });

  it('writes nothing when the row already says it', () => {
    expect(editPatch(shape({ priority: 'medium' }), { action: 'priority', priority: 'medium' })).toEqual({});
    expect(editPatch(shape({ priority: null }), { action: 'priority', priority: null })).toEqual({});
  });

  it('writes when the stored priority was not read, rather than guessing it', () => {
    expect(editPatch(shape(), { action: 'priority', priority: 'medium' })).toEqual({ priority: 'medium' });
    expect(editPatch(shape(), { action: 'priority', priority: null })).toEqual({ priority: undefined });
  });

  it('is refused on a habit, whose schema has none, and taken on a subtask and a custom item', () => {
    expect(editRefusal(shape({ type: 'habit' }), { action: 'priority', priority: 'high' }, habit)).toEqual({
      code: 'no_priority',
      status: 400,
    });
    // Even a clear: the type has nothing to clear.
    expect(editRefusal(shape({ type: 'habit' }), { action: 'priority', priority: null }, habit)).toEqual({
      code: 'no_priority',
      status: 400,
    });
    expect(editRefusal(shape({ parentItemId: ID }), { action: 'priority', priority: 'low' }, task)).toBeNull();
    expect(editRefusal(shape({ type: 'errand' }), { action: 'priority', priority: 'low' }, errand)).toBeNull();
  });
});

describe('times per day', () => {
  const water = (timesPerDay: number | null | undefined) => shape({ type: 'habit', timesPerDay });

  it('writes the count', () => {
    expect(editRefusal(water(3), { action: 'timesPerDay', timesPerDay: 5 }, habit)).toBeNull();
    expect(editPatch(water(3), { action: 'timesPerDay', timesPerDay: 5 })).toEqual({ timesPerDay: 5 });
    // Back to once a day is a 1, never a clear.
    expect(editPatch(water(3), { action: 'timesPerDay', timesPerDay: 1 })).toEqual({ timesPerDay: 1 });
  });

  it('writes nothing for the same count, or for 1 on a habit with none, which counts once', () => {
    expect(editPatch(water(3), { action: 'timesPerDay', timesPerDay: 3 })).toEqual({});
    expect(editPatch(water(null), { action: 'timesPerDay', timesPerDay: 1 })).toEqual({});
  });

  it('writes when the stored count was not read', () => {
    expect(editPatch(water(undefined), { action: 'timesPerDay', timesPerDay: 1 })).toEqual({ timesPerDay: 1 });
  });

  it('is refused on a task and a custom item, which count nothing', () => {
    for (const [type, config] of [
      ['task', task],
      ['errand', errand],
    ] as const) {
      expect(editRefusal(shape({ type }), { action: 'timesPerDay', timesPerDay: 2 }, config), type).toEqual({
        code: 'no_count',
        status: 400,
      });
    }
    expect(editRefusal(water(null), { action: 'timesPerDay', timesPerDay: 2 }, habit)).toBeNull();
  });
});

describe('reminder', () => {
  const meds = (over: Partial<EditShape> = {}) =>
    shape({ type: 'habit', reminderTime: '08:00', reminderAnchor: 'I pour my coffee', ...over });

  it('keeps the stored words, trimmed, on a time sent alone', () => {
    expect(editPatch(meds(), { action: 'reminder', time: '07:30' })).toEqual({
      reminderTime: '07:30',
      reminderAnchor: 'I pour my coffee',
    });
    expect(editPatch(meds({ reminderAnchor: '  I pour my coffee ' }), { action: 'reminder', time: '07:30' })).toEqual({
      reminderTime: '07:30',
      reminderAnchor: 'I pour my coffee',
    });
  });

  it('trims new words, and clears them for null or blank', () => {
    expect(editPatch(meds(), { action: 'reminder', time: '08:00', anchor: '  I fill the kettle ' })).toEqual({
      reminderTime: '08:00',
      reminderAnchor: 'I fill the kettle',
    });
    for (const anchor of [null, '', '  ']) {
      const patch = editPatch(meds(), { action: 'reminder', time: '08:00', anchor });
      expect(patch, String(anchor)).toEqual({ reminderTime: '08:00', reminderAnchor: undefined });
      expect('reminderAnchor' in patch).toBe(true);
    }
  });

  it('clears both columns with no time', () => {
    const off = editPatch(meds(), { action: 'reminder', time: null });
    expect(off).toEqual({ reminderTime: undefined, reminderAnchor: undefined });
    expect(Object.keys(off).sort()).toEqual(['reminderAnchor', 'reminderTime']);
  });

  it('writes nothing when both columns already say it', () => {
    expect(editPatch(meds(), { action: 'reminder', time: '08:00', anchor: 'I pour my coffee' })).toEqual({});
    expect(editPatch(meds(), { action: 'reminder', time: '08:00' })).toEqual({});
    expect(editPatch(meds(), { action: 'reminder', time: '08:00', anchor: ' I pour my coffee ' })).toEqual({});
    expect(
      editPatch(meds({ reminderTime: null, reminderAnchor: null }), { action: 'reminder', time: null }),
    ).toEqual({});
  });

  it('writes the time alone when the stored words were not read, rather than clearing them', () => {
    expect(editPatch(meds({ reminderAnchor: undefined }), { action: 'reminder', time: '07:30' })).toEqual({
      reminderTime: '07:30',
    });
  });

  it('writes when the stored time was not read, even with the words matching', () => {
    expect(
      editPatch(meds({ reminderTime: undefined }), { action: 'reminder', time: '08:00', anchor: 'I pour my coffee' }),
    ).toEqual({ reminderTime: '08:00', reminderAnchor: 'I pour my coffee' });
  });

  it('writes when the stored words were not read, even with the time matching', () => {
    expect(
      editPatch(meds({ reminderAnchor: undefined }), { action: 'reminder', time: '08:00', anchor: null }),
    ).toEqual({ reminderTime: '08:00', reminderAnchor: undefined });
    const off = editPatch(meds({ reminderTime: null, reminderAnchor: undefined }), { action: 'reminder', time: null });
    expect(off).toEqual({ reminderTime: undefined, reminderAnchor: undefined });
    expect(Object.keys(off).sort()).toEqual(['reminderAnchor', 'reminderTime']);
  });

  it('is taken on a task, a habit and a custom item', () => {
    expect(editRefusal(shape(), { action: 'reminder', time: '08:00' }, task)).toBeNull();
    expect(editRefusal(meds(), { action: 'reminder', time: null }, habit)).toBeNull();
    expect(editRefusal(shape({ type: 'errand' }), { action: 'reminder', time: '08:00' }, errand)).toBeNull();
  });

  it('is refused on a subtask, and on a type that cannot be reminded', () => {
    const notRemindable = { code: 'not_remindable', status: 400 };
    expect(editRefusal(shape({ parentItemId: ID }), { action: 'reminder', time: '08:00' }, task)).toEqual(notRemindable);
    // Even off: a subtask has no reminder to turn off.
    expect(editRefusal(shape({ parentItemId: ID }), { action: 'reminder', time: null }, task)).toEqual(notRemindable);
    expect(editRefusal(shape(), { action: 'reminder', time: '08:00' }, unremindable)).toEqual(notRemindable);
  });

  it('caps the words’ growth after the trim, and lets long words keep their length', () => {
    const at = 'w'.repeat(EDIT_LIMITS.anchor);
    expect(editRefusal(meds(), { action: 'reminder', time: '08:00', anchor: ` ${at} ` }, habit)).toBeNull();
    expect(editRefusal(meds(), { action: 'reminder', time: '08:00', anchor: `${at}w` }, habit)).toEqual(INVALID);
    const long = 'a'.repeat(700);
    expect(
      editRefusal(meds({ reminderAnchor: long }), { action: 'reminder', time: '08:00', anchor: 'b'.repeat(650) }, habit),
    ).toBeNull();
    expect(
      editRefusal(meds({ reminderAnchor: long }), { action: 'reminder', time: '08:00', anchor: 'b'.repeat(701) }, habit),
    ).toEqual(INVALID);
    // A time sent alone carries no words to cap, and a clear none to grow.
    expect(editRefusal(meds({ reminderAnchor: long }), { action: 'reminder', time: '08:00' }, habit)).toBeNull();
    expect(editRefusal(meds(), { action: 'reminder', time: '08:00', anchor: null }, habit)).toBeNull();
  });
});

describe('the limits', () => {
  it('lets a request carry more than any cap allows to grow to, so stored text can come back', () => {
    expect(OUTER_LIMITS.title).toBeGreaterThan(EDIT_LIMITS.title);
    expect(OUTER_LIMITS.notes).toBeGreaterThan(EDIT_LIMITS.notes);
    expect(EDIT_LIMITS.anchor).toBe(500);
    expect(OUTER_LIMITS.anchor).toBe(10_000);
    expect(OUTER_LIMITS.anchor).toBeGreaterThan(EDIT_LIMITS.anchor);
  });

  it('counts a habit to five times a day at most, the web chip’s list', () => {
    expect(TIMES_PER_DAY_MAX).toBe(5);
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
      reminderAnchorPlaceholder: 'I pour my coffee',
      reminderAnchorHint:
        'Optional, and worth it. Something you already do beats a time. The reminder will say what you write here.',
      reminderNeedsDate:
        'Give this a date and it will fire. Without one there is no day for the reminder to land on.',
    });
  });

  it('have no em dash in them', () => {
    for (const [key, text] of Object.entries(EDIT_COPY)) expect(text, key).not.toContain('\u2014');
  });

  it('say how long a streak runs, as the flame’s tooltip does', () => {
    expect(streakRunText(0)).toBe('No streak yet');
    expect(streakRunText(1)).toBe('1 day in a row');
    expect(streakRunText(2)).toBe('2 days in a row');
  });
});
