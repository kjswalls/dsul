import { MAX_ASSISTANT_CHARS, MAX_MESSAGE_CHARS } from './ai-limits';

/**
 * Saved AI conversations: the shapes /api/ai/conversations/** speaks, the caps,
 * and the text cleaning every saved string goes through.
 *
 * Client-safe (tests/unit/ai-server-boundary.test.ts): the store imports it as
 * freely as the routes do. Migration 057 holds the same caps as CHECKs, and
 * tests/unit/chat-migration.test.ts pins the two together.
 *
 * Nothing here is ever error copy: a failed reply is `status: 'error'` plus a
 * short `errorCode`, and its words are the client's (lib/chat-errors.ts).
 */

export type Answerer = 'model' | 'openclaw';
export type MessageStatus = 'complete' | 'stopped' | 'error';

/** What accepted proposals changed, for History's second line. Counters only. */
export interface ConversationChanges {
  added: number;
  steps: number;
  moved: number;
  changed: number;
}

/** One History row. An item conversation's live title comes from the planner, not here. */
export interface ConversationSummary {
  id: string;
  itemId: string | null;
  title: string;
  renamed: boolean;
  starred: boolean;
  /** Who answered last. */
  answerer: Answerer | null;
  /** True once any saved reply came from OpenClaw; never cleared (the delete confirm). */
  openclawSeen: boolean;
  changes: ConversationChanges;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

export interface StoredMessage {
  id: string;
  pos: number;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  errorCode: string | null;
  replyTo: string | null;
  answerer: Answerer | null;
  /** The connection's model id on the model path; null for OpenClaw. */
  model: string | null;
  createdAt: string;
  /** A reply's action lines (migration 068's `meta.actions`); absent when it has none. */
  actions?: string[];
}

/** What a client sends for one message. `meta` itself is never accepted. */
export interface TurnMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: MessageStatus;
  errorCode?: string | null;
  replyTo?: string | null;
  answerer?: Answerer | null;
  model?: string | null;
  /** A reply only: what the AI looked up, in dsul's words (cleanActions). */
  actions?: string[];
}

export interface TurnCreate {
  itemId: string | null;
  title: string;
}

/** POST /api/ai/conversations/[id]/turns. */
export interface TurnRequest {
  /** The account the save was queued under; the route refuses any other (403). */
  ownerId: string;
  /** Only on the conversation's first write. */
  create?: TurnCreate;
  /** A user message, optionally followed by its reply; or a reply alone whose user row is saved. */
  messages: [TurnMessage] | [TurnMessage, TurnMessage];
}

/**
 * PATCH /api/ai/conversations/[id]: a rename and/or a star, OR one tally, never
 * both in one call (400). A tally is an increment, so it travels alone: the
 * one statement that commits it also answers the row, and nothing else in the
 * call can fail after it has landed.
 */
export type ConversationPatch =
  | {
      /** Sets `renamed`. One line, cut to CHAT_LIMITS.titleChars. */
      title?: string;
      starred?: boolean;
      addChanges?: never;
    }
  | {
      /** Added to the counters, each 0..CHAT_LIMITS.changesPerCall. */
      addChanges: Partial<ConversationChanges>;
      title?: never;
      starred?: never;
    };

export interface SearchHit extends ConversationSummary {
  matched: 'title' | 'message';
  /** About 160 characters around the newest matching message; null for a title hit. */
  snippet: string | null;
  /** The linked item's current title (null when there is none, or it is in the trash). */
  itemTitle: string | null;
}

/** GET /api/ai/conversations. `starred` comes on the first page only, every starred row. */
export interface ConversationListResponse {
  conversations: ConversationSummary[];
  starred?: ConversationSummary[];
  nextCursor: string | null;
}

/** GET /api/ai/conversations?itemId=: the item's one conversation, or none. */
export interface ItemConversationResponse {
  conversations: [ConversationSummary] | [];
}

/** GET /api/ai/conversations/[id]: up to CHAT_LIMITS.threadPage messages, ascending. */
export interface ThreadResponse {
  conversation: ConversationSummary;
  messages: StoredMessage[];
  hasEarlier: boolean;
}

export interface TurnResponse {
  conversation: ConversationSummary;
  inserted: number;
}

export interface SearchResponse {
  results: SearchHit[];
}

export const CHAT_LIMITS = {
  /** 8,000 (lib/ai-limits.ts): the cut the model is sent, and chat_messages_user_check. */
  userChars: MAX_MESSAGE_CHARS,
  /** 40,000 (lib/ai-limits.ts): the model path's stream cap, and chat_messages_assistant_check. */
  assistantChars: MAX_ASSISTANT_CHARS,
  titleChars: 200,
  autoTitleChars: 60,
  pageSize: 30,
  maxPageSize: 50,
  threadPage: 100,
  /**
   * A search query's bounds after trim, in code points (an emoji is one), as
   * chat_search's char_length counts them; never `.length`, which counts an
   * emoji as two.
   */
  searchMin: 2,
  searchMax: 100,
  searchResults: 50,
  /**
   * Each counter of one PATCH `addChanges`, at most (a proposal carries at most
   * 20 operations, ProposalSchema; chat_note_changes clamps to the same). The
   * route refuses more with a 400, so a client never sums tallies into one
   * PATCH: each accepted proposal's tally is its own call. And a tally is an
   * increment, not idempotent: one whose PATCH failed with a network error or
   * a 5xx may already have landed, so it is dropped, never re-sent.
   */
  changesPerCall: 20,
  /**
   * A reply's action lines, at most, and each line's length: the chat loop's
   * 4 rounds of 4 lookups, and the wire's cap (lib/ai-server/stream.ts).
   * chat_append (068) cuts to the same.
   */
  actions: 16,
  actionChars: 200,
} as const;

export const DEFAULT_TITLE = 'New chat';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** chat_messages_status_check's rule for `error_code`. */
export const ERROR_CODE_RE = /^[a-z_]{1,32}$/;

export function isAnswerer(v: unknown): v is Answerer {
  return v === 'model' || v === 'openclaw';
}

export function isMessageStatus(v: unknown): v is MessageStatus {
  return v === 'complete' || v === 'stopped' || v === 'error';
}

/** A surrogate pair, or a lone half of one. Without the `u` flag this matches code units. */
const SURROGATES = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

/**
 * Text Postgres will accept, at most `max` UTF-16 code units.
 *
 * - A lone surrogate becomes U+FFFD (what `String.prototype.toWellFormed` does,
 *   without needing an ES2024 runtime): Postgres refuses it in JSON, 22P02.
 * - U+0000 is removed: Postgres text cannot hold it, 22P05.
 * - The cut never ends on a high surrogate, so it never makes a lone one.
 *
 * At most `max` code units is at most `max` code points, which is what the
 * CHECKs' char_length counts. Every clip of saved text uses this: both caps,
 * titles, deriveTitle, and the keepalive save.
 */
export function cleanText(s: string, max: number): string {
  if (typeof s !== 'string' || !(max > 0)) return '';
  let t = s.replace(SURROGATES, (m) => (m.length === 2 ? m : '\uFFFD'));
  if (t.includes('\u0000')) t = t.split('\u0000').join('');
  if (t.length > max) {
    t = t.slice(0, max);
    const last = t.charCodeAt(t.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
  }
  return t;
}

/**
 * Runs of whitespace and control characters (C0, DEL, C1; U+2028 and U+2029
 * are in `\s`) become one space, trimmed: what chat_conversations_title_check
 * accepts, and what chat_append does to a title on create.
 */
function oneLine(s: string): string {
  return s.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

/** A title as saved: one line, at most CHAT_LIMITS.titleChars. '' when nothing is left. */
export function cleanTitle(s: string): string {
  if (typeof s !== 'string') return '';
  return cleanText(oneLine(s), CHAT_LIMITS.titleChars).trimEnd();
}

/** Where a too-long auto title may break on a space, at the earliest. */
const WORD_CUT_MIN = 40;

/**
 * A conversation's automatic title, from its first message. No model call.
 *
 * The first line with something on it, a leading "?" (the command bar's ask
 * prefix) dropped, whitespace collapsed and control characters stripped. Over
 * CHAT_LIMITS.autoTitleChars it is cut on a word boundary at or after
 * character 40 when there is one, and ends in "…", the whole at most 60.
 * "New chat" when nothing is left.
 */
export function deriveTitle(text: string): string {
  const max = CHAT_LIMITS.autoTitleChars;
  for (const raw of cleanText(typeof text === 'string' ? text : '', CHAT_LIMITS.userChars).split(/\r\n|[\n\r\u2028\u2029]/)) {
    const line = oneLine(raw).replace(/^\?[?\s]*/, '');
    if (line === '') continue;
    if (line.length <= max) return line;
    const cut = cleanText(line, max - 1);
    const space = cut.lastIndexOf(' ');
    return `${(space >= WORD_CUT_MIN ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return DEFAULT_TITLE;
}

/**
 * A reply's action lines as they are kept: strings only, each collapsed to one
 * line and cut to CHAT_LIMITS.actionChars, blanks dropped, at most
 * CHAT_LIMITS.actions. Anything that is not an array is no lines. chat_append
 * (068) applies the same rule in SQL.
 */
export function cleanActions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const a of raw.slice(0, CHAT_LIMITS.actions)) {
    if (typeof a !== 'string') continue;
    const line = a.replace(/[\s\p{Cc}]+/gu, ' ').trim().slice(0, CHAT_LIMITS.actionChars);
    if (line) out.push(line);
  }
  return out;
}
