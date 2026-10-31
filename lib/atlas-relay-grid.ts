/**
 * The far zoom's geometry (design PR3, Kirby's "Relay grid" pick from
 * project-canvas/constellation.html): the board's own dot grid, where each
 * container's nearest cells turn into relay tiles, one per item, lit first,
 * and the next 1.5 cells of dots catch its colour and fade out.
 *
 * Pure and deterministic: the same clusters always give the same cells, so the
 * canvas can cache it and a test can pin it. World coordinates throughout.
 *
 * Cell (i, j) is the grid square [i*P, (i+1)*P) x [j*P, (j+1)*P), and its dot
 * sits at the square's centre, where the zoomed-in board's CSS dot grid draws
 * it (a radial gradient centred in each background tile), so the two grids
 * line up through the zoom handoff.
 *
 * Collisions go to the nearer container. Tiles are handed out in one pass
 * over every container's candidate cells, nearest first, so two crowded
 * clusters split the cells between them by distance and each still gets
 * exactly one tile per item (a cluster short of room reaches further out).
 * Aura dots come after: a cell already a tile stays one, and an aura cell
 * goes to whichever container is nearer.
 */

/** The dot grid's pitch in world pixels: the board's and the far zoom's. */
export const ATLAS_GRID_PITCH = 26;

/** How many cells past its outermost tile a container's colour reaches. */
export const ATLAS_AURA_CELLS = 1.5;

/**
 * The most tiles one container draws. A project of 400 steps would otherwise
 * be a field of its own; past this the tiles keep the lit share.
 */
export const ATLAS_FAR_TILE_CAP = 120;

export interface RelayCluster {
  key: string;
  /** World centre. */
  x: number;
  y: number;
  /** Tiles: one per item. */
  tiles: number;
  /** How many of them are lit (done). Lit tiles take the inner cells. */
  lit: number;
}

export interface RelayCell {
  i: number;
  j: number;
  /** World centre of the cell (its dot). */
  x: number;
  y: number;
  /** The cluster that owns it. */
  key: string;
  role: 'tile' | 'aura';
  /** Tiles: 0 for the innermost; below the cluster's `lit` means lit. */
  rank: number;
  lit: boolean;
  /** Distance from the cluster's cell in cells. */
  dist: number;
  /** Distance over the aura's reach, 0 at the centre to 1 at the edge: the wave's clock. */
  d: number;
  /** Aura only: 0 at the outermost tile to 1 at the aura's edge, the fade. */
  da: number;
}

export interface RelayGrid {
  pitch: number;
  /** Every claimed cell, by `cellKey(i, j)`. */
  cells: Map<string, RelayCell>;
  tiles: RelayCell[];
  aura: RelayCell[];
  /** Per cluster: its outermost tile's distance in cells (0 with no tiles). */
  reach: Map<string, number>;
  /** Per cluster: its tiles and aura, for drawing one cluster at a time. */
  byCluster: Map<string, RelayCell[]>;
}

export const cellKey = (i: number, j: number) => `${i},${j}`;

/** The cell holding a world coordinate. */
export const cellOf = (v: number, pitch = ATLAS_GRID_PITCH) => Math.floor(v / pitch);

/** A cell's dot, in world coordinates. */
export const cellCenter = (i: number, pitch = ATLAS_GRID_PITCH) => (i + 0.5) * pitch;

interface Offset {
  di: number;
  dj: number;
  dist: number;
  /** The mock's tie-break: among cells at one distance, odd columns first. */
  sort: number;
}

const offsetCache = new Map<number, Offset[]>();

/** Grid offsets within `r` cells, nearest first, in a fixed order. */
function offsetsWithin(r: number): Offset[] {
  const hit = offsetCache.get(r);
  if (hit) return hit;
  const out: Offset[] = [];
  for (let dj = -r; dj <= r; dj++) {
    for (let di = -r; di <= r; di++) {
      const dist = Math.hypot(di, dj);
      if (dist > r) continue;
      out.push({ di, dj, dist, sort: Math.hypot(di, dj + (di % 2 ? 0 : 0.001)) });
    }
  }
  out.sort((a, b) => a.sort - b.sort || a.dj - b.dj || a.di - b.di);
  offsetCache.set(r, out);
  return out;
}

/** The radius in cells that holds `n` tiles with room to spare. */
function radiusFor(n: number): number {
  return Math.ceil(Math.sqrt(Math.max(1, n) / Math.PI)) + 3;
}

/** A cluster's tile count, capped, and its lit count kept in proportion. */
export function cappedTiles(tiles: number, lit: number): { tiles: number; lit: number } {
  const n = Math.max(0, Math.floor(tiles));
  const l = Math.max(0, Math.min(n, Math.floor(lit)));
  if (n <= ATLAS_FAR_TILE_CAP) return { tiles: n, lit: l };
  return { tiles: ATLAS_FAR_TILE_CAP, lit: Math.round((l / n) * ATLAS_FAR_TILE_CAP) };
}

export function buildRelayGrid(clusters: readonly RelayCluster[], pitch = ATLAS_GRID_PITCH): RelayGrid {
  const cells = new Map<string, RelayCell>();
  const reach = new Map<string, number>();
  const byCluster = new Map<string, RelayCell[]>();
  const list = clusters.map((c, order) => {
    const { tiles, lit } = cappedTiles(c.tiles, c.lit);
    return { c, order, tiles, lit, gi: cellOf(c.x, pitch), gj: cellOf(c.y, pitch), got: [] as RelayCell[] };
  });

  // Tiles: every cluster's candidates in one list, nearest first, so a cell
  // two clusters want goes to the nearer one.
  const cands: { k: number; di: number; dj: number; dist: number; sort: number; rank: number }[] = [];
  for (let k = 0; k < list.length; k++) {
    const e = list[k];
    if (e.tiles === 0) continue;
    const offs = offsetsWithin(radiusFor(e.tiles));
    for (let r = 0; r < offs.length; r++) cands.push({ k, ...offs[r], rank: r });
  }
  cands.sort((a, b) => a.sort - b.sort || a.k - b.k || a.rank - b.rank);
  const claim = (k: number, i: number, j: number, dist: number) => {
    const e = list[k];
    const cell: RelayCell = {
      i,
      j,
      x: cellCenter(i, pitch),
      y: cellCenter(j, pitch),
      key: e.c.key,
      role: 'tile',
      rank: e.got.length,
      lit: e.got.length < e.lit,
      dist,
      d: 0,
      da: 0,
    };
    cells.set(cellKey(i, j), cell);
    e.got.push(cell);
  };
  for (const cand of cands) {
    const e = list[cand.k];
    if (e.got.length >= e.tiles) continue;
    const i = e.gi + cand.di;
    const j = e.gj + cand.dj;
    if (cells.has(cellKey(i, j))) continue;
    claim(cand.k, i, j, cand.dist);
  }
  // A cluster boxed in by its neighbours reaches further out until it has a
  // tile per item.
  for (let k = 0; k < list.length; k++) {
    const e = list[k];
    let r = radiusFor(e.tiles);
    while (e.got.length < e.tiles) {
      r += 2;
      for (const o of offsetsWithin(r)) {
        if (e.got.length >= e.tiles) break;
        const i = e.gi + o.di;
        const j = e.gj + o.dj;
        if (!cells.has(cellKey(i, j))) claim(k, i, j, o.dist);
      }
    }
  }

  // Each cluster's reach, then the aura: the next 1.5 cells, nearer wins.
  for (const e of list) {
    const rt = e.got.reduce((m, t) => Math.max(m, t.dist), 0);
    reach.set(e.c.key, rt);
    const ra = rt + ATLAS_AURA_CELLS;
    for (const t of e.got) t.d = t.dist / ra;
  }
  for (const e of list) {
    const rt = reach.get(e.c.key)!;
    const ra = rt + ATLAS_AURA_CELLS;
    for (const o of offsetsWithin(Math.ceil(ra))) {
      if (o.dist > ra) continue;
      const i = e.gi + o.di;
      const j = e.gj + o.dj;
      const key = cellKey(i, j);
      const prev = cells.get(key);
      if (prev && (prev.role === 'tile' || prev.dist <= o.dist)) continue;
      if (prev) {
        const owner = byCluster.get(prev.key);
        if (owner) owner.splice(owner.indexOf(prev), 1);
      }
      const cell: RelayCell = {
        i,
        j,
        x: cellCenter(i, pitch),
        y: cellCenter(j, pitch),
        key: e.c.key,
        role: 'aura',
        rank: -1,
        lit: false,
        dist: o.dist,
        d: o.dist / ra,
        da: Math.max(0, Math.min(1, (o.dist - rt) / ATLAS_AURA_CELLS)),
      };
      cells.set(key, cell);
      const mine = byCluster.get(e.c.key) ?? [];
      mine.push(cell);
      byCluster.set(e.c.key, mine);
    }
  }
  for (const e of list) {
    const mine = byCluster.get(e.c.key) ?? [];
    byCluster.set(e.c.key, [...e.got, ...mine]);
  }

  const tiles: RelayCell[] = [];
  const aura: RelayCell[] = [];
  for (const cell of cells.values()) (cell.role === 'tile' ? tiles : aura).push(cell);
  return { pitch, cells, tiles, aura, reach, byCluster };
}

/**
 * The wave at a cell (the mock's `drawMix`): a ring that rolls from the
 * tiles out through the dots, on a 3.2s period. `phase` is 0 to 1; `live`
 * scales it (0 for a container untouched this week, so it stays still).
 */
export function waveAt(d: number, phase: number, live: number): number {
  if (live <= 0) return 0;
  return Math.max(0, 1 - Math.abs(d - phase * 1.4) * 3.2) * live;
}

/** The wave's period in ms. */
export const ATLAS_WAVE_PERIOD_MS = 3200;

/**
 * How lit a container's wave runs: touched today or yesterday is full, within
 * the week is gentler, anything older (or unknown, or resting) is still.
 */
export function liveness(touch: { kind: string; days?: number }, resting: boolean): number {
  if (resting || touch.kind !== 'touched' || touch.days === undefined) return 0;
  if (touch.days <= 1) return 1;
  if (touch.days <= 7) return 0.6;
  return 0;
}

/**
 * The cells in view: the tiles and aura whose dots fall inside a world rect
 * (padded by a cell), for drawing only what is on screen.
 */
export function cellsInView(
  cells: readonly RelayCell[],
  view: { x0: number; y0: number; x1: number; y1: number },
  pitch = ATLAS_GRID_PITCH
): RelayCell[] {
  return cells.filter((c) => c.x >= view.x0 - pitch && c.x <= view.x1 + pitch && c.y >= view.y0 - pitch && c.y <= view.y1 + pitch);
}

/**
 * Every how many cells an empty dot is drawn at a zoom, so dots never sit
 * closer than `minPx` screen pixels (at 12% the full grid is 3px apart, and
 * 160,000 dots a frame). Tiles and aura are always drawn.
 */
export function dotStride(z: number, pitch = ATLAS_GRID_PITCH, minPx = 7): number {
  const px = pitch * z;
  if (!(px > 0)) return 1;
  return Math.max(1, Math.ceil(minPx / px));
}
