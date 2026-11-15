import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }),
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));

import { ItemBoxAsks } from '@/components/planner/item-box-asks';
import { usePlannerStore } from '@/lib/planner-store';
import { useAgentsStore } from '@/lib/agents-store';
import { useConversationsStore } from '@/lib/conversations-store';
import { useProposalStore } from '@/lib/proposal-store';
import type { Item, TaskItem } from '@/lib/planner-types';
import { CONNECTED_MODEL, OPENCLAW_CHAT, seedAI } from './helpers/ai-fixtures';

beforeAll(() => {
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const TASK = {
  type: 'task',
  id: 'item-1',
  title: 'Book the dentist',
  status: 'pending',
  isScheduled: false,
  order: 0,
  completedDates: [],
} as unknown as TaskItem;

const updateTask = vi.fn();
let unseed: () => void = () => {};

beforeEach(() => {
  useAgentsStore.setState({ agents: [], loaded: true });
  useConversationsStore.setState({ itemIndex: {} });
  useProposalStore.getState().dismiss();
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: 'UTC',
    items: [TASK],
    routines: [],
    seasons: [],
    goals: [],
    updateTask,
  });
  updateTask.mockClear();
});
afterEach(() => {
  cleanup();
  unseed();
  unseed = () => {};
});

const show = (item: Item = TASK) => {
  usePlannerStore.setState({ items: [item] });
  return render(<ItemBoxAsks item={item} />);
};
const chipTexts = () =>
  Array.from(screen.queryByTestId('item-box-asks')?.querySelectorAll('button') ?? []).map((b) =>
    // The agent's face is an aria-hidden initial; read what a person hears.
    Array.from(b.childNodes)
      .filter((n) => !(n instanceof HTMLElement && n.getAttribute('aria-hidden')))
      .map((n) => n.textContent)
      .join('')
  );

describe('the chips over the item box', () => {
  it('offers a new task its starters, from the same list as right-click › AI', () => {
    unseed = seedAI(CONNECTED_MODEL);
    show();
    expect(chipTexts()).toEqual(['Break it down', 'Help me start', 'Find a time']);
  });

  it('shows nothing once the item has a conversation', () => {
    unseed = seedAI(CONNECTED_MODEL);
    useConversationsStore.setState({ itemIndex: { 'item-1': 'conv-1' } });
    show();
    expect(screen.queryByTestId('item-box-asks')).toBeNull();
  });

  it('shows nothing while an agent holds the item', () => {
    unseed = seedAI(OPENCLAW_CHAT);
    show({ ...TASK, assignee: 'openclaw', aiStatus: 'queued' } as TaskItem);
    expect(screen.queryByTestId('item-box-asks')).toBeNull();
  });

  it('hands off to the one agent there is, by name', () => {
    unseed = seedAI(OPENCLAW_CHAT);
    show();
    const chip = screen.getByTestId('assign-agent');
    expect(chip).toHaveTextContent('Hand off to OpenClaw');
    fireEvent.click(chip);
    expect(updateTask).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ assignee: 'openclaw', aiStatus: 'queued' }),
      expect.anything()
    );
  });

  it('asks who, when more than one agent could take it', () => {
    unseed = seedAI(OPENCLAW_CHAT);
    useAgentsStore.setState({ agents: [{ assignee: 'claude', name: 'Claude', kind: 'app' }] as never, loaded: true });
    show();
    expect(screen.getByTestId('assign-agent')).toHaveTextContent(/^Hand off$/);
  });

  it('never offers a repeating task to an agent, which would never pick it up again', () => {
    unseed = seedAI(OPENCLAW_CHAT);
    show({ ...TASK, repeatFrequency: 'daily' } as unknown as TaskItem);
    expect(screen.queryByTestId('assign-agent')).toBeNull();
  });

  it('keeps to three chips with the hand-off among them', () => {
    unseed = seedAI({ ...CONNECTED_MODEL, openclaw: { agent: true, agentId: 'a' } });
    show();
    expect(chipTexts()).toEqual(['Break it down', 'Help me start', 'Hand off to OpenClaw']);
  });
});
