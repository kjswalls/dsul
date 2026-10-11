/**
 * Option cards in chat: the ClawBoy convention (github.com/kjswalls/clawboy-expo,
 * docs/interactive-options.md), read and written the same way here so an agent
 * that asks a question with choices gets tappable buttons in dsul too.
 *
 * A reply ends with a markdown link-reference definition carrying JSON:
 *
 *   [clawboy-options]: <data:application/json,{"choices":[{"label":"Yes","value":"Yes please"}]}>
 *
 * Every markdown renderer drops an unused link-reference, so a client that does
 * not know the convention shows only the prose. Several questions go in one
 * card (`questions`, each with an `id`); the answer is ONE user message, a
 * hidden `[clawboy-answers]` link-reference with `{id: value | null}` (null is
 * skipped) above a readable summary. A card is answered once the next user
 * message arrives, whatever it says: only the latest reply's card is live.
 *
 * Read: the plain-JSON and base64 link-reference forms, and the legacy HTML
 * comment (`<!-- clawboy:options {...} -->`). Written: the answers in base64,
 * as ClawBoy writes them. A directive that does not parse is left in the text,
 * where markdown still hides it.
 *
 * Pure and client-safe; the saved message keeps its directive, so a reload
 * draws the same card in the state its answer left it.
 */

export interface OptionChoice {
  /** The button's words. */
  label: string;
  /** What is sent back when it is picked; standalone-readable. */
  value: string;
  /** A short line under the label. */
  hint?: string;
}

export interface OptionQuestion {
  /** The answer's key. `_single` for the one-question form. */
  id: string;
  prompt?: string;
  choices: OptionChoice[];
  /** A typed answer beside the buttons. Default true. */
  allowFreeText: boolean;
  freeTextPlaceholder?: string;
}

export type QuestionState =
  | { answered: false }
  | { answered: true; value?: string; freeText?: string };

/** At most this many questions and choices are drawn; the rest are dropped. */
export const MAX_QUESTIONS = 8;
export const MAX_CHOICES = 8;
const MAX_FIELD = 300;

const OPTIONS_JSON_RE = /^\[clawboy-options\]:\s*<data:application\/json,([^>\n]+)>\s*$/m;
const OPTIONS_B64_RE = /^\[clawboy-options\]:\s*<data:application\/json;base64,([A-Za-z0-9+/=]+)>\s*$/m;
const OPTIONS_STRIP_RE = /\n?\[clawboy-options\]:\s*<[^\n>]*>?\s*\n?/g;
const ANSWERS_JSON_RE = /^\[clawboy-answers\]:\s*<data:application\/json,([^>\n]+)>\s*$/m;
const ANSWERS_B64_RE = /^\[clawboy-answers\]:\s*<data:application\/json;base64,([A-Za-z0-9+/=]+)>\s*$/m;
const ANSWERS_STRIP_RE = /\n?\[clawboy-answers\]:\s*<[^\n>]*>?\s*\n?/g;
const LEGACY_OPTIONS_RE = /<!--\s*clawboy:options\s*([\s\S]*?)\s*-->/gi;
const LEGACY_ANSWERS_RE = /<!--\s*clawboy:answers\s*([\s\S]*?)\s*-->/i;
/** Any clawboy comment, complete or still streaming in. */
const LEGACY_STRIP_RE = /<!--\s*clawboy:[\s\S]*?(?:-->|$)/gi;

function fromBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function toBase64(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, MAX_FIELD) : undefined;

function choicesOf(raw: unknown): OptionChoice[] {
  if (!Array.isArray(raw)) return [];
  const out: OptionChoice[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const label = str(o.label);
    const value = str(o.value);
    if (!label || !value) continue;
    const hint = str(o.hint);
    out.push({ label, value, ...(hint ? { hint } : {}) });
    if (out.length === MAX_CHOICES) break;
  }
  return out;
}

function questionOf(o: Record<string, unknown>, id: string): OptionQuestion | null {
  const choices = choicesOf(o.choices);
  if (choices.length === 0) return null;
  const prompt = str(o.prompt);
  const placeholder = str(o.freeTextPlaceholder);
  return {
    id,
    ...(prompt ? { prompt } : {}),
    choices,
    allowFreeText: typeof o.allowFreeText === 'boolean' ? o.allowFreeText : true,
    ...(placeholder ? { freeTextPlaceholder: placeholder } : {}),
  };
}

/** A directive's JSON as questions, or null when it holds none. */
function questionsOf(body: string): OptionQuestion[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj.questions) && obj.questions.length > 0) {
    const out: OptionQuestion[] = [];
    const seen = new Set<string>();
    obj.questions.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object' || out.length === MAX_QUESTIONS) return;
      let id = str((raw as Record<string, unknown>).id) ?? `q${i + 1}`;
      if (seen.has(id)) id = `${id}_${i}`;
      const q = questionOf(raw as Record<string, unknown>, id);
      if (!q) return;
      seen.add(id);
      out.push(q);
    });
    return out.length > 0 ? out : null;
  }
  const single = questionOf(obj, '_single');
  return single ? [single] : null;
}

export interface ParsedOptions {
  /** The text with a valid directive taken out: what is shown and copied. */
  text: string;
  /** The card's questions, or null when the text has none. */
  questions: OptionQuestion[] | null;
}

/** An assistant message's card, and its words without the directive. */
export function parseOptions(text: string): ParsedOptions {
  if (text.includes('[clawboy-options]')) {
    const json = OPTIONS_JSON_RE.exec(text);
    const fromJson = json ? questionsOf(json[1]) : null;
    if (fromJson) return { text: text.replace(OPTIONS_STRIP_RE, '').trimEnd(), questions: fromJson };
    const b64 = OPTIONS_B64_RE.exec(text);
    if (b64) {
      let body: string | null = null;
      try {
        body = fromBase64(b64[1]);
      } catch {
        body = null;
      }
      const fromB64 = body ? questionsOf(body) : null;
      if (fromB64) return { text: text.replace(OPTIONS_STRIP_RE, '').trimEnd(), questions: fromB64 };
    }
  }
  if (!/clawboy:options/i.test(text)) return { text, questions: null };
  // The legacy comment: the last valid one wins.
  let found: { questions: OptionQuestion[]; start: number; end: number } | null = null;
  LEGACY_OPTIONS_RE.lastIndex = 0;
  for (let m = LEGACY_OPTIONS_RE.exec(text); m; m = LEGACY_OPTIONS_RE.exec(text)) {
    const qs = questionsOf(m[1]);
    if (qs) found = { questions: qs, start: m.index, end: m.index + m[0].length };
  }
  if (!found) return { text, questions: null };
  return { text: (text.slice(0, found.start).trimEnd() + text.slice(found.end)).trimEnd(), questions: found.questions };
}

/**
 * Text with every directive taken out, complete or half-streamed: what a
 * reply shows while it is still arriving, and what a user's answer shows.
 */
export function stripOptionDirectives(text: string): string {
  const hasComment = /clawboy:/i.test(text);
  const hasRef = text.includes('[clawboy-options]') || text.includes('[clawboy-answers]');
  if (!hasComment && !hasRef) return text;
  let out = text;
  if (hasComment) out = out.replace(LEGACY_STRIP_RE, '');
  if (hasRef) out = out.replace(OPTIONS_STRIP_RE, '\n').replace(ANSWERS_STRIP_RE, '\n');
  return out.trim();
}

function answerMap(raw: unknown): Record<string, string | null> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (v === null) out[k] = null;
  }
  return out;
}

/** A user message's answers by question id (null is skipped), or null when it has none. */
export function parseAnswers(text: string): Record<string, string | null> | null {
  if (text.includes('[clawboy-answers]')) {
    const json = ANSWERS_JSON_RE.exec(text);
    if (json) {
      try {
        const m = answerMap(JSON.parse(json[1]));
        if (m) return m;
      } catch {
        // the base64 form next
      }
    }
    const b64 = ANSWERS_B64_RE.exec(text);
    if (b64) {
      try {
        const m = answerMap(JSON.parse(fromBase64(b64[1])));
        if (m) return m;
      } catch {
        // the comment form next
      }
    }
  }
  const legacy = LEGACY_ANSWERS_RE.exec(text);
  if (!legacy) return null;
  try {
    return answerMap(JSON.parse(legacy[1]));
  } catch {
    return null;
  }
}

/**
 * The one user message a card's answers go back as: the hidden answers in
 * base64, then what a person reads (the picked label, or the typed words;
 * one line per question, under its prompt, when there are several).
 */
export function composeAnswers(questions: readonly OptionQuestion[], answers: Record<string, string | null>): string {
  const json: Record<string, string | null> = {};
  const shown: string[] = [];
  for (const q of questions) {
    const a = answers[q.id] ?? null;
    json[q.id] = a;
    shown.push(a === null ? '(skipped)' : (q.choices.find((c) => c.value === a)?.label ?? a));
  }
  const summary =
    questions.length === 1
      ? shown[0]
      : questions.map((q, i) => `**${q.prompt ?? `Question ${i + 1}`}**\n${shown[i]}`).join('\n\n');
  return `[clawboy-answers]: <data:application/json;base64,${toBase64(JSON.stringify(json))}>\n\n${summary}`;
}

/**
 * Each question's state, from the user message that came next (none: every
 * question is still open). An answers directive says it per question; a plain
 * message answers a one-question card by its words (a choice when they match
 * one), and closes a longer card without answers.
 */
export function questionStates(
  questions: readonly OptionQuestion[],
  next: string | null | undefined
): Record<string, QuestionState> {
  const text = next?.trim();
  if (!text) return Object.fromEntries(questions.map((q) => [q.id, { answered: false } as QuestionState]));
  const match = (q: OptionQuestion, a: string) =>
    q.choices.find((c) => c.value.trim().toLowerCase() === a.trim().toLowerCase() || c.label.trim().toLowerCase() === a.trim().toLowerCase());
  const answers = parseAnswers(text);
  if (answers) {
    return Object.fromEntries(
      questions.map((q): [string, QuestionState] => {
        const a = answers[q.id] ?? null;
        if (a === null) return [q.id, { answered: true }];
        const c = match(q, a);
        return [q.id, c ? { answered: true, value: c.value } : { answered: true, freeText: a }];
      })
    );
  }
  if (questions.length === 1) {
    const q = questions[0];
    const c = match(q, text);
    return { [q.id]: c ? { answered: true, value: c.value } : { answered: true, freeText: text } };
  }
  return Object.fromEntries(questions.map((q) => [q.id, { answered: true } as QuestionState]));
}

/**
 * What dsul's own model is told about the convention: one paragraph of the
 * system prompt. Short on purpose; the card degrades to the prose anywhere else.
 */
export const OPTIONS_PROMPT_SENTENCE =
  'When you ask the user to pick between a few clear options (a yes or no, a choice of two to five), write the question as normal text, then end your reply with one line in exactly this form: ' +
  '[clawboy-options]: <data:application/json,{"choices":[{"label":"Short button text","value":"The full reply to send if picked"}]}> ' +
  'Use plain JSON on that one line, with no ">" inside it. Do not use it for open questions or summaries. ';
