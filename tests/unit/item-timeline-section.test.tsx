import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const fetchItemEvents = vi.fn();
const eventsAvailable = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  fetchItemEvents: (...args: unknown[]) => fetchItemEvents(...args),
  getItemEventsAvailable: () => eventsAvailable.value,
}));

// The session client, as the item's files read it: rows for a list, a signed
// URL per picture.
const filesDb = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], signed: [] as unknown[] }));
// The item's notes (082): null is a database without the table, as before 082 is applied.
const notesDb = vi.hoisted(() => ({ rows: null as Record<string, unknown>[] | null }));
vi.mock('@/lib/supabase', () => ({
  createClient: () => {
    const b = {
      select: () => b,
      eq: () => b,
      order: () => b,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: filesDb.rows, error: null }).then(resolve),
    };
    const n = {
      select: () => n,
      eq: () => n,
      order: () => n,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(
          notesDb.rows ? { data: notesDb.rows, error: null } : { data: null, error: { code: '42P01' } }
        ).then(resolve),
    };
    return {
      from: (table: string) => (table === 'item_notes' ? n : b),
      storage: {
        from: () => ({
          createSignedUrls: async (paths: string[], ttl: number) => (
            filesDb.signed.push([paths, ttl]),
            { data: paths.map((path) => ({ path, signedUrl: `https://files.test/${path}`, error: null })), error: null }
          ),
        }),
      },
    };
  },
}));

import { ItemTimeline } from '@/components/planner/item-timeline';
import { ItemConversation } from '@/components/ai/item-conversation';
import { useConversationsStore, clearChatState } from '@/lib/conversations-store';
import { useItemFilesStore } from '@/lib/item-files-store';
import { clearItemNotesState } from '@/lib/item-notes-store';
import { useRailStore } from '@/lib/rail-store';
import { usePlannerStore } from '@/lib/planner-store';
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
  eventsAvailable.value = true;
  filesDb.rows = [];
  filesDb.signed = [];
  notesDb.rows = null;
  clearItemNotesState();
  useRailStore.getState().reset();
  usePlannerStore.setState({ items: [] } as never);
  useItemFilesStore.setState({ available: null, byItem: {}, uploading: {}, placedAt: {}, thumbs: {}, thumbFails: {} });
});

const fileRow = (id: string, at: Date, over: Record<string, unknown> = {}) => ({
  id,
  item_id: 'i1',
  name: `${id}.pdf`,
  mime: 'application/pdf',
  size: 2048,
  created_at: at.toISOString(),
  added_by: null,
  ...over,
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

describe('files on the timeline', () => {
  const pinned = async () => {
    useConversationsStore.setState({ resolveItemThread: async () => 'c1', openThread: async () => {} } as never);
    render(<ItemConversation item={ITEM} mode="pinned" />);
    await act(async () => {});
    await act(async () => {});
  };

  it('sets a file between the messages by time, as you attaching it', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    fetchItemEvents.mockResolvedValue([]);
    filesDb.rows = [fileRow('a', new Date(today(9).getTime() + 500))];
    withThread();
    await pinned();
    const text = screen.getByTestId('item-conversation').textContent ?? '';
    const order = ['hi', 'You attached a.pdf', 'hello'].map((t) => text.indexOf(t));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(screen.getByTestId('item-file-card')).toHaveAttribute('data-kind', 'file');
    expect(screen.getByTestId('item-file-card')).toHaveTextContent('PDF · 2 KB');
    // Its own row, never counted as a change.
    expect(screen.queryAllByTestId('item-timeline-change')).toHaveLength(0);
    // Talk and Changes show it too.
    fireEvent.click(screen.getByTestId('item-timeline-filter-changes'));
    expect(screen.getByTestId('item-timeline-file')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('item-timeline-filter-talk'));
    expect(screen.getByTestId('item-timeline-file')).toBeInTheDocument();
  });

  it('shows the timeline for an item whose only history is a file, under Talk too', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    fetchItemEvents.mockResolvedValue([]);
    filesDb.rows = [fileRow('a', today(9))];
    await pinned();
    expect(screen.getByTestId('item-conversation')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('item-timeline-filter-talk'));
    expect(screen.queryByTestId('item-timeline-empty')).toBeNull();
    expect(screen.getByTestId('item-timeline-file')).toBeInTheDocument();
  });

  it('names the agent that attached it', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    fetchItemEvents.mockResolvedValue([]);
    filesDb.rows = [fileRow('Draft return', today(9), { added_by: 'openclaw' })];
    await pinned();
    expect(screen.getByTestId('item-timeline-file')).toHaveTextContent('OpenClaw attached Draft return.pdf');
    expect(screen.getByTestId('item-timeline-file')).toHaveAttribute('data-by', 'agent');
  });

  it('draws a picture through a short-lived signed link, and falls back to the card when it will not load', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    usePlannerStore.setState({ userId: 'u1' } as never);
    fetchItemEvents.mockResolvedValue([]);
    filesDb.rows = [fileRow('cat', today(9), { name: 'cat.png', mime: 'image/png' })];
    await pinned();
    const img = screen.getByRole('img', { name: 'cat.png' });
    expect(img).toHaveAttribute('src', 'https://files.test/u1/cat');
    expect(filesDb.signed[0]).toEqual([['u1/cat'], 600]);
    expect(screen.getByTestId('item-file-card')).toHaveAttribute('data-kind', 'image');
    // Signed again once, then the card.
    await act(async () => {
      fireEvent.error(img);
    });
    await act(async () => {
      fireEvent.error(screen.getByRole('img', { name: 'cat.png' }));
    });
    expect(screen.queryByRole('img', { name: 'cat.png' })).toBeNull();
    expect(screen.getByTestId('item-file-card')).toHaveAttribute('data-kind', 'file');
  });

  it('is on the timeline without AI, and still there when item_events is not', async () => {
    unseed = seedAI(NOTHING_CONNECTED);
    eventsAvailable.value = false;
    fetchItemEvents.mockResolvedValue([]);
    filesDb.rows = [fileRow('a', today(9))];
    render(<ItemTimeline item={ITEM} />);
    await act(async () => {});
    await act(async () => {});
    expect(screen.getByTestId('item-timeline-file')).toHaveTextContent('You attached a.pdf');
    expect(screen.getByTestId('item-file-card')).toBeInTheDocument();
  });
});

const noteRow = (id: string, at: Date, over: Record<string, unknown> = {}) => ({
  id,
  item_id: 'i1',
  body: `Note ${id}`,
  pinned_at: null,
  edited_at: null,
  created_at: at.toISOString(),
  ...over,
});

describe('notes on the timeline', () => {
  const conversation = async (mode: 'pinned' | 'inline' = 'pinned', extra: Record<string, unknown> = {}) => {
    useConversationsStore.setState({ resolveItemThread: async () => 'c1', openThread: async () => {} } as never);
    render(<ItemConversation item={ITEM} mode={mode} {...extra} />);
    await act(async () => {});
    await act(async () => {});
  };

  it('sets a note between the messages by time', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    fetchItemEvents.mockResolvedValue([]);
    notesDb.rows = [noteRow('a', new Date(today(9).getTime() + 500))];
    withThread();
    await conversation();
    const text = screen.getByTestId('item-conversation').textContent ?? '';
    const order = ['hi', 'Note a', 'hello'].map((t) => text.indexOf(t));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(screen.getByTestId('item-timeline-note')).toHaveTextContent('You · note');
  });

  it('draws the pinned card under every filter', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    fetchItemEvents.mockResolvedValue(events);
    notesDb.rows = [noteRow('p', today(7), { pinned_at: today(8).toISOString() })];
    withThread();
    await conversation();
    for (const f of ['all', 'talk', 'changes']) {
      fireEvent.click(screen.getByTestId(`item-timeline-filter-${f}`));
      expect(screen.getByTestId('item-note-pinned')).toHaveTextContent('Note · pinned');
      expect(screen.getByTestId('item-note-pinned')).toHaveTextContent('Note p');
      // Drawn on top, never also in the stream.
      expect(screen.queryByTestId('item-timeline-note')).toBeNull();
    }
  });

  it('shows the conversation for an item whose only history is a pinned note', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    fetchItemEvents.mockResolvedValue([]);
    notesDb.rows = [noteRow('p', today(7), { pinned_at: today(8).toISOString() })];
    await conversation();
    expect(screen.getByTestId('item-conversation')).toBeInTheDocument();
    expect(screen.getByTestId('item-note-pinned')).toBeInTheDocument();
  });

  it('shows a note under Talk with no messages, not the empty line', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    fetchItemEvents.mockResolvedValue([]);
    notesDb.rows = [noteRow('a', today(9))];
    await conversation();
    fireEvent.click(screen.getByTestId('item-timeline-filter-talk'));
    expect(screen.queryByTestId('item-timeline-empty')).toBeNull();
    expect(screen.getByTestId('item-timeline-note')).toBeInTheDocument();
  });

  it('in note mode, the inline box draws no agent route line and saves mid-reply', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    fetchItemEvents.mockResolvedValue([]);
    notesDb.rows = [];
    const held = { ...ITEM, assignee: 'openclaw', aiStatus: 'blocked' } as TaskItem;
    usePlannerStore.setState({ items: [held] } as never);
    useConversationsStore.setState((s) => ({ sending: { ...s.sending, 'item:i1': true } }) as never);
    await conversation('inline');
    expect(screen.getByTestId('agent-route-line')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('box-mode-note'));
    expect(screen.queryByTestId('agent-route-line')).toBeNull();
    expect(screen.getByTestId('note-mode-line')).toHaveTextContent(
      'Saved on this item. Not sent to the AI or OpenClaw.'
    );
    const input = screen.getByTestId('item-thread-input');
    expect(input).toHaveAttribute('placeholder', 'Add a note…');
    fireEvent.change(input, { target: { value: 'remember the form' } });
    expect(screen.getByRole('button', { name: 'Save note' })).toBeEnabled();
  });

  it('draws no switch where the host says so (the Do stuff desk)', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    fetchItemEvents.mockResolvedValue([]);
    notesDb.rows = [];
    await conversation('inline', { noteSwitch: false });
    expect(screen.queryByTestId('box-mode-ask')).toBeNull();
    expect(screen.queryByTestId('box-mode-note')).toBeNull();
  });
});
