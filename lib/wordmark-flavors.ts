/**
 * The wordmark's hover flavors. Hovering "dsul" spells out what it stands for,
 * "do stuff unlimited", in the next flavor of this list; at rest it is always
 * `classic`, so the login card and the sidebar never disagree about the logo.
 *
 * The order is the cycle. The first seven read cleanly at the sidebar's 13px,
 * so a new device meets those before the poster-size ones. The styles live in
 * components/primitives/wordmark.css, keyed off `data-flavor`.
 */

export const WORDMARK_FLAVORS = [
  'classic',
  'pixel',
  'terminal',
  'marker',
  'bubble',
  'tape',
  'neon',
  'serif',
  'glitch',
  'wavy',
  'scramble',
  'arcade',
] as const;

export type WordmarkFlavor = (typeof WORDMARK_FLAVORS)[number];

export const WORDMARK_TEXT = 'do stuff unlimited';

/** Where d, s, u and l sit in WORDMARK_TEXT: the letters that stay at rest. */
const INITIALS = new Set([0, 3, 9, 11]);

export interface WordmarkChar {
  /** The character to draw, spaces as no-break spaces so they keep a width. */
  ch: string;
  /** One of the four resting letters. */
  initial: boolean;
  /** Position in the whole phrase, which drives the shimmer's sweep. */
  index: number;
  /** Position among the letters that grow in (-1 for an initial). */
  fillIndex: number;
}

export const WORDMARK_CHARS: readonly WordmarkChar[] = (() => {
  let fill = 0;
  return Array.from(WORDMARK_TEXT, (c, index) => {
    const initial = INITIALS.has(index);
    return {
      ch: c === ' ' ? ' ' : c,
      initial,
      index,
      fillIndex: initial ? -1 : fill++,
    };
  });
})();

export const WORDMARK_FILL_COUNT = WORDMARK_CHARS.filter((c) => !c.initial).length;

/** Per device, so each visit carries on through the cycle where the last one stopped. */
export const WORDMARK_CYCLE_KEY = 'dsul.wordmark.nextFlavor';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Where the cycle is when storage is blocked, so hovers still advance this visit. */
let inMemory = 0;

/** Index of the flavor the next hover shows. */
export function readNextFlavorIndex(): number {
  try {
    const raw = storage()?.getItem(WORDMARK_CYCLE_KEY);
    if (raw == null) return inMemory;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n < WORDMARK_FLAVORS.length ? n : 0;
  } catch {
    return inMemory;
  }
}

/** Takes the next flavor and advances the stored position past it. */
export function takeNextFlavor(): WordmarkFlavor {
  const i = readNextFlavorIndex();
  inMemory = (i + 1) % WORDMARK_FLAVORS.length;
  try {
    storage()?.setItem(WORDMARK_CYCLE_KEY, String(inMemory));
  } catch {
    // Private mode or blocked storage: inMemory carries the cycle for this visit.
  }
  return WORDMARK_FLAVORS[i];
}

/** One growing letter's slice of the unroll: when and how it moves, as fractions of the whole run. */
export interface FillPhase {
  delay: number;
  duration: number;
  /** The piece of the whole curve this slice covers, as a CSS timing function. */
  ease: string;
}

export interface FillTiming {
  /** Opening: when this letter starts to grow, for how long, on which piece of the curve. */
  in: FillPhase;
  /** Closing: the same, run from the far end back to the initials. */
  out: FillPhase;
}

/** The whole word's curve, a quadratic ease-out: how far it has reached at time `t`. */
const reachAt = (t: number) => 1 - (1 - t) ** 2;
/** Its slope at time `t`. */
const slopeAt = (t: number) => 2 * (1 - t);
/** Its inverse: when the word reaches `x` of its width. */
const timeAt = (x: number) => 1 - Math.sqrt(Math.max(0, 1 - x));

const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * The slice of the curve between distances `from` and `to`. A slice of a
 * quadratic is a quadratic, and a cubic-bezier whose x handles sit at thirds
 * draws any polynomial up to a cubic exactly, so each letter's timing
 * function is that slice with no approximation: the edge's speed carries
 * straight from one letter into the next.
 */
function phase(from: number, to: number): FillPhase {
  const t0 = timeAt(from);
  const t1 = timeAt(to);
  const dt = t1 - t0;
  const dx = reachAt(t1) - reachAt(t0);
  if (dt <= 0 || dx <= 0) return { delay: t0, duration: 0, ease: 'linear' };
  const v0 = (slopeAt(t0) * dt) / dx;
  const v1 = (slopeAt(t1) * dt) / dx;
  return {
    delay: t0,
    duration: dt,
    ease: `cubic-bezier(0.3333, ${r4(v0 / 3)}, 0.6667, ${r4(1 - v1 / 3)})`,
  };
}

/**
 * Turns the growing letters' natural widths into one smooth unroll.
 *
 * Each letter used to grow its own box toward a fixed 1.2em cap on an equal
 * stagger, so a narrow "i" filled its box in a frame and a wide "m" took
 * several, and the word grew in uneven lurches that stopped dead on the last
 * letter. Here the whole phrase is one ease-out over its total width: each
 * letter takes the stretch of time in which the word's edge crosses it, on
 * that stretch's piece of the curve, so the edge moves at one continuous,
 * slowing speed from the first letter to the last. Closing runs the same
 * curve from the far end. Zero widths (a page with no layout yet) fall back
 * to equal shares.
 */
export function unrollTimings(widths: readonly number[]): FillTiming[] {
  const usable = widths.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const total = usable.reduce((a, b) => a + b, 0);
  const share = total > 0 ? usable.map((w) => w / total) : usable.map(() => 1 / usable.length);
  let start = 0;
  return share.map((s, i) => {
    const end = i === share.length - 1 ? 1 : Math.min(1, start + s);
    const timing = { in: phase(start, end), out: phase(1 - end, 1 - start) };
    start = end;
    return timing;
  });
}
