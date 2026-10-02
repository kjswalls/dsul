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
vi.mock('@/lib/settings-service', () => ({
  saveSettings: vi.fn(async () => {}),
  flushSettings: vi.fn(async () => {}),
}));

import { ModelPicker } from '@/components/settings/model-picker';
import { connectErrorCopy } from '@/components/settings/model-connection-panel';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { CONNECTED_MODEL, seedAI } from './helpers/ai-fixtures';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let patch: () => Response;
let cleanupAI: (() => void) | null = null;

beforeEach(() => {
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
