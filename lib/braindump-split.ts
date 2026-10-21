import type { BulkDraft } from './bulk-add';

/**
 * BRAINDUMP TO THINGS (memory/plans/power-mode.md, "Braindump to done"): a
 * paragraph of everything on the person's mind, split by their own model into
 * separate things to do (/api/ai/split), shown in the bulk-add dialog to check
 * before Add, and then got ready by prep like anything else in the braindump.
 * Nothing is kept by the split; Add is the only write.
 */

/** The most of a paste the model is sent. */
export const MAX_SPLIT_CHARS = 6_000;
/** The most things one split makes. */
export const MAX_SPLIT_ITEMS = 30;
const MAX_TITLE = 200;
const MAX_NOTES = 1_000;

/** The model's answer, checked: titles kept, notes only where given, capped. */
export function splitDrafts(raw: unknown): BulkDraft[] {
  if (!Array.isArray(raw)) return [];
  const out: BulkDraft[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { title, notes } = entry as { title?: unknown; notes?: unknown };
    const t = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : '';
    if (!t) continue;
    const n = typeof notes === 'string' ? notes.trim().slice(0, MAX_NOTES) : '';
    out.push(n ? { title: t, notes: n } : { title: t });
    if (out.length === MAX_SPLIT_ITEMS) break;
  }
  return out;
}

/**
 * A paste worth offering to split: one paragraph (a list already splits by
 * line, lib/bulk-add.ts), long enough and holding more than one sentence or
 * clause. A long title pasted on its own is not one.
 */
export function isParagraphPaste(text: string): boolean {
  const t = text.trim();
  if (t.length < 120 || /\r|\n/.test(t)) return false;
  const sentences = t.split(/[.!?;]+\s+/).filter((s) => s.trim().length > 0).length;
  const clauses = t.split(/,\s+|\s+and\s+|\s+also\s+/i).length;
  return sentences >= 2 || clauses >= 4;
}
