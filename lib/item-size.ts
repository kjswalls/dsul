import { ItemSizeSchema, type ItemSize } from '@dsul/types';
import type { Item } from './planner-types';

/**
 * How big an undated thing is — the Do stuff extension's one idea.
 *
 * A braindump that sits for weeks reads as one pile: a two-minute email and
 * "plan the trip" look the same weight, so nothing gets picked. Sizing them
 * splits the pile into a few quick wins, the errands for when you are out, the
 * big things that need a block, and the fuzzy ones that need a first step
 * before they can be done at all (memory/handoffs/stale-braindump.md).
 *
 * The size is the user's own call, stored on the item (migration 066). This
 * module only names the sizes, guesses one for a title, and orders a walk
 * through them. Pure: no store, no React.
 */

export type { ItemSize };

/**
 * Anything that may carry a size: an Item, or a braindump row's legacy-shaped
 * task (which has no `type`).
 */
export interface Sizeable {
  size?: unknown;
}

export interface SizeDef {
  key: ItemSize;
  /** The word on a size button and in the menu. */
  label: string;
  /** The section header's plural. */
  plural: string;
  /** The header's right-hand hint: what this size asks of you. */
  hint: string;
  /** The 1–4 key that picks it, in the sizing card and the size menu. */
  digit: '1' | '2' | '3' | '4';
  /** The dot's colour: a token, so it follows the theme and dark mode. */
  color: string;
}

/**
 * In walk order: quick first (momentum), then errands (they batch), then the
 * big ones. Fuzzy is last and is never "up next" — a thing you cannot start is
 * not a thing to be handed; its hint points at the first step instead.
 */
export const SIZES: readonly SizeDef[] = [
  { key: 'quick', label: 'quick', plural: 'quick', hint: 'a few minutes each', digit: '1', color: 'var(--size-quick)' },
  { key: 'errand', label: 'errand', plural: 'errands', hint: 'next time you are out', digit: '2', color: 'var(--size-errand)' },
  { key: 'big', label: 'big', plural: 'big', hint: 'needs a block', digit: '3', color: 'var(--size-big)' },
  { key: 'fuzzy', label: 'fuzzy', plural: 'fuzzy', hint: 'find a first step', digit: '4', color: 'var(--size-fuzzy)' },
];

const BY_KEY = new Map(SIZES.map((s) => [s.key, s]));

export function sizeDef(size: ItemSize): SizeDef {
  return BY_KEY.get(size)!;
}

/** The sizes "up next" walks, in order. Fuzzy is deliberately not one. */
export const WALKED_SIZES: readonly ItemSize[] = ['quick', 'errand', 'big'];

/**
 * The item's size, narrowed. The stored field is a loose string on read (a
 * fifth size must not brick an old plugin), so anything outside the four is
 * treated as unsized rather than trusted.
 */
export function itemSizeOf(item: Item | Sizeable): ItemSize | undefined {
  // A habit has no size field at all (taskShape only), so it reads unsized.
  const parsed = ItemSizeSchema.safeParse((item as Sizeable).size);
  return parsed.success ? parsed.data : undefined;
}

export function sizeForDigit(key: string): ItemSize | null | undefined {
  if (key === '0') return null;
  return SIZES.find((s) => s.digit === key)?.key;
}

/* ── guessing ─────────────────────────────────────────────────────────── */

/**
 * Word rules, checked in order; the first that matches wins. Fuzzy goes first
 * because a question mark or "figure out" beats any verb in the same title
 * ("figure out who to call" is not a quick call). Errand before quick because
 * "pick up" and "drop off" are trips even when they are short.
 *
 * A guess is only ever OFFERED: it outlines a button, and nothing is stored
 * until the user picks it or keeps all guesses. So the rules can be plain and
 * a little wrong without costing anything.
 */
const RULES: readonly { size: ItemSize; pattern: RegExp }[] = [
  {
    size: 'fuzzy',
    pattern:
      /\?\s*$|\b(figure out|think about|decide|look into|sort out|work out|maybe|someday|explore|research|consider|idea)\b/i,
  },
  {
    size: 'errand',
    pattern:
      /\b(pick up|drop off|drop by|stop by|go to|return|buy|shop|shopping|groceries|grocery|store|post office|bank|pharmacy|dmv|car wash|smog|dry cleaning|hardware)\b/i,
  },
  {
    size: 'quick',
    pattern:
      /\b(call|email|e-mail|text|message|reply|respond|ask|remind|schedule|book|make an? .*appointment|pay|order|check|send|sign|renew|confirm|rsvp|hang up|unsubscribe|look up|update)\b/i,
  },
  {
    size: 'big',
    pattern:
      /\b(plan|clean|organi[sz]e|build|write|redo|renovate|move|learn|declutter|paint|fix up|set up|overhaul|make .*video|project|trip|taxes|deep)\b/i,
  },
];

/** A guess for a title, or undefined when no rule speaks. */
export function guessSize(title: string): ItemSize | undefined {
  const t = title.trim();
  if (!t) return undefined;
  return RULES.find((r) => r.pattern.test(t))?.size;
}

/* ── the walk ─────────────────────────────────────────────────────────── */

const idOf = (row: { item: object }) => (row.item as { id: string }).id;

/**
 * Splits rows (already in the braindump's own order) by size. Unsized rows are
 * kept in their own list, in order, for the sizing card.
 */
export function bySize<R extends { item: object }>(
  rows: readonly R[]
): { sized: Record<ItemSize, R[]>; unsized: R[] } {
  const sized: Record<ItemSize, R[]> = { quick: [], errand: [], big: [], fuzzy: [] };
  const unsized: R[] = [];
  for (const row of rows) {
    const size = itemSizeOf(row.item as Sizeable);
    if (size) sized[size].push(row);
    else unsized.push(row);
  }
  return { sized, unsized };
}

/**
 * What comes up next: the first open row of the first walked size that has
 * one, passing over what was skipped this session. Once nothing unskipped is
 * left in any walked size, the skipped ones come round again in the order they
 * were skipped, so "skip" means "later", never "gone".
 */
export function nextUp<R extends { item: object }>(
  sized: Record<ItemSize, readonly R[]>,
  isOpen: (row: R) => boolean,
  skipped: readonly string[]
): R | undefined {
  const open = WALKED_SIZES.flatMap((size) => sized[size].filter(isOpen));
  const fresh = open.find((r) => !skipped.includes(idOf(r)));
  if (fresh) return fresh;
  const order = (r: R) => skipped.indexOf(idOf(r));
  return [...open].sort((a, b) => order(a) - order(b))[0];
}
