import { describe, expect, it } from 'vitest';
import { ATLAS_CARD_H, ATLAS_CARD_W, seedPlaces } from '@/lib/atlas-seed';
import type { AtlasCard, AtlasKind, AtlasMember } from '@/lib/atlas-model';
import type { Item } from '@/lib/planner-types';

/** Just the fields seeding reads. */
function card(kind: AtlasKind, id: string, memberIds: string[] = [], over: Partial<AtlasCard> = {}): AtlasCard {
  return {
    key: `${kind}:${id}`,
    kind,
    id,
    name: id,
    kindLabel: kind,
    color: 'var(--accent-1)',
    members: memberIds.map((m) => ({ item: { id: m } as Item, state: 'open', todayState: undefined }) as AtlasMember),
    tiles: [],
    moreTiles: 0,
    lit: 0,
    total: 0,
    next: null,
    openRows: [],
    allDone: true,
    nextOffersToday: false,
    touch: { kind: 'unknown' },
    resting: false,
    ...over,
  };
}

const VIEW = { w: 1600, h: 900 };

const overlap = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  a.x < b.x + ATLAS_CARD_W && b.x < a.x + ATLAS_CARD_W && a.y < b.y + ATLAS_CARD_H && b.y < a.y + ATLAS_CARD_H;

function noOverlaps(places: Record<string, { x: number; y: number }>) {
  const list = Object.entries(places);
  for (let i = 0; i < list.length; i += 1)
    for (let j = i + 1; j < list.length; j += 1)
      expect(overlap(list[i][1], list[j][1]), `${list[i][0]} vs ${list[j][0]}`).toBe(false);
}

describe('seedPlaces', () => {
  const cards = [
    card('goal', 'g1', ['a', 'b']),
    card('goal', 'g2', ['c']),
    card('project', 'feeds-g1', ['a', 'b', 'z']),
    card('project', 'feeds-g2', ['c']),
    card('project', 'loose', ['q']),
    card('season', 's', [], { routineIds: ['r1'] }),
    card('routine', 'r1', ['w']),
    card('routine', 'r2', ['v']),
  ];

  it('places every card, with no overlap', () => {
    const out = seedPlaces(cards, {}, VIEW);
    expect(Object.keys(out).sort()).toEqual(cards.map((c) => c.key).sort());
    noOverlaps(out);
  });

  it('puts goals in a left column and each feeder beside its goal', () => {
    const out = seedPlaces(cards, {}, VIEW);
    expect(out['goal:g1'].x).toBe(0);
    expect(out['goal:g2'].x).toBe(0);
    expect(out['goal:g2'].y).toBeGreaterThan(out['goal:g1'].y);
    expect(out['project:feeds-g1'].y).toBe(out['goal:g1'].y);
    expect(out['project:feeds-g1'].x).toBeGreaterThan(0);
    expect(out['project:feeds-g2'].y).toBe(out['goal:g2'].y);
  });

  it("puts a season's routine beside it", () => {
    const out = seedPlaces(cards, {}, VIEW);
    expect(out['routine:r1'].y).toBe(out['season:s'].y);
    expect(out['routine:r1'].x).toBeGreaterThan(out['season:s'].x);
  });

  it('is deterministic', () => {
    expect(seedPlaces(cards, {}, VIEW)).toEqual(seedPlaces(cards, {}, VIEW));
  });

  it('seeds only the unplaced, and never on top of a placed card', () => {
    const placed = { 'goal:g1': { x: 0, y: 0 }, 'project:loose': { x: 1500, y: 0 } };
    const out = seedPlaces(cards, placed, VIEW);
    expect(out['goal:g1']).toBeUndefined();
    expect(out['project:loose']).toBeUndefined();
    noOverlaps({ ...out, ...placed });
    // A placed card at an odd spot still blocks every cell it touches.
    const odd = { 'project:loose': { x: 130, y: 100 } };
    noOverlaps({ ...seedPlaces(cards, odd, VIEW), ...odd });
  });

  it('copes with a zero-size viewport and no cards', () => {
    expect(seedPlaces([], {}, VIEW)).toEqual({});
    const out = seedPlaces(cards, {}, { w: 0, h: 0 });
    noOverlaps(out);
    for (const p of Object.values(out)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});
