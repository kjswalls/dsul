import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

import { AtlasBoardControls } from '@/components/views/atlas/atlas-board-controls';
import { AtlasShowMenu } from '@/components/views/atlas/atlas-filters';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { useUIStore } from '@/lib/ui-store';
import { useViewStore } from '@/lib/view-store';
import { ATLAS_COPY } from '@/lib/atlas-copy';

/**
 * Atlas's controls on the board (Kirby's pick A, 2026-11-21): the tools at
 * the bottom middle, the camera at the bottom left, and Show in the header
 * pill in Display's place.
 */

beforeEach(() => {
  useAtlasUiStore.getState().reset();
  useUIStore.setState({ activeDialog: null });
  useViewStore.getState().setAtlasHideFinished(false);
  useViewStore.getState().setAtlasHideResting(false);
});
afterEach(cleanup);

function controls(over: Partial<Parameters<typeof AtlasBoardControls>[0]> = {}) {
  const props = {
    onZoomBy: vi.fn(),
    onZoomReset: vi.fn(),
    minimap: true,
    goalsShown: true,
    collectionsShown: true,
    ...over,
  };
  render(<AtlasBoardControls {...props} />);
  return props;
}

/** Radix opens a menu on pointerdown (or a key), not on a bare click. */
function openMenu(el: HTMLElement) {
  fireEvent.pointerDown(el, { button: 0, pointerType: 'mouse' });
}

describe('Atlas board controls', () => {
  it('zooms in and out by a step and goes to 100% from the zoom itself', () => {
    const p = controls();
    fireEvent.click(screen.getByTestId('atlas-zoom-in'));
    expect(p.onZoomBy).toHaveBeenLastCalledWith(1.25);
    fireEvent.click(screen.getByTestId('atlas-zoom-out'));
    expect(p.onZoomBy).toHaveBeenLastCalledWith(0.8);
    fireEvent.click(screen.getByTestId('atlas-zoom'));
    expect(p.onZoomReset).toHaveBeenCalledOnce();
  });

  it('shows the camera zoom, and names it for a screen reader', () => {
    act(() => useAtlasUiStore.getState().setCamera({ x: 0, y: 0, z: 0.71 }));
    controls();
    const z = screen.getByTestId('atlas-zoom');
    expect(z.textContent).toBe('71%');
    expect(z.getAttribute('aria-label')).toBe(ATLAS_COPY.zoomLabel(71));
  });

  it('asks for a fit', () => {
    controls();
    const before = useAtlasUiStore.getState().fitToken;
    fireEvent.click(screen.getByTestId('atlas-fit'));
    expect(useAtlasUiStore.getState().fitToken).toBe(before + 1);
  });

  it('pins the minimap and says so, and has no pin where the layout draws none', () => {
    controls();
    const pin = screen.getByTestId('atlas-minimap-pin');
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pin);
    expect(useAtlasUiStore.getState().minimapPinned).toBe(true);
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    expect(pin.getAttribute('aria-label')).toBe(ATLAS_COPY.minimapUnpin);
    cleanup();
    controls({ minimap: false });
    expect(screen.queryByTestId('atlas-minimap-pin')).toBeNull();
  });

  it('New opens the same "new" dialog as the palette, for each kind the account has', () => {
    controls();
    openMenu(screen.getByTestId('atlas-new'));
    for (const k of ['project', 'goal', 'routine', 'season']) expect(screen.getByTestId(`atlas-new-${k}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId('atlas-new-routine'));
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'new-container', kind: 'routine' });
  });

  it('New names only the kinds that are on', () => {
    controls({ goalsShown: false, collectionsShown: false });
    openMenu(screen.getByTestId('atlas-new'));
    expect(screen.getByTestId('atlas-new-project')).toBeTruthy();
    for (const k of ['goal', 'routine', 'season']) expect(screen.queryByTestId(`atlas-new-${k}`)).toBeNull();
  });
});

describe('Atlas Show menu', () => {
  it('folds the two filters into one menu and counts what is hidden', () => {
    render(<AtlasShowMenu />);
    const trigger = screen.getByTestId('atlas-show');
    expect(screen.queryByTestId('atlas-show-count')).toBeNull();
    expect(trigger.getAttribute('aria-label')).toBe(ATLAS_COPY.showLabel(0));
    openMenu(trigger);
    const finished = screen.getByTestId('atlas-show-finished');
    expect(finished.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(finished);
    expect(useViewStore.getState().atlasHideFinished).toBe(true);
    // The menu stays open for the second one.
    fireEvent.click(screen.getByTestId('atlas-show-resting'));
    expect(useViewStore.getState().atlasHideResting).toBe(true);
    expect(screen.getByTestId('atlas-show-count').textContent).toBe('2');
    expect(trigger.getAttribute('aria-label')).toBe(ATLAS_COPY.showLabel(2));
  });
});
