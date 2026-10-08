import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const noteCallFailure = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai-connection-store', () => ({
  useAIConnectionStore: { getState: () => ({ noteCallFailure }) },
}));

import { writeWithAI } from '@/lib/make-ai';
import { MAX_MAKE_ASK_CHARS } from '@/lib/ai-limits';

/** The one call "Write with AI" makes (lib/make-ai.ts). */

function sse(...frames: string[]): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  noteCallFailure.mockClear();
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

const run = (over: Partial<Parameters<typeof writeWithAI>[0]> = {}) =>
  writeWithAI({ kind: 'recipe', ask: 'When I tick Run', signal: new AbortController().signal, ...over });

describe('writeWithAI', () => {
  it('posts exactly {kind, ask}, clipped, to /api/ai/make', async () => {
    fetchSpy.mockResolvedValue(sse('{"content":"{}"}', '[DONE]'));
    await run({ kind: 'theme', ask: 'x'.repeat(1500) });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/ai/make');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(['ask', 'kind']);
    expect(body).toEqual({ kind: 'theme', ask: 'x'.repeat(MAX_MAKE_ASK_CHARS) });
  });

  it('gathers the content frames into one text', async () => {
    const onDelta = vi.fn();
    fetchSpy.mockResolvedValue(sse('{"content":"{\\"kind\\":"}', '{"content":"\\"recipe\\"}"}', '[DONE]'));
    expect(await run({ onDelta })).toEqual({ ok: true, text: '{"kind":"recipe"}' });
    expect(onDelta).toHaveBeenLastCalledWith(17);
  });

  it('an error frame gives its code and copy, and a rejected key tells the gate', async () => {
    fetchSpy.mockResolvedValue(sse('{"content":"{"}', '{"error":"Your AI key stopped working.","code":"auth"}', '[DONE]'));
    expect(await run()).toEqual({ ok: false, code: 'auth', message: 'Your AI key stopped working.' });
    expect(noteCallFailure).toHaveBeenCalledWith('auth');
  });

  it('a JSON refusal gives its code, and an unknown one reads as client', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Connect a model in Settings to write with AI.', code: 'not_connected' }), { status: 409 })
    );
    expect(await run()).toMatchObject({ ok: false, code: 'not_connected', message: 'Connect a model in Settings to write with AI.' });
    expect(noteCallFailure).toHaveBeenCalledWith('not_connected');
    fetchSpy.mockResolvedValueOnce(new Response('<html>502</html>', { status: 502 }));
    expect(await run()).toEqual({ ok: false, code: 'client' });
  });

  it('an abort is stopped, an empty stream is no_response, a dropped network is network', async () => {
    const c = new AbortController();
    fetchSpy.mockImplementationOnce(async () => {
      c.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    expect(await run({ signal: c.signal })).toEqual({ ok: false, code: 'stopped' });

    fetchSpy.mockResolvedValueOnce(sse('[DONE]'));
    expect(await run()).toEqual({ ok: false, code: 'no_response' });

    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await run()).toEqual({ ok: false, code: 'network' });

    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await run()).toEqual({ ok: false, code: 'stopped' });
  });
});
