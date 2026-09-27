import { describe, it, expect } from 'vitest';
import { GoalCreateSchema, GoalUpdateSchema } from '@dsul/types';
import { resolveGoalStateWrite, roleStillValid } from '@/lib/goals';
import type { Goal, Item } from '@/lib/planner-types';

/**
 * The agent write surface for goals (plan Phase 4).
 *
 * Same split as agent-pause-write.test.ts: Zod decides whether a BODY is
 * coherent on its own, and the resolver decides what a coherent body means
 * against the row it is aimed at. What is tested here is everything the route
 * handler delegates to; the handlers themselves are covered in
 * agent-goal-routes.test.ts.
 *
 * Neither file meets the plan's Phase 4 gate. That gate is live calls against a
 * running server, and no goal route in this repository has ever spoken to a
 * database — see the header of agent-goal-routes.test.ts for what the
 * substitute does and does not buy.
 */

const NOW = '2026-08-21T12:00:00.000Z';
const EARLIER = '2026-03-01T09:00:00.000Z';

const goal = (over: Partial<Goal> = {}): Goal =>
  ({
    id: 'g1',
    name: 'Learn Chinese',
    state: 'active',
    memberIds: [],
    milestoneIds: [],
    checkinIds: [],
    ...over,
  }) as Goal;

describe('GoalCreateSchema / GoalUpdateSchema — what a goal body may say', () => {
  it('accepts the minimum: a name', () => {
    expect(GoalCreateSchema.safeParse({ name: 'Learn Chinese' }).success).toBe(true);
  });

  it('requires a name on create and not on update', () => {
    expect(GoalCreateSchema.safeParse({ why: 'because' }).success).toBe(false);
    expect(GoalUpdateSchema.safeParse({ why: 'because' }).success).toBe(true);
  });

  it('refuses an empty name rather than storing a nameless goal', () => {
    expect(GoalCreateSchema.safeParse({ name: '' }).success).toBe(false);
    expect(GoalUpdateSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('takes the three lifecycle states and nothing else', () => {
    for (const state of ['active', 'achieved', 'abandoned']) {
      expect(GoalUpdateSchema.safeParse({ state }).success).toBe(true);
    }
    // 'auto' and 'paused' are the SEASON vocabulary — the nearest wrong answer.
    expect(GoalUpdateSchema.safeParse({ state: 'auto' }).success).toBe(false);
    expect(GoalUpdateSchema.safeParse({ state: 'paused' }).success).toBe(false);
  });
});

describe('the refusals — each one because the silent alternative is worse', () => {
  it('refuses the pause verb and points at the alternatives', () => {
    // `paused: true` works on items and on routines, and a goal is precisely
    // what a model will reach for when asked to "shelve" something. Zod's
    // default strip would 200-and-do-nothing.
    const r = GoalUpdateSchema.safeParse({ paused: true });
    expect(r.success).toBe(false);
    const message = (r as { error: { issues: { message: string }[] } }).error.issues[0].message;
    expect(message).toContain('state');
    expect(message).toContain('season');
  });

  it('refuses pausedUntil for the same reason', () => {
    expect(GoalUpdateSchema.safeParse({ pausedUntil: '2026-09-01' }).success).toBe(false);
  });

  it('refuses a caller-chosen achievedAt', () => {
    // Wrong in both directions: backdated it claims an achievement that had not
    // happened; postdated it leaves a goal reading achieved with no date.
    const r = GoalUpdateSchema.safeParse({ achievedAt: NOW });
    expect(r.success).toBe(false);
    expect(
      (r as { error: { issues: { message: string }[] } }).error.issues[0].message,
    ).toContain('derived');
  });

  it('refuses a window that never opens', () => {
    expect(
      GoalCreateSchema.safeParse({ name: 'X', startsOn: '2027-01-01', targetOn: '2026-01-01' })
        .success,
    ).toBe(false);
    expect(
      GoalCreateSchema.safeParse({ name: 'X', startsOn: '2026-01-01', targetOn: '2027-01-01' })
        .success,
    ).toBe(true);
  });

  it('accepts a single-day window — a target on the start date is a real plan', () => {
    expect(
      GoalUpdateSchema.safeParse({ startsOn: '2026-06-01', targetOn: '2026-06-01' }).success,
    ).toBe(true);
  });

  it('refuses a date that is not in yyyy-MM-dd shape', () => {
    expect(GoalUpdateSchema.safeParse({ targetOn: 'next spring' }).success).toBe(false);
    expect(GoalUpdateSchema.safeParse({ targetOn: '8/21/2026' }).success).toBe(false);
    // Shape only — DateOnlySchema is a regex, shared with every other date
    // field in the API, so an impossible month passes here exactly as it does
    // for a task's startDate. Pinned rather than fixed: tightening it is an
    // API-wide change, not a goals change.
    expect(GoalUpdateSchema.safeParse({ targetOn: '2026-13-01' }).success).toBe(true);
  });

  it('lets a date be CLEARED with null', () => {
    expect(GoalUpdateSchema.safeParse({ targetOn: null }).success).toBe(true);
    expect(GoalUpdateSchema.safeParse({ why: null }).success).toBe(true);
  });

  it('refuses one id given two roles at once, naming both arrays', () => {
    const r = GoalUpdateSchema.safeParse({
      milestoneIds: ['11111111-1111-4111-8111-111111111111'],
      memberIds: ['11111111-1111-4111-8111-111111111111'],
    });
    expect(r.success).toBe(false);
    const message = (r as { error: { issues: { message: string }[] } }).error.issues[0].message;
    expect(message).toContain('milestoneIds');
    expect(message).toContain('memberIds');
  });

  it('allows the same id twice WITHIN one array', () => {
    // A repeat inside one array is a sloppy list, not a contradiction — the db
    // layer dedupes it. Across arrays it is two instructions, refused above.
    const id = '11111111-1111-4111-8111-111111111111';
    expect(GoalUpdateSchema.safeParse({ memberIds: [id, id] }).success).toBe(true);
  });

  it('refuses a membership id that is not a uuid', () => {
    expect(GoalUpdateSchema.safeParse({ memberIds: ['task-1'] }).success).toBe(false);
  });
});

describe('resolveGoalStateWrite — what the state verb actually writes', () => {
  it('stamps achievedAt when a goal is achieved', () => {
    expect(resolveGoalStateWrite(goal(), 'achieved', NOW)).toEqual({
      state: 'achieved',
      achievedAt: NOW,
    });
  });

  it('writes NOTHING for a same-state write', () => {
    // Whole-array membership replacement is designed to be idempotent, so a
    // retried "mark achieved" is expected traffic — and it must not drag the
    // achievement date forward.
    const achieved = goal({ state: 'achieved', achievedAt: EARLIER });
    expect(resolveGoalStateWrite(achieved, 'achieved', NOW)).toEqual({});
  });

  it('clears the stamp when a goal reopens', () => {
    const achieved = goal({ state: 'achieved', achievedAt: EARLIER });
    expect(resolveGoalStateWrite(achieved, 'active', NOW)).toEqual({
      state: 'active',
      achievedAt: undefined,
    });
  });

  it('leaves the stamp alone when an achieved goal is abandoned', () => {
    // A strange history, but it is the user's history.
    const achieved = goal({ state: 'achieved', achievedAt: EARLIER });
    expect(resolveGoalStateWrite(achieved, 'abandoned', NOW)).toEqual({ state: 'abandoned' });
  });
});

describe('roleStillValid — the demotion predicate the agent PATCH consults', () => {
  const item = (repeatFrequency?: string) => ({ type: 'task', repeatFrequency }) as unknown as Item;

  it('drops a milestone that has been made recurring', () => {
    expect(roleStillValid('milestone', item('daily'))).toBe(false);
    expect(roleStillValid('milestone', item('none'))).toBe(true);
    expect(roleStillValid('milestone', item(undefined))).toBe(true);
  });

  it('drops a check-in that has stopped recurring — both directions', () => {
    expect(roleStillValid('checkin', item(undefined))).toBe(false);
    expect(roleStillValid('checkin', item('none'))).toBe(false);
    expect(roleStillValid('checkin', item('weekdays'))).toBe(true);
  });

  it('never demotes plain membership, so demotion terminates', () => {
    expect(roleStillValid('member', item('daily'))).toBe(true);
    expect(roleStillValid('member', item(undefined))).toBe(true);
  });
});
