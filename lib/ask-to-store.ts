import { create } from 'zustand';

/**
 * Who Ask's box writes to, when it is an agent (Claude, Cursor) rather than
 * the user's own answerer (memory/plans/agent-chat.md, step 2).
 *
 * Memory only, never persisted. `home` is the pick on Ask home's box (and the
 * dock's and Ctrl+K's `?`, which start from home); the first message carries it
 * onto the conversation it starts. `byThread` is each conversation's own pick.
 * Neither ever resets Ask the way `chooseChatTarget` does: one conversation can
 * mix answerers, and each reply says who wrote it.
 *
 * `waiting` is each message sent to an agent that has no answer in this
 * browser yet, by the message's id: what "Sent to Claude" is drawn from, and
 * what keeps lib/agent-chat.ts looking for answers.
 */
export interface AskWaiting {
  threadId: string;
  agent: string;
}

interface AskToState {
  home: string | null;
  byThread: Record<string, string>;
  waiting: Record<string, AskWaiting>;
  /** Messages the inbox refused or never got, by message id: "Not sent to Claude". */
  unsent: Record<string, string>;
  markUnsent: (messageId: string, agent: string) => void;
  setHome: (agent: string | null) => void;
  setFor: (threadId: string, agent: string | null) => void;
  markWaiting: (messageId: string, w: AskWaiting) => void;
  clearWaiting: (messageId: string) => void;
  reset: () => void;
}

export const useAskToStore = create<AskToState>((set) => ({
  home: null,
  byThread: {},
  waiting: {},
  unsent: {},
  markUnsent: (messageId, agent) =>
    set((s) => {
      const waiting = { ...s.waiting };
      delete waiting[messageId];
      return { waiting, unsent: { ...s.unsent, [messageId]: agent } };
    }),
  setHome: (agent) => set({ home: agent }),
  setFor: (threadId, agent) =>
    set((s) => {
      // '' is a pick too: the user's own answerer, over what the transcript suggests.
      return { byThread: { ...s.byThread, [threadId]: agent ?? '' } };
    }),
  markWaiting: (messageId, w) => set((s) => ({ waiting: { ...s.waiting, [messageId]: w } })),
  clearWaiting: (messageId) =>
    set((s) => {
      if (!(messageId in s.waiting)) return s;
      const waiting = { ...s.waiting };
      delete waiting[messageId];
      return { waiting };
    }),
  reset: () => set({ home: null, byThread: {}, waiting: {}, unsent: {} }),
}));

/** What `askToFor` reads of a conversation: its messages, oldest first. */
type Said = readonly { id: string; role: 'user' | 'assistant'; answerer: string | null }[];

/**
 * The agent a composer writes to. Home's pick for a box with no conversation
 * yet; a conversation's own pick when one was made here; otherwise whoever it
 * was last talking to: the agent that wrote its last reply, or that its last
 * question is still waiting on. Null means the user's own answerer.
 */
export function askToFor(threadId: string | null, messages: Said = []): string | null {
  const s = useAskToStore.getState();
  if (threadId === null) return s.home;
  if (threadId in s.byThread) return s.byThread[threadId] || null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') {
      const w = s.waiting[m.id];
      if (w) return w.agent;
      continue;
    }
    return m.answerer?.startsWith('agent:') ? m.answerer.slice('agent:'.length) : null;
  }
  return null;
}
