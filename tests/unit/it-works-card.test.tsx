import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * "It works." (components/ai/ask/it-works-card.tsx): Ask home's first words
 * after a connection lands in this tab, from the store's `justConnected`.
 *
 * It states a fact ("answered a test question") and names the model Ask will
 * use, so what is pinned here is when it may say so (only while the live
 * model is the one just connected), what it calls the model (a name, never a
 * raw id where one is known), that OpenRouter's free plan is claimed only on
 * the connect answer's word, and that it is said ONCE: the first send, New
 * chat, a conversation opened and Ask closing (on the phone, leaving its Ask
 * tab) each spend it. Over the real
 * stores, with the db layer and the conversation API faked, as
 * ask-home-view.test.tsx renders Ask home.
 */

vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  fetchItemEvents: vi.fn(async () => []),
  getItemEventsAvailable: () => false,
  updateItem: vi.fn(async () => {}),
  fetchAgentStates: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn() }));
vi.mock('sonner', () => ({
  toast: Object.assign(() => 'id', { error: vi.fn(), dismiss: vi.fn(), success: vi.fn() }),
}));
vi.mock('@/lib/supabase', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  })),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

import { AskHome } from '@/components/ai/ask/ask-home';
import { itWorksFor } from '@/components/ai/ask/it-works-card';
import { AnswererLabel } from '@/components/ai/bound-composer';
import { usePlannerStore } from '@/lib/planner-store';
import { useSessionUserStore } from '@/lib/session-user-store';
import { useEODStore } from '@/lib/eod-store';
import { useRailStore } from '@/lib/rail-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { useUIStore } from '@/lib/ui-store';
import { useProposalStore } from '@/lib/proposal-store';
import { useAIConnectionStore, type JustConnected } from '@/lib/ai-connection-store';
import { FLOW_COPY, type FlowResult } from '@/lib/connect-flow';
import { chatTransport } from '@/lib/chat-transport';
import { httpConversationsApi } from '@/lib/conversations-api';
import { newChat, openConversation } from '@/lib/open-chat';
import {
  clearChatState,
  configureConversations,
  conversationsSettled,
  useConversationsStore,
} from '@/lib/conversations-store';
import { resetAgentFreshness } from '@/hooks/use-agent-freshness';
import type { ModelConnectionView } from '@/lib/ai-types';
import { seedAI, type SeedAI } from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, flush, summary, type FakeTransport } from './helpers/conversations-fakes';

const NOW = Date.parse('2026-10-02T10:00:00.000Z');

const GEMINI: SeedAI = {
  phase: 'ready',
  available: true,
  model: { provider: 'gemini', model: 'gemini-flash-latest', status: 'ok' },
  openclaw: {},
  choice: 'model',
};

const OPENROUTER: SeedAI = {
  phase: 'ready',
  available: true,
  model: {
    provider: 'openrouter',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    authMethod: 'oauth',
    status: 'ok',
    modelLabel: 'Llama 3.3 70B (free)',
  },
  openclaw: {},
  choice: 'model',
};

const just = (over: Partial<JustConnected> = {}): JustConnected => ({
  provider: 'gemini',
  model: 'gemini-flash-latest',
  freeTier: false,
  at: NOW,
  ...over,
});

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

let unseed: () => void = () => {};
let transport: FakeTransport;

function seed(o: SeedAI, said: JustConnected | null = just()) {
  unseed();
  unseed = seedAI(o);
  useAIConnectionStore.getState().setJustConnected(said);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  transport = fakeTransport();
  configureConversations({ api: fakeApi().api, transport: transport.transport });
  clearChatState();
  resetAgentFreshness();
  usePlannerStore.setState({
    items: [],
    tasks: [],
    projects: [],
    routines: [],
    seasons: [],
    goals: [],
    itemTypes: [],
    userTimezone: 'UTC',
    timeFormat: '12h',
    isLoading: false,
    userId: 'u1',
  } as never);
  useSessionUserStore.setState({
    user: { id: 'u1', email: 'k@example.com', displayName: 'Kirby Example', avatarUrl: null },
  });
  useEODStore.setState({ eodReviewEnabled: false, eodReviewTime: '21:00' });
  useUIStore.setState({ activeDialog: null, displacedItemId: null });
  useRailStore.getState().reset();
  useProposalStore.getState().dismiss();
  seed(GEMINI);
});

afterEach(async () => {
  cleanup();
  await conversationsSettled();
  unseed();
  unseed = () => {};
  configureConversations({ api: httpConversationsApi, transport: chatTransport });
  useUIStore.setState({ activeDialog: null, displacedItemId: null });
  useSessionUserStore.setState({ user: null });
  vi.useRealTimers();
});

const card = () => screen.queryByTestId('it-works');
const line = () => screen.getByTestId('it-works-line').textContent;
const said = () => useAIConnectionStore.getState().justConnected;

describe('when it shows', () => {
  it('says it works, who answered, the model by name, and what to start with', () => {
    render(<AskHome />);
    const c = card() as HTMLElement;
    expect(within(c).getByRole('heading', { name: 'It works.' })).toBeInTheDocument();
    expect(line()).toBe(
      'Google Gemini answered a test question. Ask will use Gemini Flash, Google’s quick everyday model.'
    );
    expect(within(c).getByText('Gemini Flash').tagName).toBe('STRONG');
    expect(c).toHaveTextContent('Connected to your account, so dsul on the web and in the desktop app both use it.');
    expect(within(c).getByRole('link', { name: 'Settings → AI' })).toHaveAttribute('href', '/settings/ai');

    // Today's openers, live (up to three; a quiet morning has two): the
    // previews the setup column showed, one click each.
    const rows = within(screen.getByTestId('it-works-openers')).getAllByRole('button');
    expect(rows.map((r) => r.dataset.opener)).toEqual(['plan', 'reflect']);
    expect(rows[0]).toHaveTextContent('Plan my day');
    expect(rows[0]).toHaveTextContent("Drafts today from what's on it and your braindump.");
    expect(screen.getByTestId('it-works-openers')).toHaveTextContent('Start with one of these');
    expect(screen.getByTestId('it-works-openers')).toHaveTextContent('Pick one to start, or ask anything below.');
  });

  it('offers three when the day has three', () => {
    usePlannerStore.setState({
      items: [{ type: 'task', id: 'old', title: 'Fix the squeaky door', status: 'pending', isScheduled: false, order: 0, completedDates: [], startDate: '2026-09-20' }],
    } as never);
    render(<AskHome />);
    const rows = within(screen.getByTestId('it-works-openers')).getAllByRole('button');
    expect(rows.map((r) => r.dataset.opener)).toEqual(['plan', 'let-go', 'reflect']);
    expect(rows[1]).toHaveTextContent('like “Fix the squeaky door”');
  });

  it("hides the foot's chips while it shows, so nothing is offered twice", () => {
    render(<AskHome />);
    expect(screen.queryByTestId('chat-openers')).toBeNull();
    act(() => useAIConnectionStore.getState().setJustConnected(null));
    expect(card()).toBeNull();
    expect(screen.getByTestId('chat-openers')).toBeInTheDocument();
  });

  it('shows on the phone\'s Ask home too', () => {
    render(<AskHome variant="mobile" />);
    expect(card()).toBeInTheDocument();
  });
});

describe('only while the live model is the one just connected', () => {
  it('not with nothing just connected', () => {
    seed(GEMINI, null);
    render(<AskHome />);
    expect(card()).toBeNull();
    expect(screen.getByTestId('chat-openers')).toBeInTheDocument();
  });

  it('not when the model has moved on (another device, Settings)', () => {
    render(<AskHome />);
    expect(card()).toBeInTheDocument();
    act(() =>
      useAIConnectionStore.setState((s) => ({ model: { ...(s.model as ModelConnectionView), model: 'gemini-pro-latest' } }))
    );
    expect(card()).toBeNull();
  });

  it('not for another provider with the same id', () => {
    seed(GEMINI, just({ provider: 'openrouter' }));
    render(<AskHome />);
    expect(card()).toBeNull();
  });

  it('itWorksFor is that rule, pure', () => {
    const model = { provider: 'gemini', model: 'gemini-flash-latest' } as ModelConnectionView;
    expect(itWorksFor(just(), model)).toBe(true);
    expect(itWorksFor(null, model)).toBe(false);
    expect(itWorksFor(just(), null)).toBe(false);
    expect(itWorksFor(just({ model: 'gemini-pro-latest' }), model)).toBe(false);
  });
});

describe('the free plan', () => {
  it('is OpenRouter’s, said when its connect answer said so', () => {
    seed(OPENROUTER, just({ provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free', freeTier: true }));
    render(<AskHome />);
    expect(line()).toBe(
      'OpenRouter answered a test question. Ask will use Llama 3.3 70B (free), on OpenRouter’s free plan.'
    );
  });

  it('is never claimed without that word', () => {
    seed(OPENROUTER, just({ provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free', freeTier: false }));
    render(<AskHome />);
    expect(line()).toBe('OpenRouter answered a test question. Ask will use Llama 3.3 70B (free).');
  });

  it('nor for a provider that gives no plan signal', () => {
    seed(GEMINI, just({ freeTier: true }));
    render(<AskHome />);
    expect(line()).not.toContain('free plan');
  });
});

describe('the model, by name', () => {
  it('from the shape of a Claude id', () => {
    seed(
      { ...GEMINI, model: { provider: 'anthropic', model: 'claude-sonnet-4-5', status: 'ok' } },
      just({ provider: 'anthropic', model: 'claude-sonnet-4-5' })
    );
    render(<AskHome />);
    expect(line()).toBe('Anthropic answered a test question. Ask will use Claude Sonnet 4.5.');
  });

  it('as its id when nothing names it, and the host names a service of your own', () => {
    seed(
      { ...GEMINI, model: { provider: 'custom', model: 'my-model', baseUrl: 'https://llm.example.com/v1', status: 'ok' } },
      just({ provider: 'custom', model: 'my-model' })
    );
    render(<AskHome />);
    expect(line()).toBe('llm.example.com answered a test question. Ask will use my-model.');
  });

  it.each<[string, Partial<ModelConnectionView>, string]>([
    ['from the catalog', { provider: 'gemini', model: 'gemini-flash-latest' }, 'Gemini Flash'],
    ['from the catalog, not the raw id', { provider: 'openai', model: 'gpt-4o-mini' }, 'GPT-4o mini'],
    ['from the shape of the id', { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }, 'Claude Haiku 4.5'],
    [
      'from the name it was listed under when saved',
      { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free', modelLabel: 'Llama 3.3 70B (free)' },
      'Llama 3.3 70B (free)',
    ],
    ['as its id when nothing names it', { provider: 'openrouter', model: 'acme/mystery-1', modelLabel: null }, 'acme/mystery-1'],
  ])('under the box too: %s', (_, model, name) => {
    seed({ ...GEMINI, model: { status: 'ok', ...model } }, null);
    render(<AnswererLabel />);
    expect(screen.getByTestId('answerer-label').textContent).toBe(name);
  });
});

describe('said once', () => {
  it('a pick starts its conversation and spends it', async () => {
    render(<AskHome />);
    fireEvent.click(within(screen.getByTestId('it-works-openers')).getAllByRole('button')[0]);
    await act(() => flush());
    expect(said()).toBeNull();
    expect(useRailStore.getState().stacks.desktop.at(-1)?.kind).toBe('conversation');
    // The opener's own action: a fresh conversation titled with its label, its prompt sent.
    expect(transport.inputs).toHaveLength(1);
    expect(transport.inputs[0].message).toMatch(/^Help me put together a realistic plan for today/);
    const id = (useRailStore.getState().stacks.desktop.at(-1) as { id: string }).id;
    expect(useConversationsStore.getState().threads[id]?.draftTitle).toBe('Plan my day');
  });

  it('the first send, from any box, even one that pushes nothing', async () => {
    const id = useConversationsStore.getState().newDraft();
    expect(said()).not.toBeNull();
    await act(async () => {
      void useConversationsStore.getState().send(id, 'hello');
      await flush();
    });
    expect(said()).toBeNull();
    expect(useRailStore.getState().stacks.desktop).toEqual([]);
  });

  it('New chat', () => {
    render(<AskHome />);
    act(() => void newChat(false));
    expect(said()).toBeNull();
  });

  it('a conversation opened', () => {
    useConversationsStore.setState((s) => ({
      summaries: { ...s.summaries, c1: summary({ id: 'c1', title: 'Plan for today' }) },
    }));
    act(() => openConversation('c1', false));
    expect(said()).toBeNull();
  });

  it('History is not a conversation: Back finds the card still there', () => {
    act(() => useRailStore.getState().push('desktop', { kind: 'history' }));
    expect(said()).not.toBeNull();
  });

  it('Ask closing, by ✕ or Ctrl+J', () => {
    act(() => useRailStore.getState().summon());
    act(() => useRailStore.getState().closeRail());
    expect(said()).toBeNull();
  });

  it('Ask parked (an overlay given back, Escape)', () => {
    act(() => useRailStore.getState().summon({ persist: false }));
    act(() => useRailStore.getState().park());
    expect(said()).toBeNull();
  });

  // The phone's Ask closes by being left: the sheet, a swipe, a command, the
  // shell moving off a tab no longer offered. One subscription sees every
  // one of them, a setter's write or a bare setState alike.
  describe('on the phone', () => {
    afterEach(() => useMobileNavStore.setState({ activeTab: 'today' }));

    it.each<[string, () => void]>([
      ['by the sheet or a swipe', () => useMobileNavStore.getState().setActiveTab('today')],
      ['by any write to the tab', () => useMobileNavStore.setState({ activeTab: 'braindump' })],
    ])('its Ask tab left, %s', (_, leave) => {
      act(() => useMobileNavStore.setState({ activeTab: 'chat' }));
      useAIConnectionStore.getState().setJustConnected(just());
      render(<AskHome variant="mobile" />);
      expect(card()).toBeInTheDocument();

      act(leave);
      expect(said()).toBeNull();
      expect(card()).toBeNull();
    });

    it('and only left: arriving, or moving between the other tabs, spends nothing', () => {
      act(() => useMobileNavStore.setState({ activeTab: 'today' }));
      useAIConnectionStore.getState().setJustConnected(just());
      act(() => useMobileNavStore.getState().setActiveTab('braindump'));
      act(() => useMobileNavStore.getState().setActiveTab('chat'));
      expect(said()).not.toBeNull();
    });
  });

  it('a sign-out', () => {
    act(() => useAIConnectionStore.getState().reset());
    expect(said()).toBeNull();
  });
});

/**
 * An OpenRouter sign-in begun in the column can come home with the key saved
 * and working but its test question unanswered (saved, no_credit,
 * daily_limit; lib/connect-return.ts). The column is Ask by then, so Ask home
 * says why, quietly, where "It works." would sit, and spends it as it does
 * the card.
 */
describe('a sign-in that came home saved, its test question unanswered', () => {
  const note = () => screen.queryByTestId('ask-flow-note');
  const flow = () => useAIConnectionStore.getState().flowResult;
  const landed = (f: FlowResult) => {
    seed(OPENROUTER, null);
    useAIConnectionStore.getState().setFlowResult(f);
  };

  it.each(['saved', 'no_credit', 'daily_limit'] as const)(
    "says %s in the card's place, as a status, and leaves the chips be",
    (f) => {
      landed(f);
      render(<AskHome />);
      const n = note() as HTMLElement;
      expect(n).toHaveAttribute('role', 'status');
      expect(n).toHaveTextContent(FLOW_COPY[f]);
      expect(card()).toBeNull();
      expect(screen.getByTestId('chat-openers')).toBeInTheDocument();
    }
  );

  it("shows on the phone's Ask home too", () => {
    landed('no_credit');
    render(<AskHome variant="mobile" />);
    expect(note()).toHaveTextContent(FLOW_COPY.no_credit);
  });

  it.each(['denied', 'expired', 'failed', 'busy', 'unavailable'] as const)(
    'says nothing for %s: a sign-in that saved nothing is the setup column’s to say',
    (f) => {
      landed(f);
      render(<AskHome />);
      expect(note()).toBeNull();
    }
  );

  it('never beside "It works.": the card speaks', () => {
    seed(OPENROUTER, just({ provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' }));
    useAIConnectionStore.getState().setFlowResult('saved');
    render(<AskHome />);
    expect(card()).toBeInTheDocument();
    expect(note()).toBeNull();
  });

  it('goes when it is spent', () => {
    landed('saved');
    render(<AskHome />);
    expect(note()).toBeInTheDocument();
    act(() => void newChat(false));
    expect(flow()).toBeNull();
    expect(note()).toBeNull();
  });

  it.each<[string, () => void | Promise<void>]>([
    [
      'the first send, from any box',
      async () => {
        const id = useConversationsStore.getState().newDraft();
        void useConversationsStore.getState().send(id, 'hello');
        await flush();
      },
    ],
    ['New chat', () => void newChat(false)],
    [
      'a conversation opened',
      () => {
        useConversationsStore.setState((s) => ({
          summaries: { ...s.summaries, c1: summary({ id: 'c1', title: 'Plan for today' }) },
        }));
        openConversation('c1', false);
      },
    ],
    [
      'Ask closing',
      () => {
        useRailStore.getState().summon();
        useRailStore.getState().closeRail();
      },
    ],
    [
      'Ask parked',
      () => {
        useRailStore.getState().summon({ persist: false });
        useRailStore.getState().park();
      },
    ],
    ['a sign-out', () => useAIConnectionStore.getState().reset()],
  ])('is spent where the card is: %s', async (_, spend) => {
    landed('daily_limit');
    await act(async () => {
      await spend();
    });
    expect(flow()).toBeNull();
  });

  it('History is not a conversation: Back finds it still there', () => {
    landed('saved');
    act(() => useRailStore.getState().push('desktop', { kind: 'history' }));
    expect(flow()).toBe('saved');
  });
});

describe('copy', () => {
  it.each(['components/ai/ask/it-works-card.tsx', 'lib/connect-return.ts'])(
    '%s has no em dashes and never names the AI',
    (file) => {
      const src = readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
      expect(src).not.toContain('—');
      expect(src).not.toMatch(/\bBeacon\b/);
    }
  );
});
