import { EASE_SET_DOWN, EASE_SETTLE } from '@/lib/settle-plan';

/**
 * Atlas's motion, in one place (round 2, part B): every duration and curve the
 * map animates with, and the pure math behind the far zoom handoff.
 *
 * The curves are the app's own, never new ones: EASE_SETTLE is the settle
 * conductor's curve and globals.css's `--ease-out-soft`; EASE_SET_DOWN is its
 * symmetric set-down; the spring is `--ease-spring`. A test pins them to the
 * stylesheet's tokens.
 *
 * Three rules hold for everything here:
 *
 * - Transform, colour, clip and canvas drawing only, never an element's
 *   opacity, so the lime accent is never faded through a parent (CLAUDE.md,
 *   design D8). Canvas `globalAlpha` is drawing, not a parent's opacity.
 * - Under reduced motion every one of these is off: the callers ask
 *   `useAtlasReducedMotion()` and skip the animation, never shorten it.
 * - Everything but the handoff stays under ~300ms. The handoff is scrubbed by
 *   the zoom (pinch or wheel), so it never runs on a clock of its own and
 *   never fights the hand; only a click's fly-in plays it as a timed flourish.
 */

/** The settle curve: fast out, long soft landing. */
export const ATLAS_EASE_OUT: string = EASE_SETTLE;
/** Symmetric, for something that leaves and arrives in one stroke. */
export const ATLAS_EASE_IN_OUT: string = EASE_SET_DOWN;
/** A small overshoot, for a pop that lands (a tile lighting, a count). */
export const ATLAS_EASE_SPRING = 'cubic-bezier(0.34, 1.4, 0.64, 1)';
/** Quick to start, for a close that should get out of the way. */
export const ATLAS_EASE_EXIT = 'cubic-bezier(0.4, 0, 0.2, 1)';

export const ATLAS_MOTION = {
  /** The glide between layouts, and a drop's spring back. */
  glideMs: 520,
  /** A layout switch's cascade: the leftmost card goes first, the rightmost this much later. */
  glideStaggerMs: 90,
  /** A card a filter hides scales down this long, then unmounts. */
  leaveMs: 150,
  /** The focus sheet grows out of its card. */
  sheetOpenMs: 340,
  /** Its blocks rise a few pixels into place as it opens (globals.css `atlas-sheet-rise`). */
  sheetRiseMs: 260,
  /** And shrinks back into it, a little quicker. */
  sheetCloseMs: 260,
  /** The scrim behind the sheet, by colour. */
  scrimMs: 240,
  /** A pinned card's settle once its glide lands. */
  pinSettleMs: 280,
  /** The count's receipt pulse when something is filed into the card. */
  receiptMs: 260,
  /** A tile lighting on a tick, or a new tile arriving. */
  tilePopMs: 240,
  /** A strand drawing in from its goal. */
  strandDrawMs: 280,
  /** Strands that appear together draw in this far apart, up to strandStaggerCapMs. */
  strandStaggerMs: 14,
  strandStaggerCapMs: 120,
  /** A click on a far cluster: the camera's flight. */
  flyMs: 520,
  /** The flourish's assembly (cards forming from their tiles), after the flight is under way. */
  flourishMs: 640,
  /** When in the flight the assembly starts. */
  flourishDelayMs: 150,
  /** Walk Atlas's panel rising into place as a walk starts, and settling away as it ends. */
  walkPanelMs: 280,
  /** Each stop's question rising a few pixels into place (globals.css `atlas-walk-rise`). */
  walkRiseMs: 220,
  /** The walk's veil coming up and lifting, by colour. */
  walkScrimMs: 240,
  /** The walk's progress line easing along. */
  walkProgressMs: 280,
} as const;

/**
 * The focus sheet's rise, block by block: the delay of its 1st, 2nd, ... 6th
 * and every later block. globals.css spells the same values (a test pins
 * them), and the rise is on only while the sheet opens, so a block that
 * mounts later (a Done group after a tick) never rises.
 */
export const ATLAS_SHEET_RISE_DELAYS = [0, 30, 55, 80, 100, 120] as const;
/** How long the sheet's body keeps its rise on after it opens. */
export const ATLAS_SHEET_RISE_TOTAL_MS =
  ATLAS_MOTION.sheetRiseMs + ATLAS_SHEET_RISE_DELAYS[ATLAS_SHEET_RISE_DELAYS.length - 1];

/** The strands follow their cards this long after a change: the glide, its cascade and slack. */
export const ATLAS_FOLLOW_MS = ATLAS_MOTION.glideMs + ATLAS_MOTION.glideStaggerMs + 40;

/** The glide's transition, at rest (no cascade delay). */
export const ATLAS_GLIDE = `transform ${ATLAS_MOTION.glideMs}ms ${ATLAS_EASE_OUT}`;

/** The glide with a cascade delay (a layout switch only). */
export function glideTransition(delayMs: number): string {
  return delayMs > 0 ? `${ATLAS_GLIDE} ${Math.round(delayMs)}ms` : ATLAS_GLIDE;
}

/**
 * A card's cascade delay on a layout switch, by where it lands: a sweep from
 * the left edge of the arrangement to the right, so Momentum's columns and the
 * Timeline's months arrive in reading order. Finite for any input.
 */
export function glideDelay(x: number, minX: number, maxX: number): number {
  const span = maxX - minX;
  if (!Number.isFinite(x) || !Number.isFinite(span) || span <= 0) return 0;
  const t = Math.max(0, Math.min(1, (x - minX) / span));
  return Math.round(t * ATLAS_MOTION.glideStaggerMs);
}

/* ── Easing as numbers, for canvas and rAF ─────────────────────────────── */

export const clamp01 = (t: number) => (Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0);
export const easeOutCubic = (t: number) => 1 - (1 - clamp01(t)) ** 3;
export const easeInOutCubic = (t: number) => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};
/** 0 below `a`, 1 above `b`, smooth between. */
export function smoothstep(a: number, b: number, t: number): number {
  if (b <= a) return t >= b ? 1 : 0;
  const x = clamp01((t - a) / (b - a));
  return x * x * (3 - 2 * x);
}

/* ── The far zoom handoff ──────────────────────────────────────────────────
 *
 * `e` is how far through the handoff the board is: 0 is cards only (zoom 0.6
 * and up), 1 is the constellation only (0.5 and down). Zooming out, each card
 * folds flat onto its tile strip and narrows to nothing, a soft light passes
 * over it, and its tiles lift off the strip and stream, one after another,
 * into their cells on the grid, growing into relay tiles as they land. Zooming
 * in plays the same frames backwards: tiles leave the grid and assemble into
 * each card's strip as the card unfolds around them.
 */

/** Where on a card the fold closes onto: the tile strip's line (card top to its middle). */
export const ATLAS_FOLD_Y = 46;

/** A card's scale at `e`: it flattens first, then narrows. */
export function foldScale(e: number): { sx: number; sy: number } {
  const t = clamp01(e);
  const sy = 1 - 0.96 * easeInOutCubic(t / 0.55);
  const sx = 1 - 0.92 * easeInOutCubic((t - 0.2) / 0.8);
  return { sx, sy };
}

/** The light's pass across a card, 0 (off its left edge) to 1 (off its right), in the first half. */
export function sweepAt(e: number): number {
  return easeOutCubic(clamp01(e) / 0.6);
}

/** Tiles sit on the strip until the fold has begun. */
const FLIGHT_START = 0.08;
/** The last tile of a strip leaves this much later than the first. */
const FLIGHT_STAGGER = 0.3;
/** One tile's flight, as a share of the handoff. */
const FLIGHT_SPAN = 0.58;

/**
 * How far tile `k` of `n` is from its strip (0) to its cell (1) at `e`. Every
 * tile has landed by e = 1 and none has left by FLIGHT_START.
 */
export function tileFlight(e: number, k: number, n: number): number {
  const d = n > 1 ? (Math.max(0, Math.min(k, n - 1)) / (n - 1)) * FLIGHT_STAGGER : 0;
  return clamp01((clamp01(e) - FLIGHT_START - d) / FLIGHT_SPAN);
}

/**
 * A tile's place on its flight: an eased line from `a` to `b` bowed sideways
 * by a sine (alternate tiles bow opposite ways, so a stream fans out instead
 * of stacking on one line).
 */
export function flightPoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
  q: number,
  k: number
): { x: number; y: number } {
  const t = easeInOutCubic(q);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const bow = len > 0 ? Math.sin(Math.PI * clamp01(q)) * len * 0.16 * (k % 2 === 0 ? 1 : -1) : 0;
  const nx = len > 0 ? -dy / len : 0;
  const ny = len > 0 ? dx / len : 0;
  return { x: a.x + dx * t + nx * bow, y: a.y + dy * t + ny * bow };
}

/**
 * What the constellation canvas (under the cards) draws at `e`. The dots are
 * always drawn whole (they take over from the board's CSS dots). The relay
 * tiles are the overlay's while tiles are in flight, and the canvas's once
 * every tile has landed. Under reduced motion it is a plain swap at 0.5:
 * nothing until the cards are gone, then everything.
 */
export function underLayer(e: number, reduced: boolean): {
  links: number;
  aura: number;
  labels: number;
  tiles: boolean;
} {
  const t = clamp01(e);
  if (reduced) {
    const on = t >= 1 ? 1 : 0;
    return { links: on, aura: on, labels: on, tiles: on === 1 };
  }
  return { links: t, aura: smoothstep(0.35, 1, t), labels: smoothstep(0.55, 1, t), tiles: t >= 1 };
}

/**
 * The fly-in's flourish at `elapsed` ms: held at 1 (all tiles on the grid)
 * until the assembly starts, then eased down to 0 (every card whole). The
 * handoff shown is the larger of this and the zoom's own, so the flight can
 * never show a card the zoom has not reached, and the assembly plays at a
 * pace you can see instead of in the 30ms the camera spends in the band.
 */
export function flourishAt(elapsed: number): number {
  const t = (elapsed - ATLAS_MOTION.flourishDelayMs) / ATLAS_MOTION.flourishMs;
  return 1 - easeInOutCubic(t);
}

/** The whole fly-in, flight and flourish, in ms. */
export const ATLAS_FLY_TOTAL_MS = Math.max(ATLAS_MOTION.flyMs, ATLAS_MOTION.flourishDelayMs + ATLAS_MOTION.flourishMs);

/* ── Strands drawing in ─────────────────────────────────────────────────── */

/** The most dash pairs a draw-in builds; a longer strand draws in solid, then turns dashed. */
const DRAW_IN_MAX_PAIRS = 400;

/**
 * A strand's draw-in, by stroke-dashoffset: a dash array that repeats the
 * strand's own pattern (`on`/`off`, or solid with none) for a little more
 * than its length and then leaves a gap longer than it, so moving the offset
 * from `from` down to 0 uncovers the strand from its goal end, and ends on
 * exactly the pattern it rests with (no jump when the animation lets go).
 * Null for a strand with no length.
 */
export function drawInDash(
  length: number,
  pattern: readonly [number, number] | null
): { dasharray: string; from: number } | null {
  if (!Number.isFinite(length) || length <= 0) return null;
  const cover = Math.ceil(length * 1.5) + 8;
  const gap = cover * 2;
  if (pattern) {
    const [on, off] = pattern;
    const period = on + off;
    const pairs = Math.ceil(cover / period);
    if (period > 0 && pairs <= DRAW_IN_MAX_PAIRS) {
      const list: number[] = [];
      for (let i = 0; i < pairs; i++) list.push(on, off);
      list.push(0, gap);
      return { dasharray: list.join(' '), from: pairs * period };
    }
  }
  return { dasharray: `${cover} ${gap}`, from: cover };
}

/** The delay for the `i`th strand appearing at once. */
export function strandDelay(i: number): number {
  return Math.min(Math.max(0, i) * ATLAS_MOTION.strandStaggerMs, ATLAS_MOTION.strandStaggerCapMs);
}

/* ── A pin made here ───────────────────────────────────────────────────────
 *
 * A card's pin settle plays only for a pin this tab just made (the card menu
 * or a drop into a Momentum column): never for a card that was pinned all
 * along and only now shows it (a switch into Momentum), and never for a pin
 * caught up from another device. The view arms the card's key as it writes
 * the pin; the card takes the arm when it sees itself pinned. An arm nobody
 * takes (a drop that wrote nothing) lapses.
 */
const PIN_ARM_MS = 2000;
const pinArms = new Map<string, number>();

/** A pin is being written here for `key`: its settle may play. */
export function armPinSettle(key: string, now: number = Date.now()): void {
  pinArms.set(key, now);
}

/** Takes `key`'s arm: true once for a pin armed in the last two seconds. */
export function takePinSettle(key: string, now: number = Date.now()): boolean {
  const at = pinArms.get(key);
  pinArms.delete(key);
  return at !== undefined && now - at >= 0 && now - at <= PIN_ARM_MS;
}

/* ── One-off pops, by the Web Animations API ────────────────────────────── */

/**
 * Plays a one-off animation on `el` if the browser can (jsdom cannot) and
 * motion is allowed. Transform keyframes are ADDED to the element's own
 * transform (`composite: 'add'`), so a card's place on the board is never
 * overwritten mid-pop. Returns the animation, or null when nothing played.
 */
export function atlasPop(
  el: Element | null | undefined,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
  reduced: boolean
): Animation | null {
  if (reduced || !el || typeof (el as HTMLElement).animate !== 'function') return null;
  try {
    return (el as HTMLElement).animate(keyframes, options);
  } catch {
    // An engine without additive transforms: skip the flourish, never the action.
    return null;
  }
}
