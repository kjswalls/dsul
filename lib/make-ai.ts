import { clipText, MAX_MAKE_ASK_CHARS, type MakeKind } from './ai-limits';
import { useAIConnectionStore } from './ai-connection-store';
import { isChatErrorCode, replyErrorCode, type ReplyErrorCode } from './chat-errors';
import { parseSseFrames } from './sse';

/**
 * The one call "Write with AI" makes (Settings → Make, memory/plans/mods.md,
 * "AI writes it"): POST /api/ai/make with the kind and the ask, and the
 * streamed reply gathered into one string for lib/make-draft.ts to check.
 *
 * Client-safe (tests/unit/ai-server-boundary.test.ts). The body is exactly
 * `{kind, ask}`: no context, no model, no key. The server builds what else the
 * model sees. This is the module's only fetch, and nothing calls it but the
 * Write and Try again presses (components/settings/make-write.tsx): no AI call
 * happens on mount, on typing, or on its own.
 *
 * A code the gate cares about (a rejected key, nothing connected) is passed to
 * the connection store, as chat does, so the surfaces re-check and hide.
 */

export type { MakeKind };

/**
 * `message` is the route's own copy when it sent one (lib/chat-errors.ts, or
 * the route's: a provider's text never reaches a response), so a limit of
 * Make's own reads as Make's and not as the provider's.
 */
export type WriteResult =
  | { ok: true; text: string }
  | { ok: false; code: ReplyErrorCode | 'stopped'; message?: string };

const ownCopy = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() && v.length <= 300 ? v : undefined;

function noteFailure(code: unknown): void {
  if (isChatErrorCode(code)) useAIConnectionStore.getState().noteCallFailure(code);
}

export async function writeWithAI(i: {
  kind: MakeKind;
  ask: string;
  signal: AbortSignal;
  /** The characters gathered so far, for a quiet "Writing…" progress. */
  onDelta?: (chars: number) => void;
}): Promise<WriteResult> {
  let res: Response;
  try {
    res = await fetch('/api/ai/make', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: i.kind, ask: clipText(i.ask, MAX_MAKE_ASK_CHARS) }),
      signal: i.signal,
    });
  } catch {
    return i.signal.aborted ? { ok: false, code: 'stopped' } : { ok: false, code: 'network' };
  }

  if (res.status === 204) return { ok: false, code: 'stopped' };
  if (!res.ok || !res.body) {
    let code: unknown;
    let message: string | undefined;
    try {
      const body = (await res.json()) as { code?: unknown; error?: unknown };
      code = body.code;
      message = ownCopy(body.error);
    } catch {
      code = undefined;
    }
    noteFailure(code);
    return { ok: false, code: replyErrorCode(code), ...(message && { message }) };
  }

  let text = '';
  let failed = false;
  let failedCode: unknown;
  let failedMessage: string | undefined;
  try {
    for await (const frame of parseSseFrames(res.body)) {
      if (frame.error !== undefined || frame.code !== undefined) {
        failed = true;
        failedCode = frame.code;
        failedMessage = ownCopy(frame.error);
        break;
      }
      if (typeof frame.content === 'string') {
        text += frame.content;
        i.onDelta?.(text.length);
      }
    }
  } catch {
    return i.signal.aborted ? { ok: false, code: 'stopped' } : { ok: false, code: 'network' };
  }
  if (failed) {
    // The parser has let go of the body by now, so it can be cancelled.
    void res.body.cancel().catch(() => {});
    noteFailure(failedCode);
    return { ok: false, code: replyErrorCode(failedCode), ...(failedMessage && { message: failedMessage }) };
  }
  if (i.signal.aborted) return { ok: false, code: 'stopped' };
  if (!text.trim()) return { ok: false, code: 'no_response' };
  return { ok: true, text };
}
