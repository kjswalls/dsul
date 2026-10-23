import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const fetchItemEvents = vi.fn();
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  fetchItemEvents: (...args: unknown[]) => fetchItemEvents(...args),
  getItemEventsAvailable: () => true,
}));

import { ItemTimeline } from '@/components/planner/item-timeline';
import { ItemConversation } from '@/components/ai/item-conversation';
import { useConversationsStore, clearChatState } from '@/lib/conversations-store';
import { seedAI, CONNECTED_MODEL, NOTHING_CONNECTED } from './helpers/ai-fixtures';
import type { TaskItem } from '@/lib/planner-types';

/**
 * The item's timeline in the panel: changes with who made them, a day's talk
 * as one line with AI on, the filter, and nothing at all for an item with no
 * history.
 */

const ITEM: TaskItem = { type: 'task', id: 'i1', title: 'Call the dentist', status: 'pending', isScheduled: false, order: 0 };
const today = (h: number) => new Date(new Date().setHours(h, 0, 0, 0));

let unseed = () => {};
afterEach(() => {
  cleanup();
  unseed();
  fetchItemEvents.mockReset();
  clearChatState();
});

function withThread() {
  useConversationsStore.setState((s) => ({
    itemIndex: { ...s.itemIndex, i1: 'c1' },
    threads: {
      ...s.threads,
      c1: {
        id: 'c1',
        itemId: 'i1',
        messages: [
          { id: 'm1', role: 'user', content: 'hi', createdAt: today(9).getTime(), answerer: null },
          { id: 'm2', role: 'assistant', content: 'hello', createdAt: today(9).getTime() + 1000, answerer: 'model' },
        ],
      },
    } as never,
  }));
}

const events = [
  { id: 'e1', itemId: 'i1', itemType: 'task', action: 'create', payload: { title: 'x' }, createdAt: today(8).toISOString() },
  { id: 'e2', itemId: 'i1', itemType: 'task', action: 'update', payload: { title: 'Call the dentist', by: 'ai' }, createdAt: today(10).toISOString() },
];

describe('the timeline', () => {
  it('lists changes with who made them, and folds the day’s talk to one line', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    fetchItemEvents.mockResolvedValue(events);
    withThread();
    render(<ItemTimeline item={ITEM} />);
    await act(async () => {});
    const changes = screen.getAllByTestId('item-timeline-change');
    expect(changes.map((c) => c.getAttribute('data-by'))).toEqual(['you', 'ai']);
    expect(changes[1]).toHaveTextContent('AI renamed it “Call the dentist”');
    expect(screen.getByTestId('item-timeline-talk')).toHaveTextContent('You and the AI talked it through · 2 messages');
    fireEvent.click(screen.getByTestId('item-timeline-filter-changes'));
    expect(screen.queryByTestId('item-timeline-talk')).toBeNull();
    fireEvent.click(screen.getByTestId('item-timeline-filter-talk'));
    expect(screen.queryAllByTestId('item-timeline-change')).toHaveLength(0);
  });

  it('shows changes alone, with no filter and no talk, without AI', async () => {
    unseed = seedAI(NOTHING_CONNECTED);
    fetchItemEvents.mockResolvedValue(events);
    withThread();
    render(<ItemTimeline item={ITEM} />);
    await act(async () => {});
    expect(screen.getAllByTestId('item-timeline-change')).toHaveLength(2);
    expect(screen.queryByTestId('item-timeline-talk')).toBeNull();
    expect(screen.queryByTestId('item-timeline-filter-all')).toBeNull();
  });

  it('draws nothing for an item with no history', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    fetchItemEvents.mockResolvedValue([]);
    const { container } = render(<ItemTimeline item={ITEM} />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it('folds a long history to its newest three, and opens it again', async () => {
    unseed = seedAI(NOTHING_CONNECTED);
    fetchItemEvents.mockResolvedValue(
      ['high', 'low', 'medium', 'high', 'low', 'none'].map((priority, n) => ({
        id: `p${n}`,
        itemId: 'i1',
        itemType: 'task',
        action: 'update',
        payload: { priority },
        createdAt: today(1 + 2 * n).toISOString(),
      }))
    );
    render(<ItemTimeline item={ITEM} />);
    await act(async () => {});
    expect(screen.getAllByTestId('item-timeline-change')).toHaveLength(3);
    fireEvent.click(screen.getByTestId('item-timeline-fold'));
    expect(screen.getAllByTestId('item-timeline-change')).toHaveLength(6);
  });
});

describe('the timeline inside the conversation', () => {
  it('is one stream: each change sits between the messages by time, and no second timeline', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    fetchItemEvents.mockResolvedValue(events);
    withThread();
    useConversationsStore.setState({ resolveItemThread: async () => 'c1', openThread: async () => {} } as never);
    render(<ItemConversation item={ITEM} mode="pinned" />);
    await act(async () => {});
    const section = screen.getByTestId('item-conversation');
    expect(section).toHaveTextContent(/^Timeline/);
    const text = section.textContent ?? '';
    const order = ['You added it', 'hi', 'hello', 'AI renamed it'].map((t) => text.indexOf(t));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(screen.queryByTestId('item-timeline-talk')).toBeNull();
    fireEvent.click(screen.getByTestId('item-timeline-filter-changes'));
    expect(section).not.toHaveTextContent('hello');
    expect(screen.getAllByTestId('item-timeline-change')).toHaveLength(2);
  });
});
