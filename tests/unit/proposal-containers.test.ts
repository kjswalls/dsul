import { describe, expect, it } from 'vitest';
import { describeOperation, proposalContainersOf, validateProposalOperations, type ProposalContext } from '@/lib/proposal';
import type { Goal, Item, Project, ProposalOperation, Routine, Season } from '@/lib/planner-types';

// Cards that make, change and fill projects, routines, seasons and goals
// (chat step 5c): what validation lets through, and what the card says.

const item = (over: Partial<Item>): Item =>
  ({ type: 'task', status: 'pending', isScheduled: false, order: 0, completedDates: [], ...over }) as unknown as Item;

const ITEMS: Item[] = [
  item({ id: 't1', title: 'Stretch', project: 'Work', projectId: 'p1' }),
  item({ id: 't2', title: 'Journal' }),
  item({ id: 't3', title: 'Step', parentItemId: 't2' }),
];
const PROJECTS = [{ id: 'p1', name: 'Work', emoji: '' }] as Project[];
const ROUTINES = [{ id: 'r1', name: 'Morning', itemIds: ['t1'] }] as Routine[];
const SEASONS = [{ id: 's1', name: 'Summer', state: 'auto', itemIds: [], routineIds: [], startsOn: '2026-06-01' }] as unknown as Season[];
const GOALS = [{ id: 'g1', name: 'Run a 10k', state: 'active', memberIds: [], milestoneIds: ['t2'], checkinIds: [] }] as unknown as Goal[];

const ctx = (over: Partial<NonNullable<ProposalContext['containers']>> = {}): ProposalContext => ({
  items: ITEMS,
  customTypeNames: [],
  containers: { projects: PROJECTS, routines: ROUTINES, seasons: SEASONS, goals: GOALS, ...over },
});

const check = (op: ProposalOperation, c = ctx()) => validateProposalOperations([op], c);
const reason = (op: ProposalOperation, c = ctx()) => check(op, c).rejected[0]?.reason;

describe('container operations', () => {
  it('makes each kind, keeping only the fields it has', () => {
    const { accepted } = check({
      kind: 'container',
      container: 'routine',
      name: '  Evening ',
      usualTime: '21:30',
      targetOn: '2026-12-01',
      itemIds: ['t2', 't2'],
    });
    expect(accepted).toEqual([{ kind: 'container', container: 'routine', name: 'Evening', usualTime: '21:30', itemIds: ['t2'] }]);
  });

  it("moves a goal's notes to its why, and a routine's why to its notes, rather than losing them", () => {
    expect(check({ kind: 'container', container: 'goal', name: 'Read more', notes: 'Calmer evenings' }).accepted[0]).toMatchObject({
      why: 'Calmer evenings',
    });
    const routine = check({ kind: 'container', container: 'routine', name: 'Wind down', why: 'Sleep better' }).accepted[0];
    expect(routine).toMatchObject({ notes: 'Sleep better' });
    expect(routine).not.toHaveProperty('why');
  });

  it('refuses a name already taken, case folded, and a blank one', () => {
    expect(reason({ kind: 'container', container: 'project', name: 'work' })).toBe('there is already a project called "Work"');
    expect(reason({ kind: 'container', container: 'routine', name: 'MORNING' })).toMatch(/already a routine/);
    expect(reason({ kind: 'container', container: 'season', name: '   ' })).toBe('a name cannot be blank');
    expect(reason({ kind: 'container', container: 'goal' })).toBe('a new goal needs a name');
  });

  it('changes an existing one, but never its member list wholesale', () => {
    expect(check({ kind: 'container', container: 'routine', containerId: 'r1', name: 'Mornings' }).accepted).toHaveLength(1);
    expect(reason({ kind: 'container', container: 'routine', containerId: 'r1', itemIds: ['t2'] })).toMatch(/one at a time/);
    expect(reason({ kind: 'container', container: 'routine', containerId: 'nope', name: 'x' })).toBe('no routine has that id');
    expect(reason({ kind: 'container', container: 'project', containerId: 'p1' })).toBe('there is nothing to change');
  });

  it('keeps dates in order, against what the season already has', () => {
    expect(reason({ kind: 'container', container: 'season', containerId: 's1', endsOn: '2026-05-01' })).toBe(
      'a season cannot end before it starts'
    );
    expect(reason({ kind: 'container', container: 'goal', name: 'x', startsOn: '2026-10-10', targetOn: '2026-10-01' })).toMatch(
      /before it starts/
    );
  });

  it('refuses members that are gone or are steps', () => {
    expect(reason({ kind: 'container', container: 'season', name: 'Autumn', itemIds: ['ghost'] })).toMatch(/no longer exists/);
    expect(reason({ kind: 'container', container: 'routine', name: 'Night', itemIds: ['t3'] })).toBe('"Step" cannot be in a routine');
  });

  it('says so when a kind cannot be reached, or goals are off, or nothing was given to check', () => {
    expect(reason({ kind: 'container', container: 'routine', name: 'x' }, ctx({ routines: null }))).toBe(
      'routines cannot be reached just now'
    );
    expect(reason({ kind: 'container', container: 'goal', name: 'x' }, ctx({ goalsEnabled: false }))).toBe(
      'goals are turned off in Settings'
    );
    expect(reason({ kind: 'container', container: 'project', name: 'x' }, { items: ITEMS, customTypeNames: [] })).toMatch(
      /cannot be checked/
    );
  });
});

describe('membership operations', () => {
  it('adds, and takes out, one item at a time', () => {
    expect(check({ kind: 'membership', itemId: 't2', container: 'routine', containerId: 'r1' }).accepted).toHaveLength(1);
    expect(check({ kind: 'membership', itemId: 't1', container: 'routine', containerId: 'r1', member: false }).accepted).toHaveLength(1);
    expect(check({ kind: 'membership', itemId: 't2', container: 'project', containerId: 'p1' }).accepted).toHaveLength(1);
  });

  it('refuses what would change nothing', () => {
    expect(reason({ kind: 'membership', itemId: 't1', container: 'routine', containerId: 'r1' })).toBe('it is already in Morning');
    expect(reason({ kind: 'membership', itemId: 't1', container: 'project', containerId: 'p1' })).toBe('it is already in Work');
    expect(reason({ kind: 'membership', itemId: 't2', container: 'season', containerId: 's1', member: false })).toBe(
      'it is not in Summer'
    );
    // A milestone is in its goal, whatever the role.
    expect(reason({ kind: 'membership', itemId: 't2', container: 'goal', containerId: 'g1' })).toBe('it is already in Run a 10k');
  });

  it('refuses a step, a missing item and a missing container', () => {
    expect(reason({ kind: 'membership', itemId: 't3', container: 'season', containerId: 's1' })).toBe('it cannot be in a season');
    expect(reason({ kind: 'membership', itemId: 'ghost', container: 'season', containerId: 's1' })).toBe('item no longer exists');
    expect(reason({ kind: 'membership', itemId: 't2', container: 'goal', containerId: 'g9' })).toBe('no goal has that id');
  });
});

describe('the card lines', () => {
  const line = (op: ProposalOperation) => describeOperation(op, ctx());

  it('names what is made and what it starts with', () => {
    expect(line({ kind: 'container', container: 'routine', name: 'Evening', usualTime: '21:30', itemIds: ['t1', 't2'] })).toBe(
      'New routine: Evening, usually at 21:30, with Stretch and Journal'
    );
    expect(line({ kind: 'container', container: 'season', name: 'Marathon block', startsOn: '2026-10-12', endsOn: '2026-12-06' })).toBe(
      'New season: Marathon block, Mon Oct 12 to Sun Dec 6'
    );
    expect(line({ kind: 'container', container: 'goal', name: 'Run a half', targetOn: '2027-03-01' })).toBe(
      'New goal: Run a half, by Mon Mar 1'
    );
  });

  it('names the container a change is to', () => {
    expect(line({ kind: 'container', container: 'routine', containerId: 'r1', name: 'Mornings', usualTime: '06:45' })).toBe(
      'Morning (routine): rename to "Mornings", usually at 06:45'
    );
    expect(line({ kind: 'membership', itemId: 't2', container: 'routine', containerId: 'r1' })).toBe('Journal: add to Morning');
    expect(line({ kind: 'membership', itemId: 't2', container: 'project', containerId: 'p1' })).toBe('Journal: file under Work');
    expect(line({ kind: 'membership', itemId: 't1', container: 'routine', containerId: 'r1', member: false })).toBe(
      'Stretch: take out of Morning'
    );
  });
});

describe('proposalContainersOf', () => {
  it('reads a kind whose table is missing as unreachable', () => {
    const c = proposalContainersOf({
      projects: PROJECTS,
      routines: ROUTINES,
      seasons: SEASONS,
      goals: GOALS,
      collectionsAvailable: false,
      goalsAvailable: true,
    });
    expect(c).toMatchObject({ routines: null, seasons: null, goals: GOALS });
  });
});
