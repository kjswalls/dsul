import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The setup column (components/ai/rail/ask-setup.tsx): the right column while
 * nothing answers but the AI gate offers to set AI up (`askInvite`) or to fix
 * a saved model (`askFix`). When it shows and how it opens are the rail's
 * (rail-desktop.test.tsx, ai-gating-desktop.test.tsx, open-chat.test.ts);
 * this is what it says and what "No AI, thanks" does.
 *
 *  - Setup home: the greeting, what the person could ask now (the chips Ask
 *    would offer today, quoted, nothing to press), and the connect card
 *    (its own behaviour is connect-ai.test.tsx's).
 *  - Fix home: the saved connection, what is wrong in plain words, a box for
 *    a new key, and a fresh check where one can help (the box's own behaviour
 *    is connect-fix.test.tsx's).
 *  - The foot: "No AI, thanks" closes the column, hides AI for the account at
 *    once, and says so in the undo strip, in prose, with focus on Undo; Undo
 *    takes it back, and a write that fails takes the strip down.
 */

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn() }));
vi.mock('@/components/primitives/relay-field', () => ({ RelayField: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { AskSetup, SETUP_MODEL_HREF, SETUP_SETTINGS_HREF, fixCopy } from '@/components/ai/rail/ask-setup';
import { UndoStrip } from '@/components/notices/undo-strip';
import { AI_OFF_FAILED, AI_OFF_LABEL, AI_OFF_STRIP_MS, AI_STILL_OFF_LABEL } from '@/lib/no-ai';
import { useAIConnectionStore, getAICapabilities, useAICapabilities } from '@/lib/ai-connection-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useRailStore } from '@/lib/rail-store';
import { useSessionUserStore } from '@/lib/session-user-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useUndoStripStore } from '@/lib/undo-strip-store';
import { useLookStore } from '@/lib/look-store';
import type { ModelConnectionView } from '@/lib/ai-types';
import type { Item } from '@/lib/planner-types';
import { seedAI, KEY_TURNED_DOWN, NOTHING_CONNECTED, type SeedAI } from './helpers/ai-fixtures';

const TODAY = '2026-10-07';
/** 19:30 UTC: evening, so the openers look back at today and ahead to tomorrow. */
const EVENING = Date.parse('2026-10-07T19:30:00.000Z');
/** 09:00 UTC: morning. */
const MORNING = Date.parse('2026-10-07T09:00:00.000Z');

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

function setItems(items: Item[]) {
  usePlannerStore.setState({ items, tasks: items.filter((i) => i.type !== 'habit') } as never);
}

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

/**
 * The connection route, as far as these tests need it: GET the gate (with the
 * account's ai_hidden as last written), PATCH {hidden}, and PATCH {recheck},
 * which answers whatever `recheckReply` says. `patchStatus` refuses a hidden
 * write; `dropAfterLanding` lands it and then loses the answer, as a
 * connection that drops on the way back does.
 */
let patchStatus = 200;
let dropAfterLanding = false;
let serverHidden = false;
const patches: unknown[] = [];
type Reply = { status: number; body: unknown };
let recheckReply: Reply = { status: 502, body: { error: 'unreachable' } };
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  if (method === 'PATCH') {
    const body = JSON.parse(String(init?.body ?? 'null')) as { hidden?: boolean; recheck?: boolean };
    patches.push(body);
    if (body.recheck) {
      const { status, body: reply } = recheckReply;
      return { ok: status < 300, status, json: async () => reply };
    }
    if (dropAfterLanding) {
      serverHidden = body.hidden === true;
      throw new TypeError('Failed to fetch');
    }
    if (patchStatus !== 200) return { ok: false, status: patchStatus, json: async () => ({ error: 'unavailable' }) };
    serverHidden = body.hidden === true;
    return { ok: true, status: 200, json: async () => ({ aiHidden: body.hidden }) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      available: true,
      model: null,
      openclaw: { gateway: false, pluginChat: false, agent: false, agentId: null },
      aiHidden: serverHidden,
    }),
  };
});

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
  patches.length = 0;
  patchStatus = 200;
  dropAfterLanding = false;
  serverHidden = false;
  toastMock.error.mockClear();
  recheckReply = { status: 502, body: { error: 'unreachable' } };
  usePlannerStore.setState({
    items: [],
    tasks: [],
    routines: [],
    seasons: [],
    userTimezone: 'UTC',
  } as never);
  useSessionUserStore.setState({
    user: { id: 'u1', email: 'k@example.com', displayName: 'Kirby Example', avatarUrl: null },
  });
  useRailStore.getState().reset();
  useUndoStripStore.setState({ entry: null });
  useSidebarStore.setState({ askOpen: false, leftSidebarOpen: false });
  useLookStore.setState({ layout: 'classic' });
  seed(NOTHING_CONNECTED);
});

afterEach(() => {
  cleanup();
  unseed();
  unseed = () => {};
  useSessionUserStore.setState({ user: null });
  useUndoStripStore.setState({ entry: null });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const column = () => document.querySelector('[data-ask-setup]') as HTMLElement;
const previewIds = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-preview]'), (el) => el.dataset.preview);

describe('the setup home', () => {
  it('greets, previews what could be asked, and shows the way to connect: nothing in it is Ask', () => {
    setItems([task('Fix the squeaky door', { startDate: '2026-10-01' })]);
    render(<AskSetup visible />);
    expect(column()).toHaveAttribute('data-ask-setup', 'invite');
    expect(column()).toHaveAccessibleName('Set up AI');
    expect(within(column()).getByRole('heading', { level: 2 })).toHaveTextContent(/^Set up AI$/);
    // The unlit mark leads the header; History and New chat are not there.
    expect(column().querySelector('[data-ask-heading] [data-ask-mark]')).toHaveAttribute('data-lit', 'false');
    // Outside the connect card: ✕ and No AI, thanks, nothing else.
    const card = screen.getByTestId('connect-ai');
    expect(
      within(column())
        .getAllByRole('button')
        .filter((b) => !card.contains(b))
        .map((b) => b.getAttribute('aria-label') ?? b.textContent)
    ).toEqual(['Close', 'No AI, thanks']);
    expect(column().querySelector('[data-ask-greeting]')).toHaveTextContent('Evening, Kirby.');

    // Evening, with something sitting: the three Ask would offer, in its order.
    expect(previewIds()).toEqual(['plan-tomorrow', 'let-go', 'review']);
    const previews = screen.getByTestId('setup-previews');
    expect(previews).toHaveTextContent('What you could ask now');
    expect(previews).toHaveTextContent('“Plan tomorrow”');
    expect(previews).toHaveTextContent(
      'Goes through things that have waited a while, like “Fix the squeaky door”, and helps you keep them or let them go.'
    );
    expect(previews).toHaveTextContent('Each becomes one click once AI is connected.');
    // Previews, not chips: nothing in them to press.
    expect(within(previews).queryAllByRole('button')).toEqual([]);
    expect(within(previews).queryAllByRole('link')).toEqual([]);
    expect(screen.queryByTestId('chat-openers')).toBeNull();

    // The way in, right here: the connect card, after the previews, the
    // column's own (sign-in returns home, the only Settings link is Good to know's).
    expect(card).toHaveAttribute('data-connect-host', 'column');
    expect(previews.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId('setup-connect')).toBeNull();
    expect(screen.getByTestId('connect-openrouter-signin').getAttribute('href')).toBe('/api/ai/openrouter/start?r=home');
    expect(within(screen.getByTestId('connect-good-to-know')).getByRole('link', { name: 'Settings → AI' })).toHaveAttribute(
      'href',
      '/settings/ai'
    );
    // Settings → AI by its alias wherever the column names it.
    expect(SETUP_SETTINGS_HREF).toBe('/settings/ai?focus=beacon.apiKey');
    expect(SETUP_MODEL_HREF).toBe('/settings/ai?focus=beacon.model');

    // None of Ask's own markers: those mean "Ask is on screen".
    for (const sel of ['[data-rail-view]', '[data-ask-home]', '[data-ask-composer]', 'textarea']) {
      expect(document.querySelector(sel), sel).toBeNull();
    }
  });

  it("previews the morning's offers on a new account, with nothing sitting", () => {
    vi.setSystemTime(MORNING);
    render(<AskSetup visible />);
    expect(previewIds()).toEqual(['plan', 'reflect']);
    expect(screen.getByTestId('setup-previews')).toHaveTextContent('“Plan my day”');
    expect(column().querySelector('[data-ask-greeting]')).toHaveTextContent('Morning, Kirby.');
  });

  it('pins the foot: AI is optional, and No AI, thanks', () => {
    render(<AskSetup visible />);
    const foot = column().querySelector('[data-ask-setup-foot]') as HTMLElement;
    expect(foot).toHaveTextContent('AI is optional. dsul works fully without it.');
    expect(within(foot).getByRole('button', { name: 'No AI, thanks' })).toBeInTheDocument();
    // Outside the scroller, so it stays put while the home scrolls; a rule, never a fade.
    expect(column().querySelector('[data-ask-setup-scroller]')).not.toContainElement(foot);
    expect(column().querySelector('[data-ask-setup-scroller]')).toHaveClass('overflow-y-auto');
    expect(foot.className).not.toMatch(/opacity|mask|gradient/);
  });

  it('is hidden and inert while not shown, and painted but inert while it eases out', () => {
    const { rerender } = render(<AskSetup visible={false} />);
    expect(column()).toHaveAttribute('hidden');
    expect(column()).toHaveAttribute('inert');
    rerender(<AskSetup visible={false} leaving />);
    expect(column()).not.toHaveAttribute('hidden');
    expect(column()).toHaveAttribute('inert');
    rerender(<AskSetup visible />);
    expect(column()).not.toHaveAttribute('hidden');
    expect(column()).not.toHaveAttribute('inert');
  });
});

describe('the fix home', () => {
  const failing = (over: Partial<ModelConnectionView>): SeedAI => ({
    ...KEY_TURNED_DOWN,
    model: { ...KEY_TURNED_DOWN.model, ...over },
  });

  it('names the connection and says the key was turned down, with a box for a new key and a fresh check', async () => {
    seed(KEY_TURNED_DOWN);
    render(<AskSetup visible />);
    expect(column()).toHaveAttribute('data-ask-setup', 'fix');
    expect(within(column()).getByRole('heading', { level: 2 })).toHaveTextContent(/^Fix AI$/);
    const fix = screen.getByTestId('setup-fix');
    expect(within(fix).getByRole('heading', { level: 3 })).toHaveTextContent(/^Google Gemini$/);
    // Turned down at the seed's checkedAt, six and a bit days before this evening.
    expect(screen.getByTestId('fix-line')).toHaveTextContent(/^Key saved · Google turned it down 7 days ago$/);
    expect(fix).toHaveTextContent(
      'Google stopped accepting your key, so AI can’t answer right now. Paste a new one and Ask picks up where it left off.'
    );
    expect(within(fix).getByLabelText('New Gemini key')).toBe(screen.getByTestId('fix-key'));
    // Everything else is in Settings → AI, by its alias, outside the card.
    const caption = screen.getByTestId('fix-caption');
    expect(fix).not.toContainElement(caption);
    expect(within(caption).getByRole('link', { name: 'Settings → AI' })).toHaveAttribute('href', '/settings/ai');
    // No previews and no connect card here: the fix is the point.
    expect(screen.queryByTestId('setup-previews')).toBeNull();
    expect(screen.queryByTestId('connect-ai')).toBeNull();

    // The check, through the store and the route's own answers. A key still
    // turned down is not a failed request: the route checked, and answers
    // with the connection as it stands, still failing.
    const status = screen.getByTestId('fix-status');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toBeEmptyDOMElement();
    const press = () =>
      act(async () => {
        fireEvent.click(within(fix).getByRole('button', { name: 'Check the old key again' }));
      });
    recheckReply = { status: 200, body: { connection: { ...KEY_TURNED_DOWN.model, baseUrl: null, authMethod: 'key', checkedAt: null } } };
    await press();
    expect(patches).toEqual([{ recheck: true }]);
    expect(status).toHaveTextContent('Google still turns it down. A new key above fixes it.');

    // An answer about the provider, not the key, says which.
    recheckReply = { status: 502, body: { error: 'unreachable' } };
    await press();
    expect(status).toHaveTextContent('Google couldn’t answer the test question just now. Check again in a moment.');
    recheckReply = { status: 403, body: { error: 'region' } };
    await press();
    expect(status).toHaveTextContent(
      'Google won’t answer from where dsul’s server is right now. A key from another service works instead, in Settings → AI.'
    );

    // A check that could not be made says so, and nothing about the key.
    recheckReply = { status: 500, body: { error: 'server' } };
    await press();
    expect(status).toHaveTextContent('Couldn’t check it just now. Try again in a moment.');

    // Working again: nothing to fix, the gate lights and the column becomes Ask.
    recheckReply = {
      status: 200,
      body: { connection: { ...KEY_TURNED_DOWN.model, status: 'ok', problem: null, baseUrl: null, authMethod: 'key', checkedAt: null } },
    };
    await press();
    expect(getAICapabilities().canChat).toBe(true);
    expect(screen.queryByTestId('setup-fix')).toBeNull();
    expect(patches).toHaveLength(5);
  });

  it('offers no fresh check for a key dsul cannot read, nor for a missing model', () => {
    seed(failing({ problem: 'key_unreadable' }));
    const { unmount } = render(<AskSetup visible />);
    expect(screen.getByTestId('setup-fix')).toHaveTextContent(
      'dsul can’t read your saved key anymore, so AI can’t answer right now. Paste it again and Ask picks up where it left off.'
    );
    expect(screen.getByTestId('fix-line')).toHaveTextContent(/^Key saved · Needs attention$/);
    expect(screen.queryByTestId('setup-recheck')).toBeNull();
    // A box to paste it into, all the same.
    expect(screen.getByTestId('fix-key')).toBeInTheDocument();
    unmount();

    seed({ ...KEY_TURNED_DOWN, model: { provider: 'openai', model: null, status: 'ok', problem: null } });
    render(<AskSetup visible />);
    const fix = screen.getByTestId('setup-fix');
    expect(fix).toHaveTextContent('OpenAI');
    expect(fix).toHaveTextContent('No model picked');
    expect(within(fix).getByRole('link', { name: 'Pick a model in Settings → AI' })).toHaveAttribute('href', SETUP_MODEL_HREF);
    expect(screen.queryByTestId('setup-recheck')).toBeNull();
    expect(screen.queryByTestId('fix-key')).toBeNull();
  });

  it('an OpenRouter sign-in is a sign-in, never a key to paste', () => {
    const oauth = (problem: 'key_rejected' | 'key_unreadable') =>
      fixCopy({
        provider: 'openrouter',
        model: 'openrouter/auto',
        baseUrl: null,
        authMethod: 'oauth',
        status: 'failing',
        problem,
        checkedAt: null,
        limitedUntil: null,
        modelLabel: null,
      });
    expect(oauth('key_rejected').note).toBe(
      'OpenRouter stopped accepting your sign-in, so AI can’t answer right now. Sign in again and Ask picks up where it left off.'
    );
    expect(oauth('key_unreadable').note).toBe(
      'dsul can’t read your saved sign-in anymore, so AI can’t answer right now. Sign in again and Ask picks up where it left off.'
    );
    for (const problem of ['key_rejected', 'key_unreadable'] as const) {
      const copy = oauth(problem);
      expect(`${copy.note} ${copy.check} ${copy.still}`).not.toMatch(/\bkey\b|[Pp]aste/);
    }
    expect(oauth('key_rejected').check).toBe('Check again');
    expect(oauth('key_rejected').still).toBe('OpenRouter still turns it down. Signing in again fixes it.');
  });

  it('keeps the check focusable while it runs, and ignores a second press', async () => {
    seed(KEY_TURNED_DOWN);
    render(<AskSetup visible />);
    const button = screen.getByTestId('setup-recheck');
    let answer: (v: unknown) => void = () => {};
    recheckReply = { status: 200, body: { connection: { ...KEY_TURNED_DOWN.model, baseUrl: null, authMethod: 'key', checkedAt: null } } };
    const slow = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementationOnce(async (url, init) => {
      await new Promise((r) => (answer = r));
      return slow(url, init);
    });
    button.focus();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button).toHaveTextContent('Checking…');
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(document.activeElement).toBe(button);
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => answer(null));
    expect(patches).toEqual([{ recheck: true }]);
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(document.activeElement).toBe(button);
  });

  it('names a custom address by its host, or "Your service", never "Other"', () => {
    const custom = (baseUrl: string | null) =>
      fixCopy({
        provider: 'custom',
        model: 'm',
        baseUrl,
        authMethod: 'key',
        status: 'failing',
        problem: 'key_rejected',
        checkedAt: null,
        limitedUntil: null,
        modelLabel: null,
      });
    expect(custom('https://llm.example.com/v1').note).toMatch(/^llm\.example\.com stopped accepting your key/);
    expect(custom(null).note).toMatch(/^Your service stopped accepting your key/);
    for (const copy of [custom('https://llm.example.com/v1'), custom(null)]) {
      expect(`${copy.note} ${copy.still}`).not.toMatch(/\bOther\b/);
    }
  });
});

/** Stands in for the header's key: drawn while the gate offers setup. */
function FakeKey() {
  const { askInvite } = useAICapabilities();
  return askInvite ? <button data-ask-opener="">Set up AI</button> : null;
}

describe('No AI, thanks', () => {
  /** The column summoned, the strip in its dock beside it, and the key. */
  const renderOpen = () => {
    act(() => useRailStore.getState().summon({ persist: false }));
    return render(
      <>
        <FakeKey />
        <AskSetup visible />
        <div data-dock-surface="">
          <UndoStrip />
        </div>
      </>
    );
  };
  const strip = () => screen.queryByTestId('undo-strip');
  const dock = () => document.querySelector('[data-dock-surface]');
  const key = () => document.querySelector('[data-ask-opener]');
  const pressNoAI = () =>
    act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'No AI, thanks' }));
    });
  const pressUndo = () =>
    act(async () => {
      fireEvent.click(within(strip() as HTMLElement).getByRole('button', { name: 'Undo' }));
    });
  /** Let the store's re-read and the focus hand-off (a 0ms timer, then 16ms polls) settle. */
  const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

  it('closes the column, hides AI at once, and says so in the strip, with focus on Undo', async () => {
    renderOpen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'No AI, thanks' }));
    });
    // The account's answer, applied at once and written.
    expect(useAIConnectionStore.getState().aiHidden).toBe(true);
    expect(getAICapabilities().askInvite).toBe(false);
    expect(patches).toEqual([{ hidden: true }]);
    // The column goes, and stays gone through Undo: nothing is summoned.
    expect(useRailStore.getState().summoned).toBe(false);
    // The strip, in prose (the UI face, not the numeric one), with focus on Undo.
    expect(strip()).toHaveTextContent(AI_OFF_LABEL);
    expect(AI_OFF_LABEL).toBe('AI is off. dsul won’t bring it up again.');
    const undo = within(strip() as HTMLElement).getByRole('button', { name: 'Undo' });
    expect(document.activeElement).toBe(undo);
    expect(undo.className).not.toMatch(/font-num/);
    expect((strip() as HTMLElement).innerHTML).not.toMatch(/font-num/);
    // The dock it lives in is shown, so the strip is on screen.
    expect(useSidebarStore.getState().leftSidebarOpen).toBe(true);
  });

  it('Undo writes it back, and leaves the planner history alone', async () => {
    const plannerUndo = vi.fn();
    usePlannerStore.setState({ canUndo: true, undo: plannerUndo } as never);
    renderOpen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'No AI, thanks' }));
    });
    await act(async () => {
      fireEvent.click(within(strip() as HTMLElement).getByRole('button', { name: 'Undo' }));
    });
    expect(patches).toEqual([{ hidden: true }, { hidden: false }]);
    expect(useAIConnectionStore.getState().aiHidden).toBe(false);
    expect(getAICapabilities().askInvite).toBe(true);
    expect(plannerUndo).not.toHaveBeenCalled();
    expect(strip()).toBeNull();
    // Undo restores the answer, not the column.
    expect(useRailStore.getState().summoned).toBe(false);
  });

  it('Undo is described by the sentence it takes back', async () => {
    renderOpen();
    await pressNoAI();
    const undo = within(strip() as HTMLElement).getByRole('button', { name: 'Undo' });
    expect(undo).toHaveAccessibleDescription(AI_OFF_LABEL);
  });

  it('a write the server refused: the strip goes, focus follows the key, and a toast says so', async () => {
    patchStatus = 503;
    renderOpen();
    await pressNoAI();
    await settle();
    expect(strip()).toBeNull();
    expect(useAIConnectionStore.getState().aiHidden).toBe(false);
    expect(getAICapabilities().askInvite).toBe(true);
    expect(document.activeElement).toBe(key());
    expect(toastMock.error).toHaveBeenCalledWith(AI_OFF_FAILED);
    expect(AI_OFF_FAILED).toBe('Couldn’t turn AI off just now. Try again in a moment.');
  });

  it('a write that landed but whose answer was lost: the server says off, so the strip and Undo stay', async () => {
    dropAfterLanding = true;
    renderOpen();
    await pressNoAI();
    await settle();
    expect(serverHidden).toBe(true);
    expect(useAIConnectionStore.getState().aiHidden).toBe(true);
    expect(strip()).toHaveTextContent(AI_OFF_LABEL);
    expect(key()).toBeNull();
    expect(toastMock.error).not.toHaveBeenCalled();
    // And its Undo still takes it back.
    dropAfterLanding = false;
    await pressUndo();
    await settle();
    expect(serverHidden).toBe(false);
    expect(useAIConnectionStore.getState().aiHidden).toBe(false);
  });

  it('an Undo the server refused brings the row back, AI still off, and its Undo tries again', async () => {
    renderOpen();
    await pressNoAI();
    patchStatus = 503;
    await pressUndo();
    await settle();
    expect(useAIConnectionStore.getState().aiHidden).toBe(true);
    expect(strip()).toHaveTextContent(AI_STILL_OFF_LABEL);
    expect(AI_STILL_OFF_LABEL).toBe('Couldn’t turn AI back on just now. AI is still off.');
    const undo = within(strip() as HTMLElement).getByRole('button', { name: 'Undo' });
    expect(document.activeElement).toBe(undo);
    patchStatus = 200;
    await pressUndo();
    await settle();
    expect(patches).toEqual([{ hidden: true }, { hidden: false }, { hidden: false }]);
    expect(useAIConnectionStore.getState().aiHidden).toBe(false);
    expect(strip()).toBeNull();
    expect(document.activeElement).toBe(key());
  });

  it('Undo hands focus to the key once it is drawn', async () => {
    renderOpen();
    await pressNoAI();
    await pressUndo();
    await settle();
    expect(document.activeElement).toBe(key());
  });

  it("an action-log row's Undo, clicked, leaves focus where it always has: the dock takes only a row that took focus", async () => {
    renderOpen();
    act(() => useUndoStripStore.getState().show({ id: 'log-3', label: 'Complete task: A', durationMs: 5000 }));
    within(strip() as HTMLElement).getByRole('button', { name: 'Undo' }).focus();
    act(() => useUndoStripStore.getState().dismiss('log-3'));
    expect(document.activeElement).not.toBe(dock());
  });

  it('an Undo refused after the user moved on brings the row back without taking their focus', async () => {
    render(<input aria-label="Somewhere else" />);
    renderOpen();
    await pressNoAI();
    patchStatus = 503;
    let answer: (v: unknown) => void = () => {};
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementationOnce(async (url, init) => {
      await new Promise((r) => (answer = r));
      return base(url, init);
    });
    await pressUndo();
    await settle();
    const field = screen.getByRole('textbox', { name: 'Somewhere else' });
    field.focus();
    await act(async () => answer(null));
    await settle();
    expect(strip()).toHaveTextContent(AI_STILL_OFF_LABEL);
    expect(document.activeElement).toBe(field);
  });

  it('says nothing failed when the user took it back while a refused hide was still out', async () => {
    renderOpen();
    // The hide is held, then refused; the Undo queued behind it lands.
    let answer: (v: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(async (_url, init) => {
      patches.push(JSON.parse(String(init?.body ?? 'null')));
      await new Promise((r) => (answer = r));
      return { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) };
    });
    await pressNoAI();
    await pressUndo();
    await act(async () => answer(null));
    await settle();
    expect(patches).toEqual([{ hidden: true }, { hidden: false }]);
    expect(useAIConnectionStore.getState().aiHidden).toBe(false);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('goes when the planner moves, so the next Ctrl+Z is the edit, not AI', async () => {
    renderOpen();
    await pressNoAI();
    expect(strip()).toHaveTextContent(AI_OFF_LABEL);
    const at = usePlannerStore.getState().historyIndex;
    act(() => usePlannerStore.setState({ historyIndex: at + 1 } as never));
    expect(strip()).toBeNull();
    expect(useAIConnectionStore.getState().aiHidden).toBe(true);
    usePlannerStore.setState({ historyIndex: at } as never);
  });

  it('a row that leaves without Undo hands focus to the dock, never to <body>', async () => {
    renderOpen();
    await pressNoAI();
    // ✕
    await act(async () => {
      fireEvent.click(within(strip() as HTMLElement).getByRole('button', { name: 'Dismiss' }));
    });
    expect(strip()).toBeNull();
    expect(document.activeElement).toBe(dock());
    // Focus the user put elsewhere is left where it is.
    const elsewhere = screen.getByRole('button', { name: 'No AI, thanks' });
    act(() => useUndoStripStore.getState().show({ id: 'log-2', label: 'Delete task: Swim', durationMs: 5000 }));
    elsewhere.focus();
    act(() => useUndoStripStore.getState().dismiss('log-2'));
    expect(document.activeElement).toBe(elsewhere);
  });

  it('leaves on its own after its time, and a newer row is never taken down by its clock', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(EVENING);
    renderOpen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'No AI, thanks' }));
    });
    expect(strip()).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(AI_OFF_STRIP_MS - 1);
    });
    expect(strip()).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(strip()).toBeNull();
    // Focus was on its Undo: the dock has it now, not <body>.
    expect(document.activeElement).toBe(dock());

    // A planner row raised meanwhile outlives the AI-off row's clock.
    useUndoStripStore.setState({ entry: null });
    useAIConnectionStore.setState({ aiHidden: false });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'No AI, thanks' }));
    });
    act(() => useUndoStripStore.getState().show({ id: 'log-1', label: 'Delete task: Swim', durationMs: 5000 }));
    await act(async () => {
      vi.advanceTimersByTime(AI_OFF_STRIP_MS);
    });
    expect(strip()).toHaveAttribute('data-undo-id', 'log-1');
  });
});

describe('the column’s rules', () => {
  const statusGets = () => fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === 'GET').length;
  const paste = (input: HTMLElement, text: string) =>
    fireEvent.paste(input, { clipboardData: { getData: () => text } });

  it('asks the server again on window focus in the desktop app, only while it shows', async () => {
    const w = window as unknown as { dsulDesktop?: unknown };
    w.dsulDesktop = { version: 1 };
    try {
      const { rerender } = render(<AskSetup visible={false} />);
      fetchMock.mockClear();
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      // Hidden under an item: it asks nothing.
      expect(statusGets()).toBe(0);
      rerender(<AskSetup visible />);
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(statusGets()).toBe(1);
    } finally {
      delete w.dsulDesktop;
    }
  });

  it('asks nothing on window focus in a browser, where a sign-in comes back to this page', async () => {
    render(<AskSetup visible />);
    fetchMock.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(statusGets()).toBe(0);
  });

  it('has nothing lime in it, in either home, whatever is open or said', async () => {
    const lime = () => Array.from(column().querySelectorAll<HTMLElement>('[class*="bg-primary"]'));
    const { unmount } = render(<AskSetup visible />);
    expect(lime()).toEqual([]);
    // Every fold open in turn, the custom service too, and a note with actions.
    fireEvent.click(screen.getByTestId('connect-fold-openrouter'));
    expect(lime()).toEqual([]);
    fireEvent.click(screen.getByTestId('connect-fold-any'));
    fireEvent.click(screen.getByTestId('connect-custom-toggle'));
    expect(lime()).toEqual([]);
    paste(screen.getByTestId('connect-key'), 'sk-ant-api03-SENTINEL-9876');
    expect(screen.getByTestId('connect-note')).toHaveAttribute('data-note', 'wrong');
    fireEvent.change(screen.getByTestId('connect-any-key'), { target: { value: 'sk-SENTINEL-9876' } });
    expect(screen.getByTestId('connect-chooser')).toBeInTheDocument();
    expect(lime()).toEqual([]);
    unmount();

    seed(KEY_TURNED_DOWN);
    render(<AskSetup visible />);
    fireEvent.change(screen.getByTestId('fix-key'), { target: { value: 'AIzaSyTEST-SENTINEL-9876' } });
    expect(screen.getByTestId('fix-submit')).toBeInTheDocument();
    expect(lime()).toEqual([]);
  });
});

describe('its copy', () => {
  // Whole files, comments and all: a string-picking regex misses JSX text set
  // on its own line, which is most of the column's copy. Neither file has an
  // em dash anywhere, so none may arrive. (no-beacon-copy.test.ts walks the
  // AST for "Beacon" across the app; this is the column's own check.)
  it.each(['components/ai/rail/ask-setup.tsx', 'lib/no-ai.ts'])('%s has no em dashes and never names the AI', (file) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    expect(src).not.toMatch(/—/);
    expect(src).not.toMatch(/\bBeacon\b/);
  });
});
