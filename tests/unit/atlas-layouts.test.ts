import { describe, expect, it } from 'vitest';
import {
  createPositionSharer,
  filterCards,
  isFinished,
  laneAt,
  layoutPositions,
  type AtlasLayoutCtx,
} from '@/lib/atlas-layouts';
import { momentumBand, type MomentumResult } from '@/lib/atlas-momentum';
import { laneFor } from '@/lib/atlas-by-goal';
import type { AtlasLayout } from '@/lib/view-store';
import { TODAY, build, goal, project, task } from './helpers/atlas-fixtures';

/**
 * Atlas's layouts (design PR2): Your map returns stored places; the computed
 * layouts are stable; the filters remove cards in every layout.
 */

const goals = [goal('g', { memberIds: ['a'] })];
const cards = build({
  items: [
    task({ id: 'a', project: 'Work', startDate: TODAY }),
    task({ id: 'b', project: 'Home' }),
    task({ id: 'c', project: 'Done', status: 'completed' }),
  ],
  projects: [project('Work'), project('Home'), project('Done')],
  goals,
});
const bands = new Map<string, MomentumResult>(
  cards.map((c) => [c.key, momentumBand(c, c.key === 'project:p-Home' ? '2025-12-01' : undefined, TODAY)])
);
const ctx: AtlasLayoutCtx = {
  places: { 'project:p-Work': { x: 10, y: 20 }, 'project:p-Home': { x: 400, y: 20 } },
  bands,
  lanes: new Map(cards.map((c) => [c.key, laneFor(c, goals)])),
  todayStr: TODAY,
};
const LAYOUTS: AtlasLayout[] = ['map', 'momentum', 'goal', 'timeline'];

describe('layoutPositions', () => {
  it('Your map returns the stored places, as they are', () => {
    const r = layoutPositions('map', cards, ctx);
    expect(r.positions.get('project:p-Work')).toBe(ctx.places['project:p-Work']);
    expect(r.positions.has('project:p-Done')).toBe(false);
    expect(r.lanes).toEqual([]);
  });

  it.each(LAYOUTS.filter((l) => l !== 'map'))('%s places every card, the same way twice', (layout) => {
    const a = layoutPositions(layout, cards, ctx);
    const b = layoutPositions(layout, cards, ctx);
    expect([...a.positions.keys()].sort()).toEqual(cards.map((c) => c.key).sort());
    expect([...a.positions.entries()]).toEqual([...b.positions.entries()]);
  });

  it('Momentum puts each card in its band column', () => {
    const r = layoutPositions('momentum', cards, ctx);
    const col = (key: string) => laneAt(r, 'momentum', r.positions.get(key)!)?.id;
    expect(col('project:p-Work')).toBe('now');
    expect(col('project:p-Home')).toBe('resting');
    const count = (b: string) => [...bands.values()].filter((x) => x.band === b).length;
    expect(r.lanes.map((l) => [l.id, l.count])).toEqual([
      ['now', count('now')],
      ['soon', count('soon')],
      ['resting', count('resting')],
    ]);
  });

  it('shares unchanged points, so untouched cards keep their props', () => {
    const share = createPositionSharer();
    const first = share(layoutPositions('momentum', cards, ctx).positions);
    const second = share(layoutPositions('momentum', cards, ctx).positions);
    for (const [k, p] of second) expect(p).toBe(first.get(k));
  });
});

describe('the filters', () => {
  it('Hide finished removes every-member-done and ended cards', () => {
    expect(isFinished(cards.find((c) => c.key === 'project:p-Done')!)).toBe(true);
    const left = filterCards(cards, { hideFinished: true, hideResting: false }, bands).map((c) => c.key);
    expect(left).not.toContain('project:p-Done');
  });

  it.each(LAYOUTS)('remove cards in %s', (layout) => {
    const kept = filterCards(cards, { hideFinished: true, hideResting: true }, bands);
    const r = layoutPositions(layout, kept, ctx);
    expect(r.positions.has('project:p-Done')).toBe(false);
    expect(r.positions.has('project:p-Home')).toBe(false);
    expect(r.positions.has('project:p-Work')).toBe(true);
  });

  it('leave the input as it is when both are off', () => {
    expect(filterCards(cards, { hideFinished: false, hideResting: false }, bands)).toBe(cards);
  });
});
