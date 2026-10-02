import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * rail-store's stack half (C1): the views beneath the item, the one pending
 * focus request, and the composers' half-typed text. The rail's own half
 * (summon, park, railMode) is C2's and is pinned there.
 *
 * So is the `returnTo` back label ("‹ <the item's live title>", else the view
 * beneath once the item is renamed or deleted): it is RailHeader's, which
 * nothing renders before C2. C2 adds it as a pure `backLabel(view, beneath,
 * items)` and pins it here and in rail-desktop.test.tsx.
 */

const planner = vi.hoisted(() => ({ items: [] as { id: string; type: string; title: string }[] }));
vi.mock('@/lib/planner-store', () => ({
  usePlannerStore: { getState: () => ({ items: planner.items }) },
}));

import { ASK_LEVEL, bindingKey, useRailStore, type AskView } from '@/lib/rail-store';
import { useProposalStore } from '@/lib/proposal-store';
import { useUIStore } from '@/lib/ui-store';

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
