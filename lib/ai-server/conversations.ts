/**
 * Saved AI conversations (migration 057): every read and write behind
 * /api/ai/conversations/**, over a USER-SCOPED client.
 *
 * Server-only. Three rules:
 *   - Every function takes `(db, userId)`. `db` runs as that user, so RLS and
 *     the SECURITY INVOKER functions are the tenant guard; `userId` is the same
 *     user, already verified by the caller, and is repeated in every filter so
 *     each query reads as its own scope. Never the service role.
 *   - Nothing here throws for a database answer. Every function returns a
 *     `ConvResult`, and the route turns the reason into a status.
 *   - A database error leaves only as its code. A CHECK failure's `details`
 *     carries the failing row, which here is what the user typed, so an error's
 *     `.message`, `.details` and `.hint` are never read, returned or logged.
 *
 * The parsers for the request bodies live here too, so every caller of these
 * functions validates a body the same way.
 *
 * WHERE THE iPHONE APP PLUGS IN, LATER (not built in 2a). The browser reaches
 * this module through the cookie session (requireSession, app/api/ai/_shared/
 * guard.ts). A bearer route for the phone, app/api/app/conversations/**, would
 * call `authenticateAppRequest(req)` (lib/app-auth.ts) for `{ userId, client }`,
 * a client that runs as the token's user, and pass them here as `(db, userId)`
 * unchanged. It has to be a route file under app/api/app, not a handler in
 * lib/app-api.ts: only app/api/** may import lib/ai-server (the boundary test).
 * It would answer PGRST301/PGRST303 with a 401, as `dbErrorResponse` does,
 * which needs the code a 'db' failure carries.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CHAT_LIMITS,
  DEFAULT_TITLE,
  ERROR_CODE_RE,
  UUID_RE,
  cleanText,
  cleanTitle,
  isAnswerer,
  isMessageStatus,
  type ConversationChanges,
  type ConversationListResponse,
  type ConversationPatch,
  type ConversationSummary,
  type SearchHit,
  type StoredMessage,
  type ThreadResponse,
  type TurnCreate,
  type TurnMessage,
  type TurnResponse,
} from '@/lib/conversation-types';
import { isModelId } from '@/lib/ai-types';
import { isMissingSchema } from './schema-codes';

export type ConvFailure = 'missing_schema' | 'not_found' | 'conflict' | 'invalid' | 'db';

export type ConvResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: ConvFailure;
      /** 'conflict' only: the item's existing conversation. */
      conversationId?: string;
      /** 'db' only: the PostgREST/Postgres code, for a log line or a status. Never content. */
      code?: string;
    };

type Op = 'list' | 'item' | 'search' | 'thread' | 'append' | 'patch' | 'tally' | 'delete';

const CONVERSATIONS = 'chat_conversations';
const MESSAGES = 'chat_messages';
const SUMMARY_COLUMNS =
  'id, item_id, title, renamed, starred, answerer, openclaw_seen, added_count, steps_count, moved_count, changed_count, message_count, last_message_at, created_at';
const MESSAGE_COLUMNS = 'id, pos, role, content, status, error_code, reply_to, answerer, model, created_at';

/**
 * What the request got wrong, as the database saw it: a value Postgres cannot
 * parse (22P02, or 22P05 for a U+0000 the client should already have
 * stripped), a timestamp it cannot take (22007, 22008, or 22009 for an offset
 * past ±15:59; decodeCursor refuses each first), a bad argument (22023), a
 * CHECK or the dense-pos trigger (23514), a missing reply_to target (23503) or
 * a null where none may be (23502). The database is a backstop for the parsers
 * below, never a 500.
 */
const INVALID_CODES: ReadonlySet<string> = new Set([
  '22P02',
  '22P05',
  '22007',
  '22008',
  '22009',
  '22023',
  '23514',
  '23503',
  '23502',
]);
/**
 * No such row for this user (P0002). Never 42501: that is every privilege and
 * RLS refusal, a fault to log as 'db' and answer 500, not a conversation
 * deleted elsewhere. chat_append's "not signed in" is 28000, which cannot
 * happen behind requireSession and is logged as 'db' too if it ever does.
 */
const NOT_FOUND_CODES: ReadonlySet<string> = new Set(['P0002']);

const NOT_FOUND = { ok: false, reason: 'not_found' } as const;

type DbError = { code?: unknown } | null | undefined;

function codeOf(error: DbError): string | undefined {
  // ONLY the code is read; see the header.
  const code = error?.code;
  return typeof code === 'string' && code !== '' ? code : undefined;
}

/** A failed call, by its code. Only 'db' is logged: `[ai] conv <op> failed <code>`. */
export function dbFailure(op: Op, error: DbError): ConvResult<never> {
  const code = codeOf(error);
  if (isMissingSchema(code)) return { ok: false, reason: 'missing_schema' };
  if (code !== undefined && INVALID_CODES.has(code)) return { ok: false, reason: 'invalid' };
  if (code !== undefined && NOT_FOUND_CODES.has(code)) return NOT_FOUND;
  const c = code ?? 'unknown';
  console.warn('[ai] conv', op, 'failed', c);
  return { ok: false, reason: 'db', code: c };
}

/** An answer the database should never give (a row off its own CHECKs). */
function badRow(op: Op): ConvResult<never> {
  console.warn('[ai] conv', op, 'failed', 'bad_row');
  return { ok: false, reason: 'db', code: 'bad_row' };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

// ── Rows to shapes ───────────────────────────────────────────────────────────

/** A chat_conversations row, narrowed field by field. Null when it is not one. */
export function toSummary(row: unknown): ConversationSummary | null {
  if (!isObj(row)) return null;
  const { id, title, last_message_at, created_at } = row;
  if (typeof id !== 'string' || typeof title !== 'string') return null;
  if (typeof last_message_at !== 'string' || typeof created_at !== 'string') return null;
  return {
    id,
    itemId: strOrNull(row.item_id),
    title,
    renamed: row.renamed === true,
    starred: row.starred === true,
    answerer: isAnswerer(row.answerer) ? row.answerer : null,
    openclawSeen: row.openclaw_seen === true,
    changes: {
      added: count(row.added_count),
      steps: count(row.steps_count),
      moved: count(row.moved_count),
      changed: count(row.changed_count),
    },
    messageCount: count(row.message_count),
    // Verbatim, microseconds and all: the list cursor compares on it exactly.
    lastMessageAt: last_message_at,
    createdAt: created_at,
  };
}

export function toMessage(row: unknown): StoredMessage | null {
  if (!isObj(row)) return null;
  const { id, pos, role, content, status, created_at } = row;
  if (typeof id !== 'string' || typeof content !== 'string' || typeof created_at !== 'string') return null;
  if (typeof pos !== 'number' || !Number.isInteger(pos) || pos < 1) return null;
  if ((role !== 'user' && role !== 'assistant') || !isMessageStatus(status)) return null;
  return {
    id,
    pos,
    role,
    content,
    status,
    errorCode: strOrNull(row.error_code),
    replyTo: strOrNull(row.reply_to),
    answerer: isAnswerer(row.answerer) ? row.answerer : null,
    model: strOrNull(row.model),
    createdAt: created_at,
  };
}

function toSearchHit(row: unknown): SearchHit | null {
  const summary = toSummary(row);
  if (!summary || !isObj(row)) return null;
  if (row.matched !== 'title' && row.matched !== 'message') return null;
  return { ...summary, matched: row.matched, snippet: strOrNull(row.snippet), itemTitle: strOrNull(row.item_title) };
}

/** Every row narrowed, or null if any one is not a row (which fails the whole call). */
function mapAll<T>(rows: unknown, to: (row: unknown) => T | null): T[] | null {
  if (!Array.isArray(rows)) return null;
  const out: T[] = [];
  for (const row of rows) {
    const v = to(row);
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

// ── The History cursor ───────────────────────────────────────────────────────

export interface Cursor {
  /** chat_conversations.last_message_at exactly as PostgREST rendered it. */
  lastMessageAt: string;
  id: string;
}

/** PostgREST's timestamptz rendering (and ISO 8601 generally), at most microseconds. */
const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::?(\d{2}))?)$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,200}$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * A timestamp Postgres will take: a real calendar day from year 1, a real
 * time of day, and an offset within ±15:59. Date.parse is no test of that: it
 * rolls Feb 30 over to Mar 2 and takes year 0000 and +23:00, which Postgres
 * then refuses (22008, 22009), once a 500. Stricter than Postgres only for
 * 24:00 and a 60th second, which PostgREST never renders into a cursor.
 */
function isPgTimestamp(s: string): boolean {
  const m = TIMESTAMP_RE.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number);
  const offsetH = Number(m[7] ?? 0);
  const offsetM = Number(m[8] ?? 0);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (d > (mo === 2 && leap ? 29 : DAYS_IN_MONTH[mo - 1])) return false;
  return h <= 23 && mi <= 59 && sec <= 59 && offsetH <= 15 && offsetM <= 59;
}

/** base64url of `<lastMessageAt>|<id>`: opaque to the client, exact to the database. */
export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.lastMessageAt}|${c.id}`, 'utf8').toString('base64url');
}

/**
 * The cursor, or null when it is not one this module made. Both halves are
 * checked against strict shapes before they go anywhere near a filter string.
 */
export function decodeCursor(raw: unknown): Cursor | null {
  if (typeof raw !== 'string' || !CURSOR_RE.test(raw)) return null;
  const parts = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (parts.length !== 2) return null;
  const [lastMessageAt, id] = parts;
  if (!isPgTimestamp(lastMessageAt)) return null;
  if (!UUID_RE.test(id)) return null;
  return { lastMessageAt, id };
}

// ── Request bodies ───────────────────────────────────────────────────────────

/** A turn as the database will take it: every string cleaned and clipped. */
export interface ParsedTurn {
  ownerId: string;
  create: TurnCreate | null;
  messages: TurnMessage[];
}

const TURN_KEYS = new Set(['ownerId', 'create', 'messages']);
const CREATE_KEYS = new Set(['itemId', 'title']);
const MESSAGE_KEYS = new Set(['id', 'role', 'content', 'status', 'errorCode', 'replyTo', 'answerer', 'model']);
const PATCH_KEYS = new Set(['title', 'starred', 'addChanges']);
const CHANGE_KEYS = new Set<keyof ConversationChanges>(['added', 'steps', 'moved', 'changed']);
const SEARCH_KEYS = new Set(['q']);

function onlyKeys(o: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(o).every((k) => allowed.has(k));
}

const absent = (v: unknown) => v === undefined || v === null;

/** chat_messages_user_check's "not blank": something besides space, tab, CR and LF. */
const NOT_BLANK_RE = /[^ \t\r\n]/;

function parseMessage(raw: unknown): TurnMessage | null {
  if (!isObj(raw) || !onlyKeys(raw, MESSAGE_KEYS)) return null;
  const { id, role, status = 'complete', errorCode, replyTo, answerer, model } = raw;
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  if (typeof raw.content !== 'string') return null;
  if (!isMessageStatus(status)) return null;
  // An error is exactly a status plus a code (chat_messages_status_check).
  if ((status === 'error') !== (typeof errorCode === 'string')) return null;
  if (status === 'error' && !ERROR_CODE_RE.test(errorCode as string)) return null;
  if (status !== 'error' && !absent(errorCode)) return null;

  if (role === 'user') {
    if (status !== 'complete' || !absent(replyTo) || !absent(answerer) || !absent(model)) return null;
    // Clipped, never refused for length; blank is a shape problem, not a length.
    const content = cleanText(raw.content, CHAT_LIMITS.userChars);
    if (!NOT_BLANK_RE.test(content)) return null;
    return { id, role, content, status: 'complete', errorCode: null, replyTo: null, answerer: null, model: null };
  }
  if (role === 'assistant') {
    if (typeof replyTo !== 'string' || !UUID_RE.test(replyTo) || !isAnswerer(answerer)) return null;
    if (!absent(model) && !isModelId(model)) return null;
    const content = cleanText(raw.content, CHAT_LIMITS.assistantChars);
    // A stop with nothing streamed saves no reply row; only an error may be empty.
    if (status !== 'error' && content === '') return null;
    return {
      id,
      role,
      content,
      status,
      errorCode: status === 'error' ? (errorCode as string) : null,
      replyTo,
      answerer,
      model: isModelId(model) ? model : null,
    };
  }
  return null;
}

/**
 * `{ ownerId, create?, messages }`, or null for any shape the route answers
 * 400. Lengths are never a 400: content and the title are clipped to
 * CHAT_LIMITS through cleanText. The caller compares `ownerId` with the
 * session user itself (403).
 */
export function parseTurn(raw: unknown): ParsedTurn | null {
  if (!isObj(raw) || !onlyKeys(raw, TURN_KEYS)) return null;
  const { ownerId, create, messages } = raw;
  if (typeof ownerId !== 'string' || ownerId === '') return null;

  let parsedCreate: TurnCreate | null = null;
  if (create !== undefined) {
    if (!isObj(create) || !onlyKeys(create, CREATE_KEYS) || typeof create.title !== 'string') return null;
    const itemId = create.itemId ?? null;
    if (itemId !== null && (typeof itemId !== 'string' || !UUID_RE.test(itemId))) return null;
    parsedCreate = { itemId, title: cleanTitle(create.title) || DEFAULT_TITLE };
  }

  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 2) return null;
  const parsed: TurnMessage[] = [];
  for (const m of messages) {
    const p = parseMessage(m);
    if (!p) return null;
    parsed.push(p);
  }
  if (parsed.length === 2) {
    // A user message and ITS reply.
    const [user, reply] = parsed;
    if (user.role !== 'user' || reply.role !== 'assistant' || reply.replyTo !== user.id) return null;
  } else if (parsed[0].role === 'assistant' && parsedCreate !== null) {
    // A reply alone answers a user row saved earlier, so its conversation exists.
    return null;
  }
  return { ownerId, create: parsedCreate, messages: parsed };
}

/**
 * `{ title?, starred? }` with at least one, or `{ addChanges }` alone; or null
 * (400). A tally with a rename or a star is refused, never split: see
 * ConversationPatch. Each counter is 0..CHAT_LIMITS.changesPerCall, refused
 * past it rather than clamped, which would drop counts without a word.
 */
export function parsePatch(raw: unknown): ConversationPatch | null {
  if (!isObj(raw) || !onlyKeys(raw, PATCH_KEYS) || Object.keys(raw).length === 0) return null;
  if (raw.addChanges !== undefined) {
    if (raw.title !== undefined || raw.starred !== undefined) return null;
    const c = raw.addChanges;
    if (!isObj(c) || !onlyKeys(c, CHANGE_KEYS as ReadonlySet<string>)) return null;
    const changes: Partial<ConversationChanges> = {};
    for (const key of CHANGE_KEYS) {
      const n = c[key];
      if (n === undefined) continue;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > CHAT_LIMITS.changesPerCall) return null;
      changes[key] = n;
    }
    return { addChanges: changes };
  }
  const patch: { title?: string; starred?: boolean } = {};
  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string') return null;
    const title = cleanTitle(raw.title);
    if (title === '') return null;
    patch.title = title;
  }
  if (raw.starred !== undefined) {
    if (typeof raw.starred !== 'boolean') return null;
    patch.starred = raw.starred;
  }
  return patch;
}

/**
 * `{ q }`, trimmed and cleaned, CHAT_LIMITS.searchMin..searchMax CODE POINTS,
 * which is what chat_search's char_length counts; or null (400). `.length`
 * would let one emoji through to match nothing, and refuse 51..100 of them.
 */
export function parseSearch(raw: unknown): string | null {
  if (!isObj(raw) || !onlyKeys(raw, SEARCH_KEYS) || typeof raw.q !== 'string') return null;
  const q = cleanText(raw.q, raw.q.length).trim();
  // cleanText left no lone surrogate, so this counts exactly as char_length does.
  const n = Array.from(q).length;
  return n >= CHAT_LIMITS.searchMin && n <= CHAT_LIMITS.searchMax ? q : null;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * One History page: non-starred conversations, newest first, keyset-paged on
 * (last_message_at, id) over the recency index. The first page (no cursor)
 * also carries EVERY starred row: the user's own picks, so naturally few, and
 * a starred row shows only under Starred.
 */
export async function listConversations(
  db: SupabaseClient,
  userId: string,
  o: { limit: number; cursor: Cursor | null }
): Promise<ConvResult<ConversationListResponse>> {
  const limit = Number.isFinite(o.limit)
    ? Math.min(Math.max(Math.trunc(o.limit), 1), CHAT_LIMITS.maxPageSize)
    : CHAT_LIMITS.pageSize;
  let page = db.from(CONVERSATIONS).select(SUMMARY_COLUMNS).eq('user_id', userId).eq('starred', false);
  if (o.cursor) {
    // Both halves passed decodeCursor's strict shapes; the quotes keep the
    // timestamp's ':' and '+' literal inside PostgREST's logic tree.
    const { lastMessageAt: t, id } = o.cursor;
    page = page.or(`last_message_at.lt."${t}",and(last_message_at.eq."${t}",id.lt.${id})`);
  }
  const pageQuery = page
    .order('last_message_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);
  const starredQuery = o.cursor
    ? null
    : db
        .from(CONVERSATIONS)
        .select(SUMMARY_COLUMNS)
        .eq('user_id', userId)
        .eq('starred', true)
        .order('last_message_at', { ascending: false })
        .order('id', { ascending: false });

  const [pageRes, starredRes] = await Promise.all([pageQuery, starredQuery]);
  if (pageRes.error) return dbFailure('list', pageRes.error);
  if (starredRes?.error) return dbFailure('list', starredRes.error);

  const rows = mapAll(pageRes.data, toSummary);
  if (!rows) return badRow('list');
  const conversations = rows.slice(0, limit);
  const last = conversations[conversations.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor({ lastMessageAt: last.lastMessageAt, id: last.id }) : null;

  if (!starredRes) return { ok: true, value: { conversations, nextCursor } };
  const starred = mapAll(starredRes.data, toSummary);
  if (!starred) return badRow('list');
  return { ok: true, value: { conversations, starred, nextCursor } };
}

/** The item's one conversation (the partial unique index), or null when it has none. */
export async function conversationForItem(
  db: SupabaseClient,
  userId: string,
  itemId: string
): Promise<ConvResult<ConversationSummary | null>> {
  const { data, error } = await db
    .from(CONVERSATIONS)
    .select(SUMMARY_COLUMNS)
    .eq('user_id', userId)
    .eq('item_id', itemId)
    .maybeSingle();
  if (error) return dbFailure('item', error);
  if (!data) return { ok: true, value: null };
  const summary = toSummary(data);
  return summary ? { ok: true, value: summary } : badRow('item');
}

/** chat_search (titles, the linked item's current title, message text), at most 50. */
export async function searchConversations(
  db: SupabaseClient,
  _userId: string,
  q: string
): Promise<ConvResult<SearchHit[]>> {
  // chat_search scopes itself to auth.uid(): the user this client runs as.
  const { data, error } = await db.rpc('chat_search', { p_query: q, p_limit: CHAT_LIMITS.searchResults });
  if (error) return dbFailure('search', error);
  const hits = mapAll(data ?? [], toSearchHit);
  return hits ? { ok: true, value: hits } : badRow('search');
}

/**
 * A conversation and its newest CHAT_LIMITS.threadPage messages before `before`
 * (a pos), ascending. pos is dense from 1, so there are earlier ones exactly
 * when the first one returned is past 1.
 */
export async function getThread(
  db: SupabaseClient,
  userId: string,
  id: string,
  o: { before: number | null }
): Promise<ConvResult<ThreadResponse>> {
  const conversation = db
    .from(CONVERSATIONS)
    .select(SUMMARY_COLUMNS)
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle();
  let messages = db.from(MESSAGES).select(MESSAGE_COLUMNS).eq('user_id', userId).eq('conversation_id', id);
  if (o.before !== null) messages = messages.lt('pos', o.before);
  const messagesQuery = messages.order('pos', { ascending: false }).limit(CHAT_LIMITS.threadPage);

  const [c, m] = await Promise.all([conversation, messagesQuery]);
  if (c.error) return dbFailure('thread', c.error);
  if (!c.data) return NOT_FOUND;
  if (m.error) return dbFailure('thread', m.error);
  const summary = toSummary(c.data);
  const rows = mapAll(m.data, toMessage);
  if (!summary || !rows) return badRow('thread');
  rows.reverse();
  return { ok: true, value: { conversation: summary, messages: rows, hasEarlier: rows.length > 0 && rows[0].pos > 1 } };
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** The conversation as it is now, after a write that does not return it. */
async function readSummary(db: SupabaseClient, userId: string, id: string, op: Op): Promise<ConvResult<ConversationSummary>> {
  const { data, error } = await db
    .from(CONVERSATIONS)
    .select(SUMMARY_COLUMNS)
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle();
  if (error) return dbFailure(op, error);
  if (!data) return NOT_FOUND;
  const summary = toSummary(data);
  return summary ? { ok: true, value: summary } : badRow(op);
}

/**
 * One finished turn, through chat_append: created on its first write,
 * idempotent by message id. 'not_found' when there is no such conversation
 * of this user's and no `create` (deleted elsewhere), 'conflict' with the
 * existing id when the item already has a conversation.
 */
export async function appendTurn(
  db: SupabaseClient,
  userId: string,
  id: string,
  turn: { create: TurnCreate | null; messages: TurnMessage[] }
): Promise<ConvResult<TurnResponse>> {
  // Cleaned again here, whoever parsed it: these are the caps the CHECKs hold.
  const p_messages = turn.messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: cleanText(m.content, m.role === 'user' ? CHAT_LIMITS.userChars : CHAT_LIMITS.assistantChars),
    status: m.status ?? 'complete',
    errorCode: m.errorCode ?? null,
    replyTo: m.replyTo ?? null,
    answerer: m.answerer ?? null,
    model: m.model ?? null,
  }));
  const p_create = turn.create
    ? { itemId: turn.create.itemId, title: cleanTitle(turn.create.title) || DEFAULT_TITLE }
    : null;

  const { data, error } = await db.rpc('chat_append', { p_conversation: id, p_create, p_messages });
  if (error) return dbFailure('append', error);
  if (!isObj(data)) return badRow('append');
  if (data.status === 'gone') return NOT_FOUND;
  if (data.status === 'conflict') {
    const existing = data.conversationId;
    return typeof existing === 'string' && UUID_RE.test(existing)
      ? { ok: false, reason: 'conflict', conversationId: existing }
      : badRow('append');
  }
  if (data.status !== 'ok') return badRow('append');

  const read = await readSummary(db, userId, id, 'append');
  if (!read.ok) return read;
  return { ok: true, value: { conversation: read.value, inserted: count(data.inserted) } };
}

/**
 * Rename (sets `renamed`) and star, in one UPDATE; or add one tally to the
 * change counters, through chat_note_changes' atomic increments.
 *
 * A tally is ONE request: the statement that commits the increment also
 * answers the row, so nothing after it can fail and report a tally that has
 * landed (which a retry would then count twice). That is also why a tally
 * never shares a call with a rename or a star. A response lost after the
 * commit can still double-count on a re-send, so a client never re-sends one
 * (CHAT_LIMITS.changesPerCall).
 */
export async function patchConversation(
  db: SupabaseClient,
  userId: string,
  id: string,
  patch: ConversationPatch
): Promise<ConvResult<ConversationSummary>> {
  if (patch.addChanges !== undefined) {
    // The type forbids it and parsePatch refuses it; a caller that got here anyway is told so.
    if (patch.title !== undefined || patch.starred !== undefined) return { ok: false, reason: 'invalid' };
    const c = patch.addChanges;
    const { data, error } = await db.rpc('chat_note_changes', {
      p_conversation: id,
      p_added: c.added ?? 0,
      p_steps: c.steps ?? 0,
      p_moved: c.moved ?? 0,
      p_changed: c.changed ?? 0,
    });
    if (error) return dbFailure('tally', error);
    // One row, the conversation as it now is; none when it is not this user's, or gone.
    const rows = mapAll(data, toSummary);
    if (!rows || rows.length > 1) return badRow('tally');
    return rows.length === 1 ? { ok: true, value: rows[0] } : NOT_FOUND;
  }

  const fields: { title?: string; renamed?: true; starred?: boolean } = {};
  if (patch.title !== undefined) {
    const title = cleanTitle(patch.title);
    if (title === '') return { ok: false, reason: 'invalid' };
    fields.title = title;
    fields.renamed = true;
  }
  if (patch.starred !== undefined) fields.starred = patch.starred;
  if (Object.keys(fields).length === 0) return readSummary(db, userId, id, 'patch');

  const { data, error } = await db
    .from(CONVERSATIONS)
    .update(fields)
    .eq('user_id', userId)
    .eq('id', id)
    .select(SUMMARY_COLUMNS)
    .maybeSingle();
  if (error) return dbFailure('patch', error);
  if (!data) return NOT_FOUND;
  const summary = toSummary(data);
  return summary ? { ok: true, value: summary } : badRow('patch');
}

/** Hard delete; the messages go by cascade. 'not_found' when nothing was deleted. */
export async function deleteConversation(db: SupabaseClient, userId: string, id: string): Promise<ConvResult<true>> {
  const { data, error } = await db.from(CONVERSATIONS).delete().eq('user_id', userId).eq('id', id).select('id');
  if (error) return dbFailure('delete', error);
  return Array.isArray(data) && data.length > 0 ? { ok: true, value: true } : NOT_FOUND;
}
