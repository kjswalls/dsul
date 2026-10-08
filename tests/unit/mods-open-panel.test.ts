import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The one door to a mod's panel (lib/mods/ui/open-panel.ts, memory/plans/
 * mods.md build order 9): the phone's sheet while the phone shell hosts it,
 * leaving rail-store alone; else the rail, after closing an open item and
 * leaving Zen, never touching Ask's `summoned` or `askOpen`.
 */

const zen = vi.hoisted(() => ({ leave: vi.fn() }));
vi.mock('@/lib/open-chat', () => ({ leaveZen: zen.leave }));
const ui = vi.hoisted(() => ({ closeItemPanel: vi.fn() }));
vi.mock('@/lib/ui-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ui-store')>()),
  closeItemPanel: ui.closeItemPanel,
}));

import {
  __resetModSheetHostsForTests,
  closeModSheet,
  isSheetHosted,
  openModPanel,
  setModSheetHost,
} from '@/lib/mods/ui/open-panel';
import { useModSheet } from '@/lib/mods/ui/sheet-store';
import { useRailStore } from '@/lib/rail-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useUIStore } from '@/lib/ui-store';

const water = { modId: 'm1', panelId: 'water' };

beforeEach(() => {
  __resetModSheetHostsForTests();
  useModSheet.setState({ ref: null });
  useRailStore.getState().reset();
  useUIStore.setState({ activeDialog: null });
  useSidebarStore.setState({ askOpen: false });
  zen.leave.mockClear();
  ui.closeItemPanel.mockClear();
});

describe('openModPanel', () => {
  it('with a sheet host, shows the sheet and leaves rail-store untouched', () => {
    const release = setModSheetHost();
    expect(isSheetHosted()).toBe(true);
    useUIStore.setState({ activeDialog: { type: 'edit-item', item: { id: 'i1' } } as never });
    openModPanel(water);
    expect(useModSheet.getState().ref).toEqual(water);
    expect(useRailStore.getState().modPanel).toBeNull();
    expect(ui.closeItemPanel).not.toHaveBeenCalled();
    expect(zen.leave).not.toHaveBeenCalled();
    // A new panel replaces the one showing.
    openModPanel({ modId: 'm2', panelId: 'log' });
    expect(useModSheet.getState().ref).toEqual({ modId: 'm2', panelId: 'log' });
    release();
  });

  it('with no host, closes an open item, leaves Zen and sets modPanel, summoned unchanged', () => {
    useUIStore.setState({ activeDialog: { type: 'edit-item', item: { id: 'i1' } } as never });
    openModPanel(water);
    expect(ui.closeItemPanel).toHaveBeenCalledTimes(1);
    expect(zen.leave).toHaveBeenCalledTimes(1);
    expect(useRailStore.getState().modPanel).toEqual(water);
    expect(useRailStore.getState().summoned).toBe(false);
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(useModSheet.getState().ref).toBeNull();
  });

  it('closes no item when none is open', () => {
    openModPanel(water);
    expect(ui.closeItemPanel).not.toHaveBeenCalled();
  });
});

describe('the sheet host', () => {
  it('is a count: a mount, unmount, mount leaves it hosted, and each release counts once', () => {
    const a = setModSheetHost();
    a();
    const b = setModSheetHost();
    a();
    expect(isSheetHosted()).toBe(true);
    b();
    expect(isSheetHosted()).toBe(false);
  });

  it('the last release closes a sheet left showing', () => {
    const release = setModSheetHost();
    openModPanel(water);
    release();
    expect(useModSheet.getState().ref).toBeNull();
  });

  it('closeModSheet closes it', () => {
    const release = setModSheetHost();
    openModPanel(water);
    closeModSheet();
    expect(useModSheet.getState().ref).toBeNull();
    release();
  });
});
