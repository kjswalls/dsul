import { create } from 'zustand';
import { answerAgentQuestion } from './agent-question';
import { usePlannerStore } from './planner-store';
import type { AgentItem } from './ask-home';

/**
 * Answers to agents' questions, held for a moment so they can be taken back
 * (the Needs-you inbox and the card in a grid block; lib/needs-you.ts).
 *
 * An answer is two writes (lib/agent-question.ts): a reply on the item's trail
 * and the item back to `queued`, where the agent picks it up on its next run.
 * Neither can be quietly un-sent once the agent has read it, so the card folds
 * to the answer with Undo first, and the writes go out only when the undo
 * window closes, the page is hidden, or another answer is committed for the
 * same item. Until then the item is still `blocked` in the store, and the
 * surfaces draw it folded.
 *
 * Memory only. `inbox` is the header badge's popover, which a block's card can
 * open on its own item (`focus`).
 */

/** How long an answer can be taken back. */
export const UNDO_MS = 6000;

interface Pending {
  text: string;
}

interface NeedsYouState {
  pending: Record<string, Pending>;
  inbox: { open: boolean; focus: string | null };
  /** Answer `item`, after UNDO_MS. False, writing nothing, for a blank answer. */
  answer: (item: AgentItem, text: string) => boolean;
  /** Take an answer back before it goes. */
  undo: (itemId: string) => void;
  /** Send every held answer now. */
  flush: () => void;
  openInbox: (focus?: string | null) => void;
  closeInbox: () => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function stop(itemId: string) {
  const t = timers.get(itemId);
  if (t) clearTimeout(t);
  timers.delete(itemId);
}

export const useNeedsYouStore = create<NeedsYouState>((set, get) => {
  /** Write one held answer, against the item as the store has it now. */
  const commit = (itemId: string) => {
    stop(itemId);
    const held = get().pending[itemId];
    if (!held) return;
    set((s) => {
      const pending = { ...s.pending };
      delete pending[itemId];
      return { pending };
    });
    const item = usePlannerStore.getState().items.find((i) => i.id === itemId);
    // Gone, or answered elsewhere meanwhile (the item's own reply box): the
    // question this answered is no longer open, so nothing goes.
    if (!item || !('aiStatus' in item) || item.aiStatus !== 'blocked') return;
    answerAgentQuestion(item, held.text);
  };

  return {
    pending: {},
    inbox: { open: false, focus: null },

    answer: (item, text) => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      stop(item.id);
      set((s) => ({ pending: { ...s.pending, [item.id]: { text: trimmed } } }));
      timers.set(
        item.id,
        setTimeout(() => commit(item.id), UNDO_MS)
      );
      return true;
    },

    undo: (itemId) => {
      stop(itemId);
      set((s) => {
        const pending = { ...s.pending };
        delete pending[itemId];
        return { pending };
      });
    },

    flush: () => {
      for (const id of Object.keys(get().pending)) commit(id);
    },

    openInbox: (focus = null) => set({ inbox: { open: true, focus } }),
    closeInbox: () => set({ inbox: { open: false, focus: null } }),
  };
});

// A held answer must not die with the tab: hiding the page sends them.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => useNeedsYouStore.getState().flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') useNeedsYouStore.getState().flush();
  });
}
