import { describe, it, expect } from 'vitest';
import type { ProposalOperation } from '@/lib/planner-types';
import {
  NO_CHANGES,
  addChanges,
  changePhrase,
  hasChanges,
  historySecondLine,
  tallyOperations,
} from '@/lib/conversation-summary';

/**
 * History's second line is DERIVED: four stored counters plus the item as the
 * planner holds it now. These pin the tally (what one accepted proposal adds)
 * and every row of the line's table (D9).
 */

const create = (o: Partial<ProposalOperation> = {}) => ({ kind: 'create', title: 'New', ...o }) as ProposalOperation;
const update = (itemId: string, o: Record<string, unknown> = {}) => ({ kind: 'update', itemId, ...o }) as ProposalOperation;

describe('tallyOperations', () => {
  it('counts a create under a parent as a step, any other create as added', () => {
    expect(tallyOperations([create(), create(), create({ parentItemId: 'p' } as Partial<ProposalOperation>)])).toEqual({
      added: 2,
      steps: 1,
      moved: 0,
      changed: 0,
    });
  });

  it('counts DISTINCT items: an update touching the schedule moved it, any other changed it', () => {
    const t = tallyOperations([
      update('a', { startDate: '2026-10-03' }),
      update('a', { timeBucket: 'evening' }),
      update('b', { startTime: '09:00' }),
      update('c', { title: 'Renamed' }),
      update('c', { priority: 'high' }),
    ]);
    expect(t).toEqual({ added: 0, steps: 0, moved: 2, changed: 1 });
  });

  it('counts an item both moved and changed once, as moved', () => {
    expect(tallyOperations([update('a', { title: 'x' }), update('a', { startDate: '2026-10-04' })])).toEqual({
      added: 0,
      steps: 0,
      moved: 1,
      changed: 0,
    });
  });

  it('holds each counter to what one PATCH may carry', () => {
    const many = Array.from({ length: 30 }, (_, i) => update(`i${i}`, { startDate: '2026-10-05' }));
    expect(tallyOperations(many).moved).toBe(20);
  });

  it('is nothing for nothing', () => {
    expect(tallyOperations([])).toEqual(NO_CHANGES);
    expect(hasChanges(NO_CHANGES)).toBe(false);
    expect(hasChanges(null)).toBe(false);
    expect(hasChanges({ ...NO_CHANGES, steps: 1 })).toBe(true);
  });
});

describe('addChanges', () => {
  it('adds, never below zero, never past the column ceiling', () => {
    expect(addChanges({ added: 1, steps: 0, moved: 2, changed: 0 }, { moved: 3, changed: -4 })).toEqual({
      added: 1,
      steps: 0,
      moved: 5,
      changed: 0,
    });
    expect(addChanges({ ...NO_CHANGES, added: 99_999 }, { added: 20 }).added).toBe(100_000);
  });
});

describe('changePhrase', () => {
  it('joins the non-zero counters in a fixed order, with singular forms', () => {
    expect(changePhrase({ added: 1, steps: 0, moved: 3, changed: 0 })).toBe('Moved 3 items · Added 1 item');
    expect(changePhrase({ added: 0, steps: 1, moved: 0, changed: 1 })).toBe('Added a step · Changed 1 item');
    expect(changePhrase({ added: 0, steps: 4, moved: 1, changed: 2 })).toBe('Moved 1 item · Broke it into 4 steps · Changed 2 items');
    expect(changePhrase(NO_CHANGES)).toBeNull();
  });
});

describe('historySecondLine (D9)', () => {
  const general = (changes = NO_CHANGES) => ({ itemId: null, changes });
  const forItem = (changes = NO_CHANGES) => ({ itemId: 'i1', changes });

  it('item conversation, delegated and blocked: waiting on you', () => {
    expect(historySecondLine(forItem(), { assignee: 'openclaw', aiStatus: 'blocked' })).toBe('With OpenClaw · waiting on you');
  });

  it('item conversation, delegated and queued or working: working on it', () => {
    expect(historySecondLine(forItem(), { assignee: 'openclaw', aiStatus: 'queued' })).toBe('With OpenClaw · working on it');
    expect(historySecondLine(forItem(), { assignee: 'openclaw', aiStatus: 'working' })).toBe('With OpenClaw · working on it');
  });

  it("reads a stored 'beacon' as AI, never by its id", () => {
    expect(historySecondLine(forItem(), { assignee: 'beacon', aiStatus: 'working' })).toBe('With AI · working on it');
  });

  it('item conversation, item live: its changes, or none', () => {
    expect(historySecondLine(forItem({ ...NO_CHANGES, moved: 1 }), {})).toBe('Item conversation · moved 1 item');
    expect(historySecondLine(forItem(), { assignee: 'openclaw', aiStatus: 'done' })).toBe('Item conversation · no changes');
  });

  it('item conversation, item gone', () => {
    expect(historySecondLine(forItem({ ...NO_CHANGES, moved: 1 }), null)).toBe('Item conversation · item deleted');
    expect(historySecondLine(forItem(), undefined)).toBe('Item conversation · item deleted');
  });

  it('general, with changes and without', () => {
    expect(historySecondLine(general({ added: 1, steps: 0, moved: 3, changed: 0 }), null)).toBe('Moved 3 items · Added 1 item');
    expect(historySecondLine(general(), null)).toBe('No changes');
  });
});
