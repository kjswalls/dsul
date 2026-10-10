import { describe, it, expect, beforeEach } from 'vitest';
import { format, subDays } from 'date-fns';
import {
  validateProposalOperations,
  validateProposal,
  describeOperation,
  buildCatchUpProposal,
  buildProposalContext,
  MAX_CATCH_UP_OPERATIONS,
  type ProposalContext,
} from '@/lib/proposal';
import { hydrateCustomTypes } from '@/lib/item-registry';
import type { Item, Proposal, ProposalOperation } from '@/lib/planner-types';

/**
 * Proposals come from a model, so nothing they contain is trusted. These tests
 * pin the registry-derived rules that stop a hallucinated field from reaching a
 * row: per-type status vocabularies (frozen external contracts), date-anchoring,
 * and which types may be created at all.
 */

const items: Item[] = [
  {
    type: 'task',
    id: 'task-1',
    title: 'Email Dana',
    status: 'pending',
    isScheduled: false,
    order: 0,
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
  hydrateCustomTypes([
    { id: 'it-1', name: 'goal', label: 'Goal', labelPlural: 'Goals' },
  ]);
});

const validate = (...operations: ProposalOperation[]) =>
  validateProposalOperations(operations, ctx);

describe('validateProposalOperations — creates', () => {
  it('accepts a task create', () => {
    const { accepted, rejected } = validate({
      kind: 'create',
      itemType: 'task',
      title: 'Book dentist',
      startDate: '2026-08-06',
    });
    expect(rejected).toHaveLength(0);
    expect(accepted).toHaveLength(1);
  });

  it('accepts a create for a hydrated custom type', () => {
    const { accepted } = validate({ kind: 'create', itemType: 'goal', title: 'Learn Rust' });
    expect(accepted).toHaveLength(1);
  });

  it('rejects a type that does not exist', () => {
    const { accepted, rejected } = validate({
      kind: 'create',
      itemType: 'sprocket',
      title: 'Nope',
    });
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/cannot create/);
  });

  it('rejects habit creation — habits require a group the AI cannot pick', () => {
    const { accepted, rejected } = validate({
      kind: 'create',
      itemType: 'habit',
      title: 'Meditate daily',
    });
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });
});

describe('validateProposalOperations — updates', () => {
  it('accepts a reschedule of an existing task', () => {
    const { accepted } = validate({
      kind: 'update',
      itemId: 'task-1',
      startDate: '2026-08-06',
      timeBucket: 'morning',
    });
    expect(accepted).toEqual([
      { kind: 'update', itemId: 'task-1', startDate: '2026-08-06', timeBucket: 'morning' },
    ]);
  });

  it('drops an update whose item is gone', () => {
    const { accepted, rejected } = validate({ kind: 'update', itemId: 'ghost', title: 'x' });
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/no longer exists/);
  });

  it("rejects a task status from the habit vocabulary", () => {
    // 'done' is a habit word. The vocabularies are frozen and untranslatable.
    const { accepted, rejected } = validate({ kind: 'update', itemId: 'task-1', status: 'done' });
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/not a valid status/);
  });

  it("rejects a habit status from the task vocabulary", () => {
    const { accepted, rejected } = validate({
      kind: 'update',
      itemId: 'habit-1',
      status: 'completed',
    });
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/not a valid status/);
  });

  it('refuses to write scalar status to a recurring item', () => {
    // CLAUDE.md: recurring items track completion per-DATE in completedDates,
    // never via scalar status. A daily chore is `pending` forever by design, so
    // writing 'completed' here would mark the whole series done with no way for
    // the store's patch path to turn it back into one date's toggle.
    const recurring: Item[] = [
      {
        type: 'task',
        id: 'chore',
        title: 'Water plants',
        status: 'pending',
        isScheduled: false,
        order: 0,
        repeatFrequency: 'daily',
        completedDates: [],
      },
    ];
    const { accepted, rejected } = validateProposalOperations(
      [{ kind: 'update', itemId: 'chore', status: 'completed' }],
      { items: recurring, customTypeNames: [] },
    );
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/per-date/);
  });

  it('still lets a recurring item be rescheduled', () => {
    const recurring: Item[] = [
      {
        type: 'task',
        id: 'chore',
        title: 'Water plants',
        status: 'pending',
        isScheduled: false,
        order: 0,
        repeatFrequency: 'daily',
        completedDates: [],
      },
    ];
    const { accepted } = validateProposalOperations(
      [{ kind: 'update', itemId: 'chore', timeBucket: 'evening' }],
      { items: recurring, customTypeNames: [] },
    );
    expect(accepted).toHaveLength(1);
  });

  it('accepts each vocabulary against its own one-shot type', () => {
    expect(validate({ kind: 'update', itemId: 'task-1', status: 'completed' }).accepted).toHaveLength(1);
    expect(validate({ kind: 'update', itemId: 'goal-1', status: 'completed' }).accepted).toHaveLength(1);
  });

  it('never lets a proposal set a habit\'s status at all', () => {
    // A habit is recurring by definition (the registry forbids 'none'), so it
    // is always caught by the per-date rule — 'done' is a valid habit word and
    // still cannot be written as scalar status.
    const { accepted, rejected } = validate({ kind: 'update', itemId: 'habit-1', status: 'done' });
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/per-date/);
  });

  it('strips startDate from a date-blind type instead of rejecting the operation', () => {
    // Habits render on every matching day; a startDate would be silently ignored.
    const { accepted, rejected } = validate({
      kind: 'update',
      itemId: 'habit-1',
      startDate: '2026-08-06',
      timeBucket: 'evening',
    });
    expect(rejected).toHaveLength(0);
    expect(accepted[0]).not.toHaveProperty('startDate');
    expect(accepted[0]).toMatchObject({ timeBucket: 'evening' });
  });

  it('carries field-clears through, alongside ordinary changes', () => {
    // Was "v1 proposals never clear a field". Clearing is locked decision 3's
    // first step and is now implemented — see the Braindump block at the foot
    // of this file for the rules that make it safe. The bucket stays the one
    // field that may not be cleared alone.
    const { accepted } = validate({
      kind: 'update',
      itemId: 'task-1',
      startDate: null,
      priority: null,
      timeBucket: null,
      title: 'Email Dana back',
    });
    expect(accepted[0]).toEqual({
      kind: 'update',
      itemId: 'task-1',
      startDate: null,
      priority: null,
      title: 'Email Dana back',
    });
  });

  it('keeps the good operations when one is bad', () => {
    const { accepted, rejected } = validate(
      { kind: 'update', itemId: 'task-1', startDate: '2026-08-06' },
      { kind: 'update', itemId: 'ghost', title: 'x' },
      { kind: 'create', itemType: 'task', title: 'Fine' },
    );
    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(1);
  });
});

describe('validateProposal', () => {
  it('returns the proposal carrying only viable operations', () => {
    const proposal: Proposal = {
      id: 'p1',
      summary: 'A lighter Tuesday',
      createdAt: '2026-07-31T09:00:00.000Z',
      operations: [
        { kind: 'update', itemId: 'task-1', startDate: '2026-08-06' },
        { kind: 'update', itemId: 'ghost', title: 'x' },
      ],
    };
    const { proposal: cleaned, rejected } = validateProposal(proposal, ctx);
    expect(cleaned.operations).toHaveLength(1);
    expect(cleaned.summary).toBe('A lighter Tuesday');
    expect(rejected).toHaveLength(1);
  });
});

describe('buildCatchUpProposal', () => {
  const TODAY = '2026-07-31';

  /** A pending task anchored `days` before TODAY. */
  const overdueTask = (id: string, days: number): Item => ({
    type: 'task',
    id,
    title: `Task ${id}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
    startDate: format(subDays(new Date(`${TODAY}T00:00:00`), days), 'yyyy-MM-dd'),
    completedDates: [],
  });

  const build = (items: Item[]) =>
    buildCatchUpProposal({ items, customTypeNames: [], todayStr: TODAY, inactiveIds: new Set() });

  it('returns null when nothing is waiting', () => {
    expect(build([items[1]])).toBeNull();
  });

  it('moves recent overdue items to today', () => {
    const draft = build([overdueTask('a', 2), overdueTask('b', 4)]);
    expect(draft?.operations).toEqual([
      { kind: 'update', itemId: 'a', startDate: TODAY },
      { kind: 'update', itemId: 'b', startDate: TODAY },
    ]);
  });

  it('leaves the long-overdue cohort alone — that pile is not today\'s problem', () => {
    // >7 days is the "long" cohort per lib/overdue.ts.
    const draft = build([overdueTask('recent', 3), overdueTask('ancient', 40)]);
    expect(draft?.operations).toHaveLength(1);
    expect(draft?.operations[0]).toMatchObject({ itemId: 'recent' });
  });

  it('caps the card so it never becomes a wall of shame', () => {
    const many = Array.from({ length: 12 }, (_, i) => overdueTask(`t${i}`, 2));
    const draft = build(many);
    expect(draft?.operations).toHaveLength(MAX_CATCH_UP_OPERATIONS);
  });

  it('acknowledges the remainder without scolding', () => {
    const many = Array.from({ length: 8 }, (_, i) => overdueTask(`t${i}`, 2));
    const draft = build(many);
    expect(draft?.rationale).toContain('can keep waiting');
    expect(draft?.rationale).not.toMatch(/overdue|late|behind|should/i);
  });

  it('says so plainly when nothing else is outstanding', () => {
    const draft = build([overdueTask('only', 1)]);
    expect(draft?.summary).toBe('Pick one thing back up');
    expect(draft?.rationale).toContain('Nothing else is waiting');
  });

  it('produces operations that survive validation', () => {
    const list = [overdueTask('a', 2)];
    const draft = build(list)!;
    const { accepted, rejected } = validateProposalOperations(draft.operations, {
      items: list,
      customTypeNames: [],
    });
    expect(rejected).toHaveLength(0);
    expect(accepted).toHaveLength(1);
  });
});

describe('buildProposalContext', () => {
  it('lists open items with copyable ids', () => {
    const text = buildProposalContext({ ...ctx, todayStr: '2026-07-31' });
    expect(text).toContain('[task-1] Email Dana');
    expect(text).toContain('[habit-1] Stretch');
    expect(text).toContain('[goal-1] Run a 10k');
  });

  it("omits items that are finished in their own type's vocabulary", () => {
    const done: Item[] = [
      { ...(items[0] as Extract<Item, { type: 'task' }>), status: 'completed' },
      { ...(items[1] as Extract<Item, { type: 'habit' }>), status: 'done' },
    ];
    const text = buildProposalContext({ items: done, customTypeNames: [], todayStr: '2026-07-31' });
    expect(text).not.toContain('task-1');
    expect(text).not.toContain('habit-1');
    expect(text).toContain('nothing open');
  });

  it('shows a clock time and its length, so a plan can see what is booked', () => {
    const timed: Item[] = [
      { type: 'task', id: 'a', title: 'Dentist', status: 'pending', isScheduled: true, order: 0, completedDates: [], startDate: '2026-08-04', startTime: '14:00', duration: 60 },
      { type: 'task', id: 'b', title: 'Call', status: 'pending', isScheduled: true, order: 1, completedDates: [], startDate: '2026-08-04', startTime: '09:30' },
      // A task in a project block is drawn at the block's time, not its own.
      { type: 'task', id: 'c', title: 'Inbox', status: 'pending', isScheduled: true, order: 2, completedDates: [], startDate: '2026-08-04', startTime: '11:00', inProjectBlock: true },
    ] as Item[];
    const text = buildProposalContext({ items: timed, customTypeNames: [], todayStr: '2026-07-31' });
    expect(text).toContain('[a] Dentist — task, 2026-08-04, at 14:00 for 60 min');
    expect(text).toContain('[b] Call — task, 2026-08-04, at 09:30');
    expect(text).not.toContain('at 11:00');
  });

  it('bounds the list so the prompt cannot grow without limit', () => {
    const many: Item[] = Array.from({ length: 200 }, (_, i) => ({
      type: 'task',
      id: `t${i}`,
      title: `Task ${i}`,
      status: 'pending',
      isScheduled: false,
      order: i,
      completedDates: [],
    }));
    const text = buildProposalContext(
      { items: many, customTypeNames: [], todayStr: '2026-07-31' },
      10,
    );
    expect(text.split('\n')).toHaveLength(11); // heading + 10
  });
});

describe('describeOperation', () => {
  it('describes a create with its friendly date', () => {
    expect(
      describeOperation(
        { kind: 'create', itemType: 'task', title: 'Book dentist', startDate: '2026-08-06' },
        ctx,
      ),
    ).toBe('New task: Book dentist for Thu Aug 6');
  });

  it('names the custom type from the registry', () => {
    expect(
      describeOperation({ kind: 'create', itemType: 'goal', title: 'Learn Rust' }, ctx),
    ).toBe('New goal: Learn Rust');
  });

  it('describes a reschedule in terms of where it lands', () => {
    expect(
      describeOperation({ kind: 'update', itemId: 'task-1', startDate: '2026-08-06' }, ctx),
    ).toBe('Email Dana: move to Thu Aug 6');
  });

  it("uses each type's own done-word", () => {
    expect(describeOperation({ kind: 'update', itemId: 'task-1', status: 'completed' }, ctx)).toBe(
      'Email Dana: mark done',
    );
    expect(describeOperation({ kind: 'update', itemId: 'habit-1', status: 'done' }, ctx)).toBe(
      'Stretch: mark done',
    );
    // Not the done-status: named explicitly rather than mislabelled "done".
    expect(describeOperation({ kind: 'update', itemId: 'task-1', status: 'cancelled' }, ctx)).toBe(
      'Email Dana: mark cancelled',
    );
  });

  it('falls back to the title when an update changes nothing describable', () => {
    expect(describeOperation({ kind: 'update', itemId: 'task-1' }, ctx)).toBe('Email Dana');
  });

  it('leaves an unparseable date alone rather than rendering Invalid Date', () => {
    expect(
      describeOperation({ kind: 'update', itemId: 'task-1', startDate: 'someday' }, ctx),
    ).toBe('Email Dana: move to someday');
  });
});

describe('clearing a field — "put it back in the Braindump"', () => {
  /**
   * Locked decision 3's first step, and the reason it waited: clearing a date
   * is not a null write, it is the UNSCHEDULE verb. `unscheduleTask` drops
   * startTime, timeBucket and isScheduled with it, and a generic patch that
   * wrote only the date would leave an item scheduled, bucketed, and on no day
   * — placeable on no surface and reachable from nowhere.
   */
  const scheduled: Item = {
    type: 'task',
    id: 'sched-1',
    title: 'Email Dana',
    status: 'pending',
    isScheduled: true,
    order: 0,
    completedDates: [],
    startDate: '2026-08-20',
    startTime: '09:00',
    timeBucket: 'morning',
    priority: 'high',
  } as Item;

  const repeating: Item = {
    ...(scheduled as Record<string, unknown>),
    id: 'repeat-1',
    repeatFrequency: 'daily',
  } as Item;

  const localCtx: ProposalContext = {
    items: [...items, scheduled, repeating],
    customTypeNames: ['goal'],
  };
  const check = (op: ProposalOperation) => validateProposalOperations([op], localCtx);

  it('accepts a cleared date on an item that can live undated', () => {
    const { accepted, rejected } = check({
      kind: 'update',
      itemId: 'sched-1',
      startDate: null,
    } as ProposalOperation);
    expect(rejected).toHaveLength(0);
    expect(accepted[0]).toMatchObject({ startDate: null });
  });

  it('refuses it for a repeating item, which would then land on no day at all', () => {
    // Every day-scoped surface requires `startDate <= today` before recurrence
    // is consulted. The row's own control does not guard this, but a suggestion
    // accepted sight-unseen should not be how the user finds out.
    const { accepted, rejected } = check({
      kind: 'update',
      itemId: 'repeat-1',
      startDate: null,
    } as ProposalOperation);
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/repeating/i);
  });

  it('refuses it for a type that cannot go to the Braindump', () => {
    // Registry-derived: `braindumpEligible` IS the question "can this item
    // exist with no date".
    const { accepted, rejected } = check({
      kind: 'update',
      itemId: 'habit-1',
      startDate: null,
    } as ProposalOperation);
    expect(accepted).toHaveLength(0);
    expect(rejected.length + accepted.length).toBe(1);
  });

  it('accepts the simple clears, which have no companions', () => {
    expect(
      check({ kind: 'update', itemId: 'sched-1', startTime: null } as ProposalOperation)
        .accepted[0]
    ).toMatchObject({ startTime: null });
    expect(
      check({ kind: 'update', itemId: 'sched-1', priority: null } as ProposalOperation)
        .accepted[0]
    ).toMatchObject({ priority: null });
  });

  it('drops a bucket clear rather than producing an unplaceable row', () => {
    // An item with a date and no bucket is exactly the row nothing can draw.
    // "Clear the bucket" is also not a request anyone makes — unscheduling is.
    const { accepted, rejected } = check({
      kind: 'update',
      itemId: 'sched-1',
      timeBucket: null,
    } as ProposalOperation);
    expect(rejected).toHaveLength(0);
    expect(accepted[0]).not.toHaveProperty('timeBucket');
  });

  it('refuses to erase a goal milestone target date', () => {
    /**
     * The rule three other bulk date verbs already guard (`unscheduleTasks`,
     * `moveTasksToDate`, `scheduleItemsAt`) and CLAUDE.md names by hand: for a
     * milestone, `startDate` is not stale scheduling residue, it is the target
     * date. Nothing in the card would have said so either — the model is shown
     * no goal membership, so the line reads like any other row.
     */
    const { accepted, rejected } = validateProposalOperations(
      [{ kind: 'update', itemId: 'sched-1', startDate: null } as ProposalOperation],
      { ...localCtx, milestoneIds: new Set(['sched-1']) }
    );
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/milestone/i);
  });

  it('still lets a milestone be MOVED, which is what re-dating a target is', () => {
    const { accepted, rejected } = validateProposalOperations(
      [{ kind: 'update', itemId: 'sched-1', startDate: '2026-10-01' } as ProposalOperation],
      { ...localCtx, milestoneIds: new Set(['sched-1']) }
    );
    expect(rejected).toHaveLength(0);
    expect(accepted[0]).toMatchObject({ startDate: '2026-10-01' });
  });

  it('reads as Braindump on the card, not as a null', () => {
    expect(
      describeOperation(
        { kind: 'update', itemId: 'sched-1', startDate: null } as ProposalOperation,
        localCtx
      )
    ).toContain('Braindump');
  });
});

describe('what the model is shown', () => {
  it('marks repeating items, since a prompt rule now depends on it', () => {
    // "Not available for repeating items" is unfollowable if a recurring task
    // is byte-identical to a one-shot in the context — and the refusal that
    // catches it is silent.
    const repeating = {
      type: 'task',
      id: 'r1',
      title: 'Water the plants',
      status: 'pending',
      isScheduled: false,
      order: 0,
      completedDates: [],
      startDate: '2026-08-01',
      repeatFrequency: 'daily',
    } as Item;
    const context = buildProposalContext(
      { items: [repeating], customTypeNames: [], todayStr: '2026-08-26' },
    );
    expect(context).toContain('repeats');
  });

  it('leaves a one-shot unmarked', () => {
    const oneShot = items.filter((i) => i.type === 'task');
    const context = buildProposalContext(
      { items: oneShot, customTypeNames: [], todayStr: '2026-08-26' },
    );
    expect(context).not.toContain('repeats');
  });

  it('marks a habit, which repeats by construction', () => {
    // Habits cannot go to the Braindump anyway (braindumpEligible: false), but
    // the marker is a property of the item, not of one rule that reads it.
    const habits = items.filter((i) => i.type === 'habit');
    expect(
      buildProposalContext({ items: habits, customTypeNames: [], todayStr: '2026-08-26' })
    ).toContain('repeats');
  });
});

describe('verb operations (tick, skip, pause)', () => {
  const day = { ...ctx, todayStr: '2026-08-26', tz: 'UTC' };
  const verb = (v: 'complete' | 'skip' | 'unskip' | 'pause' | 'resume', itemId: string, date?: string): ProposalOperation => ({
    kind: 'verb',
    verb: v,
    itemId,
    ...(date ? { date } : {}),
  });
  const reasons = (op: ProposalOperation, c: ProposalContext = day) =>
    validateProposalOperations([op], c).rejected.map((r) => r.reason);

  it('ticks, skips and pauses a habit today', () => {
    for (const v of ['complete', 'skip', 'pause'] as const) expect(reasons(verb(v, 'habit-1')), v).toEqual([]);
  });

  it('never ticks a day still to come, but skips one', () => {
    expect(reasons(verb('complete', 'habit-1', '2026-08-27'))).toEqual(['a day that has not come yet cannot be marked done']);
    expect(reasons(verb('skip', 'habit-1', '2026-08-27'))).toEqual([]);
  });

  it('asks the gates: no resume for what is not paused, no unskip for what is not skipped', () => {
    expect(reasons(verb('resume', 'habit-1'))).toEqual(['it cannot be resumed now']);
    expect(reasons(verb('unskip', 'habit-1'))).toEqual(['it cannot be unskipped on 2026-08-26']);
  });

  it('refuses a skip on a one-off task, and an id that is not there', () => {
    expect(reasons(verb('skip', 'task-1'))[0]).toMatch(/cannot be skipped/);
    expect(reasons(verb('complete', 'nope'))).toEqual(['item no longer exists']);
  });

  it('asks only what fits the item when the day cannot be known (the server)', () => {
    expect(reasons(verb('complete', 'habit-1', '2026-08-27'), ctx)).toEqual([]);
    expect(reasons(verb('skip', 'task-1'), ctx)[0]).toMatch(/cannot be skipped/);
  });

  it('describes each in the words the card shows', () => {
    expect(describeOperation(verb('complete', 'habit-1'), day)).toBe('Stretch: done today');
    expect(describeOperation(verb('skip', 'habit-1', '2026-08-27'), day)).toMatch(/^Stretch: skip on /);
    expect(describeOperation(verb('complete', 'task-1'), day)).toBe('Email Dana: mark done');
    expect(describeOperation(verb('pause', 'habit-1'), day)).toBe('Stretch: pause');
  });
});
