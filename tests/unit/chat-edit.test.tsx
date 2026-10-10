import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { seedAI, CONNECTED_MODEL, NOTHING_CONNECTED } from './helpers/ai-fixtures';

/**
 * Edit under the latest question: the edited words go as a new turn through
 * the conversation's own binding, and the question as it was stays, with its
 * reply (Kirby's call, 2026-10-10: saved history is only ever added to).
 */

const sendFrom = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/lib/open-chat', () => ({ sendFrom }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => {} }));

import { editableQuestionIndex, TranscriptMessages } from '@/components/ai/chat-transcript';
import type { ChatMessage } from '@/lib/conversations-store';

const msg = (id: string, role: 'user' | 'assistant', content: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
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
  ...over,
});

const THREAD = [
  msg('u1', 'user', 'first'),
  msg('a1', 'assistant', 'fine'),
  msg('u2', 'user', 'plan my mornig'),
  msg('a2', 'assistant', 'Here is a plan'),
];
const VIA = { kind: 'conversation', id: 'c1' } as const;

let unseed = () => {};
beforeEach(() => {
  sendFrom.mockClear();
  unseed = seedAI(CONNECTED_MODEL);
});
afterEach(() => {
  cleanup();
  unseed();
});

describe('editableQuestionIndex', () => {
  it('is the latest question, whatever came after it', () => {
    expect(editableQuestionIndex(THREAD)).toBe(2);
    expect(editableQuestionIndex([...THREAD, msg('u3', 'user', 'and?')])).toBe(4);
    expect(editableQuestionIndex([msg('a0', 'assistant', 'hi')])).toBe(-1);
  });
});

describe('Edit', () => {
  it('is offered on the latest question only', () => {
    render(<TranscriptMessages messages={THREAD} typing={false} busy={false} retryVia={VIA} />);
    const edits = screen.getAllByTestId('chat-edit');
    expect(edits).toHaveLength(1);
    expect(edits[0].closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('u2');
  });

  it('sends the edited words as a new turn and keeps the question as it was', () => {
    render(<TranscriptMessages messages={THREAD} typing={false} busy={false} retryVia={VIA} />);
    fireEvent.click(screen.getByTestId('chat-edit'));
    const box = screen.getByLabelText('Edit your question') as HTMLTextAreaElement;
    expect(box.value).toBe('plan my mornig');
    fireEvent.change(box, { target: { value: 'plan my morning' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(sendFrom).toHaveBeenCalledWith(VIA, 'plan my morning');
    expect(screen.queryByTestId('chat-edit-box')).toBeNull();
    expect(screen.getByText('plan my mornig')).toBeTruthy();
    expect(screen.getByText('Here is a plan')).toBeTruthy();
  });

  it('puts it back on Escape or Cancel, sending nothing', () => {
    render(<TranscriptMessages messages={THREAD} typing={false} busy={false} retryVia={VIA} />);
    fireEvent.click(screen.getByTestId('chat-edit'));
    fireEvent.keyDown(screen.getByLabelText('Edit your question'), { key: 'Escape' });
    expect(screen.queryByTestId('chat-edit-box')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-edit'));
    fireEvent.click(screen.getByTestId('chat-edit-cancel'));
    expect(screen.queryByTestId('chat-edit-box')).toBeNull();
    expect(sendFrom).not.toHaveBeenCalled();
  });

  it('will not send an empty question, and Shift+Enter is a new line', () => {
    render(<TranscriptMessages messages={THREAD} typing={false} busy={false} retryVia={VIA} />);
    fireEvent.click(screen.getByTestId('chat-edit'));
    const box = screen.getByLabelText('Edit your question');
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect((screen.getByTestId('chat-edit-send') as HTMLButtonElement).disabled).toBe(true);
    expect(sendFrom).not.toHaveBeenCalled();
  });

  it('waits while a reply is arriving, needs a binding, and hides while nothing can answer', () => {
    const { rerender } = render(<TranscriptMessages messages={THREAD} typing={false} busy retryVia={VIA} />);
    expect(screen.queryByTestId('chat-edit')).toBeNull();
    rerender(<TranscriptMessages messages={THREAD} typing={false} busy={false} />);
    expect(screen.queryByTestId('chat-edit')).toBeNull();
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    rerender(<TranscriptMessages messages={THREAD} typing={false} busy={false} retryVia={VIA} />);
    expect(screen.queryByTestId('chat-edit')).toBeNull();
  });
});

describe('action lines', () => {
  it('show above a reply, one per lookup, and not on a reply without any', () => {
    render(
      <TranscriptMessages
        messages={[msg('u1', 'user', 'dentist?'), msg('a1', 'assistant', 'Thursday.', { actions: ['Looked for "dentist" (1 found)'] }), msg('u2', 'user', 'thanks'), msg('a2', 'assistant', 'Any time.')]}
        typing={false}
        busy={false}
      />
    );
    const lines = screen.getAllByTestId('chat-action');
    expect(lines.map((l) => l.textContent)).toEqual(['Looked for "dentist" (1 found)']);
    expect(screen.getByRole('list', { name: 'What the AI looked up' }).closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('a1');
  });
});
