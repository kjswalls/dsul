import { describe, expect, it } from 'vitest';
import { describeOperation, validateProposalOperations, type ProposalContext } from '@/lib/proposal';
import type { Goal, Item, Project, ProposalOperation, Routine, Season } from '@/lib/planner-types';

// Cards that pause or resume a routine, move a season or a goal between its
// states, and give a goal's member a role (chat step 5e).

const item = (over: Partial<Item>): Item =>
  ({ type: 'task', status: 'pending', isScheduled: false, order: 0, completedDates: [], ...over }) as unknown as Item;

const ITEMS: Item[] = [
  item({ id: 't1', title: 'Sign up for a race' }),
  item({ id: 't2', title: 'Weekly review', repeatFrequency: 'weekly' as never, startDate: '2026-10-04' }),
  item({ id: 't3', title: 'Step', parentItemId: 't1' }),
  item({ id: 't4', title: 'Long run' }),
];
const PROJECTS = [{ id: 'p1', name: 'Work', emoji: '' }] as Project[];
const ROUTINES = [
  { id: 'r1', name: 'Morning', itemIds: [] },
  { id: 'r2', name: 'Evening', itemIds: [], pausedAt: '2026-10-01T12:00:00.000Z' },
] as unknown as Routine[];
const SEASONS = [{ id: 's1', name: 'Summer', state: 'auto', itemIds: [], routineIds: [] }] as unknown as Season[];
const GOALS = [
  { id: 'g1', name: 'Run a 10k', state: 'active', memberIds: ['t4'], milestoneIds: [], checkinIds: [] },
] as unknown as Goal[];

const ctx = (over: Partial<ProposalContext> = {}): ProposalContext => ({
  items: ITEMS,
  customTypeNames: [],
  todayStr: '2026-10-10',
  tz: 'UTC',
  containers: { projects: PROJECTS, routines: ROUTINES, seasons: SEASONS, goals: GOALS },
  ...over,
});

const check = (op: ProposalOperation, c = ctx()) => validateProposalOperations([op], c);
const reason = (op: ProposalOperation, c = ctx()) => check(op, c).rejected[0]?.reason;
const line = (op: ProposalOperation) => describeOperation(op, ctx());

describe('container states', () => {
  it('pauses and resumes a routine, with a day it comes back', () => {
    expect(check({ kind: 'container', container: 'routine', containerId: 'r1', state: 'paused' }).accepted).toHaveLength(1);
    expect(
      check({ kind: 'container', container: 'routine', containerId: 'r1', state: 'paused', until: '2026-10-17' }).accepted,
    ).toHaveLength(1);
    expect(check({ kind: 'container', container: 'routine', containerId: 'r2', state: 'active' }).accepted).toHaveLength(1);
  });

  it('refuses a routine change that changes nothing, or a pause ending today or before', () => {
    expect(reason({ kind: 'container', container: 'routine', containerId: 'r1', state: 'active' })).toBe('Morning is not paused');
    expect(reason({ kind: 'container', container: 'routine', containerId: 'r2', state: 'paused' })).toBe('Evening is already paused');
    expect(reason({ kind: 'container', container: 'routine', containerId: 'r1', state: 'paused', until: '2026-10-10' })).toBe(
      'a pause has to end on a day still to come',
    );
    // A paused routine may be given a new day it comes back.
    expect(
      check({ kind: 'container', container: 'routine', containerId: 'r2', state: 'paused', until: '2026-10-20' }).accepted,
    ).toHaveLength(1);
  });

  it('without a day and zone (the server), leaves the routine questions to the browser', () => {
    const server = ctx({ todayStr: undefined, tz: undefined });
    expect(check({ kind: 'container', container: 'routine', containerId: 'r1', state: 'active' }, server).accepted).toHaveLength(1);
  });

  it("takes only each kind's own states, and none on a project or a new container", () => {
    expect(reason({ kind: 'container', container: 'routine', containerId: 'r1', state: 'achieved' })).toBe(
      'a routine is active or paused',
    );
    expect(reason({ kind: 'container', container: 'season', containerId: 's1', state: 'abandoned' })).toBe(
      'a season is auto, active or paused',
    );
    expect(reason({ kind: 'container', container: 'goal', containerId: 'g1', state: 'paused' })).toBe(
      'a goal is active, achieved or abandoned',
    );
    expect(reason({ kind: 'container', container: 'project', containerId: 'p1', state: 'active' })).toBe(
      'a project has no state to change',
    );
    expect(reason({ kind: 'container', container: 'season', name: 'Autumn', state: 'paused' })).toMatch(/once it exists/);
  });

  it("refuses a season or goal already in that state, and an until that is not a routine's pause", () => {
    expect(reason({ kind: 'container', container: 'season', containerId: 's1', state: 'auto' })).toBe('Summer is already auto');
    expect(reason({ kind: 'container', container: 'goal', containerId: 'g1', state: 'active' })).toBe(
      'Run a 10k is already active',
    );
    expect(reason({ kind: 'container', container: 'season', containerId: 's1', state: 'paused', until: '2026-11-01' })).toMatch(
      /only a routine being paused/,
    );
    expect(check({ kind: 'container', container: 'goal', containerId: 'g1', state: 'achieved' }).accepted).toHaveLength(1);
  });

  it('says what the state change does', () => {
    expect(line({ kind: 'container', container: 'routine', containerId: 'r1', state: 'paused', until: '2026-10-17' })).toMatch(
      /^Morning \(routine\): pause until /,
    );
    expect(line({ kind: 'container', container: 'routine', containerId: 'r2', state: 'active' })).toBe('Evening (routine): resume');
    expect(line({ kind: 'container', container: 'season', containerId: 's1', state: 'paused' })).toBe(
      'Summer (season): pause until you resume it',
    );
    expect(line({ kind: 'container', container: 'goal', containerId: 'g1', state: 'achieved' })).toBe(
      'Run a 10k (goal): mark achieved',
    );
    expect(line({ kind: 'container', container: 'goal', containerId: 'g1', state: 'abandoned' })).toBe(
      'Run a 10k (goal): set aside',
    );
  });
});

describe('goal roles', () => {
  it('adds an item in a role, or changes the role of one already in', () => {
    expect(check({ kind: 'membership', itemId: 't1', container: 'goal', containerId: 'g1', role: 'milestone' }).accepted).toHaveLength(1);
    expect(check({ kind: 'membership', itemId: 't2', container: 'goal', containerId: 'g1', role: 'checkin' }).accepted).toHaveLength(1);
    expect(check({ kind: 'membership', itemId: 't4', container: 'goal', containerId: 'g1', role: 'milestone' }).accepted).toHaveLength(1);
  });

  it('asks the goal pane its own questions: one-off milestones, repeating check-ins', () => {
    expect(reason({ kind: 'membership', itemId: 't2', container: 'goal', containerId: 'g1', role: 'milestone' })).toBe(
      'a milestone has to be a one-off item',
    );
    expect(reason({ kind: 'membership', itemId: 't1', container: 'goal', containerId: 'g1', role: 'checkin' })).toBe(
      'a check-in has to be an item that repeats',
    );
    expect(reason({ kind: 'membership', itemId: 't3', container: 'goal', containerId: 'g1', role: 'milestone' })).toBe(
      'it cannot be in a goal',
    );
  });

  it('refuses a role it already holds, a role outside a goal, and a role on the way out', () => {
    expect(reason({ kind: 'membership', itemId: 't4', container: 'goal', containerId: 'g1', role: 'member' })).toBe(
      'it is already a member of Run a 10k',
    );
    expect(reason({ kind: 'membership', itemId: 't1', container: 'routine', containerId: 'r1', role: 'member' })).toBe(
      'only a goal gives its members a role',
    );
    expect(
      reason({ kind: 'membership', itemId: 't4', container: 'goal', containerId: 'g1', member: false, role: 'member' }),
    ).toBe('an item taken out of a goal holds no role there');
  });

  it('says whether the item joins in that role or changes to it', () => {
    expect(line({ kind: 'membership', itemId: 't1', container: 'goal', containerId: 'g1', role: 'milestone' })).toBe(
      'Sign up for a race: add to Run a 10k as a milestone',
    );
    expect(line({ kind: 'membership', itemId: 't4', container: 'goal', containerId: 'g1', role: 'milestone' })).toBe(
      'Long run: make a milestone of Run a 10k',
    );
  });
});
