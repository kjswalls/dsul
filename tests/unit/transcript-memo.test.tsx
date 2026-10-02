import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';

/**
 * The shared transcript re-parses only the reply that changed (review round
 * of AI step 2a, C3+C4: bugs-8). Every streamed delta replaces the thread's
 * messages array; the store keeps each untouched message's identity, so a
 * memoised Reply whose props did not change skips its markdown parse. Without
 * it a delta re-parsed every reply on screen, and a thread is 100 messages a
 * page and more with Load earlier.
 *
 * ReactMarkdown is counted, not replaced: the real parser still renders.
 */

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('react-markdown', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-markdown')>();
  const Counted = (props: Parameters<typeof real.default>[0]) => {
    calls.n += 1;
    return real.default(props);
  };
  return { ...real, default: Counted };
});

import { TranscriptMessages } from '@/components/ai/chat-transcript';
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

const THREAD: ChatMessage[] = [
  msg('u1', 'user', 'one'),
  msg('a1', 'assistant', 'First **reply**'),
  msg('u2', 'user', 'two'),
  msg('a2', 'assistant', 'Second reply'),
  msg('u3', 'user', 'three'),
  msg('a3', 'assistant', 'Thi', { status: 'streaming', sync: 'pending' }),
];

afterEach(() => cleanup());

describe('a streamed delta', () => {
  it('re-parses the reply it grew, not every reply in the thread', () => {
    const { rerender } = render(<TranscriptMessages messages={THREAD} typing={false} busy />);
    expect(calls.n).toBe(3);

    calls.n = 0;
    const grown = [...THREAD.slice(0, 5), { ...THREAD[5], content: 'Third' }];
    rerender(<TranscriptMessages messages={grown} typing={false} busy />);
    expect(calls.n).toBe(1);
  });

  it('hands `typing` to the reply still arriving only, so it moves no other reply', () => {
    const { rerender } = render(<TranscriptMessages messages={THREAD} typing={false} busy />);
    calls.n = 0;
    rerender(<TranscriptMessages messages={THREAD} typing busy />);
    expect(calls.n).toBe(1);
  });
});
