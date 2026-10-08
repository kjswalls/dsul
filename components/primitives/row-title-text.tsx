import { Fragment } from 'react';

/**
 * Whether one grapheme draws as an emoji: it holds a pictograph that presents
 * as emoji, or a text-default one that a presentation selector, a skin tone or
 * a ZWJ join turns into one (✍🏽, 🏋🏽‍♀️, 👁‍🗨), or it is a keycap. A
 * text-style symbol (©, ™, a bare ❤) is not one: it draws in ink like the
 * letters around it. Regional indicators present as emoji, so a flag is one.
 */
const EMOJI_GRAPHEME =
  /\p{Emoji_Presentation}|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})|[#*0-9]\uFE0F?\u20E3/u;

/**
 * Where the engine has no Intl.Segmenter, a close stand-in for graphemes:
 * each emoji sequence whole (a lead, then any skin tone, selector, keycap
 * mark, tag or ZWJ join), and any other character with the marks, skin tones
 * and joiners that extend it.
 */
const CLUSTER =
  /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|(?=\u200D\p{Extended_Pictographic}))|[#*0-9]\uFE0F?\u20E3)(?:\p{Emoji_Modifier}|\uFE0F|\u20E3|[\u{E0020}-\u{E007F}]|\u200D(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}))*|[\s\S][\p{Grapheme_Extend}\p{Emoji_Modifier}\u200D]*/gu;

/** Nothing in a title without one of these can draw as an emoji: most titles stop here. */
const MAYBE_EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\u20E3]/u;

const SEGMENTER: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

export interface TitleRun {
  text: string;
  emoji: boolean;
}

/**
 * A title cut into its emoji runs and the text between them, in order. Joined,
 * the runs are the title, and every cut is a grapheme boundary: a skin tone,
 * a ZWJ or a selector never lands in a different node from its base, where
 * Chromium would shape the pair as one glyph owned by the text (a silhouette)
 * and WebKit would draw the base and the swatch apart. `segmenter` is for tests.
 */
export function splitEmoji(title: string, segmenter: Intl.Segmenter | null = SEGMENTER): TitleRun[] {
  if (!MAYBE_EMOJI.test(title)) return [{ text: title, emoji: false }];
  const parts = segmenter
    ? Array.from(segmenter.segment(title), (s) => s.segment)
    : (title.match(CLUSTER) ?? []);
  const runs: TitleRun[] = [];
  for (const part of parts) {
    const emoji = EMOJI_GRAPHEME.test(part);
    const last = runs[runs.length - 1];
    if (last && last.emoji === emoji) last.text += part;
    else runs.push({ text: part, emoji });
  }
  return runs.length > 0 ? runs : [{ text: title, emoji: false }];
}

/**
 * A row title's text, with each emoji in its own `data-row-emoji` span. The
 * waiting shimmer (app/globals.css, lib/planner-shimmer.ts) draws a title's
 * ink as its own background clipped to its glyphs, and through that clip a
 * colour emoji is only a mask: it would turn into a flat silhouette in the
 * ink. The span keeps the emoji's own fill, so it stays in colour. A title
 * with no emoji renders as the bare string, exactly as before.
 *
 * Anything that looks for a title's element by its text treats these spans as
 * part of it: Zen's flight (components/zen/zen-stage.tsx findSourceTitle) and
 * the settle's type-in (lib/settle.ts textEndX), which paces itself to the
 * whole `[data-row-title]` element.
 */
export function RowTitleText({ text }: { text: string }) {
  const runs = splitEmoji(text);
  if (!runs.some((run) => run.emoji)) return text;
  return runs.map((run, i) =>
    run.emoji ? (
      <span key={i} data-row-emoji="">
        {run.text}
      </span>
    ) : (
      <Fragment key={i}>{run.text}</Fragment>
    )
  );
}
