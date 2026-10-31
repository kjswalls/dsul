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
import { useCommandShortcuts } from '@/hooks/use-command-shortcuts';
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

function ShortcutHarness() {
  useCommandShortcuts(ctx);
  return null;
}

function renderBoard() {
  seed([task('a'), task('b', { status: 'completed' })]);
  render(
    <>
      <AtlasView />
      <ShortcutHarness />
    </>
  );
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

  it('M through the real shortcut dispatcher: not with Cmd or Ctrl, not while typing, not under the sheet', () => {
    renderBoard();
    const root = screen.getByTestId('atlas-view');
    const pinned = () => useAtlasUiStore.getState().minimapPinned;
    fireEvent.keyDown(root, { key: 'm' });
    expect(pinned()).toBe(true);
    fireEvent.keyUp(root, { key: 'm' });
    fireEvent.keyDown(root, { key: 'm', metaKey: true });
    fireEvent.keyUp(root, { key: 'm', metaKey: true });
    fireEvent.keyDown(root, { key: 'm', ctrlKey: true });
    fireEvent.keyUp(root, { key: 'm', ctrlKey: true });
    expect(pinned()).toBe(true);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: 'm' });
    fireEvent.keyUp(input, { key: 'm' });
    expect(pinned()).toBe(true);
    input.remove();
    // Behind the focus sheet M is gated like Atlas's other keys.
    act(() => useAtlasUiStore.getState().openSheet('project', 'p1', { x: 0, y: 0, width: 10, height: 10 }));
    expect(toggle.availableWhen!(ctx)).toBe(false);
    act(() => useAtlasUiStore.getState().closeSheet());
    fireEvent.keyDown(root, { key: 'm' });
    expect(pinned()).toBe(false);
  });

  it('a drag flies the camera as it moves, and a held drag still sleeps after release', () => {
    // A board bigger than the screen wherever the camera lands, so the
    // minimap stays through the drag.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
    renderBoard();
    setCamera(-2000, 0, 2);
    const canvas = minimap()!.querySelector('canvas')!;
    fireEvent.pointerDown(canvas, { button: 0, clientX: 80, clientY: 56, pointerId: 4 });
    const first = useAtlasUiStore.getState().camera;
    fireEvent.pointerMove(canvas, { clientX: 100, clientY: 56, pointerId: 4 });
    const second = useAtlasUiStore.getState().camera;
    expect(second.x).not.toBe(first.x);
    // Held still past the idle delay: still shown while held.
    act(() => {
      vi.advanceTimersByTime(ATLAS_MINIMAP_IDLE_MS * 2);
    });
    expect(minimap()!.getAttribute('data-shown')).toBe('true');
    fireEvent.pointerUp(canvas, { clientX: 100, clientY: 56, pointerId: 4 });
    act(() => {
      vi.advanceTimersByTime(ATLAS_MINIMAP_IDLE_MS + 100);
    });
    expect(minimap()!.getAttribute('data-shown')).toBeNull();
    // After the release a move no longer flies.
    const released = useAtlasUiStore.getState().camera;
    fireEvent.pointerMove(canvas, { clientX: 60, clientY: 56, pointerId: 4 });
    expect(useAtlasUiStore.getState().camera).toBe(released);
  });

  it('a pinch over its corner zooms Atlas, never the page', () => {
    renderBoard();
    setCamera(-2000, 0, 0.8);
    const zone = screen.getByTestId('atlas-minimap-zone');
    const ev = new WheelEvent('wheel', { deltaY: -20, ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      zone.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(useAtlasUiStore.getState().camera.z).toBeGreaterThan(0.8);
  });

  it('is hidden from assistive tech, with no pointer instruction', () => {
    renderBoard();
    setCamera(-2000, 0, 1);
    const zone = screen.getByTestId('atlas-minimap-zone');
    expect(zone.getAttribute('aria-hidden')).toBe('true');
    expect(zone.querySelector('[title]')).toBeNull();
    expect(zone.querySelector('[role]')).toBeNull();
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
