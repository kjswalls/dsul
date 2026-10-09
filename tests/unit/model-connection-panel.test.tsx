import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * Settings → AI's Connection section (components/settings/model-connection-panel.tsx)
 * and its model picker, rendered against the REAL connection store with a fake
 * server behind `fetch`. The pane around it (What AI does, Use AI in dsul, the
 * AI-off card, OpenClaw, On this device) is ai-pane.test.tsx's.
 *
 * Five promises are pinned here, beyond the copy of every state:
 *
 *   1. The key is write-only from the browser's side. It is pasted or typed
 *      into a password field that holds it only in its value property (never
 *      an attribute), sent once in a PUT body that is exactly what the route
 *      expects, kept in the box on a refusal so it can be fixed, emptied out
 *      the moment it works, and never rendered anywhere.
 *   2. Every mount re-asks the server, even over a fresh answer: this pane is
 *      where an OpenClaw user lands after pairing.
 *   3. Deep links (and a search hit's "Set up") still land here, on the
 *      `data-setting-alias` anchors: both anchors, exactly once each, in every
 *      state the panel draws, and it draws nothing while AI is off. With
 *      nothing connected the state is the connect card the setup column shows
 *      too (its own behaviour is connect-ai.test.tsx's); this is how the pane
 *      hosts it. A key turned down is the fix card (connect-fix.test.tsx).
 *   4. The pill and the body are separate: a check in flight turns only the
 *      pill to "Checking…", and the card under it (with whatever was typed
 *      into it) stays mounted.
 *   5. The picker filters the provider's list itself and offers a typed id, but
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelConnectionPanel, connectErrorCopy } from '@/components/settings/model-connection-panel';
import { goodToKnowCopy, limitCopy } from '@/components/ai/connect/connect-shared';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { modelName } from '@/lib/ai-model-names';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { chordLabel } from '@/lib/commands/keys';
import { resetClock } from '@/lib/format-chat-timestamp';
import { DEFAULT_SHORTCUTS, useKeyboardShortcutsStore } from '@/lib/keyboard-shortcuts-store';
import {
  PROVIDER_META,
  type AIConnectionResponse,
  type ApiErrorCode,
  type ModelConnectionView,
  type ModelOption,
} from '@/lib/ai-types';
import {
  seedAI,
  AI_OFF_CONNECTED,
  CONNECTED_MODEL,
  DAILY_LIMIT,
  GEMINI_WORKING,
  KEY_TURNED_DOWN,
  NO_MODEL_PICKED,
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

/** The switch form's key box ("Use a different service"). */
/** The connect card's free-key box (the not-connected state). */
const geminiInput = () => screen.getByTestId('connect-key') as HTMLInputElement;

/** A paste, as the browser delivers one: the box reads the clipboard's text itself. */
function paste(input: HTMLElement, text: string) {
  fireEvent.paste(input, { clipboardData: { getData: () => text } });
}

/** Connected to `provider`'s key, with "Use a different service" open. */
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

  it('is a section titled "Connection", its pill flush right on the heading’s row', () => {
    given(NOTHING_CONNECTED);
    renderPanel();
    const section = screen.getByTestId('model-connection-panel');
    expect(section.tagName).toBe('SECTION');
    const heading = within(section).getByRole('heading', { name: 'Connection' });
    expect(heading).toHaveAttribute('id', 'mcp-title');
    expect(section).toHaveAttribute('aria-labelledby', 'mcp-title');
    const pill = screen.getByTestId('mcp-status');
    expect(pill).toHaveTextContent('Not set up');
    expect(pill).toHaveAttribute('data-tone', 'grey');
    expect(pill.parentElement).toBe(heading.parentElement);
    expect(pill.parentElement!.className).toMatch(/justify-between/);
  });
});

/* ── AI is off ──────────────────────────────────────────────────────────── */

// "No AI, thanks" for the account (lib/no-ai.ts). The pane's own card says
// what is still connected (ai-pane.test.tsx); this section draws nothing then.
describe('AI is off', () => {
  it('draws nothing, though the mount still asks the server', async () => {
    given(AI_OFF_CONNECTED);
    renderPanel();
    expect(screen.queryByTestId('model-connection-panel')).toBeNull();
    await waitFor(() => expect(statusGets()).toBe(1));
    expect(screen.queryByTestId('model-connection-panel')).toBeNull();
    expect(screen.queryByTestId('mcp-ai-off')).toBeNull();
    expect(document.querySelector('[data-setting-alias]')).toBeNull();
  });

  it('never draws the AI-off card itself, on or off', () => {
    given(NOTHING_CONNECTED);
    renderPanel();
    expect(screen.getByTestId('model-connection-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-ai-off')).toBeNull();
  });

  it('comes back when AI is turned back on, with the connection as it was', async () => {
    given(AI_OFF_CONNECTED);
    renderPanel();
    await waitFor(() => expect(statusGets()).toBe(1));
    act(() => useAIConnectionStore.setState({ aiHidden: false }));
    expect(screen.getByTestId('mcp-provider')).toHaveTextContent('Google Gemini');
  });
});

/* ── States ─────────────────────────────────────────────────────────────── */

describe('before the server has answered', () => {
  it('unknown: a quiet checking card, a grey Checking… pill, and both anchors', () => {
    cleanupAI = seedAI();
    renderPanel();
    expect(screen.getByText('Checking your AI connection…')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('mcp-status')).toHaveTextContent('Checking…');
    expect(screen.getByTestId('mcp-status')).toHaveAttribute('data-tone', 'grey');
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
    // Nothing is known, so no word is claimed for it.
    expect(screen.queryByTestId('mcp-status')).toBeNull();

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
    expect(screen.queryByTestId('mcp-status')).toBeNull();
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
  /** Connected to OpenAI; the switch form is the connect card's own folds. */
  const ANTHROPIC_SENTINEL = 'sk-ant-api03-SENTINEL-9876';
  const anyKey = () => screen.getByTestId('connect-any-key') as HTMLInputElement;

  it('is the connect card’s folds, "I already use…" open, without the free-key card', () => {
    const panel = openSwitch();
    expect(within(panel).getByText('Switch service')).toBeInTheDocument();
    expect(within(panel).getByText('Connecting a different service replaces this one.')).toBeInTheDocument();
    expect(within(panel).getByTestId('connect-fold-any')).toHaveAttribute('aria-expanded', 'true');
    expect(within(panel).getByTestId('connect-fold-openrouter')).toHaveAttribute('aria-expanded', 'false');
    expect(within(panel).queryByTestId('connect-key')).toBeNull();
    expect(within(panel).getByTestId('connect-custom-toggle')).toBeInTheDocument();
    expect(anyKey().type).toBe('password');
  });

  it('the sign-in comes back to this pane', () => {
    const panel = openSwitch();
    fireEvent.click(within(panel).getByTestId('connect-fold-openrouter'));
    expect(within(panel).getByTestId('connect-openrouter-signin')).toHaveAttribute(
      'href',
      '/api/ai/openrouter/start?r=settings'
    );
  });

  it('a pasted key is placed by its prefix and sent as exactly {provider, apiKey}, and the saved one stays until it works', async () => {
    openSwitch();
    const working = view({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
    server.put = () => json({ connection: working, models: [], listed: true });
    server.status = { available: true, model: working, openclaw: CLAW_OFF, aiHidden: false };
    paste(anyKey(), ANTHROPIC_SENTINEL);
    await waitFor(() => expect(screen.getByTestId('mcp-provider')).toHaveTextContent('Anthropic'));
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({ provider: 'anthropic', apiKey: ANTHROPIC_SENTINEL });
    await waitFor(() => expect(screen.queryByTestId('mcp-switch-panel')).toBeNull());
    expectNoKeyInMarkup('SENTINEL');
  });

  it('a refused key stays in its box, the saved connection untouched', async () => {
    openSwitch();
    server.put = () => json({ error: 'key_rejected' }, 400);
    paste(anyKey(), ANTHROPIC_SENTINEL);
    const note = await screen.findByTestId('connect-note');
    expect(note).toHaveAttribute('data-code', 'key_rejected');
    expect(anyKey().value).toBe(ANTHROPIC_SENTINEL);
    expect(screen.getByTestId('mcp-provider')).toHaveTextContent('OpenAI');
    expect(screen.getByTestId('mcp-switch-panel')).toBeInTheDocument();
    expectNoKeyInMarkup('SENTINEL');
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
  it('names the provider, says when it last answered, and holds the model picker', async () => {
    given(CONNECTED_MODEL, view());
    renderPanel();
    expect(screen.getByTestId('mcp-provider')).toHaveTextContent(/^OpenAI$/);
    expect(screen.getByTestId('mcp-subline')).toHaveTextContent(
      /^Key saved · answered a test question 3 minutes ago · Check again$/
    );
    // A link inside a sentence is underlined at rest, not only on hover.
    expect(screen.getByTestId('mcp-recheck')).toHaveClass('underline');
    // The pill sits on the heading's row, not in the card.
    const pill = screen.getByTestId('mcp-status');
    expect(pill).toHaveTextContent('Working');
    expect(pill.parentElement).toBe(screen.getByRole('heading', { name: 'Connection' }).parentElement);
    // The catalog's name, not the raw id, even before the list loads.
    expect(screen.getByTestId('model-picker')).toHaveTextContent('GPT-4o mini');
    expect(screen.getByTestId('mcp-model-hint')).toHaveTextContent('Answers in Ask and drafts your plans.');
    expect(screen.getByText('Replace key')).toBeInTheDocument();
    expect(screen.getByText('Use a different service')).toBeInTheDocument();
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

  it('Use a different service opens the switch form', () => {
    given(CONNECTED_MODEL, view());
    renderPanel();
    fireEvent.click(screen.getByText('Use a different service'));
    const panel = screen.getByTestId('mcp-switch-panel');
    expect(within(panel).getByText('Switch service')).toBeInTheDocument();
    expect(within(panel).getByTestId('connect-switch')).toBeInTheDocument();
  });

  it('with no model yet: needs attention, asks for one, with the picker already open', async () => {
    given(NO_MODEL_PICKED);
    renderPanel();
    expect(screen.getByTestId('mcp-status')).toHaveTextContent('Needs attention');
    expect(screen.getByTestId('mcp-status')).toHaveAttribute('data-tone', 'honey');
    // The working card all the same: the key answers, only the pick is missing.
    expect(screen.getByTestId('mcp-subline')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-model-hint')).toHaveTextContent('Pick a model to finish connecting.');
    expect(screen.getByTestId('model-picker')).toHaveAttribute('aria-label', 'Choose a model');
    expect(await screen.findByPlaceholderText(/Search .*models…/)).toBeInTheDocument();
  });

  it('says when chat is off on this device', () => {
    given({ ...CONNECTED_MODEL, choice: 'none' }, view());
    renderPanel();
    expect(
      screen.getByText('Chat is off on this device. Change it under Who answers in chat below.')
    ).toBeInTheDocument();
  });

  it('leaves OpenClaw to its own section', () => {
    given({ ...CONNECTED_MODEL, openclaw: { gateway: true } }, view());
    renderPanel();
    expect(screen.queryByTestId('mcp-openclaw-too')).toBeNull();
    expect(screen.queryByText(/OpenClaw is connected too/)).toBeNull();
    expect(screen.queryByTestId('mcp-chat-off')).toBeNull();
  });

  it('Disconnect goes through confirm, and only then deletes', async () => {
    given(CONNECTED_MODEL, view());
    renderPanel();
    // Red text: no border, no wash. The confirm carries the destructive button.
    const action = screen.getByTestId('mcp-disconnect');
    expect(action).toHaveClass('text-destructive-text');
    expect(action.className.split(/\s+/)).not.toContain('border');
    expect(action.className).not.toMatch(/(^|\s)bg-/);
    fireEvent.click(action);
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
    expect(screen.getByTestId('mcp-status')).toHaveTextContent('Not set up');
  });

  it('a refused Disconnect says so, and keeps the card', async () => {
    given(CONNECTED_MODEL, view());
    server.del = () => json({ error: 'server' }, 503);
    renderPanel();
    fireEvent.click(screen.getByTestId('mcp-disconnect'));
    act(() => useUIStore.getState().resolveConfirm(true));
    expect(await screen.findByTestId('mcp-error')).toHaveTextContent('Something went wrong. Try again.');
    expect(screen.getByTestId('mcp-provider')).toHaveTextContent('OpenAI');
    // Cancelled, nothing is sent and nothing is said.
    fireEvent.click(screen.getByTestId('mcp-disconnect'));
    expect(screen.queryByTestId('mcp-error')).toBeNull();
    act(() => useUIStore.getState().resolveConfirm(false));
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
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

describe('needs attention (a key turned down)', () => {
  /** Google Gemini's key, turned down an hour ago, relative to the real clock as view() is. */
  const turnedDown = (over: Partial<ModelConnectionView> = {}) =>
    view({
      provider: 'gemini',
      model: 'gemini-flash-latest',
      status: 'failing',
      problem: 'key_rejected',
      checkedAt: new Date(Date.now() - 61 * 60_000).toISOString(),
      ...over,
    });

  it('the fix card: what is wrong, a box for a new key, and the ways out', () => {
    given(KEY_TURNED_DOWN, turnedDown());
    renderPanel();
    const fix = screen.getByTestId('mcp-fix');
    expect(within(fix).getByTestId('mcp-provider')).toHaveTextContent(/^Google Gemini$/);
    expect(screen.getByTestId('fix-line')).toHaveTextContent(/^Key saved · Google turned it down an hour ago$/);
    const explain = screen.getByTestId('fix-explain');
    expect(explain).toHaveTextContent(
      'Google stopped accepting this key. It may have been deleted in AI Studio, or its project was turned off. Ask and plan suggestions are paused until a working key is in.'
    );
    // The card's resting state: said once, not announced on every load.
    expect(explain.querySelector('[role="alert"]')).toBeNull();
    // A password box (no textbox role), labelled for the key it wants.
    expect(screen.getByLabelText('New Gemini key')).toBe(screen.getByTestId('fix-key'));
    const studio = screen.getByRole('link', { name: 'Open Google AI Studio' });
    expect(studio).toHaveAttribute('href', 'https://aistudio.google.com/apikey');
    expect(studio.closest('p')).toHaveTextContent(/^Your old key is replaced only once this one works\. Open Google AI Studio$/);
    expect(studio.className).not.toMatch(/border-input/);
    expect(screen.getByTestId('setup-recheck')).toHaveTextContent('Check the old key again');
    expect(fix).toContainElement(screen.getByTestId('mcp-switch'));
    expect(fix).toContainElement(screen.getByTestId('mcp-disconnect'));
    expect(screen.getByTestId('mcp-switch')).toHaveTextContent('Use a different service');
    // None of the working card's parts, and none of the column's.
    expect(screen.queryByTestId('mcp-replace')).toBeNull();
    expect(screen.queryByTestId('model-picker')).toBeNull();
    expect(screen.queryByTestId('fix-caption')).toBeNull();
    expect(screen.queryByTestId('mcp-failing')).toBeNull();
    const pill = screen.getByTestId('mcp-status');
    expect(pill).toHaveTextContent('Needs attention');
    expect(pill).toHaveAttribute('data-tone', 'honey');
    // A refused key is not asked for a model list.
    expect(calls.some((c) => c.url === '/api/ai/connection/models')).toBe(false);
  });

  it('every action in its band is one size', () => {
    given(KEY_TURNED_DOWN, turnedDown());
    renderPanel();
    for (const id of ['setup-recheck', 'mcp-switch', 'mcp-disconnect']) {
      expect(screen.getByTestId(id), id).toHaveClass('text-xs');
      expect(screen.getByTestId(id).className, id).not.toMatch(/\btext-sm\b/);
    }
    expect(screen.getByTestId('mcp-disconnect')).toHaveClass('text-destructive-text');
  });

  it('a pasted Gemini key carries the saved model, so the fix keeps the pick', async () => {
    given(KEY_TURNED_DOWN, turnedDown());
    server.put = () => json({ connection: view({ provider: 'gemini', model: 'gemini-flash-latest' }), models: [], listed: true });
    renderPanel();
    await act(async () => paste(screen.getByTestId('fix-key'), GEMINI_SENTINEL));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      { provider: 'gemini', apiKey: GEMINI_SENTINEL, model: 'gemini-flash-latest' },
    ]);
    await waitFor(() => expect(screen.getByTestId('mcp-status')).toHaveTextContent('Working'));
    expectNoKeyInMarkup('SENTINEL');
  });

  it('a fix in flight turns only the pill: the card and its box stay mounted', async () => {
    given(KEY_TURNED_DOWN, turnedDown());
    let release: (r: Response) => void = () => {};
    server.put = () => new Promise<Response>((resolve) => (release = resolve));
    renderPanel();
    const fix = screen.getByTestId('mcp-fix');
    const box = screen.getByTestId('fix-key');
    await act(async () => paste(box, GEMINI_SENTINEL));
    expect(screen.getByTestId('mcp-status')).toHaveTextContent('Checking…');
    expect(screen.getByTestId('mcp-status')).toHaveAttribute('data-tone', 'grey');
    expect(screen.getByTestId('mcp-fix')).toBe(fix);
    expect(screen.getByTestId('fix-key')).toBe(box);
    await act(async () => release(json({ error: 'key_rejected' }, 400)));
    expect(screen.getByTestId('mcp-status')).toHaveTextContent('Needs attention');
    expect(screen.getByTestId('fix-key')).toBe(box);
  });

  it('a key dsul cannot read says so, with no fresh check', () => {
    given(KEY_TURNED_DOWN, turnedDown({ problem: 'key_unreadable' }));
    renderPanel();
    expect(screen.getByTestId('fix-line')).toHaveTextContent(/^Key saved · dsul can’t read it anymore$/);
    expect(screen.getByTestId('fix-explain')).toHaveTextContent(
      'dsul can’t read your saved key anymore. Ask and plan suggestions are paused until a working key is in.'
    );
    expect(screen.queryByTestId('setup-recheck')).toBeNull();
    expect(screen.getByTestId('mcp-disconnect')).toBeInTheDocument();
  });

  it('a rejected sign-in signs in again, back to this pane', () => {
    given(
      CONNECTED_MODEL,
      view({ provider: 'openrouter', authMethod: 'oauth', status: 'failing', problem: 'key_rejected', model: 'openai/gpt-4o-mini' })
    );
    renderPanel();
    expect(screen.getByTestId('fix-signin-again')).toHaveAttribute('href', '/api/ai/openrouter/start?r=settings');
    expect(screen.getByTestId('fix-signin-again')).toHaveTextContent('Sign in again');
    expect(screen.queryByTestId('fix-key')).toBeNull();
    expect(screen.queryByTestId('mcp-signin-again')).toBeNull();
    expect(screen.getByTestId('setup-recheck')).toHaveTextContent('Check again');
  });

  it('a rejected key can be swapped for another service, the saved one kept until it works', async () => {
    given(CONNECTED_MODEL, view({ status: 'failing', problem: 'key_rejected' }));
    renderPanel();
    const swap = within(screen.getByTestId('mcp-fix')).getByTestId('mcp-switch');
    expect(swap).toHaveTextContent('Use a different service');
    fireEvent.click(swap);
    const panel = screen.getByTestId('mcp-switch-panel');

    const working = view({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
    server.put = () => json({ connection: working, models: [], listed: true });
    server.status = { available: true, model: working, openclaw: CLAW_OFF, aiHidden: false };
    paste(within(panel).getByTestId('connect-any-key'), 'sk-ant-api03-SENTINEL-9876');
    await waitFor(() => expect(screen.getByTestId('mcp-status')).toHaveTextContent('Working'));
    expect(screen.getByTestId('mcp-provider')).toHaveTextContent('Anthropic');
    // As above: the panel closes on its own render, which can land after the card's.
    await waitFor(() => expect(screen.queryByTestId('mcp-switch-panel')).toBeNull());
    expectNoKeyInMarkup('SENTINEL');
  });

  it('Disconnect from the fix card goes through the same confirm', async () => {
    given(KEY_TURNED_DOWN, turnedDown());
    renderPanel();
    fireEvent.click(screen.getByTestId('mcp-disconnect'));
    expect(useUIStore.getState().confirmRequest).toMatchObject({
      title: 'Disconnect Google Gemini?',
      testId: 'model-disconnect-confirm',
      destructive: true,
    });
    server.status = { available: true, model: null, openclaw: CLAW_OFF, aiHidden: false };
    act(() => useUIStore.getState().resolveConfirm(true));
    await waitFor(() => expect(screen.getByTestId('mcp-connect-fresh')).toBeInTheDocument());
  });
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

  it('the switch form offers a link to copy instead of the sign-in', () => {
    const panel = openSwitch();
    fireEvent.click(within(panel).getByTestId('connect-fold-openrouter'));
    expect(within(panel).queryByTestId('connect-openrouter-signin')).toBeNull();
    expect(within(panel).getByTestId('connect-copy-link')).toBeInTheDocument();
    expect(within(panel).getByTestId('connect-any-key')).toBeInTheDocument();
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
    expect(screen.queryByTestId('fix-signin-again')).toBeNull();
    // The way they connected in the first place still works, from the browser.
    expect(screen.getByTestId('connect-openrouter-desktop')).toBeInTheDocument();
    // Someone who only ever signed in has no key yet: say where one comes from.
    const box = screen.getByLabelText('New OpenRouter key') as HTMLInputElement;
    expect(box).toBe(screen.getByTestId('fix-key'));
    expect(screen.getByRole('link', { name: 'Open OpenRouter’s key page' })).toHaveAttribute(
      'href',
      PROVIDER_META.openrouter.keyHelpUrl!
    );
    fireEvent.change(box, { target: { value: OPENROUTER_SENTINEL } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('fix-submit'));
    });
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
    expect(screen.getByTestId('model-picker')).toHaveTextContent(modelName('anthropic', 'claude-sonnet-4-0').name);

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

/* ── Today's limit ──────────────────────────────────────────────────────── */

describe('a daily limit', () => {
  const LIFTS = Date.parse('2099-01-01T15:00:00.000Z');

  it('says when AI comes back, on the planner’s clock, with no recheck and no Replace key', () => {
    usePlannerStore.setState({ userTimezone: 'UTC', timeFormat: '12h' } as never);
    const at = resetClock(LIFTS, 'UTC', '12h');
    given(DAILY_LIMIT);
    renderPanel();
    const pill = screen.getByTestId('mcp-status');
    expect(pill).toHaveTextContent(`Daily limit · back at ${at}`);
    expect(pill).toHaveAttribute('data-tone', 'honey');
    expect(screen.getByTestId('mcp-provider')).toHaveTextContent(/^Google Gemini$/);
    expect(screen.getByTestId('mcp-subline')).toHaveTextContent(/^Key saved · today’s limit is used up$/);
    const note = screen.getByTestId('mcp-limit-note');
    expect(note).toHaveTextContent(
      `Google’s daily limit on this key is used up. It resets once a day, and AI comes back by itself at ${at}.`
    );
    // The card's resting state: never an alert that announces on every load.
    expect(note.querySelector('[role="alert"]')).toBeNull();
    expect(screen.getByTestId('mcp-limit-paid')).toHaveTextContent(
      'A paid Google plan raises the daily limit. dsul never charges for AI.'
    );
    const studio = screen.getByRole('link', { name: 'Open Google AI Studio' });
    expect(studio).toHaveAttribute('href', 'https://aistudio.google.com/apikey');
    expect(studio.className).toMatch(/border-input/);
    const limit = screen.getByTestId('mcp-limit');
    expect(limit).toContainElement(screen.getByTestId('mcp-switch'));
    expect(limit).toContainElement(screen.getByTestId('mcp-disconnect'));
    expect(screen.getByTestId('model-picker')).toHaveTextContent('Gemini Flash');
    expect(screen.queryByTestId('mcp-recheck')).toBeNull();
    expect(screen.queryByTestId('mcp-replace')).toBeNull();
  });

  it('OpenRouter’s is its free questions, and OpenAI’s names the company', () => {
    usePlannerStore.setState({ userTimezone: 'UTC', timeFormat: '12h' } as never);
    const at = resetClock(LIFTS, 'UTC', '12h');
    const limitedUntil = '2099-01-01T15:00:00.000Z';
    const first = renderLimited({ provider: 'openrouter', model: 'openai/gpt-4o-mini', authMethod: 'oauth', limitedUntil });
    expect(screen.getByTestId('mcp-subline')).toHaveTextContent(/^Signed in · today’s limit is used up$/);
    expect(screen.getByTestId('mcp-limit-note')).toHaveTextContent(
      `You’ve used today’s free questions. OpenRouter resets them once a day, and AI comes back by itself at ${at}.`
    );
    expect(screen.getByTestId('mcp-limit-paid')).toHaveTextContent(
      'Credit on your OpenRouter account raises the daily limit. dsul never charges for AI.'
    );
    // A sign-in has no key page to send anyone to.
    expect(screen.queryByRole('link', { name: /key page/ })).toBeNull();
    first.unmount();
    cleanupAI?.();

    renderLimited({ provider: 'openai', model: 'gpt-4o-mini', limitedUntil });
    expect(screen.getByTestId('mcp-limit-note')).toHaveTextContent(
      `Today’s limit with OpenAI is used up, and AI comes back by itself at ${at}.`
    );
    expect(screen.getByTestId('mcp-limit-paid')).toHaveTextContent(/^dsul never charges for AI\.$/);
    expect(screen.getByRole('link', { name: 'Open OpenAI’s key page' })).toHaveAttribute(
      'href',
      PROVIDER_META.openai.keyHelpUrl!
    );
    expect(limitCopy({ provider: 'openai', baseUrl: null }, at).note).toBe(
      screen.getByTestId('mcp-limit-note').textContent
    );
  });

  function renderLimited(model: Partial<ModelConnectionView>) {
    given({ ...CONNECTED_MODEL, model });
    return renderPanel();
  }
});

describe('the limit lifting', () => {
  // Fake timers only for the clock the panel re-renders on (useMinuteClock's
  // setTimeout) and Date. No waitFor or findBy here: they wait on setTimeout.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2099-01-01T14:59:30Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await act(async () => {});
  };
  /** Moves the wall clock (when given) and runs the timers due in `ms`. */
  const pass = async (ms: number, to?: string) => {
    act(() => {
      if (to) vi.setSystemTime(new Date(to));
      vi.advanceTimersByTime(ms);
    });
    await flush();
  };

  it('turns the pill back to Working on the edge, and asks the server once', async () => {
    given(DAILY_LIMIT);
    renderPanel();
    await flush();
    expect(screen.getByTestId('mcp-status')).toHaveTextContent(/^Daily limit · back at /);
    expect(statusGets()).toBe(1);

    await pass(60_250, '2099-01-01T15:00:30Z');
    expect(screen.getByTestId('mcp-status')).toHaveTextContent('Working');
    expect(screen.queryByTestId('mcp-limit')).toBeNull();
    expect(screen.getByTestId('mcp-subline')).toHaveTextContent(/^Key saved · answered a test question /);
    // The mount's ask, and one more on the edge.
    expect(statusGets()).toBe(2);

    await pass(60_250);
    expect(statusGets()).toBe(2);
  });

  it('a mount with no limit never asks for this', async () => {
    given(CONNECTED_MODEL, view());
    renderPanel();
    await flush();
    expect(statusGets()).toBe(1);
    await pass(60_250, '2099-01-01T15:00:30Z');
    await pass(60_250);
    expect(statusGets()).toBe(1);
  });

  it('a limit disconnected before it lifts asks nothing when the clock passes it', async () => {
    given(DAILY_LIMIT);
    renderPanel();
    await flush();
    fireEvent.click(screen.getByTestId('mcp-disconnect'));
    act(() => useUIStore.getState().resolveConfirm(true));
    await flush();
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(screen.getByTestId('mcp-connect-fresh')).toBeInTheDocument();
    await pass(60_250, '2099-01-01T15:00:30Z');
    await pass(60_250);
    expect(statusGets()).toBe(1);
  });
});

/* ── The pill and the body are separate questions ───────────────────────── */

describe('a check in flight', () => {
  it('a connect from the connect card turns only the pill: the card and its box stay mounted', async () => {
    given(NOTHING_CONNECTED);
    let release: (r: Response) => void = () => {};
    server.put = () => new Promise<Response>((resolve) => (release = resolve));
    renderPanel();
    const card = screen.getByTestId('connect-ai');
    const box = geminiInput();
    expect(screen.getByTestId('mcp-status')).toHaveTextContent('Not set up');
    paste(box, GEMINI_SENTINEL);
    await waitFor(() => expect(screen.getByTestId('mcp-status')).toHaveTextContent('Checking…'));
    expect(screen.getByTestId('connect-ai')).toBe(card);
    expect(geminiInput()).toBe(box);
    await act(async () => release(json({ error: 'key_rejected' }, 400)));
    expect(screen.getByTestId('mcp-status')).toHaveTextContent('Not set up');
    expect(screen.getByTestId('connect-ai')).toBe(card);
    expect(geminiInput()).toBe(box);
  });

  it('Check again turns the pill to Checking… and keeps the card', async () => {
    given(CONNECTED_MODEL, view());
    let release: (r: Response) => void = () => {};
    server.patch = () => new Promise<Response>((resolve) => (release = resolve)) as unknown as Response;
    renderPanel();
    const subline = screen.getByTestId('mcp-subline');
    fireEvent.click(screen.getByTestId('mcp-recheck'));
    await waitFor(() => expect(screen.getByTestId('mcp-status')).toHaveTextContent('Checking…'));
    expect(screen.getByTestId('mcp-subline')).toBe(subline);
    expect(screen.getByTestId('mcp-recheck')).toHaveTextContent('Checking…');
    await act(async () => release(json({ connection: view() })));
    expect(screen.getByTestId('mcp-status')).toHaveTextContent('Working');
  });
});

/* ── The pill's dot ─────────────────────────────────────────────────────── */

describe('the Working dot', () => {
  it('is lime only while something answers here', () => {
    given(CONNECTED_MODEL, view());
    const first = renderPanel();
    let pill = screen.getByTestId('mcp-status');
    expect(pill).toHaveAttribute('data-tone', 'lime');
    expect(pill.querySelector('[data-dot]')).toHaveClass('bg-primary');
    first.unmount();
    cleanupAI?.();

    // Chat is Off on this device: the key works, but nothing answers here.
    given({ ...CONNECTED_MODEL, choice: 'none' }, view());
    renderPanel();
    pill = screen.getByTestId('mcp-status');
    expect(pill).toHaveTextContent('Working');
    expect(pill).toHaveAttribute('data-tone', 'grey');
    expect(pill.querySelector('[data-dot]')).toHaveClass('bg-muted-foreground');
    expect(pill.querySelector('[class*="bg-primary"]')).toBeNull();
    expect(screen.getByTestId('mcp-chat-off')).toHaveTextContent(
      'Chat is off on this device. Change it under Who answers in chat below.'
    );
  });

  it('follows the device’s choice as it changes', () => {
    given(CONNECTED_MODEL, view());
    renderPanel();
    expect(screen.getByTestId('mcp-status')).toHaveAttribute('data-tone', 'lime');
    act(() => useAISettingsStore.setState({ chatTarget: 'none' }));
    expect(screen.getByTestId('mcp-status')).toHaveAttribute('data-tone', 'grey');
  });
});

/* ── Good to know ───────────────────────────────────────────────────────── */

describe('good to know', () => {
  it('is folded under every card for a saved connection, and never beside the setup one', () => {
    for (const [name, seed] of [
      ['working', GEMINI_WORKING],
      ['limit', DAILY_LIMIT],
      ['fix', KEY_TURNED_DOWN],
    ] as const) {
      given(seed);
      const v = renderPanel();
      const fold = screen.getByTestId('connect-good-to-know-connected');
      expect(screen.getByTestId('good-to-know-toggle'), name).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('good-to-know-body'), name).toBeNull();
      expect(screen.queryByTestId('connect-good-to-know'), name).toBeNull();
      expect(screen.getByTestId('model-connection-panel')).toContainElement(fold);
      v.unmount();
      cleanupAI?.();
      cleanupAI = null;
    }

    given(NOTHING_CONNECTED);
    renderPanel();
    expect(screen.getByTestId('connect-good-to-know')).toBeInTheDocument();
    expect(screen.queryByTestId('connect-good-to-know-connected')).toBeNull();
  });

  it('opens onto the four facts, in the connection’s own words', () => {
    given(GEMINI_WORKING);
    const first = renderPanel();
    fireEvent.click(screen.getByTestId('good-to-know-toggle'));
    const gemini = goodToKnowCopy({ provider: 'gemini', baseUrl: null });
    const body = screen.getByTestId('good-to-know-body');
    expect(Array.from(body.querySelectorAll('li')).map((li) => li.textContent)).toEqual([
      `Cost. ${gemini.cost}`,
      `What’s sent. ${gemini.sent}`,
      `Your key. ${gemini.key}`,
      `Taking it back. ${gemini.back}`,
    ]);
    first.unmount();
    cleanupAI?.();

    given(CONNECTED_MODEL, view());
    renderPanel();
    fireEvent.click(screen.getByTestId('good-to-know-toggle'));
    expect(screen.getByTestId('good-to-know-body')).toHaveTextContent(
      'Cost. OpenAI bills its API to your OpenAI account. dsul never charges for AI.'
    );
    expect(screen.getByTestId('good-to-know-body')).toHaveTextContent(
      'Taking it back. Disconnect above and dsul deletes the key. To cancel the key itself, revoke it with OpenAI.'
    );
  });
});

/* ── Rules across states ────────────────────────────────────────────────── */

describe('nothing lime', () => {
  const lime = () =>
    Array.from(
      document.querySelectorAll(
        '[data-testid="model-connection-panel"] [class*="bg-primary"], [data-testid="model-connection-panel"] [data-slot="button-key"]'
      )
    );

  it('while nothing is connected, or the key needs attention', () => {
    given(NOTHING_CONNECTED);
    const first = renderPanel();
    expect(screen.getByTestId('model-connection-panel')).toBeInTheDocument();
    expect(lime()).toEqual([]);
    first.unmount();
    cleanupAI?.();

    given(KEY_TURNED_DOWN);
    renderPanel();
    expect(screen.getByTestId('mcp-fix')).toBeInTheDocument();
    expect(lime()).toEqual([]);
  });
});

describe('anchors', () => {
  const count = (id: string) =>
    screen.getByTestId('model-connection-panel').querySelectorAll(`[data-setting-alias="${id}"]`).length;

  it('each of the two lands exactly once in every state the section draws', () => {
    const oauthTurnedDown = view({
      provider: 'openrouter',
      authMethod: 'oauth',
      status: 'failing',
      problem: 'key_rejected',
      model: 'openai/gpt-4o-mini',
    });
    const states: [string, () => void][] = [
      ['checking', () => (cleanupAI = seedAI())],
      [
        'failed',
        () => {
          cleanupAI = seedAI({ phase: 'error' });
          server.status = () => json({ error: 'server' }, 503);
        },
      ],
      ['unavailable', () => given({ ...NOTHING_CONNECTED, available: false })],
      ['not set up', () => given(NOTHING_CONNECTED)],
      ['working', () => given(GEMINI_WORKING)],
      ['no model picked', () => given(NO_MODEL_PICKED)],
      ['daily limit', () => given(DAILY_LIMIT)],
      ['fix, a key', () => given(KEY_TURNED_DOWN)],
      ['fix, a sign-in', () => given(KEY_TURNED_DOWN, oauthTurnedDown)],
    ];
    for (const [name, seed] of states) {
      seed();
      const v = renderPanel();
      expect(count('beacon.apiKey'), name).toBe(1);
      expect(count('beacon.model'), name).toBe(1);
      v.unmount();
      cleanupAI?.();
      cleanupAI = null;
    }
  });

  it('the limit card: the key on its header, the model on its picker', () => {
    given(DAILY_LIMIT);
    renderPanel({ highlightId: 'beacon.model' });
    const model = document.querySelector('[data-setting-alias="beacon.model"]')!;
    expect(model.contains(screen.getByTestId('model-picker'))).toBe(true);
    expect(model).toHaveAttribute('data-highlight', 'true');
    expect(document.querySelector('[data-setting-alias="beacon.apiKey"]')!.contains(screen.getByTestId('mcp-provider'))).toBe(
      true
    );
  });
});

describe('the panel’s files', () => {
  it.each([
    'components/settings/model-connection-panel.tsx',
    'components/settings/status-pill.tsx',
    'components/settings/disconnect.ts',
    'components/settings/model-picker.tsx',
  ])('%s has no em dashes, says Ctrl not the Mac symbol, and never names the AI', (file) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    expect(src).not.toMatch(/—/);
    expect(src).not.toMatch(/⌘/);
    expect(src).not.toMatch(/\bBeacon\b/);
  });
});
