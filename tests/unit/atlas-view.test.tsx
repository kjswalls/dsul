import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, within } from '@testing-library/react';

/**
 * Atlas's surface (components/views/atlas/), PR1a: card A, the row's click and
 * tick, the two right-click menus kept apart, the shift range kept to a card,
 * the card drag, and the accent and canvas-container locks. PR1b: places load
 * before cards draw, a seed is written once, a drag is one write, the table
 * missing falls back to this device, and a preview reads and writes nothing.
 *
 * PR1c: the focus sheet (double-click, Enter, Focus), its groups and actions,
 * and the root's Escape and Enter.
 *
 * PR2: the layouts (a switch keeps an open item open), the glide (transform
 * only, off under reduced motion), the lanes, and a filter's scale-down.
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
const io = vi.hoisted(() => ({ fetch: vi.fn(), upsert: vi.fn(), del: vi.fn() }));
vi.mock('@/lib/atlas-positions', async (orig) => ({
  ...(await orig<typeof import('@/lib/atlas-positions')>()),
  fetchAtlasPlaces: io.fetch,
  upsertAtlasPlaces: io.upsert,
  deleteAtlasPlace: io.del,
}));

import { AtlasView } from '@/components/views/atlas/atlas-view';
import { usePlannerStore } from '@/lib/planner-store';
import { useSelectionStore } from '@/lib/selection-store';
import { useUIStore } from '@/lib/ui-store';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { useAtlasStore } from '@/lib/atlas-store';
import { useViewStore } from '@/lib/view-store';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { ATLAS_GLIDE } from '@/components/views/atlas/atlas-card';
import { toast } from 'sonner';
import type { Item, Project } from '@/lib/planner-types';
import { EXT_GOALS } from '@/lib/extension-registry';
import { disableExtensions, enableExtensions } from './support/extensions';

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
  useAtlasStore.getState().reset();
  localStorage.clear();
  usePlannerStore.setState({ userId: null });
  io.fetch.mockReset().mockResolvedValue([]);
  io.upsert.mockReset().mockResolvedValue('ok');
  io.del.mockReset().mockResolvedValue('ok');
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
  it('places a card on pointerup, past 5px only', () => {
    seed([task('a')]);
    render(<AtlasView />);
    const c = card();
    const start = c.style.transform;
    // A small wiggle is a click, not a drag.
    fireEvent.pointerDown(c, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(c, { pointerId: 1, clientX: 102, clientY: 101 });
    fireEvent.pointerUp(c, { pointerId: 1, clientX: 102, clientY: 101 });
    expect(useAtlasStore.getState().places).toEqual({});
    expect(card().style.transform).toBe(start);

    fireEvent.pointerDown(c, { button: 0, pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(c, { pointerId: 2, clientX: 160, clientY: 140 });
    act(() => {
      fireEvent.pointerUp(c, { pointerId: 2, clientX: 160, clientY: 140 });
    });
    const moved = useAtlasStore.getState().places['project:p1'];
    expect(moved).toMatchObject({ kind: 'project', id: 'p1' });
    expect(card().style.transform).toBe(`translate(${moved.x}px, ${moved.y}px)`);
    // No account in this test: nothing is written anywhere.
    expect(io.upsert).not.toHaveBeenCalled();
  });

  it('never starts on a Ctrl+click (a Mac right-click)', () => {
    seed([task('a')]);
    render(<AtlasView />);
    const c = card();
    fireEvent.pointerDown(c, { button: 0, ctrlKey: true, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(c, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(c, { pointerId: 1, clientX: 200, clientY: 200 });
    expect(useAtlasStore.getState().places).toEqual({});
  });
});

describe('positions (PR1b)', () => {
  const signIn = (over: Record<string, unknown> = {}) =>
    usePlannerStore.setState({ userId: 'u1', isLoading: false, isPreview: false, ...over } as never);
  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it('waits for the account’s places, then draws a card where it was put', async () => {
    seed([task('a')]);
    signIn();
    let answer!: (v: unknown) => void;
    io.fetch.mockReturnValueOnce(new Promise((res) => (answer = res)));
    render(<AtlasView />);
    expect(card()).toBeNull();
    expect(io.fetch).toHaveBeenCalledTimes(1);
    await act(async () => answer([{ kind: 'project', id: 'p1', x: 300, y: 120, band: null }]));
    expect(card().style.transform).toBe('translate(300px, 120px)');
    // A stored place is never re-seeded or re-written.
    expect(io.upsert).not.toHaveBeenCalled();
  });

  it('seeds a card with no place and writes that seed once', async () => {
    seed([task('a')]);
    signIn();
    render(<AtlasView />);
    await flush();
    expect(card()).toBeTruthy();
    expect(io.upsert).toHaveBeenCalledTimes(1);
    const [rows, , fields] = io.upsert.mock.calls[0];
    expect(fields).toBe('xy');
    expect(rows).toEqual([expect.objectContaining({ kind: 'project', id: 'p1' })]);
    expect(card().style.transform).toBe(`translate(${rows[0].x}px, ${rows[0].y}px)`);
    // A tick elsewhere re-derives the cards; nothing is written again.
    act(() => seed([task('a'), task('b')]));
    await flush();
    expect(io.upsert).toHaveBeenCalledTimes(1);
  });

  it('works with the table missing: seeds and drags go to this device', async () => {
    seed([task('a')]);
    signIn();
    io.fetch.mockResolvedValue('unavailable');
    render(<AtlasView />);
    await flush();
    expect(useAtlasStore.getState().mode).toBe('device');
    expect(card()).toBeTruthy();
    const blob = () => JSON.parse(localStorage.getItem('dsul-atlas-places')!);
    expect(blob().userId).toBe('u1');
    expect(blob().places).toHaveLength(1);

    const c = card();
    fireEvent.pointerDown(c, { button: 0, pointerId: 3, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(c, { pointerId: 3, clientX: 180, clientY: 100 });
    act(() => {
      fireEvent.pointerUp(c, { pointerId: 3, clientX: 180, clientY: 100 });
    });
    const after = useAtlasStore.getState().places['project:p1'];
    expect(blob().places[0]).toMatchObject({ x: after.x, y: after.y });
    expect(io.upsert).not.toHaveBeenCalled();
  });

  it('writes a drag at once, x and y only', async () => {
    seed([task('a')]);
    signIn();
    io.fetch.mockResolvedValue([{ kind: 'project', id: 'p1', x: 0, y: 0, band: null }]);
    render(<AtlasView />);
    await flush();
    const c = card();
    fireEvent.pointerDown(c, { button: 0, pointerId: 4, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(c, { pointerId: 4, clientX: 140, clientY: 160 });
    act(() => {
      fireEvent.pointerUp(c, { pointerId: 4, clientX: 140, clientY: 160 });
    });
    expect(io.upsert).toHaveBeenCalledTimes(1);
    const [rows, , fields] = io.upsert.mock.calls[0];
    expect(fields).toBe('xy');
    expect(rows[0]).toMatchObject({ kind: 'project', id: 'p1' });
    expect(rows[0].x).toBeGreaterThan(0);
  });

  it('reads and writes nothing while a cached preview shows', async () => {
    seed([task('a')]);
    signIn({ isPreview: true });
    render(<AtlasView />);
    await flush();
    expect(io.fetch).not.toHaveBeenCalled();
    expect(io.upsert).not.toHaveBeenCalled();
  });

  it('after a read that throws, draws seeds without writing them, and retries on focus', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    seed([task('a')]);
    signIn();
    io.fetch.mockRejectedValueOnce(new Error('network'));
    render(<AtlasView />);
    await flush();
    expect(useAtlasStore.getState()).toMatchObject({ failed: true, mode: 'unknown' });
    expect(card()).toBeTruthy();
    expect(io.upsert).not.toHaveBeenCalled();

    io.fetch.mockResolvedValueOnce([]);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(io.fetch).toHaveBeenCalledTimes(2);
    expect(useAtlasStore.getState()).toMatchObject({ failed: false, mode: 'account' });
    // Now the drawn seed is written, once.
    expect(io.upsert).toHaveBeenCalledTimes(1);
    vi.mocked(console.error).mockRestore();
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

describe('the focus sheet (PR1c)', () => {
  beforeEach(() => {
    // The grow and shrink jump, so the sheet comes and goes in one commit.
    document.documentElement.setAttribute('data-reduce-motion', '');
  });
  afterEach(() => {
    document.documentElement.removeAttribute('data-reduce-motion');
  });
  const sheet = () => screen.queryByTestId('atlas-focus-sheet');
  const root = () => document.querySelector<HTMLElement>('[data-atlas-root]')!;

  it('grows from a double-clicked card, holding Next up, Later and Done, and is never an activeDialog', () => {
    seed([task('a', { startDate: '2026-07-20' }), task('b'), task('c', { status: 'completed' })]);
    render(<AtlasView />);
    fireEvent.doubleClick(within(card()).getByTestId('atlas-card-footer'));
    const el = sheet()!;
    expect(el).toBeTruthy();
    expect(el.dataset.atlasSheet).toBe('project:p1');
    expect(useAtlasUiStore.getState().sheet).toMatchObject({ kind: 'project', id: 'p1' });
    expect(useUIStore.getState().activeDialog).toBeNull();
    const ids = (testId: string) => rowsIn(within(el).getByTestId(testId)).map((r) => r.dataset.itemId);
    expect(ids('atlas-sheet-next')).toEqual(['a']);
    expect(ids('atlas-sheet-later')).toEqual(['b']);
    expect(ids('atlas-sheet-done')).toEqual(['c']);
    expect(within(el).getByTestId('atlas-sheet-back').textContent).toBe('‹ Atlas');
    // The map behind takes no press or focus while the sheet is up.
    expect(screen.getByTestId('atlas-surface').hasAttribute('inert')).toBe(true);
  });

  it('a double-click on a row or its box is the row’s, not the sheet’s', () => {
    seed([task('a')]);
    render(<AtlasView />);
    fireEvent.doubleClick(rowsIn(card())[0]);
    expect(sheet()).toBeNull();
  });

  it('opens from Enter on a focused card and from the hover bar’s Focus', () => {
    seed([task('a')]);
    render(<AtlasView />);
    card().focus();
    fireEvent.keyDown(card(), { key: 'Enter' });
    expect(sheet()).toBeTruthy();
    fireEvent.keyDown(sheet()!, { key: 'Escape' });
    expect(sheet()).toBeNull();
    fireEvent.click(within(card()).getByTestId('atlas-card-focus'));
    expect(sheet()).toBeTruthy();
  });

  it('Enter on a row opens the row, not the sheet', () => {
    seed([task('a')]);
    render(<AtlasView />);
    fireEvent.keyDown(rowsIn(card())[0], { key: 'Enter' });
    expect(sheet()).toBeNull();
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item' });
  });

  it('a sheet row ticks and opens the item in the rail, and the sheet stays', () => {
    seed([task('a'), task('b')]);
    render(<AtlasView />);
    fireEvent.click(within(card()).getByTestId('atlas-card-focus'));
    const row = rowsIn(within(sheet()!).getByTestId('atlas-sheet-later'))[0];
    fireEvent.click(row);
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item' });
    expect(sheet()).toBeTruthy();
    fireEvent.click(within(rowsIn(sheet()!)[0]).getByTestId('atlas-row-check'));
    expect(usePlannerStore.getState().items.find((i) => i.id === 'a')).toMatchObject({ status: 'completed' });
    // Held in its slot for a moment, drawn done.
    expect(rowsIn(within(sheet()!).getByTestId('atlas-sheet-next'))[0].dataset.completed).toBe('true');
  });

  /**
   * The item panel's own Escape rule (components/planner/item-dialog.tsx),
   * copied so the tests can see which of the two takes the key: it leaves a
   * claimed key alone, and otherwise acts from inside the panel or from <body>.
   */
  function withPanelEscape(run: () => void) {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      useUIStore.getState().closeDialog();
    };
    window.addEventListener('keydown', onKey);
    try {
      run();
    } finally {
      window.removeEventListener('keydown', onKey);
    }
  }
  const escapeOn = (target: Element) => {
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(ev);
    });
    return ev;
  };

  it('Escape closes the sheet but leaves an open item, and hands focus back to the card', () => {
    seed([task('a')]);
    render(<AtlasView />);
    fireEvent.doubleClick(within(card()).getByTestId('atlas-card-footer'));
    fireEvent.click(rowsIn(sheet()!)[0]);
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item' });
    sheet()!.focus();
    withPanelEscape(() => {
      const ev = escapeOn(sheet()!);
      expect(ev.defaultPrevented).toBe(true);
    });
    expect(sheet()).toBeNull();
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item' });
    expect(document.activeElement).toBe(card());
  });

  it('with focus fallen to <body>, Escape still closes the sheet and not the item', () => {
    seed([task('a')]);
    render(<AtlasView />);
    fireEvent.click(within(card()).getByTestId('atlas-card-focus'));
    fireEvent.click(rowsIn(sheet()!)[0]);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    withPanelEscape(() => {
      const ev = escapeOn(document.body);
      expect(ev.defaultPrevented).toBe(true);
    });
    expect(sheet()).toBeNull();
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item' });
    expect(document.activeElement).toBe(card());
  });

  it('keeps focus in the sheet when Put on Today hides itself, so Escape still closes it', () => {
    seed([task('a')]);
    render(<AtlasView />);
    fireEvent.click(within(card()).getByTestId('atlas-card-focus'));
    const btn = screen.getByTestId('atlas-sheet-today');
    btn.focus();
    fireEvent.click(btn);
    expect(screen.queryByTestId('atlas-sheet-today')).toBeNull();
    expect(sheet()!.contains(document.activeElement)).toBe(true);
    escapeOn(document.activeElement!);
    expect(sheet()).toBeNull();
  });

  it('a ticked row moves to Done when its hold ends, the next step takes Next up, and focus follows the box', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(asDate(TODAY));
    seed([task('a'), task('b', { order: 1 })]);
    render(<AtlasView />);
    fireEvent.click(within(card()).getByTestId('atlas-card-focus'));
    const ids = (testId: string) => rowsIn(within(sheet()!).getByTestId(testId)).map((r) => r.dataset.itemId);
    expect(ids('atlas-sheet-next')).toEqual(['a']);
    const box = within(rowsIn(within(sheet()!).getByTestId('atlas-sheet-next'))[0]).getByTestId('atlas-row-check');
    box.focus();
    fireEvent.click(box);
    expect(ids('atlas-sheet-next')).toEqual(['a']);
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(ids('atlas-sheet-next')).toEqual(['b']);
    expect(ids('atlas-sheet-done')).toEqual(['a']);
    const active = document.activeElement as HTMLElement;
    expect(sheet()!.contains(active)).toBe(true);
    expect(active.closest<HTMLElement>('[data-item-id]')?.dataset.itemId).toBe('a');
  });

  it('a double-click on Focus leaves the sheet open (the second click lands on the scrim)', () => {
    seed([task('a')]);
    render(<AtlasView />);
    fireEvent.click(within(card()).getByTestId('atlas-card-focus'), { detail: 1 });
    fireEvent.click(screen.getByTestId('atlas-sheet-scrim'), { detail: 2 });
    expect(sheet()).toBeTruthy();
  });

  it('a press on the scrim keeps focus, and the close hands it to the card', () => {
    seed([task('a')]);
    render(<AtlasView />);
    fireEvent.click(within(card()).getByTestId('atlas-card-focus'));
    const scrim = screen.getByTestId('atlas-sheet-scrim');
    expect(fireEvent.mouseDown(scrim)).toBe(false);
    fireEvent.click(scrim);
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(card());
  });

  it('is named by its heading, with group headings one level under it', () => {
    seed([task('a'), task('b', { status: 'completed' })]);
    render(<AtlasView />);
    fireEvent.click(within(card()).getByTestId('atlas-card-focus'));
    const el = sheet()!;
    const h2 = el.querySelector('h2')!;
    expect(el.getAttribute('aria-labelledby')).toBe(h2.id);
    expect(h2.textContent).toBe('Work');
    expect([...el.querySelectorAll('h2, h3, h4, h5, h6')].map((h) => h.tagName)).toEqual(['H2', 'H3', 'H3']);
    const done = screen.getByTestId('atlas-sheet-done-button');
    expect(done.getAttribute('aria-keyshortcuts')).toBe('Escape');
    expect(done.querySelector('kbd')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('Escape with no sheet claims nothing, so the panel keeps its own', () => {
    seed([task('a')]);
    render(<AtlasView />);
    fireEvent.pointerDown(screen.getByTestId('atlas-surface'), { button: 0, pointerId: 1 });
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      root().dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
  });

  it('Escape works from the bare root, and is ignored from a text field or a key already taken', () => {
    seed([task('a')]);
    render(<AtlasView />);
    fireEvent.click(within(card()).getByTestId('atlas-card-focus'));
    // From a field inside the sheet: ignored.
    const input = document.createElement('input');
    sheet()!.appendChild(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(sheet()).toBeTruthy();
    input.remove();
    // A key someone else claimed first (a Radix menu, at the document): ignored.
    const claim = (e: Event) => e.preventDefault();
    document.addEventListener('keydown', claim, true);
    fireEvent.keyDown(sheet()!, { key: 'Escape' });
    document.removeEventListener('keydown', claim, true);
    expect(sheet()).toBeTruthy();
    // From the root itself (focused by a bare-canvas press earlier): closes.
    fireEvent.keyDown(root(), { key: 'Escape' });
    expect(sheet()).toBeNull();
  });

  it('closes from the scrim, the crumb and Done', () => {
    seed([task('a')]);
    render(<AtlasView />);
    for (const id of ['atlas-sheet-scrim', 'atlas-sheet-back', 'atlas-sheet-done-button']) {
      fireEvent.click(within(card()).getByTestId('atlas-card-focus'));
      expect(sheet()).toBeTruthy();
      fireEvent.click(screen.getByTestId(id));
      expect(sheet()).toBeNull();
    }
  });

  it('puts an undated next step on Today through the reschedule verb', () => {
    seed([task('a')]);
    render(<AtlasView />);
    fireEvent.click(within(card()).getByTestId('atlas-card-focus'));
    fireEvent.click(screen.getByTestId('atlas-sheet-today'));
    const a = usePlannerStore.getState().items.find((i) => i.id === 'a') as { startDate?: string };
    expect(a.startDate?.slice(0, 10)).toBe(TODAY);
    // On Today now, so it is no longer offered.
    expect(screen.queryByTestId('atlas-sheet-today')).toBeNull();
  });

  it('never offers Put on Today for a recurring next step or a milestone', () => {
    seed([task('r', { repeatFrequency: 'daily', startDate: '2026-07-01' } as Partial<Item>)]);
    render(<AtlasView />);
    fireEvent.click(within(card()).getByTestId('atlas-card-focus'));
    expect(within(sheet()!).getByTestId('atlas-sheet-next')).toBeTruthy();
    expect(screen.queryByTestId('atlas-sheet-today')).toBeNull();
    cleanup();
    useAtlasUiStore.getState().reset();

    seed([task('m', { project: undefined }), task('f', { project: undefined, status: 'completed' })]);
    usePlannerStore.setState({
      goals: [
        { id: 'g1', name: 'Ship', state: 'active', memberIds: ['f'], milestoneIds: ['m'], checkinIds: [] } as never,
      ],
    });
    enableExtensions(EXT_GOALS);
    render(<AtlasView />);
    const goalCard = card('goal:g1');
    expect(goalCard).toBeTruthy();
    fireEvent.click(within(goalCard).getByTestId('atlas-card-focus'));
    expect(rowsIn(within(sheet()!).getByTestId('atlas-sheet-milestones')).map((r) => r.dataset.itemId)).toEqual(['m']);
    expect(screen.queryByTestId('atlas-sheet-today')).toBeNull();
    disableExtensions(EXT_GOALS);
  });

  it('opens the container in Organize through the console door', () => {
    seed([task('a')]);
    render(<AtlasView />);
    fireEvent.click(within(card()).getByTestId('atlas-card-focus'));
    fireEvent.click(screen.getByTestId('atlas-sheet-organize'));
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'organize', section: 'projects', focusId: 'p1' });
  });

  it('closes when Atlas unmounts, so it never springs back on the next visit', () => {
    seed([task('a')]);
    const { unmount } = render(<AtlasView />);
    fireEvent.click(within(card()).getByTestId('atlas-card-focus'));
    unmount();
    expect(useAtlasUiStore.getState().sheet).toBeNull();
  });

  it('shows a subtask under its parent row', () => {
    seed([task('p'), task('s', { parentItemId: 'p' } as Partial<Item>)]);
    render(<AtlasView />);
    expect(rowsIn(card()).map((r) => r.dataset.itemId)).toEqual(['p']);
    fireEvent.click(within(card()).getByTestId('atlas-card-focus'));
    const sub = sheet()!.querySelector<HTMLElement>('[data-atlas-subtask-of="p"] [data-testid="atlas-row"]');
    expect(sub?.dataset.itemId).toBe('s');
  });

  it('grows by geometry, never opacity, when motion is allowed', () => {
    document.documentElement.removeAttribute('data-reduce-motion');
    seed([task('a'), task('b', { status: 'completed' })]);
    render(<AtlasView />);
    fireEvent.click(within(card()).getByTestId('atlas-card-focus'));
    const el = sheet()!;
    expect(el.dataset.phase).toBe('from');
    expect(el.style.transition).toMatch(/left/);
    const offenders = [root(), ...root().querySelectorAll('*')].filter((n) => {
      const cls = (n.getAttribute('class') ?? '').split(/\s+/);
      const bare = cls.some((c) => /(^|:)opacity-/.test(c) && !/^(disabled|data-\[disabled\]):/.test(c));
      return bare || /opacity\s*:/.test(n.getAttribute('style') ?? '');
    });
    expect(offenders.map((n) => n.outerHTML.slice(0, 120))).toEqual([]);
    // Closing shrinks it back before it goes.
    act(() => useAtlasUiStore.getState().closeSheet());
    expect(sheet()?.dataset.phase).toBe('leaving');
  });
});

describe('the layouts (PR2)', () => {
  afterEach(() => {
    useViewStore.setState({ atlasLayout: 'map', atlasHideFinished: false, atlasHideResting: false });
    document.documentElement.removeAttribute('data-reduce-motion');
  });

  it('glides on transform only, never opacity', () => {
    seed([task('a')]);
    render(<AtlasView />);
    const t = card().style.transition;
    expect(t).toBe(ATLAS_GLIDE);
    expect(t).toMatch(/^transform /);
    expect(t).not.toMatch(/opacity|all/);
  });

  it('turns the glide off under reduced motion', () => {
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    seed([task('a')]);
    render(<AtlasView />);
    expect(card().style.transition).toBe('');
  });

  it('a switch draws the new lanes and leaves an open item open', () => {
    seed([task('a', { startDate: TODAY }), task('b')]);
    render(<AtlasView />);
    fireEvent.click(rowsIn(card())[0]);
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item' });
    act(() => useViewStore.getState().setAtlasLayout('momentum'));
    expect(screen.getByTestId('atlas-view').dataset.atlasLayout).toBe('momentum');
    expect(document.querySelectorAll('[data-lane-kind="band"]')).toHaveLength(3);
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item' });
    // The card says why it sits where it does.
    expect(within(card()).getByTestId('atlas-reason').textContent).toBe(ATLAS_COPY.dueToday);
    act(() => useViewStore.getState().setAtlasLayout('timeline'));
    expect(screen.getAllByTestId('atlas-month').length).toBeGreaterThan(2);
    act(() => useViewStore.getState().setAtlasLayout('map'));
    expect(document.querySelectorAll('[data-atlas-lane]')).toHaveLength(0);
  });

  it('dims nothing by opacity in any layout', () => {
    seed([task('a'), task('b', { status: 'completed' })]);
    render(<AtlasView />);
    enableExtensions(EXT_GOALS);
    usePlannerStore.setState({ goals: [{ id: 'g1', name: 'Ship', state: 'active', memberIds: ['a'], milestoneIds: [], checkinIds: [] } as never] });
    for (const layout of ['momentum', 'goal', 'timeline', 'map'] as const) {
      act(() => useViewStore.getState().setAtlasLayout(layout));
      const root = document.querySelector('[data-atlas-root]')!;
      const offenders = [root, ...root.querySelectorAll('*')].filter((el) => {
        const cls = (el.getAttribute('class') ?? '').split(/\s+/);
        return cls.some((c) => /(^|:)opacity-/.test(c)) || /opacity\s*:/.test(el.getAttribute('style') ?? '');
      });
      expect(offenders.map((el) => el.outerHTML.slice(0, 120))).toEqual([]);
    }
  });

  it('Hide finished scales a finished card down, then unmounts it', async () => {
    seed([task('a', { status: 'completed' })]);
    render(<AtlasView />);
    expect(card()).toBeTruthy();
    act(() => useViewStore.getState().setAtlasHideFinished(true));
    const leaving = card();
    expect(leaving.dataset.leaving).toBe('true');
    expect(leaving.style.transform).toMatch(/scale\(\.96\)/);
    expect(leaving.style.transition).toMatch(/^transform /);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(card()).toBeNull();
  });

  it('a remembered By goal reads as Your map while Goals is off', () => {
    disableExtensions(EXT_GOALS);
    useViewStore.setState({ atlasLayout: 'goal' });
    seed([task('a')]);
    render(<AtlasView />);
    expect(screen.getByTestId('atlas-view').dataset.atlasLayout).toBe('map');
  });

  const TWO = [{ id: 'p1', name: 'Work', emoji: '' }, { id: 'p2', name: 'Home', emoji: '' }] as Project[];

  it('holds the computed layout after a tick, so a finished card stays under the pointer until it leaves', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(asDate(TODAY));
    seed([task('a'), task('c', { project: 'Home' })], TWO);
    useViewStore.setState({ atlasLayout: 'momentum', atlasHideFinished: true });
    render(<AtlasView />);
    const at = card().style.transform;
    const root = screen.getByTestId('atlas-view');
    const box = within(card()).getByTestId('atlas-row-check');
    fireEvent.pointerOver(box);
    fireEvent.click(box, { detail: 1 });
    // Its last step is done, so Hide finished would take it, but not under the pointer.
    expect(card().dataset.leaving).toBeUndefined();
    expect(card().style.transform).toBe(at);
    fireEvent.click(within(card()).getByTestId('atlas-row-check'), { detail: 2 });
    const status = (id: string) => (usePlannerStore.getState().items.find((i) => i.id === id) as { status: string }).status;
    expect(status('a')).toBe('completed');
    expect(status('c')).toBe('pending');
    // The hold is over but the pointer is still on the card: it stays.
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(card().dataset.leaving).toBeUndefined();
    // The pointer leaves: the filter applies and the card scales away.
    act(() => {
      fireEvent.pointerLeave(root);
    });
    expect(card().dataset.leaving).toBe('true');
  });

  it('Unpin hands focus to the card, never to <body>', () => {
    seed([task('a')]);
    useAtlasStore.setState({ places: { 'project:p1': { kind: 'project', id: 'p1', x: 0, y: 0, band: 'resting' } } });
    useViewStore.setState({ atlasLayout: 'momentum' });
    render(<AtlasView />);
    const unpin = within(card()).getByTestId('atlas-unpin');
    unpin.focus();
    fireEvent.click(unpin);
    expect(within(card()).queryByTestId('atlas-unpin')).toBeNull();
    expect(document.activeElement).toBe(card());
  });

  it('a Momentum drag lights the column it is over (never its own), and a drop outside springs back with a reason', () => {
    seed([task('a')]);
    useViewStore.setState({ atlasLayout: 'momentum' });
    render(<AtlasView />);
    const c = card();
    const slot = c.style.transform;
    const hot = () => document.querySelector('[data-hot="true"]')?.getAttribute('data-atlas-lane') ?? null;
    fireEvent.pointerDown(c, { button: 0, pointerId: 7, clientX: 400, clientY: 100 });
    // Within its own column (Soon): nothing lights.
    fireEvent.pointerMove(c, { pointerId: 7, clientX: 400, clientY: 300 });
    expect(hot()).toBeNull();
    // Over Now.
    fireEvent.pointerMove(c, { pointerId: 7, clientX: 70, clientY: 100 });
    expect(hot()).toBe('now');
    expect(c.style.transition).toBe('none');
    // Let go outside every column.
    fireEvent.pointerMove(c, { pointerId: 7, clientX: -2000, clientY: 100 });
    act(() => {
      fireEvent.pointerUp(c, { pointerId: 7, clientX: -2000, clientY: 100 });
    });
    expect(toast).toHaveBeenCalledWith(ATLAS_COPY.dropInColumn);
    expect(useAtlasStore.getState().places['project:p1']?.band ?? null).toBeNull();
    expect(card().style.transform).toBe(slot);
  });

  it('Escape cancels a drag: claims the key, writes nothing, springs back', () => {
    seed([task('a')]);
    useViewStore.setState({ atlasLayout: 'momentum' });
    render(<AtlasView />);
    const c = card();
    const slot = c.style.transform;
    fireEvent.pointerDown(c, { button: 0, pointerId: 8, clientX: 400, clientY: 100 });
    fireEvent.pointerMove(c, { pointerId: 8, clientX: 70, clientY: 100 });
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(esc);
    });
    expect(esc.defaultPrevented).toBe(true);
    expect(card().style.transform).toBe(slot);
    expect(document.querySelector('[data-hot="true"]')).toBeNull();
    act(() => {
      fireEvent.pointerUp(c, { pointerId: 8, clientX: 70, clientY: 100 });
    });
    expect(useAtlasStore.getState().places['project:p1']?.band ?? null).toBeNull();
    expect(card().style.transform).toBe(slot);
  });

  it('tabs in reading order for the layout shown, and names the column', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(asDate(TODAY));
    // Work is undated (Soon); Home has a step today (Now).
    seed([task('a'), task('c', { project: 'Home', startDate: TODAY })], TWO);
    render(<AtlasView />);
    const order = () => [...document.querySelectorAll('[data-atlas-card]')].map((el) => el.getAttribute('data-atlas-card'));
    expect(order()).toEqual(['project:p1', 'project:p2']);
    act(() => useViewStore.getState().setAtlasLayout('momentum'));
    // The DOM moves only once the glide is over.
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(order()).toEqual(['project:p2', 'project:p1']);
    expect(card('project:p2').getAttribute('aria-label')).toMatch(new RegExp(`, in ${ATLAS_COPY.bandNow}$`));
    expect(card('project:p1').getAttribute('aria-label')).toMatch(new RegExp(`, in ${ATLAS_COPY.bandSoon}$`));
  });

  it('Momentum menus offer the other columns, and Unpin on a pinned card', () => {
    seed([task('a')]);
    useAtlasStore.setState({ places: { 'project:p1': { kind: 'project', id: 'p1', x: 0, y: 0, band: 'resting' } } });
    useViewStore.setState({ atlasLayout: 'momentum' });
    render(<AtlasView />);
    expect(card().dataset.pinned).toBe('true');
    expect(within(card()).getByTestId('atlas-unpin')).toBeTruthy();
    rightClick(within(card()).getByTestId('atlas-card-header'));
    expect(screen.getByTestId('container-menu-pin-now')).toBeTruthy();
    expect(screen.getByTestId('container-menu-pin-soon')).toBeTruthy();
    expect(screen.queryByTestId('container-menu-pin-resting')).toBeNull();
    fireEvent.click(screen.getByTestId('container-menu-unpin'));
    expect(useAtlasStore.getState().places['project:p1']?.band ?? null).toBeNull();
  });

  it('a press on a menu row is not a press on the board (the menu is portalled)', () => {
    seed([task('a')]);
    useViewStore.setState({ atlasLayout: 'momentum' });
    render(<AtlasView />);
    rightClick(within(card()).getByTestId('atlas-card-header'));
    const row = screen.getByTestId('container-menu-pin-resting');
    const before = useAtlasUiStore.getState().camera;
    // React bubbles the row's press through the portal to the surface; it must
    // not start a pan (which captures the pointer and steals the row's click).
    fireEvent.pointerDown(row, { pointerId: 3, button: 0, buttons: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(screen.getByTestId('atlas-surface'), { pointerId: 3, buttons: 1, clientX: 90, clientY: 90 });
    expect(useAtlasUiStore.getState().camera).toEqual(before);
    fireEvent.pointerUp(row, { pointerId: 3, button: 0, clientX: 50, clientY: 50 });
    fireEvent.click(row);
    expect(useAtlasStore.getState().places['project:p1']?.band).toBe('resting');
  });
});
