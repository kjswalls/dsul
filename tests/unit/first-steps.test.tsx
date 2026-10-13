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
 * First steps (memory/plans/power-mode.md, round 5, S1): one question, then
 * a few steps from Break it down's path with step 1 lit, and "do it for me"
 * on both screens; a single step can be handed off on its own.
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

import { FirstSteps, openFirstSteps } from '@/components/sidebar/first-steps';
import { usePlannerStore } from '@/lib/planner-store';
import { useDoStuffStore } from '@/lib/do-stuff';
import { useProposalStore } from '@/lib/proposal-store';
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
    userId: 'user-1',
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
  summary: 'Three steps',
  operations: [
    { kind: 'create', itemType: 'task', title: 'find last year\'s return', parentItemId: 'big' },
    { kind: 'create', itemType: 'task', title: 'gather the W-2s', parentItemId: 'big' },
    { kind: 'create', itemType: 'task', title: 'book the accountant', parentItemId: 'big' },
  ],
} as unknown as Proposal;

const request = vi.fn(async () => {});

beforeEach(() => {
  seed(CONNECTED_MODEL);
  seedItems([BIG]);
  useDoStuffStore.setState({ firstSteps: null });
  useAgentsStore.setState({ agents: [{ assignee: 'Claude', name: 'Claude', kind: 'app' }] as never, loaded: true });
  request.mockClear();
  useProposalStore.setState({ status: 'idle', proposal: null, error: null, lastRequest: null, request } as never);
});
afterEach(() => {
  cleanup();
  unseed();
  unseed = () => {};
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

describe('first steps', () => {
  it('opens only where the AI can break the item down', () => {
    seed(NOTHING_CONNECTED);
    expect(openFirstSteps('big')).toBe(false);
    expect(useDoStuffStore.getState().firstSteps).toBeNull();
    seed(CONNECTED_MODEL);
    expect(openFirstSteps('big')).toBe(true);
    expect(useDoStuffStore.getState().firstSteps).toBe('big');
  });

  it('asks one thing first, and sends the answer with Break it down', () => {
    render(<FirstSteps />);
    act(() => void openFirstSteps('big'));
    expect(screen.getByText('Anything I should know first?')).toBeTruthy();
    fireEvent.change(screen.getByTestId('first-steps-answer'), { target: { value: 'the accountant is booked up' } });
    fireEvent.keyDown(screen.getByTestId('first-steps-answer'), { key: 'Enter' });
    expect(request).toHaveBeenCalledWith(
      'breakdown',
      'Break this into a few concrete steps. Something to know first: the accountant is booked up',
      'big'
    );
    expect(screen.getByTestId('first-steps-steps')).toBeTruthy();
  });

  it('asks plainly when there is nothing to know', () => {
    render(<FirstSteps />);
    act(() => void openFirstSteps('big'));
    fireEvent.click(screen.getByTestId('first-steps-get'));
    expect(request).toHaveBeenCalledWith('breakdown', undefined, 'big');
  });

  it('shows the steps with step 1 lit, and saves them as subtasks', () => {
    const accept = vi.fn(() => 3);
    useProposalStore.setState({ accept } as never);
    render(<FirstSteps />);
    act(() => void openFirstSteps('big'));
    fireEvent.click(screen.getByTestId('first-steps-get'));
    stepsArrive();
    const steps = screen.getAllByTestId('first-steps-step');
    expect(steps.map((s) => s.textContent)).toEqual([
      expect.stringContaining("find last year's return"),
      expect.stringContaining('gather the W-2s'),
      expect.stringContaining('book the accountant'),
    ]);
    expect(steps[0].getAttribute('data-first')).toBe('true');
    expect(steps[1].getAttribute('data-first')).toBeNull();
    fireEvent.click(screen.getByTestId('first-steps-save'));
    expect(accept).toHaveBeenCalledTimes(1);
    expect(useDoStuffStore.getState().firstSteps).toBeNull();
  });

  it('hands the whole item off from either screen', () => {
    render(<FirstSteps />);
    act(() => void openFirstSteps('big'));
    fireEvent.click(screen.getByTestId('first-steps-do-it-for-me'));
    expect(usePlannerStore.getState().items.find((i) => i.id === 'big')).toMatchObject({ assignee: 'Claude' });
    expect(useDoStuffStore.getState().firstSteps).toBeNull();
  });

  it('hands one step off on its own, after saving the steps', () => {
    // The real accept adds the subtasks; this one does it by hand.
    const accept = vi.fn(() => {
      const kids = STEPS.operations.map((op, i) =>
        task(`k${i}`, { title: (op as { title: string }).title, parentItemId: 'big' })
      );
      seedItems([BIG, ...kids]);
      return kids.length;
    });
    useProposalStore.setState({ accept } as never);
    render(<FirstSteps />);
    act(() => void openFirstSteps('big'));
    fireEvent.click(screen.getByTestId('first-steps-get'));
    stepsArrive();
    fireEvent.click(screen.getAllByTestId('first-steps-hand-off-step')[1]);
    const byId = new Map(usePlannerStore.getState().items.map((i) => [i.id, i as Record<string, unknown>]));
    expect(byId.get('k1')?.assignee).toBe('Claude');
    expect(byId.get('k0')?.assignee).toBeFalsy();
    expect(byId.get('big')?.assignee).toBeFalsy();
  });

  it('drops its steps when closed without saving, so the item panel never shows them', () => {
    const dismiss = vi.fn();
    useProposalStore.setState({ dismiss } as never);
    render(<FirstSteps />);
    act(() => void openFirstSteps('big'));
    fireEvent.click(screen.getByTestId('first-steps-get'));
    stepsArrive();
    act(() => useDoStuffStore.setState({ firstSteps: null }));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('offers no hand-off when there is no one to hand to', () => {
    useAgentsStore.setState({ agents: [], loaded: true });
    render(<FirstSteps />);
    act(() => void openFirstSteps('big'));
    expect(screen.queryByTestId('first-steps-do-it-for-me')).toBeNull();
  });
});
