import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react';

/**
 * Atlas's minimap (design PR3): absent while the whole board is on screen,
 * shown while the camera moves and hidden ATLAS_MINIMAP_IDLE_MS after, pinned
 * by M (the toggle_atlas_minimap command), and a click flies the camera.
 * Shown and hidden by visibility and a transform: no inline opacity.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
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

import { AtlasView } from '@/components/views/atlas/atlas-view';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { useAtlasStore } from '@/lib/atlas-store';
import { useViewStore } from '@/lib/view-store';
import { STATIC_COMMANDS, type CommandContext } from '@/lib/commands';
import { DEFAULT_SHORTCUTS } from '@/lib/keyboard-shortcuts-store';
import { EXT_GOALS } from '@/lib/extension-registry';
import { disableExtensions, enableExtensions } from './support/extensions';
import { ATLAS_CARD_H, ATLAS_CARD_W } from '@/lib/atlas-seed';
import { screenToWorld } from '@/lib/atlas-camera';
import { ATLAS_MINIMAP_IDLE_MS, miniToWorld, minimapFrame } from '@/lib/atlas-minimap';
import { toast } from 'sonner';
import { TODAY, asDate, installDomShims, manualRaf, seed, spyCanvas, task } from './helpers/atlas-far-setup';

beforeAll(installDomShims);

const ctx: CommandContext = {
  theme: { resolved: 'light', value: 'light', set: () => {} },
  openChat: () => {},
  userId: 'u1',
  isMobile: false,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(asDate(TODAY));
  useAtlasUiStore.getState().reset();
  useAtlasStore.getState().reset();
  useViewStore.setState({ scope: 'atlas', atlasLayout: 'map' });
  localStorage.clear();
  manualRaf();
  spyCanvas();
  // A 1200 by 800 board (jsdom lays nothing out).
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useViewStore.setState({ scope: 'day' });
});

const setCamera = (x: number, y: number, z: number) => act(() => useAtlasUiStore.getState().setCamera({ x, y, z }));
const minimap = () => screen.queryByTestId('atlas-minimap');
const toggle = STATIC_COMMANDS.find((c) => c.id === 'atlas.toggleMinimap')!;

function renderBoard() {
  seed([task('a'), task('b', { status: 'completed' })]);
  render(<AtlasView />);
  // Fit put the card on screen; pin the camera where the test wants it.
  setCamera(0, 0, 1);
  vi.advanceTimersByTime(ATLAS_MINIMAP_IDLE_MS + 10);
}

describe('the atlas minimap', () => {
  it('is absent while the whole board is on screen', () => {
    renderBoard();
    expect(minimap()).toBeNull();
  });

  it('shows while panning and hides a moment after', () => {
    renderBoard();
    setCamera(-2000, 0, 1);
    expect(minimap()!.getAttribute('data-shown')).toBe('true');
    expect(minimap()!.className).toMatch(/\bvisible\b/);
    act(() => {
      vi.advanceTimersByTime(ATLAS_MINIMAP_IDLE_MS - 100);
    });
    expect(minimap()!.getAttribute('data-shown')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(minimap()!.getAttribute('data-shown')).toBeNull();
    expect(minimap()!.className).toMatch(/\binvisible\b/);
    expect(minimap()!.className).toMatch(/translate-y-2/);
  });

  it('M pins it: a registered command on a new shortcut id, Atlas only', () => {
    expect(toggle.shortcut).toMatchObject({ id: 'toggle_atlas_minimap', keys: ['m'] });
    expect(DEFAULT_SHORTCUTS.some((s) => s.id === 'toggle_atlas_minimap')).toBe(true);
    expect(toggle.availableWhen!(ctx)).toBe(true);
    expect(toggle.availableWhen!({ ...ctx, isMobile: true })).toBe(false);
    act(() => useViewStore.setState({ scope: 'day' }));
    expect(toggle.availableWhen!(ctx)).toBe(false);
    act(() => useViewStore.setState({ scope: 'atlas' }));

    renderBoard();
    setCamera(-2000, 0, 1);
    act(() => toggle.run(ctx));
    expect(useAtlasUiStore.getState().minimapPinned).toBe(true);
    expect(toast).toHaveBeenCalledWith('Minimap pinned');
    act(() => {
      vi.advanceTimersByTime(ATLAS_MINIMAP_IDLE_MS * 3);
    });
    expect(minimap()!.getAttribute('data-shown')).toBe('true');
    expect(minimap()!.getAttribute('data-pinned')).toBe('true');
    act(() => toggle.run(ctx));
    expect(minimap()!.getAttribute('data-shown')).toBeNull();
  });

  it('a click flies the camera to that point, zoom kept', () => {
    renderBoard();
    setCamera(-2000, 0, 0.8);
    const place = useAtlasUiStore.getState().seeded['project:p1'];
    const canvas = minimap()!.querySelector('canvas')!;
    fireEvent.pointerDown(canvas, { button: 0, clientX: 92, clientY: 56, pointerId: 3 });
    const cam = useAtlasUiStore.getState().camera;
    expect(cam.z).toBe(0.8);
    const f = minimapFrame([{ x: place.x, y: place.y, w: ATLAS_CARD_W, h: ATLAS_CARD_H }])!;
    const want = miniToWorld(f, { x: 92, y: 56 });
    const mid = screenToWorld(cam, { x: 600, y: 400 });
    expect(mid.x).toBeCloseTo(want.x);
    expect(mid.y).toBeCloseTo(want.y);
  });

  it('carries no inline opacity, and is not on By goal', () => {
    renderBoard();
    setCamera(-2000, 0, 1);
    for (const el of [screen.getByTestId('atlas-minimap-zone'), ...screen.getByTestId('atlas-minimap-zone').querySelectorAll<HTMLElement>('*')]) {
      expect(el.style.opacity).toBe('');
      expect(el.className.toString()).not.toMatch(/\bopacity-/);
    }
    enableExtensions(EXT_GOALS);
    try {
      act(() => useViewStore.setState({ atlasLayout: 'goal' }));
      expect(screen.getByTestId('atlas-view').getAttribute('data-atlas-layout')).toBe('goal');
      setCamera(-4000, 0, 1);
      expect(minimap()).toBeNull();
    } finally {
      disableExtensions(EXT_GOALS);
    }
  });
});
