import { create } from 'zustand';
import { usePlannerStore } from './planner-store';
import { useAISettingsStore } from './ai-settings-store';
import { buildDsulContext } from './ai-context';
import { goalsEnabled } from './extension-gates';
import { buildBeaconSystemPrompt } from './beacon-system-prompt';
import { stripReasoningTags } from './chat-utils';
import { parseSseFrames } from './sse';

/**
 * Shared chat state + streaming logic for Beacon/OpenClaw, extracted from
 * chat-sidebar so the desktop chat panel and mobile chat panel render the
 * same conversation (previously ~500 duplicated lines).
 *
 * Now a store FACTORY: the global Beacon conversation is one instance
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
  /** Narrow the Beacon context onto one item (per-item threads). */
  focusItemId?: string;
}

interface ChatStore {
  messages: ChatMessage[];
  isLoading: boolean;
  isTyping: boolean;
  hydrated: boolean;

  /** OpenClaw connection info (fetched when the provider is openclaw). */
  openclawChatUrl: string | null;
  openclawAgentIdDisplay: string | null;
  openclawDsulApiKey: string | null;
  /**
   * True once a gateway URL *and* token are stored server-side. Selects the
   * transport: gateway chat is proxied through /api/chat (durable sessions,
   * operator token never in the browser), and only accounts that have not set
   * one up still POST at the plugin's /plugins/dsul/chat.
   */
  openclawGatewayConfigured: boolean;

  /** Load persisted history (24h TTL). Call once from the shell. */
  hydrate: () => void;
  /** Fetch or clear OpenClaw info to match the current provider. */
  syncOpenclawInfo: () => void;
  clear: () => void;
  stop: () => void;
  send: (text: string) => Promise<void>;
}

export function createChatStore(config: ChatThreadConfig) {
  const { historyKey, sessionKey, focusItemId } = config;

  /**
   * Resolves once this thread knows which transport it is on.
   *
   * syncOpenclawInfo fires unawaited, and send() reads the answer
   * synchronously — so a user who opens the panel and types straight away
   * could have their first message take the plugin path with a gateway
   * configured, or be told "OpenClaw not connected yet" when it is. One
   * message on the wrong transport is not a crash, which is exactly why it
   * would have gone unnoticed.
   */
  let transportReady: Promise<void> | null = null;

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

    return {
      messages: [],
      isLoading: false,
      isTyping: false,
      hydrated: false,
      openclawChatUrl: null,
      openclawAgentIdDisplay: null,
      openclawDsulApiKey: null,
      openclawGatewayConfigured: false,

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

      syncOpenclawInfo: () => {
        if (useAISettingsStore.getState().provider !== 'openclaw') {
          set({
            openclawChatUrl: null,
            openclawAgentIdDisplay: null,
            openclawDsulApiKey: null,
            openclawGatewayConfigured: false,
          });
          return;
        }

        // Gateway status decides the transport; the legacy chat-url lookup
        // stays as the fallback for accounts still on the plugin path.
        // Independent requests so one failing endpoint cannot blank the other.
        transportReady = fetch('/api/agent/gateway')
          .then((r) => (r.ok ? r.json() : null))
          .then((gateway) =>
            set({
              openclawGatewayConfigured: Boolean(gateway?.configured),
              ...(gateway?.agentId ? { openclawAgentIdDisplay: gateway.agentId } : {}),
            })
          )
          .catch(() => set({ openclawGatewayConfigured: false }));

        fetch('/api/agent/chat-url')
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          })
          .then((chatData) =>
            set({
              openclawChatUrl: chatData.chatUrl ?? null,
              openclawAgentIdDisplay: chatData.agentId ?? null,
              openclawDsulApiKey: chatData.dsulApiKey ?? null,
            })
          )
          .catch(() =>
            set({ openclawChatUrl: null, openclawAgentIdDisplay: null, openclawDsulApiKey: null })
          );
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
        if (!trimmed || get().isLoading) return;

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
          const { items, projects, itemTypes, routines, programs, goals, userTimezone } =
            usePlannerStore.getState();
          const context = buildDsulContext({
            items, projects, routines, programs,
            // Beacon is told about goals only while the user has the idea
            // switched on. `buildDsulContext` already renders nothing for an
            // empty list, so this removes a LINE from the context rather than
            // changing its shape — the byte-pinned no-goal output is what an
            // account with Goals off now gets. Nothing is written either way.
            goals: goalsEnabled() ? goals : [],
            focusItemId, userTimezone,
          });
          // Fresh values via getState() to avoid stale closures.
          const { provider, apiKey, model, systemPrompt } = useAISettingsStore.getState();
          // Custom-type nouns reach the model through the default prompt; a
          // user-customized prompt wins untouched.
          const typeNouns = itemTypes.map((t) => t.labelPlural.toLowerCase());
          const effectiveSystemPrompt = systemPrompt || buildBeaconSystemPrompt(typeNouns);

          // Wait for the transport answer if it is still in flight, so the
          // first message of a session cannot take the wrong path.
          if (provider === 'openclaw' && transportReady) {
            await transportReady;
          }

          // Gateway transport rides the shared /api/chat path below — one
          // client code path for every tier, translation done server-side.
          if (provider === 'openclaw' && !get().openclawGatewayConfigured) {
            const { openclawChatUrl, openclawDsulApiKey } = get();
            if (!openclawChatUrl) {
              patchLastAssistant(() => ({
                role: 'assistant',
                content:
                  'OpenClaw not connected yet — run `openclaw dsul-context setup` and set publicUrl in openclaw.json.',
                timestamp: Date.now(),
              }));
              set({ isLoading: false });
              return;
            }
            set({ isTyping: true });
            abortController?.abort();
            const controller = new AbortController();
            abortController = controller;
            try {
              const res = await fetch(openclawChatUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(openclawDsulApiKey ? { Authorization: `Bearer ${openclawDsulApiKey}` } : {}),
                },
                signal: controller.signal,
                body: JSON.stringify({ message: trimmed, sessionKey, context }),
              });
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
              if (err instanceof DOMException && err.name === 'AbortError') {
                dropEmptyAssistantTurn();
                return;
              }
              const msg = err instanceof Error ? err.message : 'Unknown error';
              patchLastAssistant(() => ({
                role: 'assistant',
                content: `Could not reach plugin: ${msg}`,
                timestamp: Date.now(),
              }));
            } finally {
              if (abortController === controller) abortController = null;
              set({ isTyping: false, isLoading: false });
            }
            return;
          }

          // The stop button reaches HERE, not just the plugin branch below it.
          // This fetch carried no signal until now, so `stop()` was a silent
          // no-op on the transport that serves openai and every gateway user —
          // the square stayed up, the reply kept arriving, and the composer
          // stayed disabled. Claimed otherwise in an earlier comment; it was
          // wrong.
          abortController?.abort();
          controller = new AbortController();
          abortController = controller;

          const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              messages: updatedMessages,
              context,
              provider,
              apiKey,
              model,
              systemPrompt: effectiveSystemPrompt,
              // The raw pieces, for when the deployment's key pays: the server
              // then builds Beacon's prompt itself and ignores `systemPrompt`.
              customInstructions: systemPrompt,
              typeNouns,
              // Which THREAD this is, never the session key itself. The server
              // derives the gateway key from this plus the authenticated user,
              // so a browser can't address another thread or the gateway's
              // reserved namespaces. Ignored by the non-gateway providers.
              threadItemId: focusItemId ?? null,
            }),
          });

          if (!res.body) throw new Error('No response body');

          // Token-by-token: /api/chat streams real provider deltas. Errors
          // arrive as content ("[Error: …]"), so there is no error frame here.
          for await (const frame of parseSseFrames(res.body)) {
            if (frame.content) {
              patchLastAssistant((last) => ({ ...last, content: last.content + frame.content }));
            }
          }
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

/** The global Beacon conversation — the pre-factory singleton, unchanged. */
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
 * Drop every transcript this browser holds — the global Beacon thread and every
 * per-item thread, in memory and on disk.
 *
 * The most sensitive thing in this app's localStorage after the Beacon API key,
 * and the one Kirby's original report did not name: `dsul-chat-history` and
 * every `dsul-item-chat-<id>` hold the VERBATIM conversation, question and
 * answer, under browser-global keys. The 24h TTL is a quota measure, not a
 * privacy one — it is not a sign-out, and it does not fire for a thread nobody
 * reopens until the boot sweep below happens to reach it.
 *
 * Clearing the instantiated stores is not enough on its own: a thread that was
 * never opened this session exists only on disk, which is why the raw key walk
 * runs too. That is the same pair the provider-change subscriber at the bottom
 * of this file already needed, now named once and called from both.
 */
export function clearChatState(): void {
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

// New provider → fresh transcripts (avoid mixing Beacon / OpenClaw threads)
// and re-sync connection info. Module-scope subscription; inert on the server.
if (typeof window !== 'undefined') {
  sweepExpiredItemThreads();
  let prevProvider = useAISettingsStore.getState().provider;
  useAISettingsStore.subscribe((state) => {
    if (state.provider !== prevProvider) {
      prevProvider = state.provider;
      // Item threads follow the same rule as the global one — a thread must
      // never interleave replies from two different providers — which is
      // exactly what clearChatState does, so it is shared with the sign-out
      // path rather than repeated here.
      clearChatState();
      useChatStore.getState().syncOpenclawInfo();
    }
  });
}
