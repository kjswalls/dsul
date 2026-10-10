import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

/**
 * A conversation opened wide (app/chat/[id], AI step 2c): the same view Ask
 * pushes, on a page of its own, read cold from the server, behind the same
 * gate as Ask.
 */

const params = vi.hoisted(() => ({ id: '' }));
vi.mock('next/navigation', () => ({
  useParams: () => params,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/chat/${params.id}`,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn() }));

import ChatPage from '@/app/chat/[id]/page';
import { chatTransport } from '@/lib/chat-transport';
import { httpConversationsApi } from '@/lib/conversations-api';
import { clearChatState, configureConversations, conversationsSettled, useConversationsStore } from '@/lib/conversations-store';
import type { StoredMessage } from '@/lib/conversation-types';
import { seedAI, CONNECTED_MODEL, NOTHING_CONNECTED } from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, flush, summary, type FakeApi } from './helpers/conversations-fakes';

const ID = '2b0f3c9e-8d4a-4f61-9a7e-5c3d1e2f4a6b';
const ROW = summary({ id: ID, title: 'Lisbon in May', messageCount: 2 });
const MESSAGES: StoredMessage[] = [
  { id: 'm1', pos: 0, role: 'user', content: 'Where should we go?', status: 'complete', errorCode: null, replyTo: null, answerer: null, model: null, createdAt: '2026-10-02T09:00:00.000Z' },
  { id: 'm2', pos: 1, role: 'assistant', content: 'Lisbon.', status: 'complete', errorCode: null, replyTo: 'm1', answerer: 'model', model: null, createdAt: '2026-10-02T09:00:01.000Z' },
];

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

let api: FakeApi;
let unseed: () => void = () => {};

beforeEach(() => {
  api = fakeApi();
  configureConversations({ api: api.api, transport: fakeTransport().transport });
  clearChatState();
  useConversationsStore.setState({ saving: 'unknown' });
  params.id = ID;
});
afterEach(async () => {
  cleanup();
  await conversationsSettled();
  unseed();
  unseed = () => {};
  configureConversations({ api: httpConversationsApi, transport: chatTransport });
});

const settle = () => act(() => flush());

describe('the wide conversation page', () => {
  it('reads the conversation cold and shows it with its title and box', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    api.answer.thread = (id) => (id === ID ? { ok: true, value: { conversation: ROW, messages: MESSAGES, hasEarlier: false } } : undefined);
    render(<ChatPage />);
    await settle();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Lisbon in May');
    expect(screen.getByText('Lisbon.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /message/i })).toBeInTheDocument();
  });

  it('says a deleted one is gone, with no box to send from', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<ChatPage />);
    await settle();
    expect(screen.getByTestId('conversation-gone')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows nothing of it while nothing can answer, and fetches nothing', async () => {
    unseed = seedAI(NOTHING_CONNECTED);
    let asked = 0;
    api.answer.thread = () => {
      asked += 1;
      return undefined;
    };
    render(<ChatPage />);
    await settle();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('AI is off');
    expect(asked).toBe(0);
  });

  it('turns away a link that names no conversation', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    params.id = 'not-a-uuid';
    render(<ChatPage />);
    await settle();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Conversation not found');
  });
});
