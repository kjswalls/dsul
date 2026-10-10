import { create } from 'zustand';
import { changePhrase } from './conversation-summary';
import type { ConversationChanges } from './conversation-types';

/**
 * A receipt in the conversation for a plan it accepted: what changed, said
 * where it was asked for, with an Undo while that change is still the last
 * thing done.
 *
 * Memory only, for this tab's session. A receipt names a planner history entry,
 * and that history is itself per tab and gone on reload, so a saved receipt
 * would come back with an Undo that can no longer undo anything. What the
 * account keeps of an accepted plan is the conversation's four counters
 * (History's second line), as before.
 *
 * The rules are pure functions over plain data, so they lift out with the rest
 * of the chat when it becomes its own package; the store is the one dsul seam.
 */

export interface ChatReceipt {
  /** The planner history entry the accept wrote: what Undo takes back. */
  actionId: string;
  /** The last message on screen when the plan was accepted; the receipt sits under it. */
  afterMessageId: string | null;
  tally: ConversationChanges;
  undone: boolean;
}

/** "Moved 2 items · Added a step", and "· Undone" once taken back. Null when nothing changed. */
export function receiptCopy(r: Pick<ChatReceipt, 'tally' | 'undone'>): string | null {
  const phrase = changePhrase(r.tally);
  if (!phrase) return null;
  return r.undone ? `${phrase} · Undone` : phrase;
}

/**
 * Undo is offered only while the accept is still the planner's latest entry:
 * the planner's history is one line, and undoing past a later change would
 * take that change back too, which the button never said it would.
 */
export function canUndoReceipt(r: Pick<ChatReceipt, 'actionId' | 'undone'>, latestActionId: string | null): boolean {
  return !r.undone && latestActionId !== null && r.actionId === latestActionId;
}

/**
 * Where each receipt goes: under the message it was accepted after, or at the
 * end when that message is not on screen (not loaded, or the receipt came
 * before any message). Index of the message → receipts after it; -1 → the end.
 */
export function placeReceipts(
  messageIds: readonly string[],
  receipts: readonly ChatReceipt[]
): Map<number, ChatReceipt[]> {
  const at = new Map<number, ChatReceipt[]>();
  for (const r of receipts) {
    const i = r.afterMessageId ? messageIds.lastIndexOf(r.afterMessageId) : -1;
    const list = at.get(i) ?? [];
    list.push(r);
    at.set(i, list);
  }
  return at;
}

const NONE: readonly ChatReceipt[] = Object.freeze([]);

interface ChatReceiptsState {
  byConversation: Record<string, readonly ChatReceipt[]>;
  add: (conversationId: string, receipt: ChatReceipt) => void;
  markUndone: (conversationId: string, actionId: string) => void;
  reset: () => void;
}

export const useChatReceipts = create<ChatReceiptsState>()((set) => ({
  byConversation: {},
  add: (conversationId, receipt) =>
    set((s) => ({
      byConversation: {
        ...s.byConversation,
        // At most ten per conversation: a receipt is a line, not a ledger.
        [conversationId]: [...(s.byConversation[conversationId] ?? NONE), receipt].slice(-10),
      },
    })),
  markUndone: (conversationId, actionId) =>
    set((s) => {
      const list = s.byConversation[conversationId];
      if (!list) return s;
      return {
        byConversation: {
          ...s.byConversation,
          [conversationId]: list.map((r) => (r.actionId === actionId ? { ...r, undone: true } : r)),
        },
      };
    }),
  reset: () => set({ byConversation: {} }),
}));

/** A conversation's receipts, the same empty array when it has none. */
export function useConversationReceipts(conversationId: string | null | undefined): readonly ChatReceipt[] {
  return useChatReceipts((s) => (conversationId ? (s.byConversation[conversationId] ?? NONE) : NONE));
}
