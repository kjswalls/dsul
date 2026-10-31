import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, render, cleanup, fireEvent, screen } from '@testing-library/react';

/**
 * Strands and season frames on Atlas's card layer (round 2,
 * components/views/atlas/atlas-strands.tsx): dashed ink strands from a goal
 * to what feeds it, lime when either end is hovered or focused, following a
 * card as it moves without re-rendering any card; a frame round a season and
 * its routines on Your map; none on By goal or from the handoff band down.
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
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { ATLAS_STRAND_REST_CAP } from '@/lib/atlas-strands';
import { EXT_GOALS } from '@/lib/extension-registry';
import type { Project } from '@/lib/planner-types';
import { disableExtensions, enableExtensions } from './support/extensions';
import { TODAY, asDate, installDomShims, manualRaf, seed, task } from './helpers/atlas-far-setup';

beforeAll(installDomShims);

let raf: ReturnType<typeof manualRaf>;
/** performance.now() as a clock the frames move, so the follow loop's deadline passes. */
let clock = 0;
const frame = (ms: number) => {
  clock += ms;
  raf.step(ms);
};
beforeEach(() => {
  clock = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(asDate(TODAY));
  useAtlasUiStore.getState().reset();
  useAtlasStore.getState().reset();
  localStorage.clear();
  document.documentElement.removeAttribute('data-reduce-motion');
  raf = manualRaf();
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  enableExtensions(EXT_GOALS);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  disableExtensions(EXT_GOALS);
  useViewStore.setState({ atlasLayout: 'map' });
});

const goal = (id: string, memberIds: string[]) =>
  ({ id, name: `Goal ${id}`, state: 'active', memberIds, milestoneIds: [], checkinIds: [] }) as never;
const strands = () => [...document.querySelectorAll<SVGPathElement>('[data-atlas-strand]')];
const card = (key: string) => document.querySelector<HTMLElement>(`[data-atlas-card="${key}"]`)!;

/** A goal fed by project p1's item `a`, and project p2 feeding nothing. */
function seedGoal() {
  seed(
    [task('a'), task('b', { project: 'Home' } as never), task('m', { project: undefined } as never)],
    [{ id: 'p1', name: 'Work', emoji: '' } as Project, { id: 'p2', name: 'Home', emoji: '' } as Project]
  );
  usePlannerStore.setState({ goals: [goal('g1', ['a'])] });
}

describe('strands on the card layer', () => {
  it('draws one dashed ink strand from the goal to the card feeding it, under the cards', () => {
    seedGoal();
    render(<AtlasView />);
    const s = strands();
    expect(s).toHaveLength(1);
    expect(s[0].dataset.atlasStrand).toBe('goal:g1\nproject:p1');
    expect(s[0].getAttribute('d')).toMatch(/^M[\d.-]+ [\d.-]+ C /);
    expect(s[0].getAttribute('stroke-dasharray')).toBe('3 5');
    // Ink by colour, a solid mix with the ground: never an opacity.
    expect(s[0].getAttribute('stroke')).toMatch(/color-mix\(in oklch, var\(--muted-foreground\) \d+%, var\(--background\)\)/);
    expect(s[0].getAttribute('opacity')).toBeNull();
    expect(s[0].getAttribute('style') ?? '').not.toMatch(/opacity/);
    // Under the cards: the layer comes before every card in the world.
    const layer = screen.getByTestId('atlas-strands');
    expect(layer.compareDocumentPosition(card('project:p1')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(layer).toHaveAttribute('aria-hidden');
  });

  it('turns lime at full strength while either end is hovered or focused', () => {
    seedGoal();
    render(<AtlasView />);
    fireEvent.pointerOver(card('project:p1'));
    let s = strands()[0];
    expect(s.dataset.hot).toBe('true');
    expect(s.getAttribute('stroke')).toBe('var(--primary)');
    expect(s.getAttribute('stroke-dasharray')).toBeNull();
    // The same element, moved not remounted, keeps its curve.
    expect(s.getAttribute('d')).toMatch(/^M/);

    fireEvent.pointerLeave(screen.getByTestId('atlas-world'));
    expect(strands()[0].dataset.hot).toBeUndefined();

    act(() => card('goal:g1').focus());
    s = strands()[0];
    expect(s.dataset.hot).toBe('true');
    act(() => card('goal:g1').blur());
    expect(strands()[0].dataset.hot).toBeUndefined();
  });

  it('follows a card while it is held, from its live transform, and stops after', () => {
    seedGoal();
    render(<AtlasView />);
    const s = strands()[0];
    // Let the mount's follow run out.
    for (let i = 0; i < 30; i++) frame(40);
    expect(raf.pending()).toBe(0);

    const el = card('project:p1');
    fireEvent.pointerDown(el, { button: 0, pointerId: 1 });
    expect(raf.pending()).toBe(1);
    const before = s.getAttribute('d');
    // The card moves by its own transform (a drag is the card's local state).
    el.style.transform = 'translate(2000px, 1500px)';
    frame(16);
    expect(s.getAttribute('d')).not.toBe(before);
    expect(s.getAttribute('d')).toMatch(/2000/);
    expect(raf.pending()).toBe(1);

    fireEvent.pointerUp(window, { pointerId: 1 });
    for (let i = 0; i < 30; i++) frame(40);
    expect(raf.pending()).toBe(0);
  });

  it('draws once and runs no loop under reduced motion', () => {
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    seedGoal();
    render(<AtlasView />);
    expect(strands()[0].getAttribute('d')).toMatch(/^M/);
    expect(strands()[0].getAttribute('style') ?? '').not.toMatch(/transition/);
    expect(raf.pending()).toBe(0);
  });

  it('draws none on By goal, whose lanes are the link, and none in the handoff band', () => {
    seedGoal();
    render(<AtlasView />);
    expect(strands()).toHaveLength(1);
    act(() => useViewStore.getState().setAtlasLayout('goal'));
    expect(strands()).toHaveLength(0);
    act(() => useViewStore.getState().setAtlasLayout('momentum'));
    expect(strands()).toHaveLength(1);
    act(() => useViewStore.getState().setAtlasLayout('timeline'));
    expect(strands()).toHaveLength(1);
    act(() => useViewStore.getState().setAtlasLayout('map'));
    act(() => useAtlasUiStore.getState().setCamera({ x: 0, y: 0, z: 0.55 }));
    expect(screen.queryByTestId('atlas-strands')).toBeNull();
  });

  it('draws none while Goals is off', () => {
    seedGoal();
    disableExtensions(EXT_GOALS);
    render(<AtlasView />);
    expect(screen.queryByTestId('atlas-strands')).toBeNull();
  });

  it(`over ${ATLAS_STRAND_REST_CAP} strands, draws only the hot card's`, () => {
    const n = ATLAS_STRAND_REST_CAP + 5;
    const projects = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, emoji: '' }) as Project);
    const items = projects.map((p, i) => task(`t${i}`, { project: p.name } as never));
    seed([...items, task('m', { project: undefined } as never)], projects);
    usePlannerStore.setState({ goals: [goal('g1', items.map((t) => t.id))] });
    render(<AtlasView />);
    expect(screen.getAllByTestId('atlas-strands')).toHaveLength(1);
    expect(strands()).toHaveLength(0);
    fireEvent.pointerOver(card('project:p3'));
    expect(strands().map((s) => s.dataset.atlasStrand)).toEqual(['goal:g1\nproject:p3']);
    // Hovering the goal lights all of its own, which is the point of hovering it.
    fireEvent.pointerOver(card('goal:g1'));
    expect(strands()).toHaveLength(n);
  });
});

describe('season frames', () => {
  function seedSeason() {
    seed([task('a'), task('r1i', { project: undefined } as never)]);
    usePlannerStore.setState({
      routines: [{ id: 'r1', name: 'Mornings', itemIds: ['r1i'] }] as never,
      seasons: [
        {
          id: 's1',
          name: 'Spring term',
          state: 'active',
          itemIds: [],
          routineIds: ['r1'],
          startsOn: '2026-07-01',
          endsOn: '2026-08-15',
        },
      ] as never,
    });
  }

  it('frames a season and its routines on Your map, with its dates on the tab', () => {
    seedSeason();
    render(<AtlasView />);
    const frame = document.querySelector<HTMLElement>('[data-atlas-frame="season:s1"]');
    expect(frame).not.toBeNull();
    expect(frame!.textContent).toMatch(/Spring term · Jul 1 to Aug 15/);
    expect(frame!.style.width).toMatch(/px$/);
    expect(frame!.style.transform).toMatch(/^translate\(/);
    expect(frame!.className).toMatch(/border-dashed/);
    expect(frame!.getAttribute('style') ?? '').not.toMatch(/opacity/);
    expect(frame!.textContent).not.toMatch(/[–—]/);
  });

  it('frames nothing on the computed layouts', () => {
    seedSeason();
    render(<AtlasView />);
    for (const layout of ['momentum', 'timeline'] as const) {
      act(() => useViewStore.getState().setAtlasLayout(layout));
      expect(document.querySelector('[data-atlas-frame]')).toBeNull();
    }
  });
});
