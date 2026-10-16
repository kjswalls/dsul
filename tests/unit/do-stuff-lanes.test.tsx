import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

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
 * Do stuff's plan in lanes, mounted in the real Braindump: the key shuffles
 * the list into lanes, nothing shows on a row at rest, the number keys move
 * the row under the pointer, and "make it so" puts the calendar lane on its
 * days (memory/plans/power-mode.md, build order 2).
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

import { Braindump } from '@/components/sidebar/braindump';
import { usePlannerStore } from '@/lib/planner-store';
import { useDoStuffStore } from '@/lib/do-stuff';
import { usePrepPacksStore } from '@/lib/prep-packs-store';
import { useAgentsStore } from '@/lib/agents-store';
import { useViewStore } from '@/lib/view-store';
import { useKeyboardShortcutsStore } from '@/lib/keyboard-shortcuts-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import type { Item } from '@/lib/planner-types';
import { enableExtensions } from './support/extensions';
import { EXT_DO_STUFF } from '@/lib/extension-registry';

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

function seed(items: Item[], state: Record<string, unknown> = {}) {
  usePlannerStore.setState({
    userId: 'user-1',
    isLoading: false,
    error: null,
    userTimezone: 'UTC',
    items,
    tasks: items as never,
    habits: [],
    projects: [
      { id: 'p1', name: 'Work', emoji: '💼' },
      { id: 'p2', name: 'Home', emoji: '🏠' },
    ],
    routines: [],
    seasons: [],
    goals: [],
    ...state,
  });
  useViewStore.setState({
    braindumpGroupBy: 'none',
    braindumpSortBy: 'default',
    braindumpFilters: EMPTY_VIEW_FILTERS,
  });
}

const renderBraindump = () =>
  render(
    <DndContext>
      <Braindump />
    </DndContext>
  );

const SIX = [
  task('a', { title: 'email the landlord' }),
  task('b', { title: 'call the dentist' }),
  task('c', { title: 'pick up stamps' }),
  task('d', { title: 'declutter the garage' }),
  task('e', { title: 'figure out the budget' }),
  task('f', { title: 'zebra' }),
];

// The lanes fold to peeks while doing stuff (L1); these tests read every lane.
const unfold = () => {
  for (const peek of screen.queryAllByTestId(/^do-stuff-peek-/)) fireEvent.click(peek);
};

const laneOfRow = (title: string) => {
  unfold();
  return screen.getByText(title).closest('[data-lane]')?.getAttribute('data-lane');
};

beforeEach(() => {
  enableExtensions(EXT_DO_STUFF);
  useKeyboardShortcutsStore.setState({ overrides: {} });
  useDoStuffStore.getState().stop();
  usePrepPacksStore.setState({ userId: 'user-1', packs: {}, loaded: true, available: true, preparing: {}, tried: {}, error: null });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  useAgentsStore.setState({ agents: [], loaded: false });
});
afterEach(cleanup);

describe('do stuff: the plan in lanes', () => {
  it('draws nothing on the rows at rest', () => {
    seed(SIX);
    renderBraindump();
    expect(screen.getByTestId('do-stuff-start')).toBeInTheDocument();
    expect(screen.queryByTestId('item-size-button')).toBeNull();
    expect(screen.queryByTestId('do-stuff-lane-chip')).toBeNull();
  });

  it('sorts the list into lanes by the rules and lifts the next thing', () => {
    seed(SIX);
    renderBraindump();
    fireEvent.click(screen.getByTestId('do-stuff-start'));
    expect(laneOfRow('email the landlord')).toBe('now');
    expect(laneOfRow('call the dentist')).toBe('now');
    expect(laneOfRow('pick up stamps')).toBe('calendar');
    expect(laneOfRow('declutter the garage')).toBe('calendar');
    // No agent paired: the fuzzy one is left alone, not handed off.
    expect(laneOfRow('figure out the budget')).toBe('leave');
    expect(laneOfRow('zebra')).toBe('leave');
    expect(screen.queryByTestId('do-stuff-lane-handoff')).toBeNull();
    expect(screen.getByTestId('do-stuff-next')).toHaveAccessibleName('Up next: email the landlord');
    expect(screen.getAllByTestId('do-stuff-day').map((d) => d.textContent)).toEqual(['tomorrow', 'tomorrow']);
  });

  it('keeps the lane being walked open and folds the rest to peeks (L1)', () => {
    seed(SIX);
    renderBraindump();
    fireEvent.click(screen.getByTestId('do-stuff-start'));
    // Do it now is open, with its rows; the others are one line each.
    expect(screen.getByTestId('do-stuff-lane-now')).not.toHaveAttribute('data-folded');
    expect(screen.queryByTestId('do-stuff-fold-now')).toBeNull();
    expect(screen.getByTestId('do-stuff-lane-calendar')).toHaveAttribute('data-folded');
    expect(screen.getByTestId('do-stuff-peek-calendar')).toHaveTextContent('another day2pick up stamps, declutter the garage');
    expect(screen.queryByText('pick up stamps', { selector: '[data-lane-row] *' })).toBeNull();
    // Unfolded on ask, and folded again.
    fireEvent.click(screen.getByTestId('do-stuff-peek-calendar'));
    expect(screen.getByText('pick up stamps', { selector: '[data-lane-row] *' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('do-stuff-fold-calendar'));
    expect(screen.getByTestId('do-stuff-lane-calendar')).toHaveAttribute('data-folded');
  });

  it('moves the row under the pointer with a number key', () => {
    seed(SIX);
    renderBraindump();
    fireEvent.click(screen.getByTestId('do-stuff-start'));
    (document.activeElement as HTMLElement | null)?.blur();
    unfold();
    fireEvent.mouseEnter(screen.getByText('zebra').closest('[data-lane-row]')!);
    fireEvent.keyDown(window, { key: '2' });
    expect(laneOfRow('zebra')).toBe('now');
    // Not offered: the agent is not paired, so 5 does nothing.
    fireEvent.keyDown(window, { key: '5' });
    expect(laneOfRow('zebra')).toBe('now');
    // 3 is today, and 7 lets it go.
    fireEvent.keyDown(window, { key: '3' });
    expect(laneOfRow('zebra')).toBe('today');
    fireEvent.keyDown(window, { key: '7' });
    expect(laneOfRow('zebra')).toBe('archive');
    // A modifier is never a lane move.
    fireEvent.keyDown(window, { key: '6', metaKey: true });
    expect(laneOfRow('zebra')).toBe('archive');
  });

  it('makes it so: the calendar lane lands on its days, and nothing else is written', () => {
    seed(SIX);
    renderBraindump();
    fireEvent.click(screen.getByTestId('do-stuff-start'));
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-make-it-so'));
    });
    const byId = new Map(usePlannerStore.getState().items.map((i) => [i.id, i as { startDate?: string }]));
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(byId.get('c')?.startDate).toBe(tomorrow);
    expect(byId.get('d')?.startDate).toBe(tomorrow);
    for (const id of ['a', 'b', 'e', 'f']) expect(byId.get(id)?.startDate).toBeUndefined();
    expect(screen.queryByTestId('do-stuff-make-it-so')).toBeNull();
  });

  it('says "yes u can" over do it now, and holds it to three, the rest onto today', () => {
    seed(['q1', 'q2', 'q3', 'q4', 'q5', 'q6'].map((id) => task(id, { title: `quick ${id}`, size: 'quick' })));
    renderBraindump();
    fireEvent.click(screen.getByTestId('do-stuff-start'));
    expect(screen.getByTestId('do-stuff-lane-note')).toHaveTextContent('yes u can');
    expect(['q1', 'q2', 'q3'].map((id) => laneOfRow(`quick ${id}`))).toEqual(['now', 'now', 'now']);
    expect(['q4', 'q5', 'q6'].map((id) => laneOfRow(`quick ${id}`))).toEqual(['today', 'today', 'today']);
  });

  it('makes it so: today lands today, and whatever is let go with one undo', () => {
    seed(SIX);
    renderBraindump();
    fireEvent.click(screen.getByTestId('do-stuff-start'));
    (document.activeElement as HTMLElement | null)?.blur();
    unfold();
    fireEvent.mouseEnter(screen.getByText('zebra').closest('[data-lane-row]')!);
    fireEvent.keyDown(window, { key: '7' });
    unfold();
    fireEvent.mouseEnter(screen.getByText('figure out the budget').closest('[data-lane-row]')!);
    fireEvent.keyDown(window, { key: '3' });
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-make-it-so'));
    });
    const byId = new Map(usePlannerStore.getState().items.map((i) => [i.id, i as { startDate?: string; status?: string }]));
    const today = new Date().toISOString().slice(0, 10);
    expect(byId.get('e')?.startDate).toBe(today);
    expect(byId.get('f')?.status).toBe('cancelled');
    expect(byId.get('a')?.status).toBe('pending');
    // Let go leaves the braindump.
    expect(screen.queryByText('zebra')).toBeNull();
  });

  it('hands the lane to a connected app when OpenClaw is not paired', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/api/ai/agents')
          ? Response.json({ agents: [{ assignee: 'Claude', name: 'Claude', kind: 'app' }] })
          : new Response('{}', { status: 200 })
      )
    );
    seed(SIX);
    renderBraindump();
    fireEvent.click(screen.getByTestId('do-stuff-start'));
    expect(await screen.findByTestId('do-stuff-hand-to')).toHaveTextContent('to Claude');
    expect(laneOfRow('figure out the budget')).toBe('handoff');
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-make-it-so'));
    });
    const e = usePlannerStore.getState().items.find((i) => i.id === 'e') as { assignee?: string; aiStatus?: string };
    expect(e).toMatchObject({ assignee: 'Claude', aiStatus: 'queued' });
  });

  it('puts what the AI got ready in "done for you", with its chip and card', () => {
    seed(SIX);
    usePrepPacksStore.setState({
      packs: {
        b: { itemId: 'b', pack: { kind: 'call', who: 'the dentist', script: ['Hi, I need a cleaning'] }, madeFor: 'call the dentist', updatedAt: 't' },
        // Written for an older title: stale, so it sorts by the rules.
        f: { itemId: 'f', pack: { kind: 'steps', steps: ['a', 'b'] }, madeFor: 'old zebra', updatedAt: 't' },
      },
    });
    renderBraindump();
    fireEvent.click(screen.getByTestId('do-stuff-start'));
    expect(laneOfRow('call the dentist')).toBe('done');
    expect(laneOfRow('zebra')).toBe('leave');
    fireEvent.click(screen.getByTestId('prep-pack-chip'));
    const card = screen.getByTestId('prep-pack-card');
    expect(card).toHaveTextContent('Call script');
    // No number was given, so the tap out is Copy, never a guessed call.
    expect(screen.getByTestId('prep-pack-primary')).toHaveTextContent('Copy script');
    act(() => {
      fireEvent.click(screen.getByTestId('prep-pack-dismiss'));
    });
    expect(usePrepPacksStore.getState().packs.b).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith('/api/ai/prep?item=b', { method: 'DELETE' });
  });

  it('deals the packs in a deck on the phone, the next one after each', () => {
    seed(SIX);
    usePrepPacksStore.setState({
      packs: {
        a: { itemId: 'a', pack: { kind: 'email', subject: 'The boiler', body: 'Hi' }, madeFor: 'email the landlord', updatedAt: 't' },
        b: { itemId: 'b', pack: { kind: 'call', who: 'the dentist', script: ['Hi'] }, madeFor: 'call the dentist', updatedAt: 't' },
      },
    });
    render(
      <DndContext>
        <Braindump variant="mobile" />
      </DndContext>
    );
    fireEvent.click(screen.getByTestId('do-stuff-start'));
    fireEvent.click(screen.getByTestId('prep-pack-review'));
    expect(screen.getByTestId('prep-pack-deck')).toHaveTextContent('1 of 2');
    expect(screen.getByTestId('prep-pack-card')).toHaveTextContent('Email draft');
    act(() => {
      fireEvent.click(screen.getByTestId('prep-pack-dismiss'));
    });
    // The deck stays open and deals the call script in its place.
    expect(screen.getByTestId('prep-pack-card')).toHaveTextContent('Call script');
  });
});
