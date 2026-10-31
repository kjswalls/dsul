import { describe, expect, it } from 'vitest';
import { feedsOf, laneFor, linkableIds, unlinkPatches } from '@/lib/atlas-by-goal';
import { layoutPositions } from '@/lib/atlas-layouts';
import { TODAY, build, cardOf, goal, project, task } from './helpers/atlas-fixtures';

/**
 * By goal's lanes (design PR2): the goal holding most of a card's items as
 * feeders, ties to display order; subtasks never link; goals off, no lanes.
 */

const items = [
  task({ id: 'a', project: 'Work' }),
  task({ id: 'b', project: 'Work' }),
  task({ id: 'c', project: 'Work' }),
  task({ id: 'sub', project: 'Work', parentItemId: 'a' } as never),
];

describe('laneFor', () => {
  it('picks the goal holding most of the card as feeders', () => {
    const goals = [goal('g1', { memberIds: ['a'] }), goal('g2', { memberIds: ['b', 'c'] })];
    const card = cardOf(build({ items, projects: [project('Work')], goals }), 'project:p-Work');
    expect(laneFor(card, goals)).toBe('g2');
    expect(feedsOf(card, goals)).toEqual(['g1', 'g2']);
  });

  it('breaks a tie by the goals display order (live before ended, then as listed)', () => {
    const goals = [
      goal('done', { memberIds: ['a'], state: 'achieved' }),
      goal('first', { memberIds: ['b'] }),
      goal('second', { memberIds: ['c'] }),
    ];
    const card = cardOf(build({ items, projects: [project('Work')], goals }), 'project:p-Work');
    expect(laneFor(card, goals)).toBe('first');
  });

  it('a milestone alone does not put a card in the lane (unlink keeps milestones)', () => {
    const goals = [goal('g', { milestoneIds: ['a'] })];
    const card = cardOf(build({ items, projects: [project('Work')], goals }), 'project:p-Work');
    expect(laneFor(card, goals)).toBeNull();
  });

  it('a goal card heads its own lane', () => {
    const goals = [goal('g')];
    const card = cardOf(build({ items: [], goals }), 'goal:g');
    expect(laneFor(card, goals)).toBe('g');
  });
});

describe('linking', () => {
  it('never offers a subtask', () => {
    const card = cardOf(build({ items, projects: [project('Work')] }), 'project:p-Work');
    expect(linkableIds(card).sort()).toEqual(['a', 'b', 'c']);
  });

  it('unlink patches touch feeders only, in every goal that holds them', () => {
    const goals = [
      goal('g1', { memberIds: ['a', 'x'], milestoneIds: ['b'] }),
      goal('g2', { memberIds: ['c'] }),
      goal('g3', { memberIds: ['x'] }),
    ];
    const card = cardOf(build({ items, projects: [project('Work')], goals }), 'project:p-Work');
    expect(unlinkPatches(card, goals)).toEqual([
      { goalId: 'g1', memberIds: ['x'] },
      { goalId: 'g2', memberIds: [] },
    ]);
  });
});

describe('the By goal layout', () => {
  it('has no goal lanes with goals off, only "Not feeding a goal"', () => {
    const cards = build({ items, projects: [project('Work')], goals: [goal('g', { memberIds: ['a'] })], goalsAvailable: false });
    const r = layoutPositions('goal', cards, { places: {}, bands: new Map(), lanes: new Map(), todayStr: TODAY });
    expect(r.lanes.map((l) => l.kind)).toEqual(['none']);
  });

  it('draws a lane per goal card, with its feeders, then the rest', () => {
    const goals = [goal('g1', { memberIds: ['a', 'b'] })];
    const cards = build({
      items: [...items, task({ id: 'z', project: 'Home' })],
      projects: [project('Work'), project('Home')],
      goals,
    });
    const lanes = new Map(cards.map((c) => [c.key, laneFor(c, goals)]));
    const r = layoutPositions('goal', cards, { places: {}, bands: new Map(), lanes, todayStr: TODAY });
    expect(r.lanes.map((l) => [l.id, l.count])).toEqual([
      ['g1', 1],
      ['none', 1],
    ]);
    const g1 = r.lanes[0].rect;
    const work = r.positions.get('project:p-Work')!;
    expect(work.y).toBeGreaterThanOrEqual(g1.y);
    expect(work.y).toBeLessThan(g1.y + g1.h);
    expect(r.positions.get('project:p-Home')!.y).toBeGreaterThanOrEqual(r.lanes[1].rect.y);
  });
});
