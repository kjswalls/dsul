import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Settings → AI's pane body (components/settings/ai-pane.tsx), rendered
 * against the REAL connection store with a fake server behind `fetch`, and
 * the real Connection section (ModelConnectionPanel) inside it. `rowFor` is a
 * stand-in: the generic SettingRows it draws in the shell are
 * settings-shell-render.test.tsx's.
 *
 * What is pinned here, beyond the copy of every state:
 *
 *   1. Which sections show, in which order, for each state (F18 to F22 and
 *      the states the frames do not draw), and that a section shown once in a
 *      visit (On this device) stays under the select you just changed.
 *   2. "Use AI in dsul" writes only through setUseAI, is never disabled, never
 *      draws a modified bar, and hands focus to its new control only after a
 *      press on that row.
 *   3. The Connection section never remounts, whatever appears around it.
 *   4. Every record has exactly one anchor in every state.
 *   5. Nothing lime while nothing answers (the house switch aside).
 */

const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  params: new URLSearchParams(),
  pathname: '/settings/ai',
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
vi.mock('@/lib/chat-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat-transport')>()),
  resetPluginTransport: vi.fn(),
}));

import { AIPane, AIPaneMark } from '@/components/settings/ai-pane';
import { UNPAIR_FAILED } from '@/components/settings/disconnect';
import { resetPluginTransport } from '@/lib/chat-transport';
import { ScopeChip } from '@/components/settings/scope-chip';
import { __armUserForTests, useAIConnectionStore } from '@/lib/ai-connection-store';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { USE_AI_COPY } from '@/lib/ai-pane-state';
import { AI_BACK_ON_FAILED, AI_OFF_FAILED } from '@/lib/no-ai';
import { useUIStore } from '@/lib/ui-store';
import { useUndoStripStore } from '@/lib/undo-strip-store';
import { chordLabel } from '@/lib/commands/keys';
import { DEFAULT_SHORTCUTS, useKeyboardShortcutsStore } from '@/lib/keyboard-shortcuts-store';
import type { SettingCtx, SettingRecord } from '@/lib/settings/manifest';
import type { AIConnectionResponse, ModelConnectionView, ModelOption, OpenClawView } from '@/lib/ai-types';
import {
  seedAI,
  paneInputFor,
  AI_HIDDEN,
  AI_OFF_CONNECTED,
  AI_OFF_PAIRED,
  CONNECTED_MODEL,
  DAILY_LIMIT,
  GEMINI_WORKING,
  KEY_TURNED_DOWN,
  NO_MODEL_PICKED,
  NOTHING_CONNECTED,
  OPENCLAW_PLUGIN,
  OPENCLAW_PULL_ONLY,
  SEED_USER_ID,
  type SeedAI,
} from './helpers/ai-fixtures';

/** The free Google key the connect card leads with; its prefix makes it sure, so a paste checks it. */
const GEMINI_SENTINEL = 'AIzaSyTEST-SENTINEL-9876';

/* ── A fake server ──────────────────────────────────────────────────────── */

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
  /** DELETE /api/ai/openclaw */
  unpair: () => Response;
}

let server: Server;
let calls: Call[];

function respond(r: unknown | (() => Response)): Response {
  return typeof r === 'function' ? (r as () => Response)() : json(r);
}

const NOTHING: AIConnectionResponse = {
  available: true,
  model: null,
  openclaw: { gateway: false, pluginChat: false, agent: false, agentId: null },
  aiHidden: false,
};

beforeEach(() => {
  calls = [];
  nav.replace.mockReset();
  nav.push.mockReset();
  nav.params = new URLSearchParams();
  toastMock.error.mockClear();
  server = {
    status: NOTHING,
    models: { models: [{ id: 'gpt-4o-mini', label: 'gpt-4o-mini' }], listed: true },
    put: () => json({ error: 'server' }, 503),
    patch: () => json({ error: 'server' }, 503),
    del: () => json({ ok: true }),
    unpair: () => unpaired(),
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
      if (url === '/api/ai/openclaw' && method === 'DELETE') return server.unpair();
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
  __armUserForTests(null);
  useUIStore.setState({ confirmRequest: null });
  useUndoStripStore.setState({ entry: null });
  vi.unstubAllGlobals();
});

/**
 * Seed the store AND make the server say the same thing (from the same
 * `paneInputFor` the layout table reads), so the mount refresh agrees.
 */
function given(seed: SeedAI, model: ModelConnectionView | null = null) {
  cleanupAI = seedAI(seed);
  if (model) act(() => useAIConnectionStore.setState({ model }));
  const s = paneInputFor(seed);
  server.status = {
    available: s.available,
    model: s.available ? (model ?? s.model) : null,
    openclaw: s.openclaw,
    aiHidden: s.aiHidden,
  };
}

/** The check failed: seeded so, and a server that keeps failing the mount refresh. */
function givenCheckFailed() {
  cleanupAI = seedAI({ phase: 'error' });
  server.status = () => json({ error: 'server' }, 503);
}

/** Unpair lands: the agent key goes, a gateway stays, and the server says so from then on. */
function unpaired(): Response {
  const now = server.status as AIConnectionResponse;
  const openclaw: OpenClawView = { gateway: now.openclaw.gateway, pluginChat: false, agent: false, agentId: null };
  server.status = { ...now, openclaw };
  return json({ openclaw });
}

const unpairs = () => calls.filter((c) => c.url === '/api/ai/openclaw' && c.method === 'DELETE').length;

const statusGets = () => calls.filter((c) => c.url === '/api/ai/connection' && c.method === 'GET').length;
const patches = () => calls.filter((c) => c.method === 'PATCH').map((c) => c.body);

/** PATCH {hidden} lands, and the server says so from then on. */
function acceptHidden() {
  server.patch = (body) => {
    const hidden = (body as { hidden?: unknown }).hidden;
    if (typeof hidden !== 'boolean') return json({ error: 'server' }, 503);
    server.status = { ...(server.status as AIConnectionResponse), aiHidden: hidden };
    return json({ aiHidden: hidden });
  };
}

const ctx: SettingCtx = { theme: 'system', setTheme: () => {}, userId: 'test-user' };
/** A stand-in for the shell's rowFor: the record's own row anchor and its label. */
const rowFor = (r: SettingRecord) => (
  <div key={r.id} data-setting-row={r.id}>
    {r.label}
  </div>
);

function renderPane(o: { gatewayOpen?: boolean; onToggleGateway?: () => void; highlightId?: string | null } = {}) {
  return render(
    <AIPane
      ctx={ctx}
      isMobile={false}
      highlightId={o.highlightId ?? null}
      rowFor={rowFor}
      gatewayOpen={o.gatewayOpen ?? false}
      onToggleGateway={o.onToggleGateway ?? (() => {})}
    />
  );
}

/** Let the mount refresh (and anything it started) answer. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(seed: SeedAI | 'unknown' | 'error', o: Parameters<typeof renderPane>[0] = {}) {
  if (seed === 'unknown') cleanupAI = seedAI();
  else if (seed === 'error') givenCheckFailed();
  else given(seed);
  const result = renderPane(o);
  await settle();
  return result;
}

const sections = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-ai-section]')).map((el) => el.dataset.aiSection);
const aiUseRow = () => screen.getByTestId('ai-use-row');
const form = () => aiUseRow().dataset.form;

/** Ask's chord as the copy prints it on a PC (jsdom is not a Mac), from the binding, never typed. */
const askChord = (keys = DEFAULT_SHORTCUTS.find((b) => b.id === 'toggle_right_sidebar')!.keys) =>
  chordLabel(keys, false);

/** A paste, as the browser delivers one: the box reads the clipboard's text itself. */
function paste(input: HTMLElement, text: string) {
  fireEvent.paste(input, { clipboardData: { getData: () => text } });
}

/** Every lime class in the pane, the house switch's own track and thumb left out. */
const lime = () =>
  Array.from(
    document.querySelectorAll('[data-testid="ai-pane"] [class*="bg-primary"], [data-testid="ai-pane"] [data-slot="button-key"]')
  ).filter((el) => el.closest('[data-slot="switch"]') === null);

/* ── Sections ───────────────────────────────────────────────────────────── */

describe('sections, in order', () => {
  it.each([
    ['F18, nothing connected', NOTHING_CONNECTED, ['explainer', 'use', 'connection', 'openclaw']],
    ['F18 with chat Off here', { ...NOTHING_CONNECTED, choice: 'none' }, ['explainer', 'use', 'connection', 'openclaw', 'device']],
    ['no model on this server', { ...NOTHING_CONNECTED, available: false }, ['explainer', 'use', 'connection', 'openclaw']],
    ['F19, working', GEMINI_WORKING, ['explainer', 'use', 'connection', 'openclaw', 'device']],
    ['F22, AI off with a model kept', AI_OFF_CONNECTED, ['use', 'ai-off']],
    ['AI off on a server with no model', { ...AI_HIDDEN, available: false }, ['use', 'ai-off']],
  ] as const)('%s', async (_name, seed, order) => {
    await mount(seed as SeedAI);
    expect(sections()).toEqual(order);
    if ((order as readonly string[]).includes('ai-off')) {
      expect(screen.queryByTestId('model-connection-panel')).toBeNull();
    }
  });

  it('while the check is out: Use AI and Connection only', async () => {
    await mount('unknown');
    expect(sections()).toEqual(['use', 'connection']);
  });

  it('when the check failed: Use AI and Connection only', async () => {
    await mount('error');
    expect(useAIConnectionStore.getState().phase).toBe('error');
    expect(sections()).toEqual(['use', 'connection']);
  });

  it('is one pane root', async () => {
    await mount(NOTHING_CONNECTED);
    const pane = screen.getByTestId('ai-pane');
    expect(pane.querySelectorAll('[data-ai-section]')).toHaveLength(4);
  });
});

/* ── What AI does ───────────────────────────────────────────────────────── */

describe('What AI does', () => {
  afterEach(() => useKeyboardShortcutsStore.setState({ overrides: {} }));

  it('is three tiles and a caption while nothing is connected', async () => {
    await mount(NOTHING_CONNECTED);
    const explainer = screen.getByTestId('ai-explainer');
    expect(explainer).toHaveAttribute('data-form', 'tiles');
    expect(within(explainer).getByRole('heading', { name: 'What AI does in dsul' })).toBeInTheDocument();
    const tiles = within(explainer).getAllByTestId('ai-tile');
    expect(tiles.map((t) => t.dataset.tile)).toEqual(['ask', 'plan', 'breakdown']);
    expect(tiles[0]).toHaveTextContent('Ask');
    expect(tiles[0]).toHaveTextContent('Talk through your day, or ask what to do next.');
    expect(tiles[1]).toHaveTextContent('Plan suggestions');
    expect(tiles[1]).toHaveTextContent('Drafts today or tomorrow from your list. You keep, move or drop each line.');
    expect(tiles[2]).toHaveTextContent('Break it down');
    expect(tiles[2]).toHaveTextContent('Turns a big task into small steps you can start.');
    expect(within(explainer).getByTestId('ai-explainer-caption')).toHaveTextContent(
      'Nothing in your planner changes unless you say yes.'
    );
    // The grid stacks on a phone.
    expect(explainer.querySelector('ul')).toHaveClass('grid-cols-1', 'md:grid-cols-3');
  });

  it('puts the chord in the Ask tile as a flat keycap, in ink, with no space before it', async () => {
    await mount(NOTHING_CONNECTED);
    const ask = screen.getAllByTestId('ai-tile')[0];
    const chord = within(ask).getByTestId('ai-explainer-chord');
    expect(chord).toHaveClass('hidden', 'md:inline');
    expect(chord.textContent).toBe(` Open it with${askChord()}.`);
    const ink = within(chord).getByText(askChord());
    expect(ink.tagName).toBe('SPAN');
    expect(ink).toHaveClass('text-foreground');
    const cap = ink.parentElement!;
    expect(cap.className).toMatch(/ml-1\.5/);
    expect(cap.previousSibling?.textContent).toBe(' Open it with');
    // The flat neutral keycap, never the lime ButtonKey.
    expect(document.querySelector('[data-slot="button-key"]')).toBeNull();
  });

  it('is one sentence once something is connected, its three names in ink', async () => {
    await mount(GEMINI_WORKING);
    const explainer = screen.getByTestId('ai-explainer');
    expect(explainer).toHaveAttribute('data-form', 'sentence');
    expect(explainer.textContent).toBe(
      `AI in dsul is Ask (${askChord()}), plan suggestions and Break it down. Nothing in your planner changes unless you say yes.`
    );
    const strong = Array.from(explainer.querySelectorAll('strong'));
    expect(strong.map((s) => s.textContent)).toEqual(['Ask', 'plan suggestions', 'Break it down']);
    for (const s of strong) expect(s).toHaveClass('text-foreground');
    expect(within(explainer).getByTestId('ai-explainer-chord')).toHaveClass('hidden', 'md:inline');
  });

  it('follows a rebinding', async () => {
    useKeyboardShortcutsStore.setState({ overrides: { toggle_right_sidebar: ['meta', 'shift', 'k'] } });
    await mount(GEMINI_WORKING);
    expect(screen.getByTestId('ai-explainer-chord').textContent).toBe(' (Ctrl+Shift+K)');
    expect(screen.getByTestId('ai-explainer')).toHaveTextContent('AI in dsul is Ask (Ctrl+Shift+K), plan suggestions');
  });

  it('never names the chord where it does nothing', async () => {
    // Pull-only: nothing answers and nothing is offered, so Ctrl+J is inert.
    const first = await mount(OPENCLAW_PULL_ONLY);
    expect(screen.queryByTestId('ai-explainer-chord')).toBeNull();
    expect(screen.getByTestId('ai-explainer').textContent).toBe(
      'AI in dsul is Ask, plan suggestions and Break it down. Nothing in your planner changes unless you say yes.'
    );
    first.unmount();
    cleanupAI?.();

    // Chat Off on this device.
    const second = await mount({ ...NOTHING_CONNECTED, choice: 'none' });
    expect(screen.getByTestId('ai-explainer')).toHaveAttribute('data-form', 'tiles');
    expect(screen.queryByTestId('ai-explainer-chord')).toBeNull();
    second.unmount();
    cleanupAI?.();

    // No model on this server.
    const third = await mount({ ...NOTHING_CONNECTED, available: false });
    expect(screen.queryByTestId('ai-explainer-chord')).toBeNull();
    third.unmount();
    cleanupAI?.();

    // A key that needs fixing offers the fix, so the chord does something.
    await mount(KEY_TURNED_DOWN);
    expect(screen.getByTestId('ai-explainer-chord')).toBeInTheDocument();
  });

  it('is absent while the check is out, and while AI is off', async () => {
    const first = await mount('unknown');
    expect(screen.queryByTestId('ai-explainer')).toBeNull();
    first.unmount();
    await mount(AI_OFF_CONNECTED);
    expect(screen.queryByTestId('ai-explainer')).toBeNull();
  });
});

/* ── Use AI in dsul ─────────────────────────────────────────────────────── */

describe('Use AI in dsul', () => {
  function expectChip() {
    const row = aiUseRow();
    const chip = within(row).getByTestId('scope-chip');
    expect(chip).toHaveAttribute('data-scope', 'account');
    expect(chip).toHaveTextContent('All your devices');
    expect(chip).toHaveClass('shrink-0', 'whitespace-nowrap', 'rounded-[5px]');
    expect(chip.parentElement).toHaveClass('flex-wrap');
    // No modified bar, in any form.
    expect(row.className).not.toMatch(/before:/);
    expect(within(row).queryByRole('button', { name: /Reset to default/ })).toBeNull();
    expect(row).toHaveAttribute('data-setting-row', 'beacon.useAi');
  }

  it('nothing connected: "No AI, thanks", not a switch', async () => {
    await mount(NOTHING_CONNECTED);
    expect(form()).toBe('button');
    expect(within(aiUseRow()).getByTestId('ai-no-ai-thanks')).toHaveTextContent('No AI, thanks');
    expect(within(aiUseRow()).queryByRole('switch')).toBeNull();
    expect(screen.getByTestId('ai-use-desc')).toHaveTextContent(USE_AI_COPY.button);
    expectChip();
  });

  it('on: the switch, checked', async () => {
    await mount(GEMINI_WORKING);
    expect(form()).toBe('on');
    const toggle = within(aiUseRow()).getByRole('switch', { name: 'Use AI in dsul' });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAttribute('data-setting', 'beacon.useAi');
    expect(screen.getByTestId('ai-use-desc')).toHaveTextContent(USE_AI_COPY.on);
    expect(toggle).toHaveAttribute('aria-describedby', screen.getByTestId('ai-use-desc').id);
    expectChip();
  });

  it('off: the switch, unchecked', async () => {
    await mount(AI_OFF_CONNECTED);
    expect(form()).toBe('off');
    expect(within(aiUseRow()).getByRole('switch', { name: 'Use AI in dsul' })).not.toBeChecked();
    expect(screen.getByTestId('ai-use-desc')).toHaveTextContent(USE_AI_COPY.off);
    expectChip();
  });

  it('while the check is out: still loading, and no sentence that might not be true', async () => {
    await mount('unknown');
    expect(form()).toBe('pending');
    expect(screen.getByRole('status', { name: 'Use AI in dsul, still loading' })).toBeInTheDocument();
    expect(aiUseRow()).toHaveTextContent('Still loading…');
    expect(screen.queryByTestId('ai-use-desc')).toBeNull();
    expect(within(aiUseRow()).queryByRole('switch')).toBeNull();
    expectChip();
  });

  it('when the account cannot keep the choice (060 missing): unavailable, in words', async () => {
    await mount({ ...NOTHING_CONNECTED, aiHidden: null });
    expect(form()).toBe('unavailable');
    expect(within(aiUseRow()).queryByRole('switch')).toBeNull();
    expect(screen.queryByTestId('ai-no-ai-thanks')).toBeNull();
    expect(screen.queryByTestId('ai-use-desc')).toBeNull();
    expect(aiUseRow()).toHaveTextContent('Unavailable: Needs a database update that has not landed here yet.');
    expectChip();
  });

  it('when the check failed: one status line, and the reason said once, by the card below', async () => {
    await mount('error');
    expect(form()).toBe('unavailable');
    expect(aiUseRow()).toHaveTextContent('Unavailable until the check below works.');
    expect(screen.queryByTestId('ai-use-desc')).toBeNull();
    expect(screen.getAllByText('Couldn’t check your AI connection.')).toHaveLength(1);
    expectChip();
  });

  it('is never disabled, whatever the store is busy with', async () => {
    const first = await mount(GEMINI_WORKING);
    for (const busy of ['recheck', 'hidden'] as const) {
      act(() => useAIConnectionStore.setState({ busy }));
      const toggle = screen.getByTestId('ai-use-switch');
      expect(toggle).not.toHaveAttribute('disabled');
      expect(toggle).not.toHaveAttribute('data-disabled');
    }
    act(() => useAIConnectionStore.setState({ busy: null }));
    first.unmount();
    cleanupAI?.();

    await mount(NOTHING_CONNECTED);
    act(() => useAIConnectionStore.setState({ busy: 'connect' }));
    expect(screen.getByTestId('ai-no-ai-thanks')).not.toHaveAttribute('disabled');
    act(() => useAIConnectionStore.setState({ busy: null }));
  });
});

describe('Use AI in dsul: writes and focus', () => {
  it('"No AI, thanks" turns AI off, and focus moves to the switch that replaced it; on again, back', async () => {
    given(NOTHING_CONNECTED);
    acceptHidden();
    renderPane();
    await settle();

    const button = screen.getByTestId('ai-no-ai-thanks');
    button.focus();
    fireEvent.click(button);
    const toggle = screen.getByTestId('ai-use-switch');
    expect(toggle).toHaveAttribute('data-state', 'unchecked');
    expect(document.activeElement).toBe(toggle);
    await waitFor(() => expect(patches()).toEqual([{ hidden: true }]));
    await settle();
    expect(useAIConnectionStore.getState().aiHidden).toBe(true);
    expect(screen.getByTestId('mcp-ai-off')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-use-switch'));
    expect(document.activeElement).toBe(screen.getByTestId('ai-no-ai-thanks'));
    await waitFor(() => expect(patches()).toEqual([{ hidden: true }, { hidden: false }]));
    await settle();
    expect(useAIConnectionStore.getState().aiHidden).toBe(false);
    expect(document.activeElement).toBe(screen.getByTestId('ai-no-ai-thanks'));

    // The pane's switch is the account's answer and nothing else: no undo
    // strip (the off state is its own undo), and nothing went wrong.
    expect(useUndoStripStore.getState().entry).toBeNull();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('connected: off then on is two writes, in order', async () => {
    given(GEMINI_WORKING);
    acceptHidden();
    renderPane();
    await settle();
    fireEvent.click(screen.getByTestId('ai-use-switch'));
    await waitFor(() => expect(patches()).toEqual([{ hidden: true }]));
    await settle();
    expect(screen.getByTestId('ai-use-switch')).toHaveAttribute('data-state', 'unchecked');
    fireEvent.click(screen.getByTestId('ai-use-switch'));
    await waitFor(() => expect(patches()).toEqual([{ hidden: true }, { hidden: false }]));
    await settle();
    expect(screen.getByTestId('ai-use-switch')).toHaveAttribute('data-state', 'checked');
    expect(useUndoStripStore.getState().entry).toBeNull();
  });

  it('a refused "No AI, thanks" swaps back, focus follows it, and says so', async () => {
    given(NOTHING_CONNECTED);
    // The default PATCH answers 503, and the server still says AI is on.
    renderPane();
    await settle();
    const button = screen.getByTestId('ai-no-ai-thanks');
    button.focus();
    fireEvent.click(button);
    expect(document.activeElement).toBe(screen.getByTestId('ai-use-switch'));
    await waitFor(() => expect(form()).toBe('button'));
    expect(document.activeElement).toBe(screen.getByTestId('ai-no-ai-thanks'));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(AI_OFF_FAILED));
    expect(useAIConnectionStore.getState().aiHidden).toBe(false);
  });

  it('a refused "on" leaves AI off, the card back, and says so', async () => {
    given(AI_HIDDEN);
    renderPane();
    await settle();
    fireEvent.click(screen.getByTestId('ai-use-switch'));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(AI_BACK_ON_FAILED));
    expect(useAIConnectionStore.getState().aiHidden).toBe(true);
    expect(screen.getByTestId('mcp-ai-off')).toBeInTheDocument();
    expect(form()).toBe('off');
  });

  it('a write that landed but whose answer was lost turns AI on, and says nothing failed', async () => {
    given(AI_HIDDEN);
    server.patch = () => {
      server.status = { ...(server.status as AIConnectionResponse), aiHidden: false };
      throw new TypeError('Failed to fetch');
    };
    renderPane();
    await settle();
    fireEvent.click(screen.getByTestId('ai-use-switch'));
    await waitFor(() => expect(useAIConnectionStore.getState().aiHidden).toBe(false));
    await settle();
    expect(screen.queryByTestId('mcp-ai-off')).toBeNull();
    expect(form()).toBe('button');
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('a connect that swaps the form pulls no focus to this row', async () => {
    given(NOTHING_CONNECTED);
    const gemini = view({ provider: 'gemini', model: 'gemini-flash-latest' });
    server.put = () => json({ connection: gemini, models: [], listed: true });
    renderPane();
    await settle();
    server.status = { ...NOTHING, model: gemini };
    paste(screen.getByTestId('connect-key'), GEMINI_SENTINEL);
    await waitFor(() => expect(form()).toBe('on'));
    await settle();
    expect(document.activeElement).not.toBe(screen.getByTestId('ai-use-switch'));
    expect(screen.queryByTestId('ai-no-ai-thanks')).toBeNull();
    expect(patches()).toEqual([]);
  });

  it('a Disconnect that swaps the form pulls no focus to this row', async () => {
    given(CONNECTED_MODEL, view());
    renderPane();
    await settle();
    fireEvent.click(screen.getByTestId('mcp-disconnect'));
    const request = useUIStore.getState().confirmRequest!;
    expect(request.testId).toBe('model-disconnect-confirm');
    server.status = NOTHING;
    act(() => {
      useUIStore.setState({ confirmRequest: null });
      request.onConfirm();
    });
    await waitFor(() => expect(form()).toBe('button'));
    await settle();
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(document.activeElement).not.toBe(screen.getByTestId('ai-no-ai-thanks'));
    expect(patches()).toEqual([]);
  });
});

/* ── The Connection section ─────────────────────────────────────────────── */

describe('the Connection section never remounts', () => {
  /** The panel's ancestors up to the Connection wrapper: the four fixed alias slots. */
  function slotDepth() {
    const panel = screen.getByTestId('model-connection-panel');
    let n = 0;
    let el = panel.parentElement;
    while (el && el.dataset.aiSection !== 'connection') {
      expect(el.tagName).toBe('DIV');
      n += 1;
      el = el.parentElement;
    }
    expect(el, 'no Connection wrapper above the panel').not.toBeNull();
    return n;
  }

  it('a connect from F18 keeps the panel, so its just-connected line shows', async () => {
    given(NOTHING_CONNECTED);
    const gemini = view({ provider: 'gemini', model: 'gemini-flash-latest' });
    server.put = () => json({ connection: gemini, models: [], listed: true });
    renderPane();
    await settle();
    const panel = screen.getByTestId('model-connection-panel');
    // F18 wears the device aliases on the Connection slots; Working draws the rows.
    expect(document.querySelector('[data-setting-alias="beacon.provider"]')).not.toBeNull();
    server.status = { ...NOTHING, model: gemini };
    paste(screen.getByTestId('connect-key'), GEMINI_SENTINEL);
    expect(await screen.findByTestId('mcp-just-connected')).toBeInTheDocument();
    expect(screen.getByTestId('model-connection-panel')).toBe(panel);
    expect(document.querySelector('[data-setting-alias="beacon.provider"]')).toBeNull();
    expect(screen.getByTestId('ai-device')).toBeInTheDocument();
    await settle();
  });

  it('the answer arriving keeps a one-shot ?connect= notice, and asks only once', async () => {
    __armUserForTests(SEED_USER_ID);
    useAIConnectionStore.setState({ phase: 'unknown' });
    cleanupAI = () => {
      useAIConnectionStore.getState().reset();
      useAISettingsStore.getState().clearUserScopedState();
    };
    nav.params = new URLSearchParams('connect=denied');
    server.status = NOTHING;
    renderPane();
    const panel = screen.getByTestId('model-connection-panel');
    expect(screen.getByTestId('mcp-flow-notice')).toBeInTheDocument();
    expect(slotDepth()).toBe(4);
    await waitFor(() => expect(useAIConnectionStore.getState().phase).toBe('ready'));
    await settle();
    expect(screen.getByTestId('model-connection-panel')).toBe(panel);
    expect(screen.getByTestId('mcp-flow-notice')).toBeInTheDocument();
    expect(statusGets()).toBe(1);
  });

  it.each([
    ['unknown', 'unknown'],
    ['error', 'error'],
    ['F18', NOTHING_CONNECTED],
    ['no model on this server', { ...NOTHING_CONNECTED, available: false }],
    ['F19', GEMINI_WORKING],
    ['F20', KEY_TURNED_DOWN],
    ['F21', DAILY_LIMIT],
    ['pull-only', OPENCLAW_PULL_ONLY],
  ] as const)('sits under four alias slots: %s', async (_name, seed) => {
    await mount(seed as SeedAI | 'unknown' | 'error');
    expect(slotDepth()).toBe(4);
  });
});

/* ── On this device ─────────────────────────────────────────────────────── */

describe('On this device', () => {
  it('is hidden in F18', async () => {
    await mount(NOTHING_CONNECTED);
    expect(screen.queryByTestId('ai-device')).toBeNull();
  });

  it('draws its caption, its chip and both rows through rowFor, in order', async () => {
    await mount({ ...NOTHING_CONNECTED, choice: 'none' });
    const device = screen.getByTestId('ai-device');
    expect(within(device).getByRole('heading', { name: 'On this device' })).toBeInTheDocument();
    expect(within(device).getByTestId('scope-chip')).toHaveAttribute('data-scope', 'device');
    expect(device).toHaveTextContent(
      'These two stay on this device, so your phone and the desktop app can each have their own.'
    );
    const rows = Array.from(device.querySelectorAll<HTMLElement>('[data-setting-row]'));
    expect(rows.map((r) => r.dataset.settingRow)).toEqual(['beacon.provider', 'beacon.instructions']);
    expect(rows[0].parentElement).toHaveClass('border-t');
  });

  it('stays for the visit once shown: choosing a chat target keeps it', async () => {
    await mount({ ...NOTHING_CONNECTED, choice: 'none' });
    expect(screen.getByTestId('ai-device')).toBeInTheDocument();
    act(() => useAISettingsStore.setState({ chatTarget: 'model' }));
    expect(screen.getByTestId('ai-device')).toBeInTheDocument();
    // Its rows are real, so the Connection slots no longer stand in for them.
    expect(document.querySelector('[data-setting-alias="beacon.provider"]')).toBeNull();
    expect(document.querySelectorAll('[data-setting-row="beacon.provider"]')).toHaveLength(1);
  });
});

/* ── AI is off ──────────────────────────────────────────────────────────── */

describe('the AI-off card', () => {
  it('says AI is off, and what is still connected', async () => {
    await mount(AI_OFF_CONNECTED);
    const card = screen.getByTestId('mcp-ai-off');
    expect(card.tagName).toBe('SECTION');
    expect(within(card).getByRole('heading', { name: 'AI is off' })).toBeInTheDocument();
    expect(card).toHaveTextContent(
      'dsul won’t show AI or bring it up again until you turn it back on above. Your planner works exactly the same.'
    );
    const connected = within(card).getByTestId('ai-off-connected');
    expect(connected).toHaveTextContent('Google Gemini is still connected');
    expect(connected).toHaveTextContent(
      'Your key stays saved, so turning AI back on picks up where you left off. Disconnect to delete it.'
    );
    expect(within(card).queryByTestId('ai-off-paired')).toBeNull();
    // Directly under the switch, and nothing below it.
    expect(aiUseRow().compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId('model-connection-panel')).toBeNull();
    expect(screen.queryByTestId('ai-openclaw')).toBeNull();
    expect(screen.queryByTestId('ai-device')).toBeNull();
  });

  it('says "sign-in" for a sign-in', async () => {
    given(AI_OFF_CONNECTED, view({ provider: 'openrouter', model: 'openai/gpt-4o-mini', authMethod: 'oauth' }));
    renderPane();
    await settle();
    const connected = screen.getByTestId('ai-off-connected');
    expect(connected).toHaveTextContent('OpenRouter is still connected');
    expect(connected).toHaveTextContent(
      'Your sign-in stays saved, so turning AI back on picks up where you left off. Disconnect to delete it.'
    );
  });

  it('Disconnect asks first, then deletes the key, and focus goes to the card', async () => {
    await mount(AI_OFF_CONNECTED);
    const button = screen.getByTestId('ai-off-disconnect');
    expect(button.className).toMatch(/text-destructive-text/);
    button.focus();
    fireEvent.click(button);
    const request = useUIStore.getState().confirmRequest!;
    expect(request.testId).toBe('model-disconnect-confirm');
    expect(request.title).toBe('Disconnect Google Gemini?');
    expect(request.destructive).toBe(true);
    expect(typeof request.fallbackFocus).toBe('function');
    server.status = { ...NOTHING, aiHidden: true };
    act(() => {
      useUIStore.setState({ confirmRequest: null });
      request.onConfirm();
    });
    await waitFor(() => expect(screen.queryByTestId('ai-off-connected')).toBeNull());
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByTestId('mcp-ai-off'));
    // A DELETE that lands before the confirm has finished closing: the
    // dialog runs fallbackFocus, which lands on the card too.
    (document.activeElement as HTMLElement).blur();
    act(() => request.fallbackFocus!());
    expect(document.activeElement).toBe(screen.getByTestId('mcp-ai-off'));
  });

  it('cancel deletes nothing and moves no focus', async () => {
    await mount(AI_OFF_CONNECTED);
    const button = screen.getByTestId('ai-off-disconnect');
    button.focus();
    fireEvent.click(button);
    expect(useUIStore.getState().confirmRequest).not.toBeNull();
    act(() => useUIStore.setState({ confirmRequest: null }));
    await settle();
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect(document.activeElement).toBe(button);
    expect(screen.getByTestId('ai-off-connected')).toBeInTheDocument();
  });

  it('a refused delete keeps the row and says why', async () => {
    await mount(AI_OFF_CONNECTED);
    server.del = () => json({ error: 'server' }, 503);
    fireEvent.click(screen.getByTestId('ai-off-disconnect'));
    const request = useUIStore.getState().confirmRequest!;
    act(() => {
      useUIStore.setState({ confirmRequest: null });
      request.onConfirm();
    });
    const error = await screen.findByTestId('ai-off-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error.textContent).not.toBe('');
    expect(screen.getByTestId('ai-off-connected')).toBeInTheDocument();
  });

  it('names a live pairing, and says this switch leaves it alone', async () => {
    await mount(AI_OFF_PAIRED);
    const paired = screen.getByTestId('ai-off-paired');
    expect(paired).toHaveTextContent('atlas is still paired');
    expect(paired).toHaveTextContent(
      'OpenClaw reads your planner through its own pairing, which this switch doesn’t touch. Unpair it to stop that.'
    );
    expect(within(paired).getByRole('button', { name: 'Unpair' }).className).toMatch(/text-destructive-text/);
    expect(screen.queryByTestId('ai-off-connected')).toBeNull();
  });

  it.each([
    ['the main agent', { agent: true, pluginChat: true, agentId: 'main' }],
    ['a stale id with no chat transport', { agent: true, agentId: 'atlas' }],
  ])('calls %s OpenClaw', async (_name, openclaw) => {
    await mount({ ...AI_HIDDEN, openclaw });
    expect(screen.getByTestId('ai-off-paired')).toHaveTextContent('OpenClaw is still paired');
  });

  it('lists a kept model before a pairing', async () => {
    await mount({ ...AI_OFF_CONNECTED, openclaw: AI_OFF_PAIRED.openclaw });
    const connected = screen.getByTestId('ai-off-connected');
    const paired = screen.getByTestId('ai-off-paired');
    expect(connected.compareDocumentPosition(paired) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('with nothing connected is the card alone', async () => {
    await mount(AI_HIDDEN);
    expect(screen.getByTestId('mcp-ai-off')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-off-connected')).toBeNull();
    expect(screen.queryByTestId('ai-off-paired')).toBeNull();
  });

  it('Unpair asks first, then unpairs, and focus goes to the card', async () => {
    await mount({ ...AI_OFF_CONNECTED, openclaw: AI_OFF_PAIRED.openclaw });
    const button = screen.getByTestId('ai-off-unpair');
    button.focus();
    fireEvent.click(button);
    const request = useUIStore.getState().confirmRequest!;
    expect(request.testId).toBe('openclaw-unpair-confirm');
    expect(request.title).toBe('Unpair atlas?');
    expect(request.description).toBe(
      'dsul will delete the key OpenClaw uses and stop sending it your changes, so it can no longer read or change your planner. Your saved conversations stay. To pair again, run setup from OpenClaw.'
    );
    expect(request.confirmLabel).toBe('Unpair');
    expect(request.destructive).toBe(true);
    expect(request.touchesPlanner).toBe(false);
    expect(typeof request.fallbackFocus).toBe('function');
    expect(unpairs()).toBe(0);
    act(() => {
      useUIStore.setState({ confirmRequest: null });
      request.onConfirm();
    });
    await waitFor(() => expect(screen.queryByTestId('ai-off-paired')).toBeNull());
    expect(unpairs()).toBe(1);
    // The model's key is not the agent's: Disconnect's row stays.
    expect(screen.getByTestId('ai-off-connected')).toBeInTheDocument();
    expect(calls.filter((c) => c.url === '/api/ai/connection' && c.method === 'DELETE')).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByTestId('mcp-ai-off'));
    expect(resetPluginTransport).toHaveBeenCalled();
  });

  it('cancel unpairs nothing and moves no focus', async () => {
    await mount(AI_OFF_PAIRED);
    const button = screen.getByTestId('ai-off-unpair');
    button.focus();
    fireEvent.click(button);
    act(() => useUIStore.setState({ confirmRequest: null }));
    await settle();
    expect(unpairs()).toBe(0);
    expect(document.activeElement).toBe(button);
    expect(screen.getByTestId('ai-off-paired')).toBeInTheDocument();
  });

  it('a refused unpair keeps the row, says so, and asks the server again', async () => {
    await mount(AI_OFF_PAIRED);
    vi.mocked(resetPluginTransport).mockClear();
    server.unpair = () => json({ error: 'server' }, 503);
    const before = statusGets();
    fireEvent.click(screen.getByTestId('ai-off-unpair'));
    const request = useUIStore.getState().confirmRequest!;
    act(() => {
      useUIStore.setState({ confirmRequest: null });
      request.onConfirm();
    });
    const error = await screen.findByTestId('ai-off-unpair-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent(UNPAIR_FAILED);
    expect(screen.getByTestId('ai-off-paired')).toBeInTheDocument();
    await waitFor(() => expect(statusGets()).toBeGreaterThan(before));
    expect(resetPluginTransport).not.toHaveBeenCalled();
  });
});

/* ── The mark ───────────────────────────────────────────────────────────── */

describe('the live mark', () => {
  const mark = () => document.querySelector('[data-ask-mark]');

  it.each([
    ['working', GEMINI_WORKING],
    ['daily limit', DAILY_LIMIT],
    ['OpenClaw answering', OPENCLAW_PLUGIN],
  ])('is lit while something answers: %s', (_name, seed) => {
    cleanupAI = seedAI(seed);
    render(<AIPaneMark className="size-3" />);
    expect(mark()).not.toBeNull();
    expect(mark()).not.toHaveAttribute('data-lit');
    expect(mark()).toHaveClass('size-3');
  });

  it.each([
    ['nothing connected', NOTHING_CONNECTED],
    ['a key turned down (F20)', KEY_TURNED_DOWN],
    ['AI off', AI_OFF_CONNECTED],
    ['pull-only', OPENCLAW_PULL_ONLY],
  ])('is unlit while nothing answers: %s', (_name, seed) => {
    cleanupAI = seedAI(seed);
    render(<AIPaneMark />);
    expect(mark()).toHaveAttribute('data-lit', 'false');
  });
});

/* ── Lime ───────────────────────────────────────────────────────────────── */

describe('nothing lime while nothing answers', () => {
  it.each([
    ['F18', NOTHING_CONNECTED],
    ['F18 with chat Off here', { ...NOTHING_CONNECTED, choice: 'none' }],
  ] as const)('%s', async (_name, seed) => {
    await mount(seed as SeedAI);
    expect(lime()).toEqual([]);
    const marks = Array.from(document.querySelectorAll('[data-testid="ai-pane"] [data-ask-mark]'));
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) expect(m).toHaveAttribute('data-lit', 'false');
  });

  it('F22', async () => {
    await mount(AI_OFF_CONNECTED);
    expect(lime()).toEqual([]);
    expect(screen.getByTestId('ai-use-switch')).toHaveAttribute('data-state', 'unchecked');
  });

  it('pull-only (the switch is the house switch, and stays lime)', async () => {
    await mount(OPENCLAW_PULL_ONLY);
    expect(lime()).toEqual([]);
    expect(screen.getByTestId('openclaw-status')).toHaveAttribute('data-tone', 'grey');
  });

  it('and lime once something answers (the check would see it)', async () => {
    given(GEMINI_WORKING);
    render(
      <>
        <AIPaneMark />
        <AIPane
          ctx={ctx}
          isMobile={false}
          highlightId={null}
          rowFor={rowFor}
          gatewayOpen={false}
          onToggleGateway={() => {}}
        />
      </>
    );
    await settle();
    const dot = screen.getByTestId('mcp-status').querySelector('[data-dot]');
    expect(dot).toHaveClass('bg-primary');
    expect(lime().length).toBeGreaterThan(0);
    expect(document.querySelector('[data-ask-mark]:not([data-lit])')).not.toBeNull();
  });
});

/* ── Scope chips ────────────────────────────────────────────────────────── */

describe('ScopeChip', () => {
  const glyphs = () => Array.from(document.querySelectorAll<SVGElement>('[data-glyph]')).map((g) => g.dataset.glyph);

  it('the account: all your devices', () => {
    render(<ScopeChip scope="account" />);
    expect(glyphs()).toEqual(['tablet-smartphone']);
    expect(screen.getByTestId('scope-chip')).toHaveTextContent('All your devices');
  });

  it('this device on the web: a monitor, and a phone below md', () => {
    render(<ScopeChip scope="device" />);
    expect(glyphs()).toEqual(['monitor', 'smartphone']);
    expect(document.querySelector('[data-glyph="monitor"]')).toHaveClass('hidden', 'md:block');
    expect(document.querySelector('[data-glyph="smartphone"]')).toHaveClass('md:hidden');
    expect(screen.getByTestId('scope-chip')).toHaveTextContent('This browser only');
  });

  describe('in the desktop app', () => {
    beforeEach(() => {
      (window as unknown as { dsulDesktop?: unknown }).dsulDesktop = { version: 1 };
    });
    afterEach(() => {
      delete (window as unknown as { dsulDesktop?: unknown }).dsulDesktop;
    });

    it('this device: a laptop only, and the same words', () => {
      render(<ScopeChip scope="device" />);
      expect(glyphs()).toEqual(['laptop']);
      expect(screen.getByTestId('scope-chip')).toHaveTextContent('This browser only');
    });
  });
});

/* ── OpenClaw ───────────────────────────────────────────────────────────── */

describe('OpenClaw', () => {
  const copy = () => screen.getByTestId('openclaw-copy').textContent;
  const pill = () => screen.getByTestId('openclaw-status');

  it('not paired: an invitation, and a link to pair from the docs', async () => {
    await mount(NOTHING_CONNECTED);
    const section = screen.getByTestId('ai-openclaw');
    expect(within(section).getByRole('heading', { name: 'OpenClaw' })).toBeInTheDocument();
    expect(pill()).toHaveTextContent('Not paired');
    expect(pill()).toHaveAttribute('data-tone', 'grey');
    expect(section).toHaveTextContent(
      'Run your own OpenClaw agent? Pair it, and it can answer in Ask and take on tasks you hand it.'
    );
    expect(within(section).getByTestId('openclaw-pair')).toHaveAttribute('href', '/docs/openclaw');
    expect(within(section).getByTestId('openclaw-pair')).toHaveTextContent('Pair OpenClaw');
    expect(screen.queryByTestId('openclaw-copy')).toBeNull();
  });

  it('paired and answering here: lime, by its name', async () => {
    await mount(OPENCLAW_PLUGIN);
    expect(pill()).toHaveTextContent('Paired');
    expect(pill()).toHaveAttribute('data-tone', 'lime');
    expect(copy()).toBe('kirby-1 can answer in Ask and take on tasks you hand it.');
    expect(screen.queryByTestId('openclaw-pair')).toBeNull();
  });

  it.each([
    ['no name', OPENCLAW_PULL_ONLY],
    ['a stale name', { ...OPENCLAW_PULL_ONLY, openclaw: { agent: true, agentId: 'atlas' } }],
  ])('pull-only (%s): grey, and OpenClaw by name', async (_name, seed) => {
    await mount(seed);
    expect(pill()).toHaveTextContent('Paired');
    expect(pill()).toHaveAttribute('data-tone', 'grey');
    expect(copy()).toBe('OpenClaw takes on tasks you hand it.');
  });

  it('a gateway alone, with no Unpair: its own rows clear it', async () => {
    await mount({ ...NOTHING_CONNECTED, openclaw: { gateway: true } });
    expect(pill()).toHaveTextContent('Paired');
    expect(copy()).toBe('OpenClaw can answer in Ask through your gateway.');
    expect(screen.queryByTestId('openclaw-unpair')).toBeNull();
  });

  it.each([
    ['answering', OPENCLAW_PLUGIN],
    ['pull-only', OPENCLAW_PULL_ONLY],
  ])('paired (%s): Unpair, in red text', async (_name, seed) => {
    await mount(seed);
    const button = within(screen.getByTestId('ai-openclaw')).getByTestId('openclaw-unpair');
    expect(button).toHaveTextContent('Unpair');
    expect(button.className).toMatch(/text-destructive-text/);
  });

  it('Unpair leaves Not paired and the way to pair again, with focus on the section', async () => {
    await mount(OPENCLAW_PLUGIN);
    fireEvent.click(screen.getByTestId('openclaw-unpair'));
    const request = useUIStore.getState().confirmRequest!;
    expect(request.title).toBe('Unpair kirby-1?');
    expect(request.description).not.toContain('Gateway');
    act(() => {
      useUIStore.setState({ confirmRequest: null });
      request.onConfirm();
    });
    await waitFor(() => expect(pill()).toHaveTextContent('Not paired'));
    expect(screen.getByTestId('openclaw-pair')).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId('ai-openclaw'));
  });

  it('with a gateway too, the confirm says it stays, and so does the gateway', async () => {
    await mount({ ...OPENCLAW_PLUGIN, openclaw: { ...OPENCLAW_PLUGIN.openclaw, gateway: true } });
    fireEvent.click(screen.getByTestId('openclaw-unpair'));
    const request = useUIStore.getState().confirmRequest!;
    expect(request.description).toContain(
      'Your Gateway URL stays saved under Advanced, so OpenClaw can still answer in Ask. Clear it there to stop that too.'
    );
    act(() => {
      useUIStore.setState({ confirmRequest: null });
      request.onConfirm();
    });
    await waitFor(() => expect(screen.queryByTestId('openclaw-unpair')).toBeNull());
    expect(pill()).toHaveTextContent('Paired');
    expect(copy()).toBe('OpenClaw can answer in Ask through your gateway.');
  });

  it('a refused unpair stays paired and says so', async () => {
    await mount(OPENCLAW_PULL_ONLY);
    server.unpair = () => json({ error: 'server' }, 503);
    fireEvent.click(screen.getByTestId('openclaw-unpair'));
    const request = useUIStore.getState().confirmRequest!;
    act(() => {
      useUIStore.setState({ confirmRequest: null });
      request.onConfirm();
    });
    expect(await screen.findByTestId('openclaw-unpair-error')).toHaveTextContent(UNPAIR_FAILED);
    expect(pill()).toHaveTextContent('Paired');
  });

  it('both section pills sit flush right in their header rows', async () => {
    await mount(GEMINI_WORKING);
    expect(pill().parentElement).toHaveClass('justify-between');
    expect(screen.getByTestId('mcp-status').parentElement).toHaveClass('justify-between');
  });

  it('keeps the gateway rows in its own fold, which the shell drives', async () => {
    const toggle = vi.fn();
    const first = await mount(NOTHING_CONNECTED, { onToggleGateway: toggle });
    const button = screen.getByTestId('openclaw-gateway-toggle');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveTextContent('Advanced');
    expect(document.querySelector('[data-setting-row="beacon.gatewayUrl"]')).toBeNull();
    fireEvent.click(button);
    expect(toggle).toHaveBeenCalledTimes(1);
    first.unmount();
    cleanupAI?.();

    await mount(NOTHING_CONNECTED, { gatewayOpen: true });
    expect(screen.getByTestId('openclaw-gateway-toggle')).toHaveAttribute('aria-expanded', 'true');
    const rows = Array.from(
      screen.getByTestId('ai-openclaw').querySelectorAll<HTMLElement>('[data-setting-row]')
    ).map((r) => r.dataset.settingRow);
    expect(rows).toEqual(['beacon.gatewayUrl', 'beacon.gatewayToken']);
  });
});

/* ── Anchors ────────────────────────────────────────────────────────────── */

type Where =
  | { kind: 'row' }
  | { kind: 'slot' }
  | { kind: 'off' }
  | { kind: 'holds'; testId: string }
  | { kind: 'says'; text: string };

const R: Where = { kind: 'row' };
const SLOT: Where = { kind: 'slot' };
const OFF: Where = { kind: 'off' };
const holds = (testId: string): Where => ({ kind: 'holds', testId });
const says = (text: string): Where => ({ kind: 'says', text });

const IDS = [
  'beacon.useAi',
  'beacon.apiKey',
  'beacon.model',
  'beacon.provider',
  'beacon.instructions',
  'beacon.gatewayUrl',
  'beacon.gatewayToken',
] as const;

function expectAnchor(id: string, where: Where) {
  const found = Array.from(
    document.querySelectorAll<HTMLElement>(`[data-setting-row="${id}"], [data-setting-alias="${id}"]`)
  );
  expect(found, `${id}: exactly one anchor`).toHaveLength(1);
  const el = found[0];
  const panel = screen.queryByTestId('model-connection-panel');
  if (where.kind === 'row') {
    expect(el.dataset.settingRow, id).toBe(id);
    return;
  }
  expect(el.dataset.settingAlias, id).toBe(id);
  if (where.kind === 'slot') {
    expect(panel && el.contains(panel), `${id}: a Connection slot`).toBe(true);
  } else if (where.kind === 'off') {
    expect(el.contains(screen.getByTestId('mcp-ai-off')), `${id}: the AI-off card`).toBe(true);
  } else {
    expect(panel?.contains(el), `${id}: inside the Connection section`).toBe(true);
    if (where.kind === 'holds') {
      const holdsIt = el.matches(`[data-testid="${where.testId}"]`) || el.querySelector(`[data-testid="${where.testId}"]`);
      expect(holdsIt, `${id}: on ${where.testId}`).toBeTruthy();
    } else {
      expect(el.textContent, id).toContain(where.text);
    }
  }
}

describe('every record has exactly one anchor, in every state', () => {
  const oauthFailing = view({
    provider: 'openrouter',
    model: 'openai/gpt-4o-mini',
    authMethod: 'oauth',
    status: 'failing',
    problem: 'key_rejected',
  });
  const READY_SLOTS = { 'beacon.provider': SLOT, 'beacon.instructions': SLOT, 'beacon.gatewayUrl': R, 'beacon.gatewayToken': R };
  const ROWS = { 'beacon.provider': R, 'beacon.instructions': R, 'beacon.gatewayUrl': R, 'beacon.gatewayToken': R };
  const ALL_SLOTS = { 'beacon.provider': SLOT, 'beacon.instructions': SLOT, 'beacon.gatewayUrl': SLOT, 'beacon.gatewayToken': SLOT };

  const table: Array<[string, SeedAI | 'unknown' | 'error', ModelConnectionView | null, Record<(typeof IDS)[number], Where>]> = [
    ['checking', 'unknown', null, { 'beacon.useAi': R, 'beacon.apiKey': holds('mcp-checking'), 'beacon.model': holds('mcp-checking'), ...ALL_SLOTS }],
    ['check failed', 'error', null, { 'beacon.useAi': R, 'beacon.apiKey': says('Couldn’t check your AI connection.'), 'beacon.model': says('Couldn’t check your AI connection.'), ...ALL_SLOTS }],
    ['unavailable', { ...NOTHING_CONNECTED, available: false }, null, { 'beacon.useAi': R, 'beacon.apiKey': holds('mcp-unavailable'), 'beacon.model': holds('mcp-unavailable'), ...READY_SLOTS }],
    ['F18', NOTHING_CONNECTED, null, { 'beacon.useAi': R, 'beacon.apiKey': holds('connect-key'), 'beacon.model': holds('mcp-connect-fresh'), ...READY_SLOTS }],
    ['F18 with chat Off here', { ...NOTHING_CONNECTED, choice: 'none' }, null, { 'beacon.useAi': R, 'beacon.apiKey': holds('connect-key'), 'beacon.model': holds('mcp-connect-fresh'), ...ROWS }],
    ['F19', GEMINI_WORKING, null, { 'beacon.useAi': R, 'beacon.apiKey': holds('mcp-provider'), 'beacon.model': holds('model-picker'), ...ROWS }],
    ['no model picked', NO_MODEL_PICKED, null, { 'beacon.useAi': R, 'beacon.apiKey': holds('mcp-provider'), 'beacon.model': holds('model-picker'), ...ROWS }],
    ['F20, a key', KEY_TURNED_DOWN, null, { 'beacon.useAi': R, 'beacon.apiKey': holds('fix-key'), 'beacon.model': holds('fix-line'), ...ROWS }],
    ['F20, a sign-in (no key box)', KEY_TURNED_DOWN, oauthFailing, { 'beacon.useAi': R, 'beacon.apiKey': holds('fix-explain'), 'beacon.model': holds('fix-line'), ...ROWS }],
    ['F21', DAILY_LIMIT, null, { 'beacon.useAi': R, 'beacon.apiKey': holds('mcp-provider'), 'beacon.model': holds('model-picker'), ...ROWS }],
    ['F22', AI_OFF_CONNECTED, null, { 'beacon.useAi': R, 'beacon.apiKey': OFF, 'beacon.model': OFF, 'beacon.provider': OFF, 'beacon.instructions': OFF, 'beacon.gatewayUrl': OFF, 'beacon.gatewayToken': OFF }],
    ['OpenClaw only', OPENCLAW_PLUGIN, null, { 'beacon.useAi': R, 'beacon.apiKey': holds('connect-key'), 'beacon.model': holds('mcp-connect-fresh'), ...ROWS }],
    ['pull-only', OPENCLAW_PULL_ONLY, null, { 'beacon.useAi': R, 'beacon.apiKey': holds('connect-key'), 'beacon.model': holds('mcp-connect-fresh'), ...ROWS }],
  ];

  it.each(table)('%s', async (_name, seed, model, cells) => {
    if (model && typeof seed === 'object') {
      given(seed, model);
      renderPane({ gatewayOpen: true });
      await settle();
    } else {
      await mount(seed, { gatewayOpen: true });
    }
    for (const id of IDS) expectAnchor(id, cells[id]);
  });

  it('rings the alias the shell highlights, and no other', async () => {
    await mount(NOTHING_CONNECTED, { highlightId: 'beacon.provider' });
    const ringed = Array.from(document.querySelectorAll<HTMLElement>('[data-highlight]'));
    expect(ringed).toHaveLength(1);
    expect(ringed[0].dataset.settingAlias).toBe('beacon.provider');
  });

  it('rings the Use AI row when the shell highlights it', async () => {
    await mount(NOTHING_CONNECTED, { highlightId: 'beacon.useAi' });
    expect(aiUseRow()).toHaveAttribute('data-highlight', 'true');
    expect(aiUseRow().className).toMatch(/after:ring-2/);
  });
});

/* ── The files ──────────────────────────────────────────────────────────── */

describe('the pane files', () => {
  it.each(['components/settings/ai-pane.tsx', 'components/settings/scope-chip.tsx'])(
    '%s has no em dashes, never names the AI, and says Ctrl, not ⌘',
    (file) => {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      expect(src).not.toMatch(/—/);
      expect(src).not.toMatch(/\bBeacon\b/);
      expect(src).not.toMatch(/⌘/);
      // No lime ButtonKey anywhere in the pane.
      expect(src).not.toMatch(/ButtonKey/);
    }
  );
});
