import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Stopping a reply — on the transport that actually serves people.
 *
 * `stop()` and its AbortController predate this file, but only the plugin
 * branch ever armed the controller. The `/api/chat` fetch — which serves the
 * OpenAI tier AND every gateway user — passed no signal, so the button was a
 * silent no-op: the square stayed up, the reply kept arriving, and the composer
 * stayed disabled. An earlier comment in this repo asserted the opposite; these
 * tests exist so the assertion is checked rather than believed.
 */

vi.mock('@/lib/planner-store', () => ({
  usePlannerStore: {
    getState: () => ({
      items: [],
      projects: [],
      habitGroups: [],
      itemTypes: [],
      routines: [],
      seasons: [],
      goals: [],
      userTimezone: 'UTC',
    }),
  },
}));

vi.mock('@/lib/ai-settings-store', () => ({
  useAISettingsStore: {
    getState: () => ({ chatTarget: 'model', systemPrompt: '' }),
  },
}));

// The gate says a model is connected, so every send takes /api/chat. `capsFor` is computed into a hoisted
// holder after the imports: importing the fixture INSIDE this factory would
// import the very module being mocked, and the factory would wait on itself.
const gate = vi.hoisted(() => ({ caps: null as unknown }));
vi.mock('@/lib/ai-connection-store', () => ({
  getAICapabilities: () => gate.caps,
  useAIConnectionStore: {
    getState: () => ({ hydratedUserId: 'seed-user', noteCallFailure: () => {} }),
  },
}));

vi.mock('@/lib/ai-context', () => ({ buildDsulContext: () => '## dsul Context' }));

import { createChatStore } from '@/lib/chat-store';
import { capsFor, CONNECTED_MODEL } from './helpers/ai-fixtures';

gate.caps = capsFor(CONNECTED_MODEL);

/** A stream that emits one frame, then hangs until the signal aborts it. */
function hangingStream(signal: AbortSignal, first = 'Half an ans') {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: first })}\n\n`));
      signal.addEventListener('abort', () => {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      });
    },
  });
}

let store: ReturnType<typeof createChatStore>;

beforeEach(() => {
  localStorage.clear();
  store = createChatStore({ historyKey: 'test-history', sessionKey: 'test-session' });
});

afterEach(() => vi.unstubAllGlobals());

describe('the stop button on /api/chat', () => {
  it('passes an abort signal, without which stop can do nothing', async () => {
    let seen: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seen = init;
        return { ok: true, body: hangingStream(init.signal as AbortSignal) };
      })
    );

    const sending = store.getState().send('hello');
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect((seen!.signal as AbortSignal).aborted).toBe(false);

    store.getState().stop();
    await sending;
  });

  it('clears isLoading, so the composer comes back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => ({
        ok: true,
        body: hangingStream(init.signal as AbortSignal),
      }))
    );

    const sending = store.getState().send('hello');
    expect(store.getState().isLoading).toBe(true);

    store.getState().stop();
    await sending;
    expect(store.getState().isLoading).toBe(false);
  });

  it('keeps the text that had already arrived', async () => {
    // The partial answer is usually WHY they hit stop — it had started going
    // somewhere they did not want. Throwing it away loses the evidence.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => ({
        ok: true,
        body: hangingStream(init.signal as AbortSignal, 'Here is the start of an answer'),
      }))
    );

    const sending = store.getState().send('hello');
    await new Promise((r) => setTimeout(r, 10));
    store.getState().stop();
    await sending;

    const last = store.getState().messages.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.content).toContain('Here is the start of an answer');
  });

  it('does not leave an empty bubble when nothing had arrived yet', async () => {
    /**
     * `send` pushes a blank assistant turn up front so the typing dots have
     * somewhere to live. Aborting used to just return, stranding it in the
     * transcript AND in localStorage: a turn that never fills, offers no "Turn
     * this into a plan" (gated on content), and suppresses the openers forever
     * after, since those key on an empty transcript.
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        return {
          ok: true,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener('abort', () =>
                controller.error(new DOMException('aborted', 'AbortError'))
              );
            },
          }),
        };
      })
    );

    const sending = store.getState().send('hello');
    store.getState().stop();
    await sending;

    expect(store.getState().messages.map((m) => m.role)).toEqual(['user']);
  });

  it('does not show the generic error message for a deliberate stop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => ({
        ok: true,
        body: hangingStream(init.signal as AbortSignal),
      }))
    );

    const sending = store.getState().send('hello');
    store.getState().stop();
    await sending;

    for (const message of store.getState().messages) {
      expect(message.content).not.toMatch(/something went wrong/i);
    }
  });

  it('still surfaces a real failure as an error message', async () => {
    // The abort branch must not swallow genuine network errors.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    await store.getState().send('hello');
    expect(store.getState().messages.at(-1)?.content).toMatch(/something went wrong/i);
    expect(store.getState().isLoading).toBe(false);
  });

  it('lets a later request keep its own stop after an earlier one finishes', async () => {
    // The finally clears the store's controller only when it is still ITS own —
    // clearing unconditionally would disarm the stop button of the next reply.
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        return { ok: true, body: hangingStream(signal) };
      })
    );

    const first = store.getState().send('one');
    store.getState().stop();
    await first;

    const second = store.getState().send('two');
    store.getState().stop();
    await second;

    expect(signals).toHaveLength(2);
    expect(signals[1].aborted).toBe(true);
  });
});
