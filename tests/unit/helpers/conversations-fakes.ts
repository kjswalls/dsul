/**
 * Fakes for lib/conversations-store.ts: a recording ConversationsApi and a
 * scripted ChatTransport, injected with `configureConversations`.
 *
 * The API fake answers like the /api/ai/conversations routes (migration 057)
 * by default: a turn's save upserts a summary whose `messageCount` grows by
 * what was inserted, so a test only scripts the answers it is about
 * (`api.answer.appendTurn = …`).
 */
import { vi } from 'vitest';
import type { ApiCallResult, ConversationsApi } from '@/lib/conversations-api';
import type { ChatTransport, TurnInput, TurnOutcome } from '@/lib/chat-transport';
import type {
  ConversationListResponse,
  ConversationPatch,
  ConversationSummary,
  SearchHit,
  ThreadResponse,
  TurnRequest,
  TurnResponse,
} from '@/lib/conversation-types';

export function summary(o: Partial<ConversationSummary> & { id: string }): ConversationSummary {
  return {
    itemId: null,
    title: 'A conversation',
    renamed: false,
    starred: false,
    answerer: 'model',
    openclawSeen: false,
    changes: { added: 0, steps: 0, moved: 0, changed: 0 },
    messageCount: 0,
    lastMessageAt: '2026-10-02T09:00:00.000Z',
    createdAt: '2026-10-02T09:00:00.000Z',
    ...o,
  };
}

export const fail = (status: number, error: string, conversationId?: string) =>
  ({ ok: false, status, error, ...(conversationId ? { conversationId } : {}) }) as ApiCallResult<never>;

type Answer<A extends unknown[], T> = (
  ...args: A
) => ApiCallResult<T> | undefined | Promise<ApiCallResult<T> | undefined>;

export interface FakeApi {
  api: ConversationsApi;
  /** Every turn POSTed, in order. */
  turns: { id: string; body: TurnRequest }[];
  patches: { id: string; patch: ConversationPatch }[];
  keepalives: { id: string; body: string }[];
  removes: string[];
  /** Every keepalive DELETE sent from pagehide, in order. */
  keepaliveRemoves: string[];
  /** Script an answer; each falls back to the default when it gives undefined. */
  answer: {
    list?: Answer<[o?: { cursor?: string | null }], ConversationListResponse>;
    forItem?: Answer<[itemId: string], ConversationSummary | null>;
    search?: Answer<[q: string], SearchHit[]>;
    thread?: Answer<[id: string, o?: { before?: number | null }], ThreadResponse>;
    appendTurn?: Answer<[id: string, body: TurnRequest, n: number], TurnResponse>;
    patch?: Answer<[id: string, patch: ConversationPatch], ConversationSummary>;
    remove?: Answer<[id: string], true>;
  };
  /** The server's rows as the fake keeps them. */
  rows: Map<string, ConversationSummary>;
}

export function fakeApi(): FakeApi {
  const f: FakeApi = {
    turns: [],
    patches: [],
    keepalives: [],
    removes: [],
    keepaliveRemoves: [],
    answer: {},
    rows: new Map(),
    api: undefined as unknown as ConversationsApi,
  };
  const saveDefault = (id: string, body: TurnRequest): ApiCallResult<TurnResponse> => {
    const prev = f.rows.get(id);
    if (!prev && !body.create) return fail(404, 'not_found');
    const row = summary({
      ...(prev ?? { id, itemId: body.create?.itemId ?? null, title: body.create?.title ?? 'New chat' }),
      id,
      messageCount: (prev?.messageCount ?? 0) + body.messages.length,
    });
    f.rows.set(id, row);
    return { ok: true, value: { conversation: row, inserted: body.messages.length } };
  };
  const impl: ConversationsApi = {
    list: async (o) => (await f.answer.list?.(o)) ?? { ok: true, value: { conversations: [], starred: [], nextCursor: null } },
    forItem: async (itemId) => (await f.answer.forItem?.(itemId)) ?? { ok: true, value: null },
    search: async (q) => (await f.answer.search?.(q)) ?? { ok: true, value: [] },
    thread: async (id, o) => (await f.answer.thread?.(id, o)) ?? fail(404, 'not_found'),
    appendTurn: async (id, body) => {
      f.turns.push({ id, body });
      return (await f.answer.appendTurn?.(id, body, f.turns.length)) ?? saveDefault(id, body);
    },
    patch: async (id, patch) => {
      f.patches.push({ id, patch });
      const scripted = await f.answer.patch?.(id, patch);
      if (scripted) return scripted;
      const row = f.rows.get(id) ?? summary({ id });
      const next = { ...row };
      if (patch.addChanges) {
        const a = patch.addChanges;
        next.changes = {
          added: row.changes.added + (a.added ?? 0),
          steps: row.changes.steps + (a.steps ?? 0),
          moved: row.changes.moved + (a.moved ?? 0),
          changed: row.changes.changed + (a.changed ?? 0),
        };
      }
      if (typeof patch.title === 'string') Object.assign(next, { title: patch.title, renamed: true });
      if (typeof patch.starred === 'boolean') next.starred = patch.starred;
      f.rows.set(id, next);
      return { ok: true, value: next };
    },
    remove: async (id) => {
      f.removes.push(id);
      return (await f.answer.remove?.(id)) ?? { ok: true, value: true };
    },
    appendTurnKeepalive: (id, body) => {
      f.keepalives.push({ id, body });
    },
    removeKeepalive: (id) => {
      f.keepaliveRemoves.push(id);
    },
  };
  f.api = {
    list: vi.fn(impl.list),
    forItem: vi.fn(impl.forItem),
    search: vi.fn(impl.search),
    thread: vi.fn(impl.thread),
    appendTurn: vi.fn(impl.appendTurn),
    patch: vi.fn(impl.patch),
    remove: vi.fn(impl.remove),
    appendTurnKeepalive: vi.fn(impl.appendTurnKeepalive),
    removeKeepalive: vi.fn(impl.removeKeepalive),
  };
  return f;
}

export interface FakeTransport {
  transport: ChatTransport;
  inputs: TurnInput[];
  /** How the next turn ends; the default streams 'Sure.' in two deltas. */
  next: (input: TurnInput) => Promise<TurnOutcome> | TurnOutcome;
}

/** A turn that streams these deltas and completes. */
export function streams(...deltas: string[]) {
  return (input: TurnInput): TurnOutcome => {
    for (const d of deltas) input.onDelta(d);
    return { content: deltas.join(''), status: 'complete', errorCode: null, model: input.target === 'model' ? 'gpt-4o-mini' : null };
  };
}

/**
 * A turn that streams `first`, then waits for the signal and ends as a stop
 * with what arrived. `release` ends it as complete instead.
 */
export function hangs(first = '') {
  let release: (rest?: string) => void = () => {};
  const run = (input: TurnInput): Promise<TurnOutcome> => {
    if (first) input.onDelta(first);
    return new Promise((resolve) => {
      const model = input.target === 'model' ? 'gpt-4o-mini' : null;
      input.signal.addEventListener('abort', () => resolve({ content: first, status: 'stopped', errorCode: null, model }));
      release = (rest = '') => {
        if (rest) input.onDelta(rest);
        resolve({ content: first + rest, status: 'complete', errorCode: null, model });
      };
    });
  };
  return { run, release: (rest?: string) => release(rest) };
}

export function fakeTransport(): FakeTransport {
  const t: FakeTransport = {
    inputs: [],
    next: streams('Su', 're.'),
    transport: undefined as unknown as ChatTransport,
  };
  t.transport = {
    streamTurn: vi.fn(async (input: TurnInput) => {
      t.inputs.push(input);
      return t.next(input);
    }),
  };
  return t;
}

/** Let every queued microtask and timer-free promise settle. */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}
