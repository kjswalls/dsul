import { describe, it, expect } from 'vitest';
import { isPausedOn, resolvePauseWrite } from '@/lib/active';
import { withTrashedMembersKept } from '@/lib/agent-api';
import {
  TaskUpdateSchema,
  HabitUpdateSchema,
  RoutineCreateSchema,
  RoutineUpdateSchema,
  SeasonCreateSchema,
  SeasonUpdateSchema,
} from '@dsul/types';

/**
 * The agent write surface for pausing (plan Phase 4).
 *
 * Two halves, and the split is the point. Zod decides whether a BODY is
 * coherent on its own; resolvePauseWrite decides what a coherent body means
 * against the row it is aimed at. Neither can do the other's job — a refine
 * cannot read stored state, and the resolver never sees a malformed date.
 */

const TZ = 'UTC';
const TODAY = '2026-08-10';
const NOW = '2026-08-10T12:00:00.000Z';

// Paused since Aug 1, no end date — the ordinary "paused indefinitely" row.
const PAUSED = { pausedAt: '2026-08-01T09:00:00.000Z' };
const LIVE = {};

const resolve = (
  current: { pausedAt?: string; pausedUntil?: string },
  req: { paused?: boolean; pausedUntil?: string | null },
) => resolvePauseWrite(current, req, TODAY, NOW, TZ);

describe('resolvePauseWrite — pausing', () => {
  it('stamps pausedAt at the given instant', () => {
    expect(resolve(LIVE, { paused: true })).toEqual({
      patch: { pausedAt: NOW, pausedUntil: undefined },
    });
  });

  it('carries a resume date through', () => {
    expect(resolve(LIVE, { paused: true, pausedUntil: '2026-09-01' })).toEqual({
      patch: { pausedAt: NOW, pausedUntil: '2026-09-01' },
    });
  });

  it('treats pausedUntil: null as "no end date"', () => {
    // Distinct from omitting the key: the caller is SAYING indefinite. Both
    // land on the same column value, and that is fine — what matters is that
    // null is not rejected and not stored as the string "null".
    expect(resolve(LIVE, { paused: true, pausedUntil: null })).toEqual({
      patch: { pausedAt: NOW, pausedUntil: undefined },
    });
  });

  it('refuses a resume date that has already passed', () => {
    const result = resolve(LIVE, { paused: true, pausedUntil: '2026-08-01' });
    expect(result).toHaveProperty('reason');
    expect((result as { reason: string }).reason).toContain('2026-08-01');
  });

  it('refuses a resume date of today — the pause would be over before it began', () => {
    // pausedUntil is EXCLUSIVE, so "until today" is live today. Accepted
    // silently this is indistinguishable from a pause that failed to apply.
    expect(resolve(LIVE, { paused: true, pausedUntil: TODAY })).toHaveProperty('reason');
  });
});

describe('resolvePauseWrite — re-pausing something already paused', () => {
  it('does NOT restamp pausedAt', () => {
    // The regression this whole function exists to prevent. pausedAt is the
    // resolver's LOWER bound: moving it forward to now would un-hide Aug 1–10,
    // days the user already decided were paused, and nothing about the request
    // ("pause it") asked for that.
    expect(resolve(PAUSED, { paused: true })).toEqual({ patch: {} });
  });

  it('still honours a new resume date, and touches nothing else', () => {
    expect(resolve(PAUSED, { paused: true, pausedUntil: '2026-09-01' })).toEqual({
      patch: { pausedUntil: '2026-09-01' },
    });
  });

  it('accepts a bare pausedUntil as "move the resume date"', () => {
    expect(resolve(PAUSED, { pausedUntil: '2026-12-25' })).toEqual({
      patch: { pausedUntil: '2026-12-25' },
    });
  });
});

describe('resolvePauseWrite — resuming', () => {
  it('normalizes to pausedUntil = today rather than clearing the pair', () => {
    const result = resolve(PAUSED, { paused: false });
    expect(result).toEqual({ patch: { pausedUntil: TODAY } });

    // And that is genuinely live today, per the exclusive upper bound.
    expect(isPausedOn({ ...PAUSED, pausedUntil: TODAY }, TODAY, TZ)).toBe(false);
    // …while the interval it was paused for survives on the row, which is what
    // the auto-age sweep's resume grace reads.
    expect(isPausedOn({ ...PAUSED, pausedUntil: TODAY }, '2026-08-05', TZ)).toBe(true);
  });

  it('is a no-op on something already live', () => {
    // NOT `{ pausedUntil: today }`. Writing the interval anyway would hand the
    // auto-age sweep a resume grace nobody earned — a 30-day-overdue item would
    // quietly stop being swept because an agent sent a redundant resume.
    expect(resolve(LIVE, { paused: false })).toEqual({ patch: {} });
  });

  it('refuses a bare pausedUntil on something not paused', () => {
    // It would change nothing. Returning 200 for a write with no effect is how
    // an agent concludes the schedule is set and moves on.
    const result = resolve(LIVE, { pausedUntil: '2026-09-01' });
    expect(result).toHaveProperty('reason');
  });
});

describe('resolvePauseWrite — nothing asked', () => {
  it('returns an empty patch when neither key is present', () => {
    expect(resolve(PAUSED, {})).toEqual({ patch: {} });
  });
});

describe('the pause verb at the schema boundary', () => {
  it.each([
    ['TaskUpdateSchema', TaskUpdateSchema],
    ['HabitUpdateSchema', HabitUpdateSchema],
    ['RoutineUpdateSchema', RoutineUpdateSchema],
  ])('%s accepts the verb', (_name, schema) => {
    expect(schema.safeParse({ paused: true }).success).toBe(true);
    expect(schema.safeParse({ paused: true, pausedUntil: '2026-09-01' }).success).toBe(true);
    expect(schema.safeParse({ paused: false }).success).toBe(true);
  });

  it.each([
    ['TaskUpdateSchema', TaskUpdateSchema],
    ['HabitUpdateSchema', HabitUpdateSchema],
    ['RoutineUpdateSchema', RoutineUpdateSchema],
  ])('%s rejects paused: false with a date', (_name, schema) => {
    // The plausible reading — "resume ON Sep 1" — is the one thing it does not
    // do, so silently honouring half of it is worse than refusing.
    expect(schema.safeParse({ paused: false, pausedUntil: '2026-09-01' }).success).toBe(false);
  });

  it('rejects a date that is not yyyy-MM-dd', () => {
    // These are compared LEXICALLY against toDateStr output, so a friendly
    // string does not error at read time — it resolves to the wrong side of
    // every boundary, forever.
    for (const bad of ['Sep 1', '2026-9-1', '2026-09-01T00:00:00Z', 'tomorrow']) {
      expect(TaskUpdateSchema.safeParse({ paused: true, pausedUntil: bad }).success).toBe(false);
    }
  });

  it('strips pausedAt — it is derived, never accepted', () => {
    // An agent-chosen lower bound is wrong in both directions: backdated it
    // erases history that happened, postdated the pause silently does nothing.
    const parsed = TaskUpdateSchema.parse({ paused: true, pausedAt: '2020-01-01T00:00:00Z' });
    expect(parsed).not.toHaveProperty('pausedAt');
  });

  it('leaves the create schemas alone — an item cannot be born paused', () => {
    // Not parity with the user, who has no such affordance either: there is no
    // UI that creates an already-invisible item.
    expect(TaskUpdateSchema.safeParse({ paused: true }).success).toBe(true);
  });
});

describe('season range and membership at the schema boundary', () => {
  it('accepts a well-formed season', () => {
    const parsed = SeasonCreateSchema.safeParse({
      name: 'Summer',
      state: 'auto',
      startsOn: '2026-06-01',
      endsOn: '2026-08-31',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an inverted range on create AND on update', () => {
    // Live on no date at all, while reading as "seasonal, out of season" —
    // indistinguishable from a season that will come back.
    const inverted = { name: 'Backwards', startsOn: '2026-08-31', endsOn: '2026-06-01' };
    expect(SeasonCreateSchema.safeParse(inverted).success).toBe(false);
    expect(SeasonUpdateSchema.safeParse(inverted).success).toBe(false);
  });

  it('accepts a half-open range in either direction', () => {
    expect(SeasonCreateSchema.safeParse({ name: 'A', startsOn: '2026-06-01' }).success).toBe(true);
    expect(SeasonCreateSchema.safeParse({ name: 'B', endsOn: '2026-08-31' }).success).toBe(true);
  });

  it('rejects a state outside the tri-state', () => {
    expect(SeasonCreateSchema.safeParse({ name: 'A', state: 'off' }).success).toBe(false);
  });

  it('REFUSES the pause verb on a season instead of silently dropping it', () => {
    // Zod strips unknown keys, which is right for a field that means nothing.
    // `paused` means something everywhere else in this API, so an agent that
    // learned it on routines will try it here — and a stripped key returns
    // 200 {success:true} with the season still live, which is how an agent
    // concludes the job is done. Same reasoning that rejects a bare
    // pausedUntil on an unpaused item.
    for (const schema of [SeasonCreateSchema, SeasonUpdateSchema]) {
      expect(schema.safeParse({ name: 'A', paused: true }).success).toBe(false);
      expect(schema.safeParse({ name: 'A', pausedUntil: '2026-09-01' }).success).toBe(false);
    }
    // …and the message names the control that does work.
    const err = SeasonUpdateSchema.safeParse({ paused: true });
    expect(err.success).toBe(false);
    expect(JSON.stringify(err.error?.issues)).toContain('state');
  });

  it('still accepts the tri-state that replaces it', () => {
    for (const state of ['auto', 'active', 'paused']) {
      expect(SeasonUpdateSchema.safeParse({ state }).success).toBe(true);
    }
  });

  it('requires membership ids to be uuids', () => {
    expect(SeasonCreateSchema.safeParse({ name: 'A', itemIds: ['not-a-uuid'] }).success).toBe(
      false
    );
    expect(RoutineCreateSchema.safeParse({ name: 'A', itemIds: ['nope'] }).success).toBe(false);
  });

  it('does not let a routine hold routines', () => {
    // Zod strips the unknown key rather than erroring, so assert on the OUTPUT:
    // the nesting must not survive into anything the db layer sees.
    const parsed = RoutineCreateSchema.parse({ name: 'A', routineIds: [crypto.randomUUID()] });
    expect(parsed).not.toHaveProperty('routineIds');
  });

  it('requires a name', () => {
    expect(RoutineCreateSchema.safeParse({}).success).toBe(false);
    expect(SeasonCreateSchema.safeParse({}).success).toBe(false);
    expect(RoutineCreateSchema.safeParse({ name: '' }).success).toBe(false);
  });
});

describe('withTrashedMembersKept', () => {
  /**
   * The plan's locked dangling-id rule: "member arrays may reference trashed
   * items … arrays are pruned only by the purge CASCADE, never eagerly."
   *
   * The UI honours it for free, editing the raw stored array. An agent cannot:
   * items[] on the wire is deleted_at-filtered, so a model rebuilding
   * membership from what it can SEE omits the trashed id, and whole-set
   * replacement then deletes its join row — silently, and unrecoverably,
   * because restoring the item afterwards returns it as a non-member.
   */
  const live = (...ids: string[]) => new Set(ids);

  it('adds back a member that is absent only because it is in the trash', () => {
    expect(withTrashedMembersKept(['a', 'c'], ['a', 'b'], live('a'))).toEqual(['a', 'c', 'b']);
  });

  it('still honours a deliberate removal of a LIVE member', () => {
    // 'b' is live and was left out, so the caller could see it and chose to
    // drop it. Keeping it would make removal impossible through the API.
    expect(withTrashedMembersKept(['a'], ['a', 'b'], live('a', 'b'))).toEqual(['a']);
  });

  it('returns the input untouched when nothing is being dropped', () => {
    const desired = ['a', 'b', 'c'];
    expect(withTrashedMembersKept(desired, ['a', 'b'], live('a', 'b'))).toBe(desired);
  });

  it('does not duplicate a trashed member the caller kept', () => {
    // The documented flow — echo the array context published, which INCLUDES
    // trashed ids. A duplicate here would make Postgres abort the whole upsert
    // with 21000 ("cannot affect row a second time").
    expect(withTrashedMembersKept(['a', 'b'], ['a', 'b'], live('a'))).toEqual(['a', 'b']);
  });

  it('handles clearing the whole set', () => {
    // itemIds: [] means "remove everyone" — everyone the caller could see.
    expect(withTrashedMembersKept([], ['a', 'b'], live('a'))).toEqual(['b']);
  });

  it('keeps several trashed members at once', () => {
    expect(withTrashedMembersKept(['a'], ['a', 'b', 'c'], live('a'))).toEqual(['a', 'b', 'c']);
  });
});
