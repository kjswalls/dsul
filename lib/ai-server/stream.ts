/**
 * Turning a provider's text deltas into dsul's SSE frames (lib/sse.ts), and
 * the small stream utilities the routes share.
 *
 * Server-only. `deltasToSse` is pull-based and cancel-safe: nothing is
 * enqueued after the reader cancels (design 1.7). The push-based loop it
 * replaces kept enqueueing into a stream the client had already closed, which
 * throws `Invalid state: Controller is already closed` from inside the route.
 *
 * There is no upstream SSE parser here on purpose: both SDKs parse their own
 * streams, and a custom host's stream is bounded by `guardedFetch`'s body cap.
 */

import { SSE_DONE, sseFrame, type SseFrame } from '@/lib/sse';
import { ProviderError, USER_MESSAGES } from './errors';

const DEFAULT_MAX_CHARS = 40_000;

/** AbortSignal.any when present; manual fallback. */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') return any.call(AbortSignal, signals);

  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
  }
  for (const s of signals) {
    s.addEventListener('abort', () => controller.abort(s.reason), {
      once: true,
      signal: controller.signal,
    });
  }
  return controller.signal;
}

const FALLBACK_FRAME: SseFrame = { error: USER_MESSAGES.upstream, code: 'upstream' };

export function deltasToSse(
  source: AsyncIterable<string>,
  opts: {
    abort: AbortController;
    onError: (err: unknown) => Promise<SseFrame>;
    /** default 40_000 */
    maxChars?: number;
  }
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  let it: AsyncIterator<string> | null = null;
  let cancelled = false;
  let finished = false;
  let chars = 0;

  const stopSource = () => {
    const current = it;
    if (!current?.return) return;
    try {
      Promise.resolve(current.return()).catch(() => {});
    } catch {
      // A source that throws from return() has nothing left to release.
    }
  };

  const frameFor = async (err: unknown): Promise<SseFrame> => {
    try {
      return await opts.onError(err);
    } catch {
      return FALLBACK_FRAME;
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const safe = (fn: () => void) => {
        if (cancelled || finished) return;
        try {
          fn();
        } catch {
          // The consumer went away between our check and the write.
        }
      };
      const send = (text: string) => safe(() => controller.enqueue(encoder.encode(text)));
      const finish = () => {
        safe(() => controller.close());
        finished = true;
      };

      if (cancelled || finished) return;

      try {
        it ??= source[Symbol.asyncIterator]();
        // Loop until something is enqueued or the stream ends: a pull that
        // resolves without enqueueing is never called again, and the reader
        // would hang.
        for (;;) {
          const r = await it.next();
          if (cancelled || finished) return;

          if (r.done) {
            if (chars === 0) send(sseFrame(await frameFor(new ProviderError('empty'))));
            send(SSE_DONE);
            finish();
            return;
          }

          const text = r.value;
          if (typeof text !== 'string' || text === '') continue;

          const room = maxChars - chars;
          if (text.length >= room) {
            const head = text.slice(0, room);
            chars += head.length;
            if (head) send(sseFrame({ content: head }));
            opts.abort.abort();
            stopSource();
            send(SSE_DONE);
            finish();
            return;
          }

          chars += text.length;
          send(sseFrame({ content: text }));
          return;
        }
      } catch (err) {
        if (cancelled || finished) return;
        send(sseFrame(await frameFor(err)));
        send(SSE_DONE);
        finish();
      }
    },

    cancel() {
      cancelled = true;
      try {
        opts.abort.abort();
      } catch {
        // Aborting twice is a no-op; anything else is not ours to surface.
      }
      stopSource();
    },
  });
}

/** One frame + [DONE]. */
export function sseErrorStream(frame: SseFrame): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseFrame(frame)));
      controller.enqueue(encoder.encode(SSE_DONE));
      controller.close();
    },
  });
}

/**
 * Reads a JSON body without ever holding more than `maxBytes` of it. Throws
 * ProviderError('upstream') when the body is over the cap or is not JSON.
 * Reader errors (an abort, a dropped connection) propagate as they are, for
 * `toProviderError` to classify.
 */
export async function readCappedJson(res: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ProviderError('upstream');
  }
  if (res.body === null) throw new ProviderError('upstream');

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ProviderError('upstream');
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released by cancel().
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ProviderError('upstream');
  }
}
