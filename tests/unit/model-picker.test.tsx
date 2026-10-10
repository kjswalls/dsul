import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The model picker (components/settings/model-picker.tsx) on its own: a
 * refused pick reaches its copy with the field the route named, so "the key
 * can't use that model" is told apart from a save that merely failed.
 *
 * The REAL connection store, a fake server behind `fetch`, and the list
 * seeded so opening the picker asks for nothing.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings/beacon',
  useSearchParams: () => new URLSearchParams(),
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
const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({
  toast: Object.assign(() => 'id', { error: toasts.error, dismiss: vi.fn(), success: vi.fn() }),
}));
vi.mock('@/lib/settings-service', () => ({
  saveSettings: vi.fn(async () => {}),
  flushSettings: vi.fn(async () => {}),
}));

import { ModelPicker } from '@/components/settings/model-picker';
import { ChatComposer } from '@/components/ai/chat-composer';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { connectErrorCopy } from '@/components/settings/model-connection-panel';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { modelName } from '@/lib/ai-model-names';
import { CONNECTED_MODEL, GEMINI_WORKING, OPENCLAW_PLUGIN, seedAI } from './helpers/ai-fixtures';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let patch: () => Response;
let cleanupAI: (() => void) | null = null;

beforeEach(() => {
  toasts.error.mockClear();
  patch = () => json({ error: 'server' }, 503);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/ai/connection' && init?.method === 'PATCH') return patch();
      // Anything else (a refresh after a refusal) answers the seeded connection.
      return json({
        available: true,
        model: useAIConnectionStore.getState().model,
        openclaw: { gateway: false, pluginChat: false, agent: false, agentId: null },
      });
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
  cleanupAI = seedAI({ ...CONNECTED_MODEL, model: { provider: 'anthropic', model: 'claude-opus-5-5' } });
  useAIConnectionStore.setState({
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
    ],
    modelsListed: true,
    modelsStatus: 'ready',
  });
});

afterEach(() => {
  cleanup();
  cleanupAI?.();
  cleanupAI = null;
  vi.unstubAllGlobals();
});

function pickSonnet() {
  fireEvent.click(screen.getByTestId('model-picker'));
  fireEvent.click(document.querySelector('[data-model-id="claude-sonnet-4-5-20250929"]')!);
}

describe('a refused pick', () => {
  it('hands its copy the field the route named', async () => {
    patch = () => json({ error: 'invalid', field: 'model' }, 400);
    const errorCopy = vi.fn((code: string, field: string | null) => `copy:${code}:${field}`);
    render(<ModelPicker errorCopy={errorCopy} />);
    pickSonnet();
    expect(await screen.findByTestId('model-picker-error')).toHaveTextContent('copy:invalid:model');
    expect(errorCopy).toHaveBeenCalledWith('invalid', 'model');
    // Rolled back: the chip still shows the model that answers.
    expect(screen.getByTestId('model-picker')).toHaveTextContent('Claude Opus 5.5');
  });

  it('hands it null when the route named none', async () => {
    patch = () => json({ error: 'busy' }, 429);
    const errorCopy = vi.fn((code: string, field: string | null) => `copy:${code}:${field}`);
    render(<ModelPicker errorCopy={errorCopy} />);
    pickSonnet();
    expect(await screen.findByTestId('model-picker-error')).toHaveTextContent('copy:busy:null');
    expect(errorCopy).toHaveBeenCalledWith('busy', null);
  });

  it('in the panel’s words: a model the key can’t use says so, and a failed save says only that', async () => {
    const copy = (code: Parameters<typeof connectErrorCopy>[0], field: string | null) =>
      connectErrorCopy(code, 'Anthropic', { during: 'model', field });
    patch = () => json({ error: 'invalid', field: 'model' }, 400);
    render(<ModelPicker errorCopy={copy} />);
    pickSonnet();
    expect(await screen.findByTestId('model-picker-error')).toHaveTextContent(
      'That model isn’t available to your key. Pick another.'
    );

    patch = () => json({ error: 'server' }, 503);
    pickSonnet();
    await waitFor(() =>
      expect(screen.getByTestId('model-picker-error')).toHaveTextContent('Couldn’t save. Try again.')
    );
  });
});

describe('the chip', () => {
  /** Seeded with no list loaded: the chip has only the saved connection to go by. */
  function seedWithoutList(seed: Parameters<typeof seedAI>[0]) {
    cleanupAI?.();
    cleanupAI = seedAI(seed);
    useAIConnectionStore.setState({ models: null, modelsListed: false, modelsStatus: 'idle' });
  }

  it('names the model before the list loads: gemini-flash-latest is Gemini Flash', () => {
    seedWithoutList(GEMINI_WORKING);
    render(<ModelPicker errorCopy={() => ''} />);
    expect(screen.getByTestId('model-picker')).toHaveTextContent('Gemini Flash');
    expect(screen.getByTestId('model-picker')).not.toHaveTextContent('gemini-flash-latest');
  });

  it('a model no catalog names reads as the label saved with the connection', () => {
    seedWithoutList({
      ...CONNECTED_MODEL,
      model: { provider: 'openrouter', model: 'mistralai/mistral-small', modelLabel: 'Mistral Small' },
    });
    render(<ModelPicker errorCopy={() => ''} />);
    const expected = modelName('openrouter', 'mistralai/mistral-small', 'Mistral Small').name;
    expect(expected).toBe('Mistral Small');
    expect(screen.getByTestId('model-picker')).toHaveTextContent(expected);
  });

  it('with no model saved yet it asks for one, and never throws', () => {
    seedWithoutList({ ...CONNECTED_MODEL, model: { provider: 'openai', model: null } });
    render(<ModelPicker errorCopy={() => ''} />);
    expect(screen.getByRole('button', { name: 'Choose a model' })).toBeInTheDocument();
  });
});

describe('in the chat box', () => {
  it('sits at the foot of the box while the model answers, and a pick there is the account’s model', async () => {
    let sent: unknown = null;
    patch = () => json({ model: { ...useAIConnectionStore.getState().model!, model: 'claude-sonnet-4-5-20250929' } });
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<ChatComposer variant="panel" binding={{ kind: 'home' }} />);
    const chip = screen.getByTestId('chat-model-chip');
    expect(chip).toHaveTextContent('Claude Opus 5.5');
    fireEvent.click(chip);
    fireEvent.click(document.querySelector('[data-model-id="claude-sonnet-4-5-20250929"]')!);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      sent = call ? JSON.parse(String(call[1]!.body)) : null;
      expect(sent).toMatchObject({ model: 'claude-sonnet-4-5-20250929' });
    });
  });

  it('says a refused pick in a toast, so the box does not move', async () => {
    patch = () => json({ error: 'invalid', field: 'model' }, 400);
    render(<ChatComposer variant="panel" binding={{ kind: 'home' }} />);
    fireEvent.click(screen.getByTestId('chat-model-chip'));
    fireEvent.click(document.querySelector('[data-model-id="claude-sonnet-4-5-20250929"]')!);
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith('That model isn’t available to your key. Pick another.')
    );
    expect(screen.queryByTestId('model-picker-error')).toBeNull();
  });

  it('is not there while OpenClaw answers, nor in the phone’s dock bar', () => {
    const { unmount } = render(<ChatComposer variant="dock" binding={{ kind: 'home' }} />);
    expect(screen.queryByTestId('chat-model-chip')).toBeNull();
    unmount();
    cleanupAI?.();
    cleanupAI = seedAI({ ...OPENCLAW_PLUGIN, choice: 'openclaw' });
    render(<ChatComposer variant="panel" binding={{ kind: 'home' }} />);
    expect(useAISettingsStore.getState().chatTarget).toBe('openclaw');
    expect(screen.queryByTestId('chat-model-chip')).toBeNull();
  });
});
