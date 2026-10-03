import { create } from 'zustand';
import { usePlannerStore } from './planner-store';
import { getAICapabilities, useAIConnectionStore } from './ai-connection-store';
import { buildDsulContext } from './ai-context';
import { goalsEnabled } from './extension-gates';
import { isModelId } from './ai-types';
import { replyErrorCode } from './chat-errors';
import {
  CHAT_LIMITS,
  cleanText,
  cleanTitle,
  deriveTitle,
  type Answerer,
  type ConversationChanges,
  type ConversationSummary,
  type MessageStatus,
  type SearchHit,
  type StoredMessage,
  type TurnMessage,
  type TurnRequest,
} from './conversation-types';
import { httpConversationsApi, type ApiCallResult, type ConversationsApi } from './conversations-api';
import {
  chatTransport,
  outgoingTurns,
  resetPluginTransport,
  type ChatTransport,
  type TurnOutcome,
} from './chat-transport';
import { addChanges, hasChanges } from './conversation-summary';
import { useRailStore } from './rail-store';

/**
 * conversations-store.ts — saved AI conversations, as this browser holds them.
 *
 * MEMORY ONLY. The account is the record now (migration 057, /api/ai/
 * conversations/**): this is a cache of server state keyed by id, never
 * persisted, so there is no second source of truth to go stale on another
 * device and nothing on disk to leak at sign-out. It replaces the old chat
 * store and its 24-hour localStorage transcripts (swept below).
 *
 * THE WRITE. Each FINISHED turn is saved once, by this client, in one POST:
 * the user's message and the reply (or the stopped partial, or the failed
 * reply's error CODE), never per token. The client is the writer because the
 * OpenClaw plugin path never reaches dsul's server; /api/chat stays stateless.
 * Message ids are minted here, so a retried or keepalive save lands once.
 *
 * Three rules hold the writes honest:
 *   - Every queued save and change tally is stamped with the generation and
 *     the account it was queued under. `reset()` (sign-out, an account switch)
 *     bumps the generation and empties the queue, and a stamp that no longer
 *     matches is dropped unsent; the turns route refuses a foreign `ownerId`
 *     (403) for whatever got past that, a keepalive included.
 *   - Saves and tallies for one conversation run through one promise chain,
 *     in order. A failed save waits in the queue (next send, `online`, the tab
 *     coming back) and gives up after three tries ("Not saved").
 *   - The routes' own `unavailable` (their 503) means the migration is
 *     missing: saving is latched off for the session. Chat still works,
 *     unsaved, and History hides. A bare 503 from the platform is a 5xx like
 *     any other, and waits for a retry.
 *   - A conversation found deleted (a 404) is never written to again: a save
 *     would carry `create` and bring it back.
 *
 * WHO answers, and whether anything can, is the gate's (`getAICapabilities()`),
 * asked at the moment of sending. Focus and view state are rail-store's.
 */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** What was said. A failed reply's words are never here: see `errorCode`. */
  content: string;
  status: MessageStatus | 'streaming';
  errorCode: string | null;
  /** A reply's user message. */
  replyTo: string | null;
  answerer: Answerer | null;
  model: string | null;
  createdAt: number;
  /** The saved position; null until saved. */
  pos: number | null;
  /** 'pending' until the save lands; 'unsaved' once it never will ("Not saved"). */
  sync: 'saved' | 'pending' | 'unsaved';
}

export interface Thread {
  id: string;
  itemId: string | null;
  /** The title used on create: a chip's label, else the first message's (deriveTitle). */
  draftTitle: string | null;
  /** A row exists on the server. */
  saved: boolean;
  messages: ChatMessage[];
  load: 'idle' | 'loading' | 'loaded' | 'gone' | 'error';
  hasEarlier: boolean;
  streaming: boolean;
  /** Streaming, and nothing has arrived yet (the typing dots). */
  typing: boolean;
  fetchedAt: number;
}

export interface ConversationListState {
  /** Non-starred conversations, newest first, page by page. */
  ids: string[];
  /** Every starred conversation (the first page carries them all). */
  starredIds: string[];
  cursor: string | null;
  status: 'idle' | 'loading' | 'loaded' | 'error';
  fetchedAt: number;
}

export interface ConversationSearchState {
  q: string;
  status: 'idle' | 'loading' | 'done' | 'error';
  hits: SearchHit[];
}

export interface ConversationsState {
  /** The account this cache belongs to. */
  ownerId: string | null;
  /** Bumped by reset(); a late answer from an older generation is dropped. */
  generation: number;
  /** 'off': the migration is missing (a 503), latched for the session. */
  saving: 'unknown' | 'on' | 'off';
  list: ConversationListState;
  summaries: Record<string, ConversationSummary>;
  /** itemId → its conversation's id; null = known to have none. */
  itemIndex: Record<string, string | null>;
  threads: Record<string, Thread>;
  /** Set synchronously when a send starts, by binding key (rail-store's `bindingKey`). */
  sending: Record<string, true>;
  search: ConversationSearchState;

  /** Sync: a different account than the cache's resets it. */
  ensureOwner(): void;
  /** The first History page; one in flight at a time. NEVER rejects: a failure is `list.status: 'error'`. */
  ensureLoaded(): Promise<void>;
  /** On rail open, the Ask tab, window focus: the first page again if it is older than `maxAgeMs`. */
  refreshIfStale(maxAgeMs?: number): void;
  loadMore(): Promise<void>;
  /** Fetch a conversation if missing or older than 30s and not streaming; merge by message id. */
  openThread(id: string): Promise<void>;
  loadEarlier(id: string): Promise<void>;
  /**
   * The item's conversation id: known, else asked, else a draft. Never rejects:
   * a failed lookup also yields a draft, and a duplicate then converges through
   * the 409 rebind.
   */
  resolveItemThread(itemId: string): Promise<string>;
  /** A new conversation with no row until its first turn is saved. */
  newDraft(o?: { itemId?: string; title?: string }): string;
  send(threadId: string, text: string): Promise<void>;
  stop(threadId: string): void;
  rename(id: string, title: string): Promise<boolean>;
  setStarred(id: string, starred: boolean): Promise<boolean>;
  /**
   * Optimistic delete: aborts the stream, drops queued saves and tallies,
   * removes the thread, its summary and its search result, sets
   * itemIndex[itemId] = null for an item conversation, then rail-store's
   * leaveConversation. The DELETE waits
   * behind any save of it still on the wire. All of it comes back on failure,
   * a turn the abort cut short saved as stopped (the view does not: it was
   * the user's to leave).
   */
  remove(id: string): Promise<boolean>;
  /** One accepted proposal's tally, through the conversation's chain, after any pending save. */
  noteChanges(id: string, tally: ConversationChanges): void;
  /** The caller debounces (250ms). Under the 2-character minimum it clears. */
  runSearch(q: string): void;
  /** `pagehide` (registered below, once): keepalive saves within one 60,000-byte budget. */
  flushOnPageHide(): void;
  /** Mark a binding as sending; false when it already is (a second send in the same tick). */
  beginSend(key: string): boolean;
  endSend(key: string): void;
  /** Bumps the generation; empties the queue, the chains, the cache. `saving` stays latched. */
  reset(): void;
}

// ── Dependencies ─────────────────────────────────────────────────────────────

let deps: { api: ConversationsApi; transport: ChatTransport } = {
  api: httpConversationsApi,
  transport: chatTransport,
};

/** Tests inject fakes. The defaults are httpConversationsApi and chatTransport. */
export function configureConversations(d: { api?: ConversationsApi; transport?: ChatTransport }): void {
  deps = { api: d.api ?? deps.api, transport: d.transport ?? deps.transport };
}

// ── Module state (none of it rendered) ───────────────────────────────────────

/** A failed save gives up after this many tries. */
const MAX_SAVE_TRIES = 3;
/** Browsers cap in-flight keepalive bodies at 64 KiB per page; this leaves headroom. */
export const KEEPALIVE_BUDGET_BYTES = 60_000;
/** A thread refetches on open when older than this. */
const THREAD_STALE_MS = 30_000;
/** The plugin path's OpenClaw sessions archive after about an hour idle. */
const PLUGIN_SESSION_IDLE_MS = 50 * 60_000;
const CONTINUITY_TURNS = 12;
const CONTINUITY_CHARS = 8_000;

interface Stamp {
  generation: number;
  ownerId: string | null;
}
interface SaveJob extends Stamp {
  threadId: string;
  messages: [TurnMessage] | [TurnMessage, TurnMessage];
  tries: number;
  /** When the turn was said, as an order: a retry keeps it (pagehide sends oldest first). */
  seq: number;
}
interface PendingTally extends Stamp {
  tally: ConversationChanges;
}

/** One per streaming thread, so stopping one never touches another. */
const controllers = new Map<string, AbortController>();
/** Per conversation: saves and tallies, in order. */
const chains = new Map<string, Promise<void>>();
/** A draft rebound to its item's existing conversation (409) → that id. */
const aliases = new Map<string, string>();
/** Saves that failed and wait for a retry, oldest first. */
let queue: SaveJob[] = [];
/** Saves on the wire right now, with the body they carry (pagehide re-sends it). */
const inflight = new Map<SaveJob, { id: string; body: TurnRequest }>();
/**
 * Saves on a conversation's chain that have not fired yet (behind an earlier
 * save or a tally still on the wire). Neither queued nor in flight, so
 * pagehide would miss them without this.
 */
const waiting = new Set<SaveJob>();
let jobSeq = 0;
/** Tallies for a conversation whose first save has not landed yet. */
const pendingTallies = new Map<string, PendingTally[]>();
/** Deleted this generation: a late answer for one must not bring it back. */
const removed = new Set<string>();
/**
 * Conversations a save has been sent for: a row may exist even before any
 * answer says so (the answer is still on its way, or was lost after the
 * commit), so a delete must ask the server.
 */
const attempted = new Set<string>();
/** Deletes waiting on the server's answer. */
const removing = new Set<string>();
/** Saves a pending delete stopped, re-sent if the delete fails. */
const swallowed = new Map<string, SaveJob[]>();
/** A turn a pending delete cut off mid-stream, as send finished it: saved if the delete fails. */
const parked = new Map<string, { replyId: string; reply: ChatMessage | null; job: SaveJob }>();
let listInflight: Promise<void> | null = null;
/**
 * A later page on its way (loadMore). Its own marker, not `list.status`: the
 * first page is never re-read under it (a send, a refresh), which would move
 * the boundary the page's cursor was cut at.
 */
let moreInflight: Promise<void> | null = null;
/** Bumped by every first page that lands: a later page asked for before it is from another list. */
let listEpoch = 0;
/**
 * Conversations whose summary changed here while a list page was on its way,
 * one set per page in flight: the page was read before, so their own copy and
 * place in the list win over it.
 */
const touchedDuringList = new Set<Set<string>>();
const touch = (id: string) => {
  for (const touched of touchedDuringList) touched.add(id);
};
const resolving = new Map<string, Promise<string>>();
const opening = new Map<string, Promise<void>>();
/**
 * The store's `fire`, reached from outside its closure, so retryQueued (module
 * scope, for the window listeners) shares the one implementation. Assigned
 * when the store is created.
 */
let fireQueued: (job: SaveJob) => Promise<void> = async () => {};

/** The id a conversation goes by now (a 409 rebind may have renamed it). */
export function resolveConversationId(id: string): string {
  let cur = id;
  for (let i = 0; i < 8; i++) {
    const next = aliases.get(cur);
    if (!next || next === cur) break;
    cur = next;
  }
  return cur;
}
const resolveId = resolveConversationId;

function enqueue(id: string, fn: () => Promise<void>): Promise<void> {
  const prev = chains.get(id) ?? Promise.resolve();
  const next = prev.then(fn).catch(() => {});
  chains.set(id, next);
  void next.then(() => {
    if (chains.get(id) === next) chains.delete(id);
  });
  return next;
}

/** Every save, tally and list read this store has in flight, settled. For tests and teardown. */
export async function conversationsSettled(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const pending = [...chains.values(), ...opening.values(), ...resolving.values()];
    if (listInflight) pending.push(listInflight);
    if (moreInflight) pending.push(moreInflight);
    if (pending.length === 0) return;
    await Promise.all(pending.map((p) => p.catch(() => {})));
    await Promise.resolve();
  }
}

// ── Shapes ───────────────────────────────────────────────────────────────────

const INITIAL_LIST: ConversationListState = { ids: [], starredIds: [], cursor: null, status: 'idle', fetchedAt: 0 };
const INITIAL_SEARCH: ConversationSearchState = { q: '', status: 'idle', hits: [] };

function blankThread(id: string, o: { itemId?: string | null; saved?: boolean; title?: string | null } = {}): Thread {
  return {
    id,
    itemId: o.itemId ?? null,
    draftTitle: o.title ?? null,
    saved: o.saved ?? false,
    messages: [],
    load: o.saved ? 'idle' : 'loaded',
    hasEarlier: false,
    streaming: false,
    typing: false,
    fetchedAt: o.saved ? 0 : Date.now(),
  };
}

function fromStored(m: StoredMessage): ChatMessage {
  const t = Date.parse(m.createdAt);
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    status: m.status,
    errorCode: m.errorCode,
    replyTo: m.replyTo,
    answerer: m.answerer,
    model: m.model,
    createdAt: Number.isFinite(t) ? t : 0,
    pos: m.pos,
    sync: 'saved',
  };
}

/** What a save sends for one message. A user message carries nothing but itself. */
function toTurn(m: ChatMessage): TurnMessage {
  if (m.role === 'user') return { id: m.id, role: 'user', content: m.content };
  const status: MessageStatus = m.status === 'streaming' ? 'stopped' : m.status;
  return {
    id: m.id,
    role: 'assistant',
    content: m.content,
    status,
    errorCode: status === 'error' ? replyErrorCode(m.errorCode) : null,
    replyTo: m.replyTo,
    answerer: m.answerer,
    model: m.answerer === 'model' && isModelId(m.model) ? m.model : null,
  };
}

/**
 * Lists of messages as one transcript, by id: a later list's copy of an id
 * wins. Saved messages in pos order, then the unsaved in the order they came.
 */
function mergeMessages(...lists: ChatMessage[][]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const list of lists) for (const m of list) byId.set(m.id, m);
  const all = [...byId.values()];
  const placed = all.filter((m) => m.pos !== null).sort((a, b) => (a.pos as number) - (b.pos as number));
  return [...placed, ...all.filter((m) => m.pos === null)];
}

function recency(a: ConversationSummary, b: ConversationSummary): number {
  const ta = Date.parse(a.lastMessageAt);
  const tb = Date.parse(b.lastMessageAt);
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The list with this conversation where it now belongs: under Starred, or in
 * the recency-ordered page list. Not appended past a page boundary: a row
 * older than everything loaded arrives with its own page.
 */
function placeInList(
  list: ConversationListState,
  summaries: Record<string, ConversationSummary>,
  summary: ConversationSummary
): ConversationListState {
  const ids = list.ids.filter((id) => id !== summary.id);
  const starredIds = list.starredIds.filter((id) => id !== summary.id);
  const insert = (arr: string[], open: boolean) => {
    const at = arr.findIndex((id) => summaries[id] && recency(summary, summaries[id]) < 0);
    if (at >= 0) arr.splice(at, 0, summary.id);
    else if (open) arr.push(summary.id);
  };
  if (summary.starred) insert(starredIds, true);
  else insert(ids, list.cursor === null);
  return { ...list, ids, starredIds };
}

/**
 * The first page, read again over a list that had loaded further (a refresh
 * after History was scrolled): the page's rows, then every row already loaded
 * past the page's last one, under the deeper cursor, so the pages below are
 * not lost from under the reader (or from under the row Back hands focus to).
 * A row inside the page's range that the page no longer holds was deleted or
 * moved elsewhere, and goes. The order is the server's keyset, newest first
 * by (lastMessageAt, id): `recency`. A page with no cursor is the whole list.
 */
function refreshedPage(
  prev: Pick<ConversationListState, 'ids' | 'cursor'>,
  page: readonly ConversationSummary[],
  nextCursor: string | null,
  summaries: Record<string, ConversationSummary>
): { ids: string[]; cursor: string | null } {
  const ids = page.map((c) => c.id).filter((id) => !removed.has(id));
  const last = page.at(-1);
  if (nextCursor === null || !last) return { ids, cursor: nextCursor };
  const onPage = new Set(page.map((c) => c.id));
  const below = prev.ids.filter(
    (id) => !onPage.has(id) && !removed.has(id) && !!summaries[id] && recency(last, summaries[id]) < 0
  );
  return below.length > 0 ? { ids: [...ids, ...below], cursor: prev.cursor } : { ids, cursor: nextCursor };
}

/** This browser's copy of a conversation is newer than a page's (a turn saved here since the page was read). */
function newerHere(local: ConversationSummary | undefined, row: ConversationSummary): boolean {
  return !!local && Date.parse(local.lastMessageAt) > Date.parse(row.lastMessageAt);
}

function withSummaries(
  s: Pick<ConversationsState, 'summaries' | 'itemIndex'>,
  list: ConversationSummary[]
): Pick<ConversationsState, 'summaries' | 'itemIndex'> {
  if (list.length === 0) return { summaries: s.summaries, itemIndex: s.itemIndex };
  const summaries = { ...s.summaries };
  const itemIndex = { ...s.itemIndex };
  for (const c of list) {
    if (removed.has(c.id)) continue;
    summaries[c.id] = c;
    if (c.itemId) itemIndex[c.itemId] = c.id;
  }
  return { summaries, itemIndex };
}

/** The planner as context, focused on the conversation's item while it exists. */
function plannerContext(itemId: string | null): { context: string; typeNouns: string[] } {
  const { items, projects, itemTypes, routines, seasons, goals, userTimezone } = usePlannerStore.getState();
  const focusItemId = itemId && items.some((i) => i.id === itemId) ? itemId : undefined;
  const context = buildDsulContext({
    items,
    projects,
    routines,
    seasons,
    // The AI is told about goals only while the user has the idea switched on.
    goals: goalsEnabled() ? goals : [],
    focusItemId,
    userTimezone,
  });
  return { context, typeNouns: itemTypes.map((t) => t.labelPlural.toLowerCase()) };
}

/**
 * An item conversation's title on create: the item's own, while it has one.
 * The live title shows in History while the item exists; this stored copy is
 * what shows, and what search matches, once it is gone (migration 057).
 */
function itemTitle(itemId: string | null): string {
  if (!itemId) return '';
  return cleanTitle(usePlannerStore.getState().items.find((i) => i.id === itemId)?.title ?? '');
}

/**
 * What OpenClaw needs to pick up a conversation it has not seen whole.
 *
 * The gateway is sent only the newest turn (SEND_FULL_TRANSCRIPT_TO_GATEWAY,
 * lib/openclaw-gateway.ts) and remembers the rest in its own session; the
 * plugin's sessions archive after about an hour idle. So when OpenClaw answers
 * a conversation that holds the other answerer's replies, or the plugin's
 * session has likely lapsed, the context carries the last few turns.
 */
function continuityNote(prior: ChatMessage[], answerer: Answerer, via: 'chat' | 'plugin', now: number): string {
  if (answerer !== 'openclaw' || prior.length === 0) return '';
  const otherAnswerer = prior.some((m) => m.role === 'assistant' && m.answerer !== null && m.answerer !== 'openclaw');
  const last = prior[prior.length - 1];
  const lapsed = via === 'plugin' && now - last.createdAt > PLUGIN_SESSION_IDLE_MS;
  if (!otherAnswerer && !lapsed) return '';

  const turns = outgoingTurns(prior).slice(-CONTINUITY_TURNS);
  const lines: string[] = [];
  let budget = CONTINUITY_CHARS;
  for (let i = turns.length - 1; i >= 0; i--) {
    const label = turns[i].role === 'user' ? 'User' : 'Assistant';
    const line = `${label}: ${turns[i].content}`;
    if (line.length + 1 > budget) {
      const room = budget - label.length - 4;
      if (room > 0) lines.unshift(`${label}: …${cleanText(turns[i].content.slice(-room), room)}`);
      break;
    }
    lines.unshift(line);
    budget -= line.length + 1;
  }
  return lines.length > 0 ? `## Earlier in this conversation\n${lines.join('\n')}` : '';
}

/** The legacy transcripts (pre-2a): the global thread and every item thread. */
function sweepLegacyTranscripts(): void {
  try {
    localStorage.removeItem('dsul-chat-history');
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith('dsul-item-chat-')) localStorage.removeItem(key);
    }
  } catch {
    /* storage unavailable: nothing to sweep */
  }
}

// ── The store ────────────────────────────────────────────────────────────────

export const useConversationsStore = create<ConversationsState>()((set, get) => {
  const stamp = (): Stamp => ({ generation: get().generation, ownerId: get().ownerId });

  /** A stamp the store has moved on from: reset, or another account signed in. */
  const isStale = (st: Stamp): boolean => {
    const s = get();
    return (
      st.generation !== s.generation ||
      st.ownerId !== s.ownerId ||
      st.ownerId !== useAIConnectionStore.getState().hydratedUserId
    );
  };

  const updateThread = (id: string, fn: (t: Thread) => Thread) =>
    set((s) => {
      const t = s.threads[id];
      return t ? { threads: { ...s.threads, [id]: fn(t) } } : s;
    });

  const setSync = (threadId: string, ids: readonly string[], sync: ChatMessage['sync']) =>
    updateThread(resolveId(threadId), (t) => ({
      ...t,
      messages: t.messages.map((m) => (ids.includes(m.id) ? { ...m, sync } : m)),
    }));

  const jobIds = (job: SaveJob) => job.messages.map((m) => m.id);

  /** The migration is missing: everything waiting is "Not saved", and nothing more is sent. */
  const latchOff = () => {
    const queued = queue;
    queue = [];
    set({ saving: 'off' });
    for (const job of queued) setSync(job.threadId, jobIds(job), 'unsaved');
  };

  /**
   * A conversation deleted elsewhere (404 on a save or an open). Its waiting
   * turns would land nowhere, or bring it back with `create`: "Not saved", now.
   *
   * The thread keeps the name it was shown under (D9: the view keeps what is
   * in memory). The summary goes, and for a conversation opened from History
   * it was the only place the title lived, so the header would fall back to
   * "New chat", or to the first message under a rename. Kept as `draftTitle`,
   * which is safe on a gone thread: nothing saves one (fire and the pagehide
   * flush refuse it), and an item's next send never reuses it
   * (resolveItemThread skips gone drafts).
   */
  const markGone = (id: string) => {
    const rest = queue.filter((q) => resolveId(q.threadId) === id);
    queue = queue.filter((q) => resolveId(q.threadId) !== id);
    for (const q of rest) setSync(id, jobIds(q), 'unsaved');
    pendingTallies.delete(id);
    set((s) => {
      const t = s.threads[id];
      const itemId = t?.itemId ?? s.summaries[id]?.itemId ?? null;
      const summaries = { ...s.summaries };
      delete summaries[id];
      const draftTitle = s.summaries[id]?.title ?? t?.draftTitle ?? null;
      return {
        threads: t ? { ...s.threads, [id]: { ...t, load: 'gone', saved: false, draftTitle } } : s.threads,
        summaries,
        list: { ...s.list, ids: s.list.ids.filter((x) => x !== id), starredIds: s.list.starredIds.filter((x) => x !== id) },
        itemIndex: itemId ? { ...s.itemIndex, [itemId]: null } : s.itemIndex,
        search: withoutHit(s.search, id),
      };
    });
  };

  /** A save on its conversation's chain, after whatever that conversation already has there. */
  const chainSave = (id: string, job: SaveJob) => {
    waiting.add(job);
    void enqueue(id, () => fire(job));
  };

  const turnBody = (job: SaveJob, thread: Thread): TurnRequest => {
    if (thread.saved) return { ownerId: job.ownerId as string, messages: job.messages };
    const first = thread.messages.find((m) => m.role === 'user')?.content ?? job.messages[0].content;
    return {
      ownerId: job.ownerId as string,
      create: { itemId: thread.itemId, title: thread.draftTitle ?? deriveTitle(first) },
      messages: job.messages,
    };
  };

  /**
   * The draft `from` turned out to be its item's existing conversation `to`:
   * everything known about it moves there, and the rail follows.
   */
  const rebind = (from: string, to: string) => {
    if (from === to) return;
    aliases.set(from, to);
    const controller = controllers.get(from);
    if (controller) {
      controllers.delete(from);
      controllers.set(to, controller);
    }
    const chain = chains.get(from);
    if (chain && !chains.has(to)) chains.set(to, chain);
    const tallies = pendingTallies.get(from);
    if (tallies) {
      pendingTallies.delete(from);
      pendingTallies.set(to, [...(pendingTallies.get(to) ?? []), ...tallies]);
    }
    set((s) => {
      const fromT = s.threads[from];
      const toT = s.threads[to];
      const threads = { ...s.threads };
      delete threads[from];
      if (fromT) {
        threads[to] = toT
          ? {
              ...toT,
              messages: mergeMessages(toT.messages, fromT.messages),
              streaming: toT.streaming || fromT.streaming,
              typing: toT.typing || fromT.typing,
              // What the other device said is on the server: fetch on next open.
              fetchedAt: 0,
            }
          : { ...fromT, id: to, saved: true, load: 'idle', fetchedAt: 0 };
      }
      const itemId = fromT?.itemId ?? toT?.itemId ?? null;
      const sending = { ...s.sending };
      if (sending[`conv:${from}`]) {
        delete sending[`conv:${from}`];
        sending[`conv:${to}`] = true;
      }
      return { threads, sending, itemIndex: itemId ? { ...s.itemIndex, [itemId]: to } : s.itemIndex };
    });
    useRailStore.getState().rebindConversation(from, to);
  };

  const sendTally = async (rawId: string, tally: ConversationChanges, st: Stamp): Promise<void> => {
    if (isStale(st)) return;
    const id = resolveId(rawId);
    if (removed.has(id) || get().saving === 'off') return;
    const s = get();
    const t = s.threads[id];
    if (t && !t.saved && !s.summaries[id]) {
      pendingTallies.set(id, [...(pendingTallies.get(id) ?? []), { tally, ...st }]);
      return;
    }
    const res = await deps.api.patch(id, { addChanges: tally });
    if (isStale(st)) return;
    if (res.ok) {
      const local = get().summaries[id];
      const server = res.value;
      // The server's row, holding any tally still queued behind this one.
      const changes = local
        ? {
            added: Math.max(server.changes.added, local.changes.added),
            steps: Math.max(server.changes.steps, local.changes.steps),
            moved: Math.max(server.changes.moved, local.changes.moved),
            changed: Math.max(server.changes.changed, local.changes.changed),
          }
        : server.changes;
      if (!removed.has(id)) {
        touch(id);
        set((s2) => ({ summaries: { ...s2.summaries, [id]: { ...server, changes } } }));
      }
      return;
    }
    if (res.error === 'unavailable') latchOff();
    // Anything else is dropped, never re-sent: an increment whose answer was
    // lost may have landed, and a re-send would count it twice. A 404 here
    // never means "gone"; only saves and opens decide that.
  };

  const flushPendingTallies = (id: string) => {
    const held = pendingTallies.get(id);
    if (!held) return;
    pendingTallies.delete(id);
    for (const p of held) {
      if (isStale(p)) continue;
      touch(id);
      set((s) => {
        const summary = s.summaries[id];
        return summary ? { summaries: { ...s.summaries, [id]: { ...summary, changes: addChanges(summary.changes, p.tally) } } } : s;
      });
      void enqueue(id, () => sendTally(id, p.tally, p));
    }
  };

  /** The answer to one save. */
  const settle = async (job: SaveJob, id: string, res: ApiCallResult<{ conversation: ConversationSummary; inserted: number }>, allowRebind: boolean) => {
    const ids = jobIds(job);
    if (res.ok) {
      const { conversation, inserted } = res.value;
      touch(id);
      set((s) => {
        const t = s.threads[id];
        const exact = inserted === ids.length;
        const threads = t
          ? {
              ...s.threads,
              [id]: {
                ...t,
                saved: true,
                messages: t.messages.map((m) => {
                  const at = ids.indexOf(m.id);
                  if (at < 0) return m;
                  const pos = exact ? conversation.messageCount - (ids.length - 1 - at) : m.pos;
                  return { ...m, sync: 'saved' as const, pos };
                }),
              },
            }
          : s.threads;
        const next = withSummaries(s, [conversation]);
        return {
          threads,
          ...next,
          list: placeInList(s.list, next.summaries, conversation),
          saving: 'on' as const,
        };
      });
      flushPendingTallies(id);
      return;
    }

    if (res.status === 409 && res.conversationId && allowRebind && !removed.has(res.conversationId)) {
      rebind(id, res.conversationId);
      // Once more, now without `create`; a failure queues under the new id.
      await fire({ ...job, threadId: res.conversationId }, false);
      return;
    }
    if (res.status === 404) {
      setSync(id, ids, 'unsaved');
      markGone(id);
      return;
    }
    // The routes' own word for a missing migration. A bare 503 (the
    // platform's, with no such body) is a 5xx, and retried below.
    if (res.error === 'unavailable') {
      setSync(id, ids, 'unsaved');
      latchOff();
      return;
    }
    // Saved as sent, never: a shape the route refuses, or a session that
    // ended or changed hands. Neither gets better with a retry.
    if (res.status === 400 || res.status === 413 || res.status === 415 || res.status === 401 || res.status === 403) {
      setSync(id, ids, 'unsaved');
      return;
    }
    // 429, a 5xx, the network: wait for the next chance. So does a 409 naming
    // a conversation deleted here whose DELETE is still on its way: once it
    // lands, the retry creates afresh.
    const tries = job.tries + 1;
    if (tries >= MAX_SAVE_TRIES) {
      setSync(id, ids, 'unsaved');
      return;
    }
    queue.push({ ...job, threadId: id, tries });
  };

  /** One save, now, unless it is stale or an older turn of its conversation is still waiting. */
  async function fire(job: SaveJob, allowRebind = true): Promise<void> {
    waiting.delete(job);
    if (isStale(job)) return;
    const id = resolveId(job.threadId);
    if (removed.has(id)) {
      swallow(id, job);
      return;
    }
    if (get().saving === 'off') {
      setSync(id, jobIds(job), 'unsaved');
      return;
    }
    // Deleted elsewhere: a save now would carry `create` and bring it back.
    if (get().threads[id]?.load === 'gone') {
      setSync(id, jobIds(job), 'unsaved');
      return;
    }
    // Turns land in the order they were said.
    if (queue.some((q) => resolveId(q.threadId) === id)) {
      queue.push(job);
      return;
    }
    const thread = get().threads[id];
    if (!thread || !job.ownerId) return;
    const body = turnBody(job, thread);
    inflight.set(job, { id, body });
    attempted.add(id);
    let res: ApiCallResult<{ conversation: ConversationSummary; inserted: number }>;
    try {
      res = await deps.api.appendTurn(id, body);
    } catch {
      res = { ok: false, status: 0, error: 'network' };
    } finally {
      inflight.delete(job);
    }
    if (isStale(job)) return;
    if (removed.has(resolveId(id))) {
      // Answered or not, the pending delete runs after this on the chain; if
      // it fails, this turn is sent again (the ids make that harmless).
      swallow(resolveId(id), job);
      return;
    }
    await settle(job, resolveId(id), res, allowRebind);
  }

  /** A save a pending delete stopped: kept until the delete answers. */
  function swallow(id: string, job: SaveJob): void {
    if (!removing.has(id)) return;
    swallowed.set(id, [...(swallowed.get(id) ?? []), job]);
  }
  fireQueued = (job) => fire(job);

  return {
    ownerId: null,
    generation: 0,
    saving: 'unknown',
    list: INITIAL_LIST,
    summaries: {},
    itemIndex: {},
    threads: {},
    sending: {},
    search: INITIAL_SEARCH,

    ensureOwner: () => {
      const uid = useAIConnectionStore.getState().hydratedUserId;
      if (uid === get().ownerId) return;
      if (get().ownerId !== null) get().reset();
      set({ ownerId: uid });
    },

    ensureLoaded: () => {
      get().ensureOwner();
      if (get().saving === 'off' || !get().ownerId) return Promise.resolve();
      if (get().list.status === 'loaded') return Promise.resolve();
      if (listInflight) return listInflight;
      // A later page on its way means the list is loaded; the first page read
      // now would move the boundary that page was cut at.
      if (moreInflight) return moreInflight;
      const st = stamp();
      set((s) => ({ list: { ...s.list, status: 'loading' } }));
      const touched = new Set<string>();
      touchedDuringList.add(touched);
      const p = (async () => {
        try {
          const res = await deps.api.list();
          if (isStale(st)) return;
          if (!res.ok) {
            if (res.error === 'unavailable') latchOff();
            set((s) => ({ list: { ...s.list, status: 'error' } }));
            return;
          }
          const { conversations, starred = [], nextCursor } = res.value;
          listEpoch += 1;
          set((s) => {
            const next = withSummaries(s, [...starred, ...conversations]);
            let list: ConversationListState = {
              // Over pages already loaded (a refresh), they stay below this one.
              ...refreshedPage(s.list, conversations, nextCursor, next.summaries),
              starredIds: starred.map((c) => c.id).filter((id) => !removed.has(id)),
              status: 'loaded',
              fetchedAt: Date.now(),
            };
            // Saved, starred, renamed or tallied here while the page was on
            // its way: what this browser holds is newer than the page.
            const summaries = { ...next.summaries };
            for (const id of touched) {
              const local = s.summaries[id];
              if (!local || removed.has(id)) continue;
              summaries[id] = local;
              list = placeInList(list, summaries, local);
            }
            return { summaries, itemIndex: next.itemIndex, list, saving: 'on' };
          });
        } catch {
          if (!isStale(st)) set((s) => ({ list: { ...s.list, status: 'error' } }));
        } finally {
          touchedDuringList.delete(touched);
        }
      })();
      const tracked = p.finally(() => {
        if (listInflight === tracked) listInflight = null;
      });
      listInflight = tracked;
      return tracked;
    },

    refreshIfStale: (maxAgeMs = 60_000) => {
      const s = get();
      // Never under a later page on its way: that page's cursor was cut at
      // the boundary a re-read first page would move.
      if (s.saving === 'off' || listInflight || moreInflight) return;
      if (s.list.status !== 'loaded') {
        void get().ensureLoaded();
        return;
      }
      if (Date.now() - s.list.fetchedAt < maxAgeMs) return;
      // The first page again, quietly: the rows stay up while it loads.
      set((x) => ({ list: { ...x.list, status: 'idle' } }));
      void get().ensureLoaded().then(() => {
        // A failed refresh puts back only the status: the rows are the ones
        // on screen NOW, a conversation saved while it was out included.
        // `fetchedAt` stays old, so the next focus or mount tries again.
        if (get().list.status === 'error') set((x) => ({ list: { ...x.list, status: 'loaded' } }));
      });
    },

    loadMore: () => {
      get().ensureOwner();
      const s = get();
      // 'error' with a cursor is a later page that failed: History's "Try
      // again" asks for it once more. (A first page that failed has no cursor;
      // ensureLoaded is its retry.)
      if (s.saving === 'off' || !s.list.cursor) return Promise.resolve();
      if (moreInflight) return moreInflight;
      if (s.list.status !== 'loaded' && s.list.status !== 'error') return Promise.resolve();
      const st = stamp();
      const cursor = s.list.cursor;
      const epoch = listEpoch;
      set((x) => ({ list: { ...x.list, status: 'loading' } }));
      const touched = new Set<string>();
      touchedDuringList.add(touched);
      const p = (async () => {
        try {
          const res = await deps.api.list({ cursor });
          if (isStale(st)) return;
          // A first page landed meanwhile (or another page moved the
          // cursor): this one was cut from a list that is no longer the one
          // on screen, and appending it could skip rows for good.
          if (epoch !== listEpoch || get().list.cursor !== cursor) {
            if (get().list.status === 'loading') set((x) => ({ list: { ...x.list, status: 'loaded' } }));
            return;
          }
          if (!res.ok) {
            if (res.error === 'unavailable') latchOff();
            set((x) => ({ list: { ...x.list, status: 'error' } }));
            return;
          }
          set((x) => {
            const seen = new Set([...x.list.ids, ...x.list.starredIds]);
            const fresh = res.value.conversations.filter((c) => !seen.has(c.id) && !removed.has(c.id));
            // Only the rows this page adds, and of those, not one this browser
            // holds a newer copy of (a turn saved here, a star, a rename, while
            // the page was on its way): that copy stays, and goes where it
            // belongs. A row already listed was placed by a newer read.
            const held = (c: ConversationSummary) => touched.has(c.id) || newerHere(x.summaries[c.id], c);
            const taken = fresh.filter((c) => !held(c));
            const next = withSummaries(x, taken);
            let list: ConversationListState = {
              ...x.list,
              ids: [...x.list.ids, ...taken.map((c) => c.id)],
              cursor: res.value.nextCursor,
              status: 'loaded',
            };
            for (const c of fresh) {
              const local = next.summaries[c.id];
              if (held(c) && local) list = placeInList(list, next.summaries, local);
            }
            return { ...next, list };
          });
        } catch {
          if (!isStale(st)) set((x) => ({ list: { ...x.list, status: 'error' } }));
        } finally {
          touchedDuringList.delete(touched);
        }
      })();
      const tracked = p.finally(() => {
        if (moreInflight === tracked) moreInflight = null;
      });
      moreInflight = tracked;
      return tracked;
    },

    openThread: (rawId) => {
      const id = resolveId(rawId);
      const s = get();
      const t = s.threads[id];
      if (s.saving === 'off' || removed.has(id)) return Promise.resolve();
      if (t?.streaming || t?.load === 'gone') return Promise.resolve();
      // A draft has nothing on the server to fetch.
      if (t && !t.saved && !s.summaries[id]) return Promise.resolve();
      if (t?.load === 'loaded' && Date.now() - t.fetchedAt < THREAD_STALE_MS) return Promise.resolve();
      const running = opening.get(id);
      if (running) return running;

      get().ensureOwner();
      const st = stamp();
      if (!st.ownerId) return Promise.resolve();
      const summary = get().summaries[id];
      set((x) => {
        const cur = x.threads[id] ?? blankThread(id, { itemId: summary?.itemId ?? null, saved: true });
        return { threads: { ...x.threads, [id]: { ...cur, load: cur.load === 'loaded' ? 'loaded' : 'loading' } } };
      });
      const p = (async () => {
        const res = await deps.api.thread(id);
        if (isStale(st) || removed.has(id)) return;
        if (res.ok) {
          const { conversation, messages, hasEarlier } = res.value;
          set((x) => {
            const cur = x.threads[id] ?? blankThread(id, { itemId: conversation.itemId, saved: true });
            // A turn saved here since the read began is newer than the read;
            // a conversation continued on another device moves up the list.
            const local = x.summaries[id];
            const keep = newerHere(local, conversation);
            const next = keep ? { summaries: x.summaries, itemIndex: x.itemIndex } : withSummaries(x, [conversation]);
            const moved = !keep && !!local && local.lastMessageAt !== conversation.lastMessageAt;
            return {
              ...next,
              list: moved ? placeInList(x.list, next.summaries, conversation) : x.list,
              threads: {
                ...x.threads,
                [id]: {
                  ...cur,
                  itemId: conversation.itemId,
                  saved: true,
                  // Even under a stream that started while this was in flight:
                  // its turn has no pos yet, so it stays last, and the reply
                  // is still found by id.
                  messages: mergeMessages(cur.messages, messages.map(fromStored)),
                  load: 'loaded',
                  hasEarlier,
                  fetchedAt: Date.now(),
                },
              },
              saving: 'on',
            };
          });
          return;
        }
        if (res.status === 404) {
          markGone(id);
          return;
        }
        if (res.error === 'unavailable') latchOff();
        updateThread(id, (cur) => ({ ...cur, load: cur.messages.length > 0 ? 'loaded' : 'error' }));
      })().finally(() => opening.delete(id));
      opening.set(id, p);
      return p;
    },

    loadEarlier: async (rawId) => {
      get().ensureOwner();
      const id = resolveId(rawId);
      const t = get().threads[id];
      if (!t || !t.hasEarlier || get().saving === 'off') return;
      const first = t.messages.find((m) => m.pos !== null);
      if (!first || first.pos === null) return;
      const st = stamp();
      const res = await deps.api.thread(id, { before: first.pos });
      if (isStale(st) || removed.has(id)) return;
      if (!res.ok) {
        if (res.status === 404) markGone(id);
        else if (res.error === 'unavailable') latchOff();
        return;
      }
      updateThread(id, (cur) => ({
        ...cur,
        messages: mergeMessages(res.value.messages.map(fromStored), cur.messages),
        hasEarlier: res.value.hasEarlier,
      }));
    },

    resolveItemThread: (itemId) => {
      get().ensureOwner();
      const s = get();
      const known = s.itemIndex[itemId];
      if (typeof known === 'string') {
        const id = resolveId(known);
        if (!s.threads[id]) {
          set((x) => ({ threads: { ...x.threads, [id]: blankThread(id, { itemId, saved: true }) } }));
        }
        return Promise.resolve(id);
      }
      // A draft for this item already (its first save still on its way) is the one.
      const draft = Object.values(s.threads).find((t) => t.itemId === itemId && !t.saved && t.load !== 'gone');
      if (draft) return Promise.resolve(draft.id);
      if (known === null || s.saving === 'off' || !s.ownerId) return Promise.resolve(get().newDraft({ itemId }));
      const running = resolving.get(itemId);
      if (running) return running;

      const st = stamp();
      const p = (async (): Promise<string> => {
        const res = await deps.api.forItem(itemId);
        if (isStale(st)) return get().newDraft({ itemId });
        if (res.ok && res.value) {
          const found = res.value;
          set((x) => ({
            ...withSummaries(x, [found]),
            threads: x.threads[found.id]
              ? x.threads
              : { ...x.threads, [found.id]: blankThread(found.id, { itemId, saved: true }) },
          }));
          return found.id;
        }
        if (res.ok) {
          set((x) => ({ itemIndex: { ...x.itemIndex, [itemId]: null } }));
        } else if (res.error === 'unavailable') {
          latchOff();
        }
        // Unknown or none: a draft. A duplicate converges through the 409 rebind.
        const again = Object.values(get().threads).find((t) => t.itemId === itemId && !t.saved && t.load !== 'gone');
        return again ? again.id : get().newDraft({ itemId });
      })()
        .catch(() => get().newDraft({ itemId }))
        .finally(() => resolving.delete(itemId));
      resolving.set(itemId, p);
      return p;
    },

    newDraft: (o = {}) => {
      get().ensureOwner();
      const id = crypto.randomUUID();
      const title = o.title !== undefined ? cleanTitle(o.title) || null : null;
      set((s) => ({ threads: { ...s.threads, [id]: blankThread(id, { itemId: o.itemId ?? null, title }) } }));
      return id;
    },

    send: async (rawId, text) => {
      // The gate first, before a byte reaches the transcript: with nothing to
      // answer, a sent message would sit under a reply that can never come.
      const caps = getAICapabilities();
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!caps.canChat || !trimmed) return;
      if (caps.target !== 'model' && caps.target !== 'openclaw') return;

      get().ensureOwner();
      const id = resolveId(rawId);
      const existing = get().threads[id];
      if (existing?.streaming || existing?.load === 'gone') return;
      // Clipped ONCE, here: the transcript, every transport (the plugin's
      // `message` too) and the saved row all agree on what was said.
      const content = cleanText(trimmed, CHAT_LIMITS.userChars);
      if (!/[^ \t\r\n]/.test(content)) return;

      const answerer: Answerer = caps.target === 'openclaw' ? 'openclaw' : 'model';
      const via = answerer === 'openclaw' && caps.openclawTransport === 'plugin' ? 'plugin' : 'chat';
      const connected = useAIConnectionStore.getState().model?.model;
      const modelId = answerer === 'model' && isModelId(connected) ? connected : null;

      const summary = get().summaries[id];
      const base = existing ?? blankThread(id, { itemId: summary?.itemId ?? null, saved: !!summary });
      const prior = base.messages;
      const now = Date.now();
      const user: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content,
        status: 'complete',
        errorCode: null,
        replyTo: null,
        answerer: null,
        model: null,
        createdAt: now,
        pos: null,
        sync: 'pending',
      };
      const reply: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        status: 'streaming',
        errorCode: null,
        replyTo: user.id,
        answerer,
        model: modelId,
        createdAt: now,
        pos: null,
        sync: 'pending',
      };
      // The title a create will carry: a chip's label, else the item's own,
      // else the first message's.
      const draftTitle = base.saved || base.draftTitle ? base.draftTitle : itemTitle(base.itemId) || deriveTitle(content);
      // Synchronous up to here: a second send in the same tick finds it streaming.
      set((s) => ({
        threads: {
          ...s.threads,
          [id]: { ...base, draftTitle, messages: [...prior, user, reply], streaming: true, typing: true },
        },
      }));
      const st = stamp();
      const controller = new AbortController();
      controllers.set(id, controller);
      void get().ensureLoaded();
      retryQueued();

      let outcome: TurnOutcome;
      try {
        const { context, typeNouns } = plannerContext(base.itemId);
        const note = continuityNote(prior, answerer, via, now);
        outcome = await deps.transport.streamTurn({
          conversationId: id,
          target: answerer,
          via,
          message: content,
          turns: outgoingTurns([...prior, user]),
          context: note ? `${context}\n\n${note}` : context,
          typeNouns,
          signal: controller.signal,
          onDelta: (delta) => {
            if (isStale(st) || !delta) return;
            updateThread(resolveId(id), (t) => ({
              ...t,
              typing: false,
              messages: t.messages.map((m) => (m.id === reply.id ? { ...m, content: m.content + delta } : m)),
            }));
          },
        });
      } catch {
        const partial = get().threads[resolveId(id)]?.messages.find((m) => m.id === reply.id)?.content ?? '';
        outcome = { content: partial, status: 'error', errorCode: 'client', model: modelId };
      } finally {
        for (const [key, c] of controllers) if (c === controller) controllers.delete(key);
      }

      // Signed out (or another account) mid-stream: drop everything.
      if (isStale(st)) return;
      const cur = resolveId(id);

      const finalContent = cleanText(outcome.content, CHAT_LIMITS.assistantChars);
      const status = outcome.status;
      // A stop before the first token leaves only the question.
      const dropReply = status !== 'error' && finalContent === '';
      const finished: ChatMessage = {
        ...reply,
        content: finalContent,
        status,
        errorCode: status === 'error' ? replyErrorCode(outcome.errorCode) : null,
        model: answerer === 'model' ? (isModelId(outcome.model) ? outcome.model : modelId) : null,
        createdAt: Date.now(),
      };
      const messages: SaveJob['messages'] = dropReply ? [toTurn(user)] : [toTurn(user), toTurn(finished)];
      const job: SaveJob = { threadId: cur, messages, tries: 0, seq: ++jobSeq, ...st };
      if (removed.has(cur)) {
        // Deleted mid-stream: kept as finished in case the delete fails.
        if (removing.has(cur)) parked.set(cur, { replyId: reply.id, reply: dropReply ? null : finished, job });
        return;
      }
      if (!get().threads[cur]) return;
      updateThread(cur, (t) => ({
        ...t,
        streaming: false,
        typing: false,
        messages: dropReply ? t.messages.filter((m) => m.id !== reply.id) : t.messages.map((m) => (m.id === reply.id ? finished : m)),
      }));

      if (get().saving === 'off' || !st.ownerId) {
        setSync(cur, messages.map((m) => m.id), 'unsaved');
        return;
      }
      // Never awaited: the composer is free while the save is on its way.
      chainSave(cur, job);
    },

    stop: (rawId) => {
      const id = resolveId(rawId);
      controllers.get(id)?.abort();
      controllers.delete(id);
    },

    rename: async (rawId, title) => {
      get().ensureOwner();
      const id = resolveId(rawId);
      const prev = get().summaries[id];
      const clean = cleanTitle(title);
      if (!prev || !clean || get().saving === 'off') return false;
      if (clean === prev.title) return true;
      const st = stamp();
      touch(id);
      set((s) => ({ summaries: { ...s.summaries, [id]: { ...prev, title: clean, renamed: true } } }));
      const res = await deps.api.patch(id, { title: clean });
      if (isStale(st)) return false;
      touch(id);
      if (res.ok) {
        // Only what this PATCH changed, onto the copy held NOW: a save or a
        // tally answered meanwhile owns the count, the time and the changes,
        // and the PATCH's row may have been read before either landed.
        const { title: saved, renamed } = res.value;
        set((s) =>
          !removed.has(id) && s.summaries[id] ? { summaries: { ...s.summaries, [id]: { ...s.summaries[id], title: saved, renamed } } } : s
        );
        return true;
      }
      if (res.error === 'unavailable') latchOff();
      set((s) => (s.summaries[id] ? { summaries: { ...s.summaries, [id]: { ...s.summaries[id], title: prev.title, renamed: prev.renamed } } } : s));
      return false;
    },

    setStarred: async (rawId, starred) => {
      get().ensureOwner();
      const id = resolveId(rawId);
      const prev = get().summaries[id];
      if (!prev || get().saving === 'off') return false;
      if (prev.starred === starred) return true;
      const st = stamp();
      const apply = (summary: ConversationSummary) => {
        touch(id);
        set((s) => {
          const summaries = { ...s.summaries, [id]: summary };
          return { summaries, list: placeInList(s.list, summaries, summary) };
        });
      };
      apply({ ...prev, starred });
      const res = await deps.api.patch(id, { starred });
      if (isStale(st)) return false;
      if (res.ok) {
        // The star alone, onto the copy held now (rename's rule).
        const now = get().summaries[id];
        if (!removed.has(id) && now) apply({ ...now, starred: res.value.starred });
        return true;
      }
      if (res.error === 'unavailable') latchOff();
      const now = get().summaries[id];
      if (now) apply({ ...now, starred: prev.starred });
      return false;
    },

    remove: async (rawId) => {
      get().ensureOwner();
      const id = resolveId(rawId);
      const s = get();
      const thread = s.threads[id];
      const summary = s.summaries[id];
      if (!thread && !summary) return true;

      controllers.get(id)?.abort();
      controllers.delete(id);
      const droppedJobs = queue.filter((q) => resolveId(q.threadId) === id);
      queue = queue.filter((q) => resolveId(q.threadId) !== id);
      const droppedTallies = pendingTallies.get(id);
      pendingTallies.delete(id);
      const itemId = thread?.itemId ?? summary?.itemId ?? null;
      const hadIndex = itemId !== null && Object.prototype.hasOwnProperty.call(s.itemIndex, itemId);
      const priorIndex = itemId !== null ? s.itemIndex[itemId] : undefined;
      // Its search result too: History keeps the results it was opened from
      // (Back does not search again), so the row, its title and its snippet
      // would otherwise still be there when the delete lands back on them.
      const hitAt = s.search.hits.findIndex((h) => h.id === id);
      const hit = hitAt >= 0 ? s.search.hits[hitAt] : undefined;
      const hitQ = s.search.q;

      removed.add(id);
      set((x) => {
        const threads = { ...x.threads };
        delete threads[id];
        const summaries = { ...x.summaries };
        delete summaries[id];
        return {
          threads,
          summaries,
          list: { ...x.list, ids: x.list.ids.filter((v) => v !== id), starredIds: x.list.starredIds.filter((v) => v !== id) },
          itemIndex: itemId !== null ? { ...x.itemIndex, [itemId]: null } : x.itemIndex,
          search: withoutHit(x.search, id),
        };
      });
      useRailStore.getState().leaveConversation(id);

      // A draft no save was ever sent for has no row: nothing to ask the
      // server. One whose first save went out may have one, answered or not.
      if (!summary && !thread?.saved && !attempted.has(id)) return true;
      if (s.saving === 'off') return true;

      const st = stamp();
      removing.add(id);
      // On the conversation's chain, so a save still on the wire lands first
      // and the DELETE then removes it, rather than the save re-creating a row
      // the DELETE already took.
      const res = await new Promise<ApiCallResult<true>>((resolve) => {
        void enqueue(id, async () => {
          try {
            resolve(await deps.api.remove(id));
          } catch {
            resolve({ ok: false, status: 0, error: 'network' });
          }
        });
      });
      removing.delete(id);
      const stopped = swallowed.get(id) ?? [];
      swallowed.delete(id);
      const cut = parked.get(id);
      parked.delete(id);
      if (isStale(st)) return res.ok;
      // A 404 is the same outcome: it is gone.
      if (res.ok || res.status === 404) return true;

      if (res.error === 'unavailable') latchOff();
      removed.delete(id);
      queue.push(...droppedJobs);
      if (droppedTallies) pendingTallies.set(id, droppedTallies);
      set((x) => {
        const summaries = summary ? { ...x.summaries, [id]: summary } : x.summaries;
        const itemIndex = { ...x.itemIndex };
        if (itemId !== null) {
          if (hadIndex) itemIndex[itemId] = priorIndex as string | null;
          else delete itemIndex[itemId];
        }
        let back = thread ? { ...thread, streaming: false, typing: false } : undefined;
        // The turn the abort cut off, finished as send finished it (stopped,
        // with its partial; only the question if nothing had arrived).
        if (back && cut) {
          const messages = cut.reply
            ? back.messages.map((m) => (m.id === cut.replyId ? (cut.reply as ChatMessage) : m))
            : back.messages.filter((m) => m.id !== cut.replyId);
          back = { ...back, messages };
        }
        // Its result, where it was, while the same search is still up.
        const search =
          hit && x.search.q === hitQ && !x.search.hits.some((h) => h.id === id)
            ? { ...x.search, hits: [...x.search.hits.slice(0, hitAt), hit, ...x.search.hits.slice(hitAt)] }
            : x.search;
        return {
          threads: back ? { ...x.threads, [id]: back } : x.threads,
          summaries,
          itemIndex,
          list: summary ? placeInList(x.list, summaries, summary) : x.list,
          search,
        };
      });
      // Saves the delete stopped, then the cut-off turn: sent again, in order
      // (fire waits behind anything still queued, and the ids make a save
      // that had already landed harmless). A stream the abort has not ended
      // yet finishes on its own now, and saves like any other.
      for (const job of cut ? [...stopped, cut.job] : stopped) {
        if (job.ownerId) chainSave(id, job);
        else setSync(id, jobIds(job), 'unsaved');
      }
      return false;
    },

    noteChanges: (rawId, tally) => {
      const cap = (n: number | undefined) => Math.min(Math.max(0, Math.trunc(n ?? 0)), CHAT_LIMITS.changesPerCall);
      const t: ConversationChanges = { added: cap(tally.added), steps: cap(tally.steps), moved: cap(tally.moved), changed: cap(tally.changed) };
      if (!hasChanges(t)) return;
      get().ensureOwner();
      const s = get();
      if (s.saving === 'off') return;
      const id = resolveId(rawId);
      if (removed.has(id)) return;
      const thread = s.threads[id];
      const summary = s.summaries[id];
      // No conversation to count against: nothing to note.
      if (!thread && !summary) return;
      const st = stamp();
      if (summary) {
        touch(id);
        set((x) => ({ summaries: { ...x.summaries, [id]: { ...summary, changes: addChanges(summary.changes, t) } } }));
      }
      if (!summary && thread && !thread.saved) {
        pendingTallies.set(id, [...(pendingTallies.get(id) ?? []), { tally: t, ...st }]);
        return;
      }
      void enqueue(id, () => sendTally(id, t, st));
    },

    runSearch: (q) => {
      const query = Array.from(cleanText(typeof q === 'string' ? q : '', 1_000).trim())
        .slice(0, CHAT_LIMITS.searchMax)
        .join('');
      if (Array.from(query).length < CHAT_LIMITS.searchMin) {
        set({ search: { q: query, status: 'idle', hits: [] } });
        return;
      }
      if (get().saving === 'off') {
        set({ search: { q: query, status: 'error', hits: [] } });
        return;
      }
      get().ensureOwner();
      const st = stamp();
      set((s) => ({ search: { q: query, status: 'loading', hits: s.search.hits } }));
      void deps.api.search(query).then((res) => {
        // Superseded by a newer query, or by a reset.
        if (isStale(st) || get().search.q !== query) return;
        if (!res.ok) {
          if (res.error === 'unavailable') latchOff();
          set({ search: { q: query, status: 'error', hits: [] } });
          return;
        }
        const hits = res.value.filter((h) => !removed.has(h.id));
        set((s) => ({ search: { q: query, status: 'done', hits }, summaries: { ...s.summaries, ...Object.fromEntries(hits.map((h) => [h.id, s.summaries[h.id] ?? stripHit(h)])) } }));
      });
    },

    flushOnPageHide: () => {
      const s = get();
      const ownerId = s.ownerId;
      if (!ownerId || s.saving === 'off' || ownerId !== useAIConnectionStore.getState().hydratedUserId) return;
      const encoder = new TextEncoder();
      let budget = KEEPALIVE_BUDGET_BYTES;
      const bytes = (body: TurnRequest) => encoder.encode(JSON.stringify(body)).byteLength;
      /** Room for a body, taken from the one budget; false when it does not fit what is left. */
      const reserve = (body: TurnRequest): string | null => {
        const json = JSON.stringify(body);
        const n = encoder.encode(json).byteLength;
        if (n > budget) return null;
        budget -= n;
        return json;
      };
      // Never a conversation deleted here or found deleted elsewhere: a body
      // with `create` would bring it back.
      const live = (id: string) => {
        const t = s.threads[id];
        return !!t && t.load !== 'gone' && !removed.has(id);
      };

      // The budget goes in this priority order: the streaming turn, saves on
      // the wire, saves waiting on a chain, saves waiting for a retry. It is
      // not the order they are SENT in (below).
      //
      // 1. A turn still streaming, as stopped, its reply cut from the end to fit.
      const streamed: { id: string; json: string }[] = [];
      for (const thread of Object.values(s.threads)) {
        if (!thread.streaming || !live(thread.id)) continue;
        const reply = [...thread.messages].reverse().find((m) => m.role === 'assistant' && m.status === 'streaming');
        const user = reply && thread.messages.find((m) => m.id === reply.replyTo);
        if (!reply || !user) continue;
        const head: Omit<TurnRequest, 'messages'> = thread.saved
          ? { ownerId }
          : { ownerId, create: { itemId: thread.itemId, title: thread.draftTitle ?? deriveTitle(user.content) } };
        const alone: TurnRequest = { ...head, messages: [toTurn(user)] };
        const partial = cleanText(reply.content, CHAT_LIMITS.assistantChars);
        const withReply = (n: number): TurnRequest => ({
          ...head,
          messages: [toTurn(user), toTurn({ ...reply, content: cleanText(partial, n), status: 'stopped' })],
        });
        let body = alone;
        if (partial && bytes(withReply(1)) <= budget) {
          // The longest prefix that fits what is left of the budget.
          let lo = 1;
          let hi = partial.length;
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (bytes(withReply(mid)) <= budget) lo = mid;
            else hi = mid - 1;
          }
          body = withReply(lo);
        }
        const json = reserve(body);
        if (json) streamed.push({ id: thread.id, json });
      }
      const saves: { seq: number; id: string; json: string }[] = [];
      const take = (job: SaveJob, id: string, body: TurnRequest) => {
        if (isStale(job) || !live(resolveId(id))) return;
        const json = reserve(body);
        if (json) saves.push({ seq: job.seq, id, json });
      };
      // 2. Saves on the wire: an ordinary fetch is cancelled at unload, and the
      //    ids make a re-send harmless.
      for (const [job, { id, body }] of inflight) take(job, id, body);
      // 3. Saves on a chain, behind an earlier save or a tally, then 4. saves
      //    waiting for a retry, while they fit.
      for (const job of [...waiting, ...queue]) {
        const id = resolveId(job.threadId);
        const thread = s.threads[id];
        if (thread) take(job, id, turnBody(job, thread));
      }

      // Sent per conversation in the order the turns were said: the oldest
      // save first, the streaming turn last. A row's positions are handed out
      // as bodies arrive, so the other order could save a transcript backwards.
      saves.sort((a, b) => a.seq - b.seq);
      for (const b of saves) deps.api.appendTurnKeepalive(b.id, b.json);
      for (const b of streamed) deps.api.appendTurnKeepalive(b.id, b.json);
    },

    beginSend: (key) => {
      if (get().sending[key]) return false;
      set((s) => ({ sending: { ...s.sending, [key]: true } }));
      return true;
    },

    endSend: (key) =>
      set((s) => {
        if (!s.sending[key]) return s;
        const sending = { ...s.sending };
        delete sending[key];
        return { sending };
      }),

    reset: () => {
      for (const c of controllers.values()) c.abort();
      controllers.clear();
      chains.clear();
      aliases.clear();
      queue = [];
      inflight.clear();
      waiting.clear();
      pendingTallies.clear();
      removed.clear();
      attempted.clear();
      removing.clear();
      swallowed.clear();
      parked.clear();
      resolving.clear();
      opening.clear();
      listInflight = null;
      moreInflight = null;
      touchedDuringList.clear();
      set((s) => ({
        ownerId: null,
        generation: s.generation + 1,
        list: INITIAL_LIST,
        summaries: {},
        itemIndex: {},
        threads: {},
        sending: {},
        search: INITIAL_SEARCH,
      }));
    },
  };
});

/** The search without a conversation's result: deleted here, or found deleted elsewhere. */
function withoutHit(search: ConversationSearchState, id: string): ConversationSearchState {
  return search.hits.some((h) => h.id === id) ? { ...search, hits: search.hits.filter((h) => h.id !== id) } : search;
}

/** A search hit as a plain summary, for opening it before History has listed it. */
function stripHit(h: SearchHit): ConversationSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { matched, snippet, itemTitle, ...summary } = h;
  return summary;
}

/** Every waiting save, once more, in order. Next send, `online`, the tab coming back. */
function retryQueued(): void {
  const store = useConversationsStore.getState();
  // An account switch resets first, which empties the queue: nothing of the
  // last account's is ever sent under the next one's cookie.
  store.ensureOwner();
  if (queue.length === 0) return;
  const jobs = queue;
  queue = [];
  for (const job of jobs) {
    const id = resolveConversationId(job.threadId);
    waiting.add(job);
    void enqueue(id, () => fireQueued(job));
  }
}

/**
 * Drop every conversation this browser holds, in memory, and the views and
 * drafts over them; abort every stream; forget the plugin transport; sweep the
 * pre-2a transcript keys. Two callers: the sign-out clear (RAW_CLEARERS in
 * lib/local-state.ts) and any account switch it covers. Nothing on the server
 * is touched: nothing in the app deletes a saved conversation except the
 * user's own Delete.
 */
export function clearChatState(): void {
  for (const c of controllers.values()) c.abort();
  controllers.clear();
  useConversationsStore.getState().reset();
  useRailStore.getState().reset();
  resetPluginTransport();
  sweepLegacyTranscripts();
}

// Module scope, once per page load; inert on the server.
if (typeof window !== 'undefined') {
  // The pre-2a transcripts (24h, localStorage) are not imported: the account
  // is the record now, and they are the most disclosive thing on this disk.
  sweepLegacyTranscripts();
  // Here, not in a component: every page that can send (/, and /item/[id],
  // which has no AppShell) closes through it, and two listeners would spend
  // the browser's one keepalive budget twice. Not on a bfcache hide
  // (`persisted`): that page comes back, and its saves with it.
  window.addEventListener('pagehide', (e) => {
    if (!e.persisted) useConversationsStore.getState().flushOnPageHide();
  });
  window.addEventListener('online', () => retryQueued());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') retryQueued();
  });
}
