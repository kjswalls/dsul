import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

vi.mock('@/components/zen/zen-room', () => ({
  ZenSurface: () => <div data-testid="zen-surface" />,
}));
vi.mock('@/lib/settings-service', () => ({
  saveSettings: vi.fn(async () => {}),
}));

import { ZenStage } from '@/components/zen/zen-stage';
import { useViewStore } from '@/lib/view-store';

function setReduced(reduced: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: reduced && q.includes('reduce'),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  act(() => useViewStore.setState({ zenOpen: false, zenMoving: false }));
});

describe('ZenStage', () => {
  it('mounts exactly one surface at rest', () => {
    setReduced(false);
    useViewStore.setState({ zenOpen: false });
    render(<ZenStage planner={<div data-testid="planner" />} />);
    expect(screen.getByTestId('planner')).toBeInTheDocument();
    expect(screen.queryByTestId('zen-surface')).toBeNull();
  });

  it('keeps the outgoing planner mounted in place while Zen comes in over it', () => {
    setReduced(false);
    // A 2d context that draws nothing, so the wave starts and stays in flight.
    const noop = () => {};
    const ctx = new Proxy({}, { get: () => noop });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D
    );
    useViewStore.setState({ zenOpen: false });
    render(<ZenStage planner={<div data-testid="planner" />} />);
    const before = screen.getByTestId('planner');

    act(() => useViewStore.getState().setZenOpen(true));
    // Mid-switch: both surfaces, the planner the very same node, Zen clipped shut.
    expect(screen.getByTestId('planner')).toBe(before);
    const zenLayer = document.querySelector<HTMLElement>('[data-zen-layer="zen"]')!;
    expect(zenLayer.className).toContain('fixed');
    expect(zenLayer.style.clipPath).toContain('circle(0px');
    expect(useViewStore.getState().zenMoving).toBe(true);
    // The planner is on its way out: it takes no hover or click meanwhile.
    expect(document.querySelector('[data-zen-layer="planner"]')!.hasAttribute('inert')).toBe(true);

    // Pressing Z again mid-flight lands straight back on the planner, unmoved.
    act(() => useViewStore.getState().setZenOpen(false));
    expect(screen.getByTestId('planner')).toBe(before);
    expect(useViewStore.getState().zenMoving).toBe(false);
    expect(screen.queryByTestId('zen-surface')).toBeNull();
    expect(document.querySelector('canvas')).toBeNull();
  });

  it('switches instantly under reduced motion', () => {
    setReduced(true);
    useViewStore.setState({ zenOpen: false });
    render(<ZenStage planner={<div data-testid="planner" />} />);
    act(() => useViewStore.getState().setZenOpen(true));
    expect(screen.queryByTestId('planner')).toBeNull();
    expect(screen.getByTestId('zen-surface')).toBeInTheDocument();
    expect(document.querySelector('canvas')).toBeNull();
  });

  it('lands: the wave finishes, the planner leaves, and the room sits at rest', () => {
    setReduced(false);
    const noop = () => {};
    const ctx = new Proxy({}, { get: () => noop });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D
    );
    // Every frame arrives two seconds late, so the first one is the last.
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(performance.now() + 2000);
      return 1;
    });
    useViewStore.setState({ zenOpen: false, zenMoving: false });
    render(<ZenStage planner={<div data-testid="planner" />} />);
    act(() => useViewStore.getState().setZenOpen(true));

    expect(screen.queryByTestId('planner')).toBeNull();
    const zenLayer = document.querySelector<HTMLElement>('[data-zen-layer="zen"]')!;
    expect(zenLayer.className).toBe('contents');
    expect(zenLayer.style.clipPath).toBe('');
    expect(zenLayer.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('canvas')).toBeNull();
    expect(useViewStore.getState().zenMoving).toBe(false);
  });
});
