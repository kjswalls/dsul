import { describe, it, expect } from 'vitest';
import { seasonBoundaries, boundaryLabel, seasonSuppressionOn } from '@/lib/season-boundaries';
import type { Item, Season, Routine } from '@dsul/types';

/**
 * The two things the grid says out loud about seasons: where a run of days
 * changes hands (the week rail) and what a single day is missing (the day
 * notice). Both are pure functions of dates and containers, which is the whole
 * reason they live outside the components.
 */

const season = (over: Partial<Season> = {}): Season => ({
  id: 'p', name: 'Summer', state: 'auto', itemIds: [], routineIds: [], ...over,
});

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: 'r', name: 'Morning', itemIds: [], ...over,
});

const task = (id: string, over: Partial<Item> = {}): Item =>
  ({
    type: 'task', id, title: id, status: 'pending', isScheduled: false, order: 0,
    completedDates: [], skippedDates: [], ...over,
  }) as Item;

const WEEK = [
  '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02',
  '2026-09-03', '2026-09-04', '2026-09-05',
];

const ctx = (seasons: Season[], routines: Routine[] = []) => ({
  userTimezone: 'UTC',
  routines,
  seasons,
});

describe('seasonBoundaries', () => {
  it('marks the first day AFTER an inclusive range ends', () => {
    const p = season({ endsOn: '2026-08-31' });
    const found = seasonBoundaries(WEEK, [p]);
    expect([...found.keys()]).toEqual(['2026-09-01']);
    expect(found.get('2026-09-01')!.ended).toEqual([p]);
    expect(found.get('2026-09-01')!.started).toEqual([]);
  });

  it('marks the day a range opens', () => {
    const p = season({ startsOn: '2026-09-02' });
    const found = seasonBoundaries(WEEK, [p]);
    expect([...found.keys()]).toEqual(['2026-09-02']);
    expect(found.get('2026-09-02')!.started).toEqual([p]);
  });

  // The first column has no rendered neighbour, so a marker there would be an
  // assertion the reader cannot check. Walk back a week and it appears in its
  // rightful place.
  it('never reports a boundary on the first date of the run', () => {
    const p = season({ startsOn: '2026-08-30' });
    expect(seasonBoundaries(WEEK, [p]).size).toBe(0);
  });

  it('reports a handover when one ends as another begins', () => {
    const out = season({ id: 'out', name: 'Summer', endsOn: '2026-08-31' });
    const inn = season({ id: 'in', name: 'Term', startsOn: '2026-09-01' });
    const found = seasonBoundaries(WEEK, [out, inn]);
    expect(found.size).toBe(1);
    expect(boundaryLabel(found.get('2026-09-01')!)).toBe('Summer → Term');
  });

  it('handles a season that flips twice inside one run', () => {
    const p = season({ startsOn: '2026-08-31', endsOn: '2026-09-02' });
    const found = seasonBoundaries(WEEK, [p]);
    expect([...found.keys()]).toEqual(['2026-08-31', '2026-09-03']);
  });

  // Manual states have no recorded history, so there is no honest date to place
  // a boundary at — they apply uniformly to every column.
  it('reports nothing for manually-set seasons', () => {
    expect(seasonBoundaries(WEEK, [season({ state: 'active', startsOn: '2026-09-02' })]).size).toBe(0);
    expect(seasonBoundaries(WEEK, [season({ state: 'paused', startsOn: '2026-09-02' })]).size).toBe(0);
  });

  it('labels a plain start and a plain end', () => {
    expect(boundaryLabel({ started: [season({ name: 'Term' })], ended: [] })).toBe('Term starts');
    expect(boundaryLabel({ started: [], ended: [season({ name: 'Summer' })] })).toBe('Summer ends');
  });
});

describe('seasonSuppressionOn', () => {
  const D = '2026-09-05';

  it('is null when every season is on', () => {
    const items = [task('a')];
    expect(seasonSuppressionOn(D, items, ctx([season({ itemIds: ['a'] })]))).toBeNull();
  });

  it('is null when an off season is hiding nothing', () => {
    const items = [task('a')];
    expect(seasonSuppressionOn(D, items, ctx([season({ state: 'paused' })]))).toBeNull();
  });

  it('counts what an off season is hiding and names it', () => {
    const items = [task('a'), task('b'), task('c')];
    const result = seasonSuppressionOn(
      D,
      items,
      ctx([season({ name: 'Summer', state: 'paused', itemIds: ['a', 'b'] })])
    );
    expect(result).not.toBeNull();
    expect(result!.hidden).toBe(2);
    expect(result!.seasons.map((p) => p.name)).toEqual(['Summer']);
  });

  it('counts items reached through a routine the season holds', () => {
    const items = [task('a')];
    const r = routine({ id: 'r1', itemIds: ['a'] });
    const result = seasonSuppressionOn(
      D,
      items,
      ctx([season({ state: 'paused', routineIds: ['r1'] })], [r])
    );
    expect(result!.hidden).toBe(1);
  });

  // The user's own pause is their decision about that row, and it already has a
  // home in the braindump's Paused section. Folding it in would make the
  // season look responsible for work it never touched.
  it('does NOT count items the user paused by hand', () => {
    const items = [task('a', { pausedAt: '2026-08-01T12:00:00Z' }), task('b')];
    const result = seasonSuppressionOn(
      D,
      items,
      ctx([season({ state: 'paused', itemIds: ['a', 'b'] })])
    );
    expect(result!.hidden).toBe(1);
  });

  // Same reasoning one layer down: a paused ROUTINE is its own explanation and
  // its own control.
  it('does NOT count items a paused routine was already hiding', () => {
    const items = [task('a')];
    const r = routine({ id: 'r1', itemIds: ['a'], pausedAt: '2026-08-01T12:00:00Z' });
    expect(seasonSuppressionOn(D, items, ctx([season({ state: 'paused' })], [r]))).toBeNull();
  });

  // History is never hidden, so it is never missing, so it is never counted.
  it('ignores items that already carry a mark for the day', () => {
    const items = [task('a', { status: 'completed' }), task('b')];
    const result = seasonSuppressionOn(
      D,
      items,
      ctx([season({ state: 'paused', itemIds: ['a', 'b'] })])
    );
    expect(result!.hidden).toBe(1);
  });

  it('resolves per date across the range boundary', () => {
    const items = [task('a')];
    const c = ctx([season({ itemIds: ['a'], startsOn: '2026-06-01', endsOn: '2026-08-31' })]);
    expect(seasonSuppressionOn('2026-08-31', items, c)).toBeNull();
    expect(seasonSuppressionOn('2026-09-01', items, c)!.hidden).toBe(1);
  });
});
