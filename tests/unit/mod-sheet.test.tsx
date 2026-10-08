import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';

/**
 * The phone's mod sheet (components/mods/mod-sheet.tsx, memory/plans/mods.md
 * build order 9): opened through the router while the phone shell hosts it,
 * the host's chrome as its title row, nothing focused on open, and closed
 * when its mod is deleted or the panel leaves the manifest.
 *
 * vaul never unmounts its content under jsdom, so the drawer is a stand-in
 * that draws its content while open and keeps the focus handler it is given.
 */

const drawer = vi.hoisted(() => ({
  onOpenAutoFocus: null as null | ((event: { preventDefault: () => void }) => void),
  onOpenChange: null as null | ((open: boolean) => void),
}));
vi.mock('@/components/ui/drawer', () => {
  let open = false;
  return {
    Drawer: ({ open: o, onOpenChange, children }: { open: boolean; onOpenChange: (o: boolean) => void; children?: ReactNode }) => {
      open = o;
      drawer.onOpenChange = onOpenChange;
      return <>{children}</>;
    },
    DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    DrawerContent: ({
      children,
      onOpenAutoFocus,
    }: {
      children?: ReactNode;
      onOpenAutoFocus?: (event: { preventDefault: () => void }) => void;
    }) => {
      drawer.onOpenAutoFocus = onOpenAutoFocus ?? null;
      return open ? <div data-testid="mod-sheet">{children}</div> : null;
    },
  };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

import { ModSheet } from '@/components/mods/mod-sheet';
import { __resetModSheetHostsForTests, openModPanel, setModSheetHost } from '@/lib/mods/ui/open-panel';
import { useModSheet } from '@/lib/mods/ui/sheet-store';
import { useModsStore } from '@/lib/mods-store';
import { useRailStore } from '@/lib/rail-store';
import type { UserMod } from '@/lib/mods/schema';

const WATER: UserMod = {
  id: 'm1',
  userId: 'u1',
  kind: 'mod',
  slug: 'water',
  name: 'Water',
  enabled: true,
  manifest: { version: 1, uses: ['ui'], commands: [], panels: [{ id: 'water', label: 'Glasses' }] },
  disabledReason: null,
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
};

let release: () => void = () => {};
beforeEach(() => {
  __resetModSheetHostsForTests();
  useModSheet.setState({ ref: null });
  useRailStore.getState().reset();
  useModsStore.setState({ available: true, loaded: true, safeMode: false, rows: [WATER] });
  release = setModSheetHost();
});
afterEach(() => {
  cleanup();
  release();
  useModsStore.setState({ rows: [] });
});

describe('the mod sheet', () => {
  it('opens through the router with the host chrome, and moves no focus', () => {
    render(<ModSheet />);
    expect(screen.queryByTestId('mod-sheet')).toBeNull();
    act(() => openModPanel({ modId: 'm1', panelId: 'water' }));
    expect(screen.getByTestId('mod-sheet')).toBeInTheDocument();
    expect(screen.getByTestId('mod-surface-chrome')).toHaveTextContent('Water');
    expect(screen.getByTestId('mod-surface-chrome')).toHaveTextContent('Your mod');
    expect(screen.getByRole('heading', { name: 'Water, your mod' })).toBeInTheDocument();
    expect(useRailStore.getState().modPanel).toBeNull();
    const preventDefault = vi.fn();
    drawer.onOpenAutoFocus?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
  });

  it('closes on a swipe or a tap outside', () => {
    render(<ModSheet />);
    act(() => openModPanel({ modId: 'm1', panelId: 'water' }));
    act(() => drawer.onOpenChange?.(false));
    expect(useModSheet.getState().ref).toBeNull();
  });

  it('closes when its mod is deleted, or its panel leaves the manifest', () => {
    render(<ModSheet />);
    act(() => openModPanel({ modId: 'm1', panelId: 'water' }));
    act(() => useModsStore.setState({ rows: [{ ...WATER, manifest: { ...WATER.manifest as object, panels: [] } }] }));
    expect(useModSheet.getState().ref).toBeNull();
    act(() => useModsStore.setState({ rows: [WATER] }));
    act(() => openModPanel({ modId: 'm1', panelId: 'water' }));
    act(() => useModsStore.setState({ rows: [] }));
    expect(useModSheet.getState().ref).toBeNull();
  });

  it('stays, saying so, when its mod is switched off', () => {
    render(<ModSheet />);
    act(() => openModPanel({ modId: 'm1', panelId: 'water' }));
    act(() => useModsStore.setState({ rows: [{ ...WATER, enabled: false }] }));
    expect(useModSheet.getState().ref).not.toBeNull();
    expect(screen.getByText('This mod is switched off.')).toBeInTheDocument();
  });
});
