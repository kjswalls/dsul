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
