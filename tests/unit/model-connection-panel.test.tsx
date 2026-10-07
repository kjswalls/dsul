import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * The Connect-a-model panel (components/settings/model-connection-panel.tsx)
 * and its model picker, rendered against the REAL connection store with a fake
 * server behind `fetch`.
 *
 * Four promises are pinned here, beyond the copy of every state:
 *
 *   1. The key is write-only from the browser's side. It is pasted or typed
 *      into a password field that holds it only in its value property (never
 *      an attribute), sent once in a PUT body that is exactly what the route
 *      expects, kept in the box on a refusal so it can be fixed, emptied out
 *      the moment it works, and never rendered anywhere.
 *   2. Every mount re-asks the server, even over a fresh answer: this pane is
 *      where an OpenClaw user lands after pairing.
 *   3. Deep links (and a search hit's "Set up") still land here, on the
 *      `data-setting-alias` anchors, in every state. With nothing connected
 *      the state is the connect card the setup column shows too (its own
 *      behaviour is connect-ai.test.tsx's); this is how the pane hosts it.
 *   4. The picker filters the provider's list itself and offers a typed id, but
 *      only one the server would accept.
 */

const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  params: new URLSearchParams(),
  pathname: '/settings/beacon',
}));

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.params,
}));
vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: async () => ({ error: null }),
    }),
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));
vi.mock('@/lib/settings-service', () => ({
  saveSettings: vi.fn(async () => {}),
  flushSettings: vi.fn(async () => {}),
}));

import { ModelConnectionPanel, connectErrorCopy } from '@/components/settings/model-connection-panel';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { chordLabel } from '@/lib/commands/keys';
import { DEFAULT_SHORTCUTS, useKeyboardShortcutsStore } from '@/lib/keyboard-shortcuts-store';
import type {
  AIConnectionResponse,
  ApiErrorCode,
  ModelConnectionView,
  ModelOption,
} from '@/lib/ai-types';
import {
  seedAI,
  AI_HIDDEN,
  CONNECTED_MODEL,
  NOTHING_CONNECTED,
  type SeedAI,
} from './helpers/ai-fixtures';

const SENTINEL = 'sk-test-SENTINEL-9876';
/** The free Google key the connect card leads with; its prefix makes it sure, so a paste checks it. */
const GEMINI_SENTINEL = 'AIzaSyTEST-SENTINEL-9876';
/** An OpenRouter key, for a sign-in replaced by a pasted key. */
const OPENROUTER_SENTINEL = 'sk-or-v1-SENTINEL-9876';

/* ── A fake server ──────────────────────────────────────────────────────── */

const CLAW_OFF = { gateway: false, pluginChat: false, agent: false, agentId: null };

function view(over: Partial<ModelConnectionView> = {}): ModelConnectionView {
  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    baseUrl: null,
    authMethod: 'key',
    status: 'ok',
    problem: null,
    checkedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    limitedUntil: null,
    modelLabel: null,
    ...over,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

interface Server {
  status: AIConnectionResponse | (() => Response);
  models: { models: ModelOption[]; listed: boolean } | (() => Response);
  put: (body: unknown) => Response | Promise<Response>;
  patch: (body: unknown) => Response;
  del: () => Response;
}

let server: Server;
let calls: Call[];

function respond(r: unknown | (() => Response)): Response {
  return typeof r === 'function' ? (r as () => Response)() : json(r);
}

beforeEach(() => {
  calls = [];
  nav.replace.mockReset();
  nav.push.mockReset();
  nav.params = new URLSearchParams();
  nav.pathname = '/settings/beacon';
  server = {
    status: { available: true, model: null, openclaw: CLAW_OFF, aiHidden: false },
    models: { models: [{ id: 'gpt-4o-mini', label: 'gpt-4o-mini' }], listed: true },
    put: () => json({ error: 'server' }, 503),
    patch: () => json({ error: 'server' }, 503),
    del: () => json({ ok: true }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url === '/api/ai/connection' && method === 'GET') return respond(server.status);
      if (url === '/api/ai/connection/models') return respond(server.models);
      if (url === '/api/ai/connection' && method === 'PUT') return server.put(body);
      if (url === '/api/ai/connection' && method === 'PATCH') return server.patch(body);
      if (url === '/api/ai/connection' && method === 'DELETE') return server.del();
      return json({ error: 'server' }, 404);
    })
  );
  // cmdk's list measures itself; jsdom has no ResizeObserver.
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

let cleanupAI: (() => void) | null = null;

afterEach(() => {
  cleanup();
  cleanupAI?.();
  cleanupAI = null;
  useUIStore.setState({ confirmRequest: null });
  vi.unstubAllGlobals();
});

/** Seed the store AND make the server say the same thing, so the mount refresh agrees. */
function given(seed: SeedAI, model: ModelConnectionView | null = null) {
  cleanupAI = seedAI(seed);
  const state = useAIConnectionStore.getState();
  if (model) act(() => useAIConnectionStore.setState({ model }));
  server.status = {
    available: state.available,
    model: model ?? state.model,
    openclaw: state.openclaw,
    aiHidden: state.aiHidden,
  };
}

const statusGets = () =>
  calls.filter((c) => c.url === '/api/ai/connection' && c.method === 'GET').length;

function renderPanel(o: { isMobile?: boolean; highlightId?: string } = {}) {
  return render(<ModelConnectionPanel isMobile={o.isMobile} highlightId={o.highlightId} />);
}

/** Ask's chord as the copy prints it on a PC (jsdom is not a Mac), from the binding, never typed. */
const askChord = (keys = DEFAULT_SHORTCUTS.find((b) => b.id === 'toggle_right_sidebar')!.keys) =>
  chordLabel(keys, false);

/** The switch form's key box ("Use a different provider"). */
const keyInput = () => screen.getByTestId('mcp-key') as HTMLInputElement;
/** The connect card's free-key box (the not-connected state). */
const geminiInput = () => screen.getByTestId('connect-key') as HTMLInputElement;

/** A paste, as the browser delivers one: the box reads the clipboard's text itself. */
function paste(input: HTMLElement, text: string) {
  fireEvent.paste(input, { clipboardData: { getData: () => text } });
}

/** Connected to `provider`'s key, with "Use a different provider" open. */
function openSwitch(over: Partial<ModelConnectionView> = {}) {
  given(CONNECTED_MODEL, view(over));
  renderPanel();
  fireEvent.click(screen.getByTestId('mcp-switch'));
  return screen.getByTestId('mcp-switch-panel');
}

/** No key in any attribute anywhere: a value property is the only place one may be. */
function expectNoKeyInMarkup(fragment: string) {
  expect(document.body.innerHTML).not.toContain(fragment);
  expect(JSON.stringify(useAIConnectionStore.getState())).not.toContain(fragment);
}

/* ── Mount ──────────────────────────────────────────────────────────────── */

describe('mounting', () => {
  it('re-asks the server once, even over a fresh answer', async () => {
    given(CONNECTED_MODEL, view());
    // Fresh: seeded a moment ago, well inside the five-minute window.
    expect(useAIConnectionStore.getState().fetchedAt).not.toBeNull();
    renderPanel();
    await waitFor(() => expect(statusGets()).toBe(1));
    // And it keeps the answer on screen meanwhile: no drop back to "Checking".
    expect(screen.queryByTestId('mcp-checking')).toBeNull();
    expect(screen.getByTestId('mcp-provider')).toHaveTextContent('OpenAI');
    // Still exactly one after things settle (the models GET is a different URL).
    await waitFor(() => expect(calls.some((c) => c.url === '/api/ai/connection/models')).toBe(true));
    expect(statusGets()).toBe(1);
  });

  it('is a section titled "Connect a model"', () => {
    given(NOTHING_CONNECTED);
    renderPanel();
    const section = screen.getByTestId('model-connection-panel');
    expect(section.tagName).toBe('SECTION');
    expect(within(section).getByRole('heading', { name: 'Connect a model' })).toBeInTheDocument();
  });
});

/* ── AI is off ──────────────────────────────────────────────────────────── */

// "No AI, thanks" for the account (lib/no-ai.ts). Until the pane's own switch
// (AI setup PR 7), this card is the way back once the strip's Undo is gone.
describe('AI is off', () => {
  beforeEach(() => toastMock.error.mockClear());

  it('says so above the connection, and turns AI back on, focus kept in the panel', async () => {
    given(AI_HIDDEN);
    server.patch = (body) => {
      if ((body as { hidden?: boolean }).hidden !== false) return json({ error: 'server' }, 503);
      server.status = { ...(server.status as AIConnectionResponse), aiHidden: false };
      return json({ aiHidden: false });
    };
    renderPanel();
    const card = screen.getByTestId('mcp-ai-off');
    expect(card).toHaveTextContent('AI is off');
    expect(card).toHaveTextContent(
      'dsul won’t show AI or bring it up again until you turn it back on here. Your planner works exactly the same.'
    );
    // Above the connect card, which stays as it is.
    const connect = screen.getByTestId('connect-ai');
    expect(card.compareDocumentPosition(connect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const button = within(card).getByRole('button', { name: 'Turn AI back on' });
    button.focus();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ hidden: false }]);
    expect(useAIConnectionStore.getState().aiHidden).toBe(false);
    expect(screen.queryByTestId('mcp-ai-off')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('model-connection-panel'));
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('a write the server refused leaves AI off, the card back, and says so', async () => {
    given(AI_HIDDEN);
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn AI back on' }));
    });
    await waitFor(() => expect(useAIConnectionStore.getState().aiHidden).toBe(true));
    expect(screen.getByTestId('mcp-ai-off')).toBeInTheDocument();
    expect(toastMock.error).toHaveBeenCalledWith('Couldn’t turn AI back on just now. Try again in a moment.');
  });

  it('a write that landed but whose answer was lost turns AI on, and says nothing failed', async () => {
    given(AI_HIDDEN);
    server.patch = () => {
      server.status = { ...(server.status as AIConnectionResponse), aiHidden: false };
      throw new TypeError('Failed to fetch');
    };
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn AI back on' }));
    });
    await waitFor(() => expect(useAIConnectionStore.getState().aiHidden).toBe(false));
    expect(screen.queryByTestId('mcp-ai-off')).toBeNull();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('is not there while AI is on', () => {
    given(NOTHING_CONNECTED);
    renderPanel();
    expect(screen.queryByTestId('mcp-ai-off')).toBeNull();
  });
});

/* ── States ─────────────────────────────────────────────────────────────── */

describe('before the server has answered', () => {
  it('unknown: a quiet checking card, and both anchors', () => {
    cleanupAI = seedAI();
    renderPanel();
    expect(screen.getByText('Checking your AI connection…')).toHaveAttribute('aria-live', 'polite');
    expect(document.querySelector('[data-setting-alias="beacon.apiKey"]')).not.toBeNull();
    expect(document.querySelector('[data-setting-alias="beacon.model"]')).not.toBeNull();
    // Nobody is signed in yet, so the mount refresh has no one to ask for.
    expect(statusGets()).toBe(0);
  });

  it('error: says so, and Try again asks again', async () => {
    cleanupAI = seedAI({ phase: 'error' });
    server.status = () => json({ error: 'server' }, 503);
    renderPanel();
    expect(await screen.findByText('Couldn’t check your AI connection.')).toBeInTheDocument();
    expect(document.querySelector('[data-setting-alias="beacon.apiKey"]')).not.toBeNull();

    await waitFor(() => expect(statusGets()).toBe(1));
    server.status = { available: true, model: null, openclaw: CLAW_OFF, aiHidden: false };
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('mcp-connect-fresh')).toBeInTheDocument());
    expect(statusGets()).toBe(2);
  });

  it('not available on this server: says so, and points at OpenClaw', async () => {
    given({ ...NOTHING_CONNECTED, available: false });
    renderPanel();
    expect(screen.getByTestId('mcp-unavailable')).toHaveTextContent(
      'Connecting a model isn’t available on this server yet.'
    );
    expect(screen.getByText('OpenClaw still works without it.')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-use-openclaw')).toHaveAttribute('href', '/docs/openclaw');
    // The env hint is for a developer's own machine only.
    expect(screen.queryByText(/MODEL_KEYS_ENCRYPTION_KEY/)).toBeNull();
    expect(screen.queryByTestId('connect-ai')).toBeNull();
    expect(document.querySelector('[data-setting-alias="beacon.apiKey"]')).not.toBeNull();
    expect(document.querySelector('[data-setting-alias="beacon.model"]')).not.toBeNull();
  });
});

describe('not connected', () => {
  it('is the connect card, the pane’s own, inside both anchors', () => {
    given(NOTHING_CONNECTED);
    renderPanel();
    const fresh = screen.getByTestId('mcp-connect-fresh');
    const card = within(fresh).getByTestId('connect-ai');
    expect(card).toHaveAttribute('data-connect-host', 'pane');
    expect(within(card).getByRole('heading', { name: 'Get a free key from Google' })).toBeInTheDocument();
    // None of the old fresh form: no provider chips, no "Or paste a key".
    expect(screen.queryByTestId('mcp-providers')).toBeNull();
    expect(screen.queryByTestId('mcp-key')).toBeNull();
    expect(screen.queryByText('Or paste a key')).toBeNull();

    // `beacon.model` wraps the card; `beacon.apiKey` lands on the free key's box.
    const modelAnchor = document.querySelector('[data-setting-alias="beacon.model"]')!;
    expect(modelAnchor).toBe(fresh);
    expect(modelAnchor.contains(card)).toBe(true);
    const keyAnchor = document.querySelector('[data-setting-alias="beacon.apiKey"]')!;
    expect(keyAnchor.contains(geminiInput())).toBe(true);
    expect(card.contains(keyAnchor)).toBe(true);

    const key = geminiInput();
    expect(key.type).toBe('password');
    expect(key.name).toBe('model-api-key');
    expect(key.autocomplete).toBe('off');
    expect(key).toHaveAttribute('spellcheck', 'false');
    expect(key).toHaveAttribute('autocapitalize', 'none');
    expect(key).toHaveAttribute('data-1p-ignore');
    expect(key).toHaveAttribute('data-lpignore', 'true');
    expect(screen.getByLabelText('Your Gemini key')).toBe(key);

    // Sign-in comes back here, not home.
    expect(screen.getByTestId('connect-openrouter-signin')).toHaveAttribute('href', '/api/ai/openrouter/start?r=settings');
    // Taking it back is done in this pane: no link to itself.
    const good = screen.getByTestId('connect-good-to-know');
    expect(good).toHaveTextContent('Disconnect here any time, and dsul deletes the key.');
    expect(within(good).queryByRole('link')).toBeNull();
  });

  it('a deep link rings the anchor it names', () => {
    given(NOTHING_CONNECTED);
    const view = renderPanel({ highlightId: 'beacon.apiKey' });
    expect(document.querySelector('[data-setting-alias="beacon.apiKey"]')).toHaveAttribute('data-highlight', 'true');
    expect(document.querySelector('[data-setting-alias="beacon.model"]')).not.toHaveAttribute('data-highlight');
    view.rerender(<ModelConnectionPanel highlightId="beacon.model" />);
    expect(document.querySelector('[data-setting-alias="beacon.model"]')).toHaveAttribute('data-highlight', 'true');
    expect(document.querySelector('[data-setting-alias="beacon.apiKey"]')).not.toHaveAttribute('data-highlight');
  });

  it('?start=openrouter unfolds the sign-in and focuses it, and never starts one', async () => {
    given(NOTHING_CONNECTED);
    nav.params = new URLSearchParams('start=openrouter');
    renderPanel();
    const fold = screen.getByTestId('connect-fold-openrouter');
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('connect-fold-openrouter-body')).not.toHaveAttribute('hidden');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('connect-openrouter-signin')));
    // A link from anywhere only unfolds: nothing navigates, nothing is asked of OpenRouter.
    expect(nav.replace).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.includes('openrouter'))).toBe(false);
  });

  it('?start=openrouter is spent once something is connected: a later connect card starts folded', async () => {
    given(CONNECTED_MODEL, view());
    nav.params = new URLSearchParams('start=openrouter');
    renderPanel();
    server.status = { available: true, model: null, openclaw: CLAW_OFF, aiHidden: false };
    fireEvent.click(screen.getByTestId('mcp-disconnect'));
    act(() => useUIStore.getState().resolveConfirm(true));
    await waitFor(() => expect(screen.getByTestId('mcp-connect-fresh')).toBeInTheDocument());
    expect(screen.getByTestId('connect-fold-openrouter')).toHaveAttribute('aria-expanded', 'false');
  });

  it('without ?start= every fold starts closed', () => {
    given(NOTHING_CONNECTED);
    renderPanel();
    expect(screen.getByTestId('connect-fold-openrouter')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('connect-fold-any')).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('connecting from the connect card', () => {
  function acceptPut(connection: ModelConnectionView, models: ModelOption[] = []) {
    server.put = () => json({ connection, models, listed: true });
    server.status = { available: true, model: connection, openclaw: CLAW_OFF, aiHidden: false };
  }
  const gemini = () => view({ provider: 'gemini', model: 'gemini-flash-latest' });

  it('a pasted Google key is checked at once, sent as exactly {provider, apiKey}, and never shown again', async () => {
    given(NOTHING_CONNECTED);
    acceptPut(gemini(), [{ id: 'gemini-flash-latest', label: 'Gemini Flash' }]);
    renderPanel();

    paste(geminiInput(), `  ${GEMINI_SENTINEL}  `);
    await waitFor(() => expect(screen.getByTestId('mcp-provider')).toHaveTextContent('Google Gemini'));
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({ provider: 'gemini', apiKey: GEMINI_SENTINEL });

    // Nowhere in the page, nor in the store, nor left in a box.
    expectNoKeyInMarkup('SENTINEL');
    expect(document.body.innerHTML).not.toContain('9876');
    for (const input of Array.from(document.querySelectorAll('input'))) {
      expect(input.value).not.toContain('SENTINEL');
    }

    // Once: the way in. Ask starts closed on the desktop, so it names each
    // way to open it, the chord through chordLabel ("Ctrl+J" here).
    const just = await screen.findByTestId('mcp-just-connected');
    expect(askChord()).toBe('Ctrl+J');
    expect(just).toHaveTextContent(
      `Connected. Open Ask with the Ask button or ${askChord()}, or type ? in the dock, to ask anything.`
    );
    fireEvent.click(within(just).getByRole('button', { name: 'Try it' }));
    expect(nav.push).toHaveBeenCalledWith('/');
    // The column's welcome is the column's: the pane says it in its own card.
    expect(useAIConnectionStore.getState().justConnected).toBeNull();
  });

  it('names Ask’s chord as rebound, and on the phone keeps to the dock', async () => {
    useKeyboardShortcutsStore.setState({ overrides: { toggle_right_sidebar: ['meta', 'shift', 'k'] } });
    try {
      given(NOTHING_CONNECTED);
      acceptPut(gemini());
      const desktop = renderPanel();
      paste(geminiInput(), GEMINI_SENTINEL);
      expect(await screen.findByTestId('mcp-just-connected')).toHaveTextContent(
        'Connected. Open Ask with the Ask button or Ctrl+Shift+K, or type ? in the dock, to ask anything.'
      );
      desktop.unmount();
      cleanupAI?.();

      // The phone has no chord to press, and its own Ask tab: the dock sentence.
      given(NOTHING_CONNECTED);
      acceptPut(gemini());
      renderPanel({ isMobile: true });
      paste(geminiInput(), GEMINI_SENTINEL);
      const phone = await screen.findByTestId('mcp-just-connected');
      expect(phone).toHaveTextContent('Connected. Type ? in the dock to ask anything.');
      expect(phone).not.toHaveTextContent(/Ctrl|Ask button/);
    } finally {
      useKeyboardShortcutsStore.setState({ overrides: {} });
    }
  });

  it('a refused key stays in its box, in our words, and nowhere else', async () => {
    given(NOTHING_CONNECTED);
    server.put = () => json({ error: 'key_rejected' }, 400);
    renderPanel();
    paste(geminiInput(), GEMINI_SENTINEL);
    const note = await screen.findByTestId('connect-note');
    expect(note).toHaveAttribute('data-code', 'key_rejected');
    expect(within(note).getByRole('alert')).toHaveTextContent(/^Google didn’t accept that key\./);
    expect(geminiInput().value).toBe(GEMINI_SENTINEL);
    expect(geminiInput().type).toBe('password');
    expectNoKeyInMarkup('SENTINEL');
    // Still the connect card: nothing was saved.
    expect(screen.getByTestId('mcp-connect-fresh')).toBeInTheDocument();
  });
});

describe('connecting from the switch form', () => {
  function acceptPut(connection: ModelConnectionView, models: ModelOption[] = []) {
    server.put = () => json({ connection, models, listed: true });
    server.status = { available: true, model: connection, openclaw: CLAW_OFF, aiHidden: false };
  }
  /** Connected to Anthropic, so the switch form preselects OpenAI. */
  const anthropic = { provider: 'anthropic', model: 'claude-sonnet-4-5' } as const;

  it('offers OpenRouter sign-in, back to this pane, and a key form', () => {
    const panel = openSwitch(anthropic);
    expect(
      within(panel).getByText('One account for hundreds of models, including free ones. Nothing to copy or paste.')
    ).toBeInTheDocument();
    const signIn = within(panel).getByTestId('mcp-openrouter-signin');
    expect(signIn).toHaveAttribute('href', '/api/ai/openrouter/start?r=settings');
    expect(within(panel).getByText('Or paste a key')).toBeInTheDocument();

    const group = within(panel).getByRole('radiogroup', { name: 'Provider' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual([
      'OpenAI',
      'Anthropic',
      'Google Gemini',
      'OpenRouter',
      'Other',
    ]);
    expect(within(group).getByRole('radio', { name: 'OpenAI' })).toHaveAttribute('aria-checked', 'true');

    const key = keyInput();
    expect(key.type).toBe('password');
    expect(key.name).toBe('model-api-key');
    expect(key.autocomplete).toBe('off');
    expect(key).toHaveAttribute('spellcheck', 'false');
    expect(key).toHaveAttribute('autocapitalize', 'none');
    expect(key).toHaveAttribute('data-1p-ignore');
    expect(key).toHaveAttribute('data-lpignore', 'true');
    expect(key.placeholder).toBe('sk-…');
    expect(screen.getByLabelText('API key')).toBe(key);

    const help = within(panel).getByRole('link', { name: /Get a key from OpenAI/ });
    expect(help).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
    expect(help).toHaveAttribute('target', '_blank');
    expect(help).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByTestId('mcp-connect')).toBeDisabled();
  });

  it('the provider chips are a radio group the arrow keys move through', () => {
    openSwitch(anthropic);
    const openai = screen.getByRole('radio', { name: 'OpenAI' });
    expect(openai).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Anthropic' })).toHaveAttribute('tabindex', '-1');
    openai.focus();
    fireEvent.keyDown(openai, { key: 'ArrowRight' });
    const anth = screen.getByRole('radio', { name: 'Anthropic' });
    expect(anth).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(anth);
    expect(keyInput().placeholder).toBe('sk-ant-…');
    fireEvent.keyDown(anth, { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByRole('radio', { name: 'OpenAI' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: 'Other' })).toHaveAttribute('aria-checked', 'true');
  });

  it('a provider change empties the box', () => {
    openSwitch(anthropic);
    fireEvent.change(keyInput(), { target: { value: SENTINEL } });
    expect(keyInput().value).toBe(SENTINEL);
    expect(screen.getByTestId('mcp-connect')).toBeEnabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Google Gemini' }));
    expect(keyInput().value).toBe('');
    expect(keyInput().placeholder).toBe('AQ.…');
    expect(screen.getByTestId('mcp-connect')).toBeDisabled();
  });

  it('Other asks for a base URL and an optional model, and has no key link', () => {
    openSwitch(anthropic);
    fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
    expect(screen.queryByRole('link', { name: /Get a key/ })).toBeNull();
    expect(keyInput().placeholder).toBe('Your API key');
    const url = screen.getByLabelText('Base URL') as HTMLInputElement;
    expect(url.placeholder).toBe('https://api.example.com/v1');
    expect(screen.getByText('Any OpenAI-compatible service. Public https addresses only.')).toBeInTheDocument();
    expect(screen.getByLabelText('Model (optional)')).toBeInTheDocument();
    expect(screen.getByText('Only needed if the service doesn’t list its models.')).toBeInTheDocument();

    // Key alone is not enough for Other.
    fireEvent.change(keyInput(), { target: { value: 'gsk_abcdefgh' } });
    expect(screen.getByTestId('mcp-connect')).toBeDisabled();
    fireEvent.change(url, { target: { value: 'https://api.groq.com/openai/v1' } });
    expect(screen.getByTestId('mcp-connect')).toBeEnabled();
    // A model name with a space is refused before it is sent.
    fireEvent.change(screen.getByLabelText('Model (optional)'), { target: { value: 'llama 3' } });
    expect(screen.getByText('Model names can’t contain spaces.')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-connect')).toBeDisabled();
  });

  it('sends exactly {provider, apiKey}, empties the box once it works, and never shows the key', async () => {
    openSwitch(anthropic);
    acceptPut(view(), [{ id: 'gpt-4o-mini', label: 'gpt-4o-mini' }]);
    fireEvent.change(keyInput(), { target: { value: `  ${SENTINEL}  ` } });
    fireEvent.click(screen.getByTestId('mcp-connect'));
    await waitFor(() => expect(screen.getByTestId('mcp-provider')).toHaveTextContent('OpenAI'));
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ provider: 'openai', apiKey: SENTINEL }]);
    // The card turns over when the store does; the switch form closes when
    // connect() itself resolves, a few ticks later on a slow runner.
    await waitFor(() => expect(screen.queryByTestId('mcp-switch-panel')).toBeNull());
    expectNoKeyInMarkup('SENTINEL');
    for (const input of Array.from(document.querySelectorAll('input'))) {
      expect(input.value).not.toContain('SENTINEL');
    }
    expect(await screen.findByTestId('mcp-just-connected')).toBeInTheDocument();
  });

  it('Enter in the box sends it too', async () => {
    openSwitch(anthropic);
    acceptPut(view());
    fireEvent.change(keyInput(), { target: { value: SENTINEL } });
    fireEvent.keyDown(keyInput(), { key: 'Enter' });
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
  });

  it('sends the base URL and the typed model for Other', async () => {
    openSwitch(anthropic);
    acceptPut(view({ provider: 'custom', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
    fireEvent.change(keyInput(), { target: { value: SENTINEL } });
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: ' https://api.groq.com/openai/v1 ' },
    });
    fireEvent.change(screen.getByLabelText('Model (optional)'), {
      target: { value: 'llama-3.1-8b-instant' },
    });
    fireEvent.click(screen.getByTestId('mcp-connect'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      provider: 'custom',
      apiKey: SENTINEL,
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.1-8b-instant',
    });
    // A custom host is named by its hostname, not "Other".
    await waitFor(() => expect(screen.getByTestId('mcp-provider')).toHaveTextContent('Other · api.groq.com'));
  });

  it('on a refusal: our words, the key kept in its box, and nowhere else', async () => {
    openSwitch(anthropic);
    server.put = () => json({ error: 'key_rejected' }, 400);
    fireEvent.change(keyInput(), { target: { value: SENTINEL } });
    fireEvent.click(screen.getByTestId('mcp-connect'));
    const alert = await screen.findByTestId('mcp-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('OpenAI didn’t accept that key. Check that you copied all of it.');
    // Kept, to be fixed: in the box's value, never in its markup.
    expect(keyInput().value).toBe(SENTINEL);
    expect(keyInput().type).toBe('password');
    expect(keyInput()).not.toHaveAttribute('value');
    expectNoKeyInMarkup('SENTINEL');
  });

  it('refuses what can’t be a key, or another company’s key, before anything is sent', async () => {
    openSwitch(anthropic);
    fireEvent.change(keyInput(), { target: { value: 'sk-ant-api03-SENTINEL-9876' } });
    fireEvent.click(screen.getByTestId('mcp-connect'));
    expect(await screen.findByTestId('mcp-error')).toHaveTextContent('That looks like an Anthropic key, not an OpenAI one.');
    fireEvent.change(keyInput(), { target: { value: 'sk-ab' } });
    fireEvent.click(screen.getByTestId('mcp-connect'));
    await waitFor(() =>
      expect(screen.getByTestId('mcp-error')).toHaveTextContent(
        'That doesn’t look like a whole key. Check that you copied all of it, and nothing else.'
      )
    );
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('says what the route read a key as, and when a used-up limit resets', async () => {
    usePlannerStore.setState({ userTimezone: 'UTC', timeFormat: '12h' } as never);
    openSwitch(anthropic);
    const answers = [
      json({ error: 'wrong_provider', detected: 'openrouter' }, 400),
      json({ error: 'daily_limit', limitedUntil: '2026-10-08T07:00:00.000Z' }, 429),
      json({ error: 'no_credit' }, 402),
      json({ error: 'region' }, 403),
    ];
    server.put = () => answers.shift()!;
    const submit = async (expected: string) => {
      fireEvent.change(keyInput(), { target: { value: `${SENTINEL}-${answers.length}` } });
      fireEvent.click(screen.getByTestId('mcp-connect'));
      await waitFor(() => expect(screen.getByTestId('mcp-error')).toHaveTextContent(expected));
    };
    await submit('That looks like an OpenRouter key, not an OpenAI one.');
    await submit(
      'OpenAI accepted the key, but today’s limit on it is used up. It resets at 7 am. Try again then, or use another key.'
    );
    await submit('OpenAI accepted the key, but the account behind it has no credit. Add credit there, then try again.');
    await submit('OpenAI won’t answer from where dsul’s server is right now. A different provider works instead.');
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(4);
  });

  it('Other with a base URL missing its /v1: both answers point at the URL', async () => {
    // The host 404s at {base}/models (read as "doesn't list its models"), then
    // at the 1-token ping once a model is typed (bad_model → invalid on model).
    openSwitch(anthropic);
    server.put = (body) =>
      (body as { model?: string }).model
        ? json({ error: 'invalid', field: 'model' }, 400)
        : json({ error: 'model_required' }, 400);
    fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.mistral.ai' } });
    fireEvent.change(keyInput(), { target: { value: SENTINEL } });
    fireEvent.click(screen.getByTestId('mcp-connect'));
    expect(await screen.findByTestId('mcp-error')).toHaveTextContent(
      /Check the base URL \(it usually ends in \/v1\), or add a model name above/
    );

    fireEvent.change(screen.getByLabelText('Model (optional)'), { target: { value: 'mistral-small-latest' } });
    fireEvent.click(screen.getByTestId('mcp-connect'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
    // The field the route named (`model`) reaches the copy.
    await waitFor(() =>
      expect(screen.getByTestId('mcp-error')).toHaveTextContent(
        'Nothing answered for that model at that address. Check the base URL (it usually ends in /v1) and the model name.'
      )
    );
    expect(screen.getByTestId('mcp-error').textContent).not.toMatch(/add a model name above|the fields/);
  });

  it('a refusal the route pins on one field names that field', async () => {
    openSwitch(anthropic);
    const answers = [
      json({ error: 'invalid', field: 'model' }, 400),
      json({ error: 'invalid', field: 'apiKey' }, 400),
      json({ error: 'invalid' }, 400),
    ];
    server.put = () => answers.shift()!;
    const submit = async (expected: string) => {
      fireEvent.change(keyInput(), { target: { value: `${SENTINEL}-${answers.length}` } });
      fireEvent.click(screen.getByTestId('mcp-connect'));
      await waitFor(() => expect(screen.getByTestId('mcp-error')).toHaveTextContent(expected));
    };
    await submit('Check the model name and try again.');
    await submit('That doesn’t look like a whole key. Check that you copied all of it, and nothing else.');
    await submit('Check the fields and try again.');
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(3);
  });

  it('shows "Checking key…" while the key is being verified, the box read-only, never disabled', async () => {
    openSwitch(anthropic);
    let release: (r: Response) => void = () => {};
    server.put = () => new Promise<Response>((resolve) => (release = resolve));
    fireEvent.change(keyInput(), { target: { value: SENTINEL } });
    fireEvent.click(screen.getByTestId('mcp-connect'));
    await waitFor(() => expect(screen.getByTestId('mcp-connect')).toHaveTextContent('Checking key…'));
    expect(screen.getByTestId('mcp-connect-form')).toHaveAttribute('aria-busy', 'true');
    expect(keyInput()).not.toBeDisabled();
    expect(keyInput()).toHaveAttribute('readonly');
    expect(keyInput()).toHaveAttribute('aria-busy', 'true');
    expect(document.activeElement).toBe(keyInput());
    await act(async () => release(json({ error: 'unreachable' }, 502)));
    expect(await screen.findByTestId('mcp-error')).toHaveTextContent('Couldn’t reach OpenAI. Try again in a moment.');
    expect(screen.getByTestId('mcp-connect-form')).not.toHaveAttribute('aria-busy');
    expect(keyInput()).not.toHaveAttribute('readonly');
  });
});

describe('error copy', () => {
  it('maps every code to our own words', () => {
    const cases: [ApiErrorCode, string][] = [
      ['key_rejected', 'Anthropic didn’t accept that key. Check that you copied all of it.'],
      ['unreachable', 'Couldn’t reach Anthropic. Try again in a moment.'],
      ['blocked_url', 'That address isn’t allowed. Use a public https address.'],
      [
        'model_required',
        'Nothing at that address listed its models. Check the base URL (it usually ends in /v1), or add a model name above and connect again.',
      ],
      ['busy', 'Too many tries. Wait a few minutes and try again.'],
      ['invalid', 'Check the fields and try again.'],
      ['conflict', 'Your connection changed in another tab. Reload this page.'],
      ['unavailable', 'Connecting a model isn’t available on this server yet.'],
      ['server', 'Something went wrong. Try again.'],
      ['unauthorized', 'Something went wrong. Try again.'],
    ];
    for (const [code, copy] of cases) expect(connectErrorCopy(code, 'Anthropic'), code).toBe(copy);
  });

  it('the codes a key’s check can now answer with', () => {
    const cases: [ApiErrorCode, Parameters<typeof connectErrorCopy>[2], string][] = [
      ['wrong_provider', { detected: 'openai' }, 'That looks like an OpenAI key, not an Anthropic one.'],
      ['wrong_provider', {}, 'That key looks like it’s for another service. Check that you copied the right one.'],
      [
        'no_credit',
        {},
        'Anthropic accepted the key, but the account behind it has no credit. Add credit there, then try again.',
      ],
      [
        'daily_limit',
        { resetsAt: '7 am' },
        'Anthropic accepted the key, but today’s limit on it is used up. It resets at 7 am. Try again then, or use another key.',
      ],
      [
        'daily_limit',
        {},
        'Anthropic accepted the key, but today’s limit on it is used up. Try again once it resets, or use another key.',
      ],
      ['region', {}, 'Anthropic won’t answer from where dsul’s server is right now. A different provider works instead.'],
      ['network', {}, 'Couldn’t reach Anthropic just now. Try again in a moment.'],
    ];
    for (const [code, ctx, copy] of cases) expect(connectErrorCopy(code, 'Anthropic', ctx), code).toBe(copy);
    // "a Google Gemini", "an OpenRouter": the article follows the name.
    expect(connectErrorCopy('wrong_provider', 'Google Gemini', { detected: 'openrouter' })).toBe(
      'That looks like an OpenRouter key, not a Google Gemini one.'
    );
  });

  it('an invalid on Other points at the base URL, and at the field the route named', () => {
    // A base URL missing its /v1 answers 404 at both /models and the 1-token
    // ping, which reached the user as "Check the fields" with nothing pointing
    // at the address.
    const other = (field: string | null) =>
      connectErrorCopy('invalid', 'api.mistral.ai', { custom: true, field });
    expect(other('model')).toBe(
      'Nothing answered for that model at that address. Check the base URL (it usually ends in /v1) and the model name.'
    );
    expect(other(null)).toBe('Check the base URL (it usually ends in /v1), the model name and the key.');
    expect(other('apiKey')).toBe(
      'That doesn’t look like a whole key. Check that you copied all of it, and nothing else.'
    );
    expect(other('baseUrl')).toBe('Check the base URL (it usually ends in /v1).');
    expect(connectErrorCopy('invalid', 'OpenAI', { field: 'apiKey' })).toBe(other('apiKey'));
    expect(connectErrorCopy('invalid', 'OpenAI', { field: 'baseUrl' })).toBe(other('baseUrl'));
  });

  it('a connect the route pins on the model says to check the model name, not "the fields"', () => {
    expect(connectErrorCopy('invalid', 'OpenAI', { field: 'model' })).toBe(
      'Check the model name and try again.'
    );
    // Unnamed, a built-in provider's form still has only "the fields" to point at.
    expect(connectErrorCopy('invalid', 'OpenAI', { field: null })).toBe('Check the fields and try again.');
  });

  it('Check again and the picker send no fields, so they never say "Check the fields"', () => {
    // The route names `model` when the key can't use the stored or picked one.
    for (const during of ['recheck', 'model'] as const) {
      expect(connectErrorCopy('invalid', 'llm.example.com', { during, field: 'model' }), during).toBe(
        'That model isn’t available to your key. Pick another.'
      );
    }
    // Unnamed, it was a request we sent wrong: nothing about the model to pick.
    expect(connectErrorCopy('invalid', 'Anthropic', { during: 'recheck' })).toBe(
      'Something went wrong. Try again.'
    );
    expect(connectErrorCopy('invalid', 'Anthropic', { during: 'model' })).toBe('Couldn’t save. Try again.');
    expect(connectErrorCopy('busy', 'Anthropic', { during: 'model' })).toBe(
      'Too many tries. Wait a few minutes and try again.'
    );
    expect(connectErrorCopy('key_rejected', 'Anthropic', { during: 'model' })).toBe(
      'Anthropic turned down your saved key.'
    );
    expect(connectErrorCopy('server', 'Anthropic', { during: 'model' })).toBe('Couldn’t save. Try again.');
    for (const during of ['recheck', 'model'] as const) {
      for (const code of ['invalid', 'model_required', 'server', 'busy'] as ApiErrorCode[]) {
        for (const field of [null, 'model', 'apiKey', 'baseUrl']) {
          expect(connectErrorCopy(code, 'X', { during, field }), `${during} ${code} ${field}`).not.toMatch(
            /the fields/
          );
        }
      }
    }
  });
});

describe('connected', () => {
  it('names the provider, says it works, and holds the model picker', async () => {
    given(CONNECTED_MODEL, view());
    renderPanel();
    expect(screen.getByTestId('mcp-provider')).toHaveTextContent('OpenAI');
    expect(screen.getByText(/Key saved/)).toHaveTextContent('Key saved · Checked 3 minutes ago');
    expect(screen.getByTestId('mcp-status')).toHaveTextContent('Working');
    expect(screen.getByTestId('model-picker')).toHaveTextContent('gpt-4o-mini');
    expect(screen.getByText('Replace key')).toBeInTheDocument();
    expect(screen.getByText('Use a different provider')).toBeInTheDocument();
    // Anchors: the status row and the picker.
    const keyAnchor = document.querySelector('[data-setting-alias="beacon.apiKey"]')!;
    expect(keyAnchor).toHaveTextContent('Key saved');
    const modelAnchor = document.querySelector('[data-setting-alias="beacon.model"]')!;
    expect(modelAnchor.contains(screen.getByTestId('model-picker'))).toBe(true);
    // No key field at all once connected, until asked for.
    expect(document.querySelector('input[type="password"]')).toBeNull();
    // Nothing in this state says Beacon.
    expect(screen.getByTestId('model-connection-panel').textContent).not.toMatch(/\bBeacon\b/);
  });

  it('OpenRouter by sign-in reads "Signed in"', () => {
    given(CONNECTED_MODEL, view({ provider: 'openrouter', authMethod: 'oauth', model: 'openai/gpt-4o-mini' }));
    renderPanel();
    expect(screen.getByTestId('mcp-provider')).toHaveTextContent('OpenRouter');
    expect(screen.getByText(/Signed in/)).toBeInTheDocument();
    // A sign-in has no key to replace.
    expect(screen.queryByText('Replace key')).toBeNull();
  });

  it('Check again sends the recheck', async () => {
    given(CONNECTED_MODEL, view());
    server.patch = () => json({ connection: view({ checkedAt: new Date().toISOString() }) });
    renderPanel();
    fireEvent.click(screen.getByTestId('mcp-recheck'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ recheck: true });
  });

  it('Check again on a retired model says so, not "Check the fields" on a card with none', async () => {
    given(
      CONNECTED_MODEL,
      view({ provider: 'custom', baseUrl: 'https://llm.example.com/v1', model: 'my-model' })
    );
    server.patch = () => json({ error: 'invalid', field: 'model' }, 400);
    renderPanel();
    fireEvent.click(screen.getByTestId('mcp-recheck'));
    expect(await screen.findByTestId('mcp-error')).toHaveTextContent(
      'That model isn’t available to your key. Pick another.'
    );
  });

  it('Replace key keeps the provider, the host and the model, and clears the field', async () => {
    given(CONNECTED_MODEL, view());
    server.put = () => json({ connection: view(), models: [], listed: true });
    renderPanel();
    fireEvent.click(screen.getByText('Replace key'));
    expect(
      screen.getByText('The new key replaces the old one. Your current one keeps working until this one passes.')
    ).toBeInTheDocument();
    const key = screen.getByTestId('mcp-replace-key') as HTMLInputElement;
    expect(key.type).toBe('password');
    fireEvent.change(key, { target: { value: SENTINEL } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      provider: 'openai',
      apiKey: SENTINEL,
      model: 'gpt-4o-mini',
    });
    await waitFor(() => expect(screen.queryByTestId('mcp-replace-form')).toBeNull());
    expectNoKeyInMarkup('SENTINEL');
  });

  it('Replace key keeps a refused key in its box, and refuses another company’s before sending', async () => {
    given(CONNECTED_MODEL, view());
    server.put = () => json({ error: 'key_rejected' }, 400);
    renderPanel();
    fireEvent.click(screen.getByText('Replace key'));
    const key = screen.getByTestId('mcp-replace-key') as HTMLInputElement;
    expect(key).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(key, { target: { value: 'sk-or-v1-SENTINEL-9876' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('mcp-error')).toHaveTextContent('That looks like an OpenRouter key, not an OpenAI one.');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    fireEvent.change(key, { target: { value: SENTINEL } });
    fireEvent.keyDown(key, { key: 'Enter' });
    await waitFor(() =>
      expect(screen.getByTestId('mcp-error')).toHaveTextContent('OpenAI didn’t accept that key. Check that you copied all of it.')
    );
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(key.value).toBe(SENTINEL);
    expect(key).not.toHaveAttribute('value');
    expectNoKeyInMarkup('SENTINEL');
  });

  it('Use a different provider opens the connect form, without the current one preselected', () => {
    given(CONNECTED_MODEL, view());
    renderPanel();
    fireEvent.click(screen.getByText('Use a different provider'));
    const panel = screen.getByTestId('mcp-switch-panel');
    expect(within(panel).getByText('Switch provider')).toBeInTheDocument();
    expect(within(panel).getByText('Connecting a different provider replaces this one.')).toBeInTheDocument();
    expect(within(panel).getByRole('radio', { name: 'Anthropic' })).toHaveAttribute('aria-checked', 'true');
  });

  it('with no model yet: asks for one, with the picker already open', async () => {
    given(CONNECTED_MODEL, view({ model: null }));
    renderPanel();
    expect(screen.getByText('Pick a model to finish connecting.')).toBeInTheDocument();
    expect(await screen.findByPlaceholderText(/Search .*models…/)).toBeInTheDocument();
  });

  it('says when chat is off on this device', () => {
    given({ ...CONNECTED_MODEL, choice: 'none' }, view());
    renderPanel();
    expect(
      screen.getByText('Chat is off on this device. Change it under Who answers in chat below.')
    ).toBeInTheDocument();
  });

  it('says when OpenClaw can answer too', () => {
    given({ ...CONNECTED_MODEL, openclaw: { gateway: true } }, view());
    renderPanel();
    expect(
      screen.getByText('OpenClaw is connected too. Choose who answers in chat below.')
    ).toBeInTheDocument();
  });

  it('Disconnect goes through confirm, and only then deletes', async () => {
    given(CONNECTED_MODEL, view());
    renderPanel();
    fireEvent.click(screen.getByTestId('mcp-disconnect'));
    const request = useUIStore.getState().confirmRequest!;
    expect(request).toMatchObject({
      title: 'Disconnect OpenAI?',
      description:
        'dsul will delete the saved key. Chat and plan suggestions hide until you connect again. Your saved conversations stay, and come back when you reconnect. The key stays active with OpenAI until you revoke it there.',
      confirmLabel: 'Disconnect',
      destructive: true,
      testId: 'model-disconnect-confirm',
    });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    server.status = { available: true, model: null, openclaw: CLAW_OFF, aiHidden: false };
    act(() => useUIStore.getState().resolveConfirm(true));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('mcp-connect-fresh')).toBeInTheDocument());
  });

  it('Disconnect names a custom host by its hostname, not "Other"', () => {
    given(
      CONNECTED_MODEL,
      view({ provider: 'custom', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' })
    );
    renderPanel();
    fireEvent.click(screen.getByTestId('mcp-disconnect'));
    expect(useUIStore.getState().confirmRequest).toMatchObject({
      title: 'Disconnect api.groq.com?',
      description:
        'dsul will delete the saved key. Chat and plan suggestions hide until you connect again. Your saved conversations stay, and come back when you reconnect. The key stays active with api.groq.com until you revoke it there.',
    });
    act(() => useUIStore.getState().resolveConfirm(false));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('failing', () => {
  it('a rejected key: says so, in our words, with the ways out', () => {
    given(CONNECTED_MODEL, view({ status: 'failing', problem: 'key_rejected' }));
    renderPanel();
    expect(screen.getByTestId('mcp-failing')).toHaveTextContent(
      'This key stopped working. OpenAI turned it down the last time dsul used it.'
    );
    expect(screen.getByTestId('mcp-failing')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('mcp-status')).toHaveTextContent('Stopped working');
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeInTheDocument();
    expect(screen.getByTestId('mcp-recheck')).toHaveTextContent('Check again');
    expect(screen.getByTestId('mcp-disconnect')).toHaveTextContent('Disconnect');
    // The failing explanation is where `beacon.apiKey` lands now.
    expect(
      document.querySelector('[data-setting-alias="beacon.apiKey"]')!.contains(screen.getByTestId('mcp-failing'))
    ).toBe(true);
    expect(document.querySelector('[data-setting-alias="beacon.model"]')).not.toBeNull();
    // A refused key is not asked for a model list.
    expect(calls.some((c) => c.url === '/api/ai/connection/models')).toBe(false);
  });

  it('a rejected key can be swapped for another provider, the saved one kept until it works', async () => {
    given(CONNECTED_MODEL, view({ status: 'failing', problem: 'key_rejected' }));
    renderPanel();
    const failing = screen.getByTestId('mcp-failing').parentElement!;
    const swap = within(failing).getByTestId('mcp-switch');
    expect(swap).toHaveTextContent('Use a different provider');
    fireEvent.click(swap);
    const panel = screen.getByTestId('mcp-switch-panel');
    expect(within(panel).getByRole('radio', { name: 'Anthropic' })).toHaveAttribute('aria-checked', 'true');

    const working = view({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
    server.put = () => json({ connection: working, models: [], listed: true });
    server.status = { available: true, model: working, openclaw: CLAW_OFF, aiHidden: false };
    fireEvent.change(keyInput(), { target: { value: 'sk-ant-api03-SENTINEL-9876' } });
    fireEvent.click(screen.getByTestId('mcp-connect'));
    await waitFor(() => expect(screen.getByTestId('mcp-status')).toHaveTextContent('Working'));
    expect(screen.getByTestId('mcp-provider')).toHaveTextContent('Anthropic');
    // As above: the form closes when connect() resolves, after the card turns.
    await waitFor(() => expect(screen.queryByTestId('mcp-switch-panel')).toBeNull());
    expectNoKeyInMarkup('SENTINEL');
  });

  it('a rejected sign-in offers to sign in again', () => {
    given(
      CONNECTED_MODEL,
      view({ provider: 'openrouter', authMethod: 'oauth', status: 'failing', problem: 'key_rejected' })
    );
    renderPanel();
    expect(screen.getByTestId('mcp-signin-again')).toHaveAttribute('href', '/api/ai/openrouter/start?r=settings');
    expect(screen.getByTestId('mcp-signin-again')).toHaveTextContent('Sign in again');
  });

  it('an unreadable key: connect it again', () => {
    given(CONNECTED_MODEL, view({ status: 'failing', problem: 'key_unreadable' }));
    renderPanel();
    expect(screen.getByTestId('mcp-failing')).toHaveTextContent(
      'dsul can’t read your saved key anymore. Connect it again.'
    );
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeInTheDocument();
    expect(screen.getByTestId('mcp-disconnect')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-recheck')).toBeNull();
  });

  for (const problem of ['key_rejected', 'key_unreadable'] as const) {
    it(`${problem}: Replace key never claims the current key "keeps working"`, () => {
      given(CONNECTED_MODEL, view({ status: 'failing', problem }));
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: 'Replace key' }));
      const help = screen.getByTestId('mcp-replace-help');
      expect(help).toHaveTextContent('Paste a new key from OpenAI. It’s checked before it’s saved.');
      expect(help.textContent).not.toMatch(/keeps working/);
    });
  }
});

describe('outside the desktop app', () => {
  it('a window focus asks nothing: the sign-in finishes on this page', async () => {
    given(NOTHING_CONNECTED);
    renderPanel();
    await waitFor(() => expect(statusGets()).toBe(1));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => {});
    expect(statusGets()).toBe(1);
  });
});

describe('in the desktop app', () => {
  // OpenRouter's sign-in can't finish inside the shell (its callback lands in
  // the system browser, away from the PKCE cookie), so the app never offers it.
  beforeEach(() => {
    (window as unknown as { dsulDesktop?: unknown }).dsulDesktop = { version: 1 };
  });
  afterEach(() => {
    delete (window as unknown as { dsulDesktop?: unknown }).dsulDesktop;
  });

  it('the connect card offers a link to copy instead of the sign-in, and ?start= unfolds nothing', () => {
    given(NOTHING_CONNECTED);
    nav.params = new URLSearchParams('start=openrouter');
    renderPanel();
    expect(screen.queryByTestId('connect-openrouter-signin')).toBeNull();
    expect(screen.getByTestId('connect-copy-link')).toBeInTheDocument();
    expect(screen.getByTestId('connect-fold-openrouter')).toHaveAttribute('aria-expanded', 'false');
  });

  it('the switch form offers the key form only, and says sign-in works from the browser', () => {
    openSwitch();
    expect(screen.queryByTestId('mcp-openrouter-signin')).toBeNull();
    expect(screen.queryByText('Or paste a key')).toBeNull();
    expect(screen.getByTestId('mcp-openrouter-browser')).toHaveTextContent(
      'To sign in with OpenRouter instead of pasting a key, connect from dsul in your browser. The connection works here too.'
    );
    expect(screen.getByTestId('mcp-connect-form')).toBeInTheDocument();
  });

  it('a rejected sign-in is replaced with a pasted OpenRouter key, not signed in again', async () => {
    const failing = view({
      provider: 'openrouter',
      authMethod: 'oauth',
      status: 'failing',
      problem: 'key_rejected',
      model: 'openai/gpt-4o-mini',
    });
    given(CONNECTED_MODEL, failing);
    server.put = () => json({ connection: view({ provider: 'openrouter', model: 'openai/gpt-4o-mini' }) });
    renderPanel();
    expect(screen.queryByTestId('mcp-signin-again')).toBeNull();
    // The way they connected in the first place still works, from the browser.
    expect(screen.getByTestId('mcp-signin-browser')).toHaveTextContent(
      'Or sign in to OpenRouter again from dsul in your browser. The connection works here too.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Replace key' }));
    // Someone who only ever signed in has no key yet: say where one comes from.
    expect(screen.getByRole('link', { name: 'Get a key from OpenRouter' })).toHaveAttribute(
      'href',
      'https://openrouter.ai/settings/keys'
    );
    const key = screen.getByTestId('mcp-replace-key') as HTMLInputElement;
    // The desktop app reads no clipboard: no [Paste], Ctrl+V into the box instead.
    expect(screen.queryByTestId('mcp-replace-key-paste')).toBeNull();
    fireEvent.change(key, { target: { value: OPENROUTER_SENTINEL } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      provider: 'openrouter',
      apiKey: OPENROUTER_SENTINEL,
      model: 'openai/gpt-4o-mini',
    });
  });

  it('asks again when the window comes back, so a browser sign-in shows up here', async () => {
    given(NOTHING_CONNECTED);
    renderPanel();
    await waitFor(() => expect(statusGets()).toBe(1));
    server.status = {
      available: true,
      model: view({ provider: 'openrouter', authMethod: 'oauth', model: 'openai/gpt-4o-mini' }),
      openclaw: CLAW_OFF,
      aiHidden: false,
    };
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.getByTestId('mcp-provider')).toHaveTextContent('OpenRouter'));
    expect(statusGets()).toBe(2);
  });

  it('Use a different provider: the key form, without the sign-in', () => {
    given(CONNECTED_MODEL, view());
    renderPanel();
    fireEvent.click(screen.getByTestId('mcp-switch'));
    expect(screen.getByTestId('mcp-connect-switch')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-openrouter-signin')).toBeNull();
  });
});

describe('the ?connect= notice', () => {
  const cases: [string, string][] = [
    ['ok', 'Signed in with OpenRouter. You’re connected.'],
    ['denied', 'OpenRouter sign-in was cancelled.'],
    ['expired', 'That sign-in took too long or was already used. Try again.'],
    ['failed', 'Couldn’t finish signing in to OpenRouter. Try again.'],
    ['busy', 'Too many tries. Wait a few minutes and try again.'],
    ['unavailable', 'Connecting a model isn’t available on this server yet.'],
    [
      'saved',
      'Signed in with OpenRouter. Its free models were busy, so the test question went unanswered. Try Ask in a minute.',
    ],
    [
      'no_credit',
      'Signed in with OpenRouter, but the account has no credit for the test question. Add credit on OpenRouter, or pick a free model in Settings.',
    ],
    [
      'daily_limit',
      'Signed in with OpenRouter, but today’s free limit on the account is used up. Ask works again once it resets.',
    ],
  ];
  for (const [value, copy] of cases) {
    it(`?connect=${value}`, async () => {
      given(NOTHING_CONNECTED);
      nav.params = new URLSearchParams(`connect=${value}`);
      renderPanel();
      expect(screen.getByTestId('mcp-flow-notice')).toHaveTextContent(copy);
      await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/settings/beacon'));
      // Once, and the notice outlives the cleaned URL.
      expect(nav.replace).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('mcp-flow-notice')).toHaveTextContent(copy);
    });
  }

  /** Mount on `?connect=<value>` and let the panel clean the URL, as the real page does. */
  async function landOn(value: string) {
    nav.params = new URLSearchParams(`connect=${value}`);
    renderPanel();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/settings/beacon'));
    nav.params = new URLSearchParams();
    expect(screen.getByTestId('mcp-flow-notice')).toBeInTheDocument();
  }

  it('goes once the user disconnects: "You’re connected" never sits over an empty form', async () => {
    given(CONNECTED_MODEL, view({ provider: 'openrouter', authMethod: 'oauth', model: 'openai/gpt-4o-mini' }));
    await landOn('ok');
    server.status = { available: true, model: null, openclaw: CLAW_OFF, aiHidden: false };
    fireEvent.click(screen.getByTestId('mcp-disconnect'));
    act(() => useUIStore.getState().resolveConfirm(true));
    await waitFor(() => expect(screen.getByTestId('mcp-connect-fresh')).toBeInTheDocument());
    expect(screen.queryByTestId('mcp-flow-notice')).toBeNull();
  });

  it('goes once another connect starts: a failed sign-in never sits over a working card', async () => {
    given(NOTHING_CONNECTED);
    const gemini = view({ provider: 'gemini', model: 'gemini-flash-latest' });
    server.put = () => json({ connection: gemini, models: [], listed: true });
    await landOn('failed');
    server.status = { available: true, model: gemini, openclaw: CLAW_OFF, aiHidden: false };
    paste(geminiInput(), GEMINI_SENTINEL);
    await waitFor(() => expect(screen.getByTestId('mcp-status')).toHaveTextContent('Working'));
    expect(screen.queryByTestId('mcp-flow-notice')).toBeNull();
  });

  it('cleans the address it was reached by: /settings/ai stays /settings/ai', async () => {
    given(NOTHING_CONNECTED);
    nav.pathname = '/settings/ai';
    nav.params = new URLSearchParams('connect=denied');
    renderPanel();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/settings/ai'));
    expect(nav.replace).toHaveBeenCalledTimes(1);
  });

  it('a sign-in that saved a connection asks for it; one that saved nothing does not', async () => {
    for (const [value, asks] of [
      ['ok', true],
      ['saved', true],
      ['no_credit', true],
      ['daily_limit', true],
      ['denied', false],
      ['failed', false],
    ] as const) {
      given(NOTHING_CONNECTED);
      const refresh = vi.spyOn(useAIConnectionStore.getState(), 'refresh');
      nav.replace.mockReset();
      nav.params = new URLSearchParams(`connect=${value}`);
      const view = renderPanel();
      await waitFor(() => expect(nav.replace, value).toHaveBeenCalled());
      // The mount's own ask, and for a saved one a second (which joins the first).
      expect(refresh, value).toHaveBeenCalledTimes(asks ? 2 : 1);
      view.unmount();
      refresh.mockRestore();
      cleanupAI?.();
      cleanupAI = null;
    }
  });

  it('goes once Check again starts', async () => {
    given(CONNECTED_MODEL, view({ provider: 'openrouter', authMethod: 'oauth', model: 'openai/gpt-4o-mini' }));
    server.patch = () =>
      json({ connection: view({ provider: 'openrouter', authMethod: 'oauth', model: 'openai/gpt-4o-mini' }) });
    await landOn('ok');
    fireEvent.click(screen.getByTestId('mcp-recheck'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    await waitFor(() => expect(screen.queryByTestId('mcp-flow-notice')).toBeNull());
  });

  it('stays through a model pick, which changes nothing it says', async () => {
    given(CONNECTED_MODEL, view({ provider: 'openrouter', authMethod: 'oauth', model: 'openai/gpt-4o-mini' }));
    server.models = { models: [{ id: 'openai/gpt-4o', label: 'GPT-4o' }], listed: true };
    server.patch = () =>
      json({ connection: view({ provider: 'openrouter', authMethod: 'oauth', model: 'openai/gpt-4o' }) });
    await landOn('ok');
    fireEvent.click(screen.getByTestId('model-picker'));
    await waitFor(() => expect(document.querySelector('[data-model-id="openai/gpt-4o"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-model-id="openai/gpt-4o"]')!);
    await waitFor(() => expect(screen.getByTestId('model-picker')).toHaveTextContent('GPT-4o'));
    expect(screen.getByTestId('mcp-flow-notice')).toHaveTextContent('Signed in with OpenRouter. You’re connected.');
  });

  it('ignores a value it does not know, and says nothing', () => {
    for (const value of ['<script>', 'constructor', 'toString', '']) {
      given(NOTHING_CONNECTED);
      nav.params = new URLSearchParams({ connect: value });
      const view = renderPanel();
      expect(screen.queryByTestId('mcp-flow-notice'), value).toBeNull();
      expect(nav.replace, value).not.toHaveBeenCalled();
      view.unmount();
      cleanupAI?.();
      cleanupAI = null;
    }
  });
});

/* ── The picker ─────────────────────────────────────────────────────────── */

describe('the model picker', () => {
  const OPENROUTER_LIST: ModelOption[] = [
    { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
    { id: 'meta-llama/llama-3.1-8b-instruct:free', label: 'Llama 3.1 8B', free: true },
    { id: 'anthropic/claude-opus-4', label: 'Claude Opus 4' },
  ];

  function openPicker() {
    given(
      CONNECTED_MODEL,
      view({ provider: 'openrouter', authMethod: 'oauth', model: 'openai/gpt-4o-mini' })
    );
    server.models = { models: OPENROUTER_LIST, listed: true };
    renderPanel();
    fireEvent.click(screen.getByTestId('model-picker'));
  }

  const rows = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-model-id]')).map((el) => el.dataset.modelId);

  it('lists the provider’s models and filters them by name or id', async () => {
    openPicker();
    const search = await screen.findByPlaceholderText('Search 3 models…');
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.change(search, { target: { value: 'LLAMA' } });
    expect(rows()).toEqual(['meta-llama/llama-3.1-8b-instruct:free']);
    fireEvent.change(search, { target: { value: 'anthropic/' } });
    expect(rows()).toEqual(['anthropic/claude-opus-4']);
    // Label, muted id, and the Free badge.
    fireEvent.change(search, { target: { value: '' } });
    const llama = document.querySelector('[data-model-id="meta-llama/llama-3.1-8b-instruct:free"]')!;
    expect(llama).toHaveTextContent('Llama 3.1 8B');
    expect(llama).toHaveTextContent('Free');
  });

  it('OpenRouter gets a Free only toggle', async () => {
    openPicker();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const toggle = screen.getByTestId('model-picker-free-only');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(rows()).toEqual(['meta-llama/llama-3.1-8b-instruct:free']);
  });

  it('selecting saves the model', async () => {
    openPicker();
    server.patch = (body) =>
      json({
        connection: view({
          provider: 'openrouter',
          authMethod: 'oauth',
          model: (body as { model: string }).model,
        }),
      });
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(document.querySelector('[data-model-id="anthropic/claude-opus-4"]')!);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-opus-4',
    });
    await waitFor(() =>
      expect(screen.getByTestId('model-picker')).toHaveTextContent('Claude Opus 4')
    );
  });

  it('offers a typed id the list does not have, and refuses one with a space', async () => {
    openPicker();
    const search = await screen.findByPlaceholderText('Search 3 models…');
    await waitFor(() => expect(rows()).toHaveLength(3));

    fireEvent.change(search, { target: { value: 'has space' } });
    expect(screen.getByTestId('model-picker-bad-id')).toHaveTextContent('Model names can’t contain spaces.');
    expect(screen.queryByTestId('model-picker-use-typed')).toBeNull();

    server.patch = () => json({ connection: view({ provider: 'openrouter', authMethod: 'oauth', model: 'brand-new/model' }) });
    fireEvent.change(search, { target: { value: 'brand-new/model' } });
    const use = screen.getByTestId('model-picker-use-typed');
    expect(use).toHaveTextContent('Use “brand-new/model”');
    fireEvent.click(use);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      provider: 'openrouter',
      model: 'brand-new/model',
    });
  });

  it('rolls back and says so when the save fails', async () => {
    openPicker();
    server.patch = () => json({ error: 'server' }, 503);
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(document.querySelector('[data-model-id="anthropic/claude-opus-4"]')!);
    expect(await screen.findByTestId('model-picker-error')).toHaveTextContent('Couldn’t save. Try again.');
    expect(screen.getByTestId('model-picker')).toHaveTextContent('GPT-4o mini');
  });

  it('a model the provider does not have, or a rate limit, never says "Try again" alone', async () => {
    // Anthropic looks a picked id up; a 404 there is 400 invalid on model. A
    // retry fails the same way, and spends a check token doing it.
    given(CONNECTED_MODEL, view({ provider: 'anthropic', model: 'claude-sonnet-4-0' }));
    server.models = { models: [{ id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' }], listed: true };
    server.patch = () => json({ error: 'invalid', field: 'model' }, 400);
    renderPanel();
    fireEvent.click(screen.getByTestId('model-picker'));
    const search = await screen.findByPlaceholderText('Search 1 models…');
    fireEvent.change(search, { target: { value: 'claude-sonnet-4.5' } });
    fireEvent.click(screen.getByTestId('model-picker-use-typed'));
    expect(await screen.findByTestId('model-picker-error')).toHaveTextContent(
      'That model isn’t available to your key. Pick another.'
    );
    expect(screen.getByTestId('model-picker')).toHaveTextContent('claude-sonnet-4-0');

    server.patch = () => json({ error: 'busy' }, 429);
    fireEvent.click(screen.getByTestId('model-picker'));
    fireEvent.change(await screen.findByPlaceholderText('Search 1 models…'), {
      target: { value: 'claude-sonnet-4.5' },
    });
    fireEvent.click(screen.getByTestId('model-picker-use-typed'));
    await waitFor(() =>
      expect(screen.getByTestId('model-picker-error')).toHaveTextContent(
        'Too many tries. Wait a few minutes and try again.'
      )
    );
  });

  it('a failed list can be asked again', async () => {
    given(CONNECTED_MODEL, view());
    server.models = () => json({ error: 'unreachable' }, 502);
    renderPanel();
    fireEvent.click(screen.getByTestId('model-picker'));
    expect(await screen.findByText('Couldn’t load the model list.')).toBeInTheDocument();
    server.models = { models: [{ id: 'gpt-4o', label: 'gpt-4o' }], listed: true };
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(rows()).toEqual(['gpt-4o']));
  });

  it('a host that lists nothing gets a typed field instead', async () => {
    given(
      CONNECTED_MODEL,
      view({ provider: 'custom', baseUrl: 'https://llm.example.com/v1', model: 'my-model' })
    );
    server.models = { models: [], listed: false };
    renderPanel();
    fireEvent.click(screen.getByTestId('model-picker'));
    const form = await screen.findByTestId('model-picker-typed');
    const field = within(form).getByLabelText('Model') as HTMLInputElement;
    expect(field.value).toBe('my-model');
    fireEvent.change(field, { target: { value: 'my model' } });
    expect(within(form).getByText('Model names can’t contain spaces.')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
