import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * conversations-store: saved conversations as this browser holds them.
 *
 * The rules pinned here are the ones a naive store gets wrong: one save per
 * FINISHED turn (never per token), every queued save stamped with the account
 * and generation it was queued under, one chain per conversation, the 409
 * rebind, the 503 latch, and a pagehide that fits in the keepalive budget.
 * The API and the transport are fakes (configureConversations), so nothing
 * here reaches fetch.
 */

const planner = vi.hoisted(() => ({
  items: [] as { id: string; type: string; title: string }[],
  /** The look-only preview: cached rows painted while the load is still in flight. */
  isPreview: false,
  /** The load in flight with no preview up: a dropped preview (dropPreview) leaves exactly this. */
  loading: false,
  listeners: new Set<(s: unknown, prev: unknown) => void>(),
}));
vi.mock('@/lib/planner-store', () => ({
  usePlannerStore: {
    getState: () => ({
      items: planner.items,
      isPreview: planner.isPreview,
      userId: 'seed-user',
      isLoading: planner.isPreview || planner.loading,
      projects: [],
      itemTypes: [{ labelPlural: 'Errands' }],
      routines: [],
      seasons: [],
      goals: [],
      userTimezone: 'UTC',
    }),
    subscribe: (fn: (s: unknown, prev: unknown) => void) => {
      planner.listeners.add(fn);
      return () => planner.listeners.delete(fn);
    },
  },
}));

const contextArgs = vi.hoisted(() => [] as { focusItemId?: string }[]);
vi.mock('@/lib/ai-context', () => ({
  buildDsulContext: (args: { focusItemId?: string }) => {
    contextArgs.push(args);
    return '## dsul Context';
  },
}));

import {
  KEEPALIVE_BUDGET_BYTES,
  clearChatState,
  configureConversations,
  conversationsSettled,
  noteOpenclawAsked,
  openclawWasAsked,
  resolveConversationId,
  useConversationsStore,
  type ChatMessage,
} from '@/lib/conversations-store';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useRailStore } from '@/lib/rail-store';
import type { TurnInput } from '@/lib/chat-transport';
import type { TurnRequest } from '@/lib/conversation-types';
import { CONNECTED_MODEL, OPENCLAW_PLUGIN, NOTHING_CONNECTED, SEED_USER_ID, seedAI } from './helpers/ai-fixtures';
import { fail, fakeApi, fakeTransport, flush, hangs, summary, type FakeApi, type FakeTransport } from './helpers/conversations-fakes';

const store = () => useConversationsStore.getState();
const thread = (id: string) => store().threads[resolveConversationId(id)];
const roles = (id: string) => thread(id)?.messages.map((m) => m.role);
const syncs = (id: string) => thread(id)?.messages.map((m) => m.sync);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function msg(o: Partial<ChatMessage> & { id: string; role: ChatMessage['role'] }): ChatMessage {
  return {
    content: 'hi',
    status: 'complete',
    errorCode: null,
    replyTo: null,
    answerer: o.role === 'assistant' ? 'model' : null,
    model: null,
    createdAt: Date.now(),
    pos: null,
    sync: 'saved',
    ...o,
  };
}

const stored = (id: string, pos: number, role: 'user' | 'assistant', content: string, replyTo: string | null = null) => ({
  id,
  pos,
  role,
  content,
  status: 'complete' as const,
  errorCode: null,
  replyTo,
  answerer: role === 'assistant' ? ('model' as const) : null,
  model: role === 'assistant' ? 'gpt-4o-mini' : null,
  createdAt: '2026-10-02T09:00:00.000Z',
});

/** A new general conversation with one finished, saved turn. */
async function sendNew(text: string, o?: { itemId?: string; title?: string }) {
  const id = store().newDraft(o);
  await store().send(id, text);
  await conversationsSettled();
  return id;
}

const online = async () => {
  window.dispatchEvent(new Event('online'));
  await flush();
  await conversationsSettled();
};

let api: FakeApi;
let tx: FakeTransport;
let unseed: () => void = () => {};

/** The landing: fresh rows take the preview's place, and the store notifies. */
function landPlanner(items: typeof planner.items) {
  planner.items = items;
  planner.isPreview = false;
  planner.loading = false;
  const s = usePlannerStore.getState();
  for (const fn of [...planner.listeners]) fn(s, s);
}

/** dropPreview, the crash recovery: the cached rows go, the preview ends, the load is still in flight. */
function dropPlannerPreview() {
  planner.items = [];
  planner.isPreview = false;
  planner.loading = true;
  const s = usePlannerStore.getState();
  for (const fn of [...planner.listeners]) fn(s, s);
}

beforeEach(() => {
  planner.items = [];
  planner.isPreview = false;
  planner.loading = false;
  planner.listeners.clear();
  contextArgs.length = 0;
  api = fakeApi();
  tx = fakeTransport();
  configureConversations({ api: api.api, transport: tx.transport });
  unseed = seedAI(CONNECTED_MODEL);
  clearChatState();
  useConversationsStore.setState({ saving: 'unknown' });
});

afterEach(async () => {
  await conversationsSettled();
  unseed();
  unseed = () => {};
});

describe('the gate', () => {
  it('with nothing to answer, a send writes nothing and calls nothing', async () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    const id = store().newDraft();
    await store().send(id, 'plan my day');
    expect(thread(id).messages).toEqual([]);
    expect(tx.transport.streamTurn).not.toHaveBeenCalled();
    expect(api.turns).toHaveLength(0);
  });

  it('an empty message is not a send', async () => {
    const id = store().newDraft();
    await store().send(id, '  \n ');
    expect(tx.inputs).toHaveLength(0);
  });
});

describe('the save', () => {
  it('is exactly one appendTurn per finished turn, and none per delta', async () => {
    tx.next = (input) => {
      for (const d of ['Su', 're', ', ', 'here', '.']) {
        input.onDelta(d);
        expect(api.turns).toHaveLength(0);
      }
      return { content: 'Sure, here.', status: 'complete', errorCode: null, model: 'gpt-4o-mini' };
    };
    const id = await sendNew('  plan my day  ');

    expect(api.turns).toHaveLength(1);
    const { body } = api.turns[0];
    const [user, reply] = thread(id).messages;
    expect(body).toEqual({
      ownerId: SEED_USER_ID,
      create: { itemId: null, title: 'plan my day' },
      messages: [
        { id: user.id, role: 'user', content: 'plan my day' },
        {
          id: reply.id,
          role: 'assistant',
          content: 'Sure, here.',
          status: 'complete',
          errorCode: null,
          replyTo: user.id,
          answerer: 'model',
          model: 'gpt-4o-mini',
        },
      ],
    });
    expect(thread(id)).toMatchObject({ saved: true, streaming: false, typing: false });
    expect(thread(id).messages.map((m) => [m.sync, m.pos])).toEqual([
      ['saved', 1],
      ['saved', 2],
    ]);
    expect(store().summaries[id]).toMatchObject({ id, messageCount: 2 });
    expect(store().list.ids).toEqual([id]);
    expect(store().saving).toBe('on');
  });

  it('saves a later turn without create', async () => {
    const id = await sendNew('one');
    await store().send(id, 'two');
    await conversationsSettled();
    expect(api.turns.map((t) => t.body.create)).toEqual([{ itemId: null, title: 'one' }, undefined]);
    expect(thread(id).messages.map((m) => m.pos)).toEqual([1, 2, 3, 4]);
  });

  it("titles a draft by its chip's label", async () => {
    await sendNew('Plan my day', { title: '  Plan\nmy day ' });
    expect(api.turns[0].body.create?.title).toBe('Plan my day');
  });

  it('a stop keeps the partial, saved as stopped', async () => {
    const h = hangs('Half an ans');
    tx.next = h.run;
    const id = store().newDraft();
    const sending = store().send(id, 'hello');
    await flush(1);
    expect(thread(id).streaming).toBe(true);
    store().stop(id);
    await sending;
    await conversationsSettled();

    expect(thread(id).streaming).toBe(false);
    expect(api.turns[0].body.messages[1]).toMatchObject({ status: 'stopped', content: 'Half an ans', errorCode: null });
  });

  it('a stop before the first token leaves only the question, and saves it alone', async () => {
    tx.next = hangs('').run;
    const id = store().newDraft();
    const sending = store().send(id, 'hello');
    store().stop(id);
    await sending;
    await conversationsSettled();

    expect(roles(id)).toEqual(['user']);
    expect(api.turns[0].body.messages).toHaveLength(1);
    expect(api.turns[0].body.messages[0]).toMatchObject({ role: 'user', content: 'hello' });
  });

  it('a failure is saved as its code, never its words, and never re-sent to a model', async () => {
    tx.next = () => ({ content: '', status: 'error', errorCode: 'timeout', model: 'gpt-4o-mini' });
    const id = await sendNew('first');
    expect(api.turns[0].body.messages[1]).toMatchObject({ status: 'error', errorCode: 'timeout', content: '' });
    expect(thread(id).messages[1]).toMatchObject({ status: 'error', errorCode: 'timeout', content: '' });

    tx.next = () => ({ content: 'ok', status: 'complete', errorCode: null, model: 'gpt-4o-mini' });
    await store().send(id, 'second');
    expect(tx.inputs[1].turns).toEqual([{ role: 'user', content: 'second' }]);
  });

  it("keeps a failed reply's partial text beside its code", async () => {
    tx.next = (input) => {
      input.onDelta('Here is the start');
      return { content: 'Here is the start', status: 'error', errorCode: 'timeout', model: 'gpt-4o-mini' };
    };
    const id = await sendNew('hello');
    expect(thread(id).messages[1]).toMatchObject({ content: 'Here is the start', status: 'error', errorCode: 'timeout' });
  });

  it('saves a code it has never heard of as client', async () => {
    tx.next = () => ({ content: '', status: 'error', errorCode: 'teapot' as never, model: null });
    await sendNew('hello');
    expect(api.turns[0].body.messages[1]).toMatchObject({ errorCode: 'client' });
  });

  it('sends and saves a 9,000-character paste as 8,000, the same everywhere', async () => {
    const id = await sendNew('x'.repeat(9_000));
    expect(tx.inputs[0].message).toHaveLength(8_000);
    expect(tx.inputs[0].turns.at(-1)?.content).toHaveLength(8_000);
    expect(thread(id).messages[0].content).toHaveLength(8_000);
    expect(api.turns[0].body.messages[0].content).toHaveLength(8_000);
  });

  it("saves a 50,000-character OpenClaw reply as 40,000, with no model", async () => {
    unseed();
    unseed = seedAI({ ...OPENCLAW_PLUGIN, openclaw: { gateway: true, agent: true } });
    store().ensureOwner();
    tx.next = () => ({ content: 'y'.repeat(50_000), status: 'complete', errorCode: null, model: null });
    const id = await sendNew('long one please');

    expect(tx.inputs[0]).toMatchObject({ target: 'openclaw', via: 'chat' });
    expect(thread(id).messages[1].content).toHaveLength(40_000);
    expect(api.turns[0].body.messages[1]).toMatchObject({ answerer: 'openclaw', model: null });
    expect(api.turns[0].body.messages[1]?.content).toHaveLength(40_000);
  });

  it("names the conversation to the transport, and focuses the context on a live item", async () => {
    planner.items = [{ id: 'i1', type: 'task', title: 'Book the dentist' }];
    const id = await sendNew('what next?', { itemId: 'i1' });
    expect(tx.inputs[0].conversationId).toBe(id);
    expect(contextArgs.at(-1)?.focusItemId).toBe('i1');

    planner.items = [];
    await store().send(id, 'and now?');
    expect(contextArgs.at(-1)?.focusItemId).toBeUndefined();
  });

  it("titles an item's conversation by the item, not by its first question", async () => {
    // The stored title is what History shows, and search matches, once the
    // item is gone (migration 057): "Book the dentist", not the question.
    planner.items = [{ id: 'i1', type: 'task', title: 'Book the dentist' }];
    const id = await store().resolveItemThread('i1');
    await store().send(id, 'can it be earlier in the week?');
    await conversationsSettled();
    expect(api.turns[0].body.create).toEqual({ itemId: 'i1', title: 'Book the dentist' });
  });

  it('an item with no title yet falls back to the first message', async () => {
    planner.items = [{ id: 'i1', type: 'task', title: '  ' }];
    const id = await store().resolveItemThread('i1');
    await store().send(id, 'what should this be?');
    await conversationsSettled();
    expect(api.turns[0].body.create).toEqual({ itemId: 'i1', title: 'what should this be?' });
  });
});

describe('the answers to a save', () => {
  it('409: rebinds the draft to the item\'s conversation and retries once, without create', async () => {
    planner.items = [{ id: 'i1', type: 'task', title: 'Book the dentist' }];
    api.rows.set('real', summary({ id: 'real', itemId: 'i1', messageCount: 4 }));
    api.answer.appendTurn = (_id, _b, n) => (n === 1 ? fail(409, 'conflict', 'real') : undefined);

    const draft = await store().resolveItemThread('i1');
    useRailStore.getState().push('desktop', { kind: 'conversation', id: draft });
    await store().send(draft, 'hi');
    await conversationsSettled();

    expect(api.turns.map((t) => [t.id, t.body.create?.itemId ?? null])).toEqual([
      [draft, 'i1'],
      ['real', null],
    ]);
    expect(resolveConversationId(draft)).toBe('real');
    expect(store().threads[draft]).toBeUndefined();
    expect(syncs('real')).toEqual(['saved', 'saved']);
    expect(store().itemIndex.i1).toBe('real');
    expect(useRailStore.getState().stacks.desktop).toEqual([{ kind: 'conversation', id: 'real' }]);
  });

  it('409 with a failed retry: the turn waits under the new id, and the next send goes there', async () => {
    api.rows.set('real', summary({ id: 'real', itemId: 'i1', messageCount: 4 }));
    api.answer.appendTurn = (_id, _b, n) => (n === 1 ? fail(409, 'conflict', 'real') : n === 2 ? fail(500, 'server') : undefined);

    const draft = await store().resolveItemThread('i1');
    await store().send(draft, 'one');
    await conversationsSettled();
    expect(syncs('real')).toEqual(['pending', 'pending']);

    await store().send(draft, 'two');
    await conversationsSettled();
    expect(tx.inputs[1].conversationId).toBe('real');
    expect(api.turns.map((t) => t.id)).toEqual([draft, 'real', 'real', 'real']);
    // The queued turn lands before the new one, and neither creates.
    expect(api.turns[2].body.messages[0].content).toBe('one');
    expect(api.turns[3].body.messages[0].content).toBe('two');
    expect(api.turns.slice(1).every((t) => t.body.create === undefined)).toBe(true);
    expect(syncs('real')).toEqual(['saved', 'saved', 'saved', 'saved']);
  });

  it('404 on a general conversation: gone, and no further send', async () => {
    const id = await sendNew('one');
    api.rows.delete(id);
    await store().send(id, 'two');
    await conversationsSettled();

    expect(thread(id).load).toBe('gone');
    expect(store().summaries[id]).toBeUndefined();
    expect(store().list.ids).toEqual([]);
    expect(syncs(id)).toEqual(['saved', 'saved', 'unsaved', 'unsaved']);

    await store().send(id, 'three');
    expect(tx.inputs).toHaveLength(2);
  });

  it("404 on an item conversation: the item has none, and its next send creates a fresh one", async () => {
    const first = await store().resolveItemThread('i1');
    await store().send(first, 'one');
    await conversationsSettled();
    api.rows.delete(first);
    await store().send(first, 'two');
    await conversationsSettled();

    expect(store().itemIndex.i1).toBeNull();
    expect(thread(first).load).toBe('gone');

    const next = await store().resolveItemThread('i1');
    expect(next).not.toBe(first);
    await store().send(next, 'three');
    await conversationsSettled();
    expect(api.turns.at(-1)).toMatchObject({ id: next, body: { create: { itemId: 'i1' } } });
  });

  it('delete, then a send from the item, creates', async () => {
    const first = await store().resolveItemThread('i1');
    await store().send(first, 'one');
    await conversationsSettled();
    useRailStore.getState().push('phone', { kind: 'conversation', id: first });

    expect(await store().remove(first)).toBe(true);
    expect(api.removes).toEqual([first]);
    expect(store().itemIndex.i1).toBeNull();
    expect(store().threads[first]).toBeUndefined();
    expect(useRailStore.getState().stacks.phone).toEqual([]);

    const next = await store().resolveItemThread('i1');
    await store().send(next, 'two');
    await conversationsSettled();
    expect(next).not.toBe(first);
    expect(api.turns.at(-1)).toMatchObject({ id: next, body: { create: { itemId: 'i1' } } });
  });

  it.each([
    [400, 'invalid'],
    [413, 'too_large'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
  ])('%i: "Not saved", never retried', async (status, error) => {
    api.answer.appendTurn = (_id, _b, n) => (n === 1 ? fail(status, error) : undefined);
    const id = await sendNew('one');
    expect(syncs(id)).toEqual(['unsaved', 'unsaved']);
    await online();
    expect(api.turns).toHaveLength(1);
  });

  it.each([
    [429, 'busy'],
    [500, 'server'],
    [0, 'network'],
  ])('%i: queued, and saved with the same ids when the network comes back', async (status, error) => {
    api.answer.appendTurn = (_id, _b, n) => (n === 1 ? fail(status, error) : undefined);
    const id = await sendNew('one');
    expect(syncs(id)).toEqual(['pending', 'pending']);
    await online();
    expect(api.turns).toHaveLength(2);
    expect(api.turns[1].body.messages.map((m) => m.id)).toEqual(api.turns[0].body.messages.map((m) => m.id));
    expect(syncs(id)).toEqual(['saved', 'saved']);
  });

  it("a bare 503 (the platform's, not the routes') is a 5xx: queued, and saving stays on", async () => {
    api.answer.appendTurn = (_id, _b, n) => (n === 1 ? fail(503, 'server') : undefined);
    const id = await sendNew('one');
    expect(store().saving).not.toBe('off');
    expect(syncs(id)).toEqual(['pending', 'pending']);
    await online();
    expect(syncs(id)).toEqual(['saved', 'saved']);
  });

  it('gives up after three tries: "Not saved"', async () => {
    api.answer.appendTurn = () => fail(500, 'server');
    const id = await sendNew('one');
    await online();
    expect(syncs(id)).toEqual(['pending', 'pending']);
    await online();
    expect(syncs(id)).toEqual(['unsaved', 'unsaved']);
    await online();
    expect(api.turns).toHaveLength(3);
  });

  it('503: saving is latched off for the session; chat still answers, unsaved', async () => {
    api.answer.appendTurn = () => fail(503, 'unavailable');
    const id = await sendNew('one');
    expect(store().saving).toBe('off');
    expect(syncs(id)).toEqual(['unsaved', 'unsaved']);

    await store().send(id, 'two');
    await conversationsSettled();
    expect(tx.inputs).toHaveLength(2);
    expect(api.turns).toHaveLength(1);
    expect(syncs(id)).toEqual(['unsaved', 'unsaved', 'unsaved', 'unsaved']);

    const listed = (api.api.list as ReturnType<typeof vi.fn>).mock.calls.length;
    await store().ensureLoaded();
    expect(api.api.list).toHaveBeenCalledTimes(listed);
    store().reset();
    expect(store().saving).toBe('off');
  });
});

describe('a conversation found deleted is never written to again', () => {
  // Every save to a gone conversation would carry `create` (it has no row), and
  // the turns route would make a new row under the old id: the user's Delete,
  // made on another device, silently undone.
  const created = () => api.turns.filter((t) => t.body.create).map((t) => t.id);

  it('a turn that finishes after the save that found it gone', async () => {
    const id = await sendNew('one');
    api.rows.delete(id); // deleted on another device
    const held = deferred<void>();
    api.answer.appendTurn = async (_id, _b, n) => {
      if (n === 2) await held.promise;
      return undefined;
    };
    await store().send(id, 'two');
    await flush();
    const h = hangs('three!');
    tx.next = h.run;
    const sending = store().send(id, 'three');
    await flush(1);
    held.resolve(); // turn two's save: 404
    await flush();
    expect(thread(id).load).toBe('gone');

    h.release();
    await sending;
    await conversationsSettled();
    expect(api.turns).toHaveLength(2);
    expect(created()).toEqual([id]);
    expect(api.rows.has(id)).toBe(false);
    expect(syncs(id)).toEqual(['saved', 'saved', 'unsaved', 'unsaved', 'unsaved', 'unsaved']);
  });

  it('turns queued offline, then found gone when the network comes back', async () => {
    const id = await sendNew('one');
    api.answer.appendTurn = (_id, _b, n) => (n === 2 || n === 3 ? fail(0, 'network') : undefined);
    await store().send(id, 'two');
    await conversationsSettled();
    await store().send(id, 'three');
    await conversationsSettled();
    expect(syncs(id)).toEqual(['saved', 'saved', 'pending', 'pending', 'pending', 'pending']);

    api.rows.delete(id);
    await online();
    expect(api.turns).toHaveLength(4);
    expect(created()).toEqual([id]);
    expect(api.rows.has(id)).toBe(false);
    expect(syncs(id)).toEqual(['saved', 'saved', 'unsaved', 'unsaved', 'unsaved', 'unsaved']);
  });

  it('an open that finds it gone settles its waiting turns at once, and none is sent', async () => {
    const id = await sendNew('one');
    api.answer.appendTurn = (_id, _b, n) => (n === 2 ? fail(500, 'server') : undefined);
    await store().send(id, 'two');
    await conversationsSettled();
    expect(syncs(id)).toEqual(['saved', 'saved', 'pending', 'pending']);

    api.rows.delete(id);
    useConversationsStore.setState((s) => ({ threads: { ...s.threads, [id]: { ...s.threads[id], fetchedAt: 0 } } }));
    await store().openThread(id); // the thread GET answers 404
    expect(thread(id).load).toBe('gone');
    expect(syncs(id)).toEqual(['saved', 'saved', 'unsaved', 'unsaved']);

    await online();
    expect(api.turns).toHaveLength(2);
    expect(api.rows.has(id)).toBe(false);
  });

  it('pagehide sends nothing for it, not even a turn still streaming', async () => {
    const id = await sendNew('one');
    const h = hangs('partial');
    tx.next = h.run;
    const sending = store().send(id, 'two');
    await flush(1);
    useConversationsStore.setState((s) => ({ threads: { ...s.threads, [id]: { ...s.threads[id], load: 'gone', saved: false } } }));
    store().flushOnPageHide();
    expect(api.keepalives).toEqual([]);
    store().stop(id);
    await sending;
    await conversationsSettled();
    expect(api.turns).toHaveLength(1);
  });
});

describe('accounts and generations', () => {
  it('drops a queued save when the account switches, unsent', async () => {
    api.answer.appendTurn = (_id, _b, n) => (n === 1 ? fail(500, 'server') : undefined);
    await sendNew('one');
    expect(api.turns).toHaveLength(1);

    useAIConnectionStore.setState({ hydratedUserId: 'someone-else' });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    await conversationsSettled();

    expect(api.turns).toHaveLength(1);
    expect(store().threads).toEqual({});
    expect(store().ownerId).toBe('someone-else');
  });

  it('a sign-out mid-stream drops the turn: nothing saved, nothing kept', async () => {
    const h = hangs('Half');
    tx.next = h.run;
    const id = store().newDraft();
    const sending = store().send(id, 'hello');
    await flush(1);
    const generation = store().generation;
    clearChatState();
    await sending;
    await conversationsSettled();

    expect(store().generation).toBe(generation + 1);
    expect(store().threads).toEqual({});
    expect(api.turns).toHaveLength(0);
  });

  it('another account signing in mid-stream drops the turn too', async () => {
    const h = hangs('Half');
    tx.next = h.run;
    const id = store().newDraft();
    const sending = store().send(id, 'hello');
    await flush(1);
    useAIConnectionStore.setState({ hydratedUserId: 'someone-else' });
    h.release(' done');
    await sending;
    await conversationsSettled();
    expect(api.turns).toHaveLength(0);
  });

  it('an owner switch resets the cache and bumps the generation', async () => {
    const id = store().newDraft();
    const generation = store().generation;
    useAIConnectionStore.setState({ hydratedUserId: 'someone-else' });
    store().ensureOwner();
    expect(store().threads[id]).toBeUndefined();
    expect(store().generation).toBe(generation + 1);
    expect(store().ownerId).toBe('someone-else');
  });
});

describe('sending', () => {
  it('two sends in one tick make one transport call', async () => {
    const id = store().newDraft();
    await Promise.all([store().send(id, 'one'), store().send(id, 'two')]);
    expect(tx.inputs).toHaveLength(1);
    expect(roles(id)).toEqual(['user', 'assistant']);
  });

  it('a failing list read still lets a send stream and save', async () => {
    api.answer.list = () => fail(500, 'server');
    const id = await sendNew('one');
    expect(store().list.status).not.toBe('loaded');
    expect(tx.inputs).toHaveLength(1);
    expect(syncs(id)).toEqual(['saved', 'saved']);
  });

  it('beginSend marks a binding once', () => {
    expect(store().beginSend('item:i1')).toBe(true);
    expect(store().beginSend('item:i1')).toBe(false);
    store().endSend('item:i1');
    expect(store().sending).toEqual({});
  });

  it("tells OpenClaw what the model said, when it takes over a conversation", async () => {
    const id = 'c-mixed';
    useConversationsStore.setState({
      threads: {
        [id]: {
          id,
          itemId: null,
          draftTitle: null,
          saved: true,
          messages: [
            msg({ id: 'u1', role: 'user', content: 'Plan my week', pos: 1 }),
            msg({ id: 'a1', role: 'assistant', content: 'Monday: writing.', replyTo: 'u1', answerer: 'model', pos: 2 }),
          ],
          load: 'loaded',
          hasEarlier: false,
          streaming: false,
          typing: false,
          fetchedAt: Date.now(),
        },
      },
    });
    unseed();
    unseed = seedAI({ ...OPENCLAW_PLUGIN, openclaw: { gateway: true, agent: true } });
    await store().send(id, 'and Tuesday?');
    expect(tx.inputs[0].context).toBe(
      '## dsul Context\n\n## Earlier in this conversation\nUser: Plan my week\nAssistant: Monday: writing.'
    );
  });

  it('on the plugin path, recaps only once its session has likely lapsed', async () => {
    unseed();
    unseed = seedAI(OPENCLAW_PLUGIN);
    const seed = (age: number) =>
      useConversationsStore.setState({
        threads: {
          c: {
            id: 'c',
            itemId: null,
            draftTitle: null,
            saved: true,
            messages: [
              msg({ id: 'u1', role: 'user', content: 'q', createdAt: Date.now() - age }),
              msg({ id: 'a1', role: 'assistant', content: 'a', replyTo: 'u1', answerer: 'openclaw', createdAt: Date.now() - age }),
            ],
            load: 'loaded',
            hasEarlier: false,
            streaming: false,
            typing: false,
            fetchedAt: Date.now(),
          },
        },
      });
    seed(10 * 60_000);
    await store().send('c', 'fresh');
    expect(tx.inputs[0]).toMatchObject({ via: 'plugin', context: '## dsul Context' });

    await conversationsSettled();
    seed(51 * 60_000);
    await store().send('c', 'later');
    expect(tx.inputs[1].context).toContain('## Earlier in this conversation\nUser: q\nAssistant: a');
  });

  /**
   * The look-only preview paints cached rows while the load is still in
   * flight (lib/planner-snapshot.ts). A question answered against them is
   * answered against yesterday's planner, so the turn waits for the landing
   * and reads its context then. An outward call waits (this and a proposal
   * asked of a model), since it cannot be hidden the way a write is refused.
   */
  it('holds a send through the look-only preview, then asks with the fresh rows', async () => {
    planner.isPreview = true;
    const id = store().newDraft({ itemId: 'i1' });
    const sent = store().send(id, 'what is left today?');
    await flush();
    expect(tx.transport.streamTurn).not.toHaveBeenCalled();
    // The question is in the transcript already, its reply streaming: a slow answer.
    expect(roles(id)).toEqual(['user', 'assistant']);
    expect(thread(id).streaming).toBe(true);

    landPlanner([{ id: 'i1', type: 'task', title: 'Water the plants' }]);
    await sent;
    await conversationsSettled();
    expect(tx.inputs).toHaveLength(1);
    // Built after the landing: the item is only in the fresh rows.
    expect(contextArgs[0]?.focusItemId).toBe('i1');
    expect(thread(id).streaming).toBe(false);
    expect(roles(id)).toEqual(['user', 'assistant']);
  });

  it('a preview dropped mid-wait keeps the send waiting: nothing goes out on the emptied store', async () => {
    planner.isPreview = true;
    planner.items = [{ id: 'cached', type: 'task', title: 'Cached' }];
    const id = store().newDraft({ itemId: 'i1' });
    const sent = store().send(id, 'what is left today?');
    await flush();
    // PreviewCrashBoundary: a render threw on the cached rows, and the load is still in flight.
    dropPlannerPreview();
    await flush();
    expect(tx.transport.streamTurn).not.toHaveBeenCalled();
    expect(thread(id).streaming).toBe(true);

    landPlanner([{ id: 'i1', type: 'task', title: 'Water the plants' }]);
    await sent;
    await conversationsSettled();
    expect(tx.inputs).toHaveLength(1);
    expect(contextArgs).toHaveLength(1);
    expect(contextArgs[0]?.focusItemId).toBe('i1');
    expect(roles(id)).toEqual(['user', 'assistant']);
  });

  it('a Stop while the send waits for the landing sends nothing and keeps the question', async () => {
    planner.isPreview = true;
    const id = store().newDraft();
    const sent = store().send(id, 'plan my day');
    await flush();
    store().stop(id);
    landPlanner([]);
    await sent;
    await conversationsSettled();
    expect(tx.transport.streamTurn).not.toHaveBeenCalled();
    expect(roles(id)).toEqual(['user']);
    expect(thread(id).streaming).toBe(false);
  });

  it('a Stop while the send waits leaves OpenClaw unasked: the message never went', async () => {
    unseed();
    unseed = seedAI(OPENCLAW_PLUGIN);
    planner.isPreview = true;
    const id = store().newDraft();
    const sent = store().send(id, 'take this on');
    await flush();
    store().stop(id);
    landPlanner([]);
    await sent;
    await conversationsSettled();
    expect(openclawWasAsked(id)).toBe(false);
  });
});

describe('History', () => {
  it('ensureLoaded is single-flight, and loads once', async () => {
    const d = deferred<ReturnType<typeof fail> | { ok: true; value: { conversations: never[]; nextCursor: null } }>();
    api.answer.list = () => d.promise as never;
    const a = store().ensureLoaded();
    const b = store().ensureLoaded();
    expect(store().list.status).toBe('loading');
    d.resolve({ ok: true, value: { conversations: [], nextCursor: null } });
    await Promise.all([a, b]);
    await store().ensureLoaded();
    expect(api.api.list).toHaveBeenCalledTimes(1);
    expect(store().list.status).toBe('loaded');
  });

  it('carries every starred row on the first page, and pages the rest', async () => {
    api.answer.list = (o) =>
      o?.cursor
        ? { ok: true, value: { conversations: [summary({ id: 'c3', lastMessageAt: '2026-10-01T00:00:00.000Z' })], nextCursor: null } }
        : {
            ok: true,
            value: {
              conversations: [summary({ id: 'c1' }), summary({ id: 'c2' })],
              starred: [summary({ id: 's1', starred: true })],
              nextCursor: 'next',
            },
          };
    await store().ensureLoaded();
    expect(store().list).toMatchObject({ ids: ['c1', 'c2'], starredIds: ['s1'], cursor: 'next' });
    await store().loadMore();
    expect(store().list).toMatchObject({ ids: ['c1', 'c2', 'c3'], cursor: null, status: 'loaded' });
  });

  it('openThread merges by message id and does not refetch a fresh thread', async () => {
    api.answer.thread = (id) => ({
      ok: true,
      value: {
        conversation: summary({ id, messageCount: 2 }),
        messages: [
          { id: 'u1', pos: 1, role: 'user', content: 'q', status: 'complete', errorCode: null, replyTo: null, answerer: null, model: null, createdAt: '2026-10-02T09:00:00.000Z' },
          { id: 'a1', pos: 2, role: 'assistant', content: 'a', status: 'complete', errorCode: null, replyTo: 'u1', answerer: 'model', model: 'gpt-4o-mini', createdAt: '2026-10-02T09:00:01.000Z' },
        ],
        hasEarlier: false,
      },
    });
    await store().openThread('c1');
    await store().openThread('c1');
    expect(api.api.thread).toHaveBeenCalledTimes(1);
    expect(thread('c1')).toMatchObject({ saved: true, load: 'loaded' });
    expect(thread('c1').messages.map((m) => [m.id, m.pos, m.sync])).toEqual([
      ['u1', 1, 'saved'],
      ['a1', 2, 'saved'],
    ]);
  });

  it('a send while the open is on its way: the saved turns still arrive, above it', async () => {
    api.rows.set('c1', summary({ id: 'c1', messageCount: 2 }));
    useConversationsStore.setState({ summaries: { c1: summary({ id: 'c1', messageCount: 2 }) } });
    const read = deferred<void>();
    api.answer.thread = async (id) => {
      await read.promise;
      return {
        ok: true,
        value: {
          conversation: summary({ id, messageCount: 2 }),
          messages: [stored('u0', 1, 'user', 'earlier q'), stored('a0', 2, 'assistant', 'earlier a', 'u0')],
          hasEarlier: false,
        },
      };
    };
    const opening = store().openThread('c1');
    const h = hangs('par');
    tx.next = h.run;
    const sending = store().send('c1', 'new question');
    await flush(1);
    read.resolve();
    await opening;
    expect(thread('c1').messages.map((m) => m.content)).toEqual(['earlier q', 'earlier a', 'new question', 'par']);

    h.release('t two');
    await sending;
    await conversationsSettled();
    expect(thread('c1').messages.map((m) => [m.content, m.pos])).toEqual([
      ['earlier q', 1],
      ['earlier a', 2],
      ['new question', 3],
      ['part two', 4],
    ]);
  });

  it('a conversation saved while a list page is on its way keeps its place', async () => {
    const page = deferred<void>();
    api.answer.list = async () => {
      await page.promise;
      return {
        ok: true,
        value: { conversations: [summary({ id: 'older', lastMessageAt: '2026-10-01T09:00:00.000Z' })], starred: [], nextCursor: null },
      };
    };
    const id = store().newDraft();
    await store().send(id, 'hello'); // warms History: the list GET goes out
    await flush();
    expect(store().list).toMatchObject({ status: 'loading', ids: [id] });

    page.resolve();
    await flush();
    expect(store().list).toMatchObject({ status: 'loaded', ids: [id, 'older'] });
    expect(store().summaries[id]).toMatchObject({ messageCount: 2 });
  });

  it('a star given while a list page is on its way survives the page', async () => {
    const id = await sendNew('one');
    const page = deferred<void>();
    api.answer.list = async () => {
      await page.promise;
      return { ok: true, value: { conversations: [summary({ id, messageCount: 2 })], starred: [], nextCursor: null } };
    };
    store().refreshIfStale(0);
    expect(await store().setStarred(id, true)).toBe(true);

    page.resolve();
    await flush();
    expect(store().list).toMatchObject({ status: 'loaded', ids: [], starredIds: [id] });
    expect(store().summaries[id].starred).toBe(true);
  });

  it('openThread on a deleted conversation marks it gone', async () => {
    useConversationsStore.setState({ summaries: { c1: summary({ id: 'c1', itemId: 'i1' }) }, itemIndex: { i1: 'c1' } });
    await store().openThread('c1');
    expect(thread('c1').load).toBe('gone');
    expect(store().itemIndex.i1).toBeNull();
  });

  it("a conversation found gone by a save carries the reply half-typed under it to Ask home's box", async () => {
    const id = await sendNew('one');
    useRailStore.getState().setDraft(`conv:${id}`, 'and another thing');
    api.answer.appendTurn = () => fail(404, 'not_found');
    await store().send(id, 'two');
    await conversationsSettled();
    expect(thread(id).load).toBe('gone');
    expect(useRailStore.getState().drafts).toEqual({ home: 'and another thing' });
  });

  it('a conversation found gone keeps the name it was shown under, and never saves it', async () => {
    // Opened from History: the summary held its only title, and goes.
    useConversationsStore.setState({ summaries: { c1: summary({ id: 'c1', title: 'Trip plans', renamed: true }) } });
    await store().openThread('c1');
    expect(store().summaries.c1).toBeUndefined();
    expect(thread('c1')).toMatchObject({ load: 'gone', saved: false, draftTitle: 'Trip plans' });
    await store().send('c1', 'still there?');
    await conversationsSettled();
    expect(api.turns).toEqual([]);
  });

  it('a delete that fails puts everything back', async () => {
    const id = await sendNew('one');
    api.answer.remove = () => fail(500, 'server');
    expect(await store().remove(id)).toBe(false);
    expect(thread(id)).toBeDefined();
    expect(store().summaries[id]).toBeDefined();
    expect(store().list.ids).toEqual([id]);
  });

  it('a delete after saving latched off still asks the server for a conversation this browser has seen', async () => {
    const row = summary({ id: 'c1', title: 'Biopsy results', messageCount: 2 });
    api.rows.set('c1', row);
    let unavailable = false;
    api.answer.list = () => (unavailable ? fail(503, 'unavailable') : { ok: true, value: { conversations: [row], starred: [], nextCursor: null } });
    await store().ensureLoaded();
    expect(store().saving).toBe('on');
    // A transient missing-schema answer on a later refresh latches the session off.
    unavailable = true;
    useConversationsStore.setState((s) => ({ list: { ...s.list, fetchedAt: 0 } }));
    store().refreshIfStale(0);
    await conversationsSettled();
    expect(store().saving).toBe('off');

    // The confirm said "removed from all your devices": it is asked for.
    expect(await store().remove('c1')).toBe(true);
    expect(api.removes).toEqual(['c1']);

    // And a DELETE the table still cannot answer says so, and puts it back.
    const row2 = summary({ id: 'c2' });
    useConversationsStore.setState((s) => ({ summaries: { ...s.summaries, c2: row2 } }));
    api.answer.remove = () => fail(503, 'unavailable');
    expect(await store().remove('c2')).toBe(false);
    expect(api.removes).toEqual(['c1', 'c2']);
    expect(store().summaries.c2).toEqual(row2);
  });

  it('with the table missing, a draft whose first save was refused asks the server nothing', async () => {
    api.answer.appendTurn = () => fail(503, 'unavailable');
    const id = await sendNew('one');
    expect(store().saving).toBe('off');
    expect(await store().remove(id)).toBe(true);
    expect(api.removes).toEqual([]);
    expect(store().threads[id]).toBeUndefined();
  });

  it('a delete while the first save is on the wire still asks the server, after the save', async () => {
    const held = deferred<void>();
    api.answer.appendTurn = async () => {
      await held.promise;
      return undefined;
    };
    const id = store().newDraft();
    await store().send(id, 'hello');
    await flush();
    expect(api.turns).toHaveLength(1);

    const removing = store().remove(id);
    await flush();
    // Behind the save: sent first, the save would re-create the row after it.
    expect(api.removes).toEqual([]);
    // And a pagehide now never re-sends the deleted conversation's save.
    store().flushOnPageHide();
    expect(api.keepalives).toEqual([]);

    held.resolve();
    expect(await removing).toBe(true);
    expect(api.removes).toEqual([id]);
    const savedAt = (api.api.appendTurn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const deletedAt = (api.api.remove as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(deletedAt).toBeGreaterThan(savedAt);
    expect(store().threads[id]).toBeUndefined();
    expect(store().summaries[id]).toBeUndefined();
    expect(store().list.ids).toEqual([]);
  });

  it('a draft no save was ever sent for asks the server nothing, even mid-stream', async () => {
    tx.next = hangs('par').run;
    const id = store().newDraft();
    const sending = store().send(id, 'hello');
    await flush(1);
    expect(await store().remove(id)).toBe(true);
    await sending;
    await conversationsSettled();
    expect(api.removes).toEqual([]);
    expect(api.turns).toEqual([]);
  });

  it('a delete that fails re-sends the save it stopped', async () => {
    const held = deferred<void>();
    api.answer.appendTurn = async (_id, _b, n) => {
      if (n === 1) await held.promise;
      return undefined;
    };
    api.answer.remove = () => fail(500, 'server');
    const id = store().newDraft();
    await store().send(id, 'hello');
    await flush();
    const removing = store().remove(id);
    held.resolve();
    expect(await removing).toBe(false);
    await conversationsSettled();

    expect(api.turns).toHaveLength(2);
    expect(api.turns[1].body.messages.map((m) => m.id)).toEqual(api.turns[0].body.messages.map((m) => m.id));
    expect(syncs(id)).toEqual(['saved', 'saved']);
    expect(store().list.ids).toEqual([id]);
  });

  it('a delete that fails mid-stream saves the cut-off turn as stopped', async () => {
    const id = await sendNew('one');
    tx.next = hangs('partial').run;
    const sending = store().send(id, 'second');
    await flush(1);
    const answer = deferred<ReturnType<typeof fail>>();
    api.answer.remove = () => answer.promise;
    const removing = store().remove(id);
    await sending; // the abort ended the stream while the DELETE was out
    answer.resolve(fail(500, 'server'));
    expect(await removing).toBe(false);
    await conversationsSettled();

    expect(api.turns).toHaveLength(2);
    expect(api.turns[1].body.messages).toMatchObject([
      { role: 'user', content: 'second' },
      { role: 'assistant', status: 'stopped', content: 'partial' },
    ]);
    expect(thread(id).streaming).toBe(false);
    expect(thread(id).messages.map((m) => m.status)).toEqual(['complete', 'complete', 'complete', 'stopped']);
    expect(syncs(id)).toEqual(['saved', 'saved', 'saved', 'saved']);
  });

  it('a stream the abort has not ended when the DELETE fails finishes, and saves, on its own', async () => {
    const id = await sendNew('one');
    const ended = deferred<void>();
    tx.next = (input) =>
      new Promise((resolve) => {
        input.onDelta('partial');
        input.signal.addEventListener('abort', () => {
          void ended.promise.then(() => resolve({ content: 'partial', status: 'stopped', errorCode: null, model: 'gpt-4o-mini' }));
        });
      });
    const sending = store().send(id, 'second');
    await flush(1);
    api.answer.remove = () => fail(500, 'server');
    expect(await store().remove(id)).toBe(false);
    expect(api.turns).toHaveLength(1);

    ended.resolve();
    await sending;
    await conversationsSettled();
    expect(api.turns).toHaveLength(2);
    expect(api.turns[1].body.messages[1]).toMatchObject({ status: 'stopped', content: 'partial' });
    expect(thread(id).streaming).toBe(false);
    expect(syncs(id)).toEqual(['saved', 'saved', 'saved', 'saved']);
  });

  it("takes a deleted conversation's search result with it, and puts it back where it was if the delete fails", async () => {
    const id = await sendNew('biopsy results');
    const hit = (cid: string) => ({ ...summary({ id: cid }), matched: 'message' as const, snippet: '…biopsy…', itemTitle: null });
    api.answer.search = () => ({ ok: true, value: [hit('c0'), hit(id), hit('c2')] });
    store().runSearch('biopsy');
    await flush();
    expect(store().search.hits.map((h) => h.id)).toEqual(['c0', id, 'c2']);

    const answer = deferred<ReturnType<typeof fail>>();
    api.answer.remove = () => answer.promise;
    const removing = store().remove(id);
    // Gone from the results at once, as from the list.
    expect(store().search.hits.map((h) => h.id)).toEqual(['c0', 'c2']);
    answer.resolve(fail(500, 'server'));
    expect(await removing).toBe(false);
    expect(store().search.hits.map((h) => h.id)).toEqual(['c0', id, 'c2']);

    api.answer.remove = () => undefined;
    expect(await store().remove(id)).toBe(true);
    expect(store().search).toMatchObject({ q: 'biopsy', status: 'done' });
    expect(store().search.hits.map((h) => h.id)).toEqual(['c0', 'c2']);
  });

  it("drops the search result of a conversation found deleted elsewhere", async () => {
    useConversationsStore.setState({ summaries: { c1: summary({ id: 'c1', title: 'Trip plans' }) } });
    api.answer.search = () => ({ ok: true, value: [{ ...summary({ id: 'c1', title: 'Trip plans' }), matched: 'title', snippet: null, itemTitle: null }] });
    store().runSearch('trip');
    await flush();
    expect(store().search.hits.map((h) => h.id)).toEqual(['c1']);
    await store().openThread('c1');
    expect(thread('c1').load).toBe('gone');
    expect(store().search.hits).toEqual([]);
  });

  it('rename and star are optimistic, and undone on failure', async () => {
    const id = await sendNew('one');
    expect(await store().rename(id, 'Dentist plans')).toBe(true);
    expect(store().summaries[id]).toMatchObject({ title: 'Dentist plans', renamed: true });

    expect(await store().setStarred(id, true)).toBe(true);
    expect(store().list).toMatchObject({ ids: [], starredIds: [id] });

    api.answer.patch = () => fail(500, 'server');
    expect(await store().setStarred(id, false)).toBe(false);
    expect(store().summaries[id].starred).toBe(true);
    expect(store().list.starredIds).toEqual([id]);
  });

  it('search clears under two characters and keeps only the newest query', async () => {
    store().runSearch('a');
    expect(store().search).toEqual({ q: 'a', status: 'idle', hits: [] });
    expect(api.api.search).not.toHaveBeenCalled();

    const slow = deferred<{ ok: true; value: never[] }>();
    api.answer.search = (q) => (q === 'den' ? (slow.promise as never) : { ok: true, value: [{ ...summary({ id: 'c9' }), matched: 'title', snippet: null, itemTitle: null }] });
    store().runSearch('den');
    store().runSearch('dentist');
    await flush();
    slow.resolve({ ok: true, value: [] });
    await flush();
    expect(store().search).toMatchObject({ q: 'dentist', status: 'done' });
    expect(store().search.hits.map((h) => h.id)).toEqual(['c9']);
  });
});

describe("History's list, read again over time", () => {
  /** Newest first, an hour apart: c0 at 10:00, c1 at 09:00, and so on down. */
  const at = (h: number) => `2026-10-02T${String(h).padStart(2, '0')}:00:00.000Z`;
  const row = (id: string, h: number, over: Partial<ReturnType<typeof summary>> = {}) => summary({ id, lastMessageAt: at(h), ...over });

  /** The first page, then one later page loaded under it. */
  async function twoPagesLoaded() {
    api.answer.list = (o) =>
      o?.cursor === 'p2'
        ? { ok: true, value: { conversations: [row('c3', 7), row('c4', 6)], nextCursor: null } }
        : { ok: true, value: { conversations: [row('c1', 9), row('c2', 8)], starred: [], nextCursor: 'p2' } };
    await store().ensureLoaded();
    await store().loadMore();
    expect(store().list).toMatchObject({ ids: ['c1', 'c2', 'c3', 'c4'], cursor: null });
  }

  it('a quiet refresh keeps the pages loaded below the first, and their cursor', async () => {
    await twoPagesLoaded();
    // Something new elsewhere: the first page now ends a row earlier.
    api.answer.list = () => ({ ok: true, value: { conversations: [row('c0', 10), row('c1', 9)], starred: [], nextCursor: 'q2' } });
    store().refreshIfStale(0);
    await conversationsSettled();
    expect(store().list).toMatchObject({ ids: ['c0', 'c1', 'c2', 'c3', 'c4'], cursor: null, status: 'loaded' });
  });

  it("drops a row inside the page's range the page no longer holds (deleted elsewhere)", async () => {
    await twoPagesLoaded();
    api.answer.list = () => ({ ok: true, value: { conversations: [row('c0', 10), row('c2', 8)], starred: [], nextCursor: 'q2' } });
    store().refreshIfStale(0);
    await conversationsSettled();
    expect(store().list.ids).toEqual(['c0', 'c2', 'c3', 'c4']);
  });

  it('a first page that is the whole list is taken whole', async () => {
    await twoPagesLoaded();
    api.answer.list = () => ({ ok: true, value: { conversations: [row('c1', 9)], starred: [], nextCursor: null } });
    store().refreshIfStale(0);
    await conversationsSettled();
    expect(store().list).toMatchObject({ ids: ['c1'], cursor: null });
  });

  it('a later page on its way holds off any re-read of the first, which would move its boundary', async () => {
    api.answer.list = () => ({ ok: true, value: { conversations: [row('c1', 9), row('c2', 8)], starred: [], nextCursor: 'p2' } });
    await store().ensureLoaded();
    const page = deferred<void>();
    api.answer.list = async (o) => {
      if (o?.cursor !== 'p2') return { ok: true, value: { conversations: [row('c0', 10), row('c1', 9)], starred: [], nextCursor: 'q2' } };
      await page.promise;
      return { ok: true, value: { conversations: [row('c3', 7)], nextCursor: null } };
    };
    const more = store().loadMore();
    try {
      store().refreshIfStale(0);
      void store().ensureLoaded();
      expect(store().loadMore()).toBe(more);
      expect(api.api.list).toHaveBeenCalledTimes(2);
    } finally {
      page.resolve();
    }
    await more;
    expect(store().list).toMatchObject({ ids: ['c1', 'c2', 'c3'], cursor: null, status: 'loaded' });
    // Landed: the refresh may go now.
    store().refreshIfStale(0);
    await conversationsSettled();
    expect(api.api.list).toHaveBeenCalledTimes(3);
  });

  it('a later page cut under a cursor that has since moved is dropped, not appended', async () => {
    api.answer.list = () => ({ ok: true, value: { conversations: [row('c1', 9), row('c2', 8)], starred: [], nextCursor: 'p2' } });
    await store().ensureLoaded();
    const page = deferred<void>();
    api.answer.list = async () => {
      await page.promise;
      return { ok: true, value: { conversations: [row('c5', 4)], nextCursor: null } };
    };
    const more = store().loadMore();
    useConversationsStore.setState((s) => ({ list: { ...s.list, cursor: 'elsewhere' } }));
    page.resolve();
    await more;
    expect(store().list).toMatchObject({ ids: ['c1', 'c2'], cursor: 'elsewhere', status: 'loaded' });
    expect(store().summaries.c5).toBeUndefined();
  });

  it("a later page writes only the rows it adds, and never over this browser's newer copy", async () => {
    api.answer.list = () => ({ ok: true, value: { conversations: [row('c1', 9), row('c2', 8)], starred: [], nextCursor: 'p2' } });
    await store().ensureLoaded();
    // Known outside the list (a search hit), and saved here since: 12:00.
    useConversationsStore.setState((s) => ({ summaries: { ...s.summaries, c3: row('c3', 12, { messageCount: 6 }) } }));
    const page = deferred<void>();
    api.answer.list = async () => {
      await page.promise;
      return {
        ok: true,
        value: {
          conversations: [row('c2', 8, { title: 'stale' }), row('c3', 7, { messageCount: 2 }), row('c4', 6, { title: 'server' })],
          nextCursor: null,
        },
      };
    };
    const more = store().loadMore();
    // Renamed while the page was on its way.
    useConversationsStore.setState((s) => ({ summaries: { ...s.summaries, c4: row('c4', 6, { title: 'before' }) } }));
    expect(await store().rename('c4', 'mine')).toBe(true);
    page.resolve();
    await more;
    expect(store().summaries.c3).toMatchObject({ lastMessageAt: at(12), messageCount: 6 });
    expect(store().summaries.c4.title).toBe('mine');
    // c2 was already listed (placed by a newer read): left as it was.
    expect(store().summaries.c2.title).not.toBe('stale');
    // The newer copy goes where it belongs, newest first.
    expect(store().list.ids).toEqual(['c3', 'c1', 'c2', 'c4']);
  });

  it("rename and star take only what their PATCH changed, onto the copy held now", async () => {
    useConversationsStore.setState({ summaries: { c1: row('c1', 9, { messageCount: 4, title: 'Old' }) } });
    // The PATCH's row was read before a save landed here: 2 messages, 08:00.
    api.answer.patch = (_id, patch) => ({
      ok: true,
      value: row('c1', 8, { messageCount: 2, title: patch.title ?? 'Old', renamed: !!patch.title, starred: !!patch.starred }),
    });
    expect(await store().rename('c1', 'New')).toBe(true);
    expect(store().summaries.c1).toMatchObject({ title: 'New', renamed: true, messageCount: 4, lastMessageAt: at(9) });
    expect(await store().setStarred('c1', true)).toBe(true);
    expect(store().summaries.c1).toMatchObject({ title: 'New', starred: true, messageCount: 4, lastMessageAt: at(9) });
  });

  it('an open moves a conversation continued elsewhere up the list, and keeps a newer copy held here', async () => {
    useConversationsStore.setState({
      summaries: { c1: row('c1', 9), c2: row('c2', 8), c3: row('c3', 12) },
      list: { ids: ['c1', 'c2', 'c3'], starredIds: [], cursor: null, status: 'loaded', fetchedAt: Date.now() },
    });
    api.answer.thread = (id) => ({
      ok: true,
      value: { conversation: id === 'c2' ? row('c2', 11) : row('c3', 7), messages: [], hasEarlier: false },
    });
    await store().openThread('c2');
    expect(store().summaries.c2.lastMessageAt).toBe(at(11));
    expect(store().list.ids.indexOf('c2')).toBeLessThan(store().list.ids.indexOf('c1'));
    // The read began before a save here: the save's copy stands.
    await store().openThread('c3');
    expect(store().summaries.c3.lastMessageAt).toBe(at(12));
  });

  it('a refresh that fails keeps a conversation saved while it was out', async () => {
    api.answer.list = () => ({ ok: true, value: { conversations: [row('c1', 9)], starred: [], nextCursor: null } });
    await store().ensureLoaded();
    const page = deferred<void>();
    api.answer.list = async () => {
      await page.promise;
      return fail(500, 'server');
    };
    store().refreshIfStale(0);
    const id = store().newDraft();
    await store().send(id, 'hello');
    await flush();
    expect(store().list.ids).toContain(id);

    page.resolve();
    await conversationsSettled();
    expect(store().list.status).toBe('loaded');
    expect([...store().list.ids].sort()).toEqual([id, 'c1'].sort());
  });
});

describe('noteChanges', () => {
  it('before the first save lands: folded, and sent after it', async () => {
    const save = deferred<void>();
    api.answer.appendTurn = async () => {
      await save.promise;
      return undefined;
    };
    const id = store().newDraft();
    await store().send(id, 'plan it');
    store().noteChanges(id, { added: 0, steps: 0, moved: 2, changed: 0 });
    await flush();
    expect(api.patches).toHaveLength(0);

    save.resolve();
    await flush();
    await conversationsSettled();
    expect(api.patches).toEqual([{ id, patch: { addChanges: { added: 0, steps: 0, moved: 2, changed: 0 } } }]);
    const turnAt = (api.api.appendTurn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const patchAt = (api.api.patch as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(patchAt).toBeGreaterThan(turnAt);
    expect(store().summaries[id].changes.moved).toBe(2);
  });

  it('is skipped for a conversation this browser does not know', async () => {
    store().noteChanges('unknown', { added: 1, steps: 0, moved: 0, changed: 0 });
    await conversationsSettled();
    expect(api.patches).toHaveLength(0);
  });

  it('is one PATCH per proposal, never re-sent, and a 404 never means gone', async () => {
    const id = await sendNew('one');
    api.answer.patch = () => fail(404, 'not_found');
    store().noteChanges(id, { added: 1, steps: 0, moved: 0, changed: 0 });
    await conversationsSettled();
    await online();
    expect(api.patches).toHaveLength(1);
    expect(thread(id).load).not.toBe('gone');
    expect(store().summaries[id]).toBeDefined();
  });
});

describe('pagehide', () => {
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

  it('fits every keepalive body in one 60,000-byte budget, cut on a whole character', async () => {
    // A conversation whose save waits in the queue, its reply ~35KB.
    api.answer.appendTurn = (_id, _b, n) => (n === 1 ? fail(500, 'server') : undefined);
    tx.next = () => ({ content: '漢😀'.repeat(5_000), status: 'complete', errorCode: null, model: 'gpt-4o-mini' });
    const queued = await sendNew('queued one');
    expect(syncs(queued)).toEqual(['pending', 'pending']);

    // A second, still streaming, far over the budget on its own.
    const huge = '漢字😀'.repeat(20_000);
    const h = hangs(huge);
    tx.next = h.run;
    const streaming = store().newDraft();
    const sending = store().send(streaming, 'a long answer please');
    await flush(1);

    store().flushOnPageHide();

    expect(api.keepalives.length).toBeGreaterThan(0);
    const total = api.keepalives.reduce((n, k) => n + bytes(k.body), 0);
    // The numbers themselves, not the module's constant: the Fetch spec caps
    // a page's in-flight keepalive bodies at 64 KiB in all, and past it every
    // pagehide save fails. A raised budget must turn this red.
    expect(KEEPALIVE_BUDGET_BYTES).toBeLessThanOrEqual(64 * 1024);
    expect(total).toBeLessThanOrEqual(60_000);
    // The streaming turn has the budget first: as stopped, clipped from the end.
    const first = api.keepalives.find((k) => k.id === streaming);
    expect(first).toBeDefined();
    const body = JSON.parse(first!.body) as TurnRequest;
    expect(body.create).toEqual({ itemId: null, title: 'a long answer please' });
    const reply = body.messages[1]!;
    expect(reply).toMatchObject({ role: 'assistant', status: 'stopped' });
    expect(reply.content.length).toBeGreaterThan(0);
    expect(huge.startsWith(reply.content)).toBe(true);
    for (const k of api.keepalives) expect(LONE.test(k.body)).toBe(false);

    store().stop(streaming);
    await sending;
  });

  it("creates an item's conversation still streaming its first turn under the item's title, not the question", async () => {
    planner.items = [{ id: 'i1', type: 'task', title: 'Book the dentist' }];
    const h = hangs('Try the clinic on');
    tx.next = h.run;
    const id = store().newDraft({ itemId: 'i1' });
    const sending = store().send(id, 'when are they open?');
    await flush(1);

    store().flushOnPageHide();
    expect(api.keepalives.map((k) => k.id)).toEqual([id]);
    const body = JSON.parse(api.keepalives[0].body) as TurnRequest;
    expect(body.create).toEqual({ itemId: 'i1', title: 'Book the dentist' });
    expect(body.messages[1]).toMatchObject({ role: 'assistant', status: 'stopped', content: 'Try the clinic on' });

    store().stop(id);
    await sending;
  });

  it('re-sends a save still on the wire, once, with the same message ids', async () => {
    const save = deferred<void>();
    api.answer.appendTurn = async () => {
      await save.promise;
      return undefined;
    };
    const id = store().newDraft();
    await store().send(id, 'hello');
    await flush();
    expect(api.turns).toHaveLength(1);

    store().flushOnPageHide();

    expect(api.keepalives).toHaveLength(1);
    expect(api.keepalives[0].id).toBe(id);
    const ids = (JSON.parse(api.keepalives[0].body) as TurnRequest).messages.map((m) => m.id);
    expect(ids).toEqual(api.turns[0].body.messages.map((m) => m.id));
    save.resolve();
  });

  const contents = () => api.keepalives.map((k) => (JSON.parse(k.body) as TurnRequest).messages[0].content);

  it('sends a turn waiting on the chain behind a save still on the wire', async () => {
    const held = deferred<void>();
    api.answer.appendTurn = async (_id, _b, n) => {
      if (n === 1) await held.promise;
      return undefined;
    };
    const id = store().newDraft();
    await store().send(id, 'turn one');
    await store().send(id, 'turn two');
    await flush();
    expect(api.turns).toHaveLength(1);

    store().flushOnPageHide();
    expect(contents()).toEqual(['turn one', 'turn two']);
    const sent = api.keepalives.flatMap((k) => (JSON.parse(k.body) as TurnRequest).messages.map((m) => m.id));
    expect(sent).toEqual(thread(id).messages.map((m) => m.id));
    held.resolve();
  });

  it('sends every turn a retry moved onto the chain, not only the first', async () => {
    const held = deferred<void>();
    api.answer.appendTurn = async (_id, _b, n) => {
      if (n <= 2) return fail(0, 'network');
      if (n === 3) await held.promise;
      return undefined;
    };
    const id = store().newDraft();
    await store().send(id, 'turn one');
    await conversationsSettled();
    await store().send(id, 'turn two');
    await conversationsSettled();
    expect(syncs(id)).toEqual(['pending', 'pending', 'pending', 'pending']);

    window.dispatchEvent(new Event('online'));
    await flush();
    expect(api.turns).toHaveLength(3);
    store().flushOnPageHide();
    expect(contents()).toEqual(['turn one', 'turn two']);
    held.resolve();
  });

  it("sends a conversation's turns in the order they were said, the streaming one last", async () => {
    // Positions are handed out as bodies arrive: the newer turn sent first
    // could take the earlier places and save the transcript backwards.
    api.answer.appendTurn = (_id, _b, n) => (n <= 2 ? fail(500, 'server') : undefined);
    const id = store().newDraft();
    await store().send(id, 'turn one');
    await conversationsSettled();
    const h = hangs('two!');
    tx.next = h.run;
    const sending = store().send(id, 'turn two');
    await flush();
    expect(syncs(id)?.slice(0, 2)).toEqual(['pending', 'pending']);

    store().flushOnPageHide();
    expect(api.keepalives.map((k) => k.id)).toEqual([id, id]);
    expect(contents()).toEqual(['turn one', 'turn two']);
    expect((JSON.parse(api.keepalives[1].body) as TurnRequest).messages[1]).toMatchObject({ status: 'stopped', content: 'two!' });
    store().stop(id);
    await sending;
  });

  it('is registered once, by the store: a bfcache hide sends nothing, a real one flushes', async () => {
    const save = deferred<void>();
    api.answer.appendTurn = async () => {
      await save.promise;
      return undefined;
    };
    const id = store().newDraft();
    await store().send(id, 'hello');
    await flush();
    const hide = (persisted: boolean) => {
      const e = new Event('pagehide') as Event & { persisted: boolean };
      Object.defineProperty(e, 'persisted', { value: persisted });
      window.dispatchEvent(e);
    };
    hide(true);
    expect(api.keepalives).toHaveLength(0);
    hide(false);
    expect(api.keepalives.map((k) => k.id)).toEqual([id]);
    save.resolve();
  });

  it('sends nothing for a signed-out cache or with saving off', () => {
    useConversationsStore.setState({ saving: 'off' });
    store().flushOnPageHide();
    expect(api.keepalives).toHaveLength(0);
    expect(api.keepaliveRemoves).toHaveLength(0);
  });

  it('sends a delete still waiting behind a save on the wire, as a keepalive DELETE, after the saves', async () => {
    const id = await sendNew('My biopsy came back positive');
    // The next turn's save reached the server; its answer is slow.
    const slow = deferred<void>();
    api.answer.appendTurn = async () => {
      await slow.promise;
      return undefined;
    };
    await store().send(id, 'and the oncologist said stage 2');
    await flush();
    expect(api.turns).toHaveLength(2);
    const removing = store().remove(id);
    await flush();
    // Behind the save, so not sent yet...
    expect(api.removes).toEqual([]);

    // ...and the tab closes: the DELETE goes anyway, with nothing re-sent for it.
    store().flushOnPageHide();
    expect(api.keepalives).toEqual([]);
    expect(api.keepaliveRemoves).toEqual([id]);

    slow.resolve();
    expect(await removing).toBe(true);
    // Answered: nothing left to send at a later hide.
    store().flushOnPageHide();
    expect(api.keepaliveRemoves).toEqual([id]);
  });

  it('sends a delete on the wire again, and only after every save body', async () => {
    const held = deferred<void>();
    api.answer.appendTurn = async (_id, _b, n) => {
      if (n === 2) await held.promise;
      return undefined;
    };
    const gone = await sendNew('delete me');
    const other = store().newDraft();
    await store().send(other, 'keep me');
    await flush();
    const order: string[] = [];
    (api.api.appendTurnKeepalive as ReturnType<typeof vi.fn>).mockImplementation((cid: string) => order.push(`save:${cid}`));
    (api.api.removeKeepalive as ReturnType<typeof vi.fn>).mockImplementation((cid: string) => order.push(`delete:${cid}`));
    const answer = deferred<ReturnType<typeof fail>>();
    api.answer.remove = () => answer.promise;
    const removing = store().remove(gone);
    await flush();
    expect(api.removes).toEqual([gone]);

    store().flushOnPageHide();
    expect(order).toEqual([`save:${other}`, `delete:${gone}`]);
    answer.resolve(fail(404, 'not_found'));
    held.resolve();
    expect(await removing).toBe(true);
  });

  it('sends a pending delete with saving off, for the row it was sent for', async () => {
    const row = summary({ id: 'c1' });
    useConversationsStore.setState({ saving: 'off', summaries: { c1: row } });
    const answer = deferred<ReturnType<typeof fail>>();
    api.answer.remove = () => answer.promise;
    const removing = store().remove('c1');
    await flush();
    expect(api.removes).toEqual(['c1']);
    store().flushOnPageHide();
    expect(api.keepalives).toEqual([]);
    expect(api.keepaliveRemoves).toEqual(['c1']);
    answer.resolve(fail(404, 'not_found'));
    expect(await removing).toBe(true);
  });
});

describe('OpenClaw was asked', () => {
  it('a message handed to OpenClaw and stopped before its one-piece reply still counts, with no reply saved', async () => {
    unseed();
    unseed = seedAI(OPENCLAW_PLUGIN);
    tx.next = hangs('').run;
    const id = store().newDraft();
    const sending = store().send(id, 'My biopsy came back positive');
    await flush();
    expect(tx.inputs[0]).toMatchObject({ target: 'openclaw', via: 'plugin' });
    store().stop(id);
    await sending;
    await conversationsSettled();
    // Only the question was saved, so the server's flag stays down...
    expect(api.turns.map((t) => t.body.messages.map((m) => m.role))).toEqual([['user']]);
    expect(store().summaries[id].openclawSeen).toBe(false);
    // ...but this browser knows OpenClaw has it.
    expect(openclawWasAsked(id)).toBe(true);
  });

  it('a model-only conversation was never asked of OpenClaw; a reset forgets', async () => {
    const id = await sendNew('hello');
    expect(openclawWasAsked(id)).toBe(false);
    noteOpenclawAsked(id);
    expect(openclawWasAsked(id)).toBe(true);
    clearChatState();
    expect(openclawWasAsked(id)).toBe(false);
  });

  it('follows a draft rebound to its item conversation', async () => {
    unseed();
    unseed = seedAI(OPENCLAW_PLUGIN);
    planner.items = [{ id: 'i1', type: 'task', title: 'Dentist' }];
    api.rows.set('c-existing', summary({ id: 'c-existing', itemId: 'i1' }));
    api.answer.appendTurn = (_id, body) => (body.create ? fail(409, 'conflict', 'c-existing') : undefined);
    const draft = store().newDraft({ itemId: 'i1' });
    await store().send(draft, 'hi');
    await conversationsSettled();
    expect(resolveConversationId(draft)).toBe('c-existing');
    expect(openclawWasAsked('c-existing')).toBe(true);
  });
});

describe('the transport input', () => {
  it('is the six things a turn needs, and nothing about storage', async () => {
    await sendNew('hello');
    const input = tx.inputs[0] as TurnInput;
    expect(Object.keys(input).sort()).toEqual(
      ['context', 'conversationId', 'message', 'onAction', 'onDelta', 'onProposal', 'signal', 'target', 'turns', 'typeNouns', 'via'].sort()
    );
    expect(input).toMatchObject({ target: 'model', via: 'chat', message: 'hello', typeNouns: ['errands'] });
  });
});
