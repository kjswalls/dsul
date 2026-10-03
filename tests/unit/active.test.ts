import { describe, it, expect } from 'vitest';
import {
  isPausedOn,
  isItemActiveOn,
  isOpenLoopOn,
  isOpenLoopSuppressedOn,
  inactiveItemIdsOn,
  suppressionReason,
  suppressionLabel,
  isSeasonActiveOn,
  routineStandingOn,
  type ActivationContext,
} from '@/lib/active';
import type { Item, Routine, Season } from '@dsul/types';

const ctx: ActivationContext = { userTimezone: 'America/New_York' };

const task = (over: Partial<Item> = {}): Item => ({
  type: 'task', id: 't', title: 'T', status: 'pending', isScheduled: false, order: 0,
  ...over,
} as Item);

const habit = (over: Partial<Item> = {}): Item => ({
  type: 'habit', id: 'h', title: 'H', project: 'G', streak: 0, status: 'pending',
  completedDates: [], skippedDates: [], dailyCounts: {}, repeatFrequency: 'daily',
  ...over,
} as Item);

// Noon UTC on Aug 10 is still Aug 10 in New York (08:00 EDT) — keeps the
// fixtures free of accidental timezone-boundary meaning.
const AUG10 = '2026-08-10T12:00:00Z';

describe('isPausedOn — interval bounds', () => {
  it('is false with no pausedAt', () => {
    expect(isPausedOn({}, '2026-08-15', ctx.userTimezone)).toBe(false);
    expect(isPausedOn({ pausedUntil: '2026-09-01' }, '2026-08-15', ctx.userTimezone)).toBe(false);
  });

  it('is true from the pause date onward when open-ended', () => {
    const p = { pausedAt: AUG10 };
    expect(isPausedOn(p, '2026-08-10', ctx.userTimezone)).toBe(true);
    expect(isPausedOn(p, '2027-01-01', ctx.userTimezone)).toBe(true);
  });

  // The lower bound is the whole reason pausedAt is stored. Without it, pausing
  // a daily habit today would blank every unmarked day of its history.
  it('does NOT reach back before the pause began', () => {
    const p = { pausedAt: AUG10 };
    expect(isPausedOn(p, '2026-08-09', ctx.userTimezone)).toBe(false);
    expect(isPausedOn(p, '2026-07-01', ctx.userTimezone)).toBe(false);
  });

  it('treats pausedUntil as EXCLUSIVE — live again on that date', () => {
    const p = { pausedAt: AUG10, pausedUntil: '2026-09-01' };
    expect(isPausedOn(p, '2026-08-31', ctx.userTimezone)).toBe(true);
    expect(isPausedOn(p, '2026-09-01', ctx.userTimezone)).toBe(false);
    expect(isPausedOn(p, '2026-09-02', ctx.userTimezone)).toBe(false);
  });

  // An expired pause must keep reading as "was paused during [start, until)",
  // with no cron and no cleanup write — that history is what the auto-age
  // sweep's resume grace reads.
  it('an expired interval still answers correctly for dates inside it', () => {
    const p = { pausedAt: AUG10, pausedUntil: '2026-08-20' };
    expect(isPausedOn(p, '2026-08-15', ctx.userTimezone)).toBe(true);
    expect(isPausedOn(p, '2026-08-25', ctx.userTimezone)).toBe(false);
  });

  it('a manual resume (pausedUntil = today) ends the pause today', () => {
    const p = { pausedAt: AUG10, pausedUntil: '2026-08-14' };
    expect(isPausedOn(p, '2026-08-13', ctx.userTimezone)).toBe(true);
    expect(isPausedOn(p, '2026-08-14', ctx.userTimezone)).toBe(false);
  });

  it('resolves the pause start in the USER timezone, not the runtime one', () => {
    // 01:00 UTC Aug 11 is still Aug 10 in New York, so Aug 10 is inside.
    const p = { pausedAt: '2026-08-11T01:00:00Z' };
    expect(isPausedOn(p, '2026-08-10', ctx.userTimezone)).toBe(true);
    expect(isPausedOn(p, '2026-08-10', 'Europe/Berlin')).toBe(false); // there it's the 11th
  });

  it('fails OPEN on a junk timestamp — never silently swallows an item', () => {
    expect(isPausedOn({ pausedAt: 'not-a-date' }, '2026-08-15', ctx.userTimezone)).toBe(false);
  });

  it('tolerates a full-ISO date string for the queried day', () => {
    const p = { pausedAt: AUG10, pausedUntil: '2026-09-01' };
    expect(isPausedOn(p, '2026-08-15T00:00:00.000Z', ctx.userTimezone)).toBe(true);
  });
});

describe('isOpenLoopOn — what still wants doing', () => {
  it('a recurring item with no mark is open', () => {
    expect(isOpenLoopOn(habit(), '2026-08-15')).toBe(true);
  });

  it('any mark closes the day: completed, skipped, or a tally', () => {
    expect(isOpenLoopOn(habit({ completedDates: ['2026-08-15'] }), '2026-08-15')).toBe(false);
    expect(isOpenLoopOn(habit({ skippedDates: ['2026-08-15'] }), '2026-08-15')).toBe(false);
    expect(isOpenLoopOn(habit({ dailyCounts: { '2026-08-15': 1 } }), '2026-08-15')).toBe(false);
  });

  // A counted habit is discharged by REACHING its target, not by being touched.
  // This read `> 0`, so one tally of a 3×-a-day habit closed the day while the
  // row still drew 1/3 — every surface asking this question was disagreeing
  // with the grid, and the streak still broke at midnight.
  it('a counted habit stays open until it reaches its target', () => {
    const water = (count: number) =>
      habit({ timesPerDay: 3, dailyCounts: { '2026-08-15': count } });
    expect(isOpenLoopOn(water(0), '2026-08-15')).toBe(true);
    expect(isOpenLoopOn(water(1), '2026-08-15')).toBe(true);
    expect(isOpenLoopOn(water(2), '2026-08-15')).toBe(true);
    expect(isOpenLoopOn(water(3), '2026-08-15')).toBe(false);
    // Over-tallying is still done, not re-opened.
    expect(isOpenLoopOn(water(4), '2026-08-15')).toBe(false);
  });

  // The guard that keeps this from being a behavior change for anything else.
  it('a habit with no target is still closed by a single tally', () => {
    expect(isOpenLoopOn(habit({ dailyCounts: { '2026-08-15': 1 } }), '2026-08-15')).toBe(false);
    expect(
      isOpenLoopOn(habit({ timesPerDay: 1, dailyCounts: { '2026-08-15': 1 } }), '2026-08-15'),
    ).toBe(false);
  });

  // Marking it done at the target writes completedDates, which short-circuits
  // above — so the two paths agree even if a count is missing.
  it('an explicit completion beats an incomplete tally', () => {
    const done = habit({
      timesPerDay: 3,
      dailyCounts: { '2026-08-15': 1 },
      completedDates: ['2026-08-15'],
    });
    expect(isOpenLoopOn(done, '2026-08-15')).toBe(false);
  });

  it('a mark on another day leaves today open', () => {
    expect(isOpenLoopOn(habit({ completedDates: ['2026-08-14'] }), '2026-08-15')).toBe(true);
  });

  it('a zero tally is not a mark', () => {
    expect(isOpenLoopOn(habit({ dailyCounts: { '2026-08-15': 0 } }), '2026-08-15')).toBe(true);
  });

  it('a one-shot task is open only while pending', () => {
    expect(isOpenLoopOn(task({ status: 'pending' }), '2026-08-15')).toBe(true);
    expect(isOpenLoopOn(task({ status: 'completed' }), '2026-08-15')).toBe(false);
    // Cancelled is terminal too — same reasoning selectOverdue uses.
    expect(isOpenLoopOn(task({ status: 'cancelled' }), '2026-08-15')).toBe(false);
  });

  it('a recurring TASK uses the per-date rule, not scalar status', () => {
    const t = task({ repeatFrequency: 'daily', status: 'pending', completedDates: ['2026-08-15'] });
    expect(isOpenLoopOn(t, '2026-08-15')).toBe(false);
    expect(isOpenLoopOn(t, '2026-08-16')).toBe(true);
  });
});

describe('isOpenLoopSuppressedOn — hide open loops, never history', () => {
  it('hides an unmarked occurrence inside the pause', () => {
    expect(isOpenLoopSuppressedOn(habit({ pausedAt: AUG10 }), '2026-08-15', ctx)).toBe(true);
  });

  // The worked example from locked decision 4: did it at 8am, paused at noon.
  it('KEEPS a day that was already marked', () => {
    const h = habit({ pausedAt: AUG10, completedDates: ['2026-08-15'] });
    expect(isOpenLoopSuppressedOn(h, '2026-08-15', ctx)).toBe(false);
  });

  it('keeps a skipped day too', () => {
    const h = habit({ pausedAt: AUG10, skippedDates: ['2026-08-15'] });
    expect(isOpenLoopSuppressedOn(h, '2026-08-15', ctx)).toBe(false);
  });

  it('never hides history from before the pause', () => {
    const h = habit({ pausedAt: AUG10 });
    expect(isOpenLoopSuppressedOn(h, '2026-08-01', ctx)).toBe(false);
  });

  it('stops hiding once the resume date arrives', () => {
    const h = habit({ pausedAt: AUG10, pausedUntil: '2026-09-01' });
    expect(isOpenLoopSuppressedOn(h, '2026-08-31', ctx)).toBe(true);
    expect(isOpenLoopSuppressedOn(h, '2026-09-01', ctx)).toBe(false);
  });

  it('keeps a completed one-off visible while paused', () => {
    const t = task({ pausedAt: AUG10, status: 'completed' });
    expect(isOpenLoopSuppressedOn(t, '2026-08-15', ctx)).toBe(false);
  });

  it('an unpaused item is never suppressed', () => {
    expect(isOpenLoopSuppressedOn(habit(), '2026-08-15', ctx)).toBe(false);
    expect(isOpenLoopSuppressedOn(task(), '2026-08-15', ctx)).toBe(false);
  });
});

describe('isItemActiveOn', () => {
  it('is liveness, NOT visibility — a marked-but-paused item is still inactive', () => {
    const h = habit({ pausedAt: AUG10, completedDates: ['2026-08-15'] });
    expect(isItemActiveOn(h, '2026-08-15', ctx)).toBe(false);
    expect(isOpenLoopSuppressedOn(h, '2026-08-15', ctx)).toBe(false);
  });

  it('an item with no pause state is active (today\'s behavior, unchanged)', () => {
    expect(isItemActiveOn(task(), '2026-08-15', ctx)).toBe(true);
  });
});

describe('inactiveItemIdsOn', () => {
  it('collects exactly the suppressed open loops', () => {
    const items = [
      task({ id: 'live' }),
      task({ id: 'paused', pausedAt: AUG10 }),
      habit({ id: 'paused-but-done', pausedAt: AUG10, completedDates: ['2026-08-15'] }),
      task({ id: 'resumed', pausedAt: AUG10, pausedUntil: '2026-08-12' }),
    ];
    expect(inactiveItemIdsOn(items, '2026-08-15', ctx)).toEqual(new Set(['paused']));
  });

  it('is date-parameterized — the same items answer differently per day', () => {
    const items = [habit({ id: 'h', pausedAt: AUG10, pausedUntil: '2026-09-01' })];
    expect(inactiveItemIdsOn(items, '2026-08-09', ctx).size).toBe(0); // before
    expect(inactiveItemIdsOn(items, '2026-08-15', ctx).size).toBe(1); // during
    expect(inactiveItemIdsOn(items, '2026-09-02', ctx).size).toBe(0); // after
  });

  it('is empty for a store with no paused items', () => {
    expect(inactiveItemIdsOn([task(), habit()], '2026-08-15', ctx).size).toBe(0);
  });
});

describe('suppressionReason', () => {
  it('is null when live, so !reason is the liveness check', () => {
    expect(suppressionReason(task(), '2026-08-15', ctx)).toBeNull();
  });

  it('reports the resume date when there is one', () => {
    const t = task({ pausedAt: AUG10, pausedUntil: '2026-09-01' });
    expect(suppressionReason(t, '2026-08-15', ctx)).toEqual({ kind: 'paused', until: '2026-09-01' });
  });

  it('reports an open-ended pause', () => {
    expect(suppressionReason(task({ pausedAt: AUG10 }), '2026-08-15', ctx))
      .toEqual({ kind: 'paused', until: undefined });
  });

  // Deliberately reports on marked days too: the item panel must explain why an
  // item is inactive even when today's row happens to still be rendering.
  it('reports for a paused item even on a day it still renders', () => {
    const h = habit({ pausedAt: AUG10, completedDates: ['2026-08-15'] });
    expect(suppressionReason(h, '2026-08-15', ctx)).not.toBeNull();
  });
});

/* ── routine paths (Phase 2) ──────────────────────────────────────────────── */

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: 'r', name: 'Morning', itemIds: [], ...over,
});

const withRoutines = (...routines: Routine[]): ActivationContext => ({
  userTimezone: 'America/New_York',
  routines,
});

describe('routine membership scopes an item', () => {
  const D = '2026-08-15';

  it('a live routine leaves its members alone', () => {
    const c = withRoutines(routine({ itemIds: ['h'] }));
    expect(isItemActiveOn(habit(), D, c)).toBe(true);
  });

  it('a paused routine suppresses its members, though nothing on them changed', () => {
    const c = withRoutines(routine({ itemIds: ['h'], pausedAt: AUG10 }));
    expect(isItemActiveOn(habit(), D, c)).toBe(false);
    expect(inactiveItemIdsOn([habit()], D, c)).toEqual(new Set(['h']));
  });

  it('leaves NON-members alone', () => {
    const c = withRoutines(routine({ itemIds: ['someone-else'], pausedAt: AUG10 }));
    expect(isItemActiveOn(habit(), D, c)).toBe(true);
    expect(inactiveItemIdsOn([habit()], D, c).size).toBe(0);
  });

  it('is date-parameterized like every other predicate', () => {
    const c = withRoutines(routine({ itemIds: ['h'], pausedAt: AUG10, pausedUntil: '2026-09-01' }));
    expect(isItemActiveOn(habit(), '2026-08-09', c)).toBe(true);  // before
    expect(isItemActiveOn(habit(), '2026-08-31', c)).toBe(false); // during
    expect(isItemActiveOn(habit(), '2026-09-01', c)).toBe(true);  // released, exclusive
  });

  it('ONE live path is enough — an item in two routines survives one being paused', () => {
    // The disjunctive rule, and the reason it is disjunctive: belonging to a
    // second routine is an additional reason to appear, never a new way to vanish.
    const c = withRoutines(
      routine({ id: 'r1', itemIds: ['h'], pausedAt: AUG10 }),
      routine({ id: 'r2', itemIds: ['h'] }),
    );
    expect(isItemActiveOn(habit(), D, c)).toBe(true);
    expect(inactiveItemIdsOn([habit()], D, c).size).toBe(0);
  });

  it('hides only when EVERY path is paused', () => {
    const c = withRoutines(
      routine({ id: 'r1', itemIds: ['h'], pausedAt: AUG10 }),
      routine({ id: 'r2', itemIds: ['h'], pausedAt: AUG10 }),
    );
    expect(isItemActiveOn(habit(), D, c)).toBe(false);
  });

  it('an item paused itself stays hidden even inside a live routine', () => {
    const c = withRoutines(routine({ itemIds: ['h'] }));
    expect(isItemActiveOn(habit({ pausedAt: AUG10 }), D, c)).toBe(false);
  });

  it('still hides only OPEN LOOPS — the history rule survives the container arm', () => {
    const c = withRoutines(routine({ itemIds: ['h'], pausedAt: AUG10 }));
    const done = habit({ completedDates: [D] });
    expect(isItemActiveOn(done, D, c)).toBe(false);          // not live…
    expect(isOpenLoopSuppressedOn(done, D, c)).toBe(false);  // …but not hidden either
    expect(inactiveItemIdsOn([done], D, c).size).toBe(0);
  });

  it('omitting routines entirely keeps Phase 1 behavior', () => {
    expect(isItemActiveOn(habit(), D, { userTimezone: 'UTC' })).toBe(true);
    expect(inactiveItemIdsOn([habit()], D, { userTimezone: 'UTC' }).size).toBe(0);
  });
});

describe('inactiveItemIdsOn agrees with isItemActiveOn', () => {
  // The bulk path inverts membership into a tally instead of scanning per item,
  // so it is a genuinely separate implementation of the same algebra. Drift
  // between them would mean the grid and the item dialog disagree about the
  // same item on the same day.
  const D = '2026-08-15';
  const cases: [string, ActivationContext][] = [
    ['no routines', { userTimezone: 'UTC' }],
    ['live routine', withRoutines(routine({ itemIds: ['h', 't'] }))],
    ['paused routine', withRoutines(routine({ itemIds: ['h', 't'], pausedAt: AUG10 }))],
    ['one of two paused', withRoutines(
      routine({ id: 'r1', itemIds: ['h'], pausedAt: AUG10 }),
      routine({ id: 'r2', itemIds: ['h'] }),
    )],
    ['expired pause', withRoutines(
      routine({ itemIds: ['h', 't'], pausedAt: AUG10, pausedUntil: '2026-08-12' }),
    )],
  ];

  for (const [label, c] of cases) {
    it(label, () => {
      const items = [habit(), task()];
      const bulk = inactiveItemIdsOn(items, D, c);
      for (const i of items) {
        const single = !isItemActiveOn(i, D, c) && isOpenLoopOn(i, D);
        expect(bulk.has(i.id)).toBe(single);
      }
    });
  }
});

describe('suppressionReason names the container', () => {
  const D = '2026-08-15';

  it('reports the routine when the routine is what hides it', () => {
    const r = routine({ name: 'Morning', itemIds: ['h'], pausedAt: AUG10, pausedUntil: '2026-09-01' });
    expect(suppressionReason(habit(), D, withRoutines(r)))
      .toEqual({ kind: 'routine', routine: r, until: '2026-09-01' });
  });

  it("prefers the item's OWN pause — that is the control its Resume undoes", () => {
    const r = routine({ itemIds: ['h'], pausedAt: AUG10 });
    expect(suppressionReason(habit({ pausedAt: AUG10 }), D, withRoutines(r)))
      .toEqual({ kind: 'paused', until: undefined });
  });

  it('names the routine that comes back SOONEST', () => {
    const late = routine({ id: 'late', name: 'Late', itemIds: ['h'], pausedAt: AUG10, pausedUntil: '2026-10-01' });
    const soon = routine({ id: 'soon', name: 'Soon', itemIds: ['h'], pausedAt: AUG10, pausedUntil: '2026-09-01' });
    const reason = suppressionReason(habit(), D, withRoutines(late, soon));
    expect(reason).toEqual({ kind: 'routine', routine: soon, until: '2026-09-01' });
  });

  it('an open-ended pause loses to any dated one', () => {
    const openEnded = routine({ id: 'open', itemIds: ['h'], pausedAt: AUG10 });
    const dated = routine({ id: 'dated', itemIds: ['h'], pausedAt: AUG10, pausedUntil: '2026-09-01' });
    const reason = suppressionReason(habit(), D, withRoutines(openEnded, dated));
    expect(reason).toMatchObject({ kind: 'routine', until: '2026-09-01' });
  });

  it('is null while any path is live', () => {
    const c = withRoutines(
      routine({ id: 'r1', itemIds: ['h'], pausedAt: AUG10 }),
      routine({ id: 'r2', itemIds: ['h'] }),
    );
    expect(suppressionReason(habit(), D, c)).toBeNull();
  });
});

/* ── season paths (Phase 3) ──────────────────────────────────────────────── */

const season = (over: Partial<Season> = {}): Season => ({
  id: 'p', name: 'Summer', state: 'auto', itemIds: [], routineIds: [], ...over,
});

const withSeasons = (...seasons: Season[]): ActivationContext => ({
  userTimezone: 'America/New_York',
  seasons,
});

const withBoth = (routines: Routine[], seasons: Season[]): ActivationContext => ({
  userTimezone: 'America/New_York',
  routines,
  seasons,
});

describe('isSeasonActiveOn — the tri-state', () => {
  const D = '2026-08-15';

  it("'active' ignores the range entirely", () => {
    const p = season({ state: 'active', startsOn: '2030-01-01', endsOn: '2030-02-01' });
    expect(isSeasonActiveOn(p, D)).toBe(true);
  });

  it("'paused' ignores the range entirely", () => {
    const p = season({ state: 'paused', startsOn: '2026-01-01', endsOn: '2026-12-31' });
    expect(isSeasonActiveOn(p, D)).toBe(false);
  });

  it("'auto' with no range is always on", () => {
    expect(isSeasonActiveOn(season(), D)).toBe(true);
    expect(isSeasonActiveOn(season(), '1999-01-01')).toBe(true);
  });

  // Inclusive at BOTH ends, unlike a pause's exclusive upper bound. "Jun 1 to
  // Aug 31" is a period you are inside; "paused until Sep 1" is a date you come
  // back on. The two read differently, so they resolve differently.
  it('an auto range is inclusive at both ends', () => {
    const p = season({ startsOn: '2026-06-01', endsOn: '2026-08-31' });
    expect(isSeasonActiveOn(p, '2026-05-31')).toBe(false);
    expect(isSeasonActiveOn(p, '2026-06-01')).toBe(true);
    expect(isSeasonActiveOn(p, '2026-08-31')).toBe(true);
    expect(isSeasonActiveOn(p, '2026-09-01')).toBe(false);
  });

  it('an open end runs forever, an open start runs from the beginning', () => {
    expect(isSeasonActiveOn(season({ startsOn: '2026-06-01' }), '2099-01-01')).toBe(true);
    expect(isSeasonActiveOn(season({ endsOn: '2026-08-31' }), '1999-01-01')).toBe(true);
  });
});

describe('season membership scopes an item', () => {
  const D = '2026-08-15';

  it("a direct member rides its season's state", () => {
    expect(isItemActiveOn(habit(), D, withSeasons(season({ itemIds: ['h'] })))).toBe(true);
    expect(
      isItemActiveOn(habit(), D, withSeasons(season({ itemIds: ['h'], state: 'paused' })))
    ).toBe(false);
  });

  it('a non-member is untouched by a season that is off', () => {
    const c = withSeasons(season({ itemIds: ['someone-else'], state: 'paused' }));
    expect(isItemActiveOn(habit(), D, c)).toBe(true);
  });

  // The path shape that carries the design: item -> routine -> season.
  it('reaches an item through a routine the season holds', () => {
    const r = routine({ id: 'r1', itemIds: ['h'] });
    const c = withBoth([r], [season({ routineIds: ['r1'], state: 'paused' })]);
    expect(isItemActiveOn(habit(), D, c)).toBe(false);
  });

  it('a path through a routine needs BOTH containers on', () => {
    const paused = routine({ id: 'r1', itemIds: ['h'], pausedAt: AUG10 });
    const c = withBoth([paused], [season({ routineIds: ['r1'], state: 'active' })]);
    expect(isItemActiveOn(habit(), D, c)).toBe(false);
  });

  // The standalone rule, and the attach discontinuity it produces — the one
  // membership write the manager confirms before committing.
  it('a routine in NO season answers for itself; joining one hands that over', () => {
    const r = routine({ id: 'r1', itemIds: ['h'] });
    expect(isItemActiveOn(habit(), D, withBoth([r], [season({ id: 'p1', state: 'paused' })])))
      .toBe(true);
    expect(
      isItemActiveOn(
        habit(),
        D,
        withBoth([r], [season({ id: 'p1', state: 'paused', routineIds: ['r1'] })])
      )
    ).toBe(false);
  });

  // Disjunctive across paths: a second container is another reason to appear,
  // never a new way to vanish.
  it('one live path is enough, whatever kind it is', () => {
    const c = withBoth(
      [routine({ id: 'r1', itemIds: ['h'] })],
      [
        season({ id: 'off', state: 'paused', routineIds: ['r1'] }),
        season({ id: 'on', state: 'active', itemIds: ['h'] }),
      ]
    );
    expect(isItemActiveOn(habit(), D, c)).toBe(true);
  });

  it("the item's own pause still beats every live path", () => {
    const c = withSeasons(season({ itemIds: ['h'], state: 'active' }));
    expect(isItemActiveOn(habit({ pausedAt: AUG10 }), D, c)).toBe(false);
  });

  // Trashed containers are absent from these arrays, and that absence IS the
  // mechanism: a season in the trash stops scoping, so a routine it was the
  // only holder of falls back to standalone and its members return.
  //
  // Asserted as a DIFFERENCE, not as a single `true`. The trashed half alone
  // passes with the whole path algebra reverted — it is just "a standalone
  // routine is live", which Phase 2 already guaranteed — so it has to be shown
  // against the live-season case it is supposed to differ from.
  it('a trashed season releases the routine it was the only holder of', () => {
    const r = routine({ id: 'r1', itemIds: ['h'] });
    const held = season({ id: 'p1', state: 'paused', routineIds: ['r1'] });
    expect(isItemActiveOn(habit(), D, withBoth([r], [held]))).toBe(false);
    expect(isItemActiveOn(habit(), D, withBoth([r], []))).toBe(true);
  });

  it('resolves per date across a range boundary', () => {
    const c = withSeasons(
      season({ itemIds: ['h'], startsOn: '2026-06-01', endsOn: '2026-08-31' })
    );
    expect(isItemActiveOn(habit(), '2026-08-31', c)).toBe(true);
    expect(isItemActiveOn(habit(), '2026-09-01', c)).toBe(false);
  });
});

describe('inactiveItemIdsOn agrees with isItemActiveOn on season paths', () => {
  const D = '2026-08-15';
  const items = [habit(), task({ id: 't' })];

  const cases: [string, ActivationContext][] = [
    ['direct, live', withSeasons(season({ itemIds: ['h', 't'] }))],
    ['direct, off', withSeasons(season({ itemIds: ['h', 't'], state: 'paused' }))],
    ['out of range', withSeasons(season({ itemIds: ['h', 't'], startsOn: '2026-09-01' }))],
    [
      'via routine, season off',
      withBoth(
        [routine({ id: 'r1', itemIds: ['h', 't'] })],
        [season({ routineIds: ['r1'], state: 'paused' })]
      ),
    ],
    [
      'via routine, routine paused',
      withBoth(
        [routine({ id: 'r1', itemIds: ['h', 't'], pausedAt: AUG10 })],
        [season({ routineIds: ['r1'], state: 'active' })]
      ),
    ],
    [
      'standalone routine beside an off season it is not in',
      withBoth([routine({ id: 'r1', itemIds: ['h', 't'] })], [season({ id: 'p1', state: 'paused' })]),
    ],
    [
      'two paths, one live',
      withBoth(
        [routine({ id: 'r1', itemIds: ['h', 't'] })],
        [
          season({ id: 'off', state: 'paused', routineIds: ['r1'] }),
          season({ id: 'on', state: 'active', itemIds: ['h', 't'] }),
        ]
      ),
    ],
    [
      'a routine held by TWO seasons, one on',
      withBoth(
        [routine({ id: 'r1', itemIds: ['h', 't'] })],
        [
          season({ id: 'off', state: 'paused', routineIds: ['r1'] }),
          season({ id: 'on', state: 'active', routineIds: ['r1'] }),
        ]
      ),
    ],
  ];

  // The bulk path inverts membership once for speed instead of walking each
  // item's paths, so it is a SECOND implementation of the same algebra — and a
  // second implementation is exactly the thing that drifts. Every case asserts
  // against the single-item resolver rather than a hand-written expectation, so
  // the two cannot disagree without failing here.
  it.each(cases)('%s', (_label, c) => {
    const bulk = inactiveItemIdsOn(items, D, c);
    for (const item of items) {
      expect(bulk.has(item.id)).toBe(!isItemActiveOn(item, D, c) && isOpenLoopOn(item, D));
    }
  });
});

describe('suppressionReason names the BINDING container', () => {
  const D = '2026-08-15';

  it('names a season that holds the item directly', () => {
    const p = season({ itemIds: ['h'], state: 'paused' });
    expect(suppressionReason(habit(), D, withSeasons(p))).toEqual({
      kind: 'season',
      season: p,
      routine: undefined,
      until: undefined,
    });
  });

  it('gives a return date for an auto season that has not started', () => {
    const p = season({ itemIds: ['h'], startsOn: '2026-09-01' });
    expect(suppressionReason(habit(), D, withSeasons(p))).toMatchObject({
      kind: 'season',
      until: '2026-09-01',
    });
  });

  it('gives NO return date for a season that has ended — it is over, not pending', () => {
    const p = season({ itemIds: ['h'], endsOn: '2026-08-01' });
    expect(suppressionReason(habit(), D, withSeasons(p))).toMatchObject({
      kind: 'season',
      until: undefined,
    });
  });

  // An inverted range is live on NO date: every day before startsOn fails the
  // start test and every day after endsOn fails the end test, and those two
  // sets cover the calendar. So its start is not a return date — it is a date
  // on which nothing will happen, and promising it is the exact failure the
  // binding-constraint rule exists to prevent.
  it('promises no return date for an inverted range', () => {
    const p = season({ itemIds: ['h'], startsOn: '2026-09-01', endsOn: '2026-08-01' });
    expect(isSeasonActiveOn(p, '2026-08-15')).toBe(false);
    expect(isSeasonActiveOn(p, '2026-09-15')).toBe(false);
    expect(suppressionReason(habit(), D, withSeasons(p))).toMatchObject({
      kind: 'season',
      until: undefined,
    });
  });

  // Why the binding constraint wins: naming the one that clears FIRST would
  // promise a return the item will not honour — the user resumes the routine on
  // the strength of the note and nothing appears.
  it('when both block, names the one that clears LAST', () => {
    const r = routine({
      id: 'r1', name: 'Morning', itemIds: ['h'], pausedAt: AUG10, pausedUntil: '2026-08-20',
    });
    const p = season({ id: 'p1', routineIds: ['r1'], startsOn: '2026-09-01' });
    expect(suppressionReason(habit(), D, withBoth([r], [p]))).toMatchObject({
      kind: 'season',
      until: '2026-09-01',
    });

    const laterRoutine = routine({ ...r, pausedUntil: '2026-10-01' });
    expect(suppressionReason(habit(), D, withBoth([laterRoutine], [p]))).toMatchObject({
      kind: 'routine',
      until: '2026-10-01',
    });
  });

  it('an unknown return counts as latest of all', () => {
    // The routine is open-ended and the season comes back on a date, so the
    // routine is what actually holds this item down.
    const r = routine({ id: 'r1', itemIds: ['h'], pausedAt: AUG10 });
    const p = season({ id: 'p1', routineIds: ['r1'], startsOn: '2026-09-01' });
    expect(suppressionReason(habit(), D, withBoth([r], [p]))).toMatchObject({
      kind: 'routine',
      until: undefined,
    });
  });

  it('across paths, names the one that comes back SOONEST', () => {
    const soon = season({ id: 'soon', name: 'Soon', itemIds: ['h'], startsOn: '2026-09-01' });
    const late = season({ id: 'late', name: 'Late', itemIds: ['h'], startsOn: '2026-10-01' });
    expect(suppressionReason(habit(), D, withSeasons(late, soon))).toMatchObject({
      kind: 'season',
      until: '2026-09-01',
    });
  });

  it('carries the routine on an indirect path so copy can name both', () => {
    const r = routine({ id: 'r1', name: 'Morning', itemIds: ['h'] });
    const p = season({ id: 'p1', routineIds: ['r1'], state: 'paused' });
    expect(suppressionReason(habit(), D, withBoth([r], [p]))).toMatchObject({
      kind: 'season',
      routine: r,
    });
  });

  it('is null while any path is live', () => {
    const c = withSeasons(
      season({ id: 'off', itemIds: ['h'], state: 'paused' }),
      season({ id: 'on', itemIds: ['h'], state: 'active' })
    );
    expect(suppressionReason(habit(), D, c)).toBeNull();
  });
});

describe('suppressionLabel — one definition for three surfaces', () => {
  it('states the cause without apologising for it', () => {
    expect(suppressionLabel({ kind: 'paused' })).toBe('Paused');
    expect(suppressionLabel({ kind: 'paused', until: '2026-09-01' })).toBe('Paused until Sep 1');
  });

  it('uses the article-and-noun copy rule only in the long form', () => {
    const r = routine({ name: 'Morning' });
    expect(suppressionLabel({ kind: 'routine', routine: r })).toBe('Hidden with Morning');
    expect(
      suppressionLabel({ kind: 'routine', routine: r, until: '2026-09-01' }, { long: true })
    ).toBe('Hidden with your Morning routine until Sep 1');

    const p = season({ name: 'Summer' });
    expect(suppressionLabel({ kind: 'season', season: p })).toBe('Hidden with Summer');
    expect(
      suppressionLabel({ kind: 'season', season: p, until: '2026-09-01' }, { long: true })
    ).toBe('Hidden with your Summer season until Sep 1');
  });

  // Formatted from the string, never through `new Date('2026-09-01')` — that
  // overload parses UTC midnight and prints the PREVIOUS day west of Greenwich.
  it('formats a day without going through an instant', () => {
    expect(suppressionLabel({ kind: 'paused', until: '2026-01-01' })).toBe('Paused until Jan 1');
    expect(suppressionLabel({ kind: 'paused', until: '2026-12-31' })).toBe('Paused until Dec 31');
  });
});

/**
 * routineStandingOn — the one derivation of local-vs-effective, shared by the
 * ScopeRail and the Organize console's routine detail.
 *
 * It exists because those two surfaces DID disagree: the console resolved the
 * routine's own pause and nothing else, so a routine held off by a season read
 * `Active` there and `off` two columns away. A rule this easy to half-implement
 * needs one home and a test on that home, not a test on each caller.
 */
describe('routineStandingOn — local vs effective', () => {
  const TZ = 'America/New_York';
  const D = '2026-08-15';
  const held = (...ids: string[]) => ({ routineIds: ids });

  it('answers for itself when no season holds it', () => {
    const s = routineStandingOn(routine({ id: 'r' }), [], D, TZ);
    expect(s.localOn).toBe(true);
    expect(s.effectiveOn).toBe(true);
    expect(s.holders).toEqual([]);
    expect(s.soonestBlocker).toBeUndefined();
  });

  it('is off both ways when its own switch is off', () => {
    const s = routineStandingOn(
      routine({ id: 'r', pausedAt: '2026-08-01T00:00:00Z' }),
      [season({ id: 'p', ...held('r'), state: 'active' })],
      D,
      TZ,
    );
    expect(s.localOn).toBe(false);
    // A live holder does NOT override the routine's own pause — the two are
    // conjunctive downward, disjunctive across holders.
    expect(s.effectiveOn).toBe(false);
  });

  it('SPLITS when the routine is on and its only holder is off', () => {
    // The case the console was blind to, and the reason for the whole split.
    const s = routineStandingOn(
      routine({ id: 'r' }),
      [season({ id: 'p', ...held('r'), state: 'paused' })],
      D,
      TZ,
    );
    expect(s.localOn).toBe(true);
    expect(s.effectiveOn).toBe(false);
    expect(s.blockers.map((p) => p.id)).toEqual(['p']);
  });

  it('is carried by ANY live holder, however many are off', () => {
    const s = routineStandingOn(
      routine({ id: 'r' }),
      [
        season({ id: 'off1', ...held('r'), state: 'paused' }),
        season({ id: 'off2', ...held('r'), state: 'paused' }),
        season({ id: 'on', ...held('r'), state: 'active' }),
      ],
      D,
      TZ,
    );
    expect(s.effectiveOn).toBe(true);
    // The off ones are still reported — they are blocked, just not blocking —
    // so a caller can say "2 of these 3 are off" without re-deriving it.
    expect(s.blockers.map((p) => p.id)).toEqual(['off1', 'off2']);
  });

  it('ignores seasons that do not hold it', () => {
    const s = routineStandingOn(
      routine({ id: 'r' }),
      [season({ id: 'other', ...held('someone-else'), state: 'paused' })],
      D,
      TZ,
    );
    expect(s.holders).toEqual([]);
    expect(s.effectiveOn).toBe(true);
  });

  /**
   * BOTH ARRAY ORDERS, every time, and that is not belt-and-braces.
   *
   * The comparator has two undefined branches — `!da` and `!db` — and a
   * two-element sort only ever calls it once, in whichever direction the engine
   * happens to pick. A single fixture therefore exercises ONE branch and leaves
   * the other free to say anything at all, including the opposite thing. That is
   * not hypothetical: inverting `!da` alone left this suite entirely green.
   *
   * Asserting the same answer from both input orders is also the real contract —
   * `blockers` comes out of a `.filter` over store order, so which one arrives
   * first is an accident of how the user created their seasons.
   */
  const rankedFirst = (...seasons: Season[]) => {
    const forward = routineStandingOn(routine({ id: 'r' }), seasons, D, TZ);
    const reverse = routineStandingOn(routine({ id: 'r' }), [...seasons].reverse(), D, TZ);
    // A comparator that answers differently depending on input order is broken
    // even when one of the answers is the one you wanted.
    expect(forward.soonestBlocker?.id).toBe(reverse.soonestBlocker?.id);
    return forward.soonestBlocker?.id;
  };

  it('ranks the soonest RETURN, not the first in the array', () => {
    // Disjunctive: the FIRST holder back carries the routine, so the earliest
    // return is the honest date to show.
    expect(
      rankedFirst(
        season({ id: 'late', ...held('r'), startsOn: '2026-12-01' }),
        season({ id: 'soon', ...held('r'), startsOn: '2026-09-01' }),
      ),
    ).toBe('soon');
  });

  it('sorts a holder with no return date LAST, never first', () => {
    // A manually paused season has no scheduled return by construction.
    // Letting it win the ranking would name the one thing that will never
    // arrive on its own as the thing to wait for.
    expect(
      rankedFirst(
        season({ id: 'manual', ...held('r'), state: 'paused' }),
        season({ id: 'dated', ...held('r'), startsOn: '2026-09-01' }),
      ),
    ).toBe('dated');
  });

  it('keeps the ranking honest with three, where the sort really sorts', () => {
    // Two elements is one comparison; three forces the engine through both
    // branches whichever direction it starts from.
    expect(
      rankedFirst(
        season({ id: 'manual', ...held('r'), state: 'paused' }),
        season({ id: 'late', ...held('r'), startsOn: '2026-12-01' }),
        season({ id: 'soon', ...held('r'), startsOn: '2026-09-01' }),
      ),
    ).toBe('soon');
  });

  it('still names a blocker when none of them has a date', () => {
    const s = routineStandingOn(
      routine({ id: 'r' }),
      [
        season({ id: 'a', ...held('r'), state: 'paused' }),
        season({ id: 'b', ...held('r'), state: 'paused' }),
      ],
      D,
      TZ,
    );
    // Undefined here would silently drop the whole note at the call site.
    expect(s.soonestBlocker?.id).toBe('a');
  });

  it('agrees with the resolver about the item underneath', () => {
    /**
     * The property that matters more than any individual field: if this says
     * `effectiveOn`, the item resolver must agree the member is live. Two
     * separate implementations of the disjunctive rule is exactly how the
     * console and the rail drifted apart in the first place.
     */
    const item = habit({ id: 'i' });
    const r = routine({ id: 'r', itemIds: ['i'] });
    const cases: Season[][] = [
      [],
      [season({ id: 'p', ...held('r'), state: 'paused' })],
      [season({ id: 'p', ...held('r'), state: 'active' })],
      [
        season({ id: 'a', ...held('r'), state: 'paused' }),
        season({ id: 'b', ...held('r'), state: 'active' }),
      ],
      [season({ id: 'p', ...held('r'), startsOn: '2026-09-01' })],
    ];
    for (const seasons of cases) {
      const standing = routineStandingOn(r, seasons, D, TZ);
      const live = isItemActiveOn(item, D, { userTimezone: TZ, routines: [r], seasons });
      expect(standing.effectiveOn).toBe(live);
    }
  });
});
