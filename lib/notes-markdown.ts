/**
 * Item notes as markdown (thread "Add markdown to item notes", Kirby's pick
 * A + C, 2026-11-07). `items.notes` stays plain text in the database: what is
 * stored is exactly what was typed, so the iPhone app, the agent API and
 * OpenClaw read it unchanged. Only the web's item panel draws it: rendered at
 * rest (components/planner/notes-markdown.tsx) and, while it is being edited,
 * a plain textarea with the markers drawn faint behind it
 * (components/planner/live-notes-field.tsx).
 *
 * The pure parts live here so they can be tested without a DOM.
 */

/** A run of one line, as the live editor paints it. */
export type NotesSpanKind = 'text' | 'marker' | 'heading' | 'strong' | 'em' | 'code' | 'link';
export interface NotesSpan {
  kind: NotesSpanKind;
  text: string;
}

const HEADING = /^(\s{0,3}#{1,6}[ \t]+)(.*)$/;
const LIST = /^(\s*(?:[-*+]|\d{1,9}[.)])[ \t]+)(.*)$/;
const QUOTE = /^(\s{0,3}>[ \t]?)(.*)$/;

/**
 * One line of the source as runs the live editor can colour. Every character of
 * the line lands in exactly one run, in order, so the runs joined are the line:
 * the painted layer must wrap exactly where the textarea over it wraps, which
 * is why nothing here changes a glyph's width (no weight, no size, no italics:
 * bold is a text-shadow, see live-notes-field.tsx).
 */
export function notesLineSpans(line: string): NotesSpan[] {
  const h = HEADING.exec(line);
  if (h) return [{ kind: 'marker', text: h[1] }, ...(h[2] ? [{ kind: 'heading' as const, text: h[2] }] : [])];
  const lead = LIST.exec(line) ?? QUOTE.exec(line);
  if (lead) return [{ kind: 'marker', text: lead[1] }, ...inlineSpans(lead[2])];
  return inlineSpans(line);
}

/** `code`, **strong**, *em* / _em_, [text](url). Unclosed markers stay text. */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*|(?<!\w)_[^_\s][^_\n]*_(?!\w))|(\[[^\]\n]+\]\([^)\s]+\))/g;

function inlineSpans(text: string): NotesSpan[] {
  const out: NotesSpan[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    const start = m.index ?? 0;
    if (start > at) out.push({ kind: 'text', text: text.slice(at, start) });
    const s = m[0];
    if (m[1]) out.push({ kind: 'marker', text: '`' }, { kind: 'code', text: s.slice(1, -1) }, { kind: 'marker', text: '`' });
    else if (m[2]) out.push({ kind: 'marker', text: s.slice(0, 2) }, { kind: 'strong', text: s.slice(2, -2) }, { kind: 'marker', text: s.slice(-2) });
    else if (m[3]) out.push({ kind: 'marker', text: s[0] }, { kind: 'em', text: s.slice(1, -1) }, { kind: 'marker', text: s.slice(-1) });
    else {
      const close = s.indexOf('](');
      out.push(
        { kind: 'marker', text: '[' },
        { kind: 'link', text: s.slice(1, close) },
        { kind: 'marker', text: s.slice(close) }
      );
    }
    at = start + s.length;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

/** Lines with something on them: the "Show all · N lines" count. */
export function notesLineCount(source: string): number {
  return source.split('\n').filter((l) => l.trim()).length;
}

/**
 * Where in the source a click on the rendered note lands, so the editor opens
 * with the caret under the pointer rather than at the end.
 *
 * The rendered note holds the source's words without its markers, so the
 * clicked text node's words are looked for in the source, and of several
 * matches the one nearest `ratio` (how far through the rendered text the click
 * was) wins. With no match the ratio alone places it. Always a valid offset.
 */
export function notesCaretFor(source: string, nodeText: string, offset: number, ratio: number): number {
  const guess = Math.round(Math.min(1, Math.max(0, ratio)) * source.length);
  if (nodeText) {
    let best = -1;
    for (let i = source.indexOf(nodeText); i !== -1; i = source.indexOf(nodeText, i + 1)) {
      if (best === -1 || Math.abs(i - guess) < Math.abs(best - guess)) best = i;
    }
    if (best !== -1) return Math.min(source.length, best + Math.max(0, Math.min(offset, nodeText.length)));
  }
  return Math.min(source.length, guess);
}
