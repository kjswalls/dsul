import { z } from 'zod';

/**
 * Prep packs: what the AI got ready for an item, so the user only has to take
 * it from there (Do stuff's "done for you" lane, memory/plans/power-mode.md,
 * build order 3).
 *
 * Drafts first (Kirby's pick, 2026-10-12): the user's own model works from an
 * item's title and notes alone, with no web search and no inbox, so every
 * kind here is something it can write honestly from those. An email or a
 * message draft, a call script, or the first few steps. Nothing leaves the app
 * without the user's tap: the primary action opens their own mail, messages
 * or phone app with the draft in it, or copies it.
 *
 * Pure and client-safe: the schema is shared by /api/ai/prep (which checks
 * what the model wrote and what it reads back) and the peek card.
 */

/** How many items one ask may prepare. Small: each costs the user's own tokens. */
export const PREP_BATCH = 4;

const line = (max: number) => z.string().trim().max(max);

export const EmailPackSchema = z.object({
  kind: z.literal('email'),
  to: line(200).optional(),
  subject: line(200),
  body: line(4000),
});

export const MessagePackSchema = z.object({
  kind: z.literal('message'),
  to: line(200).optional(),
  body: line(1000),
});

export const CallPackSchema = z.object({
  kind: z.literal('call'),
  who: line(200),
  /** Only when the item's own title or notes had it; the model never guesses one. */
  number: line(40).optional(),
  script: z.array(line(300)).min(1).max(8),
});

export const StepsPackSchema = z.object({
  kind: z.literal('steps'),
  steps: z.array(line(200)).min(2).max(6),
});

/**
 * The one thing the AI needs to know before it can get the item ready
 * ("Which dentist do you usually see?"). Answering writes the answer into the
 * item's notes, so the next ask is about a changed item and can draft it.
 * Saved only once migration 078 lets the kind in; before that the route drops
 * questions and keeps the rest of the batch.
 */
export const QuestionPackSchema = z.object({
  kind: z.literal('question'),
  question: line(300).min(1),
  /** Two to four short likely answers, when there are obvious ones. */
  options: z.array(line(80).min(1)).min(2).max(4).optional(),
});

export const PackSchema = z.discriminatedUnion('kind', [
  EmailPackSchema,
  MessagePackSchema,
  CallPackSchema,
  StepsPackSchema,
  QuestionPackSchema,
]);

export type Pack = z.infer<typeof PackSchema>;
export type PackKind = Pack['kind'];

/** A stored pack: what was made, for which item, under which title. */
export interface PrepPack {
  itemId: string;
  pack: Pack;
  /** The title it was written for. A renamed item reads its pack as stale. */
  madeFor: string;
  updatedAt: string;
}

/** A question wants the person, so its chip is the warm one. */
export function packIsQuestion(pack: Pack): boolean {
  return pack.kind === 'question';
}

/**
 * The answer, as the line it adds to the item's notes: the question kept with
 * it, so the next ask (and the person, later) reads both together.
 */
export function answerNote(notes: string | undefined, question: string, answer: string): string {
  const line = `${question.trim()} ${answer.trim()}`;
  const before = (notes ?? '').trimEnd();
  return before ? `${before}\n${line}` : line;
}

/** The row's chip and the peek card's subtitle: what is ready. */
export function packLabel(pack: Pack): string {
  switch (pack.kind) {
    case 'email':
      return 'draft ready';
    case 'message':
      return 'message ready';
    case 'call':
      return 'script ready';
    case 'steps':
      return 'steps ready';
    case 'question':
      return '1 question';
  }
}

/** The kind, as the card names it. */
export function packKindName(pack: Pack): string {
  switch (pack.kind) {
    case 'email':
      return 'Email draft';
    case 'message':
      return 'Message draft';
    case 'call':
      return 'Call script';
    case 'steps':
      return 'First steps';
    case 'question':
      return 'A question first';
  }
}

/** Everything in the pack as plain text, for Copy. */
export function packText(pack: Pack): string {
  switch (pack.kind) {
    case 'email':
      return [...(pack.to ? [`To: ${pack.to}`] : []), `Subject: ${pack.subject}`, '', pack.body].join('\n');
    case 'message':
      return pack.body;
    case 'call':
      return [`${pack.who}${pack.number ? ` · ${pack.number}` : ''}`, '', ...pack.script.map((s) => `- ${s}`)].join('\n');
    case 'steps':
      return pack.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
    case 'question':
      return pack.question;
  }
}

/**
 * The tap that takes the pack out of the app, when there is one: the user's
 * own mail app with the draft filled in, their phone dialler. An email with no
 * address still opens a draft (the user fills in To); a call with no number
 * has no tap, only Copy.
 */
export function packHref(pack: Pack): string | null {
  switch (pack.kind) {
    case 'email': {
      const to = pack.to && /^[^\s@,;]+@[^\s@,;]+$/.test(pack.to) ? encodeURIComponent(pack.to) : '';
      return `mailto:${to}?subject=${encodeURIComponent(pack.subject)}&body=${encodeURIComponent(pack.body)}`;
    }
    case 'call': {
      const digits = pack.number?.replace(/[^\d+]/g, '') ?? '';
      return digits.length >= 3 ? `tel:${digits}` : null;
    }
    default:
      return null;
  }
}

/** The primary action's word. */
export function packAction(pack: Pack): string {
  switch (pack.kind) {
    case 'email':
      return 'Open in mail';
    case 'call':
      return packHref(pack) ? 'Call' : 'Copy script';
    default:
      return 'Copy';
  }
}

/** A pack written for another title is stale: the item has moved on. */
export function packIsStale(stored: PrepPack, title: string): boolean {
  return stored.madeFor.trim() !== title.trim();
}

/** Reads a stored row, dropping any whose body no longer fits the schema. */
export function packFromRow(row: {
  item_id: string;
  kind: string;
  body: unknown;
  made_for: string;
  updated_at: string;
}): PrepPack | null {
  const parsed = PackSchema.safeParse({ ...(row.body as object), kind: row.kind });
  if (!parsed.success) return null;
  return { itemId: row.item_id, pack: parsed.data, madeFor: row.made_for, updatedAt: row.updated_at };
}

/** The body column: the pack without its kind, which has a column of its own. */
export function packBody(pack: Pack): Record<string, unknown> {
  const { kind: _kind, ...body } = pack;
  void _kind;
  return body;
}
