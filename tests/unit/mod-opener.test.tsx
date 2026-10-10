import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * The key to a mod's panels (components/mods/mod-opener.tsx, memory/plans/
 * mods.md build order 9), on the canvas's header row after the Ask button.
 *
 *  - Nothing on the phone, in safe mode, or with no switched-on mod declaring
 *    a panel; `hidden`, still mounted, while the column shows or in Zen.
 *  - It takes the row's far end only when the Ask button is not offered.
 *  - One panel opens at once through the router; more open a menu, each row
 *    named by the host. The key and the menu are clickable in the desktop
 *    app's drag band.
 */

vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn() }));
const openPanel = vi.hoisted(() => vi.fn());
vi.mock('@/lib/mods/ui/open-panel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mods/ui/open-panel')>()),
  openModPanel: openPanel,
}));
const mobile = vi.hoisted(() => ({ on: false }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mobile.on }));

import { ModOpener } from '@/components/mods/mod-opener';
import { useModsStore } from '@/lib/mods-store';
import { useRailStore } from '@/lib/rail-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useUIStore } from '@/lib/ui-store';
import { useViewStore } from '@/lib/view-store';
import { useLookStore } from '@/lib/look-store';
import type { UserMod } from '@/lib/mods/schema';
import { seedAI, CONNECTED_MODEL, AI_HIDDEN, type SeedAI } from './helpers/ai-fixtures';

const realMatchMedia = window.matchMedia;

beforeAll(() => {
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

const mod = (slug: string, panels: { id: string; label: string }[], over: Partial<UserMod> = {}): UserMod => ({
  id: `id-${slug}`,
  userId: 'u1',
  kind: 'mod',
  slug,
  name: slug[0].toUpperCase() + slug.slice(1),
  enabled: true,
  manifest: { version: 1, uses: ['ui'], commands: [], panels },
  disabledReason: null,
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
  ...over,
});
const WATER = mod('water', [{ id: 'water', label: 'Glasses' }]);
const STEPS = mod('steps', [{ id: 'today', label: 'Today' }]);

let unseed: () => void = () => {};
const seed = (o?: SeedAI) => {
  unseed();
  unseed = seedAI(o);
};

beforeEach(() => {
  window.matchMedia = ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  mobile.on = false;
  openPanel.mockClear();
  useModsStore.setState({ available: true, loaded: true, safeMode: false, rows: [WATER] });
  useSidebarStore.setState({ askOpen: false });
  useRailStore.getState().reset();
  useUIStore.setState({ activeDialog: null });
  useViewStore.setState({ zenOpen: false, scope: 'day' } as never);
  useLookStore.setState({ layout: 'classic' });
  seed(CONNECTED_MODEL);
});

afterEach(() => {
  cleanup();
  unseed();
  unseed = () => {};
  window.matchMedia = realMatchMedia;
  useModsStore.setState({ rows: [] });
});

const key = () => document.querySelector<HTMLButtonElement>('[data-mod-opener]');

describe('when it shows', () => {
  it('shows a 32px key named "Your mod panels", in the drag band, on the date line', () => {
    render(<ModOpener />);
    const button = screen.getByRole('button', { name: 'Your mod panels' });
    expect(button).toBe(key());
    expect(button).toHaveAttribute('title', 'Your mod panels');
    expect(button).toHaveClass('size-8', 'shrink-0', 'titlebar-hole', 'mt-2');
    expect(button).not.toHaveAttribute('hidden');
  });

  it('is nothing with no panel, with every panel switched off, in safe mode, or on the phone', () => {
    useModsStore.setState({ rows: [mod('plain', [])] });
    const { rerender } = render(<ModOpener />);
    expect(key()).toBeNull();
    act(() => useModsStore.setState({ rows: [{ ...WATER, enabled: false }] }));
    rerender(<ModOpener />);
    expect(key()).toBeNull();
    act(() => useModsStore.setState({ rows: [WATER], safeMode: true }));
    rerender(<ModOpener />);
    expect(key()).toBeNull();
    act(() => useModsStore.setState({ safeMode: false }));
    mobile.on = true;
    rerender(<ModOpener />);
    expect(key()).toBeNull();
  });

  it('is hidden, still in the page, while the column shows or in Zen', () => {
    render(<ModOpener />);
    act(() => useRailStore.getState().openModPanel({ modId: WATER.id, panelId: 'water' }));
    expect(key()).toHaveAttribute('hidden');
    act(() => useRailStore.getState().closeModPanel());
    expect(key()).not.toHaveAttribute('hidden');
    act(() => useViewStore.setState({ zenOpen: true }));
    expect(key()).toHaveAttribute('hidden');
  });

  it('takes the far end only when the Ask button is not offered', () => {
    const { rerender } = render(<ModOpener />);
    expect(key()).not.toHaveClass('ml-auto');
    act(() => seed(AI_HIDDEN));
    rerender(<ModOpener />);
    expect(key()).toHaveClass('ml-auto');
  });
});

describe('a click', () => {
  it('opens the one panel through the router', () => {
    render(<ModOpener />);
    fireEvent.click(key()!, { detail: 1 });
    expect(openPanel).toHaveBeenCalledWith({ modId: WATER.id, panelId: 'water' });
    expect(document.activeElement).toBe(key());
  });

  it('with more than one panel, lists each under host chrome, in the drag band', async () => {
    useModsStore.setState({ rows: [WATER, STEPS] });
    render(<ModOpener />);
    fireEvent.pointerDown(key()!, { button: 0, ctrlKey: false });
    const menu = await screen.findByTestId('mod-opener-menu');
    expect(menu).toHaveClass('titlebar-hole');
    const rows = screen.getAllByRole('menuitem');
    expect(rows.map((r) => r.textContent)).toEqual(['Your mod · Water: Glasses', 'Your mod · Steps: Today']);
    fireEvent.click(rows[1]);
    expect(openPanel).toHaveBeenCalledWith({ modId: STEPS.id, panelId: 'today' });
  });
});
