import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  render,
  renderHook,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
  within,
} from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

/**
 * The braindump's Display shelf, mounted through the real Braindump in both
 * variants.
 *
 * Through the mount rather than beside it, because what can go wrong with the
 * shelf is wiring, not arithmetic — the arithmetic has its own pure suite
 * (display-summary.test.ts). The shelf has to appear exactly when the trigger's
 * dot is lit; open the one menu that trigger opens, through the same doors, on
 * both shells; leave focus somewhere deliberate when it takes itself away; and
 * decide its own fit with React out of the loop. A test of the shelf on its own
 * could pass all of that while the braindump mounted it wrong, which is the
 * lesson memory/plans/display-menu.md records about testing this menu.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  createItemType: vi.fn(async () => {}),
  updateItemType: vi.fn(async () => {}),
  deleteItemType: vi.fn(async () => {}),
  createItem: vi.fn(async () => {}),
  updateItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  restoreItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  createProject: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  deleteProject: vi.fn(async () => {}),
  restoreProject: vi.fn(async () => {}),
  fetchRoutines: vi.fn(async () => []),
  createRoutine: vi.fn(async () => {}),
  updateRoutine: vi.fn(async () => {}),
  deleteRoutine: vi.fn(async () => {}),
  restoreRoutine: vi.fn(async () => {}),
  fetchPrograms: vi.fn(async () => []),
  createProgram: vi.fn(async () => {}),
  updateProgram: vi.fn(async () => {}),
  deleteProgram: vi.fn(async () => {}),
  restoreProgram: vi.fn(async () => {}),
  fetchGoals: vi.fn(async () => []),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  })),
}));
/**
 * Which Display shell opens is one boolean, and setup.ts's matchMedia always
 * answers desktop — so the sheet is reachable only through this mock. A ref
 * object because vi.mock's factory is hoisted above the module scope a bare
 * `let` would live in. Off by default; the touch cases flip it and afterEach
 * puts it back.
 */
const touch = vi.hoisted(() => ({ current: false }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => touch.current }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { Braindump } from '@/components/sidebar/braindump';
import { SurfaceHeader } from '@/components/primitives/surface-header';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { EMPTY_VIEW_FILTERS, type ViewFilters } from '@/lib/filters';
import { NO_CONTAINER } from '@/lib/container-registry';
import { EXT_GOALS } from '@/lib/extension-registry';
import { clauseText, useDisplaySummary } from '@/lib/display-summary';
import { SIDEBAR_MIN_WIDTH } from '@/lib/sidebar-store';
import type { Goal } from '@/lib/planner-types';
import { disableExtensions, enableGoalsAndOrganize } from './support/extensions';

/**
 * A ResizeObserver that records what each instance was handed, so a test can
 * deliver the shelf's observation by hand. dnd-kit builds observers of its own
 * around the braindump, so the shelf's is picked out by the element it watches.
 */
type Observation = { cb: ResizeObserverCallback; els: Element[] };
const observations: Observation[] = [];
class RecordingResizeObserver {
  private readonly rec: Observation;
  constructor(cb: ResizeObserverCallback) {
    this.rec = { cb, els: [] };
    observations.push(this.rec);
  }
  observe(el: Element) {
    this.rec.els.push(el);
  }
  unobserve(el: Element) {
    this.rec.els = this.rec.els.filter((e) => e !== el);
  }
  disconnect() {
    this.rec.els = [];
  }
}

const realResizeObserver = globalThis.ResizeObserver;
const realRect = Element.prototype.getBoundingClientRect;

/**
 * Radix's menus open on pointerdown and ask for pointer capture on the way.
 * tests/unit/setup.ts shims the capture API and scrollIntoView today; they are
 * restated here, only where missing, so this file carries its own requirements.
 */
beforeAll(() => {
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver;
});

// The recording observer is this file's own, so whatever it replaced goes back
// (nothing, in jsdom). The guarded shims above only ever fill a gap.
afterAll(() => {
  if (realResizeObserver) globalThis.ResizeObserver = realResizeObserver;
  else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

const GOALS = [
  { id: 'g1', name: 'Learn Chinese', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [] },
  { id: 'g2', name: 'Marathon', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [] },
] as Goal[];

type ViewSeed = Partial<ReturnType<typeof useViewStore.getState>>;
type PlannerSeed = Partial<ReturnType<typeof usePlannerStore.getState>>;

/**
 * Goals on, the planner's first load landed, nothing set on either surface —
 * then whatever the case names. The Goal clause and the Goal grouping ride the
 * Goals extension, which ships off; the cases about the gate switch it back off
 * themselves.
 */
function seed(view: ViewSeed = {}, planner: PlannerSeed = {}) {
  enableGoalsAndOrganize();
  usePlannerStore.setState({
    userId: 'user-1',
    isLoading: false,
    userTimezone: 'UTC',
    items: [],
    tasks: [],
    habits: [],
    projects: [
      { id: 'p1', name: 'Work', emoji: '💼' },
      { id: 'p2', name: 'Home', emoji: '🏠' },
    ],
    routines: [],
    programs: [],
    goals: GOALS,
    goalsAvailable: true,
    showPausedOnGrid: false,
    ...planner,
  });
  useViewStore.setState({
    scope: 'day',
    layout: 'list',
    typeFilter: 'all',
    canvasGroupBy: 'none',
    braindumpGroupBy: 'none',
    canvasSortBy: 'default',
    braindumpSortBy: 'default',
    canvasFilters: EMPTY_VIEW_FILTERS,
    braindumpFilters: EMPTY_VIEW_FILTERS,
    ...view,
  });
}

/** A filter set: empty, plus the fields named. A fresh object, never the shared constant. */
const filters = (f: Partial<ViewFilters>): ViewFilters => ({ ...EMPTY_VIEW_FILTERS, ...f });

const renderBraindump = (variant: 'sidebar' | 'mobile' = 'sidebar') =>
  render(
    <DndContext>
      <Braindump variant={variant} />
    </DndContext>
  );

const shelf = () => screen.getByTestId('display-shelf-braindump');
const queryShelf = () => screen.queryByTestId('display-shelf-braindump');
const opener = () => screen.getByTestId('display-shelf-open-braindump');
const resetX = () => screen.getByTestId('display-shelf-reset-braindump');
const trigger = () => screen.getByTestId('display-trigger-braindump');
/** By attribute rather than getByText: 'Priority' is a group-by label AND a sort label. */
const clause = (id: string) => shelf().querySelector<HTMLElement>(`[data-clause="${id}"]`);

/* ── a hand-drawn layout, for the fit cases ─────────────────────────────── */

/** The lines box's width, and each line's; the lines lie end to end from 0. */
let boxWidth = 0;
let lineWidthOf: (line: Element) => number = () => 100;

const rect = (left: number, width: number) =>
  ({ left, right: left + width, width, top: 0, bottom: 18, height: 18, x: left, y: 0 }) as DOMRect;

/** jsdom lays nothing out, so the shelf's two measurements are drawn here. */
function layOut() {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    if (this.hasAttribute('data-shelf-lines')) return rect(0, boxWidth);
    if (this.hasAttribute('data-line') && this.parentElement) {
      let left = 0;
      for (const line of Array.from(this.parentElement.children)) {
        if (!line.hasAttribute('data-line')) continue;
        if (line === this) return rect(left, lineWidthOf(line));
        left += lineWidthOf(line);
      }
    }
    return realRect.call(this);
  } as Element['getBoundingClientRect'];
}

beforeEach(() => seed());
afterEach(() => {
  cleanup();
  touch.current = false;
  observations.length = 0;
  Element.prototype.getBoundingClientRect = realRect;
  boxWidth = 0;
  lineWidthOf = () => 100;
  delete (document as { fonts?: unknown }).fonts;
});

describe('when it shows: exactly when the trigger dot is lit', () => {
  const states: { name: string; view?: ViewSeed; goalsOff?: boolean; lit: boolean }[] = [
    { name: 'nothing set', lit: false },
    { name: 'a grouping', view: { braindumpGroupBy: 'project' }, lit: true },
    { name: 'an ordering', view: { braindumpSortBy: 'title' }, lit: true },
    { name: 'a priority', view: { braindumpFilters: filters({ priorities: ['high'] }) }, lit: true },
    {
      name: 'the unset project',
      view: { braindumpFilters: filters({ containers: [NO_CONTAINER] }) },
      lit: true,
    },
    {
      // Counted, and with no menu row to clear it — the shelf is the one place
      // it is named, and the ✕ the one place it goes.
      name: 'a project the store no longer has',
      view: { braindumpFilters: filters({ containers: ['project:Gone'] }) },
      lit: true,
    },
    { name: 'a goal', view: { braindumpFilters: filters({ goals: ['g1'] }) }, lit: true },
    { name: 'Hide finished', view: { braindumpFilters: filters({ hideFinished: true }) }, lit: true },
    { name: 'the Goal grouping', view: { braindumpGroupBy: 'goal' }, lit: true },
    {
      // Nothing consults a goal selection while Goals is off, so the dot does
      // not count it — and a shelf naming it under a dark trigger would be the
      // stranded clause in reverse.
      name: 'a goal selection the Goals switch is keeping',
      view: { braindumpFilters: filters({ goals: ['g1'] }) },
      goalsOff: true,
      lit: false,
    },
    {
      name: 'a stored Goal grouping with Goals off',
      view: { braindumpGroupBy: 'goal' },
      goalsOff: true,
      lit: false,
    },
    {
      name: 'the canvas settings alone',
      view: {
        canvasGroupBy: 'project',
        canvasSortBy: 'title',
        typeFilter: 'habits',
        canvasFilters: filters({ priorities: ['high'], hideFinished: true }),
      },
      lit: false,
    },
  ];

  // The two real pairings: the sidebar opens the dropdown, the phone tab the sheet.
  describe.each([
    { variant: 'sidebar' as const, touchShell: false },
    { variant: 'mobile' as const, touchShell: true },
  ])('the $variant mount', ({ variant, touchShell }) => {
    it.each(states)('$name', ({ view, goalsOff, lit }) => {
      seed(view);
      if (goalsOff) disableExtensions(EXT_GOALS);
      touch.current = touchShell;
      renderBraindump(variant);

      expect(trigger()).toHaveAttribute('data-active', String(lit));
      expect(queryShelf() !== null).toBe(lit);
    });
  });
});

describe('what it says', () => {
  it('names every setting in the menu order, whatever order they were set in', () => {
    seed({
      braindumpGroupBy: 'project',
      braindumpSortBy: 'title',
      // Toggle order, which the shelf must not follow — and 'home' in the case
      // a habit stored it in, which the menu's folded tick still matches.
      braindumpFilters: filters({
        priorities: ['none', 'low', 'high'],
        containers: [NO_CONTAINER, 'project:home', 'project:Work'],
        goals: ['g2', 'g1'],
        hideFinished: true,
      }),
    });
    renderBraindump();

    expect([...shelf().querySelectorAll('[data-line]')].map((l) => l.getAttribute('data-line'))).toEqual([
      'arrange',
      'priority',
      'project',
      'goal',
      'hide-finished',
    ]);
    expect(clause('group')).toHaveTextContent(/^Grouped by Project$/);
    // An en dash, as SORT_BY_OPTIONS spells it.
    expect(clause('sort')).toHaveTextContent(/^Sorted by Title A–Z$/);
    expect(clause('priority')).toHaveTextContent(/^High, Low, No priority$/);
    // The store's spelling, not the stored one.
    expect(clause('project')).toHaveTextContent(/^Work, Home, No project$/);
    expect(clause('goal')).toHaveTextContent(/^Learn Chinese, Marathon$/);
    expect(clause('hide-finished')).toHaveTextContent(/^Hide finished$/);

    // Grouping and ordering share the first line, as the list's arrangement.
    const arrange = shelf().querySelector<HTMLElement>('[data-line="arrange"]');
    expect(arrange).toContainElement(clause('group'));
    expect(arrange).toContainElement(clause('sort'));

    // clauseText is the oracle — the text the fit is keyed on is the text on
    // screen, clause for clause.
    const { result } = renderHook(() => useDisplaySummary('braindump'));
    expect(result.current.clauses).toHaveLength(6);
    for (const c of result.current.clauses) expect(clause(c.id)?.textContent).toBe(clauseText(c));
  });

  it('marks each value the way its menu row does, and goals with Target', () => {
    seed({
      braindumpFilters: filters({
        priorities: ['low', 'none'],
        containers: ['project:Work', NO_CONTAINER],
        goals: ['g1'],
      }),
    });
    renderBraindump();

    const marks = (id: string) => [...clause(id)!.querySelectorAll('[aria-hidden="true"]')];

    const [low, noPriority] = marks('priority');
    expect(low.getAttribute('style')).toContain('var(--priority-low)');
    // The hollow ring the menu gives both unset values.
    expect(noPriority).toHaveClass('rounded-full', 'border');

    const [work, noProject] = marks('project');
    expect(work.getAttribute('style')).toContain(usePlannerStore.getState().getProjectColor('Work'));
    expect(noProject).toHaveClass('rounded-full', 'border');

    const [goal] = marks('goal');
    expect(goal).toHaveClass('lucide-target');
  });
});

describe('the ✕ is Reset display', () => {
  /** Everything a reset could touch, on both surfaces and app-wide. */
  const snapshot = () => {
    const v = useViewStore.getState();
    return {
      braindumpFilters: v.braindumpFilters,
      braindumpGroupBy: v.braindumpGroupBy,
      braindumpSortBy: v.braindumpSortBy,
      canvasFilters: v.canvasFilters,
      canvasGroupBy: v.canvasGroupBy,
      canvasSortBy: v.canvasSortBy,
      typeFilter: v.typeFilter,
      showPausedOnGrid: usePlannerStore.getState().showPausedOnGrid,
    };
  };

  const cases: { name: string; goalsOff: boolean; view: ViewSeed }[] = [
    {
      name: 'with Goals on',
      goalsOff: false,
      view: {
        braindumpGroupBy: 'goal',
        braindumpSortBy: 'priority',
        braindumpFilters: filters({
          priorities: ['high'],
          containers: ['project:Work'],
          goals: ['g1'],
          hideFinished: true,
        }),
        // The other surface, which this one's reset must not reach.
        canvasGroupBy: 'project',
        canvasSortBy: 'title',
        typeFilter: 'habits',
        canvasFilters: filters({ priorities: ['low'] }),
      },
    },
    {
      name: 'with Goals off, over the goal clause and Goal grouping the switch keeps',
      goalsOff: true,
      view: {
        braindumpGroupBy: 'goal',
        braindumpSortBy: 'title',
        braindumpFilters: filters({ goals: ['g1'], hideFinished: true }),
      },
    },
  ];

  it.each(cases)('leaves the stores exactly as the menu row does, $name', async ({ goalsOff, view }) => {
    const arrange = () => {
      // Show paused is on, and app-wide: neither reset may touch it.
      seed(view, { showPausedOnGrid: true });
      if (goalsOff) disableExtensions(EXT_GOALS);
      renderBraindump();
    };

    arrange();
    fireEvent.pointerDown(trigger(), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByTestId('display-reset'));
    const byMenu = snapshot();
    cleanup();

    arrange();
    fireEvent.click(resetX());
    expect(snapshot()).toEqual(byMenu);
    expect(snapshot().showPausedOnGrid).toBe(true);
  });

  it('keeps what the Goals switch is keeping, and the shelf still goes', () => {
    seed({ braindumpGroupBy: 'goal', braindumpFilters: filters({ goals: ['g1'], hideFinished: true }) });
    disableExtensions(EXT_GOALS);
    renderBraindump();

    fireEvent.click(resetX());

    // Off is lossless: switching Goals back on returns the clause that was left.
    expect(useViewStore.getState().braindumpFilters).toEqual(filters({ goals: ['g1'] }));
    expect(useViewStore.getState().braindumpGroupBy).toBe('goal');
    // Neither is counted while the switch is off, so the dot goes out with the shelf.
    expect(trigger()).toHaveAttribute('data-active', 'false');
    expect(queryShelf()).toBeNull();
  });

  it('hands focus to the trigger before the reset takes the shelf away', () => {
    seed({ braindumpGroupBy: 'project' });
    renderBraindump();
    resetX().focus();

    fireEvent.click(resetX());

    expect(queryShelf()).toBeNull();
    // Not <body>, where a focused button that unmounts leaves it.
    expect(document.activeElement).toBe(trigger());
  });
});

describe('opening the menu from the shelf', () => {
  it('opens the pointer dropdown from its text, and Escape brings focus back to the text', async () => {
    seed({ braindumpGroupBy: 'project' });
    renderBraindump();

    fireEvent.click(opener());

    const menu = await screen.findByTestId('display-menu');
    expect(menu).toHaveAttribute('data-display-variant', 'menu');
    // The trigger's own menu, not a second one beside it.
    expect(screen.getAllByTestId('display-trigger-braindump')).toHaveLength(1);

    fireEvent.keyDown(menu, { key: 'Escape' });
    // Radix returns focus a tick after the content unmounts.
    await waitFor(() => expect(document.activeElement).toBe(opener()));
  });

  it('sends focus to the trigger when the pick made from it takes the shelf away', async () => {
    seed({ braindumpGroupBy: 'project' });
    renderBraindump();

    fireEvent.click(opener());
    fireEvent.click(await screen.findByRole('menuitem', { name: /Grouping/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^None/ }));

    expect(useViewStore.getState().braindumpGroupBy).toBe('none');
    expect(queryShelf()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it('leaves focus where a right-click outside put it, as Radix does for its trigger', async () => {
    seed({ braindumpGroupBy: 'project' });
    renderBraindump();

    fireEvent.click(opener());
    await screen.findByTestId('display-menu');
    // Radix arms its outside-pointer listener a tick after the content mounts.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.pointerDown(document.body, { button: 2 });
    await waitFor(() => expect(screen.queryByTestId('display-menu')).toBeNull());
    // Past the tick in which focus would have been handed back.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(document.activeElement).not.toBe(opener());
    expect(document.activeElement).not.toBe(trigger());
  });

  it('opens the phone sheet through its own trigger, on the root, after a drilled close', async () => {
    touch.current = true;
    seed({ braindumpGroupBy: 'project' });
    renderBraindump('mobile');
    const pane = () => screen.getByTestId('display-sheet-pane');
    const sheet = () => screen.getByTestId('display-menu');

    fireEvent.click(trigger());
    fireEvent.click(await screen.findByTestId('display-section-priority'));
    expect(pane()).toHaveAttribute('data-pane', 'priority');

    fireEvent.keyDown(sheet(), { key: 'Escape' });
    await waitFor(() => expect(sheet()).toHaveAttribute('data-state', 'closed'));
    // vaul keeps the closed sheet mounted in jsdom, still on the drilled pane:
    // the reset belongs to the NEXT opening.
    expect(pane()).toHaveAttribute('data-pane', 'priority');

    // By test id: in jsdom vaul leaves the page aria-hidden after a close.
    fireEvent.click(opener());

    expect(sheet()).toHaveAttribute('data-state', 'open');
    expect(pane()).toHaveAttribute('data-pane', 'root');
  });
});

describe('fit: one line, or the stack', () => {
  const fit = () => shelf().getAttribute('data-fit');

  /** Deliver the shelf's own ResizeObserver callback: the one watching its probe. */
  function resize() {
    const probe = shelf().querySelector('[data-shelf-probe]');
    const mine = observations.filter((o) => probe !== null && o.els.includes(probe));
    expect(mine).toHaveLength(1);
    act(() => mine[0].cb([], {} as ResizeObserver));
  }

  it('is one line in jsdom, where every width is 0', () => {
    seed({ braindumpGroupBy: 'project', braindumpFilters: filters({ hideFinished: true }) });
    renderBraindump();
    expect(fit()).toBe('line');
  });

  it('stacks when the line will not fit, comes back when it will, and re-fits on a change of text', () => {
    seed({ braindumpGroupBy: 'project', braindumpFilters: filters({ hideFinished: true }) });
    renderBraindump();

    // Two lines of 100 in a box of 150. The shelf measured 0 at mount, so this
    // first resize is where it measures.
    layOut();
    boxWidth = 150;
    resize();
    expect(fit()).toBe('stack');

    boxWidth = 250;
    resize();
    expect(fit()).toBe('line');

    // A third line, and no resize: the text changed, so the shelf re-fits itself.
    act(() =>
      useViewStore.setState({ braindumpFilters: filters({ hideFinished: true, priorities: ['high'] }) })
    );
    expect(fit()).toBe('stack');
  });

  it('only compares on a resize — the width it measured is not re-read there', () => {
    // Forcing the one-line layout to measure inside observer delivery is how a
    // resize loop starts; a resize reuses the width the text last measured.
    layOut();
    boxWidth = 250;
    seed({ braindumpGroupBy: 'project', braindumpFilters: filters({ hideFinished: true }) });
    renderBraindump();
    expect(fit()).toBe('line');

    lineWidthOf = () => 150;
    resize();
    expect(fit()).toBe('line');
  });

  it('re-fits when a value joins a clause that is already showing', () => {
    // Lines as wide as their text, so a value that adds no line still adds width.
    lineWidthOf = (line) => (line.textContent ?? '').length * 10;
    layOut();
    boxWidth = 60;
    seed({ braindumpFilters: filters({ priorities: ['high'] }) });
    renderBraindump();
    expect(fit()).toBe('line');

    act(() => useViewStore.setState({ braindumpFilters: filters({ priorities: ['high', 'low'] }) }));
    expect(fit()).toBe('stack');
  });

  it('measures again when web fonts land, which resizes nothing', async () => {
    let fontsLand = () => {};
    const ready = new Promise<void>((resolve) => {
      fontsLand = resolve;
    });
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } });
    seed({ braindumpGroupBy: 'project', braindumpFilters: filters({ hideFinished: true }) });
    renderBraindump();
    expect(fit()).toBe('line');

    // The swapped-in face sets the same text wider.
    layOut();
    boxWidth = 150;
    await act(async () => {
      fontsLand();
      await ready;
    });

    expect(fit()).toBe('stack');
  });

  it('lets a stacked multi-select shrink, so its values wrap instead of clipping', () => {
    // jsdom cannot lay this out, so the class is the assertion: a clause that
    // stays shrink-0 in the stack holds its one-line width and clips.
    seed({
      braindumpFilters: filters({ priorities: ['high'], containers: ['project:Work'], goals: ['g1'] }),
    });
    renderBraindump();
    for (const id of ['priority', 'project', 'goal']) {
      expect(clause(id)).toHaveClass('shrink-0', 'group-data-[fit=stack]/shelf:shrink');
    }
  });

  it('renders, and keeps the fit it measured, with no ResizeObserver at all', () => {
    const recording = globalThis.ResizeObserver;
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    try {
      seed({ braindumpGroupBy: 'project' });
      renderBraindump();
      expect(shelf()).toHaveAttribute('data-fit', 'line');
    } finally {
      globalThis.ResizeObserver = recording;
    }
  });
});

describe('the two mounts', () => {
  it('gives the phone 28px targets and leaves the sidebar at its own density', () => {
    seed({ braindumpGroupBy: 'project' });

    renderBraindump('mobile');
    expect(opener()).toHaveClass(
      'before:absolute',
      'before:inset-x-0',
      'before:-inset-y-[5px]',
      "before:content-['']"
    );
    expect(resetX()).toHaveClass(
      'relative',
      'before:absolute',
      'before:-inset-x-[6px]',
      'before:-inset-y-[5px]',
      "before:content-['']"
    );
    // The phone tab has no collapsing column to hold a fit through.
    expect(shelf().style.minWidth).toBe('');
    cleanup();

    renderBraindump('sidebar');
    expect(opener()).not.toHaveClass('before:absolute');
    expect(resetX()).not.toHaveClass('before:absolute');
    // The narrowest column, less the capsule's 10px sides.
    expect(shelf().style.minWidth).toBe(`${SIDEBAR_MIN_WIDTH - 20}px`);
  });

  it('is named by its own text, and described with the nouns the glyphs stand for', () => {
    seed({
      braindumpGroupBy: 'project',
      braindumpFilters: filters({
        priorities: ['low', 'high'],
        containers: ['project:Work', NO_CONTAINER],
        goals: ['g1'],
      }),
    });
    renderBraindump();

    // Label in Name: what is on screen is what the button is called.
    expect(opener()).toHaveAccessibleName(/^Grouped by Project/);
    // With a pause between settings and between values. The computation here trims each
    // element's text, so the space inside a separator does not survive it; the separators'
    // own text is pinned below instead.
    expect(opener()).toHaveAccessibleName(/^Grouped by Project; ?High, ?Low; ?Work, ?No project; ?Learn Chinese$/);
    expect(Array.from(opener().querySelectorAll('.sr-only'), (el) => el.textContent)).toEqual([
      '; ',
      ', ',
      '; ',
      ', ',
      '; ',
    ]);
    expect(opener()).not.toHaveAttribute('aria-label');
    expect(opener()).toHaveAccessibleDescription(/^Display settings/);
    expect(opener()).toHaveAccessibleDescription(
      'Display settings. Priority: High, Low. Project: Work, No project. Goal: Learn Chinese.'
    );
    expect(resetX()).toHaveAccessibleName('Reset display');
    // The popup the pointer shell opens.
    expect(opener()).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('announces the sheet as what it opens on touch', () => {
    touch.current = true;
    seed({ braindumpGroupBy: 'project' });
    renderBraindump('mobile');
    expect(opener()).toHaveAttribute('aria-haspopup', 'dialog');
  });
});

describe("before the planner's first load", () => {
  it('holds back "Unknown goal" until the goals list has had its chance to answer', () => {
    seed({ braindumpFilters: filters({ goals: ['g1'] }) }, { isLoading: true, goals: [] });
    renderBraindump();

    // Counted all the same, so the shelf is up: the dot is lit.
    expect(trigger()).toHaveAttribute('data-active', 'true');
    expect(within(shelf()).queryByText('Unknown goal')).toBeNull();
    expect(clause('goal')).toHaveTextContent(/^…$/);

    // Loaded, and still nothing answers to the id: now it is unknown.
    act(() => usePlannerStore.setState({ isLoading: false }));
    expect(clause('goal')).toHaveTextContent(/^Unknown goal$/);
  });
});

describe('lime', () => {
  it('has no opacity anywhere between a lime glyph and the surface', () => {
    // The Low dot is --priority-low and this project's square is --accent-8,
    // both lime. Drawn at rest as data glyphs — which is only allowed while
    // nothing above them can fade them.
    seed(
      { braindumpFilters: filters({ priorities: ['low'], containers: ['project:Wind-down'] }) },
      { projects: [{ id: 'p9', name: 'Wind-down', emoji: '🌙', color: 'var(--accent-8)' }] }
    );
    renderBraindump();
    const section = screen.getByTestId('braindump');

    const lime = [...shelf().querySelectorAll<HTMLElement>('[style]')].filter((el) =>
      /var\(--priority-low\)|var\(--accent-8\)/.test(el.getAttribute('style') ?? '')
    );
    expect(lime).toHaveLength(2);

    for (const glyph of lime) {
      let node: HTMLElement | null = glyph;
      let walked = 0;
      while (node) {
        expect(node.getAttribute('class') ?? '').not.toMatch(/(^|[\s:])(opacity-|transition-opacity)/);
        expect(node.style.opacity).toBe('');
        if (node === section) break;
        node = node.parentElement;
        walked += 1;
      }
      expect(node).toBe(section);
      expect(walked).toBeGreaterThan(4);
    }

    // Nor does anything in the shelf fade or animate at all.
    for (const el of shelf().querySelectorAll('*')) {
      expect(el.getAttribute('class') ?? '').not.toMatch(/opacity|transition/);
    }
  });
});

describe('the capsule it lives in', () => {
  /** The outer surface-3 capsule, reached from the title it frames (mobile-content.test's route). */
  const capsule = (title: RegExp) =>
    screen.getByRole('heading', { name: title }).closest('div')?.parentElement;

  it('adds nothing at rest, and sits after the pill when it shows', () => {
    renderBraindump();
    expect(capsule(/Braindump/)?.children).toHaveLength(1);
    cleanup();

    seed({ braindumpGroupBy: 'project' });
    renderBraindump();
    const children = capsule(/Braindump/)?.children;
    expect(children).toHaveLength(2);
    expect(children?.[0]).toContainElement(screen.getByRole('heading', { name: /Braindump/ }));
    expect(children?.[1]).toBe(shelf());
  });

  it('leaves a header that hangs nothing below its pill as it was (Beacon)', () => {
    render(
      <SurfaceHeader title="Beacon">
        <button aria-label="User menu">K</button>
      </SurfaceHeader>
    );
    expect(capsule(/Beacon/)?.children).toHaveLength(1);
  });
});
