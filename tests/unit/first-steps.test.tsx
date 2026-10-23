import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

// RelayField (the braindump's empty-state backdrop) reads prefers-reduced-motion.
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

/**
 * First steps with one home (Kirby's pick, 2026-10-23): opening them opens
 * the item, and the AI's steps are drafted rows in its Subtasks
 * (components/planner/drafted-steps.tsx), kept, edited, handed off or dropped
 * there, with an inline Undo instead of a toast.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  createItemType: vi.fn(async () => {}),
  updateItemType: vi.fn(async () => {}),
  deleteItemType: vi.fn(async () => {}),
  createItem: vi.fn(async () => {}),
  updateItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  restoreItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  createProject: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  deleteProject: vi.fn(async () => {}),
  restoreProject: vi.fn(async () => {}),
  fetchRoutines: vi.fn(async () => []),
  createRoutine: vi.fn(async () => {}),
  updateRoutine: vi.fn(async () => {}),
  deleteRoutine: vi.fn(async () => {}),
  restoreRoutine: vi.fn(async () => {}),
  fetchSeasons: vi.fn(async () => []),
  createSeason: vi.fn(async () => {}),
  updateSeason: vi.fn(async () => {}),
  deleteSeason: vi.fn(async () => {}),
  restoreSeason: vi.fn(async () => {}),
  fetchGoals: vi.fn(async () => []),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));
const showItemSteps = vi.hoisted(() => vi.fn());
vi.mock('@/lib/open-chat', () => ({ showItemSteps }));

import { openFirstSteps } from '@/components/sidebar/first-steps';
import { DraftedSteps } from '@/components/planner/drafted-steps';
import { usePlannerStore } from '@/lib/planner-store';
import { useProposalStore } from '@/lib/proposal-store';
import { usePrepPacksStore } from '@/lib/prep-packs-store';
import { useAgentsStore } from '@/lib/agents-store';
import type { Item, Proposal } from '@/lib/planner-types';
import { seedAI, CONNECTED_MODEL, NOTHING_CONNECTED, type SeedAI } from './helpers/ai-fixtures';

const task = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    type: 'task',
    id,
    title: `Task ${id}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
    ...extra,
  }) as unknown as Item;

const BIG = task('big', { title: 'sort out taxes' });

function seedItems(items: Item[]) {
  usePlannerStore.setState({
    userId: null,
    isLoading: false,
    error: null,
    userTimezone: 'UTC',
    items,
    tasks: items as never,
    habits: [],
    projects: [],
    routines: [],
    seasons: [],
    goals: [],
  });
}

let unseed: () => void = () => {};
const seed = (o?: SeedAI) => {
  unseed();
  unseed = seedAI(o);
};

const STEPS: Proposal = {
  id: 'p1',
  summary: 'Three steps',
  operations: [
    { kind: 'create', itemType: 'task', title: "find last year's return", parentItemId: 'big' },
    { kind: 'create', itemType: 'task', title: 'gather the W-2s', parentItemId: 'big' },
    { kind: 'create', itemType: 'task', title: 'book the accountant', parentItemId: 'big' },
  ],
} as unknown as Proposal;

const request = vi.fn(async () => {});
const dismiss = vi.fn(() => useProposalStore.setState({ status: 'idle', proposal: null, lastRequest: null } as never));

beforeEach(() => {
  seed(CONNECTED_MODEL);
  seedItems([BIG]);
  useAgentsStore.setState({ agents: [{ assignee: 'Claude', name: 'Claude', kind: 'app' }] as never, loaded: true });
  request.mockClear();
  dismiss.mockClear();
  showItemSteps.mockClear();
  useProposalStore.setState({ status: 'idle', proposal: null, error: null, lastRequest: null, request, dismiss } as never);
  usePrepPacksStore.setState({ packs: {}, available: true, preparing: {}, tried: {} });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});
afterEach(() => {
  cleanup();
  unseed();
  unseed = () => {};
  vi.unstubAllGlobals();
});

/** What the store looks like once the steps have come back for BIG. */
const stepsArrive = () =>
  act(() => {
    useProposalStore.setState({
      status: 'ready',
      proposal: STEPS,
      lastRequest: { intent: 'breakdown', itemId: 'big', surface: 'item:big' },
    } as never);
  });

const kids = () =>
  usePlannerStore
    .getState()
    .items.filter((i) => (i as { parentItemId?: string }).parentItemId === 'big') as (Item & { assignee?: string })[];
const rows = () => screen.getAllByTestId('drafted-step');
const titles = () => rows().map((r) => (r.querySelector('input') as HTMLInputElement).value);

describe('first steps', () => {
  it('opens only where the AI can break the item down, and opens the item', () => {
    seed(NOTHING_CONNECTED);
    expect(openFirstSteps('big')).toBe(false);
    expect(showItemSteps).not.toHaveBeenCalled();
    seed(CONNECTED_MODEL);
    expect(openFirstSteps('big')).toBe(true);
    expect(showItemSteps).toHaveBeenCalledWith(expect.objectContaining({ id: 'big' }), { ask: true });
  });

  it('asks for nothing when a steps pack is already drafted', () => {
    usePrepPacksStore.setState({
      packs: {
        big: { itemId: 'big', madeFor: 'sort out taxes', updatedAt: 't1', pack: { kind: 'steps', steps: ['a', 'b'] } },
      },
    });
    expect(openFirstSteps('big')).toBe(true);
    expect(showItemSteps).toHaveBeenCalledWith(expect.anything(), { ask: false });
  });
});

describe('drafted steps', () => {
  it('shows a breakdown as rows, step 1 lit, and keeps them all as subtasks', () => {
    render(<DraftedSteps item={BIG} />);
    stepsArrive();
    expect(titles()).toEqual(["find last year's return", 'gather the W-2s', 'book the accountant']);
    expect(rows()[0].getAttribute('data-first')).toBe('true');
    expect(rows()[1].getAttribute('data-first')).toBeNull();
    fireEvent.click(screen.getByTestId('drafted-steps-keep-all'));
    expect(kids().map((k) => k.title)).toEqual(["find last year's return", 'gather the W-2s', 'book the accountant']);
    expect(screen.queryAllByTestId('drafted-step')).toHaveLength(0);
    expect(screen.getByTestId('drafted-steps-note').textContent).toContain('3 subtasks added');
    expect(dismiss).toHaveBeenCalled();
  });

  it('undoes Keep all from the inline line, taking the subtasks back', () => {
    render(<DraftedSteps item={BIG} />);
    stepsArrive();
    fireEvent.click(screen.getByTestId('drafted-steps-keep-all'));
    fireEvent.click(screen.getByTestId('drafted-steps-undo'));
    expect(kids()).toHaveLength(0);
    expect(titles()).toHaveLength(3);
  });

  it('keeps one row, as edited, on Enter', () => {
    render(<DraftedSteps item={BIG} />);
    stepsArrive();
    const input = rows()[1].querySelector('input')!;
    fireEvent.change(input, { target: { value: 'gather the W-2s and 1099s' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(kids().map((k) => k.title)).toEqual(['gather the W-2s and 1099s']);
    expect(titles()).toEqual(["find last year's return", 'book the accountant']);
  });

  it('drops a row, and Undo puts it back', () => {
    render(<DraftedSteps item={BIG} />);
    stepsArrive();
    fireEvent.click(screen.getAllByTestId('drafted-step-drop')[0]);
    expect(titles()).toEqual(['gather the W-2s', 'book the accountant']);
    fireEvent.click(screen.getByTestId('drafted-steps-undo'));
    expect(titles()).toHaveLength(3);
    expect(kids()).toHaveLength(0);
  });

  it('hands one step off on its own', () => {
    render(<DraftedSteps item={BIG} />);
    stepsArrive();
    fireEvent.click(screen.getAllByTestId('drafted-step-hand-off')[1]);
    expect(kids()).toEqual([expect.objectContaining({ title: 'gather the W-2s', assignee: 'Claude' })]);
    expect(usePlannerStore.getState().items.find((i) => i.id === 'big')).not.toHaveProperty('assignee', 'Claude');
  });

  it('offers no hand-off when there is no one to hand to', () => {
    useAgentsStore.setState({ agents: [], loaded: true });
    render(<DraftedSteps item={BIG} />);
    stepsArrive();
    expect(screen.queryByTestId('drafted-step-hand-off')).toBeNull();
  });

  it('draws a steps pack the same way, and Clear can be undone', () => {
    usePrepPacksStore.setState({
      packs: {
        big: { itemId: 'big', madeFor: 'sort out taxes', updatedAt: 't1', pack: { kind: 'subtasks', subtasks: ['one', 'two'] } },
      },
    });
    render(<DraftedSteps item={BIG} />);
    expect(titles()).toEqual(['one', 'two']);
    fireEvent.click(screen.getByTestId('drafted-steps-clear'));
    expect(screen.queryAllByTestId('drafted-step')).toHaveLength(0);
    expect(usePrepPacksStore.getState().packs.big).toBeUndefined();
    fireEvent.click(screen.getByTestId('drafted-steps-undo'));
    expect(titles()).toEqual(['one', 'two']);
    expect(usePrepPacksStore.getState().packs.big).toBeDefined();
  });

  it('asks again with a note', () => {
    render(<DraftedSteps item={BIG} />);
    stepsArrive();
    fireEvent.click(screen.getByTestId('drafted-steps-redo'));
    const note = screen.getByTestId('drafted-steps-redo-note');
    fireEvent.change(note, { target: { value: 'the accountant is booked up' } });
    fireEvent.submit(note.closest('form')!);
    expect(request).toHaveBeenCalledWith(
      'breakdown',
      'Break this into a few concrete steps. Something to know first: the accountant is booked up',
      'big'
    );
  });

  it('drops a breakdown it owns when the panel closes', () => {
    const { unmount } = render(<DraftedSteps item={BIG} />);
    stepsArrive();
    unmount();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});
