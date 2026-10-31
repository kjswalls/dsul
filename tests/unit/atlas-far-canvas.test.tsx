import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react';

/**
 * Atlas's far zoom (design PR3): below 0.5 the DOM cards unmount and the
 * Relay grid canvas draws; in the 0.6 to 0.5 band both are there and the
 * cards shrink by transform; Dusk turns the island `.dark` only on a light
 * theme; colours are read from inside the island; reduced motion draws one
 * still frame; a cluster flies in on a click or Enter and has the container's
 * right-click menu. Nothing is faded by opacity.
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
import { useLookStore } from '@/lib/look-store';
import { useUIStore } from '@/lib/ui-store';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { ATLAS_CARD_W } from '@/lib/atlas-seed';
import { ATLAS_FOLD_Y, ATLAS_MOTION, foldScale, sweepAt } from '@/lib/atlas-motion';
import { TODAY, asDate, installDomShims, manualRaf, seed, sizeCanvases, spyCanvas, task } from './helpers/atlas-far-setup';

beforeAll(installDomShims);

let raf: ReturnType<typeof manualRaf>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(asDate(TODAY));
  useAtlasUiStore.getState().reset();
  useAtlasStore.getState().reset();
  useLookStore.setState({ atlasFarPaper: 'bloom' });
  useUIStore.setState({ activeDialog: null });
  localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('data-reduce-motion');
  raf = manualRaf();
  sizeCanvases();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('data-reduce-motion');
});

const zoom = (z: number) => act(() => useAtlasUiStore.getState().setCamera({ x: 0, y: 0, z }));
const cards = () => document.querySelectorAll('[data-atlas-card]');
const canvas = () => screen.queryByTestId('atlas-far-canvas');
const island = () => screen.getByTestId('atlas-island');

describe('the far zoom', () => {
  it('unmounts the cards below 0.5 and draws the canvas, with both in the handoff band', () => {
    const log = spyCanvas();
    seed([task('a'), task('b', { status: 'completed' }), task('c')]);
    render(<AtlasView />);
    expect(cards()).toHaveLength(1);
    expect(canvas()).toBeNull();

    // The band: the card shrinks by transform, no glide, and the canvas comes up.
    zoom(0.55);
    expect(cards()).toHaveLength(1);
    expect(canvas()).not.toBeNull();
    const card = cards()[0] as HTMLElement;
    // It folds flat onto its tile strip by the world's fold, scrubbed by the zoom.
    expect(card.style.transform).toMatch(/scale\(var\(--atlas-fold-x, 1\), var\(--atlas-fold-y, 1\)\)/);
    expect(card.style.transformOrigin).toBe(`${ATLAS_CARD_W / 2}px ${ATLAS_FOLD_Y}px`);
    expect(card.style.transition).toBe('none');
    const world = screen.getByTestId('atlas-world');
    expect(world.getAttribute('data-handoff')).toBe('true');
    const fold = foldScale(0.5);
    expect(parseFloat(world.style.getPropertyValue('--atlas-fold-x'))).toBeCloseTo(fold.sx, 3);
    expect(parseFloat(world.style.getPropertyValue('--atlas-fold-y'))).toBeCloseTo(fold.sy, 3);
    expect(parseFloat(world.style.getPropertyValue('--atlas-sweep'))).toBeCloseTo(sweepAt(0.5), 3);
    // The tiles fly on the overlay, drawn over the cards.
    expect(screen.getByTestId('atlas-handoff-canvas')).toBeTruthy();
    // The CSS dots step aside; the canvas draws the grid.
    expect(screen.queryByTestId('atlas-dots')).toBeNull();
    // No cluster buttons while the cards are still there.
    expect(document.querySelector('[data-atlas-far-cluster]')).toBeNull();

    zoom(0.4);
    expect(cards()).toHaveLength(0);
    expect(canvas()).not.toBeNull();
    const hit = document.querySelector<HTMLElement>('[data-atlas-far-cluster="project:p1"]')!;
    expect(hit).toBeTruthy();
    expect(hit.getAttribute('aria-label')).toBe(ATLAS_COPY.farClusterLabel('Work', 'Project'));

    // A frame paints tiles (one sprite per item) and the label.
    raf.step();
    expect(log.count('drawImage')).toBeGreaterThanOrEqual(3);
    expect(log.texts()).toContain('Work');
    expect(log.texts()).toContain(ATLAS_COPY.farLeft(2));

    // Back past 0.6: cards only.
    zoom(0.8);
    expect(cards()).toHaveLength(1);
    expect(canvas()).toBeNull();
    expect(screen.queryByTestId('atlas-handoff-canvas')).toBeNull();
    expect((cards()[0] as HTMLElement).style.transform).not.toMatch(/atlas-fold/);
  });

  it('streams the tiles on the overlay through the band, drawing only strictly inside it', () => {
    const log = spyCanvas();
    seed([task('a'), task('b', { status: 'completed' }), task('c')]);
    render(<AtlasView />);
    zoom(0.55);
    log.calls.length = 0;
    raf.step();
    // Mid-band: the strip squares (fills) and the landing sprites, and the
    // constellation canvas holds its labels back until the tiles have landed.
    expect(log.count('drawImage')).toBeGreaterThan(0);
    expect(log.count('stroke')).toBeGreaterThan(0);
    expect(log.texts()).toEqual([]);
    // Scrubbed by the zoom: a nudge redraws, with no clock running.
    zoom(0.54);
    expect(raf.pending()).toBeGreaterThan(0);
    raf.step();
    expect(raf.pending()).toBe(0);
  });

  it('is a plain swap under reduced motion: no fold, no overlay, nothing drawn but dots until 0.5', () => {
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    const log = spyCanvas();
    seed([task('a'), task('b', { status: 'completed' })]);
    render(<AtlasView />);
    zoom(0.55);
    const card = cards()[0] as HTMLElement;
    expect(card.style.transform).toBe('translate(0px, 0px)');
    expect(screen.getByTestId('atlas-world').getAttribute('data-handoff')).toBeNull();
    expect(screen.queryByTestId('atlas-handoff-canvas')).toBeNull();
    log.calls.length = 0;
    raf.step();
    expect(log.count('drawImage')).toBe(0);
    expect(log.texts()).toEqual([]);
    zoom(0.4);
    raf.step();
    expect(log.texts()).toContain('Work');
  });

  it('plays the handoff as a timed flourish on a click fly-in, then lets go', () => {
    const log = spyCanvas();
    seed([task('a'), task('b', { status: 'completed' })]);
    render(<AtlasView />);
    zoom(0.3);
    const hit = document.querySelector<HTMLElement>('[data-atlas-far-cluster="project:p1"]')!;
    fireEvent.pointerDown(hit, { button: 0, clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(window, { button: 0, clientX: 50, clientY: 50, pointerId: 1 });
    const seen: number[] = [];
    let flown = false;
    for (let i = 0; i < 60 && raf.pending() > 0; i++) {
      act(() => raf.step(16));
      const { camera, flourish } = useAtlasUiStore.getState();
      if (flourish !== null) seen.push(flourish);
      // Past the camera's flight the cards are whole-sized boxes still assembling.
      if (camera.z === 1 && flourish !== null && flourish > 0.05 && !flown) {
        flown = true;
        expect(cards()).toHaveLength(1);
        expect(screen.getByTestId('atlas-world').getAttribute('data-handoff')).toBe('true');
        expect(screen.getByTestId('atlas-handoff-canvas')).toBeTruthy();
      }
    }
    // The assembly ran on its own clock past the flight, and came down to whole cards.
    expect(flown).toBe(true);
    expect(seen.length).toBeGreaterThan(ATLAS_MOTION.flyMs / 16);
    expect(seen[seen.length - 1]).toBeLessThan(0.05);
    const end = useAtlasUiStore.getState();
    expect(end.camera.z).toBe(1);
    expect(end.flourish).toBeNull();
    expect(screen.queryByTestId('atlas-handoff-canvas')).toBeNull();
    expect(screen.getByTestId('atlas-world').getAttribute('data-handoff')).toBeNull();
    expect(log.count('drawImage')).toBeGreaterThan(0);
  });

  it('a pinch during the flourish takes the handoff back at once', () => {
    spyCanvas();
    seed([task('a')]);
    render(<AtlasView />);
    zoom(0.3);
    const hit = document.querySelector<HTMLElement>('[data-atlas-far-cluster="project:p1"]')!;
    fireEvent.keyDown(hit, { key: 'Enter' });
    for (let i = 0; i < 4; i++) act(() => raf.step(16));
    expect(useAtlasUiStore.getState().flourish).not.toBeNull();
    zoom(0.8);
    expect(useAtlasUiStore.getState().flourish).toBeNull();
    act(() => raf.step(16));
    expect(useAtlasUiStore.getState().camera.z).toBe(0.8);
  });

  it('turns the island dark under Dusk only, only zoomed out, only on a light theme', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    spyCanvas();
    seed([task('a')]);
    render(<AtlasView />);
    zoom(0.4);
    expect(island().classList.contains('dark')).toBe(false);
    expect(screen.getByTestId('atlas-ground').style.backgroundColor).toBe('transparent');

    act(() => useLookStore.getState().setAtlasFarPaper('dusk'));
    expect(island().getAttribute('data-atlas-dusk')).toBe('true');
    expect(screen.getByTestId('atlas-ground').style.backgroundColor).toMatch(/oklch/);
    expect(screen.getByTestId('atlas-ground').style.transition).toMatch(/^background-color /);
    // The ground fades first; the ink (and the glow) follow once it is slate,
    // so nothing glows on paper.
    expect(island().classList.contains('dark')).toBe(false);
    act(() => vi.advanceTimersByTime(400));
    expect(island().classList.contains('dark')).toBe(true);

    // Dusk holds through the band (no flicker at 0.5), and lets go at 0.6.
    zoom(0.55);
    expect(island().classList.contains('dark')).toBe(true);
    zoom(0.45);
    expect(island().classList.contains('dark')).toBe(true);
    zoom(0.7);
    expect(island().classList.contains('dark')).toBe(false);
    expect(island().getAttribute('data-atlas-dusk')).toBeNull();
    // Coming in from above, the band alone never turns Dusk on.
    zoom(0.55);
    expect(island().getAttribute('data-atlas-dusk')).toBeNull();
  });

  it('keeps the CSS dot grid on an empty board at every zoom', () => {
    spyCanvas();
    seed([], []);
    render(<AtlasView />);
    zoom(0.3);
    expect(canvas()).toBeNull();
    expect(screen.getByTestId('atlas-dots')).toBeTruthy();
  });

  it('never darkens the island on a dark theme, where the far zoom already glows', async () => {
    spyCanvas();
    document.documentElement.classList.add('dark');
    useLookStore.setState({ atlasFarPaper: 'dusk' });
    seed([task('a')]);
    render(<AtlasView />);
    zoom(0.4);
    expect(island().classList.contains('dark')).toBe(false);
  });

  it('reads colours from inside the island, so Dusk draws with the dark values', () => {
    spyCanvas();
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
      const cs = real(el, pseudo);
      const dark = !!el.closest?.('.dark');
      const values: Record<string, string> = {
        '--background': dark ? 'oklch(17.3% 0.005 286)' : 'oklch(0.986 0.0012 90)',
        '--accent-1': dark ? 'oklch(0.66 0.1 140)' : 'oklch(0.68 0.11 140)',
      };
      return new Proxy(cs, {
        get: (t, prop) =>
          prop === 'getPropertyValue'
            ? (name: string) => values[name] ?? t.getPropertyValue(name)
            : Reflect.get(t, prop, t),
      });
    });
    seed([task('a')]);
    render(<AtlasView />);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    zoom(0.4);
    expect(canvas()!.getAttribute('data-atlas-far-mode')).toBe('bloom');
    act(() => useLookStore.getState().setAtlasFarPaper('dusk'));
    act(() => vi.advanceTimersByTime(400));
    expect(canvas()!.getAttribute('data-atlas-far-mode')).toBe('glow');
  });

  it('waves for a container touched this week, and draws one still frame under reduced motion', () => {
    spyCanvas();
    seed([task('a', { status: 'completed', completedDates: [TODAY] }), task('b')]);
    const view = render(<AtlasView />);
    zoom(0.4);
    expect(canvas()!.getAttribute('data-waving')).toBe('true');
    // The loop keeps asking for frames.
    raf.step();
    raf.step();
    expect(raf.pending()).toBeGreaterThan(0);
    view.unmount();

    document.documentElement.setAttribute('data-reduce-motion', 'true');
    useAtlasUiStore.getState().reset();
    render(<AtlasView />);
    zoom(0.4);
    expect(canvas()!.getAttribute('data-waving')).toBeNull();
    raf.step();
    // One frame was drawn on demand, and nothing asks for another.
    expect(raf.pending()).toBe(0);
  });

  it('flies in on a click or Enter, and a drag does not', () => {
    spyCanvas();
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    seed([task('a')]);
    render(<AtlasView />);
    zoom(0.3);
    const hit = () => document.querySelector<HTMLElement>('[data-atlas-far-cluster="project:p1"]')!;

    fireEvent.pointerDown(hit(), { button: 0, clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(window, { button: 0, clientX: 90, clientY: 50, pointerId: 1 });
    expect(useAtlasUiStore.getState().camera.z).toBe(0.3);

    fireEvent.pointerDown(hit(), { button: 0, clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(window, { button: 0, clientX: 51, clientY: 50, pointerId: 1 });
    expect(useAtlasUiStore.getState().camera.z).toBe(1);
    // The cards are back at zoom 1.
    expect(cards()).toHaveLength(1);

    zoom(0.3);
    fireEvent.keyDown(hit(), { key: 'Enter' });
    expect(useAtlasUiStore.getState().camera.z).toBe(1);
  });

  it('keeps focus on the map through a fly-in, landing on the card', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    spyCanvas();
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    seed([task('a')]);
    render(<AtlasView />);
    zoom(0.3);
    const hit = document.querySelector<HTMLElement>('[data-atlas-far-cluster="project:p1"]')!;
    act(() => hit.focus());
    fireEvent.keyDown(hit, { key: 'Enter' });
    expect(useAtlasUiStore.getState().camera.z).toBe(1);
    // The cluster is gone: focus never drops to <body>.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByTestId('atlas-view'));
    act(() => vi.advanceTimersByTime(0));
    expect(document.activeElement?.getAttribute('data-atlas-card')).toBe('project:p1');
  });

  it('pans a far cluster on screen when Tab reaches it', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
    spyCanvas();
    seed([task('a')]);
    render(<AtlasView />);
    // Far off to the right of the screen.
    act(() => useAtlasUiStore.getState().setCamera({ x: -5000, y: 0, z: 0.3 }));
    const hit = document.querySelector<HTMLElement>('[data-atlas-far-cluster="project:p1"]')!;
    act(() => hit.focus());
    expect(useAtlasUiStore.getState().camera.x).not.toBe(-5000);
  });

  it("says what the tiles show to a screen reader", () => {
    spyCanvas();
    seed([task('a', { title: 'Write the brief' }), task('b', { status: 'completed' })]);
    render(<AtlasView />);
    zoom(0.3);
    expect(screen.getByTestId('atlas-far-hits').getAttribute('aria-label')).toBe(ATLAS_COPY.farLabel);
    const hit = document.querySelector<HTMLElement>('[data-atlas-far-cluster="project:p1"]')!;
    const status = document.getElementById(hit.getAttribute('aria-describedby')!)!;
    expect(status.textContent).toBe(
      ATLAS_COPY.farClusterStatus(ATLAS_COPY.farTip('Project', 1, 2), ATLAS_COPY.farNext('Write the brief'))
    );
  });

  it("a cluster's right-click is the container's menu, with Zoom in here", () => {
    spyCanvas();
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    seed([task('a')]);
    render(<AtlasView />);
    zoom(0.3);
    const hit = document.querySelector<HTMLElement>('[data-atlas-far-cluster="project:p1"]')!;
    fireEvent.contextMenu(hit, { clientX: 10, clientY: 10 });
    expect(screen.getByTestId('container-context-menu')).toBeTruthy();
    fireEvent.click(screen.getByTestId('container-menu-zoom-in'));
    expect(useAtlasUiStore.getState().camera.z).toBe(1);
  });

  it('shows a tooltip on hover, by visibility of an element, never a fade', () => {
    spyCanvas();
    seed([task('a', { title: 'Write the brief' }), task('b', { status: 'completed' })]);
    render(<AtlasView />);
    zoom(0.3);
    const hit = document.querySelector<HTMLElement>('[data-atlas-far-cluster="project:p1"]')!;
    fireEvent.pointerEnter(hit);
    const tip = screen.getByTestId('atlas-far-tip');
    expect(tip.textContent).toContain('Work');
    expect(tip.textContent).toContain(ATLAS_COPY.farTip('Project', 1, 2));
    expect(tip.textContent).toContain(ATLAS_COPY.farNext('Write the brief'));
    fireEvent.pointerLeave(hit);
    expect(screen.queryByTestId('atlas-far-tip')).toBeNull();

    // Zoomed into the band mid-hover (no pointerleave), then back out: no stale tip.
    fireEvent.pointerEnter(document.querySelector<HTMLElement>('[data-atlas-far-cluster="project:p1"]')!);
    expect(screen.getByTestId('atlas-far-tip')).toBeTruthy();
    zoom(0.55);
    zoom(0.3);
    expect(screen.queryByTestId('atlas-far-tip')).toBeNull();
  });

  it('carries no opacity anywhere in the island, zoomed out or in the band', () => {
    spyCanvas();
    useLookStore.setState({ atlasFarPaper: 'dusk' });
    seed([task('a'), task('b')]);
    render(<AtlasView />);
    for (const z of [0.55, 0.3]) {
      zoom(z);
      const all = [island(), ...island().querySelectorAll<HTMLElement>('*')];
      for (const el of all) {
        expect(el.style.opacity, el.outerHTML.slice(0, 80)).toBe('');
        expect(el.className.toString()).not.toMatch(/\bopacity-/);
      }
    }
  });
});
