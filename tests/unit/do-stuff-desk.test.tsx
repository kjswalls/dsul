import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

// RelayField (the braindump's empty-state backdrop) reads prefers-reduced-motion.
beforeAll(() => {
  // The day column measures itself.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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
 * The Desk (memory/plans/power-mode.md, the polish round): while doing stuff,
 * the canvas becomes the current item set large (notes, steps, a jot box and
 * its conversation) beside today's day column. It follows the walk, and Esc or
 * stopping the mode closes it.
 */

vi.mock('@/lib/db', () => ({
  fetchItemEvents: vi.fn(async () => []),
  getItemEventsAvailable: () => true,
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
// First steps open the item (their one home); the desk keeps the focus here.
const showItemSteps = vi.hoisted(() => vi.fn());
vi.mock('@/lib/open-chat', async (orig) => ({ ...(await orig<typeof import('@/lib/open-chat')>()), showItemSteps }));
// The item's notes (082), read by the desk's conversation; none unless a test says so.
const notesRead = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/lib/item-notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/item-notes')>()),
  listItemNotes: vi.fn(async () => notesRead.rows),
}));

import { Braindump } from '@/components/sidebar/braindump';
import { ViewRouter } from '@/components/views/view-router';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { openDesk, useDoStuffStore } from '@/lib/do-stuff';
import { seedAI, CONNECTED_MODEL } from './helpers/ai-fixtures';
import { usePrepPacksStore } from '@/lib/prep-packs-store';
import { useAgentsStore } from '@/lib/agents-store';
import { useViewStore } from '@/lib/view-store';
import { useKeyboardShortcutsStore } from '@/lib/keyboard-shortcuts-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import type { Item } from '@/lib/planner-types';
import { enableExtensions } from './support/extensions';
import { EXT_DO_STUFF } from '@/lib/extension-registry';
import { clearItemNotesState } from '@/lib/item-notes-store';

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

function seed(items: Item[]) {
  usePlannerStore.setState({
    userId: 'user-1',
    isLoading: false,
    error: null,
    userTimezone: 'UTC',
    selectedDate: new Date(Date.now() + 3 * 86_400_000),
    items,
    tasks: items.filter((i) => !(i as { parentItemId?: string }).parentItemId) as never,
    habits: [],
    projects: [],
    routines: [],
    seasons: [],
    goals: [],
  });
  useViewStore.setState({
    scope: 'day',
    layout: 'buckets',
    braindumpGroupBy: 'none',
    braindumpSortBy: 'default',
    braindumpFilters: EMPTY_VIEW_FILTERS,
  });
}

const ITEMS = [
  task('a', { title: 'reply to sam about the lease', size: 'quick', notes: 'renewal or month to month?' }),
  task('a1', { title: 'find the lease', parentItemId: 'a', order: 0, status: 'completed' }),
  task('a2', { title: 'check the renewal date', parentItemId: 'a', order: 1 }),
  task('b', { title: 'call the dentist', size: 'quick' }),
  task('c', { title: 'pick up stamps', size: 'errand' }),
  task('d', { title: 'declutter the garage', size: 'big' }),
  task('e', { title: 'figure out the budget' }),
  task('f', { title: 'zebra' }),
];

beforeEach(() => {
  enableExtensions(EXT_DO_STUFF);
  useKeyboardShortcutsStore.setState({ overrides: {} });
  useDoStuffStore.getState().stop();
  usePrepPacksStore.setState({ userId: 'user-1', packs: {}, loaded: true, available: true, preparing: {}, tried: {}, error: null });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  useAgentsStore.setState({ agents: [], loaded: false });
});
afterEach(() => {
  cleanup();
  notesRead.rows = [];
  clearItemNotesState();
});

function start({ host = true }: { host?: boolean } = {}) {
  render(
    <DndContext>
      <Braindump />
      {host && <ViewRouter />}
    </DndContext>
  );
  fireEvent.click(screen.getByTestId('do-stuff-start'));
}

const open = () =>
  act(() => {
    fireEvent.click(screen.getByTestId('do-stuff-open-desk'));
  });

const today = () => new Date().toISOString().slice(0, 10);

const byId = (id: string) => usePlannerStore.getState().items.find((i) => i.id === id) as Record<string, unknown>;

describe('the desk', () => {
  it('opens on the current item, on today, with its notes and steps', () => {
    seed(ITEMS);
    start();
    expect(screen.queryByTestId('do-stuff-desk')).toBeNull();
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-open-desk'));
    });
    const next = useDoStuffStore.getState().next!;
    expect(next.id).toBe('a');
    const desk = screen.getByTestId('do-stuff-desk-item');
    expect(desk.textContent).toContain('reply to sam about the lease');
    expect(screen.getByTestId('do-stuff-desk-notes').textContent).toContain('renewal or month to month?');
    const steps = screen.getAllByRole('checkbox', { name: /find the lease|check the renewal date/ });
    expect(steps.map((s) => s.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    // The strip says only how long until the next block; never the lane.
    expect(screen.getByTestId('do-stuff-desk-kicker').textContent).not.toContain('do it now');
    // Always today: the canvas came back from three days out.
    const sel = usePlannerStore.getState().selectedDate;
    expect(sel.toDateString()).toBe(new Date().toDateString());
  });

  it('ticks a step, and a jot lands at the foot of the notes', () => {
    seed(ITEMS);
    start();
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-open-desk'));
    });
    act(() => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'check the renewal date' }));
    });
    expect(byId('a2').status).toBe('completed');
    const jot = screen.getByTestId('do-stuff-desk-jot');
    fireEvent.change(jot, { target: { value: 'landlord prefers email' } });
    act(() => {
      fireEvent.keyDown(jot, { key: 'Enter' });
    });
    expect(byId('a').notes).toBe('renewal or month to month?\nlandlord prefers email');
    expect((jot as HTMLTextAreaElement).value).toBe('');
  });

  it('follows the walk on done, and Esc goes back to the day', () => {
    seed(ITEMS);
    start();
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-open-desk'));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-desk-done'));
    });
    expect(byId('a').status).toBe('completed');
    const next = useDoStuffStore.getState().next!;
    expect(screen.getByTestId('do-stuff-desk-item').textContent).toContain(next.title);
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByTestId('do-stuff-desk')).toBeNull();
    expect(useDoStuffStore.getState().desk).toBe(false);
  });

  it('opens by itself on an item with something to work with, once the sort lands, and stays shut once closed', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      seed(ITEMS);
      start();
      expect(useDoStuffStore.getState().desk).toBe(false);
      // 'a' has notes and steps: worth a desk (Kirby, 2026-10-23).
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(useDoStuffStore.getState().desk).toBe(true);
      expect(screen.getByTestId('do-stuff-desk-item').textContent).toContain('reply to sam about the lease');
      // Closed by the person: left closed for the run.
      act(() => {
        fireEvent.keyDown(window, { key: 'Escape' });
      });
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(useDoStuffStore.getState().desk).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a bare item as the card in the list', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      seed(ITEMS.filter((t) => !['a', 'a1', 'a2'].includes(t.id)));
      start();
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(useDoStuffStore.getState().next?.id).toBe('b');
      expect(useDoStuffStore.getState().desk).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes when the mode stops', () => {
    seed(ITEMS);
    start();
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-open-desk'));
    });
    act(() => useDoStuffStore.getState().stop());
    expect(screen.queryByTestId('do-stuff-desk')).toBeNull();
    act(() => useDoStuffStore.getState().start());
    expect(useDoStuffStore.getState().desk).toBe(false);
  });

  it('takes the focus as it opens, and ↵ S T F work from it', () => {
    const unseed = seedAI(CONNECTED_MODEL);
    try {
      seed(ITEMS);
      start();
      open();
      const pane = screen.getByRole('region', { name: 'Desk' });
      expect(document.activeElement).toBe(pane);
      // T: onto today, the card's own key. The row leaves do it now for the
      // today lane, so the walk moves on.
      expect(screen.getByTestId('do-stuff-desk-today').getAttribute('aria-keyshortcuts')).toBe('T');
      act(() => {
        fireEvent.keyDown(pane, { key: 't' });
      });
      expect(byId('a').startDate).toBe(today());
      const second = useDoStuffStore.getState().next!.id;
      expect(second).not.toBe('a');
      // F: first steps, offered since the model can propose.
      expect(screen.getByTestId('do-stuff-desk-first-steps').getAttribute('aria-keyshortcuts')).toBe('F');
      act(() => {
        fireEvent.keyDown(pane, { key: 'f' });
      });
      expect(showItemSteps).toHaveBeenLastCalledWith(expect.objectContaining({ id: second }), { ask: true });
      // S: skip, and the next item takes the desk.
      expect(screen.getByTestId('do-stuff-desk-skip').getAttribute('aria-keyshortcuts')).toBe('S');
      act(() => {
        fireEvent.keyDown(pane, { key: 's' });
      });
      expect(useDoStuffStore.getState().skipped).toEqual([second]);
      const third = useDoStuffStore.getState().next!.id;
      expect(third).not.toBe(second);
      // ↵: done.
      act(() => {
        fireEvent.keyDown(pane, { key: 'Enter' });
      });
      expect(byId(third).status).toBe('completed');
    } finally {
      unseed();
    }
  });

  it('the jot writes on ↵ only: blur keeps the draft, Esc clears it, and neither touches the notes', () => {
    seed(ITEMS);
    start();
    open();
    const jot = screen.getByTestId('do-stuff-desk-jot') as HTMLTextAreaElement;
    fireEvent.change(jot, { target: { value: 'half a tho' } });
    act(() => {
      fireEvent.blur(jot);
    });
    expect(byId('a').notes).toBe('renewal or month to month?');
    expect(jot.value).toBe('half a tho');
    jot.focus();
    act(() => {
      fireEvent.keyDown(jot, { key: 'Escape' });
    });
    expect(byId('a').notes).toBe('renewal or month to month?');
    expect(jot.value).toBe('');
    // Esc in the box left the box, not the desk.
    expect(screen.getByTestId('do-stuff-desk')).toBeTruthy();
    expect(document.activeElement).not.toBe(jot);
    fireEvent.change(jot, { target: { value: 'landlord prefers email' } });
    act(() => {
      fireEvent.keyDown(jot, { key: 'Enter' });
    });
    expect(byId('a').notes).toBe('renewal or month to month?\nlandlord prefers email');
    act(() => {
      fireEvent.keyDown(jot, { key: 'Enter' });
    });
    expect(byId('a').notes).toBe('renewal or month to month?\nlandlord prefers email');
  });

  it('grows with the lines typed, from two to six', () => {
    seed(ITEMS);
    start();
    open();
    const jot = screen.getByTestId('do-stuff-desk-jot') as HTMLTextAreaElement;
    expect(jot.rows).toBe(2);
    fireEvent.change(jot, { target: { value: 'one\ntwo\nthree\nfour' } });
    expect(jot.rows).toBe(4);
    fireEvent.change(jot, { target: { value: Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\n') } });
    expect(jot.rows).toBe(6);
  });

  it('is empty only when the plan says there is nothing; an item gone from the store draws nothing', () => {
    seed(ITEMS);
    start();
    open();
    // The plan still names 'a', but the store has lost it.
    act(() => {
      usePlannerStore.setState((s) => ({ items: s.items.filter((i) => i.id !== 'a') }));
    });
    expect(useDoStuffStore.getState().next?.id).toBe('a');
    expect(screen.queryByTestId('do-stuff-desk-clear')).toBeNull();
    expect(screen.queryByTestId('do-stuff-desk-item')).toBeNull();
    // Nothing left to walk: the end of the walk, which here has the plan's
    // moves to make (the empty "the rest can wait" is for a plan with none).
    act(() => useDoStuffStore.setState({ next: null }));
    expect(screen.getByTestId('do-stuff-receipt')).toBeTruthy();
  });

  it('ends the walk on a receipt: what got done, where the rest goes, and make it so', () => {
    seed(ITEMS);
    start();
    open();
    act(() => useDoStuffStore.setState({ next: null, doneIds: ['a1'], doneCount: 1 }));
    const commit = useDoStuffStore.getState().commit!;
    const moves = commit.days.size + commit.today.length + commit.unschedule.length + commit.handOff.length;
    expect(moves).toBeGreaterThan(0);
    const receipt = screen.getByTestId('do-stuff-receipt');
    expect(screen.getByTestId('do-stuff-receipt-head').textContent).toMatch(new RegExp(`^1 done· ${moves} moved`));
    expect(receipt.textContent).toContain('find the lease');
    expect(screen.getAllByTestId('do-stuff-receipt-moved')).toHaveLength(moves);
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-receipt-commit'));
    });
    expect(useDoStuffStore.getState().on).toBe(false);
  });

  it('closes when the canvas leaves today', () => {
    seed(ITEMS);
    start();
    open();
    expect(useDoStuffStore.getState().desk).toBe(true);
    act(() => usePlannerStore.getState().setSelectedDate(new Date(Date.now() + 86_400_000)));
    expect(useDoStuffStore.getState().desk).toBe(false);
    expect(screen.queryByTestId('do-stuff-desk')).toBeNull();
  });

  it('the list card offers "Back to the day" while the desk is open, and D toggles', () => {
    seed(ITEMS);
    start();
    open();
    // With the slot off the grid (no free stretch left today) the card keeps
    // its actions; while the slot is drawn it is a slim row with none.
    act(() => useDoStuffStore.setState({ slot: false }));
    expect(screen.queryByTestId('do-stuff-open-desk')).toBeNull();
    const back = screen.getByTestId('do-stuff-close-desk');
    expect(back).toHaveAccessibleName('Back to the day');
    act(() => {
      fireEvent.click(back);
    });
    expect(useDoStuffStore.getState().desk).toBe(false);
    expect(screen.getByTestId('do-stuff-open-desk')).toBeTruthy();
    act(() => {
      fireEvent.keyDown(screen.getByTestId('do-stuff-next'), { key: 'd' });
    });
    expect(useDoStuffStore.getState().desk).toBe(true);
    act(() => {
      fireEvent.keyDown(screen.getByTestId('do-stuff-next'), { key: 'd' });
    });
    expect(useDoStuffStore.getState().desk).toBe(false);
  });

  it('the card is its own shape: done and skip in the capsule, no today button, keys only in its footer', () => {
    seed(ITEMS);
    start();
    open();
    act(() => useDoStuffStore.setState({ slot: false, desk: false }));
    const card = screen.getByTestId('do-stuff-next');
    expect(screen.getByTestId('do-stuff-done')).toHaveAccessibleName(/^Done: /);
    expect(screen.getByTestId('do-stuff-skip')).toBeTruthy();
    // "today" left the card (Kirby, 2026-10-23); T still does it, and the footer says so.
    expect(screen.queryByTestId('do-stuff-today')).toBeNull();
    expect(screen.getByTestId('do-stuff-next-keys').textContent).toContain('today');
    // No checkbox and no lane chip on the card: done is the tick, the header names the lane.
    expect(card.querySelector('[role="checkbox"]')).toBeNull();
    expect(card.querySelector('[data-testid="do-stuff-lane-chip"]')).toBeNull();
    // The title opens the item.
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-next-title'));
    });
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item' });
  });

  it('the exit sits in the kicker row, the actions hold the verbs, and the day column is dense', () => {
    seed(ITEMS);
    start();
    open();
    const item = screen.getByTestId('do-stuff-desk-item');
    const close = screen.getByTestId('do-stuff-desk-close');
    expect(close.parentElement).toBe(screen.getByTestId('do-stuff-desk-kicker').parentElement);
    expect(screen.getByTestId('do-stuff-desk-done').parentElement!.contains(close)).toBe(false);
    // Done, skip and today wait in the bar at the foot of the room.
    const bar = screen.getByTestId('do-stuff-desk-bar');
    for (const id of ['do-stuff-desk-done', 'do-stuff-desk-skip', 'do-stuff-desk-today']) {
      expect(bar.contains(screen.getByTestId(id))).toBe(true);
    }
    expect(item.contains(bar)).toBe(true);
    // The day column is the day's clock: no Anytime strip while walking.
    expect(screen.getByTestId('do-stuff-desk-day').querySelector('[data-dnd-id="unscheduled:anytime"]')).toBeNull();
    expect(screen.getByTestId('do-stuff-desk-day').hasAttribute('data-dense')).toBe(true);
  });
});

describe('notes on the desk', () => {
  it('with AI, shows the item’s note rows and pinned card, draws no Ask / Note switch, and Jot still writes the description', async () => {
    const unseed = seedAI(CONNECTED_MODEL);
    try {
      const at = new Date().toISOString();
      notesRead.rows = [
        { id: 'n1', itemId: 'a', body: 'call before noon', createdAt: at, editedAt: null, pinnedAt: null },
        { id: 'n2', itemId: 'a', body: 'the pinned one', createdAt: at, editedAt: null, pinnedAt: at },
      ];
      seed(ITEMS);
      start();
      open();
      await act(async () => {});
      expect(screen.getByTestId('item-timeline-note')).toHaveTextContent('call before noon');
      expect(screen.getByTestId('item-note-pinned')).toHaveTextContent('the pinned one');
      expect(screen.queryByTestId('box-mode-ask')).toBeNull();
      expect(screen.queryByTestId('box-mode-note')).toBeNull();
      const jot = screen.getByTestId('do-stuff-desk-jot');
      fireEvent.change(jot, { target: { value: 'landlord prefers email' } });
      act(() => {
        fireEvent.keyDown(jot, { key: 'Enter' });
      });
      expect(byId('a').notes).toBe('renewal or month to month?\nlandlord prefers email');
    } finally {
      unseed();
    }
  });
});

describe('the desk needs a host', () => {
  it('with no view that draws it, there is no desk button and openDesk is a no-op', () => {
    seed(ITEMS);
    start({ host: false });
    expect(useDoStuffStore.getState().deskHosts).toBe(0);
    expect(screen.queryByTestId('do-stuff-open-desk')).toBeNull();
    act(() => {
      fireEvent.keyDown(screen.getByTestId('do-stuff-next'), { key: 'd' });
    });
    expect(useDoStuffStore.getState().desk).toBe(false);
    act(() => openDesk());
    expect(useDoStuffStore.getState().desk).toBe(false);
  });

  it('the host leaving closes the desk', () => {
    seed(ITEMS);
    start();
    expect(useDoStuffStore.getState().deskHosts).toBe(1);
    open();
    expect(useDoStuffStore.getState().desk).toBe(true);
    cleanup();
    expect(useDoStuffStore.getState().deskHosts).toBe(0);
    expect(useDoStuffStore.getState().desk).toBe(false);
  });
});
