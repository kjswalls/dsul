import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/**
 * lib/ask-pending.ts: the question kept from `?` while nothing answers.
 *
 *  - The record: per tab (sessionStorage, with a memory mirror for a browser
 *    that refuses the write), per account (the AI gate's `hydratedUserId`),
 *    capped as a send caps it, and gone from storage when it is malformed,
 *    claimed, or another account's.
 *  - The claimed list: a few random ids in localStorage, shared by every tab,
 *    so a question asked or cleared in one tab is never asked again by a copy
 *    of it in a duplicated tab.
 *  - The watcher: asks it once something answers, a macrotask after the
 *    connect, with the planner loaded for the same account; asks it only when
 *    the connection is the one the consent line named (and lately), and
 *    otherwise leaves it in Ask home's box, unsent. Claim, then act.
 *
 * What the setup page shows and its [Clear] are ask-setup.test.tsx's; the
 * consent line and its presses are connect-ai.test.tsx's.
 */

/** A context build that throws: send finishes before it returns. */
const context = vi.hoisted(() => ({ throws: false, titles: [] as string[][] }));
vi.mock('@/lib/ai-context', () => ({
  buildDsulContext: (o: { items: { title: string }[] }) => {
    // The titles each built context was made from (the look-only preview's case).
    context.titles.push(o.items.map((i) => i.title));
    if (context.throws) throw new RangeError('Invalid time zone specified: Mars/Olympus');
    return '## dsul Context';
  },
}));

import {
  ASK_CLAIMED_KEY,
  ASK_PENDING_KEY,
  CONSENT_TTL_MS,
  KEPT_MAX_CHARS,
  __resetKeptForTests,
  clearKept,
  clearKeptQuestionState,
  keepQuestion,
  markConsent,
  readKept,
  restoreKept,
  takeKept,
  useKeptQuestion,
  watchKeptQuestion,
  type KeptQuestion,
} from '@/lib/ask-pending';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { configureConversations, conversationsSettled, clearChatState, useConversationsStore } from '@/lib/conversations-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useRailStore } from '@/lib/rail-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useUIStore } from '@/lib/ui-store';
import { useViewStore } from '@/lib/view-store';
import type { ModelConnectionView } from '@/lib/ai-types';
import { NOTHING_CONNECTED, SEED_USER_ID, seedAI } from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, type FakeTransport } from './helpers/conversations-fakes';

const NOW = Date.parse('2026-10-07T18:00:00.000Z');
const QUESTION = 'what should I do first';

const MODEL: ModelConnectionView = {
  provider: 'gemini',
  model: 'gemini-flash-latest',
  baseUrl: null,
  authMethod: 'key',
  status: 'ok',
  problem: null,
  checkedAt: '2026-10-07T17:59:00.000Z',
  limitedUntil: null,
  modelLabel: null,
};

const rail = () => useRailStore.getState();
const sent = () => tx.inputs.map((i) => i.turns.at(-1)?.content);
const stored = () => sessionStorage.getItem(ASK_PENDING_KEY);
const claimed = (): string[] => JSON.parse(localStorage.getItem(ASK_CLAIMED_KEY) ?? '[]');

/** The connect that lights the gate: one store write, as `connect`'s own set() is. */
function connect(model: Partial<ModelConnectionView> = {}) {
  useAIConnectionStore.setState({ model: { ...MODEL, ...model } });
}

let tx: FakeTransport;
let unseed: () => void = () => {};
let stops: Array<() => void> = [];

function watch(o: { phone?: () => boolean } = {}) {
  const stop = watchKeptQuestion({ isPhone: o.phone ?? (() => false), now: () => Date.now() });
  stops.push(stop);
  return stop;
}

/** The watcher's macrotask, and the send it starts. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await conversationsSettled();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  tx = fakeTransport();
  configureConversations({ api: fakeApi().api, transport: tx.transport });
  clearChatState();
  unseed = seedAI(NOTHING_CONNECTED);
  usePlannerStore.setState({ userId: SEED_USER_ID, isLoading: false, error: null });
  useMobileNavStore.setState({ activeTab: 'today' });
  useSidebarStore.setState({ askOpen: false });
  useUIStore.setState({ activeDialog: null, displacedItemId: null });
  useViewStore.setState({ zenOpen: false });
});

afterEach(async () => {
  // First: a refusing storage spy would throw out of the stores' own clears below.
  vi.restoreAllMocks();
  for (const stop of stops) stop();
  stops = [];
  await conversationsSettled();
  unseed();
  unseed = () => {};
  clearKeptQuestionState();
  sessionStorage.clear();
  localStorage.removeItem(ASK_CLAIMED_KEY);
  __resetKeptForTests();
  usePlannerStore.setState({ userId: null, isLoading: false, isPreview: false, error: null, items: [] });
  context.throws = false;
  context.titles = [];
  vi.useRealTimers();
});

describe('the record', () => {
  it('keeps the question for the gate’s account, per tab, with a new id and no consent', () => {
    expect(keepQuestion(`  ${QUESTION}  `)).toBe(true);
    const q = readKept(SEED_USER_ID) as KeptQuestion;
    expect(q).toMatchObject({ text: QUESTION, at: NOW, uid: SEED_USER_ID, consent: null });
    expect(q.id).toEqual(expect.any(String));
    expect(JSON.parse(stored() as string)).toEqual(q);
    // Only sessionStorage holds it: never a cookie or the shared localStorage.
    expect(document.cookie).not.toContain(QUESTION);
    expect(JSON.stringify(localStorage)).not.toContain(QUESTION);
  });

  it('keeps nothing with nobody signed in, or nothing to keep', () => {
    expect(keepQuestion('   ')).toBe(false);
    unseed();
    unseed = seedAI();
    expect(useAIConnectionStore.getState().hydratedUserId).toBeNull();
    expect(keepQuestion(QUESTION)).toBe(false);
    expect(stored()).toBeNull();
  });

  it('replaces an earlier question wholesale', () => {
    keepQuestion('first');
    markConsent({ provider: 'gemini' });
    const first = readKept(SEED_USER_ID) as KeptQuestion;
    vi.setSystemTime(NOW + 1000);
    keepQuestion('second');
    const second = readKept(SEED_USER_ID) as KeptQuestion;
    expect(second.text).toBe('second');
    expect(second.id).not.toBe(first.id);
    expect(second.at).toBe(NOW + 1000);
    expect(second.consent).toBeNull();
  });

  it('cuts a long question where a send would', () => {
    keepQuestion('x'.repeat(KEPT_MAX_CHARS + 500));
    expect(readKept(SEED_USER_ID)?.text).toHaveLength(KEPT_MAX_CHARS);
  });

  it('removes a malformed record as it reads it', () => {
    for (const raw of [
      '{not json',
      JSON.stringify({ id: 'q1', text: QUESTION, at: NOW, uid: SEED_USER_ID }),
      JSON.stringify({ id: 'q1', text: '  ', at: NOW, uid: SEED_USER_ID, consent: null }),
      JSON.stringify({ id: 'q1', text: QUESTION, at: NOW, uid: SEED_USER_ID, consent: { provider: 'nope', baseUrl: null, at: NOW } }),
    ]) {
      __resetKeptForTests();
      sessionStorage.setItem(ASK_PENDING_KEY, raw);
      expect(readKept(SEED_USER_ID)).toBeNull();
      expect(stored()).toBeNull();
    }
  });

  it("never shows another account's question, and removes it only once the account is known", () => {
    const foreign: KeptQuestion = { id: 'q-b', text: QUESTION, at: NOW, uid: 'someone-else', consent: null };
    sessionStorage.setItem(ASK_PENDING_KEY, JSON.stringify(foreign));
    expect(readKept(null)).toBeNull();
    expect(stored()).not.toBeNull();
    expect(readKept(SEED_USER_ID)).toBeNull();
    expect(stored()).toBeNull();
  });

  it('reads a fresh page’s record from storage (the OpenRouter round trip)', () => {
    keepQuestion(QUESTION);
    const q = readKept(SEED_USER_ID);
    __resetKeptForTests();
    expect(readKept(SEED_USER_ID)).toEqual(q);
  });

  describe('storage that refuses', () => {
    /** Throw from `method` on one of the two storages only. */
    function refuse(which: 'session' | 'local', method: 'setItem' | 'getItem') {
      const real = Storage.prototype[method];
      vi.spyOn(Storage.prototype, method).mockImplementation(function (this: Storage, ...args: [string, string?]) {
        if (this === (which === 'session' ? window.sessionStorage : window.localStorage)) {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        }
        return (real as (...a: unknown[]) => unknown).apply(this, args) as never;
      });
    }

    it('sessionStorage refusing the write: the mirror keeps it for this page', () => {
      refuse('session', 'setItem');
      expect(keepQuestion(QUESTION)).toBe(true);
      expect(stored()).toBeNull();
      expect(readKept(SEED_USER_ID)?.text).toBe(QUESTION);
      markConsent({ provider: 'gemini' });
      expect(readKept(SEED_USER_ID)?.consent?.provider).toBe('gemini');
    });

    it('sessionStorage refusing the read: nothing to show, nothing thrown', () => {
      sessionStorage.setItem(ASK_PENDING_KEY, JSON.stringify({ id: 'q1', text: QUESTION, at: NOW, uid: SEED_USER_ID, consent: null }));
      __resetKeptForTests();
      refuse('session', 'getItem');
      expect(readKept(SEED_USER_ID)).toBeNull();
    });

    it('localStorage refusing the claimed list: the claim holds in this tab, and the question is still asked, once', async () => {
      refuse('local', 'setItem');
      keepQuestion(QUESTION);
      markConsent({ provider: 'gemini' });
      watch();
      connect();
      await settle();
      expect(sent()).toEqual([QUESTION]);
      expect(localStorage.getItem(ASK_CLAIMED_KEY)).toBeNull();
      watch();
      // A status read landing (the planner store persists, and would throw here).
      useAIConnectionStore.setState({ fetchedAt: Date.now() });
      await settle();
      expect(sent()).toEqual([QUESTION]);
    });
  });

  it('[Clear] removes it and leaves its id on the claimed list', () => {
    keepQuestion(QUESTION);
    const { id } = readKept(SEED_USER_ID) as KeptQuestion;
    clearKept();
    expect(stored()).toBeNull();
    expect(readKept(SEED_USER_ID)).toBeNull();
    expect(claimed()).toEqual([id]);
  });

  it('the claimed list keeps the last eight ids', () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      keepQuestion(`question ${i}`);
      ids.push((readKept(SEED_USER_ID) as KeptQuestion).id);
      clearKept();
    }
    expect(claimed()).toEqual(ids.slice(-8));
  });

  it("the account's clear takes the record and the mirror, and leaves the claimed list", () => {
    keepQuestion('cleared before');
    clearKept();
    const list = claimed();
    keepQuestion(QUESTION);
    expect(readKept(SEED_USER_ID)).not.toBeNull();
    clearKeptQuestionState();
    expect(stored()).toBeNull();
    // The mirror too: readKept would answer from it if only the key had gone.
    expect(readKept(SEED_USER_ID)).toBeNull();
    expect(claimed()).toEqual(list);
  });

  describe('consent', () => {
    it('stamps the press on the question this account sees, and renews it on the next', () => {
      markConsent({ provider: 'gemini' });
      expect(stored()).toBeNull();
      keepQuestion(QUESTION);
      markConsent({ provider: 'gemini' });
      expect(readKept(SEED_USER_ID)?.consent).toEqual({ provider: 'gemini', baseUrl: null, at: NOW });
      markConsent({ provider: 'custom', baseUrl: 'https://llm.example.com/v1' }, NOW + 5000);
      expect(readKept(SEED_USER_ID)?.consent).toEqual({ provider: 'custom', baseUrl: 'https://llm.example.com/v1', at: NOW + 5000 });
    });

    it("never stamps another account's question", () => {
      sessionStorage.setItem(ASK_PENDING_KEY, JSON.stringify({ id: 'q-b', text: QUESTION, at: NOW, uid: 'someone-else', consent: null }));
      markConsent({ provider: 'gemini' });
      expect(JSON.parse(stored() as string).consent).toBeNull();
    });
  });

  it('takeKept and restoreKept put back the identical record, its id off the claimed list', () => {
    keepQuestion(QUESTION);
    markConsent({ provider: 'gemini' });
    const before = readKept(SEED_USER_ID) as KeptQuestion;
    const taken = takeKept() as KeptQuestion;
    expect(taken).toEqual(before);
    expect(stored()).toBeNull();
    expect(readKept(SEED_USER_ID)).toBeNull();
    vi.setSystemTime(NOW + 60_000);
    // A claimed id is unclaimed by the restore (the watcher's put-back).
    localStorage.setItem(ASK_CLAIMED_KEY, JSON.stringify([taken.id]));
    restoreKept(taken);
    expect(readKept(SEED_USER_ID)).toEqual(before);
    expect(JSON.parse(stored() as string)).toEqual(before);
    expect(claimed()).toEqual([]);
  });

  it('restoreKept leaves a newer question alone', () => {
    keepQuestion('old');
    const old = takeKept() as KeptQuestion;
    keepQuestion('new');
    restoreKept(old);
    expect(readKept(SEED_USER_ID)?.text).toBe('new');
  });
});

describe('useKeptQuestion', () => {
  it("is this account's question, live: kept, consented, cleared", () => {
    const { result } = renderHook(() => useKeptQuestion());
    expect(result.current).toBeNull();
    act(() => void keepQuestion(QUESTION));
    expect(result.current?.text).toBe(QUESTION);
    act(() => markConsent({ provider: 'gemini' }));
    expect(result.current?.consent?.provider).toBe('gemini');
    act(() => clearKept());
    expect(result.current).toBeNull();
  });

  it('hides it the moment the account changes', () => {
    keepQuestion(QUESTION);
    const { result } = renderHook(() => useKeptQuestion());
    expect(result.current?.text).toBe(QUESTION);
    act(() => useAIConnectionStore.setState({ hydratedUserId: 'someone-else' }));
    expect(result.current).toBeNull();
  });

  it('hides it when another tab claims or clears it (a duplicated tab)', () => {
    keepQuestion(QUESTION);
    const { id } = readKept(SEED_USER_ID) as KeptQuestion;
    const { result } = renderHook(() => useKeptQuestion());
    expect(result.current?.text).toBe(QUESTION);
    act(() => {
      localStorage.setItem(ASK_CLAIMED_KEY, JSON.stringify([id]));
      window.dispatchEvent(new StorageEvent('storage', { key: ASK_CLAIMED_KEY, newValue: JSON.stringify([id]) }));
    });
    expect(result.current).toBeNull();
  });
});

describe('the watcher', () => {
  /** A question kept and consented to for the company the press named. */
  function keepConsented(target: { provider: ModelConnectionView['provider']; baseUrl?: string | null } = { provider: 'gemini' }) {
    expect(keepQuestion(QUESTION)).toBe(true);
    markConsent(target);
  }

  it('asks it once something answers, a macrotask later, once', async () => {
    keepConsented();
    watch();
    connect();
    // Not in the same tick as the connect: its caller is still finishing.
    expect(sent()).toEqual([]);
    await settle();
    expect(sent()).toEqual([QUESTION]);
    expect(stored()).toBeNull();
    expect(claimed()).toHaveLength(1);
    // A status flap, a recheck, any change: nothing more.
    useAIConnectionStore.setState({ model: { ...MODEL, status: 'failing' } });
    connect();
    usePlannerStore.setState({ isLoading: false });
    await settle();
    expect(sent()).toEqual([QUESTION]);
  });

  it('is level-triggered: a page that loads already answering asks it (the OpenRouter return)', async () => {
    keepConsented({ provider: 'openrouter' });
    connect({ provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free', authMethod: 'oauth' });
    __resetKeptForTests();
    watch();
    await settle();
    expect(sent()).toEqual([QUESTION]);
  });

  it("runs after the connect's own finish (succeed pops home and says It works.), so its conversation stays on screen", async () => {
    keepConsented();
    rail().push('desktop', { kind: 'history' });
    watch();
    connect();
    // ConnectAI's succeed, a microtask after the store's write.
    await Promise.resolve();
    rail().popToHome('desktop');
    useAIConnectionStore.getState().setJustConnected({ provider: 'gemini', model: MODEL.model as string, freeTier: true, at: NOW });
    await settle();
    expect(sent()).toEqual([QUESTION]);
    const top = rail().stacks.desktop.at(-1);
    expect(top).toMatchObject({ kind: 'conversation' });
    expect(useConversationsStore.getState().threads[(top as { id: string }).id].messages[0].content).toBe(QUESTION);
    // Landing straight in its conversation spends "It works." (a §0 decision of AI setup PR 5).
    expect(useAIConnectionStore.getState().justConnected).toBeNull();
  });

  it('opens Ask on the desktop for this session only, over a closed item and out of Zen', async () => {
    keepConsented();
    useUIStore.setState({ activeDialog: { type: 'edit-item', item: { id: 'i1', title: 'Book the dentist' } as never } });
    useViewStore.setState({ zenOpen: true });
    watch();
    connect();
    await settle();
    expect(sent()).toEqual([QUESTION]);
    expect(useUIStore.getState().activeDialog).toBeNull();
    expect(useViewStore.getState().zenOpen).toBe(false);
    expect(rail().summoned).toBe(true);
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(useMobileNavStore.getState().activeTab).toBe('today');
  });

  it('asks on the shell showing when it asks: the phone’s Ask tab, its own stack, never a summon', async () => {
    let phone = false;
    keepConsented();
    watch({ phone: () => phone });
    connect();
    phone = true;
    await settle();
    expect(sent()).toEqual([QUESTION]);
    expect(useMobileNavStore.getState().activeTab).toBe('chat');
    expect(rail().stacks.phone.at(-1)).toMatchObject({ kind: 'conversation' });
    expect(rail().stacks.desktop).toEqual([]);
    expect(rail().summoned).toBe(false);
  });

  it('waits for the planner: the gate first, the plan later, asked once when it lands', async () => {
    usePlannerStore.setState({ userId: null, isLoading: false });
    keepConsented();
    watch();
    connect();
    await settle();
    expect(sent()).toEqual([]);
    usePlannerStore.setState({ userId: SEED_USER_ID, isLoading: true });
    await settle();
    expect(sent()).toEqual([]);
    usePlannerStore.setState({ isLoading: false });
    await settle();
    expect(sent()).toEqual([QUESTION]);
    usePlannerStore.setState({ isLoading: false, error: null });
    await settle();
    expect(sent()).toEqual([QUESTION]);
  });

  it('never asks over the look-only preview or its crash drop: it goes out once, with the fresh rows as context', async () => {
    // memory/plans/instant-planner.md: the cached rows are up while the load
    // is still in flight (isLoading on), so the watcher's settled check holds
    // it, as it holds a cold load. A crash drop empties the rows and keeps the
    // load in flight: still held.
    const cached = [{ type: 'task', id: 't1', title: 'Cached row', status: 'pending', isScheduled: false, order: 0, completedDates: [] }];
    const fresh = [{ ...cached[0], title: 'Fresh row' }];
    usePlannerStore.setState({ userId: SEED_USER_ID, isLoading: true, isPreview: true, items: cached } as never);
    keepConsented();
    watch();
    connect();
    await settle();
    expect(sent()).toEqual([]);
    expect(readKept(SEED_USER_ID)?.text).toBe(QUESTION);
    usePlannerStore.setState({ isPreview: false, items: [] } as never);
    await settle();
    expect(sent()).toEqual([]);
    usePlannerStore.setState({ isLoading: false, items: fresh } as never);
    await settle();
    expect(sent()).toEqual([QUESTION]);
    expect(context.titles).toEqual([['Fresh row']]);
  });

  it("asks nothing over a planner load that failed, or one that is another account's, and keeps the question", async () => {
    keepConsented();
    for (const planner of [
      { userId: SEED_USER_ID, isLoading: false, error: 'Could not load' },
      { userId: 'someone-else', isLoading: false, error: null },
    ]) {
      usePlannerStore.setState(planner);
      const stop = watch();
      connect();
      await settle();
      stop();
      expect(sent()).toEqual([]);
      expect(readKept(SEED_USER_ID)?.text).toBe(QUESTION);
    }
  });

  it('asks nothing while the gate is unknown, failed, or answers nothing', async () => {
    keepConsented();
    watch();
    useAIConnectionStore.setState({ phase: 'error' });
    await settle();
    useAIConnectionStore.setState({ phase: 'ready', model: null });
    await settle();
    expect(sent()).toEqual([]);
    expect(readKept(SEED_USER_ID)).not.toBeNull();
  });

  it('a send refused after the claim puts the identical record back, and tries again on the next change, not on its own', async () => {
    keepConsented();
    const before = readKept(SEED_USER_ID) as KeptQuestion;
    const send = useConversationsStore.getState().send;
    const refused = vi.fn(async () => {});
    useConversationsStore.setState({ send: refused });
    watch();
    connect();
    await settle();
    expect(refused).toHaveBeenCalledTimes(1);
    expect(readKept(SEED_USER_ID)).toEqual(before);
    expect(JSON.parse(stored() as string)).toEqual(before);
    expect(claimed()).toEqual([]);
    // The put-back is no change the watcher hears.
    await settle();
    expect(refused).toHaveBeenCalledTimes(1);
    useConversationsStore.setState({ send });
    usePlannerStore.setState({ isLoading: false });
    await settle();
    expect(sent()).toEqual([QUESTION]);
  });

  it('a send that finishes before it returns (its context build threw) took the text: asked once, never put back', async () => {
    context.throws = true;
    const api = fakeApi();
    configureConversations({ api: api.api, transport: tx.transport });
    const send = useConversationsStore.getState().send;
    const sends = vi.fn((id: string, text: string) => send(id, text));
    useConversationsStore.setState({ send: sends });
    keepConsented();
    watch();
    connect();
    await settle();
    // Ordinary planner writes (an edit, a tick) each wake the watcher.
    for (let i = 0; i < 3; i++) {
      usePlannerStore.setState({ isLoading: false });
      await settle();
    }
    const holding = Object.values(useConversationsStore.getState().threads).filter((t) =>
      t.messages.some((m) => m.role === 'user' && m.content === QUESTION)
    );
    expect(holding).toHaveLength(1);
    expect(holding[0].messages.at(-1)).toMatchObject({ role: 'assistant', status: 'error' });
    expect(sends).toHaveBeenCalledTimes(1);
    expect(api.turns).toHaveLength(1);
    expect(readKept(SEED_USER_ID)).toBeNull();
    expect(stored()).toBeNull();
    expect(claimed()).toHaveLength(1);
  });

  it('waits for Ask home’s own send to finish rather than be refused by it', async () => {
    keepConsented();
    useConversationsStore.getState().beginSend('home');
    watch();
    connect();
    await settle();
    expect(sent()).toEqual([]);
    expect(readKept(SEED_USER_ID)).not.toBeNull();
    useConversationsStore.getState().endSend('home');
    await settle();
    expect(sent()).toEqual([QUESTION]);
  });

  it("React's dev double effect, and two watchers at once, ask it once", async () => {
    keepConsented();
    connect();
    const first = watch();
    first();
    watch();
    watch();
    await settle();
    expect(sent()).toEqual([QUESTION]);
  });

  it('a sign-out between the connect and the macrotask asks nothing', async () => {
    keepConsented();
    watch();
    connect();
    // SIGNED_OUT: the gate resets first, then the account's clear.
    useAIConnectionStore.getState().reset();
    clearKeptQuestionState();
    await settle();
    expect(sent()).toEqual([]);
  });

  it('gone with AppShell: a timer still waiting asks nothing, and the question stays', async () => {
    keepConsented();
    const stop = watch();
    connect();
    stop();
    await settle();
    expect(sent()).toEqual([]);
    expect(readKept(SEED_USER_ID)?.text).toBe(QUESTION);
  });

  it('a duplicated tab, with its own copy and the shared list, never asks it again; nor one the person cleared', async () => {
    keepConsented();
    const copy = stored() as string;
    watch();
    connect();
    await settle();
    expect(sent()).toEqual([QUESTION]);

    // The duplicate: a fresh page holding the copy, the same localStorage.
    __resetKeptForTests();
    sessionStorage.setItem(ASK_PENDING_KEY, copy);
    watch();
    await settle();
    expect(sent()).toEqual([QUESTION]);
    expect(stored()).toBeNull();

    // Cleared in one tab, then the gate lights in its duplicate.
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    keepQuestion('cleared one');
    markConsent({ provider: 'gemini' });
    const clearedCopy = stored() as string;
    clearKept();
    __resetKeptForTests();
    sessionStorage.setItem(ASK_PENDING_KEY, clearedCopy);
    connect();
    await settle();
    expect(sent()).toEqual([QUESTION]);
  });

  describe('sends only where the consent line said, and otherwise leaves it in Ask home’s box', () => {
    /** Leaves nothing sent, nothing opened, the question claimed, and the text in the box. */
    async function expectWaitsInTheBox(typed?: string) {
      await settle();
      expect(sent()).toEqual([]);
      expect(rail().drafts.home).toBe(typed ? `${typed}\n${QUESTION}` : QUESTION);
      expect(rail().summoned).toBe(false);
      expect(rail().stacks.desktop).toEqual([]);
      expect(useMobileNavStore.getState().activeTab).toBe('today');
      expect(useUIStore.getState().activeDialog?.type).toBe('edit-item');
      expect(stored()).toBeNull();
      expect(claimed()).toHaveLength(1);
    }

    beforeEach(() => {
      useUIStore.setState({ activeDialog: { type: 'edit-item', item: { id: 'i1', title: 'Book the dentist' } as never } });
    });

    it('the company it named: sent', async () => {
      keepConsented({ provider: 'openai' });
      watch();
      connect({ provider: 'openai', model: 'gpt-4o-mini' });
      await settle();
      expect(sent()).toEqual([QUESTION]);
    });

    it('no consent (connected in Settings → AI, another device): waits', async () => {
      keepQuestion(QUESTION);
      watch();
      connect();
      await expectWaitsInTheBox();
    });

    it('another company than the one it named: waits', async () => {
      keepConsented({ provider: 'gemini' });
      watch();
      connect({ provider: 'openrouter', model: 'openrouter/auto', authMethod: 'oauth' });
      await expectWaitsInTheBox();
    });

    it('Another service at another host: waits; at the same host: sent', async () => {
      keepConsented({ provider: 'custom', baseUrl: 'https://llm.example.com/v1' });
      watch();
      connect({ provider: 'custom', model: 'local-model', baseUrl: 'https://elsewhere.example.org/v1' });
      await expectWaitsInTheBox();

      unseed();
      unseed = seedAI(NOTHING_CONNECTED);
      rail().setDraft('home', '');
      keepConsented({ provider: 'custom', baseUrl: 'https://llm.example.com/v1' });
      connect({ provider: 'custom', model: 'local-model', baseUrl: 'https://LLM.example.com/openai/v1' });
      await settle();
      expect(sent()).toEqual([QUESTION]);
    });

    it('a consent older than an hour: waits', async () => {
      keepConsented();
      vi.setSystemTime(NOW + CONSENT_TTL_MS + 1);
      watch();
      connect();
      await expectWaitsInTheBox();
    });

    it('OpenClaw answering: waits, and the answerer is left as the gate chose it', async () => {
      keepConsented();
      watch();
      useAIConnectionStore.setState({ model: { ...MODEL, status: 'failing' }, openclaw: { gateway: true, pluginChat: false, agent: true, agentId: 'kirby-1' } });
      await expectWaitsInTheBox();
      expect(useAISettingsStore.getState().chatTarget).toBe('model');
    });

    it("after anything already typed in Ask home's box", async () => {
      rail().setDraft('home', 'half a thought');
      keepQuestion(QUESTION);
      watch();
      connect();
      await expectWaitsInTheBox('half a thought');
    });
  });
});
