import type { ApiErrorCode } from './ai-types';
import type {
  ConversationListResponse,
  ConversationPatch,
  ConversationSummary,
  ItemConversationResponse,
  SearchHit,
  SearchResponse,
  ThreadResponse,
  TurnRequest,
  TurnResponse,
} from './conversation-types';

/**
 * The browser's client for /api/ai/conversations/** (PR-1's routes), and
 * nothing else: no state, no retries, no latch. lib/conversations-store.ts owns
 * all of that, and takes this as an injectable dependency, so a test swaps in a
 * fake and the transport test's `calls.map(c => c.url)` stays `['/api/chat']`.
 *
 * Client-safe (tests/unit/ai-server-boundary.test.ts). Every call is
 * same-origin with the session cookie and `no-store`. A failure is a value,
 * never a throw: the HTTP status (0 when the request never got an answer) and
 * the route's `ApiErrorCode`, so the store can tell a 503 `unavailable` (the
 * migration is missing: latch saving off) from a 404 (deleted elsewhere) from
 * a 409 (the item already has its conversation, `conversationId`) from
 * everything worth retrying.
 *
 * What the user typed rides only in request BODIES (a turn, a search, a
 * rename), never in a URL, and nothing here logs.
 */

export type ApiCallResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      /** The HTTP status; 0 for a network failure or an unreadable answer. */
      status: number;
      error: ApiErrorCode | 'network';
      /** 409 only: the item's existing conversation. */
      conversationId?: string;
    };

export interface ConversationsApi {
  /** One History page; the first (no cursor) also carries every starred conversation. */
  list(o?: { cursor?: string | null; limit?: number }): Promise<ApiCallResult<ConversationListResponse>>;
  /** The item's one conversation, or null when it has none. */
  forItem(itemId: string): Promise<ApiCallResult<ConversationSummary | null>>;
  search(q: string): Promise<ApiCallResult<SearchHit[]>>;
  /** The newest page of messages, or the page before `before` (a pos). */
  thread(id: string, o?: { before?: number | null }): Promise<ApiCallResult<ThreadResponse>>;
  appendTurn(id: string, body: TurnRequest): Promise<ApiCallResult<TurnResponse>>;
  patch(id: string, patch: ConversationPatch): Promise<ApiCallResult<ConversationSummary>>;
  remove(id: string): Promise<ApiCallResult<true>>;
  /**
   * A turn saved from `pagehide`: `fetch(…, { keepalive: true })`, fire and
   * forget. `body` is the serialized TurnRequest, already measured against the
   * keepalive budget by the caller.
   */
  appendTurnKeepalive(id: string, body: string): void;
}

const BASE = '/api/ai/conversations';
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

const API_CODES: ReadonlySet<string> = new Set<ApiErrorCode>([
  'unauthorized',
  'forbidden',
  'unavailable',
  'invalid',
  'too_large',
  'unsupported_media',
  'key_rejected',
  'unreachable',
  'blocked_url',
  'model_required',
  'not_connected',
  'busy',
  'conflict',
  'not_found',
  'server',
]);

/**
 * A status the route did not name a code for, read the way the routes use them.
 * No 503 here: the routes say `unavailable` (the migration is missing) in their
 * body, and a bare 503 is the platform's (a throttled or paused deployment, the
 * edge), a 5xx worth retrying, never a reason to stop saving for the session.
 */
function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'invalid';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'too_large';
    case 415:
      return 'unsupported_media';
    case 429:
      return 'busy';
    default:
      return 'server';
  }
}

async function call<T>(url: string, init: RequestInit, read: (body: unknown) => T | null): Promise<ApiCallResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: 'no-store', credentials: 'same-origin' });
  } catch {
    return { ok: false, status: 0, error: 'network' };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = (body && typeof body === 'object' ? body : {}) as { error?: unknown; conversationId?: unknown };
    const error = typeof b.error === 'string' && API_CODES.has(b.error) ? (b.error as ApiErrorCode) : codeForStatus(res.status);
    return typeof b.conversationId === 'string'
      ? { ok: false, status: res.status, error, conversationId: b.conversationId }
      : { ok: false, status: res.status, error };
  }
  const value = read(body);
  // A 200 whose body is not what the route promises is a fault, not data.
  return value === null ? { ok: false, status: 0, error: 'server' } : { ok: true, value };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const enc = encodeURIComponent;

export const httpConversationsApi: ConversationsApi = {
  list(o = {}) {
    const q = new URLSearchParams();
    if (o.limit !== undefined) q.set('limit', String(o.limit));
    if (o.cursor) q.set('cursor', o.cursor);
    const qs = q.toString();
    return call(qs ? `${BASE}?${qs}` : BASE, { method: 'GET' }, (b) =>
      isObj(b) && Array.isArray(b.conversations) ? (b as unknown as ConversationListResponse) : null
    );
  },

  forItem(itemId) {
    return call(`${BASE}?itemId=${enc(itemId)}`, { method: 'GET' }, (b) => {
      if (!isObj(b) || !Array.isArray(b.conversations)) return null;
      const [first] = (b as unknown as ItemConversationResponse).conversations;
      // `undefined` would read as a malformed body; "no conversation" is a real answer.
      return { found: first ?? null };
    }).then((r) => (r.ok ? { ok: true as const, value: r.value.found } : r));
  },

  search(q) {
    return call(
      `${BASE}/search`,
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ q }) },
      (b) => (isObj(b) && Array.isArray(b.results) ? (b as unknown as SearchResponse).results : null)
    );
  },

  thread(id, o = {}) {
    const before = o.before ?? null;
    const url = before !== null ? `${BASE}/${enc(id)}?before=${before}` : `${BASE}/${enc(id)}`;
    return call(url, { method: 'GET' }, (b) =>
      isObj(b) && isObj(b.conversation) && Array.isArray(b.messages) ? (b as unknown as ThreadResponse) : null
    );
  },

  appendTurn(id, body) {
    return call(
      `${BASE}/${enc(id)}/turns`,
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) },
      (b) => (isObj(b) && isObj(b.conversation) ? (b as unknown as TurnResponse) : null)
    );
  },

  patch(id, patch) {
    return call(
      `${BASE}/${enc(id)}`,
      { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch) },
      (b) => (isObj(b) && isObj(b.conversation) ? (b.conversation as unknown as ConversationSummary) : null)
    );
  },

  remove(id) {
    return call(`${BASE}/${enc(id)}`, { method: 'DELETE' }, (b) => (isObj(b) && b.ok === true ? true : null));
  },

  appendTurnKeepalive(id, body) {
    try {
      void fetch(`${BASE}/${enc(id)}/turns`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body,
        keepalive: true,
        credentials: 'same-origin',
      }).catch(() => {});
    } catch {
      // A browser that refuses the body (over its keepalive budget) throws
      // synchronously; the page is going away either way.
    }
  },
};
