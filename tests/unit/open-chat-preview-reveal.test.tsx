import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, renderHook } from '@testing-library/react';

/**
 * An item's conversation opened on desktop while the planner is the look-only
 * preview (lib/open-chat.ts openConversation, askAboutItem).
 *
 * The item's open is HELD then (lib/ui-store.ts defers it), and the landing
 * may drop it (hooks/use-deferred-dialog.ts): a busy slot, a failed load, the
 * row gone. The reveal that scrolls the item's panel to its conversation
 * (rail-store `pendingReveal`) is armed only once that very open is promoted.
 * Armed up front, a dropped open left it waiting, and the item's NEXT open,
 * from a row minutes later, scrolled to the conversation unasked.
 *
 * The real ui, rail, planner and conversations stores, the real promoter, and
 * the pinned ItemConversation the desktop panel renders (it takes the reveal
 * as it mounts).
 */

vi.mock('@/lib/ai-context', () => ({ buildDsulContext: () => '## dsul Context' }));

import { askAboutItem, openConversation, openSetup } from '@/lib/open-chat';
import { clearChatState, configureConversations, conversationsSettled, useConversationsStore } from '@/lib/conversations-store';
import { useRailStore } from '@/lib/rail-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { openAddDialog, openBulkAdd, openEditFor, useUIStore } from '@/lib/ui-store';
import { useViewStore } from '@/lib/view-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useDeferredDialogPromotion } from '@/hooks/use-deferred-dialog';
import { ItemConversation } from '@/components/ai/item-conversation';
import type { Item, Task } from '@/lib/planner-types';
import { CONNECTED_MODEL, KEY_TURNED_DOWN, NOTHING_CONNECTED, seedAI } from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, summary } from './helpers/conversations-fakes';

const A = 'user-a';
const task = (id: string, title: string): Item =>
  ({ type: 'task', id, title, status: 'pending', isScheduled: false, order: 0, completedDates: [] }) as Item;

function previewing() {
  const items = [task('i1', 'Cached title'), task('i2', 'Another')];
  usePlannerStore.setState({
    userId: A,
    isLoading: true,
    isPreview: true,
    error: null,
    loadFailedUserId: null,
    items,
    tasks: items as never,
    habits: [] as never,
  } as never);
}

function landFresh() {
  const items = [task('i1', 'Fresh title'), task('i2', 'Another')];
  usePlannerStore.setState({
    userId: A,
    isLoading: false,
    isPreview: false,
    error: null,
    loadFailedUserId: null,
    items,
    tasks: items as never,
    habits: [] as never,
  } as never);
}

const ui = () => useUIStore.getState();
const rail = () => useRailStore.getState();
const seedConversation = (id: string, itemId: string) =>
  useConversationsStore.setState((s) => ({ summaries: { ...s.summaries, [id]: summary({ id, itemId }) } }));

let unseed: () => void = () => {};
beforeEach(() => {
  configureConversations({ api: fakeApi().api, transport: fakeTransport().transport });
  unseed = seedAI(CONNECTED_MODEL);
  clearChatState();
  rail().reset();
  useSidebarStore.setState({ askOpen: false });
  useUIStore.setState({ activeDialog: null, deferredDialog: null, confirmRequest: null, displacedItemId: null });
  useViewStore.setState({ zenOpen: false, zenMoving: false });
  previewing();
  renderHook(() => useDeferredDialogPromotion());
});

afterEach(async () => {
  cleanup();
  await conversationsSettled();
  unseed();
  unseed = () => {};
  usePlannerStore.setState({ isPreview: false, isLoading: false } as never);
});

describe("an item's conversation opened over the preview, on desktop", () => {
  it('arms no reveal while the open is held', () => {
    seedConversation('c1', 'i1');
    openConversation('c1', false);
    expect(ui().deferredDialog).toMatchObject({ type: 'edit-item', item: { id: 'i1' } });
    expect(rail().pendingReveal).toBeNull();
  });

  it('reveals the conversation when the held open is promoted at landing', () => {
    seedConversation('c1', 'i1');
    openConversation('c1', false);
    landFresh();

    expect(ui().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'i1', title: 'Fresh title' } });
    expect(rail().pendingReveal).toEqual({ itemId: 'i1' });
    // The panel's conversation takes it as it mounts.
    render(<ItemConversation item={task('i1', 'Fresh title')} mode="pinned" />);
    expect(rail().pendingReveal).toBeNull();
  });

  it('leaves nothing armed when the landing drops the open (the launcher took the slot)', () => {
    seedConversation('c1', 'i1');
    openConversation('c1', false);
    ui().openDialog({ type: 'launcher' });
    landFresh();
    expect(ui().activeDialog).toEqual({ type: 'launcher' });
    expect(ui().deferredDialog).toBeNull();
    expect(rail().pendingReveal).toBeNull();

    // Later, the same item opened from a row: it opens at its top.
    ui().closeDialog();
    openEditFor(task('i1', 'Fresh title') as unknown as Task, 'task');
    render(<ItemConversation item={task('i1', 'Fresh title')} mode="pinned" />);
    expect(useRailStore.getState().consumeReveal('i1')).toBe(false);
  });

  it('leaves nothing armed when the load fails', () => {
    seedConversation('c1', 'i1');
    openConversation('c1', false);
    usePlannerStore.setState({ isLoading: false, isPreview: false, error: 'offline', loadFailedUserId: A, items: [] } as never);
    expect(ui().deferredDialog).toBeNull();
    expect(rail().pendingReveal).toBeNull();
  });

  it('lets go of a held open that a newer one replaced, and reveals only the one that opens', () => {
    seedConversation('c1', 'i1');
    seedConversation('c2', 'i2');
    openConversation('c1', false);
    openConversation('c2', false);
    landFresh();
    expect(ui().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'i2' } });
    expect(rail().pendingReveal).toEqual({ itemId: 'i2' });
  });

  it('holds the reveal for askAboutItem too, and drops it with the open', () => {
    useConversationsStore.setState((s) => ({ itemIndex: { ...s.itemIndex, i1: 'c1' } }));
    askAboutItem(task('i1', 'Cached title'), { isMobile: false });
    expect(rail().pendingReveal).toBeNull();
    ui().openDialog({ type: 'launcher' });
    landFresh();
    expect(rail().pendingReveal).toBeNull();
  });

  it('arms nothing for an open the preview refused because a pasted list waits', () => {
    openBulkAdd({ text: 'Milk\nEggs' });
    seedConversation('c1', 'i1');
    openConversation('c1', false);
    expect(ui().deferredDialog).toEqual({ type: 'bulk-add', text: 'Milk\nEggs' });
    expect(rail().pendingReveal).toBeNull();

    landFresh();
    expect(ui().activeDialog).toEqual({ type: 'bulk-add', text: 'Milk\nEggs' });
    expect(rail().pendingReveal).toBeNull();
  });

  it('on loaded data, arms the reveal with the open, as it always has', () => {
    landFresh();
    seedConversation('c1', 'i1');
    openConversation('c1', false);
    expect(ui().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'i1' } });
    expect(rail().pendingReveal).toEqual({ itemId: 'i1' });
  });
});

/**
 * A door into AI setup (lib/open-chat.ts openSetup: `?` in the dock or the
 * launcher, ⌘K's "Set up AI" and "Fix AI", all live through the preview)
 * pressed after an item was asked for over the preview. On real data the door
 * closes the open item and setup shows; over the preview the item is held,
 * not open, so the door lets the held one go. Kept, it opened on top of the
 * setup asked for after it the moment the data landed.
 */
describe('a setup door pressed over an item held for the landing', () => {
  describe.each([
    ['setup', NOTHING_CONNECTED],
    ['the fix', KEY_TURNED_DOWN],
  ])('with %s offered', (_label, offered) => {
    beforeEach(() => {
      unseed();
      unseed = seedAI(offered);
    });

    it('desktop: lets the held item go, so setup still shows once the data lands', () => {
      openEditFor(task('i1', 'Cached title') as unknown as Task, 'task');
      expect(ui().deferredDialog).toMatchObject({ type: 'edit-item', item: { id: 'i1' } });

      expect(openSetup(false)).toBe(true);
      expect(ui().deferredDialog).toBeNull();
      expect(rail().summoned).toBe(true);

      landFresh();
      // Before: the item, promoted over the setup column.
      expect(ui().activeDialog).toBeNull();
      expect(rail().summoned).toBe(true);
    });

    it('desktop: the same as on real data, where the door closes the open item', () => {
      landFresh();
      openEditFor(task('i1', 'Fresh title') as unknown as Task, 'task');
      expect(ui().activeDialog?.type).toBe('edit-item');
      expect(openSetup(false)).toBe(true);
      expect(ui().activeDialog).toBeNull();
      expect(rail().summoned).toBe(true);
    });

    it('desktop: leaves a held dialog that is not the item alone (it is a modal, not the column)', () => {
      openAddDialog();
      const held = ui().deferredDialog;
      expect(held?.type).toBe('add');
      openSetup(false);
      expect(ui().deferredDialog).toBe(held);
    });

    it('phone: leaves the held item, which lands over the Ask tab as any promoted item does', () => {
      openEditFor(task('i1', 'Cached title') as unknown as Task, 'task');
      expect(openSetup(true)).toBe(true);
      expect(ui().deferredDialog).toMatchObject({ type: 'edit-item', item: { id: 'i1' } });
    });
  });

  it('leaves the held item alone when no door is on offer', () => {
    openEditFor(task('i1', 'Cached title') as unknown as Task, 'task');
    // CONNECTED_MODEL, from the outer beforeEach: nothing to set up.
    expect(openSetup(false)).toBe(false);
    expect(ui().deferredDialog).toMatchObject({ type: 'edit-item', item: { id: 'i1' } });
    landFresh();
    expect(ui().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'i1', title: 'Fresh title' } });
  });
});
