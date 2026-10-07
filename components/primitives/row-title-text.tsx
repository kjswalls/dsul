import { Fragment } from 'react';

/**
 * One emoji cluster or a run of them: a pictograph that presents as emoji (or
 * one asked to with U+FE0F), a keycap, then any skin tone, presentation
 * selector, keycap mark, tag sequence (subdivision flags) or ZWJ join that
 * belongs to it. A text-style symbol (©, ™, a bare ❤) is not one: it draws in
 * ink like the letters around it. Regional indicators present as emoji, so a
 * flag is two of them in a row.
 */
const EMOJI =
  /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|[#*0-9]\uFE0F?\u20E3)(?:\p{Emoji_Modifier}|\uFE0F|\u20E3|[\u{E0020}-\u{E007F}]|\u200D(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})\uFE0F?|\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|[#*0-9]\uFE0F?\u20E3)*/gu;

export interface TitleRun {
  text: string;
  emoji: boolean;
}

/** A title cut into its emoji runs and the text between them, in order. Joined, the runs are the title. */
export function splitEmoji(title: string): TitleRun[] {
  const runs: TitleRun[] = [];
  let at = 0;
  for (const match of title.matchAll(EMOJI)) {
    const start = match.index ?? 0;
    if (start > at) runs.push({ text: title.slice(at, start), emoji: false });
    runs.push({ text: match[0], emoji: true });
    at = start + match[0].length;
  }
  if (at < title.length || runs.length === 0) runs.push({ text: title.slice(at), emoji: false });
  return runs;
}

/**
 * A row title's text, with each emoji in its own `data-row-emoji` span. The
 * waiting shimmer (app/globals.css, lib/planner-shimmer.ts) draws a title's
 * ink as its own background clipped to its glyphs, and through that clip a
 * colour emoji is only a mask: it would turn into a flat silhouette in the
 * ink. The span keeps the emoji's own fill, so it stays in colour. A title
 * with no emoji renders as the bare string, exactly as before.
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
