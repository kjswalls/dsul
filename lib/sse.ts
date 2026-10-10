/**
 * dsul's chat wire format, in one place.
 *
 * Every chat transport speaks the same frames — `data: {"content":"…"}`, an
 * optional `data: {"error":"…","code":"…"}`, terminated by `data: [DONE]` — so the client
 * has exactly ONE parser regardless of which tier answered. Provider-shaped
 * payloads (OpenAI chunks from `/api/chat`, or an OpenClaw gateway's
 * OpenAI-compatible stream) are translated into these frames server-side.
 *
 * Extracted from the two hand-rolled copies that used to live inside the old
 * chat store's `send()`. Both had the same latent bug: `[DONE]` and error frames
 * `break`ed only the inner per-line loop, so the reader kept pulling from a
 * stream the caller had already finished with. Returning from the generator
 * ends the read for real.
 */

export interface SseFrame {
  content?: string
  /**
   * An action line: one lookup the AI made while answering ("Looked for
   * "dentist" (2 found)"), in dsul's words, before any `content`. Older
   * clients skip it.
   */
  action?: string
  /** Our copy, never the provider's text. */
  error?: string
  /**
   * The machine-readable reason beside `error` (a `ChatErrorCode` from
   * lib/ai-types.ts), so the client can react to WHY — a rejected key hides
   * the AI surfaces — without parsing copy. Optional: the OpenClaw paths and
   * older servers send `error` alone.
   */
  code?: string
}

const DONE = Symbol('sse-done')

/** `null` = not a frame (comment, blank line, malformed JSON — all skippable). */
function parseSseLine(line: string): SseFrame | typeof DONE | null {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (payload === '[DONE]') return DONE
  if (!payload) return null
  try {
    const parsed: unknown = JSON.parse(payload)
    return parsed && typeof parsed === 'object' ? (parsed as SseFrame) : null
  } catch {
    return null
  }
}

/**
 * Yields frames from an SSE body until the stream ends or `[DONE]` arrives.
 *
 * Frames are yielded as-is; interpreting `error` (and deciding whether to keep
 * already-streamed content) is the caller's business, because the two chat
 * paths differ on it.
 */
export async function* parseSseFrames(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Frames can split across chunks — the tail is always an incomplete line.
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const frame = parseSseLine(line)
        if (frame === DONE) return
        if (frame) yield frame
      }
    }

    // A stream that ends without a trailing newline still has one real frame.
    const last = parseSseLine(buffer)
    if (last && last !== DONE) yield last
  } finally {
    reader.releaseLock()
  }
}

/** Server side: encode one dsul frame. */
export function sseFrame(frame: SseFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`
}

/** Server side: the terminator every dsul SSE response ends with. */
export const SSE_DONE = 'data: [DONE]\n\n'

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
} as const
