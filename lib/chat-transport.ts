import { useAISettingsStore } from './ai-settings-store';
import { useAIConnectionStore } from './ai-connection-store';
import {
  MAX_CHAT_CONTEXT_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
  clipText,
  type ChatTurn,
} from './ai-limits';
import { isModelId } from './ai-types';
import { isChatErrorCode, replyErrorCode, type ReplyErrorCode } from './chat-errors';
import { stripReasoningTags } from './chat-utils';
import { parseSseFrames } from './sse';
import type { MessageStatus } from './conversation-types';

/**
 * One chat turn, on whichever transport answers it, and nothing about storage.
 *
 * Moved out of the old chat store (deleted in AI step 2a): the /api/chat
 * stream, the OpenClaw plugin call and its per-account URL cache. What
 * changed on the way:
 *   - a turn names its saved conversation (`conversationId`), never an item:
 *     the server builds the gateway session key from it and the verified user
 *     (`conversationSessionKey`, lib/openclaw-gateway.ts), and the plugin path
 *     keys its session `dsul-chat-<id>`. One gateway session per conversation,
 *     so a new chat really is new on OpenClaw.
 *   - a failure is a CODE (lib/chat-errors.ts), never words in the reply.
 *     Error copy is not content: it is never saved as the AI's words and never
 *     re-sent to a model. A reply that had begun keeps its text.
 *   - a stop is `status: 'stopped'` with whatever arrived, never an error.
 *
 * WHO answers is not this module's business either: the caller asked the gate
 * (`getAICapabilities()`) at the moment of sending and passes the answer in.
 * The key, the model and the prompt all live server-side; a body names a
 * target and carries the user's own instructions as data, never a key, a model
 * or a system prompt.
 */

export interface TurnInput {
  conversationId: string;
  /** The effective answerer, from the gate. */
  target: 'model' | 'openclaw';
  /** OpenClaw only: the user's gateway rides /api/chat; the plugin is called directly. */
  via: 'chat' | 'plugin';
  /** The new message, already clipped to the user cap (the plugin path sends it alone). */
  message: string;
  /** The transcript for /api/chat, ending with `message` (see `outgoingTurns`). */
  turns: ChatTurn[];
  /** The planner context, already built (and any continuity note folded in). */
  context: string;
  /** Custom-type nouns, for the server's prompt. */
  typeNouns: string[];
  signal: AbortSignal;
  /** Each streamed delta, in memory only. Never a save. */
  onDelta: (delta: string) => void;
}

export interface TurnOutcome {
  /** Everything that arrived, raw. Empty for a stop or failure before the first token. */
  content: string;
  status: MessageStatus;
  /** Set exactly when `status` is 'error'; always a code a saved reply may carry. */
  errorCode: ReplyErrorCode | null;
  /** The connection's model id on the model path; null for OpenClaw (gateway or plugin). */
  model: string | null;
}

export interface ChatTransport {
  /** Never rejects: every way a turn can end is a TurnOutcome. */
  streamTurn(input: TurnInput): Promise<TurnOutcome>;
}

/**
 * The transcript as a model should see it. Pure.
 *
 * - A failed reply (`status: 'error'`) is dropped, and so is the user message it
 *   answered: error copy never reaches a model, and a question whose answer
 *   failed is asked again by the user anyway.
 * - A reply with nothing in it (a stop before the first token, a stream still
 *   empty) is dropped; the question it answered stays.
 * - Then strict alternation: of two user turns in a row the earlier goes (it
 *   was never answered), and a reply with no question before it goes.
 * - The newest MAX_MESSAGES, each clipped to MAX_MESSAGE_CHARS. The server
 *   keeps at most that many and clips every turn to the same length anyway,
 *   so the model sees exactly what it would unclipped; clipping here keeps
 *   one huge reply from getting every later send refused as too long.
 */
export function outgoingTurns(
  messages: ReadonlyArray<{ id: string; role: 'user' | 'assistant'; content: string; status: string; replyTo?: string | null }>
): ChatTurn[] {
  const answeredByError = new Set<string>();
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || m.status !== 'error') return;
    if (m.replyTo) {
      answeredByError.add(m.replyTo);
      return;
    }
    for (let j = i - 1; j >= 0; j--) {
      if (messages[j].role === 'user') {
        answeredByError.add(messages[j].id);
        break;
      }
    }
  });

  const kept: ChatTurn[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      if (answeredByError.has(m.id)) continue;
      if (kept.at(-1)?.role === 'user') kept.pop();
      kept.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.status === 'error' || m.status === 'streaming' || m.content === '') continue;
    if (kept.at(-1)?.role !== 'user') continue;
    kept.push({ role: 'assistant', content: m.content });
  }
  return kept.slice(-MAX_MESSAGES).map((t) => ({ role: t.role, content: clipText(t.content, MAX_MESSAGE_CHARS) }));
}

// ── The plugin path's URL and key ─────────────────────────────────────────────

/** What the plugin path needs to reach the user's OpenClaw directly. */
interface PluginTransport {
  chatUrl: string | null;
  /** The user's dsul plugin key (not a provider key), sent as the bearer. */
  dsulApiKey: string | null;
}

/**
 * The plugin transport, fetched lazily and shared by every conversation.
 *
 * Only the plugin path needs `/api/agent/chat-url`: the gate already knows a
 * chat URL is registered (`openclaw.pluginChat`), but the browser still needs
 * the URL itself and the plugin key to call it. Fetched on the first plugin
 * send, not on every mount, and keyed by the account the gate answered for,
 * so a different user on this browser never reuses the last one's key. A
 * failure is not cached: the next send asks again.
 */
let pluginTransport: { userId: string | null; promise: Promise<PluginTransport> } | null = null;

const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function loadPluginTransport(): Promise<PluginTransport> {
  const userId = useAIConnectionStore.getState().hydratedUserId;
  if (pluginTransport && pluginTransport.userId === userId) return pluginTransport.promise;

  const entry = {
    userId,
    promise: fetch('/api/agent/chat-url', { cache: 'no-store', credentials: 'same-origin' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<unknown>;
      })
      .then((body): PluginTransport => {
        const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        return { chatUrl: strOrNull(b.chatUrl), dsulApiKey: strOrNull(b.dsulApiKey) };
      }),
  };
  pluginTransport = entry;
  // A failed read, or an answer with no URL yet (the plugin registers it when
  // its gateway restarts), must not stick: drop it so the next send re-reads.
  entry.promise.then(
    (t) => {
      if (!t.chatUrl) dropPluginTransport(entry);
    },
    () => dropPluginTransport(entry)
  );
  return entry.promise;
}

function dropPluginTransport(entry: NonNullable<typeof pluginTransport>) {
  if (pluginTransport === entry) pluginTransport = null;
}

/**
 * Forget the cached plugin URL and key. The sign-out clear (`clearChatState`,
 * lib/conversations-store.ts) and a user's change of answerer
 * (`chooseChatTarget`, lib/chat-target.ts) both call it.
 */
export function resetPluginTransport(): void {
  pluginTransport = null;
}

/** The plugin path's session key: one OpenClaw session per saved conversation. */
export function pluginSessionKey(conversationId: string): string {
  return `dsul-chat-${conversationId}`;
}

/**
 * The user's own instructions, folded into the context the plugin forwards.
 *
 * The plugin body is a fixed contract (`{message, sessionKey, context}`) and
 * the plugin passes `context` on as its extra system prompt
 * (openclaw-plugin/src/chat.ts), so this reaches the agent with no republish.
 */
function withInstructions(context: string, systemPrompt: string): string {
  const instructions = clipText(systemPrompt.trim(), MAX_INSTRUCTIONS_CHARS);
  return instructions ? `${context}\n\n## The user's own instructions\n${instructions}` : context;
}

/** Tell the gate why a call failed; it re-checks on a rejected key or a vanished connection. */
function noteFailure(code: unknown) {
  if (isChatErrorCode(code)) useAIConnectionStore.getState().noteCallFailure(code);
}

const isAbort = (err: unknown, signal: AbortSignal) =>
  signal.aborted || (err instanceof DOMException && err.name === 'AbortError');

const failed = (content: string, code: unknown, model: string | null): TurnOutcome => ({
  content,
  status: 'error',
  errorCode: replyErrorCode(code),
  model,
});

/**
 * The plugin path: POST straight at the user's OpenClaw plugin. Only for an
 * account with no gateway; a gateway rides /api/chat. The plugin answers with
 * one JSON body, not a stream (#149), so there is nothing to show until it
 * has finished.
 */
async function viaPlugin(input: TurnInput): Promise<TurnOutcome> {
  const { signal } = input;
  try {
    // A read that fails (an expired session, a 500, offline) lands in the
    // catch below as "can't reach": the gate already knows this account
    // registered a chat URL, so sending it back to setup would be wrong.
    const transport = await loadPluginTransport();
    if (signal.aborted) return { content: '', status: 'stopped', errorCode: null, model: null };
    // Only a read that SUCCEEDED with no URL means setup is unfinished.
    if (!transport.chatUrl) return failed('', 'plugin_setup', null);

    const { systemPrompt } = useAISettingsStore.getState();
    const res = await fetch(transport.chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(transport.dsulApiKey ? { Authorization: `Bearer ${transport.dsulApiKey}` } : {}),
      },
      signal,
      // The plugin contract, exactly. Nothing else rides along.
      body: JSON.stringify({
        message: input.message,
        sessionKey: pluginSessionKey(input.conversationId),
        context: withInstructions(input.context, systemPrompt),
      }),
    });
    // The plugin may have re-registered (a new URL or key) since this was
    // cached; a refused call re-reads both on the next send.
    if (!res.ok) resetPluginTransport();
    let parsed: { content?: unknown; error?: unknown };
    try {
      parsed = (await res.json()) as typeof parsed;
    } catch (err) {
      if (isAbort(err, signal)) return { content: '', status: 'stopped', errorCode: null, model: null };
      return failed('', 'plugin_error', null);
    }
    // The plugin's own error text is never shown or saved: it is OpenClaw's
    // words about OpenClaw's state. Our copy says what to do.
    if (!res.ok || (typeof parsed?.error === 'string' && parsed.error)) return failed('', 'plugin_error', null);
    const content = typeof parsed?.content === 'string' ? stripReasoningTags(parsed.content) : '';
    if (!content) return failed('', 'no_response', null);
    input.onDelta(content);
    return { content, status: 'complete', errorCode: null, model: null };
  } catch (err) {
    // The URL read takes no signal, so a stop during it shows up here as a
    // plain rejection on an aborted controller, not an AbortError.
    if (isAbort(err, signal)) return { content: '', status: 'stopped', errorCode: null, model: null };
    resetPluginTransport();
    // The browser's own wording ("Failed to fetch", "Load failed") says
    // nothing a person can act on; ours says what to check.
    return failed('', 'plugin_unreachable', null);
  }
}

/** /api/chat: the connected model, or the user's OpenClaw gateway, streamed as dsul frames. */
async function viaChatRoute(input: TurnInput): Promise<TurnOutcome> {
  const { signal } = input;
  const connected = useAIConnectionStore.getState().model?.model;
  const model = input.target === 'model' && isModelId(connected) ? connected : null;
  let content = '';
  try {
    const { systemPrompt } = useAISettingsStore.getState();
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        messages: input.turns,
        // Clipped to the server's own limit: it clips there anyway, and an
        // unclipped heavy account would push the body past its cap.
        context: clipText(input.context, MAX_CHAT_CONTEXT_CHARS),
        // Who answers. The key, the model and the prompt are the server's;
        // this body never carries any of them.
        target: input.target,
        // The user's own instructions, APPENDED server-side to the built-in
        // prompt, never in place of it.
        customInstructions: clipText(systemPrompt, MAX_INSTRUCTIONS_CHARS),
        typeNouns: input.typeNouns,
        // Which CONVERSATION this is, never a session key. The server builds
        // the gateway key from this and the authenticated user, so a browser
        // can't address another user's session or a reserved namespace.
        // Ignored on the model path.
        conversationId: input.conversationId,
      }),
    });

    if (!res.ok) {
      // Refused before any stream: the body is our own copy and a code. The
      // code is what is kept; the copy is lib/chat-errors.ts's.
      const b = (await res.json().catch(() => null)) as { code?: unknown } | null;
      noteFailure(b?.code);
      return failed('', b?.code, model);
    }
    if (!res.body) return failed('', 'no_response', model);

    // Token by token: /api/chat streams real provider deltas, then at most one
    // `{error, code}` frame, then [DONE].
    let errorCode: unknown = undefined;
    let errored = false;
    for await (const frame of parseSseFrames(res.body)) {
      if (typeof frame.content === 'string' && frame.content) {
        content += frame.content;
        input.onDelta(frame.content);
      }
      if (typeof frame.error === 'string' && frame.error) {
        errored = true;
        errorCode = frame.code;
        noteFailure(frame.code);
        break;
      }
    }
    // Stop reading after an error frame: nothing behind it is meant for the
    // user. (Breaking out released the parser's lock first.)
    if (errored) {
      res.body.cancel().catch(() => {});
      return failed(content, errorCode, model);
    }
    // A stream that closed with nothing in it is not a reply.
    if (content === '') return failed('', 'no_response', model);
    return { content, status: 'complete', errorCode: null, model };
  } catch (err) {
    if (isAbort(err, signal)) return { content, status: 'stopped', errorCode: null, model };
    return failed(content, 'client', model);
  }
}

/** The real transport. Tests inject their own through `configureConversations`. */
export const chatTransport: ChatTransport = {
  streamTurn: (input) =>
    input.target === 'openclaw' && input.via === 'plugin' ? viaPlugin(input) : viaChatRoute(input),
};
