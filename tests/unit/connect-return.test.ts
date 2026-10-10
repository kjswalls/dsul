import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  JUST_CONNECTED_WINDOW_MS,
  __resetConnectReturnForTests,
  justConnectedFrom,
  readConnectReturn,
  takeConnectReturn,
} from '@/lib/connect-return';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { useRailStore } from '@/lib/rail-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useViewStore } from '@/lib/view-store';
import type { ModelConnectionView } from '@/lib/ai-types';
import { seedAI, AI_HIDDEN, NOTHING_CONNECTED, type SeedAI } from './helpers/ai-fixtures';

/**
 * An OpenRouter sign-in begun in the setup column returns to `/?connect=…`,
 * and lib/connect-return.ts is the one step from that address to what the
 * column says. The return is a full page load, so the hard part is ORDER:
 * AppShell's effect runs before the provider adopts the account, and the
 * gate's first answer wipes the store to INITIAL. A result written at once
 * would be gone before anything showed it; these pin that it waits for the
 * answer, writes once, and opens the column only on the desktop.
 *
 * The link is also anyone's to craft, so `ok` alone never claims a test
 * question was answered: the answered connection has to back it up.
 */

const NOW = Date.parse('2026-10-07T18:00:00.000Z');

/** The connection an OpenRouter sign-in saves, checked a moment ago. */
const SIGNED_IN: ModelConnectionView = {
  provider: 'openrouter',
  model: 'meta-llama/llama-3.3-70b-instruct:free',
  baseUrl: null,
  authMethod: 'oauth',
  status: 'ok',
  problem: null,
  checkedAt: new Date(NOW - 20_000).toISOString(),
  limitedUntil: null,
  modelLabel: 'Meta: Llama 3.3 70B Instruct (free)',
};

const SIGNED_IN_SEED: SeedAI = {
  phase: 'ready',
  available: true,
  model: SIGNED_IN,
  openclaw: {},
  choice: 'model',
};

let unseed: () => void = () => {};
/** Every take's cleanup, run after each test: one still waiting on the gate must not answer in the next. */
let disposers: Array<() => void> = [];

function take(search: string, o: { phone?: boolean } = {}) {
  const clearLink = vi.fn();
  const dispose = takeConnectReturn(search, {
    clearLink,
    isPhone: () => !!o.phone,
    now: () => NOW,
  });
  disposers.push(dispose);
  return { clearLink, dispose };
}

const ai = () => useAIConnectionStore.getState();
const rail = () => useRailStore.getState();

beforeEach(() => {
  __resetConnectReturnForTests();
  useAIConnectionStore.getState().reset();
  rail().reset();
  useViewStore.setState({ zenOpen: false });
  useSidebarStore.setState({ askOpen: false });
  useMobileNavStore.setState({ activeTab: 'today' });
});

afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers = [];
  unseed();
  unseed = () => {};
  vi.unstubAllGlobals();
  vi.useRealTimers();
  useAISettingsStore.getState().clearUserScopedState();
});

describe('reading the link', () => {
  it('knows every result the callback sends', () => {
    for (const flow of ['ok', 'denied', 'expired', 'failed', 'busy', 'unavailable', 'saved', 'no_credit', 'daily_limit']) {
      expect(readConnectReturn(`?connect=${flow}`)).toBe(flow);
    }
  });

  it("reads the table's own keys only", () => {
    for (const raw of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'OK', ' ok', 'nope', '']) {
      expect(readConnectReturn(`?connect=${encodeURIComponent(raw)}`)).toBeNull();
    }
    expect(readConnectReturn('')).toBeNull();
    expect(readConnectReturn('?eod=1')).toBeNull();
  });
});

describe('the link comes off the address bar at once', () => {
  it('before the gate has answered, whatever it said', () => {
    for (const search of ['?connect=denied', '?connect=ok', '?connect=__proto__', '?connect=']) {
      const { clearLink, dispose } = take(search);
      expect(clearLink).toHaveBeenCalledTimes(1);
      dispose();
    }
  });

  it('and is left alone when there is none', () => {
    const { clearLink } = take('?eod=2026-10-06');
    expect(clearLink).not.toHaveBeenCalled();
  });
});

describe('waiting for the gate', () => {
  it('writes nothing while the gate is unknown', () => {
    take('?connect=denied');
    expect(ai().flowResult).toBeNull();
    expect(rail().summoned).toBe(false);
  });

  it('says it after the first answer for the account, not before the wipe that answer brings', async () => {
    let answer: (body: unknown) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          answer = (body) => resolve({ ok: true, status: 200, json: async () => body });
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    // The order a full page load runs in: AppShell's effect, then the provider adopts the account.
    take('?connect=denied');
    const hydrating = ai().hydrate('user-1');
    expect(ai().phase).toBe('unknown');
    expect(ai().flowResult).toBeNull();

    answer({ available: true, model: null, openclaw: {}, aiHidden: false });
    await hydrating;

    expect(ai().phase).toBe('ready');
    expect(ai().flowResult).toBe('denied');
    expect(rail().summoned).toBe(true);
  });

  it('drops it when the gate fails: the gate fails closed, and so does this', () => {
    unseed = seedAI({ ...NOTHING_CONNECTED, phase: 'unknown' });
    take('?connect=denied');
    useAIConnectionStore.setState({ phase: 'error' });
    expect(ai().flowResult).toBeNull();
    // A later answer does not bring it back.
    unseed = seedAI(NOTHING_CONNECTED);
    expect(ai().flowResult).toBeNull();
    expect(rail().summoned).toBe(false);
  });

  it('says it at once when the gate has already answered', () => {
    unseed = seedAI(NOTHING_CONNECTED);
    take('?connect=expired');
    expect(ai().flowResult).toBe('expired');
  });

  it('writes once and summons once, though its own write re-enters the subscription', () => {
    // Spied on the live state objects: every later `set` copies the action across.
    const setFlowResult = vi.spyOn(ai(), 'setFlowResult');
    const summon = vi.spyOn(rail(), 'summon');
    take('?connect=denied');
    unseed = seedAI(NOTHING_CONNECTED);
    // A later answer for the same account says nothing new.
    useAIConnectionStore.setState({ fetchedAt: Date.now() });
    expect(setFlowResult).toHaveBeenCalledTimes(1);
    expect(setFlowResult).toHaveBeenCalledWith('denied');
    expect(summon).toHaveBeenCalledTimes(1);
    expect(summon).toHaveBeenCalledWith({ persist: false });
  });

  it('a dispose before the answer stops it', () => {
    vi.useFakeTimers();
    const { dispose } = take('?connect=denied');
    dispose();
    vi.runAllTimers();
    unseed = seedAI(NOTHING_CONNECTED);
    expect(ai().flowResult).toBeNull();
    expect(rail().summoned).toBe(false);
  });

  it("survives React's dev double mount, which strips the link on the first and finds none on the second", () => {
    vi.useFakeTimers();
    const first = take('?connect=denied');
    first.dispose();
    // The second mount reads the address bar the first one already cleaned.
    const second = take('');
    expect(second.clearLink).not.toHaveBeenCalled();
    vi.runAllTimers();
    unseed = seedAI(NOTHING_CONNECTED);
    expect(ai().flowResult).toBe('denied');
  });
});

describe('what an ok return may claim', () => {
  it('"It works." for the sign-in it names: OpenRouter, signed in, working, a model, checked a moment ago', () => {
    expect(justConnectedFrom(SIGNED_IN, NOW)).toEqual({
      provider: 'openrouter',
      model: SIGNED_IN.model,
      // The return carries no plan signal; the card never guesses one.
      freeTier: false,
      at: NOW,
    });
  });

  it.each<[string, Partial<ModelConnectionView>]>([
    ['another provider (a crafted link over a key connection)', { provider: 'gemini', authMethod: 'key' }],
    ['a key, not a sign-in', { authMethod: 'key' }],
    ['a connection that is failing', { status: 'failing', problem: 'key_rejected' }],
    ['no model picked', { model: null }],
    ['a check from long ago (a stale or crafted link)', { checkedAt: new Date(NOW - JUST_CONNECTED_WINDOW_MS - 1000).toISOString() }],
    ['a check in the future', { checkedAt: new Date(NOW + JUST_CONNECTED_WINDOW_MS + 1000).toISOString() }],
    ['no check at all', { checkedAt: null }],
    ['a check that is not a time', { checkedAt: 'yesterday' }],
  ])('nothing for %s', (_, patch) => {
    expect(justConnectedFrom({ ...SIGNED_IN, ...patch }, NOW)).toBeNull();
  });

  it('nothing with no connection', () => {
    expect(justConnectedFrom(null, NOW)).toBeNull();
  });

  it('sets justConnected from the answered connection, and leaves flowResult alone', () => {
    take('?connect=ok');
    unseed = seedAI(SIGNED_IN_SEED);
    expect(ai().justConnected).toEqual({ provider: 'openrouter', model: SIGNED_IN.model, freeTier: false, at: NOW });
    expect(ai().flowResult).toBeNull();
  });

  it('sets nothing for a stale ok, but still opens Ask', () => {
    take('?connect=ok');
    unseed = seedAI({ ...SIGNED_IN_SEED, model: { ...SIGNED_IN, checkedAt: '2026-10-01T00:00:00.000Z' } });
    expect(ai().justConnected).toBeNull();
    expect(rail().summoned).toBe(true);
  });

  it('sets nothing for an ok that answers with nothing connected', () => {
    take('?connect=ok');
    unseed = seedAI(NOTHING_CONNECTED);
    expect(ai().justConnected).toBeNull();
    expect(ai().flowResult).toBeNull();
  });
});

describe('a sign-in that did not end connected', () => {
  it.each(['denied', 'expired', 'failed', 'busy', 'unavailable', 'saved', 'no_credit', 'daily_limit'] as const)(
    'leaves %s for the column to say',
    (flow) => {
      take(`?connect=${flow}`);
      unseed = seedAI(NOTHING_CONNECTED);
      expect(ai().flowResult).toBe(flow);
      expect(ai().justConnected).toBeNull();
    }
  );

  it.each(['saved', 'no_credit', 'daily_limit'] as const)(
    'leaves %s for Ask home to say when the connection it saved answers (its test question did not)',
    (flow) => {
      rail().push('desktop', { kind: 'history' });
      take(`?connect=${flow}`);
      unseed = seedAI(SIGNED_IN_SEED);
      expect(ai().flowResult).toBe(flow);
      // Never "It works.": the test question went unanswered.
      expect(ai().justConnected).toBeNull();
      // The column opens where the sign-in began, on Ask's home, and opening
      // it (a summon, a pop to home) spends nothing.
      expect(rail().stacks.desktop).toEqual([]);
      expect(rail().summoned).toBe(true);
      expect(ai().flowResult).toBe(flow);
    }
  );

  it.each([
    ['a key turned down', { model: { ...SIGNED_IN, status: 'failing', problem: 'key_rejected' } }],
    ['the connection gone', { model: null }],
  ] as const)(
    "goes with Ask when the connection stops answering before it is spent (%s), so the setup or fix home never says it later",
    (_, after) => {
      take('?connect=saved');
      unseed = seedAI(SIGNED_IN_SEED);
      // A write that leaves the connection answering keeps it.
      useAIConnectionStore.setState({ fetchedAt: NOW });
      expect(ai().flowResult).toBe('saved');
      useAIConnectionStore.setState(after);
      expect(ai().flowResult).toBeNull();
      // And a result written later is not the watch's business.
      ai().setFlowResult('denied');
      useAIConnectionStore.setState({ model: SIGNED_IN });
      useAIConnectionStore.setState({ model: null });
      expect(ai().flowResult).toBe('denied');
    }
  );

  it.each(['denied', 'expired', 'failed', 'busy', 'unavailable'] as const)(
    'leaves nothing for %s when a connection answers anyway: Ask says only a sign-in that saved, and one left would surface later',
    (flow) => {
      take(`?connect=${flow}`);
      unseed = seedAI(SIGNED_IN_SEED);
      expect(ai().flowResult).toBeNull();
      expect(ai().justConnected).toBeNull();
      expect(rail().summoned).toBe(true);
    }
  );
});

describe('opening the column where the sign-in began', () => {
  it('desktop: out of Zen, Ask home, summoned without writing askOpen', () => {
    useViewStore.setState({ zenOpen: true });
    rail().push('desktop', { kind: 'history' });
    take('?connect=denied');
    unseed = seedAI(NOTHING_CONNECTED);
    expect(useViewStore.getState().zenOpen).toBe(false);
    expect(rail().stacks.desktop).toEqual([]);
    expect(rail().summoned).toBe(true);
    expect(useSidebarStore.getState().askOpen).toBe(false);
  });

  it('desktop, ok: Ask opens on its home, with the card to show', () => {
    rail().push('desktop', { kind: 'history' });
    take('?connect=ok');
    unseed = seedAI(SIGNED_IN_SEED);
    expect(rail().stacks.desktop).toEqual([]);
    expect(rail().summoned).toBe(true);
    // Opening Ask is a summon, never a push or a close: nothing spends the card.
    expect(ai().justConnected).not.toBeNull();
  });

  // The phone's setup page and Ask both live on its Ask tab. A summon there
  // would arm the desktop column to spring open on a wider window.
  it('phone: the Ask tab on its home, with the store write, and never a summon or Zen', () => {
    useViewStore.setState({ zenOpen: true });
    rail().push('phone', { kind: 'history' });
    rail().push('desktop', { kind: 'history' });
    take('?connect=denied', { phone: true });
    unseed = seedAI(NOTHING_CONNECTED);
    expect(ai().flowResult).toBe('denied');
    expect(useMobileNavStore.getState().activeTab).toBe('chat');
    expect(rail().stacks.phone).toEqual([]);
    expect(rail().summoned).toBe(false);
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(useViewStore.getState().zenOpen).toBe(true);
    // The desktop's own stack is the desktop's.
    expect(rail().stacks.desktop).toEqual([{ kind: 'history' }]);
  });

  it('phone, ok: the Ask tab opens on its home, with the card to show', () => {
    rail().push('phone', { kind: 'history' });
    take('?connect=ok', { phone: true });
    unseed = seedAI(SIGNED_IN_SEED);
    expect(useMobileNavStore.getState().activeTab).toBe('chat');
    expect(rail().stacks.phone).toEqual([]);
    expect(rail().summoned).toBe(false);
    expect(ai().justConnected).toMatchObject({ provider: 'openrouter', model: SIGNED_IN.model, freeTier: false, at: NOW });
  });

  it('phone: stays where it is when the gate offers nothing to show', () => {
    take('?connect=denied', { phone: true });
    unseed = seedAI(AI_HIDDEN);
    expect(useMobileNavStore.getState().activeTab).toBe('today');
    expect(rail().summoned).toBe(false);
  });

  it('leaves no summon waiting when the gate offers nothing to show', () => {
    take('?connect=denied');
    unseed = seedAI(AI_HIDDEN);
    expect(rail().summoned).toBe(false);
  });
});
