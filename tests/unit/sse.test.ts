import { describe, it, expect } from 'vitest';
import { parseSseFrames, sseFrame, SSE_DONE, type SseFrame } from '@/lib/sse';

/**
 * lib/sse.ts is the single parser for dsul's chat wire format. It replaced two
 * hand-rolled copies inside the old chat store's send() (lib/chat-transport.ts
 * reads it now), so these tests pin the behavior
 * both copies had (frames split across chunks, malformed payloads skipped) plus
 * the bug neither had fixed: `[DONE]` must end the READ, not just the inner
 * per-line loop.
 */

/** Feeds the given string chunks as a ReadableStream, byte-encoded like a real body. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SseFrame[]> {
  const out: SseFrame[] = [];
  for await (const frame of parseSseFrames(stream)) out.push(frame);
  return out;
}

describe('parseSseFrames', () => {
  it('parses a simple content stream', async () => {
    const frames = await collect(
      streamOf('data: {"content":"Hel"}\n\n', 'data: {"content":"lo"}\n\n', SSE_DONE)
    );
    expect(frames).toEqual([{ content: 'Hel' }, { content: 'lo' }]);
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    // The network splits wherever it likes — mid-JSON, mid-line, mid-prefix.
    const frames = await collect(
      streamOf('data: {"con', 'tent":"split"}\n', '\ndata: {"content":"!"}\n\n', SSE_DONE)
    );
    expect(frames).toEqual([{ content: 'split' }, { content: '!' }]);
  });

  it('stops at [DONE] and ignores anything after it', async () => {
    const frames = await collect(
      streamOf('data: {"content":"a"}\n\n', SSE_DONE, 'data: {"content":"never"}\n\n')
    );
    expect(frames).toEqual([{ content: 'a' }]);
  });

  it('skips malformed JSON, blank lines and non-data lines', async () => {
    const frames = await collect(
      streamOf(
        ': keepalive comment\n',
        'data: not-json\n',
        'data: \n',
        'event: ping\n',
        'data: {"content":"survived"}\n\n',
        SSE_DONE
      )
    );
    expect(frames).toEqual([{ content: 'survived' }]);
  });

  it('yields error frames rather than deciding what they mean', async () => {
    const frames = await collect(
      streamOf('data: {"content":"partial"}\n\n', 'data: {"error":"upstream died"}\n\n')
    );
    expect(frames).toEqual([{ content: 'partial' }, { error: 'upstream died' }]);
  });

  it('emits a trailing frame when the stream ends without a newline', async () => {
    const frames = await collect(streamOf('data: {"content":"unterminated"}'));
    expect(frames).toEqual([{ content: 'unterminated' }]);
  });

  it('handles an empty stream', async () => {
    expect(await collect(streamOf())).toEqual([]);
  });

  it('tolerates `data:` with no space, as the SSE spec allows', async () => {
    const frames = await collect(streamOf('data:{"content":"tight"}\n\n', SSE_DONE));
    expect(frames).toEqual([{ content: 'tight' }]);
  });

  it('drops JSON that is not an object', async () => {
    const frames = await collect(
      streamOf('data: "bare string"\n\n', 'data: 42\n\n', 'data: {"content":"ok"}\n\n')
    );
    expect(frames).toEqual([{ content: 'ok' }]);
  });
});

describe('sseFrame', () => {
  it('round-trips through the parser', async () => {
    const frames = await collect(
      streamOf(sseFrame({ content: 'a"quoted"\nnewline' }), sseFrame({ error: 'x' }), SSE_DONE)
    );
    expect(frames).toEqual([{ content: 'a"quoted"\nnewline' }, { error: 'x' }]);
  });
});
