import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateProposalOperations,
  describeOperation,
  type ProposalContext,
} from '@/lib/proposal';
import { hydrateCustomTypes } from '@/lib/item-registry';
import { ProposalCreateOpSchema, ProposalDraftSchema } from '@dsul/types';
import type { Item, ProposalOperation } from '@/lib/planner-types';

/**
 * Breaking a too-big item into steps — the one proposal verb that CREATES
 * structure rather than moving work around.
 *
 * A subtask has no independent presence: nothing outside its parent's detail
 * panel renders one. That single fact drives every rule here — why a
 * grandchild is refused (nothing would show it), why scheduling fields are
 * dropped (they would be written and never read), and why an EXISTING subtask
 * still cannot be the target of an update.
 */

const items: Item[] = [
  {
    type: 'task',
    id: 'parent-1',
    title: 'Write the quarterly report',
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
  },
  {
    type: 'task',
    id: 'child-1',
    parentItemId: 'parent-1',
    title: 'Pull the numbers',
    status: 'pending',
    isScheduled: false,
    order: 1,
    completedDates: [],
  },
  {
    type: 'habit',
    id: 'habit-1',
    title: 'Stretch',
    group: 'Personal',
    streak: 3,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
  },
  {
    type: 'custom',
    customType: 'goal',
    id: 'goal-1',
    title: 'Run a 10k',
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
  },
];

const ctx: ProposalContext = { items, customTypeNames: ['goal'] };

beforeEach(() => {
  hydrateCustomTypes([{ id: 'it-1', name: 'goal', label: 'Goal', labelPlural: 'Goals' }]);
});

const step = (overrides: Partial<ProposalOperation> = {}): ProposalOperation =>
  ({
    kind: 'create',
    itemType: 'task',
    title: 'Draft the outline',
    parentItemId: 'parent-1',
    ...overrides,
  }) as ProposalOperation;

const validate = (...operations: ProposalOperation[]) =>
  validateProposalOperations(operations, ctx);

describe('creating subtasks', () => {
  it('accepts a step under a task', () => {
    const { accepted, rejected } = validate(step());
    expect(rejected).toHaveLength(0);
    expect(accepted[0]).toMatchObject({ parentItemId: 'parent-1', title: 'Draft the outline' });
  });

  it('refuses a parent that has since been deleted', () => {
    const { accepted, rejected } = validate(step({ parentItemId: 'gone' }));
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/no longer exists/);
  });

  it('refuses a habit as a parent, because the registry says so', () => {
    // Not a type check: `subtasks: false` is registry config, and any future
    // type that says the same is excluded by the same line.
    const { accepted, rejected } = validate(step({ parentItemId: 'habit-1' }));
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/cannot have subtasks/);
  });

  it('refuses to nest — a subtask cannot be broken down', () => {
    // One level is all the panel renders, and lib/db.ts refuses a grandchild
    // independently. A second level would be written where nothing shows it.
    const { accepted, rejected } = validate(step({ parentItemId: 'child-1' }));
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/cannot themselves be broken down/);
  });

  it('allows a custom type to be a parent when its config permits it', () => {
    const { accepted, rejected } = validate(step({ parentItemId: 'goal-1' }));
    expect(rejected).toHaveLength(0);
    expect(accepted).toHaveLength(1);
  });

  it('drops scheduling fields rather than the whole step', () => {
    // The subtask is the useful part of the operation. One stray date the model
    // added should cost the date, not the step.
    const { accepted, rejected } = validate(
      step({ startDate: '2026-09-01', startTime: '09:00', timeBucket: 'morning' } as never)
    );
    expect(rejected).toHaveLength(0);
    expect(accepted[0]).not.toHaveProperty('startDate');
    expect(accepted[0]).not.toHaveProperty('startTime');
    expect(accepted[0]).not.toHaveProperty('timeBucket');
  });

  it('keeps notes and priority, which a subtask can actually carry', () => {
    const { accepted } = validate(
      step({ notes: 'ask Dana first', priority: 'high' } as never)
    );
    expect(accepted[0]).toMatchObject({ notes: 'ask Dana first', priority: 'high' });
  });

  it('still refuses habit creation, parent or no parent', () => {
    const { accepted, rejected } = validate(step({ itemType: 'habit' }));
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/cannot create items of type/);
  });

  it('leaves ordinary creates untouched', () => {
    const { accepted, rejected } = validate({
      kind: 'create',
      itemType: 'task',
      title: 'A normal task',
      startDate: '2026-09-01',
    } as ProposalOperation);
    expect(rejected).toHaveLength(0);
    expect(accepted[0]).toMatchObject({ startDate: '2026-09-01' });
  });

  it('still refuses to UPDATE an existing subtask', () => {
    // The rule that predates breakdown, and the reason for all of the above:
    // rescheduling something no view shows is a change with no visible effect
    // and no way to undo it from where the user is looking.
    const { accepted, rejected } = validate({
      kind: 'update',
      itemId: 'child-1',
      startDate: '2026-09-01',
    } as ProposalOperation);
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/managed inside their parent/);
  });

  it('drops only the bad step, keeping the rest of the breakdown', () => {
    const { accepted, rejected } = validate(
      step({ title: 'one' }),
      step({ title: 'two', parentItemId: 'habit-1' }),
      step({ title: 'three' })
    );
    expect(accepted.map((o) => (o as { title: string }).title)).toEqual(['one', 'three']);
    expect(rejected).toHaveLength(1);
  });
});

describe('a blank parent', () => {
  /**
   * `parentItemId: ""` used to slip the whole parent branch — truthiness, not
   * presence. The result was a "step" with a blank parent that rendered as a
   * top-level task (the projection filters on `!parentItemId`), kept the
   * scheduling fields the branch would have stripped, and then failed to
   * persist because Postgres rejects '' as a uuid. It appeared, got an undo
   * entry, and vanished on the next load.
   */
  it('is refused rather than treated as absent', () => {
    const { accepted, rejected } = validate(
      step({ parentItemId: '', startDate: '2026-09-01' } as never)
    );
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/blank/);
  });

  it('is refused when it is only whitespace', () => {
    const { accepted } = validate(step({ parentItemId: '   ' } as never));
    expect(accepted).toHaveLength(0);
  });

  it('is rejected by the schema before it ever reaches the validator', () => {
    expect(
      ProposalCreateOpSchema.safeParse({
        kind: 'create',
        itemType: 'task',
        title: 'Step',
        parentItemId: '',
      }).success
    ).toBe(false);
  });
});

describe('size caps', () => {
  it('refuses a reply with an implausible number of operations', () => {
    // The producer is untrusted by design — on the agent tier it is somebody
    // else's gateway. 5,000 operations rendered six visible lines in a scroll
    // box under a button reading "Do all of it", then fanned out 5,000
    // unthrottled inserts on one tap.
    const many = Array.from({ length: 5000 }, () => ({
      kind: 'create',
      itemType: 'task',
      title: 'spam',
    }));
    expect(
      ProposalDraftSchema.safeParse({ summary: 'x', operations: many }).success
    ).toBe(false);
  });

  it('still accepts a plausible plan', () => {
    const some = Array.from({ length: 8 }, () => ({
      kind: 'create',
      itemType: 'task',
      title: 'a real step',
    }));
    expect(ProposalDraftSchema.safeParse({ summary: 'x', operations: some }).success).toBe(true);
  });

  it('refuses unbounded strings', () => {
    const huge = 'x'.repeat(100_000);
    expect(
      ProposalDraftSchema.safeParse({
        summary: 'x',
        operations: [{ kind: 'create', itemType: 'task', title: huge }],
      }).success
    ).toBe(false);
    expect(
      ProposalDraftSchema.safeParse({
        summary: huge,
        operations: [{ kind: 'create', itemType: 'task', title: 'ok' }],
      }).success
    ).toBe(false);
  });
});

describe('describing a step', () => {
  it('names the parent, so a breakdown line says what it is a step of', () => {
    expect(describeOperation(step(), ctx)).toBe(
      'Draft the outline (under Write the quarterly report)'
    );
  });

  it('degrades without inventing a parent it cannot find', () => {
    expect(describeOperation(step({ parentItemId: 'gone' }), ctx)).toBe('Step: Draft the outline');
  });

  it('leaves an ordinary create reading as it always did', () => {
    const line = describeOperation(
      { kind: 'create', itemType: 'task', title: 'A normal task' } as ProposalOperation,
      ctx
    );
    expect(line).toBe('New task: A normal task');
  });
});
