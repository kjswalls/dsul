import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StrictMode } from 'react';
import { cleanup, renderHook } from '@testing-library/react';
import {
  PREVIEW_DEFERRED_SLOTS,
  isDataDialog,
  isDataDialogArmed,
  openEditFor,
  setEditItemInterceptor,
  useUIStore,
  type ActiveDialog,
  type ConfirmRequest,
} from '@/lib/ui-store';
import { useDeferredDialogPromotion } from '@/hooks/use-deferred-dialog';
import { usePlannerStore } from '@/lib/planner-store';
import type { Item, Task } from '@/lib/planner-types';

/**
 * ui-store's half of the look-only preview (lib/ui-store.ts) and its promotion
 * (hooks/use-deferred-dialog.ts).
 *
 * While the planner shows cached rows, the five data slots are DEFERRED, not
 * opened: the docked panel autosaves and the modal saves, so a dialog seeded
 * from a cached row would write a decision about it after the fresh data had
 * replaced it. The request is opened when — and only when — fresh data lands
 * for the same account, re-resolved against that data. `confirm` is refused
 * outright on `/`, where every confirm guards a data action.
 */

const A = 'user-a';
const B = 'user-b';

const task = (id: string, title: string): Item =>
  ({ type: 'task', id, title, status: 'pending', isScheduled: false, order: 0, completedDates: [] }) as Item;

const CACHED = () => [task('t-kept', 'Cached title'), task('t-gone', 'Deleted elsewhere since')];
const FRESH = () => [task('t-kept', 'Fresh title'), task('t-new', 'Made elsewhere')];

/** Every slot, classified. A Record over the union, so a new slot fails to compile until it is. */
const SLOT_IS_DATA: Record<ActiveDialog['type'], boolean> = {
  add: true,
  'edit-item': true,
  'new-container': true,
  'bulk-add': true,
  organize: true,
  launcher: false,
  'keyboard-shortcuts': false,
  'bug-report': false,
};

const DATA_SLOTS: ActiveDialog[] = [
  { type: 'add', tab: 'task' },
  { type: 'edit-item', item: task('t-kept', 'Cached title') },
  { type: 'new-container', kind: 'routine' },
  { type: 'bulk-add', text: 'one\ntwo' },
  { type: 'organize', section: 'projects' },
];
const CHROME_SLOTS: ActiveDialog[] = [
  { type: 'launcher' },
  { type: 'keyboard-shortcuts' },
  { type: 'bug-report' },
];

const CONFIRM: ConfirmRequest = { title: 'Delete?', description: 'Gone.', onConfirm: () => {} };

/** The planner as the preview leaves it: cached rows, still loading. */
function previewing(userId = A) {
  const items = CACHED();
  usePlannerStore.setState({
    userId,
    isLoading: true,
    isPreview: true,
    error: null,
    loadFailedUserId: null,
    items,
    tasks: items as never,
    habits: [] as never,
  } as never);
}

/** The success landing: fresh rows, isPreview cleared in the same set(). */
function landFresh(userId = A) {
  const items = FRESH();
  usePlannerStore.setState({
    userId,
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

beforeEach(() => {
  useUIStore.setState({ activeDialog: null, deferredDialog: null, confirmRequest: null, dialogHandoff: false });
  previewing();
});
afterEach(() => {
  cleanup();
  usePlannerStore.setState({ isPreview: false, isLoading: false } as never);
});

describe('openDialog while previewing', () => {
  it('classifies every slot: exactly the five data slots defer', () => {
    expect([...PREVIEW_DEFERRED_SLOTS].sort()).toEqual(
      Object.entries(SLOT_IS_DATA)
        .filter(([, data]) => data)
        .map(([type]) => type)
        .sort()
    );
    for (const [type, data] of Object.entries(SLOT_IS_DATA)) {
      expect(isDataDialog({ type } as ActiveDialog), type).toBe(data);
    }
    expect(isDataDialog(null)).toBe(false);
  });

  it('defers each data slot instead of opening it', () => {
    for (const dialog of DATA_SLOTS) {
      ui().openDialog(dialog);
      expect(ui().activeDialog, dialog.type).toBeNull();
      expect(ui().deferredDialog, dialog.type).toBe(dialog);
    }
  });

  it('keeps only the last request', () => {
    ui().openDialog({ type: 'organize', section: 'projects' });
    ui().openDialog({ type: 'add', tab: 'habit' });
    expect(ui().deferredDialog).toEqual({ type: 'add', tab: 'habit' });
  });

  it('defers through the helpers too (openEditFor stamps, then asks openDialog)', () => {
    openEditFor(task('t-kept', 'Cached title') as unknown as Task, 'task');
    expect(ui().activeDialog).toBeNull();
    expect(ui().deferredDialog?.type).toBe('edit-item');
  });

  it("never hands an item to the phone Ask tab's interceptor: the slot defers it", () => {
    // rail-store installs it while the tab is mounted; its item view autosaves.
    const interceptor = vi.fn(() => true);
    setEditItemInterceptor(interceptor);
    try {
      openEditFor(task('t-kept', 'Cached title') as unknown as Task, 'task');
      expect(interceptor).not.toHaveBeenCalled();
      expect(ui().deferredDialog?.type).toBe('edit-item');
    } finally {
      setEditItemInterceptor(null);
    }
  });

  it('opens the launcher, the shortcuts sheet and the bug report as usual, deferral untouched', () => {
    ui().openDialog({ type: 'organize' });
    for (const dialog of CHROME_SLOTS) {
      ui().openDialog(dialog);
      expect(ui().activeDialog, dialog.type).toBe(dialog);
      expect(ui().deferredDialog, dialog.type).toEqual({ type: 'organize' });
    }
  });

  it('closeDialog leaves the deferral intact (the launcher closes itself after running a door)', () => {
    ui().openDialog({ type: 'launcher' });
    ui().openDialog({ type: 'organize', section: 'routines' });
    ui().closeDialog();
    expect(ui().activeDialog).toBeNull();
    expect(ui().deferredDialog).toEqual({ type: 'organize', section: 'routines' });
  });

  it('a data slot opened on real data opens, and drops a stale deferral', () => {
    ui().openDialog({ type: 'organize' });
    landFresh();
    ui().openDialog({ type: 'add', tab: 'task' });
    expect(ui().activeDialog).toEqual({ type: 'add', tab: 'task' });
    expect(ui().deferredDialog).toBeNull();
  });

  it('a chrome slot opened on real data does not drop a deferral', () => {
    useUIStore.setState({ deferredDialog: { type: 'organize' } });
    landFresh();
    ui().openDialog({ type: 'launcher' });
    expect(ui().deferredDialog).toEqual({ type: 'organize' });
  });
});

describe('confirm while previewing', () => {
  it('is refused', () => {
    ui().confirm(CONFIRM);
    expect(ui().confirmRequest).toBeNull();
  });

  it('is raised as usual off the planner route (the preview outlives a client navigation)', () => {
    // /settings's model disconnect asks through this same confirm, and it
    // touches no planner row: refused there, the click would just vanish.
    window.history.pushState({}, '', '/settings/ai');
    try {
      ui().confirm(CONFIRM);
      expect(ui().confirmRequest).toBe(CONFIRM);
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('is raised as usual once the preview ends', () => {
    landFresh();
    ui().confirm(CONFIRM);
    expect(ui().confirmRequest).toBe(CONFIRM);
  });
});

describe('isDataDialogArmed', () => {
  const cases: [string, Partial<{ activeDialog: ActiveDialog | null; deferredDialog: ActiveDialog | null }>, boolean][] = [
    ['nothing open, nothing waiting', { activeDialog: null, deferredDialog: null }, false],
    ['the launcher open', { activeDialog: { type: 'launcher' } }, false],
    ['the shortcuts sheet open', { activeDialog: { type: 'keyboard-shortcuts' } }, false],
    ['the bug report open', { activeDialog: { type: 'bug-report' } }, false],
    ['Organize armed (the /settings arm-then-push)', { activeDialog: { type: 'organize' } }, true],
    ['the item panel open', { activeDialog: { type: 'edit-item', item: task('t1', 'x') } }, true],
    ['the add dialog open', { activeDialog: { type: 'add', tab: 'task' } }, true],
    ['a deferral waiting', { deferredDialog: { type: 'bulk-add' } }, true],
    ['the launcher open over a deferral', { activeDialog: { type: 'launcher' }, deferredDialog: { type: 'organize' } }, true],
  ];
  it.each(cases)('%s → %s', (_label, state, armed) => {
    useUIStore.setState({ activeDialog: null, deferredDialog: null, ...state });
    expect(isDataDialogArmed()).toBe(armed);
  });
});

describe('useDeferredDialogPromotion', () => {
  const mount = () => renderHook(() => useDeferredDialogPromotion());

  it('opens the request on a successful landing into an empty slot', () => {
    mount();
    ui().openDialog({ type: 'organize', section: 'projects' });
    landFresh();
    expect(ui().activeDialog).toEqual({ type: 'organize', section: 'projects' });
    expect(ui().deferredDialog).toBeNull();
  });

  it('drops it on the failure edge (a failed load is settled, not loaded)', () => {
    mount();
    ui().openDialog({ type: 'organize' });
    usePlannerStore.setState({
      isLoading: false,
      isPreview: false,
      error: 'offline',
      loadFailedUserId: A,
      items: [],
      tasks: [] as never,
    } as never);
    expect(ui().activeDialog).toBeNull();
    expect(ui().deferredDialog).toBeNull();
  });

  it('drops it on a crash drop, and the later landing opens nothing', () => {
    mount();
    ui().openDialog({ type: 'organize' });
    // dropPreview: data emptied, still loading.
    usePlannerStore.setState({ isPreview: false, items: [], tasks: [] as never } as never);
    expect(ui().deferredDialog).toBeNull();
    landFresh();
    expect(ui().activeDialog).toBeNull();
  });

  it('drops it on an account change', () => {
    mount();
    ui().openDialog({ type: 'add', tab: 'task' });
    // identifyUser(B): another account, empty, loading.
    usePlannerStore.setState({ userId: B, isLoading: true, isPreview: false, items: [] } as never);
    expect(ui().deferredDialog).toBeNull();
    expect(ui().activeDialog).toBeNull();
  });

  it('drops it when the edge lands loaded for a different account', () => {
    mount();
    ui().openDialog({ type: 'add', tab: 'task' });
    landFresh(B);
    expect(ui().activeDialog).toBeNull();
    expect(ui().deferredDialog).toBeNull();
  });

  it('drops it when the slot is taken by then', () => {
    mount();
    ui().openDialog({ type: 'organize' });
    ui().openDialog({ type: 'launcher' });
    landFresh();
    expect(ui().activeDialog).toEqual({ type: 'launcher' });
    expect(ui().deferredDialog).toBeNull();
  });

  it('drops it when a confirm is up', () => {
    mount();
    ui().openDialog({ type: 'organize' });
    useUIStore.setState({ confirmRequest: CONFIRM });
    landFresh();
    expect(ui().activeDialog).toBeNull();
    expect(ui().deferredDialog).toBeNull();
    expect(ui().confirmRequest).toBe(CONFIRM);
  });

  it('re-resolves an edit-item to the fresh row, keeping the payload type stamp', () => {
    mount();
    openEditFor(task('t-kept', 'Cached title') as unknown as Task, 'task');
    const payload = ui().deferredDialog as Extract<ActiveDialog, { type: 'edit-item' }>;
    landFresh();
    const opened = ui().activeDialog as Extract<ActiveDialog, { type: 'edit-item' }>;
    expect(opened.type).toBe('edit-item');
    expect(opened.item.id).toBe('t-kept');
    expect(opened.item.title).toBe('Fresh title');
    expect(opened.item.type).toBe(payload.item.type);
    // A fresh object, not the cached snapshot nor the store's row itself.
    expect(opened.item).not.toBe(payload.item);
    expect(opened.item).not.toBe(usePlannerStore.getState().items.find((i) => i.id === 't-kept'));
  });

  it("promotes an edit-item the way openEditFor sends one, through the phone Ask tab's interceptor", () => {
    mount();
    openEditFor(task('t-kept', 'Cached title') as unknown as Task, 'task');
    const interceptor = vi.fn<(item: Item) => boolean>(() => true);
    setEditItemInterceptor(interceptor);
    try {
      landFresh();
      expect(interceptor).toHaveBeenCalledTimes(1);
      expect(interceptor.mock.calls[0][0]).toMatchObject({ id: 't-kept', title: 'Fresh title' });
      // Taken over Ask: the slot stays as it was.
      expect(ui().activeDialog).toBeNull();
      expect(ui().deferredDialog).toBeNull();
    } finally {
      setEditItemInterceptor(null);
    }
  });

  it('drops an edit-item whose row is gone from the fresh data', () => {
    mount();
    openEditFor(task('t-gone', 'Deleted elsewhere since') as unknown as Task, 'task');
    landFresh();
    expect(ui().activeDialog).toBeNull();
    expect(ui().deferredDialog).toBeNull();
  });

  it('filters a new organizer’s itemIds to rows that still exist', () => {
    mount();
    ui().openDialog({ type: 'new-container', kind: 'routine', title: 'Morning', itemIds: ['t-kept', 't-gone'] });
    landFresh();
    expect(ui().activeDialog).toEqual({
      type: 'new-container',
      kind: 'routine',
      title: 'Morning',
      itemIds: ['t-kept'],
    });
  });

  it('ignores a store change that is not the end of a preview', () => {
    mount();
    useUIStore.setState({ deferredDialog: { type: 'organize' } });
    usePlannerStore.setState({ items: CACHED() } as never);
    expect(ui().deferredDialog).toEqual({ type: 'organize' });
    expect(ui().activeDialog).toBeNull();
  });

  it('clears the deferral on unmount, and stops listening', async () => {
    const hook = mount();
    ui().openDialog({ type: 'organize' });
    hook.unmount();
    // The clear waits a microtask so a StrictMode re-mount can keep it (test below).
    await Promise.resolve();
    expect(ui().deferredDialog).toBeNull();
    ui().openDialog({ type: 'organize' });
    landFresh();
    expect(ui().activeDialog).toBeNull();
  });

  it('survives StrictMode’s mount → cleanup → mount (the /settings arm-then-push)', async () => {
    // A door on /settings, mid-preview, defers Organize and pushes `/`
    // (lib/console-door.ts). AppShell mounts there under StrictMode in
    // development, whose effect cleanup runs right after the first mount.
    ui().openDialog({ type: 'organize', section: 'goals' });
    expect(ui().deferredDialog).toEqual({ type: 'organize', section: 'goals' });
    const subscribe = vi.spyOn(usePlannerStore, 'subscribe');
    renderHook(() => useDeferredDialogPromotion(), { wrapper: StrictMode });
    // Guard the guard: the cleanup really did run between two subscriptions.
    expect(subscribe).toHaveBeenCalledTimes(2);
    subscribe.mockRestore();
    await Promise.resolve();
    expect(ui().deferredDialog).toEqual({ type: 'organize', section: 'goals' });
    landFresh();
    expect(ui().activeDialog).toEqual({ type: 'organize', section: 'goals' });
  });

  it('a real unmount under StrictMode still drops it (leaving `/`)', async () => {
    const hook = renderHook(() => useDeferredDialogPromotion(), { wrapper: StrictMode });
    ui().openDialog({ type: 'organize' });
    hook.unmount();
    await Promise.resolve();
    expect(ui().deferredDialog).toBeNull();
  });
});
