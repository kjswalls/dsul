import type { Pack } from './prep-packs';

/**
 * HOW YOU WRITE: what the person's AI has learned from the drafts they changed
 * before using them (memory/plans/power-mode.md, "How you write"). A few short
 * lines of style, never content: tone, length, how they open and sign off, the
 * words they reach for. It lives in Do stuff's config (user_extensions.config),
 * so every device writes the same way, and Settings shows it, to change or to
 * clear. The edits themselves are never kept: the before and after go to the
 * person's own model once, to update these lines, and are gone.
 *
 * Off until the person says yes: each lesson is a call on their own model, and
 * the extension rule says nothing that costs money starts on. The first time
 * they take out a draft they changed, the card asks once.
 *
 * This file is pure: the keys, the reads, and what counts as an edit worth
 * learning from. The writer is lib/learn-style.ts.
 */

/** Do stuff's config key for the learned lines. */
export const WRITING_STYLE_KEY = 'writingStyle';
/** Do stuff's config key for the switch: true on, false asked and not on. */
export const LEARN_STYLE_KEY = 'learnStyle';

/** The most the lines may hold, as stored and as the model is sent them. */
export const MAX_STYLE_CHARS = 800;
/** The most of one draft, before or after, a lesson is sent. */
export const MAX_SAMPLE_CHARS = 2_000;
/** A change smaller than this many characters is a typo, not a style. */
const MIN_CHANGE_CHARS = 4;

type Config = Readonly<Record<string, unknown>> | undefined;

export function writingStyleOf(config: Config): string {
  const v = config?.[WRITING_STYLE_KEY];
  return typeof v === 'string' ? v.trim().slice(0, MAX_STYLE_CHARS) : '';
}

export function learnStyleOn(config: Config): boolean {
  return config?.[LEARN_STYLE_KEY] === true;
}

/** Has the card asked yet? Asked once, on any device, and never again. */
export function learnStyleAsked(config: Config): boolean {
  return typeof config?.[LEARN_STYLE_KEY] === 'boolean';
}

/** The kinds the person writes in their own voice. */
export type StyleKind = 'email' | 'message' | 'draft' | 'call';

/** A pack's own words, when it is one the person would send or say. */
export function writtenText(pack: Pack): { kind: StyleKind; text: string } | null {
  switch (pack.kind) {
    case 'email':
      // The body is the writing; a subject alone is not a draft.
      return { kind: 'email', text: pack.body.trim() ? [pack.subject.trim(), pack.body.trim()].filter(Boolean).join('\n\n') : '' };
    case 'message':
      return { kind: 'message', text: pack.body.trim() };
    case 'draft':
      return { kind: 'draft', text: pack.body.trim() ? [pack.title?.trim(), pack.body.trim()].filter(Boolean).join('\n\n') : '' };
    case 'call':
      return { kind: 'call', text: pack.script.map((l) => l.trim()).filter(Boolean).join('\n') };
    default:
      return null;
  }
}

export interface StyleEdit {
  kind: StyleKind;
  before: string;
  after: string;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The edit worth learning from, or null: the same kind, both sides written,
 * and more changed than a typo. Whitespace alone is never a style.
 */
export function styleEdit(before: Pack, after: Pack): StyleEdit | null {
  const a = writtenText(before);
  const b = writtenText(after);
  if (!a || !b || a.kind !== b.kind || !a.text || !b.text) return null;
  const x = squash(a.text);
  const y = squash(b.text);
  if (x === y) return null;
  // What changed is what lies between the common start and the common end.
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let end = 0;
  while (end < x.length - start && end < y.length - start && x[x.length - 1 - end] === y[y.length - 1 - end]) end++;
  const changed = Math.max(x.length - start - end, y.length - start - end);
  if (changed < MIN_CHANGE_CHARS) return null;
  return { kind: a.kind, before: a.text.slice(0, MAX_SAMPLE_CHARS), after: b.text.slice(0, MAX_SAMPLE_CHARS) };
}
