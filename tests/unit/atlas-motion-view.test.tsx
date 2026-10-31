import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, render, cleanup, fireEvent, within } from '@testing-library/react';

/**
 * Atlas's small moments (round 2, part B), in the view: a tick pops the tile
 * that lit and pulses the count, a row filed in pulses the count as a
 * receipt, a pin settles the card once its glide lands, a layout switch
 * cascades left to right and then drops its delays, and a strand that
 * appears draws in. Every one is a Web Animation on transform or stroke
 * (never opacity), and none plays under reduced motion.
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
// A settled planner with no account: the moments are news only once settled.
vi.mock('@/lib/planner-ready', async (orig) => ({
  ...(await orig<typeof import('@/lib/planner-ready')>()),
  usePlannerSettled: () => true,
}));

import { AtlasView } from '@/components/views/atlas/atlas-view';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { useAtlasStore } from '@/lib/atlas-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { ATLAS_GLIDE, ATLAS_MOTION } from '@/lib/atlas-motion';
import { EXT_GOALS } from '@/lib/extension-registry';
import type { Item, Project } from '@/lib/planner-types';
import { disableExtensions, enableExtensions } from './support/extensions';
import { TODAY, asDate, installDomShims, manualRaf, seed, task } from './helpers/atlas-far-setup';

beforeAll(installDomShims);

interface Played {
  el: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}
let played: Played[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(asDate(TODAY));
  useAtlasUiStore.getState().reset();
  useAtlasStore.getState().reset();
  usePlannerStore.setState({ isPreview: false } as never);
  localStorage.clear();
  document.documentElement.removeAttribute('data-reduce-motion');
  manualRaf();
  played = [];
  const animate = function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    played.push({ el: this, keyframes, options });
    return { cancel() {}, finished: Promise.resolve() } as unknown as Animation;
  };
  (Element.prototype as unknown as { animate: unknown }).animate = animate;
  (SVGElement.prototype as unknown as { getTotalLength: () => number }).getTotalLength = () => 240;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (Element.prototype as unknown as { animate?: unknown }).animate;
  delete (SVGElement.prototype as unknown as { getTotalLength?: unknown }).getTotalLength;
  document.documentElement.removeAttribute('data-reduce-motion');
  useViewStore.setState({ atlasLayout: 'map' });
});

const card = (key = 'project:p1') => document.querySelector<HTMLElement>(`[data-atlas-card="${key}"]`)!;
const onTestId = (id: string) => played.filter((p) => (p.el as HTMLElement).dataset?.testid === id);
const keyframesHaveNoOpacity = () => {
  for (const p of played) for (const k of p.keyframes) expect(Object.keys(k)).not.toContain('opacity');
};

describe('a tick and a filed row', () => {
  it('pops the tile that lit and pulses the count, by transform', () => {
    seed([task('a'), task('b')]);
    render(<AtlasView />);
    expect(played).toHaveLength(0);
    fireEvent.click(within(card()).getByTestId('atlas-row-check'), { detail: 1 });
    const tiles = played.filter((p) => (p.el as HTMLElement).tagName === 'I');
    expect(tiles).toHaveLength(1);
    expect((tiles[0].el as HTMLElement).dataset.tile).toBe('lit');
    expect(tiles[0].options.duration).toBe(ATLAS_MOTION.tilePopMs);
    const count = onTestId('atlas-count');
    expect(count).toHaveLength(1);
    expect(count[0].options.duration).toBe(ATLAS_MOTION.receiptMs);
    expect(count[0].keyframes.every((k) => typeof k.transform === 'string')).toBe(true);
    keyframesHaveNoOpacity();
  });

  it('pulses the count as a receipt when a row is filed into the card', () => {
    seed([task('a')]);
    render(<AtlasView />);
    act(() => {
      const items = [...usePlannerStore.getState().items, task('n', { project: 'Work' })] as Item[];
      usePlannerStore.setState({ items, tasks: items as never });
    });
    expect(onTestId('atlas-count')).toHaveLength(1);
    // A new tile arrives with its own pop.
    expect(played.some((p) => (p.el as HTMLElement).tagName === 'I')).toBe(true);
    keyframesHaveNoOpacity();
  });

  it('pulses nothing when the cached preview gives way to the real load', () => {
    seed([task('a')]);
    usePlannerStore.setState({ isPreview: true } as never);
    render(<AtlasView />);
    act(() => {
      const items = [...usePlannerStore.getState().items, task('n', { project: 'Work' })] as Item[];
      usePlannerStore.setState({ items, tasks: items as never, isPreview: false } as never);
    });
    expect(played).toHaveLength(0);
  });

  it('plays nothing under reduced motion', () => {
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    seed([task('a'), task('b')]);
    render(<AtlasView />);
    fireEvent.click(within(card()).getByTestId('atlas-row-check'), { detail: 1 });
    expect(played).toHaveLength(0);
  });
});

describe('a pin', () => {
  it('settles the card once its glide lands, added to its place', () => {
    seed([task('a')]);
    useViewStore.setState({ atlasLayout: 'momentum' });
    render(<AtlasView />);
    act(() => useAtlasStore.getState().pin('project', 'p1', 'now', undefined));
    const settle = played.filter((p) => p.el === card());
    expect(settle).toHaveLength(1);
    expect(settle[0].options.composite).toBe('add');
    expect(settle[0].options.delay).toBeGreaterThan(0);
    expect(settle[0].options.delay!).toBeLessThan(ATLAS_MOTION.glideMs);
    keyframesHaveNoOpacity();
  });
});

describe('a layout switch', () => {
  const TWO = [{ id: 'p1', name: 'Work', emoji: '' }, { id: 'p2', name: 'Home', emoji: '' }] as Project[];

  it('cascades left to right, then drops its delays so a spring back never waits', () => {
    seed([task('a'), task('c', { project: 'Home', startDate: TODAY })], TWO);
    render(<AtlasView />);
    expect(card().style.transition).toBe(ATLAS_GLIDE);
    act(() => useViewStore.getState().setAtlasLayout('momentum'));
    const delays = ['project:p1', 'project:p2'].map((k) => {
      const m = card(k).style.transition.match(/ (\d+)ms$/);
      return m && card(k).style.transition !== ATLAS_GLIDE ? Number(m[1]) : 0;
    });
    // Home is in Now (left), Work in Soon (right): Work goes later.
    expect(delays[0]).toBeGreaterThan(delays[1]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(ATLAS_MOTION.glideStaggerMs);
    act(() => {
      vi.advanceTimersByTime(ATLAS_MOTION.glideMs + ATLAS_MOTION.glideStaggerMs + 60);
    });
    expect(card('project:p1').style.transition).toBe(ATLAS_GLIDE);
    expect(card('project:p2').style.transition).toBe(ATLAS_GLIDE);
  });

  it('has no cascade under reduced motion', () => {
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    seed([task('a'), task('c', { project: 'Home', startDate: TODAY })], TWO);
    render(<AtlasView />);
    act(() => useViewStore.getState().setAtlasLayout('momentum'));
    expect(card('project:p1').style.transition).toBe('');
  });
});

describe('strands', () => {
  const goal = (id: string, memberIds: string[]) =>
    ({ id, name: `Goal ${id}`, state: 'active', memberIds, milestoneIds: [], checkinIds: [] }) as never;
  afterEach(() => disableExtensions(EXT_GOALS));

  it('draw in from the goal by dash offset when they appear, ending on their rest dash', () => {
    enableExtensions(EXT_GOALS);
    seed([task('a')]);
    usePlannerStore.setState({ goals: [goal('g1', ['a'])] });
    render(<AtlasView />);
    const path = document.querySelector('[data-atlas-strand]')!;
    const draw = played.filter((p) => p.el === path);
    expect(draw).toHaveLength(1);
    const [from, to] = draw[0].keyframes;
    expect(Number(from.strokeDashoffset)).toBeGreaterThan(240);
    expect(Number(to.strokeDashoffset)).toBe(0);
    expect(String(from.strokeDasharray).startsWith('3 5 3 5')).toBe(true);
    expect(draw[0].options.fill).toBe('backwards');
    // Hovering turns it lime: the same strand, so it does not draw in again.
    fireEvent.pointerOver(card());
    expect(played.filter((p) => p.el === path)).toHaveLength(1);
    keyframesHaveNoOpacity();
  });

  it('appear whole under reduced motion', () => {
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    enableExtensions(EXT_GOALS);
    seed([task('a')]);
    usePlannerStore.setState({ goals: [goal('g1', ['a'])] });
    render(<AtlasView />);
    expect(document.querySelector('[data-atlas-strand]')).toBeTruthy();
    expect(played).toHaveLength(0);
  });
});
