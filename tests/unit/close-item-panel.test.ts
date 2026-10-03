import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  closeItemPanel,
  openQuickCapture,
  registerItemPanelClose,
  registerItemPanelFlush,
  useUIStore,
} from '@/lib/ui-store';

/**
 * lib/ui-store.ts: the one flushing close for every caller outside the item
 * panel (Ctrl+J, `?`, "Pick things back up"), and the id the ⌘K launcher
 * displaced, which only `?` reads.
 */

const ui = () => useUIStore.getState();
const item = (id: string) => ({ type: 'edit-item' as const, item: { id } as never });

beforeEach(() => useUIStore.setState({ activeDialog: null, displacedItemId: null, confirmRequest: null }));

describe('closeItemPanel', () => {
  let offs: (() => void)[] = [];
  afterEach(() => {
    offs.forEach((off) => off());
    offs = [];
  });

  it("flushes first, then goes through the shell's close (its selection rule), never a bare closeDialog", () => {
    const calls: string[] = [];
    offs.push(registerItemPanelFlush(() => calls.push(`flush, slot ${ui().activeDialog?.type}`)));
    offs.push(
      registerItemPanelClose(() => {
        calls.push('shell close');
        ui().closeDialog();
      })
    );
    ui().openDialog(item('i1'));
    closeItemPanel();
    // The flush ran while the item was still in the slot: synchronously, so a
    // caller that reads the planner next sees the edit.
    expect(calls).toEqual(['flush, slot edit-item', 'shell close']);
    expect(ui().activeDialog).toBeNull();
  });

  it('falls back to closeDialog with no shell registered (Zen, the phone)', () => {
    const calls: string[] = [];
    offs.push(registerItemPanelFlush(() => calls.push('flush')));
    ui().openDialog(item('i1'));
    closeItemPanel();
    expect(calls).toEqual(['flush']);
    expect(ui().activeDialog).toBeNull();
  });

  it('does nothing when no item is open, and never closes another dialog', () => {
    const calls: string[] = [];
    offs.push(registerItemPanelFlush(() => calls.push('flush')));
    offs.push(registerItemPanelClose(() => calls.push('close')));
    closeItemPanel();
    ui().openDialog({ type: 'keyboard-shortcuts' });
    closeItemPanel();
    expect(calls).toEqual([]);
    expect(ui().activeDialog).toEqual({ type: 'keyboard-shortcuts' });
  });

  it("an unregister clears only its own slot, so a newer panel's flush survives an older one's cleanup", () => {
    const calls: string[] = [];
    const offOld = registerItemPanelFlush(() => calls.push('old'));
    offs.push(registerItemPanelFlush(() => calls.push('new')));
    offOld();
    ui().openDialog(item('i1'));
    closeItemPanel();
    expect(calls).toEqual(['new']);
  });
});

describe('displacedItemId', () => {
  it('is the item the launcher replaced, and only that', () => {
    ui().openDialog(item('i1'));
    expect(ui().displacedItemId).toBeNull();
    ui().openDialog({ type: 'launcher' });
    expect(ui().displacedItemId).toBe('i1');
  });

  it('survives the launcher re-opened over itself', () => {
    ui().openDialog(item('i1'));
    ui().openDialog({ type: 'launcher' });
    ui().openDialog({ type: 'launcher', query: '/' });
    expect(ui().displacedItemId).toBe('i1');
  });

  it('is cleared by the next openDialog or closeDialog', () => {
    ui().openDialog(item('i1'));
    ui().openDialog({ type: 'launcher' });
    ui().closeDialog();
    expect(ui().displacedItemId).toBeNull();

    ui().openDialog(item('i1'));
    ui().openDialog({ type: 'launcher' });
    ui().openDialog({ type: 'bulk-add' });
    expect(ui().displacedItemId).toBeNull();
  });

  it('is not set by a launcher over an empty slot or another dialog', () => {
    ui().openDialog({ type: 'launcher' });
    expect(ui().displacedItemId).toBeNull();
    ui().openDialog({ type: 'bulk-add' });
    ui().openDialog({ type: 'launcher' });
    expect(ui().displacedItemId).toBeNull();
  });

  it("is kept by the desktop app's quick capture, which opens the launcher over the docked panel", () => {
    ui().openDialog(item('i1'));
    openQuickCapture();
    expect(ui().activeDialog).toEqual({ type: 'launcher', query: '+' });
    expect(ui().displacedItemId).toBe('i1');
  });
});
