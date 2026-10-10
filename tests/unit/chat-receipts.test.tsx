import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * A receipt where a plan was accepted: what changed, said in the conversation
 * that asked, with Undo while that accept is still the planner's latest entry.
 * Undoing past a later change would take that change back too, so the button
 * goes the moment anything else is done.
 */

vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => {} }));

import { TranscriptMessages } from '@/components/ai/chat-transcript';
import {
  canUndoReceipt,
  placeReceipts,
  receiptCopy,
  useChatReceipts,
  type ChatReceipt,
} from '@/lib/chat-receipts';
import { usePlannerStore } from '@/lib/planner-store';
import { useUndoStripStore } from '@/lib/undo-strip-store';
import type { ChatMessage } from '@/lib/conversations-store';

const msg = (id: string, role: 'user' | 'assistant', content: string): ChatMessage => ({
  id,
  role,
  content,
  status: 'complete',
  errorCode: null,
  replyTo: null,
  answerer: role === 'assistant' ? 'model' : null,
  model: null,
  createdAt: 0,
  pos: 0,
  sync: 'saved',
});

const receipt = (over: Partial<ChatReceipt> = {}): ChatReceipt => ({
  actionId: 'act-2',
  afterMessageId: 'a1',
  tally: { added: 0, steps: 0, moved: 2, changed: 0 },
  undone: false,
  ...over,
});

/** The planner's log as the store keeps it: newest first, historyIndex counted from the oldest. */
function plannerAt(ids: string[], index: number) {
  usePlannerStore.setState({
    actionLog: [...ids].reverse().map((id) => ({ id, label: id, timestamp: 0 })),
    historyIndex: index,
  });
}

const THREAD = [msg('u1', 'user', 'plan my day'), msg('a1', 'assistant', 'Here is a plan'), msg('u2', 'user', 'thanks')];

describe('receiptCopy', () => {
  it('says what changed, and that it was taken back once it was', () => {
    expect(receiptCopy(receipt())).toBe('Moved 2 items');
    expect(receiptCopy(receipt({ undone: true, tally: { added: 1, steps: 0, moved: 1, changed: 0 } }))).toBe(
      'Moved 1 item · Added 1 item · Undone'
    );
  });

  it('is null when the accept changed nothing countable', () => {
    expect(receiptCopy(receipt({ tally: { added: 0, steps: 0, moved: 0, changed: 0 } }))).toBeNull();
  });
});

describe('canUndoReceipt', () => {
  it('only while the accept is the latest entry and not yet undone', () => {
    expect(canUndoReceipt(receipt(), 'act-2')).toBe(true);
    expect(canUndoReceipt(receipt(), 'act-3')).toBe(false);
    expect(canUndoReceipt(receipt(), null)).toBe(false);
    expect(canUndoReceipt(receipt({ undone: true }), 'act-2')).toBe(false);
  });
});

describe('placeReceipts', () => {
  it('puts each under the message it followed, or at the end when that message is not on screen', () => {
    const placed = placeReceipts(['u1', 'a1', 'u2'], [receipt(), receipt({ actionId: 'x', afterMessageId: 'gone' })]);
    expect(placed.get(1)?.map((r) => r.actionId)).toEqual(['act-2']);
    expect(placed.get(-1)?.map((r) => r.actionId)).toEqual(['x']);
  });
});

describe('the receipt line', () => {
  const undo = vi.fn();
  let realUndo: () => void;
  beforeEach(() => {
    realUndo = usePlannerStore.getState().undo;
    usePlannerStore.setState({ undo });
    undo.mockClear();
    useChatReceipts.getState().reset();
  });
  afterEach(() => {
    cleanup();
    usePlannerStore.setState({ undo: realUndo });
  });

  it('sits under the reply it followed, and Undo takes the accept back', () => {
    plannerAt(['act-1', 'act-2'], 1);
    useChatReceipts.getState().add('c1', receipt());
    const dismiss = vi.spyOn(useUndoStripStore.getState(), 'dismiss');
    render(
      <TranscriptMessages
        messages={THREAD}
        typing={false}
        busy={false}
        receipts={{ conversationId: 'c1', list: useChatReceipts.getState().byConversation.c1 ?? [] }}
      />
    );
    const line = screen.getByTestId('chat-receipt');
    expect(line.textContent).toContain('Moved 2 items');
    // Under the reply, above the next question.
    const reply = screen.getByText('Here is a plan');
    expect(reply.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.compareDocumentPosition(screen.getByText('thanks')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByTestId('chat-receipt-undo'));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(useChatReceipts.getState().byConversation.c1?.[0]?.undone).toBe(true);
    expect(dismiss).toHaveBeenCalledWith('act-2');
  });

  it('offers no Undo once something else has been done since', () => {
    plannerAt(['act-1', 'act-2', 'act-3'], 2);
    render(
      <TranscriptMessages messages={THREAD} typing={false} busy={false} receipts={{ conversationId: 'c1', list: [receipt()] }} />
    );
    expect(screen.getByTestId('chat-receipt')).toBeTruthy();
    expect(screen.queryByTestId('chat-receipt-undo')).toBeNull();
  });

  it('offers it again when the later change is itself undone', () => {
    plannerAt(['act-1', 'act-2', 'act-3'], 1);
    render(
      <TranscriptMessages messages={THREAD} typing={false} busy={false} receipts={{ conversationId: 'c1', list: [receipt()] }} />
    );
    expect(screen.getByTestId('chat-receipt-undo')).toBeTruthy();
  });
});

describe('the receipts store', () => {
  it('keeps the last ten per conversation and clears on reset', () => {
    const s = useChatReceipts.getState();
    s.reset();
    for (let i = 0; i < 12; i++) s.add('c1', receipt({ actionId: `a${i}` }));
    expect(useChatReceipts.getState().byConversation.c1?.map((r) => r.actionId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `a${i + 2}`)
    );
    useChatReceipts.getState().reset();
    expect(useChatReceipts.getState().byConversation).toEqual({});
  });
});
