// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * components/mods/mod-surface.tsx: the host's chrome in every state, the
 * state read from Make's rows and the sandbox (never the runner slot), a
 * mod's own words only under "Your mod reported:" and only when they meet
 * the surface rule, Try again, and Open in Make.
 */

vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn() }) }));

import { ModSurface } from '@/components/mods/mod-surface';
import { ModCard } from '@/components/mods/mod-card';
import { useModsStore } from '@/lib/mods-store';
import { modSandbox } from '@/lib/mods/sandbox-host';
import { __resetPanelStoreForTests, usePanelStore } from '@/lib/mods/ui/panel-store';
import { parseModTree } from '@/lib/mods/ui/tree';
import type { UserMod } from '@/lib/mods/schema';

/** The store's own actions, put back before each test (some tests swap one for a spy). */
const ACTIONS = { ...usePanelStore.getState() };

const MOD = '00000000-0000-4000-8000-000000000001';
const REF = { modId: MOD, panelId: 'water' };
const KEY = `${MOD}:water`;

const row = (over: Partial<UserMod> = {}): UserMod => ({
  id: MOD,
  userId: 'u',
  kind: 'mod',
  slug: 'water',
  name: 'Water',
  enabled: true,
  manifest: {
    version: 1,
    uses: ['ui'],
    commands: [],
    panels: [{ id: 'water', label: 'Glasses', icon: 'CupSoda', card: true }],
  },
  disabledReason: null,
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
  ...over,
});

function cache() {
  const parsed = parseModTree(JSON.stringify({ type: 'stat', value: '3 of 8', label: 'Glasses today' }), { uses: ['ui'] });
  if (!parsed.ok) throw new Error(parsed.message);
  usePanelStore.setState({
    trees: {
      [KEY]: { seq: 1, tree: parsed.tree, actions: parsed.actions, atomKinds: parsed.atoms, rowUpdatedAt: row().updatedAt, at: 0 },
    },
    status: { [KEY]: 'ok' },
  });
}

const chrome = () => within(screen.getByTestId('mod-surface-chrome'));

beforeEach(() => {
  usePanelStore.setState(ACTIONS);
  __resetPanelStoreForTests();
  useModsStore.setState({ rows: [row()], safeMode: false });
  nav.push.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ModSurface', () => {
  it('draws the host chrome, outside the tree, in every state', () => {
    const states = ['loading', 'ok', 'empty', 'error'] as const;
    for (const status of states) {
      __resetPanelStoreForTests();
      if (status === 'ok') cache();
      else usePanelStore.setState({ status: { [KEY]: status } });
      render(<ModSurface panelRef={REF} presentation="rail" />);
      expect(chrome().getByText('Water')).toBeInTheDocument();
      expect(chrome().getByText('Your mod')).toBeInTheDocument();
      expect(chrome().getByText('Glasses')).toBeInTheDocument();
      cleanup();
    }
    useModsStore.setState({ rows: [row({ enabled: false })] });
    render(<ModSurface panelRef={REF} presentation="card" />);
    expect(chrome().getByText('Your mod')).toBeInTheDocument();
  });

  it('draws the tree in a section named for the mod, apart from the chrome', () => {
    cache();
    render(<ModSurface panelRef={REF} presentation="rail" />);
    const section = screen.getByRole('region', { name: 'Water, your mod' });
    expect(within(section).getByText('3 of 8')).toBeInTheDocument();
    expect(within(section).queryByText('Your mod')).toBeNull();
    expect(screen.getByTestId('mod-surface-chrome').contains(section)).toBe(false);
  });

  it('shows skeleton lines while loading with nothing cached, and the cached tree while a newer one loads', () => {
    render(<ModSurface panelRef={REF} presentation="card" />);
    expect(screen.getByTestId('mod-surface-loading')).toBeInTheDocument();
    cleanup();
    cache();
    usePanelStore.setState({ status: { [KEY]: 'loading' } });
    render(<ModSurface panelRef={REF} presentation="card" />);
    expect(screen.getByText('3 of 8')).toBeInTheDocument();
  });

  it('the error state: its copy, the mod’s message under a host label, Try again', () => {
    usePanelStore.setState({ status: { [KEY]: 'error' }, errors: { [KEY]: 'water is not defined' } });
    const retry = vi.fn();
    usePanelStore.setState({ retry });
    render(<ModSurface panelRef={REF} presentation="rail" />);
    expect(screen.getByText('This mod hit an error')).toBeInTheDocument();
    expect(screen.getByTestId('mod-surface-reported')).toHaveTextContent('Your mod reported: water is not defined');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledWith(REF);
  });

  it('hides a message that fails the surface rule, and omits the line with no message', () => {
    usePanelStore.setState({ status: { [KEY]: 'error' }, errors: { [KEY]: 'Sign in again to keep going' } });
    render(<ModSurface panelRef={REF} presentation="rail" />);
    expect(screen.getByTestId('mod-surface-reported')).toHaveTextContent('Your mod reported: (message hidden)');
    cleanup();
    usePanelStore.setState({ status: { [KEY]: 'error' }, errors: {} });
    render(<ModSurface panelRef={REF} presentation="rail" />);
    expect(screen.queryByTestId('mod-surface-reported')).toBeNull();
  });

  it('is off from Make’s rows, with the reason framed and the mod’s part through the rule', () => {
    useModsStore.setState({
      rows: [row({ enabled: false, disabledReason: '3 errors in 10 minutes. Last: Reconnect your model' })],
    });
    cache();
    render(<ModSurface panelRef={REF} presentation="rail" />);
    expect(screen.getByText('This mod is switched off.')).toBeInTheDocument();
    expect(screen.getByText('3 errors in 10 minutes.')).toBeInTheDocument();
    expect(screen.getByTestId('mod-surface-reported')).toHaveTextContent('(message hidden)');
    expect(screen.queryByText('3 of 8')).toBeNull();
  });

  it('is unavailable from the sandbox, with its copy', () => {
    vi.spyOn(modSandbox, 'status').mockReturnValue('unavailable');
    render(<ModSurface panelRef={REF} presentation="rail" />);
    expect(screen.getByText('Mods can’t run in this browser yet')).toBeInTheDocument();
    cleanup();
    vi.spyOn(modSandbox, 'status').mockReturnValue('outdated');
    render(<ModSurface panelRef={REF} presentation="rail" />);
    expect(screen.getByText('Reload to run your mods')).toBeInTheDocument();
  });

  it('with no runner in the slot, a panel is just loading, and a cached one still shows', () => {
    render(<ModSurface panelRef={REF} presentation="rail" />);
    expect(screen.getByTestId('mod-surface')).toHaveAttribute('data-mod-state', 'loading');
    cleanup();
    cache();
    render(<ModSurface panelRef={REF} presentation="rail" />);
    expect(screen.getByText('3 of 8')).toBeInTheDocument();
  });

  it('empty says so; Open in Make leaves first, then goes', () => {
    usePanelStore.setState({ status: { [KEY]: 'empty' } });
    const onLeave = vi.fn();
    render(<ModSurface panelRef={REF} presentation="sheet" onLeave={onLeave} />);
    expect(screen.getByText('This mod draws nothing here yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open in Make' }));
    expect(onLeave).toHaveBeenCalled();
    expect(nav.push).toHaveBeenCalledWith('/settings/make');
    expect(onLeave.mock.invocationCallOrder[0]).toBeLessThan(nav.push.mock.invocationCallOrder[0]);
  });

  it('says when redraws are paused or the person is too quick', () => {
    cache();
    usePanelStore.setState({ throttled: { [KEY]: true }, slowed: { [MOD]: true } });
    render(<ModSurface panelRef={REF} presentation="rail" />);
    expect(screen.getByText('Paused, redrawing too often')).toBeInTheDocument();
    expect(screen.getByText('Slow down a little')).toBeInTheDocument();
  });

  it('counts as showing the panel only while active and the mod can draw', () => {
    const { rerender } = render(<ModSurface panelRef={REF} presentation="rail" active={false} />);
    expect(usePanelStore.getState().visible[KEY]).toBeUndefined();
    rerender(<ModSurface panelRef={REF} presentation="rail" />);
    expect(usePanelStore.getState().visible[KEY]).toBe(1);
    useModsStore.setState({ rows: [row({ enabled: false })] });
    rerender(<ModSurface panelRef={REF} presentation="rail" />);
    expect(usePanelStore.getState().visible[KEY]).toBeUndefined();
  });

  it('draws nothing in safe mode, or for a panel the mod no longer declares', () => {
    useModsStore.setState({ safeMode: true });
    const { container } = render(<ModSurface panelRef={REF} presentation="rail" />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    useModsStore.setState({ safeMode: false });
    render(<ModSurface panelRef={{ modId: MOD, panelId: 'gone' }} presentation="rail" />);
    expect(screen.queryByTestId('mod-surface')).toBeNull();
  });
});

describe('ModCard', () => {
  it('shows the card panel with the host glyph, and nothing in safe mode or without a card', () => {
    cache();
    render(<ModCard />);
    expect(screen.getByTestId('mod-card')).toBeInTheDocument();
    expect(screen.getByTestId('mod-surface')).toHaveAttribute('data-mod-presentation', 'card');
    expect(screen.getByTestId('mod-surface-chrome').querySelector('.lucide-puzzle')).not.toBeNull();
    cleanup();
    useModsStore.setState({ safeMode: true });
    render(<ModCard />);
    expect(screen.queryByTestId('mod-card')).toBeNull();
    cleanup();
    useModsStore.setState({ safeMode: false, rows: [row({ manifest: { version: 1, uses: ['ui'], panels: [{ id: 'water', label: 'Glasses' }] } })] });
    render(<ModCard />);
    expect(screen.queryByTestId('mod-card')).toBeNull();
  });
});
