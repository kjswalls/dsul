import type { AtlasCard } from './atlas-model';
import type { Point, Viewport } from './atlas-camera';

/**
 * Where a card with no place of its own first lands on Your map. Pure and
 * deterministic: the same cards, places and viewport give the same answer.
 *
 * - goals in a left column;
 * - each card that feeds a goal (most of its members are that goal's items)
 *   beside its goal, on the goal's row;
 * - a season's routines beside the season;
 * - everything else in a grid under the goal block (from the top when there
 *   are no goals), as wide as the seed viewport or as a roughly 16:9 block,
 *   whichever is wider.
 *
 * Goals arrive live first (lib/atlas-model.ts sorts them as every goal list
 * does), so an achieved or set-aside goal never takes the top rows.
 *
 * Cards snap to a cell grid, and a cell is free only when its card rect would
 * overlap no placed card and no card seeded before it, so nothing lands on
 * anything.
 */

/** Card A's width, and the room a seeded card is given. */
export const ATLAS_CARD_W = 260;
/** A seeded card's assumed height: a collapsed card A with room to spare. */
export const ATLAS_CARD_H = 190;
export const ATLAS_SEED_GAP = 40;

const CELL_W = ATLAS_CARD_W + ATLAS_SEED_GAP;
const CELL_H = ATLAS_CARD_H + ATLAS_SEED_GAP;
/** How far along a row a goal's feeders run before wrapping. */
const FEEDER_COLS = 4;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function seedPlaces(
  cards: readonly AtlasCard[],
  placed: Readonly<Record<string, Point>>,
  viewport: Viewport,
): Record<string, Point> {
  const out: Record<string, Point> = {};
  const taken: Box[] = Object.values(placed).map((p) => ({
    x: p.x,
    y: p.y,
    w: ATLAS_CARD_W,
    h: ATLAS_CARD_H,
  }));

  const box = (col: number, row: number): Box => ({
    x: col * CELL_W,
    y: row * CELL_H,
    w: ATLAS_CARD_W,
    h: ATLAS_CARD_H,
  });
  const isFree = (col: number, row: number) => {
    const b = box(col, row);
    return !taken.some((t) => overlaps(b, t));
  };
  const take = (key: string, col: number, row: number) => {
    const b = box(col, row);
    taken.push(b);
    out[key] = { x: b.x, y: b.y };
  };
  /** First free cell along a row from `col`, wrapping to the next row after `span`. */
  const takeAlong = (key: string, row: number, col: number, span: number) => {
    for (let r = row; r < row + 500; r += 1) {
      for (let c = col; c < col + span; c += 1) {
        if (isFree(c, r)) {
          take(key, c, r);
          return { col: c, row: r };
        }
      }
    }
    // Unreachable in practice; still never overlaps.
    take(key, col, row + 500);
    return { col, row: row + 500 };
  };

  const unplaced = (c: AtlasCard) => !placed[c.key] && !out[c.key];
  const goals = cards.filter((c) => c.kind === 'goal');
  const hasGoals = goals.length > 0;

  // Which goal each non-goal card feeds: the goal holding most of its members,
  // ties to the earlier goal.
  const goalItems = goals.map((g) => new Set(g.members.map((m) => m.item.id)));
  const feedsGoal = new Map<string, AtlasCard>();
  for (const c of cards) {
    if (c.kind === 'goal') continue;
    let best = -1;
    let bestCount = 0;
    goalItems.forEach((set, i) => {
      const n = c.members.filter((m) => set.has(m.item.id)).length;
      if (n > bestCount) {
        best = i;
        bestCount = n;
      }
    });
    if (best >= 0) feedsGoal.set(c.key, goals[best]);
  }

  // The row a card sits on, from wherever it is.
  const rowOf = (c: AtlasCard) => {
    const p = placed[c.key] ?? out[c.key];
    return p ? Math.max(0, Math.round(p.y / CELL_H)) : 0;
  };

  // 1. Goals down the left column.
  for (const g of goals) {
    if (unplaced(g)) takeAlong(g.key, 0, 0, 1);
  }

  // 2. Feeders beside their goal.
  for (const g of goals) {
    const row = rowOf(g);
    for (const c of cards) {
      if (feedsGoal.get(c.key) !== g || !unplaced(c)) continue;
      takeAlong(c.key, row, 1, FEEDER_COLS);
    }
  }

  // 3. The rest in a grid under the goal block. Its width comes from the room
  // the seed viewport has, or from the count for a roughly 16:9 block (cells
  // are 300x230, so c = sqrt(1.4n) columns), whichever is wider.
  let startRow = 0;
  if (hasGoals) {
    for (const c of cards) {
      if (c.kind !== 'goal' && !feedsGoal.has(c.key)) continue;
      const p = placed[c.key] ?? out[c.key];
      if (p) startRow = Math.max(startRow, Math.floor((p.y + ATLAS_CARD_H) / CELL_H) + 1);
    }
  }
  const rest = cards.filter((c) => unplaced(c)).length;
  const fit = Math.floor(Math.max(0, viewport.w) / CELL_W);
  const cols = Math.max(3, Number.isFinite(fit) ? fit : 3, Math.ceil(Math.sqrt(1.4 * rest)));
  const startCol = 0;
  const routinesById = new Map(cards.filter((c) => c.kind === 'routine').map((c) => [c.id, c]));

  for (const c of cards) {
    if (!unplaced(c) || c.kind === 'routine') continue;
    const at = takeAlong(c.key, startRow, startCol, cols);
    if (c.kind === 'season') {
      // Its routines beside it, on its row.
      for (const rid of c.routineIds ?? []) {
        const r = routinesById.get(rid);
        if (r && unplaced(r)) takeAlong(r.key, at.row, at.col + 1, cols);
      }
    }
  }
  for (const c of cards) {
    if (unplaced(c)) takeAlong(c.key, startRow, startCol, cols);
  }

  return out;
}
