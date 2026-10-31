import { describe, expect, it } from 'vitest';
import {
  ATLAS_AURA_CELLS,
  ATLAS_FAR_TILE_CAP,
  ATLAS_GRID_PITCH,
  buildRelayGrid,
  cappedTiles,
  cellCenter,
  cellKey,
  cellOf,
  dotStride,
  liveness,
  waveAt,
  type RelayCluster,
} from '@/lib/atlas-relay-grid';

/**
 * The far zoom's geometry (design PR3, the Relay grid from
 * constellation.html): a tile per item on the board's own 26px grid, lit
 * first, then a 1.5-cell aura; collisions go to the nearer container.
 */

const P = ATLAS_GRID_PITCH;
const at = (key: string, i: number, j: number, tiles: number, lit = 0): RelayCluster => ({
  key,
  x: cellCenter(i),
  y: cellCenter(j),
  tiles,
  lit,
});

describe('atlas relay grid', () => {
  it('uses the board grid: 26px, a dot at each cell centre', () => {
    expect(P).toBe(26);
    expect(cellOf(0)).toBe(0);
    expect(cellOf(25.9)).toBe(0);
    expect(cellOf(26)).toBe(1);
    expect(cellOf(-1)).toBe(-1);
    expect(cellCenter(2)).toBe(65);
  });

  it('gives one tile per item, the lit ones innermost', () => {
    const g = buildRelayGrid([at('a', 10, 10, 7, 3)]);
    const tiles = g.tiles.filter((t) => t.key === 'a');
    expect(tiles).toHaveLength(7);
    const byRank = [...tiles].sort((x, y) => x.rank - y.rank);
    expect(byRank.map((t) => t.lit)).toEqual([true, true, true, false, false, false, false]);
    // Nearest first: ranks never get closer as they go.
    for (let k = 1; k < byRank.length; k++) expect(byRank[k].dist).toBeGreaterThanOrEqual(byRank[k - 1].dist);
    // The first tile is the cluster's own cell.
    expect(byRank[0]).toMatchObject({ i: 10, j: 10, dist: 0 });
  });

  it('puts an aura 1.5 cells past the outermost tile, fading out', () => {
    const g = buildRelayGrid([at('a', 0, 0, 5, 1)]);
    const reach = g.reach.get('a')!;
    expect(reach).toBeGreaterThan(0);
    const aura = g.aura.filter((c) => c.key === 'a');
    expect(aura.length).toBeGreaterThan(0);
    for (const c of aura) {
      expect(c.dist).toBeGreaterThan(0);
      expect(c.dist).toBeLessThanOrEqual(reach + ATLAS_AURA_CELLS);
      expect(c.da).toBeGreaterThanOrEqual(0);
      expect(c.da).toBeLessThanOrEqual(1);
      expect(c.d).toBeLessThanOrEqual(1);
    }
    // Further out is fainter.
    const near = aura.reduce((m, c) => (c.dist < m.dist ? c : m));
    const outer = aura.reduce((m, c) => (c.dist > m.dist ? c : m));
    expect(near.da).toBeLessThan(outer.da);
    // Nothing past the reach.
    expect(g.cells.has(cellKey(0, Math.ceil(reach + ATLAS_AURA_CELLS) + 1))).toBe(false);
  });

  it('gives a contested cell to the nearer container, and still a tile per item to each', () => {
    // Two clusters three cells apart, each wanting more cells than sit between them.
    const g = buildRelayGrid([at('a', 0, 0, 12, 4), at('b', 3, 0, 12, 4)]);
    expect(g.tiles.filter((t) => t.key === 'a')).toHaveLength(12);
    expect(g.tiles.filter((t) => t.key === 'b')).toHaveLength(12);
    // A tile cell is nearer (or as near) to its own cluster than to the other.
    for (const t of g.tiles) {
      const own = t.key === 'a' ? [0, 0] : [3, 0];
      const other = t.key === 'a' ? [3, 0] : [0, 0];
      expect(Math.hypot(t.i - own[0], t.j - own[1])).toBeLessThanOrEqual(Math.hypot(t.i - other[0], t.j - other[1]) + 1.5);
    }
    // The cells right beside each cluster are its own.
    expect(g.cells.get(cellKey(0, 0))!.key).toBe('a');
    expect(g.cells.get(cellKey(3, 0))!.key).toBe('b');
    // No cell is claimed twice.
    expect(g.tiles.length + g.aura.length).toBe(g.cells.size);
  });

  it('never lets an aura take a tile, and gives an aura cell to the nearer container', () => {
    const g = buildRelayGrid([at('a', 0, 0, 1), at('b', 4, 0, 1)]);
    // Between them, cell (1,0) is a's, (3,0) is b's.
    expect(g.cells.get(cellKey(1, 0))).toMatchObject({ key: 'a', role: 'aura' });
    expect(g.cells.get(cellKey(3, 0))).toMatchObject({ key: 'b', role: 'aura' });
    expect(g.cells.get(cellKey(0, 0))).toMatchObject({ key: 'a', role: 'tile' });
  });

  it('is deterministic', () => {
    const cs = [at('a', 0, 0, 9, 2), at('b', 5, 2, 4, 4), at('c', -3, 6, 15, 0)];
    const one = buildRelayGrid(cs);
    const two = buildRelayGrid(cs);
    expect([...two.cells.entries()]).toEqual([...one.cells.entries()]);
  });

  it('draws an empty container as an aura round its cell, with no tiles', () => {
    const g = buildRelayGrid([at('a', 0, 0, 0)]);
    expect(g.tiles).toHaveLength(0);
    expect(g.reach.get('a')).toBe(0);
    expect(g.cells.get(cellKey(0, 0))).toMatchObject({ role: 'aura', key: 'a' });
  });

  it('caps a huge container and keeps its lit share', () => {
    expect(cappedTiles(10, 4)).toEqual({ tiles: 10, lit: 4 });
    expect(cappedTiles(400, 100)).toEqual({ tiles: ATLAS_FAR_TILE_CAP, lit: 30 });
    expect(cappedTiles(3, 9)).toEqual({ tiles: 3, lit: 3 });
    const g = buildRelayGrid([at('a', 0, 0, 500, 0)]);
    expect(g.tiles).toHaveLength(ATLAS_FAR_TILE_CAP);
  });

  it('waves from the tiles out through the dots, only for a live container', () => {
    expect(waveAt(0.5, 0.5 / 1.4, 1)).toBeCloseTo(1);
    expect(waveAt(0.5, 0.5 / 1.4, 0.6)).toBeCloseTo(0.6);
    expect(waveAt(0.9, 0, 1)).toBe(0);
    expect(waveAt(0.5, 0.5 / 1.4, 0)).toBe(0);
  });

  it('runs the wave for a touch this week, never for resting or unknown', () => {
    expect(liveness({ kind: 'touched', days: 0 }, false)).toBe(1);
    expect(liveness({ kind: 'touched', days: 5 }, false)).toBe(0.6);
    expect(liveness({ kind: 'touched', days: 10 }, false)).toBe(0);
    expect(liveness({ kind: 'unknown' }, false)).toBe(0);
    expect(liveness({ kind: 'touched', days: 0 }, true)).toBe(0);
  });

  it('thins empty dots so they stay 7px apart when zoomed far out', () => {
    expect(dotStride(1)).toBe(1);
    expect(dotStride(0.3)).toBe(1);
    expect(dotStride(0.12)).toBe(3);
    expect(dotStride(0)).toBe(1);
  });

  it('builds 100 containers quickly', () => {
    const cs = Array.from({ length: 100 }, (_, n) => at(`c${n}`, (n % 10) * 11, Math.floor(n / 10) * 9, 3 + (n % 25), n % 4));
    const t0 = performance.now();
    const g = buildRelayGrid(cs);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(g.tiles.length).toBe(cs.reduce((s, c) => s + c.tiles, 0));
  });
});
