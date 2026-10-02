import { create } from 'zustand';
import { usePlannerStore } from './planner-store';
import { useAISettingsStore } from './ai-settings-store';
import { getAICapabilities, useAIConnectionStore } from './ai-connection-store';
import { buildDsulContext } from './ai-context';
import {
  MAX_CHAT_CONTEXT_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
  clipText,
} from './ai-limits';
import { goalsEnabled } from './extension-gates';
import { stripReasoningTags } from './chat-utils';
import { parseSseFrames } from './sse';
import type { ChatErrorCode } from './ai-types';

/**
 * Shared chat state + streaming logic for the connected model and OpenClaw,
 * extracted from chat-sidebar so the desktop chat panel and mobile chat panel
 * render the same conversation (previously ~500 duplicated lines).
 *
 * WHO answers is not this store's business. The gate (`getAICapabilities()`,
 * lib/ai-connection-store.ts) says whether anything can and through which
 * transport; `send` reads it at the moment of sending and writes nothing to the
 * transcript when the answer is "nothing". The key, the model and the prompt
 * all live server-side: the body names a target and carries the user's own
 * instructions as data, never a key, a model or a system prompt.
 *
 * Now a store FACTORY: the global conversation is one instance
 * (`useChatStore`, byte-compatible with the old singleton), and each item's
 * thread is another (`itemChatStore(id)`), keyed by its own localStorage
 * history and its own OpenClaw sessionKey — the plugin passes a client-chosen
 * sessionKey straight through to `runtime.subagent.run`, so per-item threads
 * need no plugin change (openclaw-plugin/src/chat.ts).
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
}

const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
const ITEM_HISTORY_PREFIX = 'dsul-item-chat-';

/**
 * Per-thread transcript cap. localStorage is ~5MB for the WHOLE origin and
 * eight other stores persist into it; when it fills, `setItem` throws for all
 * of them, so a runaway thread doesn't break chat, it breaks view prefs and
 * the morning check. Trim the oldest rather than risk the ceiling.
 */
const MAX_STORED_MESSAGES = 100;

interface ChatThreadConfig {
  /** localStorage key for this thread's transcript. */
  historyKey: string;
  /** OpenClaw-side conversation identity (server history lives per key). */
  sessionKey: string;
  /** Narrow the planner context onto one item (per-item threads). */
  focusItemId?: string;
}

interface ChatStore {
  messages: ChatMessage[];
  isLoading: boolean;
  isTyping: boolean;
  hydrated: boolean;

  /** Load persisted history (24h TTL). Call once from the shell. */
  hydrate: () => void;
  clear: () => void;
  stop: () => void;
  send: (text: string) => Promise<void>;
}

/** What the legacy plugin path needs to reach the user's OpenClaw directly. */
interface PluginTransport {
  chatUrl: string | null;
  /** The user's dsul plugin key (not a provider key), sent as the bearer. */
  dsulApiKey: string | null;
}

/**
 * The plugin transport, fetched lazily and shared by every thread.
 *
 * Only the legacy plugin path needs `/api/agent/chat-url`: the gate already
 * knows a chat URL is registered (`openclaw.pluginChat`), but the browser
 * still needs the URL itself and the plugin key to call it. Fetched on the
 * first plugin send, not on every panel mount, and keyed by the account the
 * gate answered for, so a different user on this browser never reuses the
 * last one's key. A failure is not cached: the next send asks again.
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
 * Forget the cached plugin URL and key. Reached through `clearChatState()`,
 * which both the sign-out clear (lib/local-state.ts) and a user's change of
 * answerer (`chooseChatTarget`, lib/chat-target.ts) call.
 */
export function resetPluginTransport(): void {
  pluginTransport = null;
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
  if (typeof code !== 'string' || !code) return;
  useAIConnectionStore.getState().noteCallFailure(code as ChatErrorCode);
}

const GENERIC_FAILURE = 'Something went wrong. Try again.';

export function createChatStore(config: ChatThreadConfig) {
  const { historyKey, sessionKey, focusItemId } = config;

  function saveHistory(messages: ChatMessage[]) {
    if (messages.length === 0) return;
    const stored =
      messages.length > MAX_STORED_MESSAGES ? messages.slice(-MAX_STORED_MESSAGES) : messages;
    try {
      localStorage.setItem(historyKey, JSON.stringify({ messages: stored, savedAt: Date.now() }));
    } catch {
      /* ignore */
    }
  }

  // Per-store: stopping one thread must not kill another thread's stream.
  let abortController: AbortController | null = null;

  return create<ChatStore>()((set, get) => {
    const setMessages = (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
      const messages = updater(get().messages);
      set({ messages });
      saveHistory(messages);
    };

    const patchLastAssistant = (patch: (last: ChatMessage) => ChatMessage) => {
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === 'assistant') next[next.length - 1] = patch(last);
        return next;
      });
    };

    /** Put our own copy in the reply bubble, replacing whatever was there. */
    const replyWith = (content: string) =>
      patchLastAssistant(() => ({ role: 'assistant', content, timestamp: Date.now() }));

    /**
     * Remove the placeholder turn a stopped reply never filled.
     *
     * `send` pushes an empty assistant message up front so the typing dots have
     * somewhere to live. Aborting used to just return, leaving that empty
     * bubble in the transcript AND in localStorage — a turn that never fills,
     * offers no "Turn this into a plan" (gated on content), and suppresses the
     * openers forever after, since those key on an empty transcript.
     *
     * Only ever drops a LAST assistant turn that is still empty, so a reply
     * stopped halfway keeps whatever text had already arrived — that partial
     * answer is usually why the user hit stop.
     */
    const dropEmptyAssistantTurn = () => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        return last?.role === 'assistant' && last.content === '' ? prev.slice(0, -1) : prev;
      });
    };

    /**
     * The legacy plugin path: POST straight at the user's OpenClaw plugin.
     * Only for an account with no gateway; a gateway rides /api/chat.
     */
    async function sendViaPlugin(message: string, context: string): Promise<void> {
      set({ isTyping: true });
      abortController?.abort();
      const controller = new AbortController();
      abortController = controller;
      try {
        // A read that fails (an expired session, a 500, offline) lands in the
        // catch below, as "can't reach": the gate already knows this account
        // registered a chat URL, so sending it back to setup would be wrong.
        const transport = await loadPluginTransport();
        if (controller.signal.aborted) {
          dropEmptyAssistantTurn();
          return;
        }
        // Only a read that SUCCEEDED with no URL means setup is unfinished.
        if (!transport.chatUrl) {
          replyWith(
            "OpenClaw isn't reachable yet. Run `openclaw dsul-context setup` and set publicUrl in openclaw.json."
          );
          return;
        }
        const { systemPrompt } = useAISettingsStore.getState();
        const res = await fetch(transport.chatUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(transport.dsulApiKey ? { Authorization: `Bearer ${transport.dsulApiKey}` } : {}),
          },
          signal: controller.signal,
          // The plugin contract, exactly. Nothing else rides along.
          body: JSON.stringify({
            message,
            sessionKey,
            context: withInstructions(context, systemPrompt),
          }),
        });
        // The plugin may have re-registered (a new URL or key) since this was
        // cached; a refused call re-reads both on the next send.
        if (!res.ok) resetPluginTransport();
        // The plugin answers with one JSON body, not a stream (#149). It
        // used to write SSE framing around a single payload it only
        // emitted once the whole run finished, so there was never
        // anything incremental to read.
        const parsed = (await res.json()) as { content?: string; error?: string };
        const accumulated = parsed.error ? `Error: ${parsed.error}` : (parsed.content ?? '');
        patchLastAssistant((last) => ({
          ...last,
          content: stripReasoningTags(accumulated) || 'No response received.',
          timestamp: Date.now(),
        }));
      } catch (err) {
        // The URL read takes no signal, so a stop during it shows up here as
        // a plain rejection on an aborted controller, not an AbortError.
        if (
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === 'AbortError')
        ) {
          dropEmptyAssistantTurn();
          return;
        }
        resetPluginTransport();
        // The browser's own wording ("Failed to fetch", "Load failed") says
        // nothing a person can act on; ours says what to check.
        replyWith("Couldn't reach OpenClaw. Check that it is running.");
      } finally {
        if (abortController === controller) abortController = null;
        set({ isTyping: false, isLoading: false });
      }
    }

    return {
      messages: [],
      isLoading: false,
      isTyping: false,
      hydrated: false,

      hydrate: () => {
        if (get().hydrated) return;
        set({ hydrated: true });
        try {
          const raw = localStorage.getItem(historyKey);
          if (!raw) return;
          const parsed = JSON.parse(raw);
          if (
            parsed?.savedAt &&
            Date.now() - parsed.savedAt < HISTORY_TTL_MS &&
            Array.isArray(parsed.messages)
          ) {
            set({ messages: parsed.messages });
          } else {
            localStorage.removeItem(historyKey);
          }
        } catch {
          localStorage.removeItem(historyKey);
        }
      },

      clear: () => {
        set({ messages: [] });
        try {
          localStorage.removeItem(historyKey);
        } catch {
          /* ignore */
        }
      },

      stop: () => {
        abortController?.abort();
        abortController = null;
      },

      send: async (text) => {
        const trimmed = text.trim();
        // The gate first, before a single byte reaches the transcript: with
        // nothing to answer, a sent message would sit under a reply that can
        // never come.
        const caps = getAICapabilities();
        if (!caps.canChat || !trimmed || get().isLoading) return;

        const userMessage: ChatMessage = { role: 'user', content: trimmed, timestamp: Date.now() };
        const updatedMessages = [...get().messages, userMessage];
        setMessages(() => updatedMessages);
        set({ isLoading: true });
        setMessages((prev) => [...prev, { role: 'assistant', content: '', timestamp: Date.now() }]);

        // Declared out here so `finally` can tell "my controller" from a newer
        // request's — clearing the store's reference unconditionally would let
        // a finishing request disarm the stop button of the one after it.
        let controller: AbortController | null = null;

        try {
          const { items, projects, itemTypes, routines, seasons, goals, userTimezone } =
            usePlannerStore.getState();
          const context = buildDsulContext({
            items, projects, routines, seasons,
            // The AI is told about goals only while the user has the idea
            // switched on. `buildDsulContext` already renders nothing for an
            // empty list, so this removes a LINE from the context rather than
            // changing its shape — the byte-pinned no-goal output is what an
            // account with Goals off now gets. Nothing is written either way.
            goals: goalsEnabled() ? goals : [],
            focusItemId, userTimezone,
          });

          if (caps.target === 'openclaw' && caps.openclawTransport === 'plugin') {
            await sendViaPlugin(trimmed, context);
            return;
          }

          // Fresh values via getState() to avoid stale closures.
          const { systemPrompt } = useAISettingsStore.getState();
          // Custom-type nouns reach the model through the server's prompt.
          const typeNouns = itemTypes.map((t) => t.labelPlural.toLowerCase());
          // The newest turns only, each clipped: the server keeps at most this
          // many and clips every turn to the same length anyway, so the model
          // sees exactly what it would unclipped. What clipping here buys is
          // the body cap: one oversized paste stays in the stored history
          // (up to MAX_STORED_MESSAGES), and unclipped it would ride every
          // later send and get each one refused as too long.
          const outgoing = updatedMessages
            .slice(-MAX_MESSAGES)
            .map(({ role, content }) => ({ role, content: clipText(content, MAX_MESSAGE_CHARS) }));

          // The stop button reaches HERE, not just the plugin branch above.
          abortController?.abort();
          controller = new AbortController();
          abortController = controller;

          const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              messages: outgoing,
              // Clipped to the server's own limit, for the same reason.
              context: clipText(context, MAX_CHAT_CONTEXT_CHARS),
              // Who answers. The key, the model and the prompt are the
              // server's; this body never carries any of them.
              target: caps.target,
              // The user's own instructions, APPENDED server-side to the
              // built-in prompt, never in place of it.
              customInstructions: clipText(systemPrompt, MAX_INSTRUCTIONS_CHARS),
              typeNouns,
              // Which THREAD this is, never the session key itself. The server
              // derives the gateway key from this plus the authenticated user,
              // so a browser can't address another thread or the gateway's
              // reserved namespaces. Ignored on the model path.
              threadItemId: focusItemId ?? null,
            }),
          });

          if (!res.ok) {
            // Refused before any stream: the body is our own copy and a code.
            const b = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
            replyWith(typeof b?.error === 'string' && b.error ? b.error : GENERIC_FAILURE);
            noteFailure(b?.code);
            return;
          }

          if (!res.body) throw new Error('No response body');

          // Token-by-token: /api/chat streams real provider deltas, then at
          // most one `{error, code}` frame, then [DONE].
          let failed = false;
          for await (const frame of parseSseFrames(res.body)) {
            if (typeof frame.content === 'string' && frame.content) {
              const delta = frame.content;
              patchLastAssistant((last) => ({ ...last, content: last.content + delta }));
            }
            if (typeof frame.error === 'string' && frame.error) {
              const error = frame.error;
              // Whatever arrived before the failure stays; the reason follows it.
              patchLastAssistant((last) => ({
                ...last,
                content: last.content === '' ? error : `${last.content}\n\n${error}`,
                timestamp: Date.now(),
              }));
              noteFailure(frame.code);
              failed = true;
              break;
            }
          }
          // Stop reading after an error frame: nothing behind it is meant for
          // the user. (Breaking out released the parser's lock first.)
          if (failed) res.body.cancel().catch(() => {});

          // A stream that closed with nothing in it must not strand an empty
          // bubble: it never fills, and it suppresses the openers for good.
          patchLastAssistant((last) =>
            last.content === '' ? { ...last, content: 'No response received.' } : last
          );
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            dropEmptyAssistantTurn();
          } else {
            patchLastAssistant((last) =>
              last.content === ''
                ? {
                    role: 'assistant',
                    content: 'Sorry, something went wrong. Please try again.',
                    timestamp: Date.now(),
                  }
                : last
            );
          }
        } finally {
          if (abortController === controller) abortController = null;
          set({ isLoading: false });
        }
      },
    };
  });
}

export type ChatStoreHook = ReturnType<typeof createChatStore>;

/** The global conversation — the pre-factory singleton, unchanged. */
export const useChatStore = createChatStore({
  historyKey: 'dsul-chat-history',
  sessionKey: 'dsul-chat',
});

// Per-item threads, created lazily and cached for hook identity — a component
// must get the SAME store instance across renders or zustand resubscribes
// every render. Bounded in practice by how many item panels a session opens.
const itemChatStores = new Map<string, ChatStoreHook>();

export function itemChatStore(itemId: string): ChatStoreHook {
  let store = itemChatStores.get(itemId);
  if (!store) {
    store = createChatStore({
      historyKey: `dsul-item-chat-${itemId}`,
      sessionKey: `dsul-item-${itemId}`,
      focusItemId: itemId,
    });
    itemChatStores.set(itemId, store);
  }
  return store;
}

/** Walk every stored item-thread key. Backwards, since removal reindexes. */
function forEachItemThreadKey(fn: (key: string) => void) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(ITEM_HISTORY_PREFIX)) fn(key);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Drop every transcript this browser holds — the global thread and every
 * per-item thread, in memory and on disk — and the cached plugin transport.
 *
 * The most sensitive thing in this app's localStorage, and the one Kirby's
 * original report did not name: `dsul-chat-history` and every
 * `dsul-item-chat-<id>` hold the VERBATIM conversation, question and answer,
 * under browser-global keys. The 24h TTL is a quota measure, not a privacy
 * one — it is not a sign-out, and it does not fire for a thread nobody reopens
 * until the boot sweep below happens to reach it.
 *
 * Clearing the instantiated stores is not enough on its own: a thread that was
 * never opened this session exists only on disk, which is why the raw key walk
 * runs too. Two callers: the sign-out clear (RAW_CLEARERS in
 * lib/local-state.ts) and `chooseChatTarget` (lib/chat-target.ts), the one
 * user-initiated change of answerer. Nothing subscribes to the stored choice
 * any more: a subscriber also fired on rehydration and on resets, and wiped
 * transcripts nobody asked to lose.
 */
export function clearChatState(): void {
  resetPluginTransport();
  useChatStore.getState().clear();
  itemChatStores.forEach((store) => store.getState().clear());
  forEachItemThreadKey((key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  });
}

/**
 * Drop expired item transcripts at boot.
 *
 * The 24h TTL is only checked when a thread is OPENED, so a transcript for an
 * item you never revisit is never swept — it just sits there, and the pile only
 * grows. Sweeping once per session keeps the origin's shared quota from filling
 * with conversations nobody will read again.
 */
function sweepExpiredItemThreads() {
  const now = Date.now();
  forEachItemThreadKey((key) => {
    let expired = true;
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? 'null');
      expired = !parsed?.savedAt || now - parsed.savedAt >= HISTORY_TTL_MS;
    } catch {
      expired = true; // unparseable is also worth reclaiming
    }
    if (expired) localStorage.removeItem(key);
  });
}

// Module scope, once per page load; inert on the server.
if (typeof window !== 'undefined') {
  sweepExpiredItemThreads();
}
