import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, within } from '@testing-library/react';

/**
 * Walk Atlas, the view half (components/views/atlas/atlas-walk.tsx): started
 * from the command or the toolbar, it stands on one card at a time in the
 * layout's order with a veil cut out around it (an element: no card is ever
 * dimmed), asks one question with the existing verbs as buttons, steps with
 * Next, Back, arrows and Enter, keeps Tab in its panel, says each stop to a
 * screen reader, and Escape ends it with the camera back where it was.
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
import { AtlasToolbar } from '@/components/views/atlas/atlas-toolbar';
import { usePlannerStore } from '@/lib/planner-store';
import { useSelectionStore } from '@/lib/selection-store';
import { useUIStore } from '@/lib/ui-store';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { useAtlasStore } from '@/lib/atlas-store';
import { useViewStore } from '@/lib/view-store';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { STATIC_COMMANDS, isAvailable, type CommandContext } from '@/lib/commands';
import { toast } from 'sonner';
import type { Item, Project } from '@/lib/planner-types';
import { EXT_GOALS } from '@/lib/extension-registry';
import { disableExtensions, enableExtensions } from './support/extensions';

const TODAY = '2026-07-16';
const asDate = (ymd: string) => new Date(`${ymd}T12:00:00Z`);

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

const task = (id: string, over: Partial<Item> = {}) =>
  ({
    type: 'task',
    id,
    title: `Task ${id}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    skippedDates: [],
    project: 'Work',
    ...over,
  }) as unknown as Item;

const PROJECTS = [
  { id: 'p1', name: 'Work', emoji: '' },
  { id: 'p2', name: 'Home', emoji: '' },
] as Project[];

function seed(items: Item[], projects: Project[] = PROJECTS) {
  usePlannerStore.setState({
    items,
    tasks: items.filter((i) => i.type !== 'habit') as never,
    habits: items.filter((i) => i.type === 'habit') as never,
    projects,
    routines: [],
    seasons: [],
    goals: [],
    userTimezone: 'UTC',
    selectedDate: asDate(TODAY),
    collectionsAvailable: true,
    goalsAvailable: true,
  });
}

const CTX: CommandContext = {
  theme: { resolved: 'light', value: 'light', set: () => {} },
  openChat: () => {},
  userId: 'u1',
  isMobile: false,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(asDate(TODAY));
  // Flights jump: the camera is checked as soon as the walk moves.
  document.documentElement.setAttribute('data-reduce-motion', 'true');
  useAtlasUiStore.getState().reset();
  useAtlasStore.getState().reset();
  localStorage.clear();
  usePlannerStore.setState({ userId: null });
  useSelectionStore.getState().clear();
  useUIStore.setState({ activeDialog: null, confirmRequest: null });
  useViewStore.setState({ scope: 'atlas', atlasLayout: 'map', atlasHideFinished: false, atlasHideResting: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.removeAttribute('data-reduce-motion');
});

const panel = () => screen.queryByTestId('atlas-walk');
const stopKey = () => panel()?.getAttribute('data-walk-card');
const start = () => act(() => useAtlasUiStore.getState().startWalk());

describe('Walk Atlas: the command', () => {
  it('is registered with no key, on Atlas only, off on the phone and under the sheet', () => {
    const cmd = STATIC_COMMANDS.find((c) => c.id === 'atlas.walk')!;
    expect(cmd).toBeTruthy();
    expect(cmd.label).toBe(ATLAS_COPY.walk);
    expect(cmd.shortcut).toBeUndefined();
    expect(isAvailable(cmd, CTX)).toBe(true);
    expect(isAvailable(cmd, { ...CTX, isMobile: true })).toBe(false);
    expect(typeof cmd.hidden === 'function' && cmd.hidden({ ...CTX, isMobile: true })).toBe(true);
    useViewStore.setState({ scope: 'day' });
    expect(isAvailable(cmd, CTX)).toBe(false);
    useViewStore.setState({ scope: 'atlas' });
    useAtlasUiStore.getState().openSheet('project', 'p1', { x: 0, y: 0, width: 1, height: 1 });
    expect(isAvailable(cmd, CTX)).toBe(false);
    useAtlasUiStore.getState().closeSheet();

    void cmd.run(CTX);
    expect(useAtlasUiStore.getState().walk).not.toBeNull();
    // Run again during a walk: it ends, asking for the camera back.
    void cmd.run(CTX);
    expect(useAtlasUiStore.getState().walk).toBeNull();
  });

  it('starts and stops from the toolbar button, which says whether a walk is on', () => {
    render(<AtlasToolbar />);
    const b = screen.getByTestId('atlas-walk-button');
    expect(b.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(b);
    expect(useAtlasUiStore.getState().walk).not.toBeNull();
    expect(b.getAttribute('aria-pressed')).toBe('true');
    expect(b.getAttribute('aria-label')).toBe(ATLAS_COPY.walkStopLabel);
    fireEvent.click(b);
    expect(useAtlasUiStore.getState().walk).toBeNull();
  });
});

describe('Walk Atlas: the walk', () => {
  it('stands on each drawn card in order, asks one question, and announces each stop', () => {
    seed([task('a'), task('b', { project: 'Home' })]);
    render(<AtlasView />);
    start();
    expect(panel()).toBeTruthy();
    const first = stopKey()!;
    expect(['project:p1', 'project:p2']).toContain(first);
    expect(screen.getByTestId('atlas-walk-step').textContent).toBe('1 of 2');
    expect(screen.getByTestId('atlas-walk-question').textContent).toBe(ATLAS_COPY.walkNextQuestion);
    expect(screen.getByTestId('atlas-walk-announce').textContent).toMatch(/^Card 1 of 2: (Work|Home), Project\. /);
    // Focus moves into the panel, onto Next.
    expect(document.activeElement).toBe(screen.getByTestId('atlas-walk-next'));
    expect((screen.getByTestId('atlas-walk-back') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('atlas-walk-next'));
    const second = stopKey()!;
    expect(second).not.toBe(first);
    expect(screen.getByTestId('atlas-walk-step').textContent).toBe('2 of 2');
    expect(screen.getByTestId('atlas-walk-announce').textContent).toMatch(/^Card 2 of 2: /);

    // Past the last card: a closing stop, then Back returns to the last card.
    fireEvent.click(screen.getByTestId('atlas-walk-next'));
    expect(panel()!.getAttribute('data-walk-stop')).toBe('finished');
    expect(screen.getByTestId('atlas-walk-question').textContent).toBe(ATLAS_COPY.walkFinishedQuestion);
    fireEvent.click(screen.getByTestId('atlas-walk-back'));
    expect(stopKey()).toBe(second);
  });

  it('steps with the arrows and with Enter on the panel', () => {
    seed([task('a'), task('b', { project: 'Home' })]);
    render(<AtlasView />);
    start();
    const first = stopKey();
    fireEvent.keyDown(panel()!, { key: 'ArrowRight' });
    expect(stopKey()).not.toBe(first);
    fireEvent.keyDown(panel()!, { key: 'ArrowLeft' });
    expect(stopKey()).toBe(first);
    fireEvent.keyDown(panel()!, { key: 'Enter' });
    expect(stopKey()).not.toBe(first);
  });

  it('keeps standing on its card when the layout changes mid-walk', () => {
    seed([task('a'), task('b', { project: 'Home' })]);
    render(<AtlasView />);
    start();
    fireEvent.click(screen.getByTestId('atlas-walk-next'));
    const on = stopKey();
    act(() => useViewStore.getState().setAtlasLayout('momentum'));
    expect(screen.getByTestId('atlas-view').getAttribute('data-atlas-layout')).toBe('momentum');
    expect(stopKey()).toBe(on);
    expect(useAtlasUiStore.getState().walk?.key).toBe(on);
  });

  it('keeps Tab inside the panel', () => {
    seed([task('a'), task('b', { project: 'Home' })]);
    render(<AtlasView />);
    start();
    fireEvent.click(screen.getByTestId('atlas-walk-next'));
    const buttons = within(panel()!).getAllByRole('button').filter((b) => !(b as HTMLButtonElement).disabled);
    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0], { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('cuts the veil out as an element, and dims no card by opacity', () => {
    seed([task('a'), task('b', { project: 'Home' })]);
    render(<AtlasView />);
    start();
    const veil = screen.getByTestId('atlas-walk-veil');
    expect(veil.tagName.toLowerCase()).toBe('path');
    expect(veil.getAttribute('fill-rule')).toBe('evenodd');
    expect(veil.getAttribute('d')).toMatch(/^M-20000/);
    const isOpacity = (el: Element) =>
      /opacity/.test((el as HTMLElement).style?.cssText ?? '') ||
      (el.getAttribute('class') ?? '').split(/\s+/).some((c) => /^opacity-/.test(c));
    for (const el of document.querySelectorAll('[data-atlas-card], [data-atlas-card] *')) {
      expect(isOpacity(el), el.outerHTML.slice(0, 80)).toBe(false);
    }
    for (const el of [panel()!, ...panel()!.querySelectorAll('*'), veil]) {
      expect(isOpacity(el)).toBe(false);
    }
  });

  it('Escape ends it and takes the camera back where it was, claiming the key', () => {
    seed([task('a'), task('b', { project: 'Home' })]);
    render(<AtlasView />);
    act(() => useAtlasUiStore.getState().setCamera({ x: 5, y: 6, z: 0.9 }));
    start();
    // The walk (or a pan during it) moved the camera.
    act(() => useAtlasUiStore.getState().setCamera({ x: 400, y: -300, z: 1.1 }));
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      document.activeElement!.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(useAtlasUiStore.getState().walk).toBeNull();
    expect(useAtlasUiStore.getState().camera).toEqual({ x: 5, y: 6, z: 0.9 });
    expect(panel()).toBeNull();
    expect(screen.queryByTestId('atlas-walk-scrim')).toBeNull();
  });

  it('Done ends it with the camera back too; Escape leaves an open text field alone', () => {
    seed([task('a'), task('b', { project: 'Home' })]);
    render(<AtlasView />);
    act(() => useAtlasUiStore.getState().setCamera({ x: 1, y: 2, z: 1 }));
    start();
    act(() => useAtlasUiStore.getState().setCamera({ x: 50, y: 50, z: 1 }));
    fireEvent.click(screen.getByTestId('atlas-walk-done'));
    expect(useAtlasUiStore.getState().walk).toBeNull();
    expect(useAtlasUiStore.getState().camera).toEqual({ x: 1, y: 2, z: 1 });

    start();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useAtlasUiStore.getState().walk).not.toBeNull();
    input.remove();
  });

  it("puts a card's next step on Today through the reschedule verb", () => {
    seed([task('a')], [PROJECTS[0]]);
    render(<AtlasView />);
    start();
    fireEvent.click(screen.getByTestId('atlas-walk-today'));
    const a = usePlannerStore.getState().items.find((i) => i.id === 'a') as { startDate?: string };
    expect(a.startDate?.slice(0, 10)).toBe(TODAY);
    expect(toast).toHaveBeenCalledWith(ATLAS_COPY.putOnTodayDone('Task a'));
    // On Today now, so it is no longer offered, and focus stays in the panel.
    expect(screen.queryByTestId('atlas-walk-today')).toBeNull();
    expect(panel()!.contains(document.activeElement)).toBe(true);
  });

  it('never offers Put on Today for a milestone or a recurring step', () => {
    seed([task('r', { repeatFrequency: 'daily', startDate: '2026-07-01' } as Partial<Item>)], [PROJECTS[0]]);
    render(<AtlasView />);
    start();
    expect(panel()).toBeTruthy();
    expect(screen.queryByTestId('atlas-walk-today')).toBeNull();
    act(() => useAtlasUiStore.getState().endWalk(false));
    cleanup();
    useAtlasUiStore.getState().reset();

    seed([task('m', { project: undefined })], []);
    usePlannerStore.setState({
      goals: [{ id: 'g1', name: 'Ship', state: 'active', memberIds: [], milestoneIds: ['m'], checkinIds: [] } as never],
    });
    enableExtensions(EXT_GOALS);
    render(<AtlasView />);
    start();
    expect(stopKey()).toBe('goal:g1');
    expect(screen.queryByTestId('atlas-walk-today')).toBeNull();
    disableExtensions(EXT_GOALS);
  });

  it("asks what's next of a card with nothing open, and Organize steps the walk aside", () => {
    seed([task('done', { status: 'completed' })], [PROJECTS[0]]);
    render(<AtlasView />);
    start();
    expect(panel()!.getAttribute('data-walk-stop')).toBe('empty');
    expect(screen.getByTestId('atlas-walk-question').textContent).toBe("What's the next step?");
    // Organize steps the walk aside and opens the container there.
    fireEvent.click(screen.getByTestId('atlas-walk-organize'));
    expect(useAtlasUiStore.getState().walk).toBeNull();
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'organize', section: 'projects', focusId: 'p1' });
  });

  it('with motion allowed, settles away on Escape and is gone a moment later', async () => {
    document.documentElement.removeAttribute('data-reduce-motion');
    seed([task('a'), task('b', { project: 'Home' })]);
    render(<AtlasView />);
    start();
    fireEvent.click(screen.getByTestId('atlas-walk-next'));
    act(() => {
      fireEvent.keyDown(panel()!, { key: 'Escape' });
    });
    expect(useAtlasUiStore.getState().walk).toBeNull();
    expect(panel()!.getAttribute('data-phase')).toBe('leaving');
    expect(panel()!.style.transform).toMatch(/translateY/);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(panel()).toBeNull();
  });

  it('says so and stops when nothing is drawn', () => {
    seed([], []);
    render(<AtlasView />);
    start();
    expect(useAtlasUiStore.getState().walk).toBeNull();
    expect(toast).toHaveBeenCalledWith(ATLAS_COPY.walkNothing);
  });

  it('ends when Atlas unmounts, so it never springs back on the next visit', () => {
    seed([task('a')], [PROJECTS[0]]);
    const { unmount } = render(<AtlasView />);
    start();
    unmount();
    expect(useAtlasUiStore.getState().walk).toBeNull();
    expect(useAtlasUiStore.getState().walkHome).toBeNull();
  });

  it('waits unseen under the focus sheet and comes back as it closes', () => {
    seed([task('a')], [PROJECTS[0]]);
    render(<AtlasView />);
    start();
    act(() => useAtlasUiStore.getState().openSheet('project', 'p1', { x: 0, y: 0, width: 10, height: 10 }));
    expect(panel()!.style.visibility).toBe('hidden');
    // Escape is the sheet's first.
    fireEvent.keyDown(screen.getByTestId('atlas-focus-sheet'), { key: 'Escape' });
    expect(useAtlasUiStore.getState().sheet).toBeNull();
    expect(useAtlasUiStore.getState().walk).not.toBeNull();
    expect(panel()!.style.visibility).toBe('');
  });
});
