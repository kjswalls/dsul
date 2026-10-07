import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * The phone's setup page (components/mobile/setup-tab.tsx): the Ask tab while
 * nothing answers but the AI gate invites or offers the fix. When the shell
 * shows it is the shell's (ai-gating-mobile-item.test.tsx, which mocks this
 * page); the connect card's own behaviour is connect-ai.test.tsx's. This is
 * its order, its foot, and what it is not.
 *
 *  - Invite: the capsule's word and the user menu, the greeting, YOUR
 *    QUESTION when one was kept (above the card), the card leading, two
 *    previews under the folds when nothing is kept, Good to know once, and
 *    the foot at the end of the page, whose No AI is the phone's.
 *  - Fix: "Fix AI", and the fix home.
 *  - Never Ask: none of Ask's markers, no conversation list warmed, no box.
 */

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }) }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn() }));
vi.mock('@/components/primitives/relay-field', () => ({ RelayField: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
const chooseNoAI = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/no-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/no-ai')>()),
  chooseNoAI,
}));

import { SetupTab } from '@/components/mobile/setup-tab';
import { ASK_CLAIMED_KEY, __resetKeptForTests, clearKeptQuestionState, keepQuestion, readKept } from '@/lib/ask-pending';
import { usePlannerStore } from '@/lib/planner-store';
import { useRailStore } from '@/lib/rail-store';
import { useSessionUserStore } from '@/lib/session-user-store';
import type { Item } from '@/lib/planner-types';
import { seedAI, KEY_TURNED_DOWN, NOTHING_CONNECTED, SEED_USER_ID, type SeedAI } from './helpers/ai-fixtures';

const TODAY = '2026-10-07';
/** 19:30 UTC: evening, so the openers look back at today and ahead to tomorrow. */
const EVENING = Date.parse('2026-10-07T19:30:00.000Z');
const KEPT = 'what should I do first';

const task = (id: string, over: Record<string, unknown> = {}): Item =>
  ({
    type: 'task',
    id,
    title: id,
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    startDate: TODAY,
    ...over,
  }) as Item;

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

/** The gate's read, the only call this page makes; the url is kept for the check that nothing else is asked. */
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>(async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    available: true,
    model: null,
    openclaw: { gateway: false, pluginChat: false, agent: false, agentId: null },
    aiHidden: false,
  }),
}));

let unseed: () => void = () => {};
const seed = (o?: SeedAI) => {
  unseed();
  unseed = seedAI(o);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EVENING);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  chooseNoAI.mockClear();
  const items = [task('Fix the squeaky door', { startDate: '2026-10-01' })];
  usePlannerStore.setState({ items, tasks: items, routines: [], seasons: [], userTimezone: 'UTC' } as never);
  useSessionUserStore.setState({
    user: { id: 'u1', email: 'k@example.com', displayName: 'Kirby Example', avatarUrl: null },
  });
  useRailStore.getState().reset();
  seed(NOTHING_CONNECTED);
});

afterEach(() => {
  cleanup();
  unseed();
  unseed = () => {};
  clearKeptQuestionState();
  localStorage.removeItem(ASK_CLAIMED_KEY);
  __resetKeptForTests();
  useSessionUserStore.setState({ user: null });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const page = () => document.querySelector('[data-setup-tab]') as HTMLElement;
const scroller = () => page().querySelector('[data-setup-scroller]') as HTMLElement;
const capsule = () => page().querySelector('[data-surface-header]') as HTMLElement;
const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
/** In document order, each after the last. */
const inOrder = (...nodes: Node[]) => nodes.every((n, i) => i === 0 || follows(nodes[i - 1], n));
const previewIds = () => Array.from(document.querySelectorAll<HTMLElement>('[data-preview]'), (el) => el.dataset.preview);
const renderTab = () => render(<SetupTab headerAccessory={<button type="button">User menu</button>} />);

describe('inviting', () => {
  it('the capsule says Set up AI beside the user menu, then the greeting, the card, two previews, Good to know and the foot', () => {
    renderTab();
    expect(page()).toHaveAttribute('data-setup-tab', 'invite');
    // The word and the menu: no mark in the capsule (F17), no History, no "+".
    expect(within(capsule()).getByRole('heading', { level: 2 })).toHaveTextContent(/^Set up AI$/);
    expect(within(capsule()).getAllByRole('button').map((b) => b.textContent)).toEqual(['User menu']);
    expect(capsule().querySelector('[data-ask-mark]')).toBeNull();

    const greeting = scroller().querySelector('[data-ask-greeting]') as HTMLElement;
    expect(greeting).toHaveTextContent('Evening, Kirby.');
    const connect = screen.getByTestId('connect-ai');
    expect(connect).toHaveAttribute('data-connect-host', 'column');
    expect(connect).toHaveAttribute('data-layout', 'phone');

    // The key card leads; the previews, two of them, come under the folds.
    const previews = screen.getByTestId('setup-previews');
    expect(previewIds()).toEqual(['plan-tomorrow', 'let-go']);
    expect(previews).toHaveTextContent('Each becomes one click once AI is connected.');
    const foot = scroller().querySelector('[data-setup-foot]') as HTMLElement;
    expect(
      inOrder(
        greeting,
        screen.getByTestId('connect-key-card'),
        screen.getByTestId('connect-folds'),
        previews,
        screen.getByTestId('connect-good-to-know'),
        foot
      )
    ).toBe(true);
    expect(screen.getAllByTestId('connect-good-to-know')).toHaveLength(1);
    expect(screen.queryByTestId('setup-question')).toBeNull();

    // The foot closes the page: inside the scroller, its last line.
    expect(scroller().lastElementChild).toBe(foot);
    expect(foot).toHaveTextContent('AI is optional. dsul works fully without it.');
    expect(within(foot).getByRole('button', { name: 'No AI, thanks' })).toBeInTheDocument();

    // A sign-in comes back here, to the tab.
    expect(screen.getByTestId('connect-fold-openrouter-body')).toHaveTextContent(
      'OpenRouter opens in this tab and sends you back here.'
    );
  });

  it('with a question kept: YOUR QUESTION between the greeting and the card, and no previews', () => {
    expect(keepQuestion(KEPT)).toBe(true);
    renderTab();
    const question = screen.getByTestId('setup-question');
    expect(question).toHaveTextContent('Your question');
    expect(screen.getByTestId('setup-question-text')).toHaveTextContent(/^“what should I do first”$/);
    expect(question).toHaveTextContent('It’s kept here, and sent once AI is connected.');
    expect(
      inOrder(scroller().querySelector('[data-ask-greeting]')!, question, screen.getByTestId('connect-key-card'))
    ).toBe(true);
    expect(screen.queryByTestId('setup-previews')).toBeNull();
    expect(screen.getByTestId('connect-key-card')).toHaveTextContent(
      'dsul checks it with one tiny test question, then asks yours.'
    );
  });

  it('Clear takes the question back, the previews return under the folds, and focus goes to the key card’s title', async () => {
    keepQuestion(KEPT);
    renderTab();
    const clear = screen.getByRole('button', { name: 'Clear your question' });
    clear.focus();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    fireEvent.click(clear);
    expect(readKept(SEED_USER_ID)).toBeNull();
    expect(screen.queryByTestId('setup-question')).toBeNull();
    expect(previewIds()).toEqual(['plan-tomorrow', 'let-go']);
    await act(() => new Promise((r) => setTimeout(r, 0)));
    // What takes its place on the phone is the card, not previews a screen
    // below; its title, not its box, which would raise the keyboard unasked.
    const title = within(screen.getByTestId('connect-key-card')).getByRole('heading', { name: 'Get a free key from Google' });
    expect(title).toHaveAttribute('data-setup-card-heading');
    expect(document.activeElement).toBe(title);
    expect(document.activeElement).not.toBe(screen.getByTestId('connect-key'));
    // Scrolled to, wherever the page was: no preventScroll.
    const call = focus.mock.contexts.indexOf(title);
    expect(call).toBeGreaterThanOrEqual(0);
    expect(focus.mock.calls[call][0]?.preventScroll).not.toBe(true);
    focus.mockRestore();
  });

  it('No AI, thanks is the phone’s: it leaves the desktop’s braindump alone', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'No AI, thanks' }));
    expect(chooseNoAI).toHaveBeenCalledTimes(1);
    expect(chooseNoAI).toHaveBeenCalledWith({ phone: true });
  });

  it('has nothing lime in it', () => {
    keepQuestion(KEPT);
    renderTab();
    fireEvent.paste(screen.getByTestId('connect-key'), { clipboardData: { getData: () => 'AIzaSyTEST-SENTINEL-9876' } });
    expect(screen.getByTestId('connect-submit')).toHaveTextContent('Connect and ask');
    fireEvent.click(screen.getByTestId('connect-fold-openrouter'));
    expect(Array.from(page().querySelectorAll('[class*="bg-primary"]'))).toEqual([]);
  });
});

describe('fixing', () => {
  it('the capsule says Fix AI, and the fix home shows, foot and all', () => {
    seed(KEY_TURNED_DOWN);
    keepQuestion(KEPT);
    renderTab();
    expect(page()).toHaveAttribute('data-setup-tab', 'fix');
    expect(within(capsule()).getByRole('heading', { level: 2 })).toHaveTextContent(/^Fix AI$/);
    expect(screen.getByTestId('setup-fix')).toBeInTheDocument();
    expect(screen.getByTestId('fix-key')).toBeInTheDocument();
    expect(screen.queryByTestId('connect-ai')).toBeNull();
    expect(screen.queryByTestId('setup-previews')).toBeNull();
    // A question kept while it invited is not the fix home's to show.
    expect(screen.queryByTestId('setup-question')).toBeNull();
    expect(scroller().querySelector('[data-setup-foot]')).toHaveTextContent('No AI, thanks');
  });
});

describe('never Ask', () => {
  it('wears none of Ask’s markers, warms no conversation list, and has no box', () => {
    renderTab();
    expect(page()).toBeInTheDocument();
    for (const sel of [
      '[data-ask-tab]',
      '[data-ask-home]',
      '[data-ask-setup]',
      '[data-rail-view]',
      '[data-ask-composer]',
      '[data-ask-heading]',
      'textarea',
    ]) {
      expect(document.querySelector(sel), sel).toBeNull();
    }
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('conversations'))).toEqual([]);
  });

  it('drops a composer request left from before, which would take the caret into the next box unasked', () => {
    act(() => useRailStore.getState().focusComposer());
    renderTab();
    expect(useRailStore.getState().pendingFocus).toBeNull();
  });
});
