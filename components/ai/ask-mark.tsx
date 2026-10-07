import { forwardRef, type Ref } from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Where the mark's light sits: the centre of its lit part, in CSS px from the
 * centre of its 16px slot. The Ask key's rim is lit from here
 * (app/globals.css, "Ask's key"), so its brightest arc is the one beside the
 * lit tile. Aurora step's lit part is its accent foot, the 8px tile whose
 * centre is (4, 12) in the 16-unit viewBox: 4px left of the slot's centre and
 * 4px below it. A mark with no lit part says { x: 0, y: 0 }.
 */
export const ASK_MARK_LIGHT = { x: -4, y: 4 } as const;

/*
 * The tiles' paint. Every colour is a theme token from the mark's slot
 * contract (app/globals.css, "Ask's key", declared on [data-ask-mark] and on
 * the key), so every look and tint follows:
 *   --ask-icon-accent    the theme accent, the light: full strength, never faded
 *   --ask-icon-pair-ink  the look's aurora partner, deep enough to carry 3:1
 * The middle tile is a solid blend 40% of the way from the accent to the
 * head, in oklch so the hue keeps its chroma. Nothing is faded: every step is
 * a different solid colour.
 *
 * Engaged (the Ask key, `group/ask-key`, hovered, keyboard-focused or
 * pressed), the light is handed one step up the band and held there: the
 * middle tile takes the accent at once, then 60ms later the head grows from
 * 4px to 5px, anchored at its outer corner. Leaving runs it back in reverse
 * (the head first, the middle tile 60ms later). Each is one property, 160ms;
 * nothing moves at rest, under reduced motion, or anywhere outside the key
 * (Ask's header and every other place the mark is drawn show it still).
 */
const FOOT = 'fill-[var(--ask-icon-accent)]';
const MID = cn(
  'fill-[color-mix(in_oklch,var(--ask-icon-accent),var(--ask-icon-pair-ink)_40%)]',
  'transition-[fill] delay-[60ms] duration-[160ms] ease-[var(--ease-out-soft)] motion-reduce:transition-none',
  'group-hover/ask-key:fill-[var(--ask-icon-accent)] group-hover/ask-key:delay-0',
  'group-focus-visible/ask-key:fill-[var(--ask-icon-accent)] group-focus-visible/ask-key:delay-0',
  'group-active/ask-key:fill-[var(--ask-icon-accent)] group-active/ask-key:delay-0'
);
const HEAD = cn(
  'origin-top-right fill-[var(--ask-icon-pair-ink)] [transform-box:fill-box]',
  'transition-[scale] duration-[160ms] ease-[var(--ease-out-soft)] motion-reduce:transition-none',
  'group-hover/ask-key:scale-125 group-hover/ask-key:delay-[60ms]',
  'group-focus-visible/ask-key:scale-125 group-focus-visible/ask-key:delay-[60ms]',
  'group-active/ask-key:scale-125 group-active/ask-key:delay-[60ms]'
);
/** The one-ink mark: every tile in the text colour round it, and still. */
const INK = 'fill-current';

/**
 * Which paint the mark wears:
 *  - 'aurora'  its own colours (the accent foot, the blend, the partner head),
 *              wherever the AI is named in colour.
 *  - 'ink'     one solid ink, `currentColor`, for a slot that colours its
 *              glyph itself: a row of line icons in one muted ink, a notice
 *              tinted red for a failure, the phone's mode card, which carries
 *              no colour on purpose (mobile-redesign.md).
 */
export type AskMarkTone = 'aurora' | 'ink';

type DataAttributes = { [key: `data-${string}`]: string | undefined };

function Mark({
  tone,
  className,
  data,
  ref,
  sized,
}: {
  tone: AskMarkTone;
  className?: string;
  data?: DataAttributes;
  ref?: Ref<SVGSVGElement>;
  /** Width and height attributes, Lucide's way, for a slot that sizes by class. */
  sized?: boolean;
}) {
  const [foot, mid, head] = tone === 'ink' ? [INK, INK, INK] : [FOOT, MID, HEAD];
  return (
    <svg
      ref={ref}
      {...data}
      data-ask-mark="aurora-step"
      data-tone={tone}
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      fill="none"
      {...(sized ? { width: 16, height: 16 } : null)}
      className={cn('shrink-0 overflow-visible', className)}
    >
      <rect x="0" y="8" width="8" height="8" rx="2" className={foot} />
      <rect x="7" y="3" width="6" height="6" rx="1.5" className={mid} />
      <rect x="12" y="0" width="4" height="4" rx="1" className={head} />
    </svg>
  );
}

/**
 * The AI's mark, "Aurora step": the app icon's diagonal glow band as three
 * tiles that shrink away from the light (8, 6 and 4px on whole pixels, joined
 * corner to corner by a 1px overlap). The lime foot sits beside the key's
 * glint, then mint, then a deep-teal head (in dark: lime, mint, cyan; each
 * look's own accent and partner elsewhere).
 *
 * It is drawn for a 16px slot (size-4) and scales to any other by a size
 * class (`size-3` in a hint, `size-6` over a new chat's greeting), and it is
 * decorative: what carries it names itself ("Open Ask", the "Ask" heading,
 * "Ask AI"). `data-*` attributes pass through (History's `data-glyph`).
 *
 * THIS FILE IS THE MARK, and it is the AI's mark everywhere: the Ask key
 * (components/ai/rail/ask-opener.tsx), Ask's header
 * (components/ai/rail/rail-header.tsx), and every place that marks AI, where
 * Lucide's Sparkles used to (the Ask rows in ⌘K and the right-click menu, a
 * proposal, a general conversation in History, a new chat's greeting, the
 * agent block, the AI settings pane, the AI notices, the phone's Ask glyph;
 * tests/unit/ask-key.test.tsx lists them). Each renders <AskMark /> or
 * <AskMarkIcon />, the key reads
 * ASK_MARK_LIGHT to aim its rim light, and nothing else knows what the mark
 * looks like. Swapping it is a change to this file alone: a new svg on the
 * same slot and tokens, and its own light point.
 *
 * Where the sparkle was the AI's honey, the mark wears its own colours
 * ('aurora', the default); where it took the ink of the row it sat in, the
 * mark does too ('ink'), so a muted list stays one ink and a failure stays red.
 */
export function AskMark({
  className,
  tone = 'aurora',
  ...data
}: { className?: string; tone?: AskMarkTone } & DataAttributes) {
  return <Mark tone={tone} data={data} className={cn('size-4', className)} />;
}

/**
 * The one-ink mark where a slot takes a Lucide icon (a settings pane's, a
 * command's, a notice's, the phone's mode glyphs). Sized like Lucide's: 16px
 * by its attributes until the slot's own class sizes it, so `h-3.5 w-3.5` and
 * `size-3` both win. Only `className` is read: a slot's `strokeWidth` means
 * nothing to filled tiles, and the mark is always decorative.
 */
export const AskMarkIcon: LucideIcon = forwardRef<SVGSVGElement, Omit<LucideProps, 'ref'>>(function AskMarkIcon(
  { className },
  ref
) {
  return <Mark ref={ref} tone="ink" sized className={className} />;
});
