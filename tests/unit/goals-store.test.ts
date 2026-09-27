import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The goals SLICE — Phase 1 of memory/plans/long-term-goals.md.
 *
 * Same harness as pause.test.ts: the db layer is mocked and the REAL Zustand
 * store is driven, so these assert both the optimistic state and the writes
 * that leave for Supabase. Goals need that pairing more than most features,
 * because the two things most likely to break them are invisible in the UI —
 * a membership write that never leaves, and a role that quietly changes.
 */

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    fetchItems: vi.fn(async () => []),
    fetchProjects: vi.fn(async () => []),
    fetchItemTypes: vi.fn(async () => []),
    fetchRoutines: vi.fn(async () => []),
    fetchSeasons: vi.fn(async () => []),
    fetchGoals: vi.fn(async () => []),
    createItem: vi.fn(async () => {}),
    updateItem: vi.fn(async () => {}),
    deleteItem: vi.fn(async () => {}),
    restoreItem: vi.fn(async () => {}),
    setItemCompletion: vi.fn(async () => {}),
    createGoal: vi.fn(async () => {}),
    updateGoal: vi.fn(async () => {}),
    deleteGoal: vi.fn(async () => {}),
    restoreGoal: vi.fn(async () => {}),
    recordCheckin: vi.fn(),
  };
});
vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
// The bridge and the achievement offer both speak through sonner; the tests
// invoke the toast's own action the way a user would click it.
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/completion-confetti', () => ({ celebrateCompletion: vi.fn() }));

import { usePlannerStore } from '@/lib/planner-store';
import * as db from '@/lib/db';
import { toast } from 'sonner';
import type { Goal, Item } from '@/lib/planner-types';

const U = 'user-1';

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'g1',
  name: 'Learn Chinese',
  state: 'active',
  memberIds: [],
  milestoneIds: [],
  checkinIds: [],
  ...over,
});

const task = (over: Partial<Extract<Item, { type: 'task' }>> = {}): Item => ({
  type: 'task',
  id: 't1',
  title: 'Sit HSK 3',
  status: 'pending',
  isScheduled: false,
  order: 0,
  completedDates: [],
  skippedDates: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  usePlannerStore.setState({
    userId: U,
    items: [],
    tasks: [],
    habits: [],
    goals: [],
    routines: [],
    seasons: [],
    projects: [],
    goalsAvailable: true,
    // Reset with the rest of it. Nothing set this until the UTC+14 case below,
    // and the moment something did it leaked forward into every later test in
    // the file — the check-in bridge does date math and started reading a zone
    // it never asked for.
    userTimezone: undefined,
  } as never);
});

describe('the goals slice', () => {
  it('creates, edits and soft-deletes, writing each through', () => {
    const s = usePlannerStore.getState();
    const id = s.addGoal({ name: 'Learn Chinese', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [] });
    expect(db.createGoal).toHaveBeenCalledWith(U, expect.objectContaining({ id, name: 'Learn Chinese' }));

    usePlannerStore.getState().updateGoal(id, { why: 'To talk to my in-laws' });
    expect(db.updateGoal).toHaveBeenCalledWith(U, id, { why: 'To talk to my in-laws' });

    usePlannerStore.getState().removeGoal(id);
    expect(db.deleteGoal).toHaveBeenCalledWith(U, id);
    expect(usePlannerStore.getState().goals).toHaveLength(0);
  });

  it('deleting a goal touches none of its members', () => {
    // The whole promise of the aspire role. "Delete Learn Chinese" must not
    // take a year of habits and tasks with it — only the goal and its links.
    usePlannerStore.setState({
      items: [task()],
      goals: [goal({ memberIds: ['t1'], milestoneIds: [] })],
    } as never);
    usePlannerStore.getState().removeGoal('g1');
    expect(usePlannerStore.getState().items).toHaveLength(1);
    expect(db.updateItem).not.toHaveBeenCalled();
    expect(db.deleteItem).not.toHaveBeenCalled();
  });
});

describe('setGoalState', () => {
  it('stamps achievedAt on achieving and CLEARS it on reopening', () => {
    usePlannerStore.setState({ goals: [goal()] } as never);
    usePlannerStore.getState().setGoalState('g1', 'achieved');
    const achieved = usePlannerStore.getState().goals[0];
    expect(achieved.state).toBe('achieved');
    expect(achieved.achievedAt).toBeTruthy();

    usePlannerStore.getState().setGoalState('g1', 'active');
    const reopened = usePlannerStore.getState().goals[0];
    expect(reopened.state).toBe('active');
    expect(reopened.achievedAt).toBeUndefined();
    // The key must SURVIVE to the db layer as an explicit clear — dropped as an
    // absent key, the stamp would live on in the row forever.
    expect(db.updateGoal).toHaveBeenLastCalledWith(U, 'g1', { state: 'active', achievedAt: undefined });
    // ...and that matcher alone does NOT check it. toHaveBeenLastCalledWith uses
    // toEqual semantics, which treat an absent key and a key set to undefined as
    // equal — exactly the distinction the comment above calls load-bearing. So
    // assert the key's PRESENCE, which is the part that reaches the db layer.
    const patch = vi.mocked(db.updateGoal).mock.lastCall?.[2] ?? {};
    expect(Object.prototype.hasOwnProperty.call(patch, 'achievedAt')).toBe(true);
  });

  it('never restamps a goal already in the requested state', () => {
    // Retried writes are expected traffic. Restamping would drag a multi-year
    // achievement date forward every time one arrived.
    const stamp = '2026-01-01T00:00:00.000Z';
    usePlannerStore.setState({ goals: [goal({ state: 'achieved', achievedAt: stamp })] } as never);
    usePlannerStore.getState().setGoalState('g1', 'achieved');
    expect(usePlannerStore.getState().goals[0].achievedAt).toBe(stamp);
    expect(db.updateGoal).not.toHaveBeenCalled();
  });

  it('leaves the stamp alone when abandoning', () => {
    const stamp = '2026-01-01T00:00:00.000Z';
    usePlannerStore.setState({ goals: [goal({ state: 'achieved', achievedAt: stamp })] } as never);
    usePlannerStore.getState().setGoalState('g1', 'abandoned');
    expect(usePlannerStore.getState().goals[0].achievedAt).toBe(stamp);
  });
});

describe('the demotion rule', () => {
  it('demotes a milestone to member when the item becomes recurring', () => {
    // Locked decision 3. A recurring item's scalar status never moves, so a
    // recurring milestone can never be counted achieved — the goal would read
    // permanently behind with nothing to click.
    usePlannerStore.setState({
      items: [task()],
      goals: [goal({ milestoneIds: ['t1'] })],
    } as never);

    usePlannerStore.getState().updateTask('t1', { repeatFrequency: 'daily' });

    const g = usePlannerStore.getState().goals[0];
    expect(g.milestoneIds).toEqual([]);
    expect(g.memberIds).toEqual(['t1']);
    // And the membership write leaves, carrying all three arrays.
    expect(db.updateGoal).toHaveBeenCalledWith(U, 'g1', {
      memberIds: ['t1'], milestoneIds: [], checkinIds: [],
    });
  });

  it('demotes a check-in when the item stops recurring', () => {
    usePlannerStore.setState({
      items: [task({ repeatFrequency: 'weekdays' })],
      goals: [goal({ checkinIds: ['t1'] })],
    } as never);

    usePlannerStore.getState().updateTask('t1', { repeatFrequency: 'none' });

    const g = usePlannerStore.getState().goals[0];
    expect(g.checkinIds).toEqual([]);
    expect(g.memberIds).toEqual(['t1']);
  });

  it('never blocks the edit it reacts to', () => {
    // A goal must not constrain its members — that is the aspire role's whole
    // seam. The item edit lands either way; the membership is what yields.
    usePlannerStore.setState({
      items: [task()],
      goals: [goal({ milestoneIds: ['t1'] })],
    } as never);
    usePlannerStore.getState().updateTask('t1', { repeatFrequency: 'daily' });
    const item = usePlannerStore.getState().items[0] as Extract<Item, { type: 'task' }>;
    expect(item.repeatFrequency).toBe('daily');
  });

  it('leaves a still-valid role alone, and skips the scan for unrelated edits', () => {
    usePlannerStore.setState({
      items: [task()],
      goals: [goal({ milestoneIds: ['t1'] })],
    } as never);
    usePlannerStore.getState().updateTask('t1', { title: 'Renamed' });
    expect(usePlannerStore.getState().goals[0].milestoneIds).toEqual(['t1']);
    expect(db.updateGoal).not.toHaveBeenCalled();
  });

  it('does not duplicate an item that is already a plain member elsewhere in the goal', () => {
    // Guarding the array rebuild: an item cannot hold two roles in one goal
    // (the PK enforces it), so the demoted id must not be appended twice.
    usePlannerStore.setState({
      items: [task()],
      goals: [goal({ milestoneIds: ['t1'], memberIds: ['t1'] })],
    } as never);
    usePlannerStore.getState().updateTask('t1', { repeatFrequency: 'daily' });
    expect(usePlannerStore.getState().goals[0].memberIds).toEqual(['t1']);
  });
});

describe('the bulk date verbs leave milestone target dates alone', () => {
  const seed = () =>
    usePlannerStore.setState({
      items: [
        task({ id: 'plain', title: 'Buy milk', startDate: '2026-06-01', timeBucket: 'anytime' }),
        task({ id: 'stone', title: 'Sit HSK 3', startDate: '2026-06-30', timeBucket: 'anytime' }),
      ],
      goals: [goal({ milestoneIds: ['stone'] })],
    } as never);

  it('moveTasksToDate skips them', () => {
    // For an ordinary task startDate is a scheduling intention and "move all to
    // tomorrow" is a kindness. For a milestone it is the target date, and a
    // habitual bulk tap would walk a goal's deadline forward a day at a time.
    seed();
    usePlannerStore.getState().moveTasksToDate(['plain', 'stone'], '2026-06-02');
    const byId = new Map(usePlannerStore.getState().items.map((i) => [i.id, i]));
    expect((byId.get('plain') as { startDate?: string }).startDate).toBe('2026-06-02');
    expect((byId.get('stone') as { startDate?: string }).startDate).toBe('2026-06-30');
  });

  it('unscheduleTasks — the sweep’s verb — skips them', () => {
    // The heaviest caller here is the unattended auto-age sweep, which CLEARS
    // startDate. Left in, a milestone thirty days behind loses the only record
    // of when it was due, silently and overnight.
    seed();
    usePlannerStore.getState().unscheduleTasks(['plain', 'stone']);
    const byId = new Map(usePlannerStore.getState().items.map((i) => [i.id, i]));
    expect((byId.get('plain') as { startDate?: string }).startDate).toBeUndefined();
    expect((byId.get('stone') as { startDate?: string }).startDate).toBe('2026-06-30');
  });

  it('scheduleItemsAt keeps the target date but still takes the time', () => {
    // The gap this closes: the SAME drop handler routed an untimed week column
    // through moveTasksToDate (which excludes milestones) and an hour cell one
    // column over through scheduleItemsAt (which did not), so a milestone's
    // deadline survived or moved depending on which pixel it was dropped on.
    //
    // The date is withheld, NOT the whole drop — this verb also carries a time,
    // and refusing outright would discard a drag the user plainly meant.
    seed();
    usePlannerStore.getState().scheduleItemsAt(['plain', 'stone'], 'morning', '09:00', '2026-06-02');
    const byId = new Map(usePlannerStore.getState().items.map((i) => [i.id, i]));
    expect((byId.get('plain') as { startDate?: string }).startDate).toBe('2026-06-02');
    expect((byId.get('stone') as { startDate?: string }).startDate).toBe('2026-06-30');
    // The time landed on both, milestone included.
    expect((byId.get('stone') as { startTime?: string }).startTime).toBe('09:00');
    expect((byId.get('plain') as { startTime?: string }).startTime).toBe('09:00');
  });

  it('still lets a single deliberate reschedule through', () => {
    // Only the sweeping verbs are refused. Moving one milestone on purpose is
    // ordinary planning and stays available everywhere.
    seed();
    usePlannerStore.getState().updateTask('stone', { startDate: '2026-07-15' });
    const byId = new Map(usePlannerStore.getState().items.map((i) => [i.id, i]));
    expect((byId.get('stone') as { startDate?: string }).startDate).toBe('2026-07-15');
  });
});

describe('create-with-membership', () => {
  it('lands the item and its goal role in ONE gesture', () => {
    usePlannerStore.setState({ goals: [goal()] } as never);
    usePlannerStore.getState().addTask(
      { title: 'Sit HSK 3', status: 'pending', isScheduled: false, order: 0, completedDates: [], skippedDates: [] } as never,
      { goalIds: ['g1'], goalRole: 'milestone' },
    );
    const g = usePlannerStore.getState().goals[0];
    expect(g.milestoneIds).toHaveLength(1);
    expect(g.memberIds).toHaveLength(0);
  });

  it('defaults to the plain member role', () => {
    usePlannerStore.setState({ goals: [goal()] } as never);
    usePlannerStore.getState().addTask(
      { title: 'Book a tutor', status: 'pending', isScheduled: false, order: 0, completedDates: [], skippedDates: [] } as never,
      { goalIds: ['g1'] },
    );
    expect(usePlannerStore.getState().goals[0].memberIds).toHaveLength(1);
  });
});

describe('the trash keeps a goal’s roles', () => {
  it('restores each member into the role it held, not as plain members', () => {
    // The near-miss the console's own Phase 4 recorded, one level worse: a bin
    // snapshot of bare ids would bring every milestone and check-in back as a
    // plain member — silently changing the goal's progress denominator, while
    // the visible gate (the row is back on the list) passes either way.
    const entry = {
      kind: 'goal' as const,
      id: 'g9',
      name: 'Learn Chinese',
      deletedAt: '2026-08-01T00:00:00.000Z',
      entity: goal({
        id: 'g9',
        memberIds: ['m1'],
        milestoneIds: ['s1', 's2'],
        checkinIds: ['c1'],
      }),
    };
    usePlannerStore.setState({ goals: [] } as never);
    usePlannerStore.getState().restoreFromTrash(entry);

    const restored = usePlannerStore.getState().goals[0];
    expect(restored.milestoneIds).toEqual(['s1', 's2']);
    expect(restored.checkinIds).toEqual(['c1']);
    expect(restored.memberIds).toEqual(['m1']);
    expect(db.restoreGoal).toHaveBeenCalledWith(U, 'g9');
  });

  it('is a no-op when the goal is already back', () => {
    usePlannerStore.setState({ goals: [goal({ id: 'g9' })] } as never);
    usePlannerStore.getState().restoreFromTrash({
      kind: 'goal' as const,
      id: 'g9',
      name: 'Learn Chinese',
      deletedAt: '2026-08-01T00:00:00.000Z',
      entity: goal({ id: 'g9' }),
    });
    expect(usePlannerStore.getState().goals).toHaveLength(1);
  });
});

describe('the review’s findings, pinned', () => {
  it('demotion is ONE history entry, so one undo cannot restore an invalid role', () => {
    // The blocker three lenses found. Two set()s meant two entries, and the
    // intermediate one is the state decision 3 exists to make unreachable: a
    // milestone whose item recurs, whose scalar status is frozen by design, so
    // it can never be counted achieved. Worse, syncContainers then WRITES it.
    usePlannerStore.setState({
      items: [task()],
      goals: [goal({ milestoneIds: ['t1'] })],
    } as never);
    usePlannerStore.getState().refreshActionLog();
    // Compared by HEAD rather than by length: the log is capped at
    // MAX_HISTORY_SIZE, so a full stack absorbs a second entry without growing
    // — which is exactly how a two-entry edit could hide from a count.
    const previousHead = usePlannerStore.getState().actionLog[0]?.label;

    usePlannerStore.getState().updateTask('t1', { repeatFrequency: 'daily' });
    usePlannerStore.getState().refreshActionLog();
    const log = usePlannerStore.getState().actionLog;
    expect(log[0].label).toMatch(/^Role changed:/);
    expect(log[1]?.label).toBe(previousHead);

    usePlannerStore.getState().undo();
    const g = usePlannerStore.getState().goals[0];
    const item = usePlannerStore.getState().items[0] as Extract<Item, { type: 'task' }>;
    // Either both revert or neither does — never a recurring milestone.
    expect(g.milestoneIds.includes('t1') && item.repeatFrequency === 'daily').toBe(false);
  });

  it('the demotion receipt rides a label the undo toast can actually see', () => {
    // The receipt has exactly one consumer and it fires only for a known
    // prefix, so an `Edit …` label wrote the explanation into an object
    // nothing renders — and borrowing another verb's prefix would have lied in
    // the history popover, which shows the label verbatim.
    usePlannerStore.setState({
      items: [task()],
      goals: [goal({ milestoneIds: ['t1'] })],
    } as never);
    usePlannerStore.getState().updateTask('t1', { repeatFrequency: 'daily' });
    usePlannerStore.getState().refreshActionLog();
    const entry = usePlannerStore.getState().actionLog[0];
    expect(entry.label.startsWith('Role changed:')).toBe(true);
    expect(entry.receipt).toMatch(/Learn Chinese/);
  });

  it('refuses a membership patch that gives one item two roles', () => {
    // db.ts refuses it inside the write, which this action fires as
    // .catch(console.error) AFTER the optimistic set() — so without a guard
    // here the store kept a state the database rejected, and every subsequent
    // membership edit on the goal threw on the same contradiction.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    usePlannerStore.setState({ goals: [goal({ memberIds: ['t1'] })] } as never);
    usePlannerStore.getState().updateGoal('g1', {
      memberIds: ['t1'],
      milestoneIds: ['t1'],
      checkinIds: [],
    });
    const g = usePlannerStore.getState().goals[0];
    expect(g.milestoneIds).toEqual([]);
    expect(g.memberIds).toEqual(['t1']);
    expect(db.updateGoal).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('clears goals on sign-out, so the next account never sees them', () => {
    usePlannerStore.setState({ goals: [goal()], goalsAvailable: false } as never);
    usePlannerStore.getState().clearStore();
    expect(usePlannerStore.getState().goals).toEqual([]);
    expect(usePlannerStore.getState().goalsAvailable).toBe(true);
  });

  it('survives an undo back to session start with its goals intact', () => {
    // The payoff of typing the history-baseline literal. Missed there, undoing
    // to the baseline reads every goal as "present in current, absent in
    // restored" — which syncContainers executes as a DELETE of all of them.
    usePlannerStore.setState({ goals: [goal()] } as never);
    usePlannerStore.getState().addGoal({
      name: 'Second', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [],
    });
    usePlannerStore.getState().undo();
    // The goal that existed at the baseline survives; only the one the undone
    // action CREATED is deleted. Before the literal was typed, the baseline
    // held no `goals` at all, so syncContainers read both as "absent in
    // restored" and soft-deleted the pair.
    expect(usePlannerStore.getState().goals.map((g) => g.name)).toEqual(['Learn Chinese']);
    const deleted = (db.deleteGoal as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (c) => c[1],
    );
    expect(deleted).not.toContain('g1');
  });

  it('the bulk verbs persist exactly what they kept', () => {
    // The optimistic state and the DB writes must name the same set — the
    // divergence that shipped in 1a and was caught by its own test.
    usePlannerStore.setState({
      items: [
        task({ id: 'plain', startDate: '2026-06-01', timeBucket: 'anytime' }),
        task({ id: 'stone', startDate: '2026-06-30', timeBucket: 'anytime' }),
      ],
      goals: [goal({ milestoneIds: ['stone'] })],
    } as never);
    usePlannerStore.getState().unscheduleTasks(['plain', 'stone']);
    const written = (db.updateItem as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (c) => c[0],
    );
    expect(written).toEqual(['plain']);
  });
});

describe('Phase 2 — the goal surface', () => {
  it('offers achievement when the last milestone closes, and never takes it', () => {
    // Offers, never acts: achieving is a statement about a stretch of your
    // life, and an app that made it for you would be claiming to know when the
    // thing you set out to do is done.
    usePlannerStore.setState({
      items: [task({ id: 's1', title: 'Sit HSK 3' })],
      goals: [goal({ milestoneIds: ['s1'] })],
    } as never);
    usePlannerStore.getState().toggleTaskStatus('s1');
    expect(usePlannerStore.getState().goals[0].state).toBe('active');
  });

  it('renders a far target as the day STORED, in a zone ahead of UTC', () => {
    // targetOn is a calendar date — no time, no zone — so the day shown must
    // not depend on who is looking. The regression this pins was self-inflicted
    // and one commit old: formatGoalDay built the date at UTC noon and then
    // rendered it in the USER's zone, which at UTC+12/+14 is already tomorrow.
    // A goal due 2026-12-01 read "Dec 2" in Auckland and Kiritimati.
    //
    // Kiritimati (UTC+14) is the widest offset there is, so it fails loudest;
    // Auckland would do, and is the zone goals.test.ts already uses.
    usePlannerStore.setState({
      userTimezone: 'Pacific/Kiritimati',
      items: [task({ id: 's1', title: 'Sit HSK 3' })],
      goals: [goal({ milestoneIds: ['s1'], targetOn: '2999-12-01' })],
    } as never);
    usePlannerStore.getState().toggleTaskStatus('s1');

    const call = vi.mocked(toast).mock.calls.at(-1);
    const description = (call?.[1] as { description?: string } | undefined)?.description ?? '';
    expect(description).toContain('Dec 1');
    expect(description).not.toContain('Dec 2');
  });

  it('stays quiet while any milestone is still open', () => {
    usePlannerStore.setState({
      items: [task({ id: 's1' }), task({ id: 's2' })],
      goals: [goal({ milestoneIds: ['s1', 's2'] })],
    } as never);
    usePlannerStore.getState().toggleTaskStatus('s1');
    // Nothing to assert on state — the point is that no write happened.
    expect(usePlannerStore.getState().goals[0].state).toBe('active');
    expect(db.updateGoal).not.toHaveBeenCalled();
  });

  it('creates a milestone that is findable — undated and UNBUCKETED', () => {
    // The first version bucketed it, on reasoning that was exactly backwards.
    // deriveDayItems tests startDate before it looks at a bucket, so a bucket
    // buys an undated item nothing on a day column — while the braindump
    // excludes on `isScheduled || timeBucket`. Bucketing therefore removed it
    // from the only list undated work lives in and added it to none.
    usePlannerStore.setState({ goals: [goal()], items: [] } as never);
    usePlannerStore.getState().addTask(
      {
        title: 'Reach conversational fluency',
        status: 'pending',
        isScheduled: false,
        order: 0,
        completedDates: [],
        skippedDates: [],
      } as never,
      { goalIds: ['g1'], goalRole: 'milestone' },
    );
    const g = usePlannerStore.getState().goals[0];
    expect(g.milestoneIds).toHaveLength(1);
    const created = usePlannerStore.getState().items[0] as {
      timeBucket?: string;
      isScheduled?: boolean;
      startDate?: string;
    };
    // Braindump-visible: no bucket, not scheduled, no date.
    expect(created.timeBucket).toBeUndefined();
    expect(created.isScheduled).toBe(false);
    expect(created.startDate).toBeUndefined();
  });
});

describe('the check-in bridge', () => {
  const recurring = (over: Partial<Extract<Item, { type: 'task' }>> = {}): Item =>
    task({ id: 'c1', title: 'Weekly review', repeatFrequency: 'daily', startDate: '2026-08-01', ...over });

  it('writes the note against every active goal the item checks in for', () => {
    // Filing under the first match left a shared check-in's second goal with a
    // permanently empty history, no matter how many notes were written.
    const spy = vi.spyOn(window, 'prompt').mockReturnValue('tones are getting easier');
    usePlannerStore.setState({
      items: [recurring()],
      goals: [
        goal({ id: 'g1', name: 'Chinese', checkinIds: ['c1'] }),
        goal({ id: 'g2', name: 'Reading', checkinIds: ['c1'] }),
      ],
    } as never);

    usePlannerStore.getState().toggleTaskStatus('c1', undefined, new Date('2026-08-23T12:00:00'));
    // The toast's action is what writes; invoke it the way the user would.
    const call = (toast as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1);
    const opts = call?.[1] as { action?: { onClick: () => void } } | undefined;
    opts?.action?.onClick();

    const written = (db.recordCheckin as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(written.map((c) => c[2]).sort()).toEqual(['g1', 'g2']);
    // And against the OCCURRENCE date, not the moment of typing.
    expect(written.every((c) => c[3] === '2026-08-23')).toBe(true);
    spy.mockRestore();
  });

  it('says nothing when the item is nobody’s check-in', () => {
    usePlannerStore.setState({
      items: [recurring()],
      goals: [goal({ memberIds: ['c1'] })],
    } as never);
    (toast as unknown as { mockClear: () => void }).mockClear();
    usePlannerStore.getState().toggleTaskStatus('c1', undefined, new Date('2026-08-23T12:00:00'));
    expect(toast).not.toHaveBeenCalled();
  });
});
