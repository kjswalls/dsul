import { describe, expect, it } from 'vitest';
import { describeOperation, validateProposalOperations, type ProposalContext } from '@/lib/proposal';
import type { Goal, Item, Project, ProposalOperation, Routine, Season } from '@/lib/planner-types';

// Deletes and streak resets on a card (chat step 5d): each alone on its card,
// with its consequence written into the line.

const item = (over: Partial<Item>): Item =>
  ({ type: 'task', status: 'pending', isScheduled: false, order: 0, completedDates: [], ...over }) as unknown as Item;
const habit = (over: Partial<Item>): Item =>
  ({ type: 'habit', status: 'pending', repeatFrequency: 'daily', completedDates: [], skippedDates: [], dailyCounts: {}, streak: 0, ...over }) as unknown as Item;

const ITEMS: Item[] = [
  item({ id: 't1', title: 'Report', project: 'Work', projectId: 'p1' }),
  item({ id: 't2', title: 'Outline', parentItemId: 't1' }),
  item({ id: 't3', title: 'Draft', parentItemId: 't1' }),
  habit({ id: 'h1', title: 'Floss', streak: 40 }),
  habit({ id: 'h2', title: 'Read', streak: 0 }),
];
const containers = {
  projects: [{ id: 'p1', name: 'Work', emoji: '' }] as Project[],
  routines: [{ id: 'r1', name: 'Morning', itemIds: ['h1', 'h2'] }] as Routine[],
  seasons: [{ id: 's1', name: 'Summer', state: 'auto', itemIds: ['t1'], routineIds: [] }] as unknown as Season[],
  goals: [{ id: 'g1', name: 'Calm', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [] }] as unknown as Goal[],
};
const ctx = (over: Partial<ProposalContext> = {}): ProposalContext => ({ items: ITEMS, customTypeNames: [], containers, ...over });
const check = (ops: ProposalOperation[], c = ctx()) => validateProposalOperations(ops, c);
const reason = (op: ProposalOperation, c = ctx()) => check([op], c).rejected[0]?.reason;
const line = (op: ProposalOperation) => describeOperation(op, ctx());

describe('deletes and streak resets', () => {
  it('stand alone on a card', () => {
    expect(check([{ kind: 'delete', what: 'item', id: 't1' }]).accepted).toHaveLength(1);
    const mixed = check([
      { kind: 'delete', what: 'item', id: 't1' },
      { kind: 'update', itemId: 'h1', title: 'Floss nightly' },
    ]);
    expect(mixed.accepted).toEqual([{ kind: 'update', itemId: 'h1', title: 'Floss nightly' }]);
    expect(mixed.rejected[0].reason).toBe('a delete goes on a card of its own');
    // Two at once is one tap among others too.
    const two = check([
      { kind: 'resetStreak', itemId: 'h1' },
      { kind: 'delete', what: 'routine', id: 'r1' },
    ]);
    expect(two.accepted).toEqual([]);
    expect(two.rejected.map((r) => r.reason)).toEqual(['a streak reset goes on a card of its own', 'a delete goes on a card of its own']);
  });

  it('still goes when the change beside it was refused anyway', () => {
    const r = check([
      { kind: 'delete', what: 'item', id: 't1' },
      { kind: 'update', itemId: 'ghost', title: 'x' },
    ]);
    expect(r.accepted).toEqual([{ kind: 'delete', what: 'item', id: 't1' }]);
  });

  it('refuses what is not there, a step, and a streak that is already 0 or hidden', () => {
    expect(reason({ kind: 'delete', what: 'item', id: 'ghost' })).toBe('item no longer exists');
    expect(reason({ kind: 'delete', what: 'item', id: 't2' })).toBe('a step is deleted inside its task');
    expect(reason({ kind: 'delete', what: 'season', id: 'nope' })).toBe('no season has that id');
    expect(reason({ kind: 'delete', what: 'goal', id: 'g1' }, ctx({ containers: { ...containers, goalsEnabled: false } }))).toBe(
      'goals are turned off in Settings'
    );
    expect(reason({ kind: 'resetStreak', itemId: 't1' })).toBe('only a habit keeps a streak');
    expect(reason({ kind: 'resetStreak', itemId: 'h2' })).toBe('its streak is already 0');
    expect(reason({ kind: 'resetStreak', itemId: 'h1' }, ctx({ streaksEnabled: false }))).toBe('streaks are turned off in Settings');
  });

  it('spell out what goes and what stays', () => {
    expect(line({ kind: 'delete', what: 'item', id: 't1' })).toBe('Delete "Report" and its 2 steps. It goes to the trash for 30 days.');
    expect(line({ kind: 'delete', what: 'item', id: 'h1' })).toBe(
      'Delete the habit "Floss", its 40-day streak and its history. It goes to the trash for 30 days.'
    );
    expect(line({ kind: 'delete', what: 'project', id: 'p1' })).toBe(
      'Delete the project "Work". Its 1 item stays, in no project. It goes to the trash for 30 days.'
    );
    expect(line({ kind: 'delete', what: 'routine', id: 'r1' })).toBe(
      'Delete the routine "Morning". Its 2 items stay, no longer paused together. It goes to the trash for 30 days.'
    );
    expect(line({ kind: 'delete', what: 'goal', id: 'g1' })).toBe('Delete the goal "Calm". It goes to the trash for 30 days.');
    expect(line({ kind: 'resetStreak', itemId: 'h1' })).toBe(
      'Reset the streak on "Floss" from 40 days to 0. Its history stays: days already ticked stay ticked.'
    );
  });
});
