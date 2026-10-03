import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, renderHook } from '@testing-library/react';

/**
 * rail-store. The stack half (C1): the views beneath the item, the one pending
 * focus request, and the composers' half-typed text. The rail half (C2): the
 * one visibility rule (`railMode`), summon / park / closeRail, the reserve,
 * the reveal request, and the back label (`backLabel`, which RailHeader
 * renders; rail-desktop.test.tsx pins it on screen).
 */

const planner = vi.hoisted(() => ({ items: [] as { id: string; type: string; title: string }[] }));
vi.mock('@/lib/planner-store', () => ({
  usePlannerStore: { getState: () => ({ items: planner.items }) },
}));

import {
  ASK_LEVEL,
  PANEL_OVERLAY_QUERY,
  RAIL_RESERVE_PX,
  backLabel,
  bindingKey,
  clearRailFocusRecord,
  noteRailEntry,
  railMode,
  railModeNow,
  usePanelOverlays,
  useRailMode,
  useRailCovers,
  useRailStore,
  type AskView,
} from '@/lib/rail-store';
import { useProposalStore } from '@/lib/proposal-store';
import { useUIStore } from '@/lib/ui-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useViewStore } from '@/lib/view-store';
import { CONNECTED_MODEL, NOTHING_CONNECTED, seedAI } from './helpers/ai-fixtures';

const rail = () => useRailStore.getState();
const history: AskView = { kind: 'history' };
const conv = (id: string, o: Partial<Extract<AskView, { kind: 'conversation' }>> = {}): AskView => ({
  kind: 'conversation',
  id,
  ...o,
});
const item = (itemId: string): AskView => ({ kind: 'item', itemId });

/** A proposal card raised from this surface, as proposal-store records it. */
function cardOn(surface: string) {
  useProposalStore.setState({
    status: 'ready',
    lastRequest: { intent: 'ask', surface } as never,
  });
}

const realDismiss = useProposalStore.getState().dismiss;
function stubDismiss() {
  const dismiss = vi.fn();
  useProposalStore.setState({ dismiss });
  return dismiss;
}

beforeEach(() => {
  useProposalStore.setState({ dismiss: realDismiss });
  rail().reset();
  planner.items = [];
  useUIStore.setState({ activeDialog: null });
  useProposalStore.setState({ status: 'idle', lastRequest: null });
});

describe('the level rule', () => {
  const VIEWS: AskView[] = [history, conv('c1'), item('i1')];
  const orders = (arr: AskView[]): AskView[][] =>
    arr.length <= 1 ? [arr] : arr.flatMap((v, i) => orders([...arr.slice(0, i), ...arr.slice(i + 1)]).map((o) => [v, ...o]));

  it.each(orders(VIEWS).map((o) => [o.map((v) => v.kind).join(' → '), o]))(
    'pushing %s leaves an ordered subset of [history, conversation, item]',
    (_label, order) => {
      for (const v of order as AskView[]) rail().push('phone', v);
      const stack = rail().stacks.phone;
      const levels = stack.map((v) => ASK_LEVEL[v.kind]);
      expect([...levels].sort()).toEqual(levels);
      expect(new Set(levels).size).toBe(levels.length);
      // The last push is always on top.
      expect(stack.at(-1)).toEqual((order as AskView[]).at(-1));
    }
  );

  it('replaces a view at its own level instead of stacking it', () => {
    rail().push('desktop', history);
    rail().push('desktop', conv('c1'));
    rail().push('desktop', conv('c2'));
    expect(rail().stacks.desktop).toEqual([history, conv('c2')]);
  });

  it('keeps the two surfaces apart', () => {
    rail().push('desktop', conv('c1'));
    expect(rail().stacks.phone).toEqual([]);
  });
});

describe('back', () => {
  it('pops the top, and goes no lower than home', () => {
    rail().push('desktop', history);
    rail().push('desktop', conv('c1'));
    rail().back('desktop');
    expect(rail().stacks.desktop).toEqual([history]);
    expect(rail().lastNav).toBe('back');
    rail().back('desktop');
    rail().back('desktop');
    expect(rail().stacks.desktop).toEqual([]);
  });

  it('re-opens the item a "?" was asked over, if it still exists', () => {
    planner.items = [{ id: 'i1', type: 'task', title: 'Book the dentist' }];
    rail().push('desktop', conv('c1', { returnTo: { itemId: 'i1' } }));
    rail().back('desktop');
    expect(rail().stacks.desktop).toEqual([]);
    const slot = useUIStore.getState().activeDialog;
    expect(slot).toMatchObject({ type: 'edit-item', item: { id: 'i1', type: 'task' } });
  });

  it('opens nothing when that item has been deleted', () => {
    rail().push('desktop', conv('c1', { returnTo: { itemId: 'gone' } }));
    rail().back('desktop');
    expect(useUIStore.getState().activeDialog).toBeNull();
  });

  it('popToHome empties one surface', () => {
    rail().push('desktop', history);
    rail().push('phone', history);
    rail().popToHome('desktop');
    expect(rail().stacks).toEqual({ desktop: [], phone: [history] });
  });
});

describe('leaveConversation and rebindConversation', () => {
  it('drops a deleted conversation from both stacks, and the views beneath show', () => {
    rail().push('desktop', history);
    rail().push('desktop', conv('c1'));
    rail().push('phone', conv('c1'));
    rail().leaveConversation('c1');
    expect(rail().stacks).toEqual({ desktop: [history], phone: [] });
  });

  it('moves a draft to its real id everywhere: views, draft text, a pending focus', () => {
    rail().push('desktop', conv('draft'));
    rail().push('phone', history);
    rail().push('phone', conv('draft'));
    rail().setDraft(bindingKey({ kind: 'draft', id: 'draft' }), 'half typed');
    rail().focusComposer({ kind: 'draft', id: 'draft' });

    rail().rebindConversation('draft', 'real');

    expect(rail().stacks).toEqual({ desktop: [conv('real')], phone: [history, conv('real')] });
    expect(rail().drafts).toEqual({ 'conv:real': 'half typed' });
    expect(rail().pendingFocus).toEqual({ target: 'composer', binding: { kind: 'draft', id: 'real' } });
  });

  it('keeps a card through a rebind: it is the same conversation', () => {
    const dismiss = stubDismiss();
    rail().push('desktop', conv('draft'));
    cardOn('conv:draft');
    rail().rebindConversation('draft', 'real');
    expect(dismiss).not.toHaveBeenCalled();
  });
});

describe('pendingFocus', () => {
  it('is consumed once, by the field it names', () => {
    rail().focusComposer({ kind: 'conversation', id: 'c1' });
    expect(rail().consumeFocus('composer', { kind: 'home' })).toBe(false);
    expect(rail().consumeFocus('history-search')).toBe(false);
    expect(rail().consumeFocus('composer', { kind: 'conversation', id: 'c1' })).toBe(true);
    // A later mount does not take focus.
    expect(rail().consumeFocus('composer', { kind: 'conversation', id: 'c1' })).toBe(false);
  });

  it('a request naming no binding goes to whichever composer mounts first', () => {
    rail().focusComposer();
    expect(rail().consumeFocus('composer', { kind: 'item', itemId: 'i1' })).toBe(true);
    expect(rail().pendingFocus).toBeNull();
  });

  it('History search has its own request', () => {
    rail().requestFocus({ target: 'history-search' });
    expect(rail().consumeFocus('composer')).toBe(false);
    expect(rail().consumeFocus('history-search')).toBe(true);
  });
});

describe('composer drafts', () => {
  it('are kept per binding, across an unmount, until cleared', () => {
    rail().setDraft('home', 'for home');
    rail().setDraft(bindingKey({ kind: 'item', itemId: 'i1' }), 'for the item');
    expect(rail().drafts).toEqual({ home: 'for home', 'item:i1': 'for the item' });
    rail().setDraft('home', '');
    expect(rail().drafts).toEqual({ 'item:i1': 'for the item' });
  });

  it('a draft and the conversation it becomes share one key', () => {
    expect(bindingKey({ kind: 'draft', id: 'x' })).toBe(bindingKey({ kind: 'conversation', id: 'x' }));
  });
});

describe("a conversation's proposal card", () => {
  it('is dismissed when its conversation leaves both stacks, and only then', () => {
    const dismiss = stubDismiss();
    rail().push('desktop', conv('c1'));
    rail().push('phone', conv('c1'));
    cardOn('conv:c1');

    // An item over it, or Back on one surface: still on the other.
    rail().push('desktop', item('i1'));
    rail().back('desktop');
    rail().back('desktop');
    expect(dismiss).not.toHaveBeenCalled();

    rail().back('phone');
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("never touches another surface's card", () => {
    const dismiss = stubDismiss();
    rail().push('desktop', conv('c1'));
    cardOn('item:i1');
    rail().back('desktop');
    cardOn('conv:c2');
    rail().push('desktop', conv('c1'));
    rail().leaveConversation('c1');
    expect(dismiss).not.toHaveBeenCalled();
  });
});

describe('reset', () => {
  it('sends both stacks home and forgets focus and drafts', () => {
    rail().push('desktop', conv('c1'));
    rail().push('phone', history);
    rail().focusComposer();
    rail().setDraft('home', 'x');
    rail().reset();
    expect(rail()).toMatchObject({ stacks: { desktop: [], phone: [] }, pendingFocus: null, drafts: {}, lastNav: null });
  });
});

/* ── C2: the rail half ──────────────────────────────────────────────────── */

/**
 * Stands in for the viewport: PANEL_OVERLAY_QUERY matches while `narrow`, and
 * a flip notifies every listener the way a real MediaQueryList does.
 */
const viewport = vi.hoisted(() => ({ narrow: false, listeners: new Set<() => void>() }));
const realMatchMedia = window.matchMedia;
function installViewport() {
  window.matchMedia = ((query: string) =>
    ({
      matches: query === PANEL_OVERLAY_QUERY && viewport.narrow,
      media: query,
      onchange: null,
      addEventListener: (_: string, fn: () => void) => viewport.listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => viewport.listeners.delete(fn),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}
function setNarrow(narrow: boolean) {
  viewport.narrow = narrow;
  for (const fn of [...viewport.listeners]) fn();
}

describe('railMode, the one visibility rule', () => {
  const B = [false, true];
  const cases = B.flatMap((itemOpen) =>
    B.flatMap((askOpen) =>
      B.flatMap((canChat) =>
        B.flatMap((overlays) => B.map((summoned) => ({ itemOpen, askOpen, canChat, overlays, summoned })))
      )
    )
  );

  it.each(cases.map((c) => [JSON.stringify(c), c]))('%s', (_label, c) => {
    const i = c as (typeof cases)[number];
    const expected = i.itemOpen
      ? 'item'
      : (i.askOpen || i.summoned) && i.canChat && (!i.overlays || i.summoned)
        ? 'ask'
        : 'hidden';
    expect(railMode(i)).toBe(expected);
  });

  it('an open item is the column, with or without AI', () => {
    expect(railMode({ itemOpen: true, askOpen: false, canChat: false, overlays: true, summoned: false })).toBe('item');
  });

  it('with nothing to answer there is no Ask, whatever was kept or summoned', () => {
    expect(railMode({ itemOpen: false, askOpen: true, canChat: false, overlays: false, summoned: true })).toBe('hidden');
  });

  it('never an overlay at boot: a persisted askOpen alone does not raise one', () => {
    expect(railMode({ itemOpen: false, askOpen: true, canChat: true, overlays: true, summoned: false })).toBe('hidden');
    expect(railMode({ itemOpen: false, askOpen: true, canChat: true, overlays: false, summoned: false })).toBe('ask');
  });
});

describe('PANEL_OVERLAY_QUERY, the one overlay breakpoint', () => {
  /*
   * JS and CSS must agree on which side of the line every width falls: the
   * column's classes decide where it lays out, and this query decides whether
   * <main> goes inert, the braindump yields, the bulk bar stands down and
   * Escape parks. `(max-width: 1180px)` matched AT 1180 while the column's
   * `max-[1180px]:` did not, so at exactly 1180 the planner sat in plain view
   * beside a docked column, inert.
   */
  it('excludes the breakpoint itself, as Tailwind compiles max-[1180px]:', () => {
    expect(PANEL_OVERLAY_QUERY).toBe('not all and (min-width: 1180px)');
  });

  it("is the same breakpoint as every overlay class on the column, and the column's only one", () => {
    const src = readFileSync(path.resolve(__dirname, '../../components/shell/desktop-shell.tsx'), 'utf8');
    const px = PANEL_OVERLAY_QUERY.match(/\(min-width: (\d+)px\)/)?.[1];
    expect(px).toBe('1180');
    const variants = new Set(src.match(/\bmax-\[\d+px\]:/g) ?? []);
    expect([...variants]).toEqual([`max-[${px}px]:`]);
    // The overlay's positioning, card and shadow all ride on it.
    for (const cls of ['absolute', 'z-30', 'bg-canvas', 'box-content']) {
      expect(src).toContain(`max-[${px}px]:${cls}`);
    }
  });
});

describe('summon, park, closeRail', () => {
  let unseed: () => void = () => {};
  beforeEach(() => {
    installViewport();
    setNarrow(false);
    unseed = seedAI(CONNECTED_MODEL);
    useSidebarStore.setState({ askOpen: true });
    useViewStore.setState({ zenOpen: false, zenMoving: false });
  });
  afterEach(() => {
    unseed();
    window.matchMedia = realMatchMedia;
    viewport.listeners.clear();
    useSidebarStore.setState({ askOpen: true });
  });

  it('Ask rests open when docked, from the persisted askOpen alone', () => {
    expect(rail().summoned).toBe(false);
    expect(railModeNow()).toBe('ask');
  });

  it('summon keeps Ask open (persisted) and summoned; closeRail turns both off', () => {
    useSidebarStore.setState({ askOpen: false });
    expect(railModeNow()).toBe('hidden');
    rail().summon();
    expect(useSidebarStore.getState().askOpen).toBe(true);
    expect(rail().summoned).toBe(true);
    expect(railModeNow()).toBe('ask');
    // No focus request unless asked for.
    expect(rail().pendingFocus).toBeNull();

    rail().closeRail();
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(rail().summoned).toBe(false);
    expect(railModeNow()).toBe('hidden');
  });

  it("summon({persist:false}) (the tour) shows Ask without writing askOpen, and park() hides it again", () => {
    useSidebarStore.setState({ askOpen: false });
    rail().summon({ persist: false });
    expect(railModeNow()).toBe('ask');
    expect(useSidebarStore.getState().askOpen).toBe(false);
    rail().park();
    expect(railModeNow()).toBe('hidden');
    expect(useSidebarStore.getState().askOpen).toBe(false);
  });

  it('park leaves a docked Ask the user keeps open where it is', () => {
    rail().summon();
    rail().park();
    expect(useSidebarStore.getState().askOpen).toBe(true);
    expect(railModeNow()).toBe('ask');
  });

  it('summon({focus}) asks for the box; summon({home}) pops the desktop stack', () => {
    rail().push('desktop', history);
    rail().push('phone', history);
    rail().summon({ focus: true, home: true });
    expect(rail().pendingFocus).toEqual({ target: 'composer' });
    expect(rail().stacks).toEqual({ desktop: [], phone: [history] });
  });

  it('below 1180px Ask shows only when summoned there, and a park gives the planner back', () => {
    setNarrow(true);
    // Kept open, but not summoned this session: no overlay.
    expect(railModeNow()).toBe('hidden');
    rail().summon({ focus: true });
    expect(railModeNow()).toBe('ask');
    rail().park();
    expect(railModeNow()).toBe('hidden');
    expect(useSidebarStore.getState().askOpen).toBe(true);
  });

  it('an item open on top is the column at every width', () => {
    useUIStore.setState({ activeDialog: { type: 'edit-item', item: { id: 'i1' } as never } });
    expect(railModeNow()).toBe('item');
    setNarrow(true);
    expect(railModeNow()).toBe('item');
  });

  it('with nothing to answer the column is only ever the item', () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    rail().summon();
    expect(railModeNow()).toBe('hidden');
  });

  it('Zen replaces the shell, so nothing shows there whatever the stores say', () => {
    useViewStore.setState({ zenOpen: true });
    expect(railModeNow()).toBe('hidden');
  });

  describe('focus across a summon', () => {
    function mount() {
      const outside = document.createElement('input');
      const column = document.createElement('div');
      column.setAttribute('data-rail', '');
      const box = document.createElement('textarea');
      column.appendChild(box);
      document.body.append(outside, column);
      return { outside, box, done: () => { outside.remove(); column.remove(); } };
    }

    it('closing hands focus back to what held it before the summon that opened Ask', async () => {
      useSidebarStore.setState({ askOpen: false });
      const { outside, box, done } = mount();
      outside.focus();
      rail().summon({ focus: true });
      box.focus();
      rail().closeRail();
      await new Promise((r) => setTimeout(r, 0));
      expect(document.activeElement).toBe(outside);
      done();
    });

    it('a summon while Ask already shows does not move the target', async () => {
      useSidebarStore.setState({ askOpen: false });
      const { outside, box, done } = mount();
      const other = document.createElement('button');
      document.body.appendChild(other);
      outside.focus();
      rail().summon();
      other.focus();
      rail().summon({ focus: true });
      box.focus();
      rail().closeRail();
      await new Promise((r) => setTimeout(r, 0));
      expect(document.activeElement).toBe(outside);
      other.remove();
      done();
    });

    it('leaves focus that is already outside the rail where it is', async () => {
      useSidebarStore.setState({ askOpen: false });
      const { outside, done } = mount();
      const elsewhere = document.createElement('button');
      document.body.appendChild(elsewhere);
      outside.focus();
      rail().summon();
      elsewhere.focus();
      rail().closeRail();
      await new Promise((r) => setTimeout(r, 0));
      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
      done();
    });

    const tick = () => new Promise((r) => setTimeout(r, 0));

    it('yields to a return that lands before it: the item panel handing focus to its row', async () => {
      useSidebarStore.setState({ askOpen: false });
      const { outside, box, done } = mount();
      const row = document.createElement('button');
      document.body.appendChild(row);
      outside.focus();
      rail().summon({ focus: true });
      box.focus();
      rail().closeRail();
      // ItemDialog's restore runs in the commit, before the hand-back's timer.
      row.focus();
      await tick();
      expect(document.activeElement).toBe(row);
      row.remove();
      done();
    });

    it('never answers a later close with a record from an earlier open', async () => {
      useSidebarStore.setState({ askOpen: false });
      const { outside, box, done } = mount();
      const canvas = document.createElement('button');
      document.body.appendChild(canvas);
      // Opened from `outside`, closed while focus was elsewhere: nothing handed back…
      outside.focus();
      rail().summon({ focus: true });
      canvas.focus();
      rail().closeRail();
      await tick();
      // …then opened from nowhere, and closed from inside the rail.
      canvas.blur();
      rail().summon({ focus: true });
      box.focus();
      rail().closeRail();
      await tick();
      expect(document.activeElement).not.toBe(outside);
      canvas.remove();
      done();
    });

    it('spends the record on a close that hands nothing back', async () => {
      useSidebarStore.setState({ askOpen: false });
      const { outside, box, done } = mount();
      const canvas = document.createElement('button');
      document.body.appendChild(canvas);
      outside.focus();
      rail().summon({ focus: true });
      canvas.focus();
      rail().closeRail();
      await tick();
      // Shown again from inside the column (an item's Back): no summon notes
      // anything, so a record kept from before would answer this close.
      box.focus();
      rail().summon();
      rail().closeRail();
      await tick();
      expect(document.activeElement).toBe(box);
      canvas.remove();
      done();
    });

    it('a summon from <body> drops an older record', async () => {
      const { outside, box, done } = mount();
      outside.focus();
      noteRailEntry(outside);
      useSidebarStore.setState({ askOpen: false });
      outside.blur();
      rail().summon({ focus: true });
      box.focus();
      rail().closeRail();
      await tick();
      expect(document.activeElement).not.toBe(outside);
      done();
    });

    it('notes where focus came from into the rail, for an Ask open from boot', async () => {
      const { outside, box, done } = mount();
      // No summon: Ask rests open. Focus enters the box from `outside`.
      outside.focus();
      noteRailEntry(outside);
      box.focus();
      rail().closeRail();
      await tick();
      expect(document.activeElement).toBe(outside);
      done();
    });

    it('ignores an entry from nowhere or from inside the rail', async () => {
      const { outside, box, done } = mount();
      noteRailEntry(outside);
      noteRailEntry(null);
      noteRailEntry(document.body);
      noteRailEntry(box);
      box.focus();
      rail().closeRail();
      await tick();
      expect(document.activeElement).toBe(outside);
      done();
    });

    it('forgets the record once the column hides by another path', async () => {
      const { outside, box, done } = mount();
      noteRailEntry(outside);
      clearRailFocusRecord();
      box.focus();
      rail().closeRail();
      await tick();
      expect(document.activeElement).toBe(box);
      done();
    });

    it('parking an overlay hands focus back as closing does', async () => {
      setNarrow(true);
      const { outside, box, done } = mount();
      outside.focus();
      rail().summon({ focus: true });
      box.focus();
      rail().park();
      await tick();
      expect(document.activeElement).toBe(outside);
      done();
    });

    it('a park that leaves a docked Ask showing moves nothing, and keeps the record', async () => {
      useSidebarStore.setState({ askOpen: false });
      const { outside, box, done } = mount();
      outside.focus();
      rail().summon({ focus: true });
      box.focus();
      rail().park();
      await tick();
      expect(document.activeElement).toBe(box);
      rail().closeRail();
      await tick();
      expect(document.activeElement).toBe(outside);
      done();
    });

    it('Back onto the item a "?" was asked over gives it the focus the rail held', () => {
      planner.items = [{ id: 'i1', type: 'task', title: 'Book the dentist' }];
      const { outside, box, done } = mount();
      const token = () => useUIStore.getState().itemPanelFocusToken;

      rail().push('desktop', conv('c1', { returnTo: { itemId: 'i1' } }));
      box.focus();
      const before = token();
      rail().back('desktop');
      expect(token()).toBe(before + 1);

      // From the canvas, it is the canvas's focus: left alone.
      useUIStore.setState({ activeDialog: null });
      rail().push('desktop', conv('c1', { returnTo: { itemId: 'i1' } }));
      outside.focus();
      rail().back('desktop');
      expect(token()).toBe(before + 1);
      done();
    });
  });

  describe('the hooks', () => {
    it('useRailCovers never re-renders a docked reader: not for an open, a close, a push or a draft', () => {
      // DesktopShell's one rail read. Docked, a Ctrl+J opens and closes the
      // column; the shell, its braindump and its day must not hear of it.
      let renders = 0;
      useSidebarStore.setState({ askOpen: false });
      const { result } = renderHook(() => {
        renders += 1;
        return useRailCovers(false);
      });
      expect(result.current).toBe(false);
      const base = renders;

      act(() => {
        rail().summon();
        rail().push('desktop', history);
        rail().setDraft('home', 'typing');
        rail().setReserve(RAIL_RESERVE_PX);
      });
      act(() => useUIStore.setState({ activeDialog: { type: 'edit-item', item: { id: 'i1' } as never } }));
      act(() => {
        useUIStore.setState({ activeDialog: null });
        rail().closeRail();
      });
      expect(result.current).toBe(false);
      expect(renders).toBe(base);
    });

    it('useRailCovers is the overlay showing, and re-renders only when that flips', () => {
      let renders = 0;
      useSidebarStore.setState({ askOpen: false });
      const { result } = renderHook(() => {
        renders += 1;
        return useRailCovers(true);
      });
      expect(result.current).toBe(false);
      act(() => {
        rail().push('desktop', history);
        rail().setDraft('home', 'typing');
      });
      act(() => rail().summon());
      expect(result.current).toBe(true);
      const shown = renders;
      // Still covering: an item over Ask is a different mode, not a different answer.
      act(() => useUIStore.setState({ activeDialog: { type: 'edit-item', item: { id: 'i1' } as never } }));
      expect(result.current).toBe(true);
      expect(renders).toBe(shown);
      act(() => {
        useUIStore.setState({ activeDialog: null });
        rail().park();
      });
      expect(result.current).toBe(false);
    });

    it('useRailMode follows the stores and the overlay reading it is given', () => {
      const { result, rerender } = renderHook(({ overlays }) => useRailMode(overlays), {
        initialProps: { overlays: false },
      });
      expect(result.current).toBe('ask');
      rerender({ overlays: true });
      expect(result.current).toBe('hidden');
      act(() => rail().summon());
      expect(result.current).toBe('ask');
      act(() => useUIStore.setState({ activeDialog: { type: 'edit-item', item: { id: 'i1' } as never } }));
      expect(result.current).toBe('item');
    });

    it('usePanelOverlays follows the query', () => {
      const { result } = renderHook(() => usePanelOverlays());
      expect(result.current).toBe(false);
      act(() => setNarrow(true));
      expect(result.current).toBe(true);
    });
  });
});

describe('the reserve, the reveal request, reset', () => {
  it('reservePx is a non-negative width, and a sign-out leaves it (it is layout)', () => {
    rail().setReserve(RAIL_RESERVE_PX);
    expect(rail().reservePx).toBe(432);
    rail().reset();
    expect(rail().reservePx).toBe(432);
    rail().setReserve(Number.NaN);
    expect(rail().reservePx).toBe(0);
    rail().setReserve(-5);
    expect(rail().reservePx).toBe(0);
  });

  it('reserveInstant says how the last reserve change came, and only a change sets it', () => {
    rail().setReserve(0);
    rail().setReserve(RAIL_RESERVE_PX, { instant: true });
    expect(rail()).toMatchObject({ reservePx: 432, reserveInstant: true });
    // The column re-publishing the same reserve once its transition is back is
    // no change, so it leaves the boot reveal's flag as it was.
    rail().setReserve(RAIL_RESERVE_PX);
    expect(rail().reserveInstant).toBe(true);
    rail().setReserve(0);
    expect(rail()).toMatchObject({ reservePx: 0, reserveInstant: false });
    rail().setReserve(RAIL_RESERVE_PX);
    expect(rail()).toMatchObject({ reservePx: 432, reserveInstant: false });
    rail().setReserve(0);
  });

  it('covers is what the column publishes, and a sign-out leaves it (it is layout)', () => {
    expect(rail().covers).toBe(false);
    rail().setCovers(true);
    expect(rail().covers).toBe(true);
    rail().reset();
    expect(rail().covers).toBe(true);
    rail().setCovers(false);
    expect(rail().covers).toBe(false);
  });

  it('pendingReveal is consumed once, by the item it names', () => {
    rail().setPendingReveal('i1');
    expect(rail().consumeReveal('i2')).toBe(false);
    expect(rail().consumeReveal('i1')).toBe(true);
    expect(rail().consumeReveal('i1')).toBe(false);
  });

  it('reset also un-summons and drops a reveal', () => {
    rail().summon({ persist: false });
    rail().setPendingReveal('i1');
    rail().reset();
    expect(rail()).toMatchObject({ summoned: false, pendingReveal: null, pendingFocus: null });
  });
});

describe('backLabel', () => {
  const items = [{ id: 'i1', title: 'Book the dentist' }];
  const titles: Record<string, string> = { c1: 'Plan my day' };
  const title = (id: string) => titles[id];

  it('names the view beneath: Ask over home, History over History, the title over a conversation', () => {
    expect(backLabel(null, undefined, items, title)).toBe('Ask');
    expect(backLabel(null, history, items, title)).toBe('History');
    expect(backLabel(null, conv('c1'), items, title)).toBe('Plan my day');
    expect(backLabel(conv('c2'), history, items, title)).toBe('History');
    expect(backLabel(history, undefined, items, title)).toBe('Ask');
  });

  it('a conversation nobody has named yet is a new chat', () => {
    expect(backLabel(null, conv('draft'), items, title)).toBe('New chat');
    expect(backLabel(null, conv('c1'), items)).toBe('New chat');
  });

  it("a conversation asked over an item names the item, by its LIVE title", () => {
    const asked = conv('c2', { returnTo: { itemId: 'i1' } });
    expect(backLabel(asked, undefined, items, title)).toBe('Book the dentist');
    // Renamed: the new title, read from the store, not a copy taken at the ask.
    expect(backLabel(asked, history, [{ id: 'i1', title: 'Book the hygienist' }], title)).toBe('Book the hygienist');
  });

  it('falls back to the view beneath once that item is deleted, so it never promises a dead item', () => {
    const asked = conv('c2', { returnTo: { itemId: 'i1' } });
    expect(backLabel(asked, undefined, [], title)).toBe('Ask');
    expect(backLabel(asked, history, [], title)).toBe('History');
    // A blank title is no name to go back to either.
    expect(backLabel(asked, undefined, [{ id: 'i1', title: '  ' }], title)).toBe('Ask');
  });

  it('agrees with back(): the label names the item exactly when Back would reopen it', () => {
    const asked = conv('c2', { returnTo: { itemId: 'i1' } });
    for (const present of [true, false]) {
      planner.items = present ? [{ id: 'i1', type: 'task', title: 'Book the dentist' }] : [];
      useUIStore.setState({ activeDialog: null });
      rail().reset();
      rail().push('desktop', asked);
      const label = backLabel(asked, undefined, planner.items, title);
      rail().back('desktop');
      const reopened = useUIStore.getState().activeDialog?.type === 'edit-item';
      expect(reopened).toBe(present);
      expect(label).toBe(present ? 'Book the dentist' : 'Ask');
    }
  });
});
