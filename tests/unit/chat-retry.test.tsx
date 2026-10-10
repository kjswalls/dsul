import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { seedAI, CONNECTED_MODEL, NOTHING_CONNECTED } from './helpers/ai-fixtures';

/**
 * Try again under a reply that failed or was stopped: the same question sent
 * again as a new turn, through the conversation's own binding. Shown only where
 * asking again could go differently; a failure that needs something changed
 * first (a key, a model, the wording) gets no button, because the same words
 * would fail the same way.
 */

const sendFrom = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/lib/open-chat', () => ({ sendFrom }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => {} }));

import { retryQuestion, TranscriptMessages } from '@/components/ai/chat-transcript';
import { isRetryableReplyError } from '@/lib/chat-errors';
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

const failed = (code: string): ChatMessage[] => [
  msg('u1', 'user', 'first'),
  msg('a1', 'assistant', 'fine'),
  msg('u2', 'user', 'what next?'),
  msg('a2', 'assistant', '', { status: 'error', errorCode: code as ChatMessage['errorCode'], replyTo: 'u2' }),
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

describe('isRetryableReplyError', () => {
  it.each(['rate_limit', 'upstream', 'timeout', 'network', 'server', 'plugin_error', 'no_response', 'client'])(
    '%s may go differently next time',
    (code) => expect(isRetryableReplyError(code)).toBe(true)
  );

  it.each(['auth', 'quota', 'bad_model', 'bad_request', 'refused', 'empty', 'daily_limit', 'region', 'too_large'])(
    '%s needs something changed first',
    (code) => expect(isRetryableReplyError(code)).toBe(false)
  );
});

describe('retryQuestion', () => {
  it('is the question the failed reply answered', () => {
    expect(retryQuestion(failed('timeout'))).toBe('what next?');
  });

  it('is the question under a stopped reply, whatever was kept of it', () => {
    const thread = [msg('u1', 'user', 'tell me'), msg('a1', 'assistant', 'Par', { status: 'stopped' })];
    expect(retryQuestion(thread)).toBe('tell me');
  });

  it('is null under a reply that failed for good, finished, or is still arriving', () => {
    expect(retryQuestion(failed('auth'))).toBeNull();
    expect(retryQuestion([msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'hello')])).toBeNull();
    expect(retryQuestion([msg('u1', 'user', 'hi'), msg('a1', 'assistant', '', { status: 'streaming' })])).toBeNull();
  });

  it('is null when the last message is a question with no reply (a stop before the first word)', () => {
    expect(retryQuestion([msg('u1', 'user', 'hi')])).toBeNull();
  });

  it('only looks at the latest reply', () => {
    const thread = [...failed('timeout'), msg('u3', 'user', 'again'), msg('a3', 'assistant', 'done')];
    expect(retryQuestion(thread)).toBeNull();
  });
});

describe('the Try again button', () => {
  it('sends the same question again through the conversation’s own binding', () => {
    render(<TranscriptMessages messages={failed('upstream')} typing={false} busy={false} retryVia={VIA} />);
    fireEvent.click(screen.getByTestId('chat-retry'));
    expect(sendFrom).toHaveBeenCalledWith(VIA, 'what next?');
  });

  it('is not offered under a failure the same words would hit again', () => {
    render(<TranscriptMessages messages={failed('bad_model')} typing={false} busy={false} retryVia={VIA} />);
    expect(screen.queryByTestId('chat-retry')).toBeNull();
  });

  it('waits while the conversation is busy, and needs a binding to send through', () => {
    const { rerender } = render(<TranscriptMessages messages={failed('timeout')} typing={false} busy retryVia={VIA} />);
    expect(screen.queryByTestId('chat-retry')).toBeNull();
    rerender(<TranscriptMessages messages={failed('timeout')} typing={false} busy={false} />);
    expect(screen.queryByTestId('chat-retry')).toBeNull();
  });

  it('hides while nothing can answer', () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    render(<TranscriptMessages messages={failed('timeout')} typing={false} busy={false} retryVia={VIA} />);
    expect(screen.queryByTestId('chat-retry')).toBeNull();
  });
});
