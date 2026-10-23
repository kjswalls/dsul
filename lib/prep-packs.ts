import { z } from 'zod';

/**
 * Prep packs: what the AI got ready for an item, so the user only has to take
 * it from there (Do stuff's "done for you" lane, memory/plans/power-mode.md,
 * build order 3).
 *
 * Drafts first (Kirby's pick, 2026-10-12): the user's own model works from an
 * item's title, notes and context, with no inbox, so every kind here is
 * something it can write honestly from those. With research on (Kirby,
 * 2026-10-20) it may also look things up on the web, and a pack then carries
 * the links it used (`sources`); options, lists, form answers and longer
 * drafts came with it. An email or a
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

/** A link the AI found: https only, and short enough to be a real page. */
export function isSafeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 500) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname.includes('.');
  } catch {
    return false;
  }
}

const Url = z.string().trim().refine(isSafeUrl);

/** The site a link goes to, as the card shows it beside the link. */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Where the facts in a pack came from, when the AI looked them up (the
 * research switch). A bad link is dropped, never the pack.
 */
const Sources = z.preprocess(
  (v) =>
    Array.isArray(v)
      ? v.filter((s) => s && typeof s === 'object' && isSafeUrl((s as { url?: unknown }).url)).slice(0, 5)
      : undefined,
  z.array(z.object({ title: line(120).default(''), url: Url })).optional()
);
const withSources = { sources: Sources };

/**
 * What the AI took the item to mean, when it was only fairly sure (Kirby's
 * pick C, 2026-10-23; lib/prep-rules.ts PREP_MEANING_RULES): the card shows it
 * on top, and "Not quite?" offers the alternates. A bad one is dropped, never
 * the pack.
 */
const withReading = {
  reading: line(200).min(1).optional().catch(undefined),
  alternates: z.array(line(120).min(1)).max(3).optional().catch(undefined),
};

export const EmailPackSchema = z.object({
  kind: z.literal('email'),
  to: line(200).optional(),
  subject: line(200),
  body: line(4000),
  ...withSources,
  ...withReading,
});

export const MessagePackSchema = z.object({
  kind: z.literal('message'),
  to: line(200).optional(),
  body: line(1000),
  ...withSources,
  ...withReading,
});

export const CallPackSchema = z.object({
  kind: z.literal('call'),
  who: line(200),
  /** Only when the item's own title or notes had it; the model never guesses one. */
  number: line(40).optional(),
  script: z.array(line(300)).min(1).max(8),
  ...withSources,
  ...withReading,
});

export const StepsPackSchema = z.object({
  kind: z.literal('steps'),
  steps: z.array(line(200)).min(2).max(6),
  ...withSources,
  ...withReading,
});

/** Two to four short likely answers, when there are obvious ones. */
const Options = z.array(line(80).min(1)).min(2).max(4).optional();

/** One question beyond the first, in `more`. A bad one is dropped, never the card. */
const MoreQuestion = z.object({
  question: line(300).min(1),
  options: Options.catch(undefined),
  multi: z.boolean().optional().catch(undefined),
});

/**
 * What the AI needs to know before it can get the item ready ("Who's
 * Sammy?"). Answering writes the answers into the item's notes, so the next
 * ask is about a changed item and can draft it. Up to three questions since
 * pick C (2026-10-23): the first is `question`, so a card written before then
 * still reads; `more` holds the rest. `multi` lets several answers be picked
 * ("What's settled already?"). Saved only once migration 078 lets the kind
 * in; before that the route drops questions and keeps the rest of the batch.
 */
export const QuestionPackSchema = z.object({
  kind: z.literal('question'),
  question: line(300).min(1),
  options: Options,
  multi: z.boolean().optional().catch(undefined),
  more: z
    .preprocess(
      (v) => (Array.isArray(v) ? v.filter((q) => MoreQuestion.safeParse(q).success).slice(0, 2) : undefined),
      z.array(MoreQuestion).optional()
    )
    .optional(),
});

/** One question as the card asks it. */
export interface PackQuestion {
  question: string;
  options?: string[];
  multi?: boolean;
}

/** Every question a question card asks, the first one first. */
export function packQuestions(pack: z.infer<typeof QuestionPackSchema>): PackQuestion[] {
  return [
    { question: pack.question, ...(pack.options ? { options: pack.options } : {}), ...(pack.multi ? { multi: true } : {}) },
    ...(pack.more ?? []).map((q) => ({
      question: q.question,
      ...(q.options ? { options: q.options } : {}),
      ...(q.multi ? { multi: true } : {}),
    })),
  ];
}

/** What the AI took a pack's item to mean, when it said; null when it was sure. */
export function packReading(pack: Pack): { reading: string; alternates: string[] } | null {
  if (pack.kind === 'question' || !pack.reading) return null;
  return { reading: pack.reading, alternates: pack.alternates ?? [] };
}

/**
 * The person's correction to a reading, as the line it adds to the item's
 * notes. The next ask reads it (PREP_QUESTION_RULE_LIST trusts it over the
 * title), and so does the person.
 */
export function meantNote(notes: string | undefined, meant: string): string {
  const line = `I meant: ${meant.trim()}`;
  const before = (notes ?? '').trimEnd();
  return before ? `${before}\n${line}` : line;
}

/**
 * Things the AI found to choose between: appointment slots, products, places.
 * Each with its own link, so the user books or buys on the real site.
 */
export const OptionsPackSchema = z.object({
  kind: z.literal('options'),
  intro: line(300).optional(),
  options: z
    .array(
      z.object({
        title: line(120).min(1),
        detail: line(300).optional(),
        when: line(80).optional(),
        price: line(40).optional(),
        url: Url.optional().catch(undefined),
      })
    )
    .min(1)
    .max(6),
  ...withSources,
  ...withReading,
});

/** A list to work through: shopping, packing, what to bring. */
export const ListPackSchema = z.object({
  kind: z.literal('list'),
  items: z.array(line(120).min(1)).min(1).max(40),
  ...withSources,
  ...withReading,
});

/** A form's answers, filled in to paste, and where the form is. Never submitted. */
export const FormPackSchema = z.object({
  kind: z.literal('form'),
  url: Url.optional().catch(undefined),
  fields: z
    // Sized under 074's 16,000-byte body check, sources included.
    .array(z.object({ label: line(120).min(1), value: line(600) }))
    .min(1)
    .max(15),
  ...withSources,
  ...withReading,
});

/** Longer writing than a message: a post, a letter, a bio, a description. */
export const DraftPackSchema = z.object({
  kind: z.literal('draft'),
  title: line(200).optional(),
  body: line(6000).min(1),
  ...withSources,
  ...withReading,
});

/**
 * Subtasks to add with one tap (Kirby's pick, 2026-10-21): the item broken
 * into real rows, where steps are only text. Nothing is added until the tap.
 */
export const SubtasksPackSchema = z.object({
  kind: z.literal('subtasks'),
  subtasks: z.array(line(200).min(1)).min(2).max(8),
  ...withReading,
});

/** For a "find out…" item: the answer itself, and where it came from. */
export const AnswerPackSchema = z.object({
  kind: z.literal('answer'),
  answer: line(1500).min(1),
  ...withSources,
  ...withReading,
});

/** Where to go: the place, its hours and number when a source had them. */
export const PlacePackSchema = z.object({
  kind: z.literal('place'),
  name: line(160).min(1),
  address: line(300).optional(),
  hours: line(200).optional(),
  phone: line(40).optional(),
  url: Url.optional().catch(undefined),
  ...withSources,
  ...withReading,
});

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A time to do it, which one tap puts on the day grid. `date` is the person's
 * own day (yyyy-MM-dd); without one it is today. Never a time in the past is
 * a prompt rule, not a check here: the card shows the time and the tap is the
 * person's.
 */
export const TimePackSchema = z.object({
  kind: z.literal('time'),
  date: z.string().regex(DATE_RE).optional().catch(undefined),
  time: z.string().regex(TIME_RE),
  /** Minutes, 5 to 8 hours. */
  duration: z.number().int().min(5).max(480).optional().catch(undefined),
  why: line(200).optional(),
  ...withReading,
});

/** Two to four choices side by side, and the one the AI would pick. */
export const PickPackSchema = z.object({
    kind: z.literal('pick'),
    question: line(200).optional(),
    choices: z
      .array(
        z.object({
          name: line(120).min(1),
          pros: z.array(line(120).min(1)).max(4).default([]),
          cons: z.array(line(120).min(1)).max(4).default([]),
          price: line(40).optional(),
          url: Url.optional().catch(undefined),
        })
      )
      .min(2)
      .max(4),
    /** The index of the AI's pick in `choices`. */
    recommended: z.number().int().min(0),
    why: line(300),
    ...withSources,
    ...withReading,
  });

/** The kinds 074 allowed; the rest wait on 078, 079 and 080 (the route's 23514 retry). */
export const ORIGINAL_PACK_KINDS: ReadonlySet<string> = new Set(['email', 'message', 'call', 'steps']);

export const PackSchema = z.discriminatedUnion('kind', [
  EmailPackSchema,
  MessagePackSchema,
  CallPackSchema,
  StepsPackSchema,
  QuestionPackSchema,
  OptionsPackSchema,
  ListPackSchema,
  FormPackSchema,
  DraftPackSchema,
  SubtasksPackSchema,
  AnswerPackSchema,
  PlacePackSchema,
  TimePackSchema,
  PickPackSchema,
]).refine((p) => p.kind !== 'pick' || p.recommended < p.choices.length);

/** The kinds 079 allowed; the five after it wait on 080. */
export const RESEARCH_PACK_KINDS: ReadonlySet<string> = new Set([
  ...ORIGINAL_PACK_KINDS,
  'question',
  'options',
  'list',
  'form',
  'draft',
]);

/**
 * The kinds whose tap changes the planner itself (subtasks added, the answer
 * kept in the notes, the item put on the day) rather than leaving the app.
 * prep-packs-store's `apply` is the one writer.
 */
export function packApplies(pack: Pack): boolean {
  return pack.kind === 'subtasks' || pack.kind === 'answer' || pack.kind === 'time';
}

/** "15:30" as the card says it: "3:30pm". */
export function clockLabel(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  const hour = h % 12 || 12;
  return m ? `${hour}:${String(m).padStart(2, '0')}${suffix}` : `${hour}${suffix}`;
}

/** A map search for a place, which opens the person's own maps on a phone. */
export function mapHref(pack: { name: string; address?: string }): string {
  const q = [pack.name, pack.address].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

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
  return answersNote(notes, [{ question, answer }]);
}

/** Several answers at once, a line each, in the order they were asked. */
export function answersNote(notes: string | undefined, answers: readonly { question: string; answer: string }[]): string {
  const lines = answers
    .filter((a) => a.answer.trim())
    .map((a) => `${a.question.trim()} ${a.answer.trim()}`);
  const before = (notes ?? '').trimEnd();
  return [...(before ? [before] : []), ...lines].join('\n');
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
    case 'question': {
      const n = 1 + (pack.more?.length ?? 0);
      return n === 1 ? '1 question' : `${n} questions`;
    }
    case 'options':
      return pack.options.length === 1 ? '1 option' : `${pack.options.length} options`;
    case 'list':
      return 'list ready';
    case 'form':
      return 'answers ready';
    case 'draft':
      return 'draft ready';
    case 'subtasks':
      return `${pack.subtasks.length} subtasks`;
    case 'answer':
      return 'answer found';
    case 'place':
      return 'place found';
    case 'time':
      return clockLabel(pack.time);
    case 'pick':
      return 'pick ready';
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
    case 'options':
      return 'Options found';
    case 'list':
      return 'A list';
    case 'form':
      return 'Form answers';
    case 'draft':
      return 'A draft';
    case 'subtasks':
      return 'Subtasks';
    case 'answer':
      return 'The answer';
    case 'place':
      return 'A place';
    case 'time':
      return 'A time for it';
    case 'pick':
      return 'A pick';
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
      return packQuestions(pack)
        .map((q) => q.question)
        .join('\n');
    case 'options':
      return [
        ...(pack.intro ? [pack.intro, ''] : []),
        ...pack.options.map((o) =>
          [o.title, o.when, o.price, o.detail, o.url].filter(Boolean).join(' · ')
        ),
      ].join('\n');
    case 'list':
      return pack.items.map((i) => `- ${i}`).join('\n');
    case 'form':
      return pack.fields.map((f) => `${f.label}: ${f.value}`).join('\n');
    case 'draft':
      return [...(pack.title ? [pack.title, ''] : []), pack.body].join('\n');
    case 'subtasks':
      return pack.subtasks.map((s) => `- ${s}`).join('\n');
    case 'answer':
      return pack.answer;
    case 'place':
      return [pack.name, pack.address, pack.hours, pack.phone, pack.url].filter(Boolean).join('\n');
    case 'time':
      return [`${pack.date ? `${pack.date} ` : ''}${clockLabel(pack.time)}${pack.duration ? ` · ${pack.duration} min` : ''}`, ...(pack.why ? [pack.why] : [])].join('\n');
    case 'pick':
      return [
        ...(pack.question ? [pack.question, ''] : []),
        ...pack.choices.map((c, i) =>
          [
            `${i === pack.recommended ? '★ ' : ''}${c.name}${c.price ? ` · ${c.price}` : ''}`,
            ...c.pros.map((p) => `  + ${p}`),
            ...c.cons.map((p) => `  - ${p}`),
            ...(c.url ? [`  ${c.url}`] : []),
          ].join('\n')
        ),
        '',
        pack.why,
      ].join('\n');
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
    case 'message': {
      // Only to a number: a name has no link, and the card offers the share
      // sheet or Copy instead. "?&body=" opens filled in on iOS and Android.
      const number = smsNumber(pack.to);
      return number ? `sms:${number}?&body=${encodeURIComponent(pack.body)}` : null;
    }
    case 'form':
      return pack.url ?? null;
    case 'place':
      return mapHref(pack);
    default:
      return null;
  }
}

/** A message's "to" as a number to text, when it is one (7 to 15 digits). */
export function smsNumber(to: string | undefined): string | null {
  if (!to || /[a-z@]/i.test(to)) return null;
  const digits = to.replace(/[^\d+]/g, '');
  const count = digits.replace(/\D/g, '').length;
  return count >= 7 && count <= 15 && /^\+?\d+$/.test(digits) ? digits : null;
}

/** Packs whose primary hands a message to someone: after it, "Sent it?". */
export function packSends(pack: Pack): boolean {
  return pack.kind === 'email' || pack.kind === 'message' || (pack.kind === 'call' && packHref(pack) !== null);
}

/** The primary action's word. */
export function packAction(pack: Pack): string {
  switch (pack.kind) {
    case 'email':
      return 'Open in mail';
    case 'message':
      return packHref(pack) ? 'Open in messages' : 'Copy';
    case 'call':
      return packHref(pack) ? 'Call' : 'Copy script';
    case 'form':
      return pack.url ? 'Open the form' : 'Copy answers';
    case 'list':
      return 'Copy list';
    case 'subtasks':
      return 'Add subtasks';
    case 'answer':
      return 'Keep in notes';
    case 'place':
      return 'Open in maps';
    case 'time':
      return 'Put it on the day';
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
