import { describe, expect, it } from 'vitest';
import {
  TIMELINE_DAY_PX,
  TIMELINE_MAX_MONTHS,
  dateForX,
  targetAllowed,
  timelinePlace,
  timelineWindow,
  xForDate,
} from '@/lib/atlas-timeline';
import { layoutPositions } from '@/lib/atlas-layouts';
import { TODAY, build, cardOf, goal, habit, project, routine, season, task } from './helpers/atlas-fixtures';

/** Timeline (design PR2): x and dates round trip, the inverted window is refused, the undated lane. */

describe('the window', () => {
  it('starts the month before today and runs at least three months on', () => {
    const w = timelineWindow(TODAY);
    expect(w.start).toBe('2026-02-01');
    expect(w.end).toBe('2026-06-30');
    expect(w.months.map((m) => m.label)).toEqual(['Feb', 'Mar', 'Apr', 'May', 'Jun']);
  });

  it('reaches two months past the latest date, clamped to 18 months', () => {
    expect(timelineWindow(TODAY, '2026-10-04').end).toBe('2026-12-31');
    const far = timelineWindow(TODAY, '2031-01-01');
    expect(far.months).toHaveLength(TIMELINE_MAX_MONTHS);
    expect(far.months.some((m) => m.label === 'Jan 2027')).toBe(true);
  });
});

describe('xForDate and dateForX', () => {
  const w = timelineWindow(TODAY, '2026-12-01');
  it('round trip on every day, and snap to a whole day', () => {
    for (const d of ['2026-02-01', '2026-03-10', '2026-07-04', '2026-12-31']) {
      expect(dateForX(w, xForDate(w, d))).toBe(d);
      expect(dateForX(w, xForDate(w, d) + TIMELINE_DAY_PX * 0.4)).toBe(d);
    }
  });
  it('keep a drop inside the window', () => {
    expect(dateForX(w, -5000)).toBe(w.start);
    expect(dateForX(w, 1e7)).toBe(w.end);
  });
});

describe('a target', () => {
  it('refuses the inverted window (a target before the goal starts)', () => {
    expect(targetAllowed({ startsOn: '2026-04-01' }, '2026-03-20')).toBe(false);
    expect(targetAllowed({ startsOn: '2026-04-01' }, '2026-04-01')).toBe(true);
    expect(targetAllowed({}, '2020-01-01')).toBe(true);
  });
});

describe('where cards sit', () => {
  const cards = build({
    items: [
      task({ id: 'a', project: 'Dated', startDate: '2026-04-02' }),
      task({ id: 'b', project: 'Undated' }),
      habit({ id: 'h' }),
    ],
    projects: [project('Dated'), project('Undated')],
    routines: [routine('r1', ['h'])],
    seasons: [season('s1', { state: 'auto', startsOn: '2026-03-01', endsOn: '2026-05-31' }), season('s2')],
    goals: [goal('g1', { targetOn: '2026-06-01' }), goal('g2')],
  });
  const seasons = new Map([
    ['s1', season('s1', { state: 'auto', startsOn: '2026-03-01', endsOn: '2026-05-31' })],
    ['s2', season('s2')],
  ]);

  it('sorts every kind into its lane, the undated ones into No dates', () => {
    expect(timelinePlace(cardOf(cards, 'project:p-Dated'), TODAY, seasons)).toEqual({ lane: 'dated', day: '2026-04-02', what: 'next' });
    expect(timelinePlace(cardOf(cards, 'project:p-Undated'), TODAY, seasons)).toEqual({ lane: 'none' });
    expect(timelinePlace(cardOf(cards, 'routine:r1'), TODAY, seasons)).toEqual({ lane: 'repeats' });
    expect(timelinePlace(cardOf(cards, 'goal:g1'), TODAY, seasons)).toEqual({ lane: 'goals', day: '2026-06-01' });
    expect(timelinePlace(cardOf(cards, 'goal:g2'), TODAY, seasons)).toEqual({ lane: 'none' });
    expect(timelinePlace(cardOf(cards, 'season:s2'), TODAY, seasons)).toEqual({ lane: 'none' });
  });

  it('lays out a season bar, a goal centred on its day, and the No dates row last', () => {
    const r = layoutPositions('timeline', cards, {
      places: {},
      bands: new Map(),
      seasons: [...seasons.values()],
      todayStr: TODAY,
    });
    const tl = r.timeline!;
    expect(tl.seasonBars.map((b) => b.key)).toEqual(['season:s1']);
    const g1 = r.positions.get('goal:g1')!;
    expect(dateForX(tl.window, g1.x + 130 - TIMELINE_DAY_PX / 2)).toBe('2026-06-01');
    const none = r.lanes.find((l) => l.id === 'tl:none')!;
    expect(r.positions.get('project:p-Undated')!.y).toBeGreaterThanOrEqual(none.rect.y);
    expect(none.rect.y).toBe(tl.noDatesY);
  });
});
