import { describe, expect, it } from 'vitest';
import {
  DURATION_LABELS,
  DURATION_ORDER,
  EDIT_COPY,
  EDIT_LIMITS,
  MAX_DURATION_MINUTES,
  NEW_TITLE_LIMIT,
  OUTER_LIMITS,
  TIMES_PER_DAY_MAX,
  UNSCHEDULE_TASK_PATCH,
  cleanNotes,
  durationLabel,
  editPatch,
  editRefusal,
  editShapeFromRow,
  planTimeEdit,
  reminderPatch,
  resetStreakPatch,
  resetStreakRefusal,
  scheduleHabitPatch,
  scheduleTaskPatch,
  streakRunText,
  subtaskRefusal,
  timeEditPatch,
  withinGrowthLimit,
  type EditShape,
  type TimeDraft,
  type TimeLive,
  type TimePlan,
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

  it('carries the Time chip’s six columns when they were read, null included, and leaves them absent otherwise', () => {
    expect(
      editShapeFromRow({
        id: ID,
        type: 'task',
        parent_item_id: null,
        start_date: '2026-10-01',
        time_bucket: 'morning',
        in_project_block: true,
        start_time: '09:00',
        is_scheduled: true,
        duration: 45,
      }),
    ).toEqual({
      id: ID,
      type: 'task',
      parentItemId: null,
      startDate: '2026-10-01',
      timeBucket: 'morning',
      inProjectBlock: true,
      startTime: '09:00',
      isScheduled: true,
      duration: 45,
    });
    const nulls = editShapeFromRow({
      id: ID,
      type: 'task',
      parent_item_id: null,
      start_date: null,
      time_bucket: null,
      in_project_block: null,
      start_time: null,
      is_scheduled: null,
      duration: null,
    });
    for (const key of ['startDate', 'timeBucket', 'inProjectBlock', 'startTime', 'isScheduled', 'duration'] as const) {
      expect(nulls[key], key).toBeNull();
    }
    const unread = editShapeFromRow({ id: ID, type: 'task', parent_item_id: null });
    for (const key of ['startDate', 'timeBucket', 'inProjectBlock', 'startTime', 'isScheduled', 'duration']) {
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

  it('takes a length of up to a day', () => {
    expect(MAX_DURATION_MINUTES).toBe(1440);
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

describe('the store’s schedule patches', () => {
  it('scheduleTaskPatch: scheduled, auto-corrected, out of the block, in the store’s key order', () => {
    const patch = scheduleTaskPatch('morning', '15:00');
    expect(Object.keys(patch)).toEqual([
      'isScheduled',
      'timeBucket',
      'startTime',
      'inProjectBlock',
      'previousStartTime',
      'previousStartDate',
    ]);
    expect(patch).toEqual({
      isScheduled: true,
      timeBucket: 'afternoon',
      startTime: '15:00',
      inProjectBlock: false,
      previousStartTime: undefined,
      previousStartDate: undefined,
    });
    // Present, and undefined: lib/db.ts writes them as NULL.
    expect('previousStartTime' in patch && 'previousStartDate' in patch).toBe(true);
    // Anytime holds no correction, and no time keeps the bucket it was given.
    expect(scheduleTaskPatch('anytime', '15:00').timeBucket).toBe('anytime');
    expect(scheduleTaskPatch('evening').timeBucket).toBe('evening');
    expect('startTime' in scheduleTaskPatch('evening')).toBe(true);
  });

  it('UNSCHEDULE_TASK_PATCH: the four keys, frozen', () => {
    expect(Object.keys(UNSCHEDULE_TASK_PATCH)).toEqual(['isScheduled', 'timeBucket', 'startTime', 'startDate']);
    expect(UNSCHEDULE_TASK_PATCH).toEqual({
      isScheduled: false,
      timeBucket: undefined,
      startTime: undefined,
      startDate: undefined,
    });
    expect(Object.isFrozen(UNSCHEDULE_TASK_PATCH)).toBe(true);
  });

  it('scheduleHabitPatch: the bucket auto-corrected to the time', () => {
    expect(scheduleHabitPatch('evening', '09:00')).toEqual({ timeBucket: 'morning', startTime: '09:00' });
    expect(Object.keys(scheduleHabitPatch('evening'))).toEqual(['timeBucket', 'startTime']);
    expect(scheduleHabitPatch('evening')).toEqual({ timeBucket: 'evening', startTime: undefined });
  });
});

describe('planTimeEdit', () => {
  const DATE = new Date(2026, 9, 1);
  const draft = (over: Partial<TimeDraft> = {}): TimeDraft => ({
    startDate: DATE,
    timeBucket: 'morning',
    startTime: '',
    ...over,
  });
  const taskLive = (over: Partial<TimeLive> = {}): TimeLive => ({ type: 'task', isScheduled: true, ...over });
  const habitLive = (over: Partial<TimeLive> = {}): TimeLive => ({ type: 'habit', ...over });

  // One row per branch of commitEdit's second pass, as it read before the move.
  it.each<[string, TimeLive, TimeDraft, string[], TimePlan]>([
    ['a task with no schedule key', taskLive({ timeBucket: 'morning' }), draft({ timeBucket: 'evening' }), ['duration'], { kind: 'none' }],
    [
      'dated, a new bucket',
      taskLive({ timeBucket: 'morning' }),
      draft({ timeBucket: 'evening', startTime: '19:00' }),
      ['timeBucket', 'startTime'],
      { kind: 'scheduleTask', bucket: 'evening', time: '19:00' },
    ],
    [
      'dated, not scheduled',
      taskLive({ timeBucket: 'morning', isScheduled: false }),
      draft({ startTime: '10:00' }),
      ['startTime'],
      { kind: 'scheduleTask', bucket: 'morning', time: '10:00' },
    ],
    [
      'dated, the same bucket, a new time',
      taskLive({ timeBucket: 'morning', startTime: '09:00' }),
      draft({ startTime: '10:30' }),
      ['startTime'],
      { kind: 'setTime', time: '10:30' },
    ],
    [
      "the same bucket, '' against undefined",
      taskLive({ timeBucket: 'morning' }),
      draft({ startTime: '' }),
      ['startTime'],
      { kind: 'none' },
    ],
    [
      "dated with 'none' against a stored bucket",
      taskLive({ timeBucket: 'morning' }),
      draft({ timeBucket: 'none' }),
      ['timeBucket'],
      { kind: 'scheduleTask', bucket: 'anytime', time: undefined },
    ],
    [
      "dated with 'none' against a stored Anytime, scheduled",
      taskLive({ timeBucket: 'anytime' }),
      draft({ timeBucket: 'none' }),
      ['timeBucket'],
      { kind: 'none' },
    ],
    [
      'undated and scheduled',
      taskLive({ timeBucket: 'morning' }),
      draft({ startDate: undefined }),
      ['startDate'],
      { kind: 'unscheduleTask' },
    ],
    [
      'undated, unscheduled',
      taskLive({ isScheduled: false }),
      draft({ startDate: undefined }),
      ['startDate'],
      { kind: 'none' },
    ],
    ['a custom item takes the task branch', taskLive({ type: 'custom', timeBucket: 'afternoon' }), draft({ timeBucket: 'evening' }), ['timeBucket'], { kind: 'scheduleTask', bucket: 'evening', time: undefined }],
    ['a habit with no schedule key', habitLive({ timeBucket: 'morning' }), draft({ timeBucket: 'evening' }), ['duration'], { kind: 'none' }],
    ['a habit given a date key only', habitLive({ timeBucket: 'morning' }), draft({ timeBucket: 'evening' }), ['startDate'], { kind: 'none' }],
    [
      'a habit, a new bucket',
      habitLive({ timeBucket: 'morning' }),
      draft({ timeBucket: 'evening' }),
      ['timeBucket'],
      { kind: 'scheduleHabit', bucket: 'evening', time: undefined },
    ],
    [
      'a habit, a new time',
      habitLive({ timeBucket: 'morning', startTime: '08:00' }),
      draft({ startTime: '08:30' }),
      ['startTime'],
      { kind: 'scheduleHabit', bucket: 'morning', time: '08:30' },
    ],
    [
      'a habit, the same',
      habitLive({ timeBucket: 'morning', startTime: '08:00' }),
      draft({ startTime: '08:00' }),
      ['startTime'],
      { kind: 'none' },
    ],
    ["a habit, 'none' with a stored bucket", habitLive({ timeBucket: 'evening' }), draft({ timeBucket: 'none' }), ['timeBucket'], { kind: 'clearHabitTime' }],
    ["a habit, 'none' with none", habitLive(), draft({ timeBucket: 'none' }), ['timeBucket'], { kind: 'none' }],
  ])('%s', (_, live, d, keys, plan) => {
    expect(planTimeEdit(live, d, keys)).toEqual(plan);
  });

  it('reads only the truthiness of the date, so a stored string counts as dated', () => {
    expect(planTimeEdit(taskLive({ timeBucket: 'morning' }), draft({ startDate: '2026-10-01', timeBucket: 'evening' }), ['timeBucket'])).toEqual({
      kind: 'scheduleTask',
      bucket: 'evening',
      time: undefined,
    });
  });
});

describe('the Time chip’s lengths', () => {
  it('are the dialog’s, in its order', () => {
    expect(DURATION_ORDER).toEqual(['15', '30', '45', '60', '90', '120']);
    expect(DURATION_LABELS).toEqual({
      '15': '15 min',
      '30': '30 min',
      '45': '45 min',
      '60': '1 hour',
      '90': '1.5 hours',
      '120': '2 hours',
    });
  });

  it('name a preset by its words, from the draft’s string or a number', () => {
    for (const value of DURATION_ORDER) {
      expect(durationLabel(value), value).toBe(DURATION_LABELS[value]);
      expect(durationLabel(Number(value)), value).toBe(DURATION_LABELS[value]);
    }
  });

  it('name any other length "N min", as the chip always has, an empty draft included', () => {
    expect(durationLabel('50')).toBe('50 min');
    expect(durationLabel(75)).toBe('75 min');
    expect(durationLabel('')).toBe(' min');
  });
});

describe('time', () => {
  /** A type whose schema has no length: none ships, but the gate is the schema's. */
  const noDuration: ItemTypeConfig = { ...task, fields: task.fields.filter((f) => f !== 'duration') };
  /** A dated task in the Afternoon, scheduled, no time and no length stored: every time column read. */
  const dated = (over: Partial<EditShape> = {}): EditShape =>
    shape({
      startDate: '2026-10-01',
      timeBucket: 'afternoon',
      inProjectBlock: null,
      startTime: null,
      isScheduled: true,
      duration: null,
      ...over,
    });
  const meds = (over: Partial<EditShape> = {}): EditShape =>
    shape({
      type: 'habit',
      startDate: null,
      timeBucket: 'morning',
      inProjectBlock: null,
      startTime: '08:00',
      isScheduled: null,
      duration: 15,
      ...over,
    });
  const notDated = { code: 'not_dated', status: 409 };
  const notForSubtask = { code: 'not_for_subtask', status: 400 };

  it('is refused under a subtask, before an undated one is', () => {
    expect(editRefusal(dated({ parentItemId: ID }), { action: 'time', duration: 45 }, task)).toEqual(notForSubtask);
    expect(editRefusal(dated({ parentItemId: ID, startDate: null }), { action: 'time', duration: 45 }, task)).toEqual(
      notForSubtask,
    );
  });

  it('is a 409 on a task with no date, and never on a habit, which has none', () => {
    expect(editRefusal(dated({ startDate: null }), { action: 'time', duration: 45 }, task)).toEqual(notDated);
    expect(editRefusal(dated({ startDate: null, type: 'errand' }), { action: 'time', duration: 45 }, errand)).toEqual(
      notDated,
    );
    expect(editRefusal(meds(), { action: 'time', duration: 45 }, habit)).toBeNull();
    expect(editRefusal(dated(), { action: 'time', duration: 45 }, task)).toBeNull();
    expect(editRefusal(dated({ type: 'errand' }), { action: 'time', timeBucket: 'evening' }, errand)).toBeNull();
  });

  it('refuses a length on a type whose schema has none, and only when one is sent', () => {
    expect(editRefusal(dated(), { action: 'time', duration: 45 }, noDuration)).toEqual({ code: 'no_duration', status: 400 });
    expect(editRefusal(dated(), { action: 'time', timeBucket: 'evening' }, noDuration)).toBeNull();
  });

  it('refuses a time that would land beside Anytime or no part of day, and takes it cleared', () => {
    expect(editRefusal(dated({ timeBucket: 'anytime' }), { action: 'time', startTime: '09:00' }, task)).toEqual(INVALID);
    expect(editRefusal(dated({ timeBucket: null }), { action: 'time', startTime: '09:00' }, task)).toEqual(INVALID);
    // Anytime sent while a time is stored and kept.
    expect(editRefusal(dated({ startTime: '15:00' }), { action: 'time', timeBucket: 'anytime' }, task)).toEqual(INVALID);
    expect(editRefusal(meds(), { action: 'time', timeBucket: null }, habit)).toEqual(INVALID);
    // The same, with the time cleared alongside.
    expect(
      editRefusal(dated({ startTime: '15:00' }), { action: 'time', timeBucket: 'anytime', startTime: null }, task),
    ).toBeNull();
    expect(editRefusal(meds(), { action: 'time', timeBucket: null, startTime: null }, habit)).toBeNull();
    // A time under a part of day sent with it, over a stored Anytime.
    expect(
      editRefusal(dated({ timeBucket: 'anytime' }), { action: 'time', timeBucket: 'morning', startTime: '09:00' }, task),
    ).toBeNull();
    // A length alone judges no time.
    expect(editRefusal(dated({ timeBucket: 'anytime' }), { action: 'time', duration: 45 }, task)).toBeNull();
  });

  it('writes nothing for a key sent as the dialog would seed it', () => {
    // No length stored seeds the type's default block, 30.
    expect(timeEditPatch(dated(), { action: 'time', duration: 30 }, task)).toEqual({});
    expect(timeEditPatch(dated(), { action: 'time', timeBucket: 'afternoon' }, task)).toEqual({});
    expect(timeEditPatch(dated({ duration: 45 }), { action: 'time', duration: 45 }, task)).toEqual({});
    expect(timeEditPatch(meds(), { action: 'time', startTime: '08:00', timeBucket: 'morning' }, habit)).toEqual({});
    // A task's null bucket is none, so null over none is already so.
    expect(timeEditPatch(dated({ timeBucket: null }), { action: 'time', timeBucket: null }, task)).toEqual({});
  });

  it('writes a length alone, and never schedules for it', () => {
    expect(timeEditPatch(dated({ isScheduled: false }), { action: 'time', duration: 45 }, task)).toEqual({ duration: 45 });
    expect(timeEditPatch(meds(), { action: 'time', duration: 30 }, habit)).toEqual({ duration: 30 });
  });

  it('writes a new time alone in its part of day, and files one from another there', () => {
    expect(timeEditPatch(dated({ startTime: '13:00' }), { action: 'time', startTime: '15:30' }, task)).toEqual({
      startTime: '15:30',
    });
    expect(timeEditPatch(dated(), { action: 'time', startTime: '09:00' }, task)).toEqual({
      startTime: '09:00',
      timeBucket: 'morning',
    });
    // No specific time.
    const cleared = timeEditPatch(dated({ startTime: '13:00' }), { action: 'time', startTime: null }, task);
    expect(cleared).toEqual({ startTime: undefined });
    expect('startTime' in cleared).toBe(true);
  });

  it('schedules an item that isn’t, and moves a part of day with scheduleTask’s whole write', () => {
    expect(timeEditPatch(dated({ isScheduled: false }), { action: 'time', startTime: '15:30' }, task)).toEqual({
      startTime: '15:30',
      ...scheduleTaskPatch('afternoon', '15:30'),
    });
    // isScheduled NULL reads as not scheduled, as the store's falsy test does.
    expect(timeEditPatch(dated({ isScheduled: null }), { action: 'time', duration: 45 }, task)).toEqual({ duration: 45 });
    expect(timeEditPatch(dated({ isScheduled: null }), { action: 'time', startTime: '15:30' }, task)).toMatchObject({
      isScheduled: true,
    });
    const moved = timeEditPatch(dated({ inProjectBlock: true }), { action: 'time', timeBucket: 'evening' }, task);
    expect(moved).toEqual(scheduleTaskPatch('evening'));
    expect(Object.keys(moved)).toEqual(Object.keys(scheduleTaskPatch('evening')));
  });

  it('reads a task’s null bucket as Anytime: picking it, or none, schedules it there', () => {
    expect(timeEditPatch(dated({ timeBucket: null }), { action: 'time', timeBucket: 'anytime' }, task)).toEqual(
      scheduleTaskPatch('anytime'),
    );
    expect(timeEditPatch(dated({ timeBucket: 'morning' }), { action: 'time', timeBucket: null }, task)).toEqual(
      scheduleTaskPatch('anytime'),
    );
  });

  it('keeps a project block for a new time alone, across parts of day too', () => {
    const block = dated({ timeBucket: 'morning', inProjectBlock: true });
    expect(timeEditPatch(block, { action: 'time', startTime: '09:30' }, task)).toEqual({ startTime: '09:30' });
    const crossed = timeEditPatch(block, { action: 'time', startTime: '15:00' }, task);
    expect(crossed).toEqual({ startTime: '15:00', timeBucket: 'afternoon' });
    expect('inProjectBlock' in crossed).toBe(false);
  });

  it('compares a stored empty time raw, as the dialog does', () => {
    // '' seeds as '', so null ('' in the draft) is already so.
    expect(timeEditPatch(dated({ startTime: '' }), { action: 'time', startTime: null }, task)).toEqual({});
  });

  it('writes a habit’s part of day and time as scheduleHabit does, the time overruling the pick', () => {
    expect(timeEditPatch(meds({ startTime: null }), { action: 'time', timeBucket: 'evening' }, habit)).toEqual(
      scheduleHabitPatch('evening'),
    );
    expect(timeEditPatch(meds({ startTime: '09:00' }), { action: 'time', timeBucket: 'evening' }, habit)).toEqual({
      timeBucket: 'morning',
      startTime: '09:00',
    });
    expect(timeEditPatch(meds(), { action: 'time', startTime: null }, habit)).toEqual({
      startTime: undefined,
      timeBucket: 'morning',
    });
    const cleared = timeEditPatch(meds(), { action: 'time', timeBucket: null, startTime: null }, habit);
    expect(cleared).toEqual({ timeBucket: undefined, startTime: undefined });
    expect(Object.keys(cleared).sort()).toEqual(['startTime', 'timeBucket']);
  });

  it.each(['startTime', 'isScheduled', 'duration', 'startDate', 'timeBucket'] as const)(
    'throws when %s was not read',
    (key) => {
      expect(() => timeEditPatch(dated({ [key]: undefined }), { action: 'time', duration: 45 }, task)).toThrow();
    },
  );

  it('editPatch takes the row’s own type when no config is passed', () => {
    for (const [row, edit] of [
      [dated(), { action: 'time', duration: 30 }],
      [dated({ isScheduled: false }), { action: 'time', startTime: '15:30' }],
      [meds(), { action: 'time', duration: 45 }],
      [dated({ type: 'errand' }), { action: 'time', timeBucket: 'evening' }],
    ] as const) {
      expect(editPatch(row, edit), JSON.stringify(edit)).toEqual(editPatch(row, edit, getItemTypeConfig(row.type)));
    }
    // A config's own default block decides what is already so.
    const fortyFive: ItemTypeConfig = { ...task, schedule: { ...task.schedule, defaultBlockMinutes: 45 } };
    expect(editPatch(dated(), { action: 'time', duration: 30 }, fortyFive)).toEqual({ duration: 30 });
    expect(editPatch(dated(), { action: 'time', duration: 45 }, fortyFive)).toEqual({});
  });
});
