/**
 * settle-plan.ts — the settle conductor's pure half: what each participant
 * does when the fresh planner lands over the look-only preview.
 *
 * lib/settle.ts captures FIRST (the preview DOM, inside the landing set()) and
 * measures LAST (the fresh DOM, in SettleHost's layout effect), one
 * `SettleSide` per `[data-settle-scope]`. `planScope` turns the pair into a
 * plan and the conductor turns the plan into WAAPI animations. No DOM here, so
 * every rule is tested with plain rects (tests/unit/settle-plan.test.ts).
 *
 * Every treatment is IN PLACE, on the participant's own box, transform and
 * clip-path only: nothing is drawn over the planner, so nothing can fade lime
 * (CLAUDE.md) or escape a scroller's clip.
 *
 *  - MOVE: a node on both sides whose own displacement is a pixel or more
 *    glides from where the preview drew it. "Own" is net of the nearest moving
 *    ancestor, because transforms compose down the DOM: a row inside a group
 *    that moved 40px animates only what the group's glide doesn't carry it.
 *    Every move shares one duration and curve, so the composition is exact at
 *    every frame, not just the ends.
 *  - A row whose KEY changed is still a move when its item id is unmatched
 *    exactly once on each side: a task rescheduled Monday → Wednesday glides
 *    across the week's columns. A recurring item drawn on several days stays
 *    unpaired — which Monday went to which Wednesday is a guess.
 *  - APPEAR: new on screen; rows type in left → right, frames unfold top →
 *    down. A node under an appearing frame rides that frame's reveal instead —
 *    a row that moved into it too, whose glide would only show through the
 *    unfold's clip.
 *  - REVEAL: a frame holding rows that grew taller uncovers its new height as
 *    they glide into it, rather than taking it in one frame with an empty band
 *    (a shrink cannot be held: nothing in transform or clip-path draws a box
 *    taller than its layout).
 *  - EXIT: gone at landing, counted and never animated. The neighbours' moves
 *    close the gap, which reads as the row leaving without a ghost overlay.
 *  - RETYPE: a row that stayed put but whose content changed has its new
 *    content type in once, from its first changed character: what reads the
 *    same (the checkbox, an unchanged prefix) never blanks.
 *  - LARGE: too much changed for each move to be followed, so instead of a
 *    storm of crossing glides the scope's top-level blocks rise into place in
 *    one short cascade.
 *
 * Only VISIBLE nodes animate or count — an 800-row braindump moves the ~25
 * rows on screen, and a change below the fold cannot tip a scope into large.
 */

/**
 * Timings, holds and caps, in ms / frames / px / counts. Pinned by a test.
 * Moves run on EASE_MOVE (ease-out-soft today, which covers ~96% of a 420ms
 * move by ~210ms, so the glide reads as arriving rather than travelling); the
 * worst case (appear rank 6) is done by ~584ms, inside the completed-sinks
 * hold's 700ms.
 */
export const SETTLE = {
  // Treatment durations. A move (and the clip reveals that ride it) and a retarget's re-aim take moveMs.
  moveMs: 420,
  appearMs: 340,
  retypeMs: 300,
  riseMs: 320,
  riseOffsetPx: 6,
  // A new row waits for the gap it lands in to open, then cascades by rank (capped).
  appearLead: 100,
  frameAppearLead: 80,
  appearStagger: 24,
  appearMaxRank: 6,
  riseStagger: 24,
  riseMaxRank: 8,
  // Hold-until-quiet: paused for 2–8 frames, played once two frames pass with no mutation.
  holdMinFrames: 2,
  quietFrames: 2,
  holdMaxFrames: 8,
  holdTimeoutMs: 400,
  // A follow-up commit mid-play re-aims the scope's moves from where they are drawn.
  retargetMinMs: 220,
  maxRetargets: 2,
  // A run never outlives this, counted from the landing.
  runTimeoutMs: 1400,
  // Caps: a scope past maxNodesPerScope is not captured; the rest feed SETTLE_LIMITS.
  maxNodesPerScope: 2000,
  maxAnimationsPerScope: 300,
  maxRetypes: 12,
  largeRows: 48,
  largeStructural: 24,
  // A landing that changed what is under the pointer, with nothing animating, swallows clicks this long.
  shieldMs: 250,
  // Clip insets run this far outside the box, so focus rings and shadows aren't shaved mid-reveal.
  clipBleedPx: 8,
  // A row gliding farther than its own height is lifted for the run: stacked above its
  // siblings on the nearest painted ground, so texts never overprint as it crosses them.
  liftRows: true as boolean,
} as const;

/**
 * `--ease-out-soft` (app/globals.css), spelled out: element.animate() cannot
 * read a custom property. A test pins the two together. Appears, retypes and
 * rises run on it.
 */
export const EASE_SETTLE = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * The curve every move runs on — the glide, the clip reveals that ride it (a
 * row's grow, a frame's bottom edge) and a retarget's re-aim — kept apart from
 * EASE_SETTLE so the glide can be tuned on its own. They must share one curve
 * with each other: nested moves compose exactly only on the same curve.
 */
export const EASE_MOVE: string = EASE_SETTLE;

export type SettleRole = 'row' | 'frame';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SettleNode {
  /** Unique within its scope: a row's raw key, a frame's qualified one, duplicates numbered (`createKeyDeduper`). */
  key: string;
  /** A row's item id (`data-item-id`), so a row whose key changed can still be paired. */
  id?: string;
  role: SettleRole;
  /** The animated box's layout rect, in viewport coordinates. */
  rect: Rect;
  /** Intersects the scope's clip and every clipping ancestor's. */
  visible: boolean;
  /** A visible row's change signature; absent for frames and for rows off screen. */
  sig?: string;
  /** A visible row's raw textContent, beside its sig: where a retype starts. */
  text?: string;
  /** The nearest ancestor participant's key, on the same side. */
  parent?: string;
  /** No participant ancestor. */
  topLevel: boolean;
}

/** One scope, one side of the landing. Map order is DOM order. */
export interface SettleSide {
  nodes: Map<string, SettleNode>;
}

export interface SettleLimits {
  maxAnimations: number;
  maxRetypes: number;
  largeRows: number;
  largeStructural: number;
}

export interface SettleMove {
  key: string;
  /** The FIRST-side key: the same key, or the paired one for a row whose key changed. */
  fromKey: string;
  /** FIRST − LAST, net of the nearest moving ancestor. Both under 1px only when the row grew. */
  dx: number;
  dy: number;
  /** Rows only: LAST − FIRST size, set when either dimension grew by more than 1px. */
  grow?: { dw: number; dh: number };
  /**
   * Frames only: how much of its new height starts hidden, uncovered as the
   * rows inside glide into it. Never more than lies beyond both its old
   * extent and everything inside's FIRST place, so no glide is shaved.
   */
  reveal?: number;
}

export interface SettleAppear {
  key: string;
  role: SettleRole;
  /** Order on screen by (top, left), counted within its role. */
  rank: number;
}

export interface SettleRetype {
  key: string;
  /**
   * The first index at which the row's raw text differs from FIRST's — the
   * conductor types in from that character's x. Absent when the text is the
   * same (an attribute changed: the whole row types in) or unknown.
   */
  at?: number;
}

export interface SettleRise {
  key: string;
  rank: number;
}

export interface SettlePlan {
  mode: 'none' | 'fine' | 'large';
  moves: SettleMove[];
  appears: SettleAppear[];
  retypes: SettleRetype[];
  /** Large mode only. */
  rises: SettleRise[];
  /** Any visible difference — drives the landing shield, whatever the mode. */
  changed: boolean;
}

/** The plan caps, from SETTLE. */
export const SETTLE_LIMITS: SettleLimits = {
  maxAnimations: SETTLE.maxAnimationsPerScope,
  maxRetypes: SETTLE.maxRetypes,
  largeRows: SETTLE.largeRows,
  largeStructural: SETTLE.largeStructural,
};

/** Under a pixel is rounding, not motion. */
const MIN_PX = 1;

/** A frame's reveal ends this far below its box — the clip bleed — so content may hang that far out. */
const REVEAL_BLEED = SETTLE.clipBleedPx;

const ZERO = { dx: 0, dy: 0 } as const;

/**
 * Numbers repeated keys in the order they are offered — `k`, `k#2`, `k#3` —
 * so a row drawn twice in one scope (a project block's duplicate host) is two
 * participants, not one. Offer keys in DOM order on both sides so the nth copy
 * pairs with the nth. One deduper per scope per side.
 */
export function createKeyDeduper(): (key: string) => string {
  const seen = new Map<string, number>();
  const taken = new Set<string>();
  return (key) => {
    let n = seen.get(key) ?? 0;
    let unique: string;
    // A raw key that already ends in `#n` must not collide with a numbered copy.
    do {
      n += 1;
      unique = n === 1 ? key : `${key}#${n}`;
    } while (taken.has(unique));
    seen.set(key, n);
    taken.add(unique);
    return unique;
  };
}

/** The first index at which two texts differ, or null when they are the same. */
export function firstDifference(a: string, b: string): number | null {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i === a.length && i === b.length ? null : i;
}

const byPosition = (a: SettleNode, b: SettleNode): number =>
  a.rect.top - b.rect.top || a.rect.left - b.rect.left;

/**
 * LAST key → FIRST key for every node on both sides: the same key, or, for a
 * row whose key changed, the one row on each side carrying an unmatched id.
 */
function matchSides(first: SettleSide, last: SettleSide): Map<string, string> {
  const from = new Map<string, string>();
  for (const key of last.nodes.keys()) if (first.nodes.has(key)) from.set(key, key);

  // id → its one unmatched row's key, or null once a second turns up.
  const loneRows = (side: SettleSide, other: SettleSide): Map<string, string | null> => {
    const lone = new Map<string, string | null>();
    for (const [key, node] of side.nodes) {
      if (node.role !== 'row' || !node.id || other.nodes.has(key)) continue;
      lone.set(node.id, lone.has(node.id) ? null : key);
    }
    return lone;
  };
  const wasLone = loneRows(first, last);
  for (const [id, key] of loneRows(last, first)) {
    const fromKey = wasLone.get(id);
    if (key !== null && typeof fromKey === 'string') from.set(key, fromKey);
  }
  return from;
}

/** Each kind of change, before the mode decides what plays. */
interface Classified {
  moves: SettleMove[];
  rowMoves: number;
  appears: SettleAppear[];
  exits: number;
  rowExits: number;
  /** Every in-place change, by position; the plan keeps the first `maxRetypes`. */
  retypes: SettleRetype[];
}

/**
 * Per frame that keeps its key: how far down its own box (from its FIRST top)
 * the matched nodes inside it start, how far below its LAST top anything drawn
 * inside it ends, and whether a matched row is among them — what a frame's
 * reveal must leave uncut.
 */
interface Inside {
  firstBottom: number;
  lastBottom: number;
  rows: boolean;
}

function insideOf(first: SettleSide, last: SettleSide, from: Map<string, string>): Map<string, Inside> {
  const inside = new Map<string, Inside>();
  for (const [key, node] of last.nodes) {
    const fromKey = from.get(key);
    const found = fromKey === undefined ? undefined : first.nodes.get(fromKey);
    // Matched nodes say where the reveal may start; anything drawn at the end,
    // matched or appearing, says whether its edge would cut something.
    const was = found && (found.visible || node.visible) ? found : undefined;
    if (!was && !node.visible) continue;
    let parent = node.parent;
    for (let hops = 0; parent !== undefined && hops < last.nodes.size; hops += 1) {
      const up = last.nodes.get(parent);
      const upFrom = from.get(parent);
      const upWas = upFrom === undefined ? undefined : first.nodes.get(upFrom);
      if (!up) break;
      if (up.role === 'frame' && upWas) {
        const acc = inside.get(parent) ?? { firstBottom: -Infinity, lastBottom: -Infinity, rows: false };
        acc.lastBottom = Math.max(acc.lastBottom, node.rect.top + node.rect.height - up.rect.top);
        if (was) {
          acc.firstBottom = Math.max(acc.firstBottom, was.rect.top + was.rect.height - upWas.rect.top);
          acc.rows ||= node.role === 'row';
        }
        inside.set(parent, acc);
      }
      parent = up.parent;
    }
  }
  return inside;
}

function classify(first: SettleSide, last: SettleSide): Classified {
  const from = matchSides(first, last);
  const inside = insideOf(first, last, from);

  // An unmatched visible ancestor is appearing itself, or sits under one that
  // is: either way its reveal already uncovers this node.
  const underAppearing = (node: SettleNode): boolean => {
    let parent = node.parent;
    for (let hops = 0; parent !== undefined && hops < last.nodes.size; hops += 1) {
      const up = last.nodes.get(parent);
      if (!up) return false;
      if (up.visible && !from.has(parent)) return true;
      parent = up.parent;
    }
    return false;
  };

  // A frame that grew keeps its new height hidden down to wherever the
  // matched nodes inside it start (relative positions run linearly on the one
  // shared curve, so an edge that does too never cuts them). Only a frame of
  // rows: an hour cell's growth is a scale change, not something arriving.
  // Content that ends hanging out past the bleed would be cut until the run
  // ends, so that frame gets no reveal.
  const revealOf = (key: string, node: SettleNode, was: SettleNode): number => {
    const box = inside.get(key);
    if (!box?.rows || node.rect.height - was.rect.height <= MIN_PX) return 0;
    if (box.lastBottom > node.rect.height + REVEAL_BLEED) return 0;
    const hidden = node.rect.height - Math.max(was.rect.height, box.firstBottom);
    return hidden > MIN_PX ? hidden : 0;
  };

  // A node's move needs its ancestors' first, so moves resolve on demand and
  // memoize; null is "matched and not moving" or "not matched".
  const motion = new Map<string, SettleMove | null>();

  function totalOf(key: string, fromKey: string): { dx: number; dy: number } {
    const was = first.nodes.get(fromKey)!.rect;
    const now = last.nodes.get(key)!.rect;
    return { dx: was.left - now.left, dy: was.top - now.top };
  }

  // What the nearest ANIMATED ancestor's glide already carries: its total
  // displacement, since the moves above it telescope to exactly that. An
  // appearing ancestor (unmatched) or a still one adds nothing and is skipped.
  function carried(node: SettleNode): { dx: number; dy: number } {
    let parent = node.parent;
    for (let hops = 0; parent !== undefined && hops < last.nodes.size; hops += 1) {
      const move = moveOf(parent);
      if (move) return totalOf(parent, move.fromKey);
      parent = last.nodes.get(parent)?.parent;
    }
    return ZERO;
  }

  function moveOf(key: string): SettleMove | null {
    const known = motion.get(key);
    if (known !== undefined) return known;
    motion.set(key, null); // a malformed parent cycle stops here rather than recursing
    const node = last.nodes.get(key);
    const fromKey = from.get(key);
    const was = fromKey === undefined ? undefined : first.nodes.get(fromKey);
    if (!node || !was || fromKey === undefined || !(was.visible || node.visible)) return null;
    // Inside a frame that is unfolding, a glide would only show through its clip.
    if (underAppearing(node)) return null;

    const total = totalOf(key, fromKey);
    const base = carried(node);
    const dx = total.dx - base.dx;
    const dy = total.dy - base.dy;
    const dw = node.rect.width - was.rect.width;
    const dh = node.rect.height - was.rect.height;
    // A row's own clip reveals its new extent. A frame's would shave the rows
    // gliding inside it, so a frame reveals only what nothing inside crosses.
    const grows = node.role === 'row' && (dw > MIN_PX || dh > MIN_PX);
    const reveal = node.role === 'frame' ? revealOf(key, node, was) : 0;
    if (Math.abs(dx) < MIN_PX && Math.abs(dy) < MIN_PX && !grows && !reveal) return null;

    const move: SettleMove = { key, fromKey, dx, dy };
    if (grows) move.grow = { dw, dh };
    if (reveal) move.reveal = reveal;
    motion.set(key, move);
    return move;
  }

  const moves: SettleMove[] = [];
  let rowMoves = 0;
  for (const [key, node] of last.nodes) {
    const move = moveOf(key);
    if (!move) continue;
    moves.push(move);
    if (node.role === 'row') rowMoves += 1;
  }

  const appearing: [string, SettleNode][] = [];
  for (const [key, node] of last.nodes) {
    if (node.visible && !from.has(key) && !underAppearing(node)) appearing.push([key, node]);
  }
  appearing.sort(([, a], [, b]) => byPosition(a, b));
  const rankIn: Record<SettleRole, number> = { row: 0, frame: 0 };
  const appears = appearing.map(([key, node]): SettleAppear => ({
    key,
    role: node.role,
    rank: rankIn[node.role]++,
  }));

  const kept = new Set(from.values());
  let exits = 0;
  let rowExits = 0;
  for (const [key, node] of first.nodes) {
    if (kept.has(key) || !node.visible) continue;
    exits += 1;
    if (node.role === 'row') rowExits += 1;
  }

  // In place means no move at all — not even a grow, whose reveal already
  // shows the row's new extent — and no unfolding frame around it. A missing
  // sig (off screen at capture) is not a difference.
  const retyped: [SettleRetype, SettleNode][] = [];
  for (const [key, node] of last.nodes) {
    const fromKey = from.get(key);
    if (node.role !== 'row' || !node.visible || fromKey === undefined || motion.get(key)) continue;
    if (underAppearing(node)) continue;
    const was = first.nodes.get(fromKey)!;
    if (was.sig === undefined || node.sig === undefined || was.sig === node.sig) continue;
    const at = was.text !== undefined && node.text !== undefined ? firstDifference(was.text, node.text) : null;
    retyped.push([at === null ? { key } : { key, at }, node]);
  }
  retyped.sort(([, a], [, b]) => byPosition(a, b));

  return { moves, rowMoves, appears, exits, rowExits, retypes: retyped.map(([r]) => r) };
}

const emptyPlan = (mode: SettlePlan['mode'], changed: boolean): SettlePlan => ({
  mode,
  moves: [],
  appears: [],
  retypes: [],
  rises: [],
  changed,
});

/**
 * One scope's plan. Pure: the conductor calls it again on every re-hold
 * against the same FIRST, so it must not keep or mutate anything.
 *
 * Large when the change is too broad to follow move by move. The row counts
 * deliberately ignore frames — a range change slides every hour cell in a
 * week (~130 frames), and that is one calm motion, not a large one — while the
 * structural and animation caps count everything.
 */
export function planScope(first: SettleSide, last: SettleSide, limits: SettleLimits): SettlePlan {
  const c = classify(first, last);
  const changed = c.moves.length > 0 || c.appears.length > 0 || c.exits > 0 || c.retypes.length > 0;
  if (!changed) return emptyPlan('none', false);

  const retypes = c.retypes.slice(0, Math.max(0, limits.maxRetypes));
  const rowAppears = c.appears.filter((a) => a.role === 'row').length;
  const large =
    c.rowMoves + rowAppears + c.rowExits > limits.largeRows ||
    c.appears.length + c.exits > limits.largeStructural ||
    c.moves.length + c.appears.length + retypes.length > limits.maxAnimations;

  if (large) {
    const plan = emptyPlan('large', true);
    const top = [...last.nodes].filter(([, node]) => node.topLevel && node.visible);
    top.sort(([, a], [, b]) => byPosition(a, b));
    plan.rises = top.map(([key], rank) => ({ key, rank }));
    return plan;
  }

  return { mode: 'fine', moves: c.moves, appears: c.appears, retypes, rises: [], changed: true };
}
