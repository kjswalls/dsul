import { describe, expect, it } from 'vitest';
import {
  DRAFT_KEYS,
  habitUpdatesFromDraft,
  taskUpdatesFromDraft,
  type ItemDraft,
} from '@/components/planner/item-dialog';

/**
 * The load-bearing invariant of the non-modal panel
 * (memory/plans/item-surface-growth.md Phase 7): an autosave writes ONLY the
 * fields the user touched in the panel.
 *
 * It matters because the canvas behind the panel stays live. If a commit sent
 * the whole property set — as the modal always did, safely, because it owned
 * the screen — then dragging a block, resizing it, undoing, or an agent write
 * would all be silently reverted by the next keystroke's save.
 */

const draft: ItemDraft = {
  title: '  Write the deck  ',
  notes: '  three slides, no more  ',
  priority: 'high',
  container: 'Work',
  startDate: new Date(2026, 6, 30),
  timeBucket: 'morning',
  startTime: '09:00',
  duration: '45',
  repeatFrequency: 'custom',
  repeatDays: [1, 3],
  repeatMonthDay: 1,
  timesPerDay: '2',
  // Populated on purpose, not to satisfy the type. These are the two draft
  // keys that are NOT columns on the item — they are join rows — so if either
  // ever leaked into an updates payload the panel would try to persist it as a
  // column. The assertions below prove it doesn't.
  routineIds: ['routine-1'],
  goalIds: ['goal-1'],
  seasonIds: ['season-1'],
  newContainer: { show: false, name: '', icon: '' },
};

describe('panel writes are scoped to what was touched', () => {
  it('sends one field when one field changed', () => {
    expect(taskUpdatesFromDraft(draft, ['priority'])).toEqual({ priority: 'high' });
    expect(taskUpdatesFromDraft(draft, ['notes'])).toEqual({ notes: 'three slides, no more' });
    // `project`, not `group` — one CLASSIFY kind since migration 039, and the
    // store speaks in items. `group` survives only in the agent projection.
    expect(habitUpdatesFromDraft(draft, ['container'])).toEqual({ project: 'Work' });
  });

  it('never leaks an untouched field into the payload', () => {
    // The regression this exists for: `duration` here would clobber a resize
    // the user just made on the grid with the panel open.
    for (const key of ['title', 'priority', 'notes', 'container'] as const) {
      expect(Object.keys(taskUpdatesFromDraft(draft, [key]))).toHaveLength(1);
    }
    expect(taskUpdatesFromDraft(draft, ['title'])).not.toHaveProperty('duration');
    expect(taskUpdatesFromDraft(draft, ['title'])).not.toHaveProperty('startTime');
    expect(habitUpdatesFromDraft(draft, ['title'])).not.toHaveProperty('timesPerDay');
  });

  it('never persists membership as a column, not even on a full save', () => {
    // routineIds/seasonIds are join rows written through updateRoutine /
    // updateSeason, so they are deliberately absent from DRAFT_KEYS. If one
    // were ever added there, these builders would start sending it to
    // updateItem, where db.ts's allowlist would silently drop it — a
    // membership edit that looks saved and is gone on reload.
    expect(DRAFT_KEYS).not.toContain('routineIds');
    expect(DRAFT_KEYS).not.toContain('seasonIds');
    // Goals are the same shape of thing — join rows written through updateGoal,
    // never a column on the item — so they stay out for the same reason.
    expect(DRAFT_KEYS).not.toContain('goalIds');
    for (const payload of [
      taskUpdatesFromDraft(draft, DRAFT_KEYS),
      habitUpdatesFromDraft(draft, DRAFT_KEYS),
    ]) {
      expect(payload).not.toHaveProperty('routineIds');
      expect(payload).not.toHaveProperty('goalIds');
      expect(payload).not.toHaveProperty('seasonIds');
    }
  });

  it('treats the three repeat fields as one control', () => {
    expect(taskUpdatesFromDraft(draft, ['repeatDays'])).toEqual({
      repeatFrequency: 'custom',
      repeatDays: [1, 3],
      repeatMonthDay: undefined,
    });
  });

  it('writes nothing when nothing was touched', () => {
    expect(taskUpdatesFromDraft(draft, [])).toEqual({});
    expect(habitUpdatesFromDraft(draft, [])).toEqual({});
    // 'timeBucket' has no direct column on either payload — it is applied by
    // the scheduling second pass, not by these builders.
    expect(taskUpdatesFromDraft(draft, ['timeBucket'])).toEqual({});
  });

  it('still produces the whole-item save the modal has always sent', () => {
    const full = taskUpdatesFromDraft(draft, DRAFT_KEYS);
    expect(full).toEqual({
      title: 'Write the deck',
      notes: 'three slides, no more',
      priority: 'high',
      project: 'Work',
      startDate: '2026-07-30',
      duration: 45,
      startTime: '09:00',
      repeatFrequency: 'custom',
      repeatDays: [1, 3],
      repeatMonthDay: undefined,
    });
  });

  it("maps the draft's UI sentinels to cleared values", () => {
    const blank: ItemDraft = {
      ...draft,
      notes: '   ',
      priority: 'none',
      container: 'none',
      startDate: undefined,
      startTime: '',
      repeatFrequency: 'none',
    };
    expect(taskUpdatesFromDraft(blank, DRAFT_KEYS)).toMatchObject({
      notes: undefined,
      priority: undefined,
      project: undefined,
      startDate: undefined,
      startTime: undefined,
      repeatFrequency: undefined,
    });
  });
});
