import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Stopping a reply, on the transport that actually serves people.
 *
 * `stop()` and its AbortController predate this file, but only the plugin
 * branch ever armed the controller. The `/api/chat` fetch, which serves every
 * model connection AND every gateway user, passed no signal, so the button was
 * a silent no-op: the square stayed up, the reply kept arriving, and the
 * composer stayed disabled. These tests exist so the claim is checked rather
 * than believed.
 *
 * The real transport, with the conversations API a fake
 * (configureConversations): a stop is also what gets SAVED, so these pin the
 * saved turn too.
 */

vi.mock('@/lib/planner-store', () => ({
  usePlannerStore: {
    getState: () => ({
      items: [],
      projects: [],
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

// The gate says a model is connected, so every send takes /api/chat. `capsFor`
// is computed into a hoisted holder after the imports: importing the fixture
// INSIDE this factory would import the very module being mocked, and the
// factory would wait on itself.
const gate = vi.hoisted(() => ({ caps: null as unknown }));
vi.mock('@/lib/ai-connection-store', () => ({
  getAICapabilities: () => gate.caps,
  useAIConnectionStore: {
    getState: () => ({ hydratedUserId: 'seed-user', model: { model: 'gpt-4o-mini' }, noteCallFailure: () => {} }),
  },
}));

vi.mock('@/lib/ai-context', () => ({ buildDsulContext: () => '## dsul Context' }));

import { chatTransport } from '@/lib/chat-transport';
import {
  clearChatState,
  configureConversations,
  conversationsSettled,
  useConversationsStore,
} from '@/lib/conversations-store';
import { chatErrorCopy } from '@/lib/chat-errors';
import { capsFor, CONNECTED_MODEL } from './helpers/ai-fixtures';
import { fakeApi, type FakeApi } from './helpers/conversations-fakes';

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

const store = () => useConversationsStore.getState();
const messagesOf = (id: string) => store().threads[id]?.messages ?? [];

let api: FakeApi;
let id: string;

beforeEach(() => {
  api = fakeApi();
  configureConversations({ api: api.api, transport: chatTransport });
  clearChatState();
  id = store().newDraft();
});

afterEach(async () => {
  await conversationsSettled();
  vi.unstubAllGlobals();
});

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

    const sending = store().send(id, 'hello');
    await new Promise((r) => setTimeout(r, 0));
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect((seen!.signal as AbortSignal).aborted).toBe(false);

    store().stop(id);
    await sending;
    expect((seen!.signal as AbortSignal).aborted).toBe(true);
  });

  it('clears streaming, so the composer comes back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => ({
        ok: true,
        body: hangingStream(init.signal as AbortSignal),
      }))
    );

    const sending = store().send(id, 'hello');
    expect(store().threads[id].streaming).toBe(true);

    store().stop(id);
    await sending;
    expect(store().threads[id].streaming).toBe(false);
  });

  it('keeps the text that had already arrived, as stopped, and saves it so', async () => {
    // The partial answer is usually WHY they hit stop: it had started going
    // somewhere they did not want. Throwing it away loses the evidence.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => ({
        ok: true,
        body: hangingStream(init.signal as AbortSignal, 'Here is the start of an answer'),
      }))
    );

    const sending = store().send(id, 'hello');
    await new Promise((r) => setTimeout(r, 10));
    store().stop(id);
    await sending;
    await conversationsSettled();

    const last = messagesOf(id).at(-1)!;
    expect(last).toMatchObject({ role: 'assistant', status: 'stopped', errorCode: null });
    expect(last.content).toContain('Here is the start of an answer');
    expect(api.turns).toHaveLength(1);
    expect(api.turns[0].body.messages[1]).toMatchObject({ status: 'stopped', content: 'Here is the start of an answer' });
  });

  it('does not leave an empty bubble when nothing had arrived yet', async () => {
    /**
     * `send` puts a blank reply up front so the typing dots have somewhere to
     * live. Aborting used to just return, stranding it: a turn that never
     * fills, offers no "Turn this into a plan" (gated on content), and
     * suppresses the openers forever after, since those key on an empty
     * transcript.
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        return {
          ok: true,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
            },
          }),
        };
      })
    );

    const sending = store().send(id, 'hello');
    store().stop(id);
    await sending;
    await conversationsSettled();

    expect(messagesOf(id).map((m) => m.role)).toEqual(['user']);
    expect(api.turns[0].body.messages).toHaveLength(1);
  });

  it('a deliberate stop is never an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => ({
        ok: true,
        body: hangingStream(init.signal as AbortSignal),
      }))
    );

    const sending = store().send(id, 'hello');
    store().stop(id);
    await sending;

    for (const message of messagesOf(id)) {
      expect(message.status).not.toBe('error');
      expect(message.content).not.toMatch(/something went wrong/i);
    }
  });

  it('still surfaces a real failure as an error', async () => {
    // The abort branch must not swallow genuine network errors.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );

    await store().send(id, 'hello');
    const last = messagesOf(id).at(-1)!;
    expect(last).toMatchObject({ status: 'error', errorCode: 'client' });
    expect(chatErrorCopy(last.errorCode, last.answerer)).toMatch(/something went wrong/i);
    expect(store().threads[id].streaming).toBe(false);
  });

  it('lets a later request keep its own stop after an earlier one finishes', async () => {
    // The finally clears a controller only when it is still ITS own: clearing
    // unconditionally would disarm the stop button of the next reply.
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        return { ok: true, body: hangingStream(signal) };
      })
    );

    const first = store().send(id, 'one');
    store().stop(id);
    await first;

    const second = store().send(id, 'two');
    await new Promise((r) => setTimeout(r, 0));
    store().stop(id);
    await second;

    expect(signals).toHaveLength(2);
    expect(signals[1].aborted).toBe(true);
  });

  it('stopping one conversation never touches another', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        return { ok: true, body: hangingStream(signal) };
      })
    );
    const other = store().newDraft();

    const a = store().send(id, 'one');
    const b = store().send(other, 'two');
    await new Promise((r) => setTimeout(r, 0));
    store().stop(id);
    await a;
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
    expect(store().threads[other].streaming).toBe(true);

    store().stop(other);
    await b;
  });
});
