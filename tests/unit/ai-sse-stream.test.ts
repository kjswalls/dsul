// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ProviderError, USER_MESSAGES } from '@/lib/ai-server/errors';
import { anySignal, deltasToSse, readCappedJson, sseErrorStream } from '@/lib/ai-server/stream';
import { parseSseFrames, type SseFrame } from '@/lib/sse';

/**
 * The chat route's stream (design 1.7): provider deltas in, dsul frames out,
 * through the same parser the client uses. Pull-based, so a client that hangs
 * up stops the upstream instead of being written to after it left.
 */

const onError = async (err: unknown): Promise<SseFrame> => {
  const e = err instanceof ProviderError ? err : new ProviderError('upstream');
  return { error: e.message, code: e.kind };
};

async function* from(items: string[]) {
  for (const s of items) yield s;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<{ frames: SseFrame[]; raw: string }> {
  const [a, b] = stream.tee();
  const frames: SseFrame[] = [];
  const rawP = new Response(b).text();
  for await (const f of parseSseFrames(a)) frames.push(f);
  return { frames, raw: await rawP };
}

describe('deltasToSse', () => {
  it('emits content frames, then [DONE]', async () => {
    const { frames, raw } = await drain(
      deltasToSse(from(['Hel', '', 'lo']), { abort: new AbortController(), onError })
    );
    expect(frames).toEqual([{ content: 'Hel' }, { content: 'lo' }]);
    expect(raw.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('sends action lines as their own frames, trimmed and capped, never counted as reply text', async () => {
    async function* withActions() {
      yield { action: '  Looked for "dentist" (1 found) ' };
      yield { action: '' };
      yield { action: 'x'.repeat(500) };
      yield 'Thursday.';
    }
    const { frames } = await drain(deltasToSse(withActions(), { abort: new AbortController(), onError, maxChars: 9 }));
    expect(frames).toEqual([
      { action: 'Looked for "dentist" (1 found)' },
      { action: 'x'.repeat(200) },
      { content: 'Thursday.' },
    ]);
  });

  it('action lines alone are no reply', async () => {
    async function* onlyActions() {
      yield { action: 'Looked over your projects, routines and goals' };
    }
    const { frames } = await drain(deltasToSse(onlyActions(), { abort: new AbortController(), onError }));
    expect(frames.at(-1)).toMatchObject({ code: 'empty' });
  });

  it('a thrown source gives exactly one {error, code} frame, then [DONE]', async () => {
    async function* broken() {
      yield 'partial';
      throw new ProviderError('rate_limit', 429);
    }
    const { frames, raw } = await drain(deltasToSse(broken(), { abort: new AbortController(), onError }));
    expect(frames).toEqual([
      { content: 'partial' },
      { error: USER_MESSAGES.rate_limit, code: 'rate_limit' },
    ]);
    expect(raw.match(/\[DONE\]/g)).toHaveLength(1);
    expect(raw.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('a source that throws before yielding still gives one frame and [DONE]', async () => {
    async function* broken(): AsyncGenerator<string> {
      throw new Error('boom: upstream body sk-SENTINEL');
    }
    const { frames, raw } = await drain(deltasToSse(broken(), { abort: new AbortController(), onError }));
    expect(frames).toEqual([{ error: USER_MESSAGES.upstream, code: 'upstream' }]);
    expect(raw).not.toContain('SENTINEL');
  });

  it('an onError that itself throws still ends the stream with a frame', async () => {
    async function* broken(): AsyncGenerator<string> {
      yield 'x';
      throw new Error('no');
    }
    const { frames } = await drain(
      deltasToSse(broken(), {
        abort: new AbortController(),
        onError: async () => {
          throw new Error('db down');
        },
      })
    );
    expect(frames).toEqual([{ content: 'x' }, { error: USER_MESSAGES.upstream, code: 'upstream' }]);
  });

  it('zero deltas give an empty frame', async () => {
    const seen: unknown[] = [];
    const { frames, raw } = await drain(
      deltasToSse(from(['', '']), {
        abort: new AbortController(),
        onError: async (err) => {
          seen.push(err);
          return onError(err);
        },
      })
    );
    expect(frames).toEqual([{ error: USER_MESSAGES.empty, code: 'empty' }]);
    expect((seen[0] as ProviderError).kind).toBe('empty');
    expect(raw.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('reader.cancel() aborts, calls it.return(), and nothing throws afterwards', async () => {
    const abort = new AbortController();
    const returned = vi.fn();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        let n = 0;
        return {
          async next() {
            n++;
            if (n === 1) return { done: false, value: 'first' };
            await gate; // the upstream stalls mid-answer
            return { done: false, value: 'late' };
          },
          async return() {
            returned();
            return { done: true, value: undefined };
          },
        };
      },
    };
    const errors: unknown[] = [];
    const onUnhandled = (e: unknown) => errors.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const stream = deltasToSse(source, { abort, onError });
      const reader = stream.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('first');
      const pending = reader.read(); // pull #2 is now waiting on the stalled source
      await reader.cancel();
      expect(abort.signal.aborted).toBe(true);
      expect(returned).toHaveBeenCalledTimes(1);
      release(); // the late delta arrives after the client left
      await expect(pending).resolves.toEqual({ done: true, value: undefined });
      await new Promise((r) => setTimeout(r, 10));
      expect(errors).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('maxChars stops the stream, aborts upstream and ends with [DONE]', async () => {
    const abort = new AbortController();
    const returned = vi.fn();
    async function* endless() {
      try {
        for (;;) yield 'abcdefghij';
      } finally {
        returned();
      }
    }
    const { frames, raw } = await drain(deltasToSse(endless(), { abort, onError, maxChars: 25 }));
    const text = frames.map((f) => f.content ?? '').join('');
    expect(text).toBe('abcdefghijabcdefghijabcde');
    expect(frames.some((f) => f.error)).toBe(false);
    expect(abort.signal.aborted).toBe(true);
    expect(raw.endsWith('data: [DONE]\n\n')).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(returned).toHaveBeenCalled();
  });

  it('defaults maxChars to 40 000', async () => {
    async function* endless() {
      for (;;) yield 'x'.repeat(1000);
    }
    const { frames } = await drain(deltasToSse(endless(), { abort: new AbortController(), onError }));
    expect(frames.map((f) => f.content ?? '').join('').length).toBe(40_000);
  });
});

describe('sseErrorStream', () => {
  it('is one frame and [DONE]', async () => {
    const { frames, raw } = await drain(sseErrorStream({ error: 'nope', code: 'not_connected' }));
    expect(frames).toEqual([{ error: 'nope', code: 'not_connected' }]);
    expect(raw).toBe('data: {"error":"nope","code":"not_connected"}\n\ndata: [DONE]\n\n');
  });
});

describe('readCappedJson', () => {
  it('parses a body under the cap', async () => {
    await expect(readCappedJson(new Response('{"a":1}'), 100)).resolves.toEqual({ a: 1 });
  });

  it('rejects with upstream over the cap (streamed, no content-length)', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"a":"'));
        c.enqueue(new Uint8Array(200).fill(0x61));
        c.enqueue(new TextEncoder().encode('"}'));
        c.close();
      },
    });
    await expect(readCappedJson(new Response(body), 100)).rejects.toMatchObject({ kind: 'upstream' });
  });

  it('rejects early on a declared content-length over the cap', async () => {
    const res = new Response('x'.repeat(500), { headers: { 'content-length': '500' } });
    await expect(readCappedJson(res, 100)).rejects.toMatchObject({ kind: 'upstream' });
  });

  it('rejects non-JSON with upstream, never echoing the body', async () => {
    const err = await readCappedJson(new Response('<html>sk-SENTINEL</html>'), 1000).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('upstream');
    expect(String((err as Error).message)).not.toContain('SENTINEL');
  });
});

describe('anySignal', () => {
  it('aborts when any input aborts, carrying its reason', () => {
    const a = new AbortController();
    const b = new AbortController();
    const s = anySignal([a.signal, b.signal]);
    expect(s.aborted).toBe(false);
    b.abort(new DOMException('late', 'TimeoutError'));
    expect(s.aborted).toBe(true);
    expect((s.reason as DOMException).name).toBe('TimeoutError');
  });

  it('works without AbortSignal.any (manual fallback)', () => {
    const original = (AbortSignal as unknown as { any?: unknown }).any;
    (AbortSignal as unknown as { any?: unknown }).any = undefined;
    try {
      const a = new AbortController();
      const s = anySignal([a.signal, new AbortController().signal]);
      expect(s.aborted).toBe(false);
      a.abort('why');
      expect(s.aborted).toBe(true);
      expect(s.reason).toBe('why');

      const done = new AbortController();
      done.abort('already');
      expect(anySignal([done.signal]).reason).toBe('already');
    } finally {
      (AbortSignal as unknown as { any?: unknown }).any = original;
    }
  });
});
