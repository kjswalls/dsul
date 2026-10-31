import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, within } from '@testing-library/react';

/**
 * Atlas's surface (components/views/atlas/), PR1a: card A, the row's click and
 * tick, the two right-click menus kept apart, the shift range kept to a card,
 * the session-only card drag, and the accent and canvas-container locks.
 *
 * The focus sheet and its Escape/Enter keys land with PR1c and are tested there.
 */

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'light', resolvedTheme: 'light', setTheme: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/db', () => ({
  updateItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  setItemSkip: vi.fn(async () => {}),
  fetchAgentStates: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import { AtlasView } from '@/components/views/atlas/atlas-view';
import { usePlannerStore } from '@/lib/planner-store';
import { useSelectionStore } from '@/lib/selection-store';
import { useUIStore } from '@/lib/ui-store';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import type { Item, Project } from '@/lib/planner-types';

const TODAY = '2026-07-16';
const asDate = (ymd: string) => new Date(`${ymd}T12:00:00Z`);

beforeAll(() => {
  // tests/unit/setup.ts has no ResizeObserver; Atlas only needs one to exist.
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
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

const task = (id: string, over: Partial<Item> = {}) =>
  ({
    type: 'task',
    id,
    title: `Task ${id}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    skippedDates: [],
    project: 'Work',
    ...over,
  }) as unknown as Item;

function seed(items: Item[], projects: Project[] = [{ id: 'p1', name: 'Work', emoji: '' } as Project]) {
  usePlannerStore.setState({
    items,
    tasks: items.filter((i) => i.type !== 'habit') as never,
    habits: items.filter((i) => i.type === 'habit') as never,
    projects,
    routines: [],
    seasons: [],
    goals: [],
    userTimezone: 'UTC',
    selectedDate: asDate(TODAY),
    collectionsAvailable: true,
    goalsAvailable: true,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(asDate(TODAY));
  useAtlasUiStore.getState().reset();
  useSelectionStore.getState().clear();
  useUIStore.setState({ activeDialog: null, confirmRequest: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const card = (key = 'project:p1') => document.querySelector<HTMLElement>(`[data-atlas-card="${key}"]`)!;
const rowsIn = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-testid="atlas-row"]')];
function rightClick(el: Element) {
  fireEvent.contextMenu(el, { clientX: 10, clientY: 10 });
  return screen.getByTestId(/context-menu$/);
}

describe('card A', () => {
  it('renders the strip, the next step and the footer', () => {
    seed([task('a', { startDate: '2026-07-20' }), task('b'), task('c', { status: 'completed' })]);
    render(<AtlasView />);
    const c = card();
    expect(c).toBeTruthy();
    expect(c.getAttribute('aria-label')).toBe('Work, Project');
    expect(within(c).getByTestId('atlas-tiles').querySelectorAll('[data-tile]')).toHaveLength(3);
    // Dated first: the next step is the dated one.
    expect(rowsIn(c).map((r) => r.dataset.itemId)).toEqual(['a']);
    expect(rowsIn(c)[0].dataset.atlasCardKey).toBe('project:p1');
    expect(rowsIn(c)[0].hasAttribute('data-settle-key')).toBe(false);
    // No known touch: the neutral count, never "resting".
    expect(within(c).getByTestId('atlas-count').textContent).toBe('1 of 3');
    expect(within(c).queryByTestId('atlas-touch')).toBeNull();
    expect(c.dataset.resting).toBeUndefined();
  });

  it('shows the dashed All done state with nothing open', () => {
    seed([task('a', { status: 'completed' })]);
    render(<AtlasView />);
    expect(card().dataset.allDone).toBe('true');
    expect(within(card()).getByTestId('atlas-card-all-done').textContent).toBe("All done. What's next?");
  });

  it('expands to every open row with the chevron', () => {
    seed([task('a'), task('b'), task('c')]);
    render(<AtlasView />);
    expect(rowsIn(card())).toHaveLength(1);
    fireEvent.click(within(card()).getByTestId('atlas-card-expand'));
    expect(rowsIn(card())).toHaveLength(3);
  });
});

describe('a row', () => {
  it('opens the item on a click, and Ctrl+click toggles without opening', () => {
    seed([task('a'), task('b')]);
    render(<AtlasView />);
    const row = rowsIn(card())[0];
    fireEvent.click(row, { ctrlKey: true });
    expect(useSelectionStore.getState().selectedIds.has('a')).toBe(true);
    expect(useUIStore.getState().activeDialog).toBeNull();
    fireEvent.click(row);
    const dialog = useUIStore.getState().activeDialog;
    expect(dialog?.type).toBe('edit-item');
    expect((dialog as { item: Item }).item.id).toBe('a');
    expect([...useSelectionStore.getState().selectedIds]).toEqual(['a']);
  });

  it('ticks through its own box, without opening the item', () => {
    seed([task('a')]);
    render(<AtlasView />);
    fireEvent.click(within(card()).getByTestId('atlas-row-check'));
    const a = usePlannerStore.getState().items.find((i) => i.id === 'a') as { status: string };
    expect(a.status).toBe('completed');
    expect(useUIStore.getState().activeDialog).toBeNull();
  });

  it('keeps a Shift range inside the clicked card', () => {
    // The same items on two cards: a project and a second project by name.
    seed(
      [task('a'), task('b'), task('c', { project: 'Home' }), task('d', { project: 'Home' })],
      [{ id: 'p1', name: 'Work', emoji: '' } as Project, { id: 'p2', name: 'Home', emoji: '' } as Project]
    );
    render(<AtlasView />);
    fireEvent.click(within(card('project:p1')).getByTestId('atlas-card-expand'));
    fireEvent.click(within(card('project:p2')).getByTestId('atlas-card-expand'));
    const [a] = rowsIn(card('project:p1'));
    const [, d] = rowsIn(card('project:p2'));
    fireEvent.click(a, { ctrlKey: true });
    fireEvent.click(d, { shiftKey: true });
    // The document-wide range runs a..d; only the clicked card's rows join it,
    // so nothing from the Work card (a, b) is taken along.
    expect([...useSelectionStore.getState().selectedIds].sort()).toEqual(['c', 'd']);
  });
});

describe('a ticked row', () => {
  it('stays in its slot, drawn done, and a double click ticks exactly one item', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(asDate(TODAY));
    seed([task('a'), task('b'), task('c')]);
    render(<AtlasView />);
    const box = within(card()).getByTestId('atlas-row-check');
    fireEvent.click(box, { detail: 1 });
    // The same row, now done, is still where the pointer is.
    expect(rowsIn(card()).map((r) => r.dataset.itemId)).toEqual(['a']);
    expect(rowsIn(card())[0].dataset.completed).toBe('true');
    expect(within(card()).getByTestId('atlas-row-check')).toBe(box);
    // The double click's second click is not a second tick.
    fireEvent.click(box, { detail: 2 });
    const status = (id: string) => (usePlannerStore.getState().items.find((i) => i.id === id) as { status: string }).status;
    expect(status('a')).toBe('completed');
    expect(status('b')).toBe('pending');
    // Once the hold is over (and the pointer is not on the card), the card re-picks.
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(rowsIn(card()).map((r) => r.dataset.itemId)).toEqual(['b']);
  });
});

describe('a Shift range with an item on two cards', () => {
  it('runs along the clicked card, not the document order', () => {
    seed(
      [task('x'), task('b1', { project: undefined }), task('b2', { project: undefined })],
      [{ id: 'p1', name: 'Work', emoji: '' } as Project]
    );
    usePlannerStore.setState({ routines: [{ id: 'r1', name: 'Morning', itemIds: ['b1', 'b2', 'x'] }] as never });
    render(<AtlasView />);
    // x shows first on the Work card, then again on the routine.
    expect(rowsIn(card('project:p1')).map((r) => r.dataset.itemId)).toEqual(['x']);
    fireEvent.click(within(card('routine:r1')).getByTestId('atlas-card-expand'));
    const rows = rowsIn(card('routine:r1'));
    expect(rows.map((r) => r.dataset.itemId)).toEqual(['b1', 'b2', 'x']);
    fireEvent.click(rows[1], { ctrlKey: true });
    fireEvent.click(rows[2], { shiftKey: true });
    expect([...useSelectionStore.getState().selectedIds].sort()).toEqual(['b2', 'x']);
  });
});

describe('focus and the camera', () => {
  it('a press never pans the camera; keyboard focus does', () => {
    const w = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    const h = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700);
    try {
      seed([task('a')]);
      render(<AtlasView />);
      const off = { x: -2000, y: 0, z: 1 };
      act(() => useAtlasUiStore.getState().setCamera(off));
      const c = card();
      fireEvent.pointerDown(c, { button: 0, pointerId: 1, clientX: 5, clientY: 5 });
      act(() => c.focus());
      expect(useAtlasUiStore.getState().camera).toEqual(off);
      fireEvent.pointerUp(c, { pointerId: 1, clientX: 5, clientY: 5 });
      act(() => c.blur());
      act(() => c.focus());
      expect(useAtlasUiStore.getState().camera).not.toEqual(off);
    } finally {
      w.mockRestore();
      h.mockRestore();
    }
  });
});

describe('card states', () => {
  it('lifts an expanded card above its neighbours', () => {
    seed([task('a'), task('b')]);
    render(<AtlasView />);
    expect(card().className).not.toMatch(/(^|\s)z-10(\s|$)/);
    fireEvent.click(within(card()).getByTestId('atlas-card-expand'));
    expect(card().className).toMatch(/(^|\s)z-10(\s|$)/);
  });

  it('bridges the gap between the hover bar and the card', () => {
    seed([task('a')]);
    render(<AtlasView />);
    expect(within(card()).getByTestId('atlas-card-hoverbar').className).toMatch(/after:top-full/);
  });

  it('draws no All done on an empty project or a paused routine', () => {
    seed([task('h', { project: undefined })]);
    usePlannerStore.setState({
      routines: [{ id: 'r', name: 'Evening', itemIds: ['h'], pausedAt: '2026-07-01T00:00:00Z', pausedUntil: '2026-08-01' }] as never,
    });
    render(<AtlasView />);
    for (const key of ['project:p1', 'routine:r']) {
      expect(card(key).dataset.allDone, key).toBeUndefined();
      expect(within(card(key)).queryByTestId('atlas-card-all-done'), key).toBeNull();
    }
  });

  it('names only the kinds the account has on the empty map', () => {
    seed([], []);
    usePlannerStore.setState({ collectionsAvailable: false });
    render(<AtlasView />);
    const text = screen.getByTestId('atlas-empty').textContent ?? '';
    expect(text).not.toMatch(/goals|routines|seasons/i);
  });
});

describe('the wheel', () => {
  const wheel = (init: WheelEventInit) => {
    const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
    act(() => {
      screen.getByTestId('atlas-surface').dispatchEvent(ev);
    });
  };

  it('zooms at most about 1.5x for one mouse notch with Ctrl', () => {
    seed([task('a')]);
    render(<AtlasView />);
    act(() => useAtlasUiStore.getState().setCamera({ x: 0, y: 0, z: 1 }));
    wheel({ ctrlKey: true, deltaY: 100 });
    const z = useAtlasUiStore.getState().camera.z;
    expect(z).toBeLessThan(1);
    expect(1 / z).toBeLessThanOrEqual(1.5);
  });

  it('pans 16px per line for a wheel that reports lines', () => {
    seed([task('a')]);
    render(<AtlasView />);
    act(() => useAtlasUiStore.getState().setCamera({ x: 0, y: 0, z: 1 }));
    wheel({ deltaMode: 1, deltaY: 3 });
    expect(useAtlasUiStore.getState().camera).toEqual({ x: 0, y: -48, z: 1 });
  });
});

describe('the card drag, cancelled', () => {
  it('leaves no swallowed click behind', () => {
    seed([task('a'), task('b')]);
    render(<AtlasView />);
    const c = card();
    fireEvent.pointerDown(c, { button: 0, pointerId: 3, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(c, { pointerId: 3, clientX: 160, clientY: 140 });
    act(() => {
      fireEvent.pointerCancel(c, { pointerId: 3, clientX: 160, clientY: 140 });
    });
    fireEvent.click(within(card()).getByTestId('atlas-card-expand'));
    expect(rowsIn(card())).toHaveLength(2);
  });
});

describe('the right-click menus', () => {
  it('a row opens only the item menu, the header only the card menu', () => {
    seed([task('a')]);
    render(<AtlasView />);
    const rowMenu = rightClick(rowsIn(card())[0]);
    expect(rowMenu.getAttribute('data-testid')).toBe('item-context-menu');
    expect(screen.queryByTestId('container-context-menu')).toBeNull();
    fireEvent.keyDown(rowMenu, { key: 'Escape' });
    cleanup();

    render(<AtlasView />);
    const cardMenu = rightClick(within(card()).getByTestId('atlas-card-header'));
    expect(cardMenu.getAttribute('data-testid')).toBe('container-context-menu');
    expect(screen.queryByTestId('item-context-menu')).toBeNull();
    expect(within(cardMenu).getByTestId('container-menu-center').textContent).toContain('Center here');
  });
});

describe('the card drag', () => {
  it('moves a card for the session on pointerup, past 5px only', () => {
    seed([task('a')]);
    render(<AtlasView />);
    const c = card();
    const start = c.style.transform;
    // A small wiggle is a click, not a drag.
    fireEvent.pointerDown(c, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(c, { pointerId: 1, clientX: 102, clientY: 101 });
    fireEvent.pointerUp(c, { pointerId: 1, clientX: 102, clientY: 101 });
    expect(useAtlasUiStore.getState().moved).toEqual({});
    expect(card().style.transform).toBe(start);

    fireEvent.pointerDown(c, { button: 0, pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(c, { pointerId: 2, clientX: 160, clientY: 140 });
    act(() => {
      fireEvent.pointerUp(c, { pointerId: 2, clientX: 160, clientY: 140 });
    });
    const moved = useAtlasUiStore.getState().moved['project:p1'];
    expect(moved).toBeTruthy();
    expect(card().style.transform).toBe(`translate(${moved.x}px, ${moved.y}px)`);
  });

  it('never starts on a Ctrl+click (a Mac right-click)', () => {
    seed([task('a')]);
    render(<AtlasView />);
    const c = card();
    fireEvent.pointerDown(c, { button: 0, ctrlKey: true, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(c, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(c, { pointerId: 1, clientX: 200, clientY: 200 });
    expect(useAtlasUiStore.getState().moved).toEqual({});
  });
});

describe('the locks', () => {
  it('dims nothing by opacity (the accent rule)', () => {
    seed([task('a'), task('b', { status: 'completed' })]);
    render(<AtlasView />);
    const root = document.querySelector('[data-atlas-root]')!;
    const offenders = [root, ...root.querySelectorAll('*')].filter((el) => {
      const cls = (el.getAttribute('class') ?? '').split(/\s+/);
      const bare = cls.some((c) => /(^|:)opacity-/.test(c) && !/^(disabled|data-\[disabled\]):/.test(c));
      return bare || /opacity\s*:/.test(el.getAttribute('style') ?? '');
    });
    expect(offenders.map((el) => el.outerHTML.slice(0, 120))).toEqual([]);
  });

  it('holds no canvas-container', () => {
    seed([task('a')]);
    render(<AtlasView />);
    expect(document.querySelectorAll('[data-atlas-root] .canvas-container')).toHaveLength(0);
  });

  it('carries the camera on one node only', () => {
    seed([task('a')]);
    render(<AtlasView />);
    const world = screen.getByTestId('atlas-world');
    expect(world.style.transform).toMatch(/scale\(/);
    const scaled = [...document.querySelectorAll<HTMLElement>('[data-atlas-root] *')].filter((el) =>
      /scale\(/.test(el.style.transform)
    );
    expect(scaled).toEqual([world]);
  });

  it('a bare-canvas press focuses the root, so its keys keep working', () => {
    seed([task('a')]);
    render(<AtlasView />);
    fireEvent.pointerDown(screen.getByTestId('atlas-surface'), { button: 0, pointerId: 1 });
    expect(document.activeElement).toBe(document.querySelector('[data-atlas-root]'));
  });
});
