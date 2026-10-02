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
 * both shells, from its words as from its opener; leave focus somewhere
 * deliberate when it takes itself away; and lay itself out as one paragraph
 * from the stylesheet alone, measuring nothing. A test of the shelf on its own
 * could pass all of that while the braindump mounted it wrong, which is the
 * lesson memory/plans/display-menu.md records about testing this menu.
 *
 * jsdom lays nothing out, so how the paragraph wraps, where a ✕ hangs and when
 * it is drawn are pinned as the classes that do it — the load-bearing ones, not
 * every class the shelf wears.
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
  fetchSeasons: vi.fn(async () => []),
  createSeason: vi.fn(async () => {}),
  updateSeason: vi.fn(async () => {}),
  deleteSeason: vi.fn(async () => {}),
  restoreSeason: vi.fn(async () => {}),
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
import { CLICK_AWAY_SCOPE_ATTR, isClickAwayTarget } from '@/lib/click-away';
import type { Goal } from '@/lib/planner-types';
import { disableExtensions, enableGoalsAndOrganize } from './support/extensions';
import { finishExit, recordResizeObservers, settle, watchLayoutReads } from './support/shelf';

/**
 * A ResizeObserver that records what each instance was handed, in for the
 * whole file. The shelf measures nothing, so it builds none — but dnd-kit
 * builds observers of its own around the braindump, so the case that says so
 * counts them before the shelf mounts and after, and looks at what every one of
 * them watches.
 */
let observers: ReturnType<typeof recordResizeObservers>;

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
  observers = recordResizeObservers();
});

// The recording observer is this file's own, so whatever it replaced goes back
// (nothing, in jsdom). The guarded shims above only ever fill a gap.
afterAll(() => observers.restore());

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
    seasons: [],
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

/**
 * The fewest things to take off that Reset shows for: two phrases and a
 * filter's two values, the filter last.
 */
const fourToTakeOff = (): ViewSeed => ({
  braindumpGroupBy: 'project',
  braindumpSortBy: 'title',
  braindumpFilters: filters({ priorities: ['high', 'low'] }),
});

/** Every setting the braindump has: eight ✕s between them, Hide finished last. */
const everything = () =>
  seed({
    braindumpGroupBy: 'project',
    braindumpSortBy: 'title',
    braindumpFilters: filters({
      priorities: ['high', 'low'],
      // Two spellings of Work: one value, one ✕, and both go with it.
      containers: ['project:Work', 'project:work', NO_CONTAINER],
      goals: ['g1'],
      hideFinished: true,
    }),
  });

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
const queryReset = () => screen.queryByTestId('display-shelf-reset-braindump');
const trigger = () => screen.getByTestId('display-trigger-braindump');
/** The paragraph: one wrapping box, with every setting an item of it. */
const lines = () => shelf().querySelector<HTMLElement>('[data-shelf-lines]')!;
/** By attribute rather than getByText: 'Priority' is a group-by label AND a sort label. */
const clause = (id: string) => shelf().querySelector<HTMLElement>(`[data-clause="${id}"]`);
/** Every setting, in the order the paragraph runs. */
const clauses = () => Array.from(shelf().querySelectorAll<HTMLElement>('[data-clause]'));
/** A multi-select's values as the eye reads them, one per value. */
const valueLabels = (id: string) =>
  Array.from(clause(id)?.querySelectorAll('[data-value]') ?? [], (v) => v.textContent);
/** The words of the first phrase or value in `el`. */
const wordsIn = (el: Element) => el.querySelector<HTMLElement>('[data-chip-label]')!;
/**
 * Every phrase and every value as the pointer meets it: the span around its
 * words and its ✕. A phrase's carries no data-value, so each is found by its
 * words.
 */
const units = () =>
  Array.from(shelf().querySelectorAll('[data-chip-label]'), (words) => words.parentElement!);
/** Every per-setting ✕, in reading order; Reset is not one of them. */
const removeXs = () => screen.queryAllByTestId('display-shelf-remove-braindump');
const removeX = (name: string) => screen.getByRole('button', { name });

/**
 * Whether the pointer stops at `el` at rest or passes through it to what is
 * underneath. pointer-events is inherited, so the nearest plain class at or
 * above `el` decides; a variant's (group-hover/unit:, focus-visible:,
 * pointer-coarse:) does not hold at rest.
 */
function pointerAtRest(el: Element): 'auto' | 'none' {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.classList.contains('pointer-events-none')) return 'none';
    if (n.classList.contains('pointer-events-auto')) return 'auto';
  }
  return 'auto';
}

/**
 * A flex box, either way round. Every box the shelf pins as one is itself an
 * item of a flex box, where inline-flex lays out as flex, so either class does.
 */
const FLEX_BOX = /(^|\s)(inline-)?flex(\s|$)/;

/**
 * A class that cuts off what hangs past its box, as a fine pointer's ✕ hangs
 * past its words and a reach past its button: any overflow but visible, on
 * either axis and under any variant, an ellipsis, a line clamp, or paint
 * containment.
 */
const CLIPS =
  /(^|[\s:])(overflow-(x-|y-)?(hidden|clip|auto|scroll)|truncate|line-clamp-(\d+|\[[^\]]+\])|contain-(paint|content|strict))(\s|$)/;

/** The classes of every box from `el`'s parent up to the shelf's own that would clip it. */
const clippersAbove = (el: Element) => {
  const found: string[] = [];
  for (let n = el.parentElement; n && n !== shelf().parentElement; n = n.parentElement) {
    const cls = n.getAttribute('class') ?? '';
    if (CLIPS.test(cls)) found.push(cls);
  }
  return found;
};

beforeEach(() => seed());
afterEach(() => {
  cleanup();
  touch.current = false;
  observers.made.length = 0;
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

    // One item of the paragraph per setting, in the menu's section order.
    expect(Array.from(lines().children, (c) => c.getAttribute('data-clause'))).toEqual([
      'group',
      'sort',
      'priority',
      'project',
      'goal',
      'hide-finished',
    ]);
    expect(clause('group')).toHaveTextContent(/^Grouped by Project$/);
    // An en dash, as SORT_BY_OPTIONS spells it.
    expect(clause('sort')).toHaveTextContent(/^Sorted by Title A–Z$/);
    expect(valueLabels('priority')).toEqual(['High', 'Low', 'No priority']);
    // The store's spelling, not the stored one.
    expect(valueLabels('project')).toEqual(['Work', 'Home', 'No project']);
    expect(valueLabels('goal')).toEqual(['Learn Chinese', 'Marathon']);
    // Reset sits in this last setting too, and adds no words to it.
    expect(clause('hide-finished')).toContainElement(resetX());
    expect(clause('hide-finished')).toHaveTextContent(/^Hide finished$/);

    // clauseText is the oracle — the opener is named by it, so the text on
    // screen has to be it, clause for clause (a multi-select's values joined as
    // it joins them).
    const { result } = renderHook(() => useDisplaySummary('braindump'));
    expect(result.current.clauses).toHaveLength(6);
    for (const c of result.current.clauses) {
      const onScreen = 'values' in c ? valueLabels(c.id).join(', ') : clause(c.id)?.textContent;
      expect(onScreen).toBe(clauseText(c));
    }
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

    const marks = (id: string) =>
      [...clause(id)!.querySelectorAll('[data-value] > [data-chip-label]')].map(
        (label) => label.firstElementChild!
      );

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

describe('Reset display, at the end of the paragraph', () => {
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

  /** Reset's slot: the span that pushes it to the end of its line. */
  const slot = () => resetX().parentElement!;

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
        // Four to take off besides what the switch keeps, so Reset shows.
        braindumpFilters: filters({
          goals: ['g1'],
          priorities: ['low'],
          containers: [NO_CONTAINER],
          hideFinished: true,
        }),
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
    seed({
      braindumpGroupBy: 'goal',
      braindumpSortBy: 'title',
      braindumpFilters: filters({ goals: ['g1'], priorities: ['high', 'low'], hideFinished: true }),
    });
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

  it('hands focus to the trigger before the reset takes the shelf away, and opens nothing', () => {
    seed(fourToTakeOff());
    renderBraindump();
    // BEFORE: React batches the reset's re-render past the handler either
    // way, so only what the trigger sees as focus lands can tell the order.
    let setWhenFocused: string | null = null;
    trigger().addEventListener('focus', () => {
      setWhenFocused = useViewStore.getState().braindumpGroupBy;
    });
    resetX().focus();

    fireEvent.click(resetX());

    expect(queryShelf()).toBeNull();
    // Not <body>, where a focused button that unmounts leaves it.
    expect(document.activeElement).toBe(trigger());
    expect(setWhenFocused).toBe('project');
    // And opens nothing. That holds by where Reset sits, outside every unit
    // (the placement cases pin it), so its click has no words' handler to
    // bubble into.
    expect(screen.queryByTestId('display-menu')).toBeNull();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  // With two or three, the ✕s and the menu's row already reset in as many
  // clicks, and Reset would push three settings onto a second line in the
  // List/Day capsule. A value is one thing to take off, as its ✕ is one ✕.
  it.each([
    { name: 'one phrase', xs: 1, shows: false, view: { braindumpGroupBy: 'project' } },
    {
      name: 'two phrases',
      xs: 2,
      shows: false,
      view: { braindumpGroupBy: 'project', braindumpSortBy: 'title' },
    },
    {
      name: 'three phrases',
      xs: 3,
      shows: false,
      view: {
        braindumpGroupBy: 'project',
        braindumpSortBy: 'title',
        braindumpFilters: filters({ hideFinished: true }),
      },
    },
    {
      name: 'one filter of three values',
      xs: 3,
      shows: false,
      view: { braindumpFilters: filters({ priorities: ['high', 'medium', 'low'] }) },
    },
    { name: 'two phrases and two values', xs: 4, shows: true, view: fourToTakeOff() },
    {
      name: 'one filter of four values',
      xs: 4,
      shows: true,
      view: { braindumpFilters: filters({ priorities: ['high', 'medium', 'low', 'none'] }) },
    },
    {
      name: 'a phrase and three values',
      xs: 4,
      shows: true,
      view: {
        braindumpGroupBy: 'project',
        braindumpFilters: filters({ containers: ['project:Work', 'project:Home', NO_CONTAINER] }),
      },
    },
  ] satisfies { name: string; xs: number; shows: boolean; view: ViewSeed }[])(
    'shows only from four things to take off up: $name',
    ({ xs, shows, view }) => {
      seed(view);
      renderBraindump();
      expect(removeXs()).toHaveLength(xs);
      expect(queryReset() !== null).toBe(shows);
    }
  );

  it('goes when a ✕ leaves fewer than four, and comes back with a fourth', () => {
    seed(fourToTakeOff());
    renderBraindump();
    expect(resetX()).toBeInTheDocument();

    fireEvent.click(removeX('Remove Priority: High'));
    expect(removeXs()).toHaveLength(3);
    expect(queryReset()).toBeNull();

    act(() =>
      useViewStore.setState({ braindumpFilters: filters({ priorities: ['low'], hideFinished: true }) })
    );
    expect(removeXs()).toHaveLength(4);
    expect(resetX()).toBeInTheDocument();
  });

  it.each([
    { variant: 'sidebar' as const, pad: ['pl-[23px]', 'pointer-coarse:pl-[16px]'], notPad: ['pl-[16px]'] },
    { variant: 'mobile' as const, pad: ['pl-[16px]'], notPad: ['pl-[23px]'] },
  ])(
    'ends the last setting in the $variant mount when that is a phrase, held to it and pushed to the end of its line',
    ({ variant, pad, notPad }) => {
      seed({ ...fourToTakeOff(), braindumpFilters: filters({ priorities: ['high', 'low'], hideFinished: true }) });
      renderBraindump(variant);
      const last = clause('hide-finished')!;
      expect(clauses().at(-1)).toBe(last);

      // In the last setting, and in no other.
      for (const c of clauses()) expect(c.contains(resetX())).toBe(c === last);
      // Pushed to the end of its line and never shrunk, with room before it
      // that clears the ✕ ahead of it: 24px from the words on a pointer, where
      // that ✕ hangs in the room, and 16 past an in-flow ✕.
      expect(slot()).toHaveClass('ml-auto', 'flex', 'shrink-0', ...pad);
      for (const p of notPad) expect(slot()).not.toHaveClass(p);
      // Nothing above it in the paragraph takes the pointer, so its own class
      // takes its click; and it is drawn at rest, unlike a ✕.
      expect(resetX()).toHaveClass('pointer-events-auto', 'text-muted-foreground');
      // One unbreakable pair with the phrase, so Reset never takes a line
      // alone, growing to the end of whatever line it lands on.
      const tail = slot().parentElement!;
      expect(tail.children).toHaveLength(2);
      expect(tail.firstElementChild).toBe(units().at(-1));
      expect(tail.lastElementChild).toBe(slot());
      expect(tail.className).toMatch(FLEX_BOX);
      expect(tail).toHaveClass('min-w-0', 'max-w-full', 'grow');
      expect(tail).not.toHaveClass('flex-wrap');
      expect(tail.parentElement).toBe(last);
      expect(last).toHaveClass('grow');
      // Not part of the phrase's unit: hovering Reset neither lights those
      // words nor draws their ✕.
      expect(units().some((u) => u.contains(resetX()))).toBe(false);
    }
  );

  it.each([
    { variant: 'sidebar' as const, pad: ['pl-[8px]', 'pointer-coarse:pl-[6px]'], notPad: ['pl-[6px]'] },
    { variant: 'mobile' as const, pad: ['pl-[6px]'], notPad: ['pl-[8px]'] },
  ])(
    'ends the last setting in the $variant mount when that is a filter, as the last item of its run',
    ({ variant, pad, notPad }) => {
      seed(fourToTakeOff());
      renderBraindump(variant);
      const run = clause('priority')!;
      expect(clauses().at(-1)).toBe(run);

      for (const c of clauses()) expect(c.contains(resetX())).toBe(c === run);
      // The run's own last item, after its values: it wraps on its own rather
      // than take the last value with it, and the run's gap is part of its room.
      expect(slot().parentElement).toBe(run);
      expect(run.lastElementChild).toBe(slot());
      expect(Array.from(run.children).slice(0, -1).map((v) => v.getAttribute('data-value'))).toEqual([
        'high',
        'low',
      ]);
      expect(slot()).toHaveClass('ml-auto', 'flex', 'shrink-0', ...pad);
      for (const p of notPad) expect(slot()).not.toHaveClass(p);
      expect(resetX()).toHaveClass('pointer-events-auto', 'text-muted-foreground');
      expect(run).toHaveClass('grow');
      expect(units().some((u) => u.contains(resetX()))).toBe(false);
    }
  );

  it("wears the menu row's own glyph, never a ✕", async () => {
    seed(fourToTakeOff());
    renderBraindump();
    // An action wherever the line leaves it, never one more setting's ✕.
    expect(resetX().querySelectorAll('svg')).toHaveLength(1);
    expect(resetX().querySelector('svg')).toHaveClass('lucide-rotate-ccw');
    expect(resetX().querySelector('svg')).not.toHaveClass('lucide-x');

    fireEvent.pointerDown(trigger(), { button: 0, ctrlKey: false });
    const row = await screen.findByTestId('display-reset');
    expect(row.querySelector('svg')).toHaveClass('lucide-rotate-ccw');
  });
});

describe('a ✕ for each setting', () => {
  it('wears one per phrase and one per value, each named for what it takes off', () => {
    everything();
    renderBraindump();

    expect(removeXs().map((x) => x.getAttribute('aria-label'))).toEqual([
      'Remove Grouped by Project',
      'Remove Sorted by Title A–Z',
      'Remove Priority: High',
      'Remove Priority: Low',
      'Remove Project: Work',
      'Remove Project: No project',
      'Remove Goal: Learn Chinese',
      'Remove Hide finished',
    ]);
    // Each sits inside the setting it removes, so it wraps and ellipsizes with it.
    expect(clause('group')).toContainElement(removeXs()[0]);
    expect(clause('priority')?.querySelector('[data-value="low"]')).toContainElement(removeXs()[3]);
  });

  it('takes off just its own setting, and leaves the rest showing', () => {
    everything();
    renderBraindump();

    fireEvent.click(removeX('Remove Priority: High'));
    expect(useViewStore.getState().braindumpFilters.priorities).toEqual(['low']);
    expect(valueLabels('priority')).toEqual(['Low']);

    fireEvent.click(removeX('Remove Project: Work'));
    expect(useViewStore.getState().braindumpFilters.containers).toEqual([NO_CONTAINER]);
    expect(valueLabels('project')).toEqual(['No project']);

    fireEvent.click(removeX('Remove Sorted by Title A–Z'));
    expect(useViewStore.getState().braindumpSortBy).toBe('default');
    expect(clause('sort')).toBeNull();
    expect(clause('group')).toHaveTextContent(/^Grouped by Project$/);

    fireEvent.click(removeX('Remove Hide finished'));
    expect(useViewStore.getState().braindumpFilters.hideFinished).toBe(false);

    fireEvent.click(removeX('Remove Goal: Learn Chinese'));
    expect(useViewStore.getState().braindumpFilters.goals).toEqual([]);
    expect(clause('goal')).toBeNull();

    // Nothing opened on the way: a ✕ is not the text.
    expect(screen.queryByTestId('display-menu')).toBeNull();
    expect(trigger()).toHaveAttribute('data-active', 'true');
  });

  // Each ✕ sits beside the words whose click opens the menu, in the unit whose
  // hover draws it: its own click has no handler that opens the menu to
  // bubble into.
  it.each([
    {
      name: 'Remove Grouped by Project',
      unit: () => wordsIn(clause('group')!).parentElement!,
      setting: () => useViewStore.getState().braindumpGroupBy,
      left: 'none',
    },
    {
      name: 'Remove Priority: High',
      unit: () => clause('priority')!.querySelector('[data-value="high"]')!,
      setting: () => useViewStore.getState().braindumpFilters.priorities,
      left: ['low'],
    },
  ])('takes its setting off and opens nothing, from beside words that open the menu: $name', async ({
    name,
    unit,
    setting,
    left,
  }) => {
    seed({ braindumpGroupBy: 'project', braindumpFilters: filters({ priorities: ['high', 'low'] }) });
    renderBraindump();
    expect(unit()).toContainElement(removeX(name));

    fireEvent.click(removeX(name));

    expect(setting()).toEqual(left);
    // A click on the words opens the menu within the click, so a tick is
    // more than it would need.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByTestId('display-menu')).toBeNull();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('leaves the canvas alone', () => {
    everything();
    useViewStore.setState({ canvasFilters: filters({ priorities: ['high'] }), canvasGroupBy: 'project' });
    renderBraindump();

    fireEvent.click(removeX('Remove Priority: High'));
    fireEvent.click(removeX('Remove Grouped by Project'));

    expect(useViewStore.getState().canvasFilters.priorities).toEqual(['high']);
    expect(useViewStore.getState().canvasGroupBy).toBe('project');
  });

  it('hands focus on to the next ✕, or the one before when it was the last', () => {
    seed(fourToTakeOff());
    renderBraindump();

    removeX('Remove Priority: High').focus();
    fireEvent.click(removeX('Remove Priority: High'));
    expect(document.activeElement).toBe(removeX('Remove Priority: Low'));

    fireEvent.click(removeX('Remove Priority: Low'));
    // Not Reset, which went with the fourth thing to take off.
    expect(document.activeElement).toBe(removeX('Remove Sorted by Title A–Z'));
  });

  it('hands focus across a setting that goes from the middle, to the ✕ after it', () => {
    seed({ braindumpGroupBy: 'project', braindumpSortBy: 'title', braindumpFilters: filters({ priorities: ['high'] }) });
    renderBraindump();
    const next = removeX('Remove Priority: High');
    removeX('Remove Sorted by Title A–Z').focus();

    fireEvent.click(removeX('Remove Sorted by Title A–Z'));

    expect(clause('sort')).toBeNull();
    // The very button focus was handed to, still mounted: each setting is kept
    // by what it names, so the ones after the gap do not take over the DOM of
    // the ones before it, and the ✕ just focused is not torn down under it.
    expect(next).toBeInTheDocument();
    expect(document.activeElement).toBe(next);
    expect(removeX('Remove Priority: High')).toBe(next);
  });

  it('never hands focus to Reset, even from the last ✕, which Reset follows and outlives', () => {
    // Five to take off, so four are left after the press and Reset stays.
    seed({ ...fourToTakeOff(), braindumpFilters: filters({ priorities: ['high', 'low'], hideFinished: true }) });
    renderBraindump();
    const last = removeX('Remove Hide finished');
    expect(removeXs().at(-1)).toBe(last);
    // Next after it in the tab order.
    expect(last.compareDocumentPosition(resetX()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    last.focus();

    fireEvent.click(last);

    expect(resetX()).toBeInTheDocument();
    expect(document.activeElement).toBe(removeX('Remove Priority: Low'));
  });

  it('hands focus to the trigger when the last setting goes, and the shelf with it', () => {
    seed({ braindumpFilters: filters({ goals: ['g1'] }) });
    renderBraindump();
    removeX('Remove Goal: Learn Chinese').focus();

    fireEvent.click(removeX('Remove Goal: Learn Chinese'));

    expect(queryShelf()).toBeNull();
    expect(trigger()).toHaveAttribute('data-active', 'false');
    expect(document.activeElement).toBe(trigger());
  });

  // A pointer's click counts 1. The browser draws no focus a mouse's click
  // leaves, so focus handed to the next ✕ sat where nobody could see it (on a
  // fine pointer the ✕ itself is not drawn until its setting is under the
  // pointer; in forced colours it is, but not the focus), and the next Space
  // took that setting off too.
  it.each([
    { name: 'a fine pointer', media: null },
    { name: 'forced colours', media: '(forced-colors: active)' },
  ])('hands focus to the opener after a click under $name, without scrolling', ({ media }) => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = (query: string) =>
      ({ ...realMatchMedia(query), matches: media !== null && query.includes(media) }) as MediaQueryList;
    seed(fourToTakeOff());
    renderBraindump();
    const scrolls: (FocusOptions | undefined)[] = [];
    const real = HTMLElement.prototype.focus;
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions
    ) {
      if (this === opener()) scrolls.push(options);
      real.call(this, options);
    });
    try {
      removeX('Remove Priority: High').focus();

      fireEvent.click(removeX('Remove Priority: High'), { detail: 1 });

      expect(useViewStore.getState().braindumpFilters.priorities).toEqual(['low']);
      expect(document.activeElement).toBe(opener());
      expect(scrolls).toEqual([{ preventScroll: true }]);
    } finally {
      spy.mockRestore();
      window.matchMedia = realMatchMedia;
    }
  });

  // Where nothing hovers, a screen reader's double-tap on a phone or tablet
  // can arrive as a click of 1, so a click there walks on as a key does.
  it.each([
    { name: 'the phone mount', variant: 'mobile' as const, media: null },
    { name: 'a coarse pointer', variant: 'sidebar' as const, media: '(pointer: coarse)' },
  ])('hands focus on to the next ✕ after a click under $name', ({ variant, media }) => {
    touch.current = variant === 'mobile';
    const realMatchMedia = window.matchMedia;
    window.matchMedia = (query: string) =>
      ({ ...realMatchMedia(query), matches: media !== null && query.includes(media) }) as MediaQueryList;
    try {
      seed(fourToTakeOff());
      renderBraindump(variant);
      removeX('Remove Priority: High').focus();

      fireEvent.click(removeX('Remove Priority: High'), { detail: 1 });

      expect(useViewStore.getState().braindumpFilters.priorities).toEqual(['low']);
      expect(document.activeElement).toBe(removeX('Remove Priority: Low'));
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  // Where every ✕ is drawn, the first click's re-wrap can put the next ✕
  // under the pointer or the finger, and a double-click's or double-tap's
  // second click lands on it.
  it.each([
    { name: 'the phone mount', variant: 'mobile' as const, media: null },
    { name: 'a coarse pointer', variant: 'sidebar' as const, media: '(pointer: coarse)' },
    { name: 'a fine pointer', variant: 'sidebar' as const, media: null },
  ])("takes nothing more off for a click's follow-on that lands on a ✕, under $name", ({ variant, media }) => {
    touch.current = variant === 'mobile';
    const realMatchMedia = window.matchMedia;
    window.matchMedia = (query: string) =>
      ({ ...realMatchMedia(query), matches: media !== null && query.includes(media) }) as MediaQueryList;
    try {
      seed(fourToTakeOff());
      renderBraindump(variant);

      fireEvent.click(removeX('Remove Priority: High'), { detail: 1 });
      fireEvent.click(removeX('Remove Priority: Low'), { detail: 2 });
      fireEvent.click(removeX('Remove Priority: Low'), { detail: 3 });

      expect(useViewStore.getState().braindumpFilters.priorities).toEqual(['low']);
      // A click of its own still takes it off.
      fireEvent.click(removeX('Remove Priority: Low'), { detail: 1 });
      expect(useViewStore.getState().braindumpFilters.priorities).toEqual([]);
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  // The follow-on's press gives the ✕ it lands on the mouse's focus, which the
  // browser does not draw, and a Space then took that setting off too.
  it.each([
    { name: 'a fine pointer', variant: 'sidebar' as const, media: null, walks: false },
    { name: 'forced colours', variant: 'sidebar' as const, media: '(forced-colors: active)', walks: false },
    { name: 'a coarse pointer', variant: 'sidebar' as const, media: '(pointer: coarse)', walks: true },
    { name: 'the phone mount', variant: 'mobile' as const, media: null, walks: true },
  ])("leaves focus after a click's follow-on on a ✕ where the click before it left it, under $name", ({
    variant,
    media,
    walks,
  }) => {
    touch.current = variant === 'mobile';
    const realMatchMedia = window.matchMedia;
    window.matchMedia = (query: string) =>
      ({ ...realMatchMedia(query), matches: media !== null && query.includes(media) }) as MediaQueryList;
    const scrolls: (FocusOptions | undefined)[] = [];
    const real = HTMLElement.prototype.focus;
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions
    ) {
      if (this.dataset.testid === 'display-shelf-open-braindump') scrolls.push(options);
      real.call(this, options);
    });
    try {
      seed(fourToTakeOff());
      renderBraindump(variant);
      removeX('Remove Priority: High').focus();
      fireEvent.click(removeX('Remove Priority: High'), { detail: 1 });
      const low = removeX('Remove Priority: Low');
      const left = walks ? low : opener();
      expect(document.activeElement).toBe(left);

      // A double-click's second, then a triple-click's third: each press
      // focuses the ✕ again (jsdom focuses nothing on a press, so the test does).
      for (const detail of [2, 3]) {
        act(() => low.focus());
        fireEvent.click(low, { detail });
        expect(useViewStore.getState().braindumpFilters.priorities).toEqual(['low']);
        expect(document.activeElement).toBe(left);
      }
      expect(scrolls).toEqual(Array(walks ? 0 : 3).fill({ preventScroll: true }));
    } finally {
      spy.mockRestore();
      window.matchMedia = realMatchMedia;
    }
  });

  // A ✕'s click can re-wrap Reset under the pointer (Wind-down's ✕ in the 280px
  // braindump), and the double-click's second press then took every setting off.
  it.each([
    { name: 'a fine pointer', variant: 'sidebar' as const, media: null, walks: false },
    { name: 'forced colours', variant: 'sidebar' as const, media: '(forced-colors: active)', walks: false },
    { name: 'a coarse pointer', variant: 'sidebar' as const, media: '(pointer: coarse)', walks: true },
    { name: 'the phone mount', variant: 'mobile' as const, media: null, walks: true },
  ])("resets nothing on a click's follow-on that lands on Reset, under $name", ({ variant, media, walks }) => {
    touch.current = variant === 'mobile';
    const realMatchMedia = window.matchMedia;
    window.matchMedia = (query: string) =>
      ({ ...realMatchMedia(query), matches: media !== null && query.includes(media) }) as MediaQueryList;
    try {
      seed({ ...fourToTakeOff(), braindumpFilters: filters({ priorities: ['high', 'medium', 'low'] }) });
      renderBraindump(variant);
      removeX('Remove Priority: Medium').focus();
      fireEvent.click(removeX('Remove Priority: Medium'), { detail: 1 });
      expect(document.activeElement).toBe(walks ? removeX('Remove Priority: Low') : opener());

      // jsdom focuses nothing on a press, so the test does.
      act(() => resetX().focus());
      fireEvent.click(resetX(), { detail: 2 });

      expect(useViewStore.getState().braindumpFilters.priorities).toEqual(['high', 'low']);
      expect(useViewStore.getState().braindumpGroupBy).toBe('project');
      expect(queryShelf()).not.toBeNull();
      expect(document.activeElement).toBe(walks ? resetX() : opener());
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  it('hands focus to the trigger after a click that takes the last setting, and the shelf with it', () => {
    seed({ braindumpFilters: filters({ goals: ['g1'] }) });
    renderBraindump();

    fireEvent.click(removeX('Remove Goal: Learn Chinese'), { detail: 1 });

    expect(queryShelf()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  // Reset goes with the fourth thing to take off, and the last phrase, which
  // it ended, is left without it. That phrase keeps its place in the DOM:
  // rebuilt, it took the ✕ just handed focus with it, and focus fell to <body>.
  it.each([{ variant: 'sidebar' as const }, { variant: 'mobile' as const }])(
    "keeps the last phrase's ✕ it hands focus to as Reset goes, in the $variant mount",
    ({ variant }) => {
      seed({
        braindumpGroupBy: 'project',
        braindumpSortBy: 'title',
        braindumpFilters: filters({ priorities: ['high'], hideFinished: true }),
      });
      renderBraindump(variant);
      expect(resetX()).toBeInTheDocument();
      const handedTo = removeX('Remove Hide finished');
      removeX('Remove Priority: High').focus();

      fireEvent.click(removeX('Remove Priority: High'));

      expect(queryReset()).toBeNull();
      expect(handedTo.isConnected).toBe(true);
      expect(document.activeElement).toBe(handedTo);
    }
  );

  it('keeps a focused ✕ in the last phrase as a fourth thing to take off brings Reset back', () => {
    seed({ braindumpGroupBy: 'project', braindumpSortBy: 'title', braindumpFilters: filters({ hideFinished: true }) });
    renderBraindump();
    expect(queryReset()).toBeNull();
    const focused = removeX('Remove Hide finished');
    focused.focus();

    act(() => useViewStore.setState({ braindumpFilters: filters({ priorities: ['high'], hideFinished: true }) }));

    expect(resetX()).toBeInTheDocument();
    expect(focused.isConnected).toBe(true);
    expect(document.activeElement).toBe(focused);
  });

  it('takes off a project the store no longer has, which no menu row can', () => {
    seed({ braindumpFilters: filters({ containers: ['project:Gone', 'project:Work'] }) });
    renderBraindump();

    fireEvent.click(removeX('Remove Project: Gone'));

    expect(useViewStore.getState().braindumpFilters.containers).toEqual(['project:Work']);
  });

  it('keeps the words out of the accessibility tree and the ✕s in it', () => {
    everything();
    renderBraindump();
    expect(shelf().querySelectorAll('[data-chip-label]')).toHaveLength(8);
    expect(removeXs()).toHaveLength(8);
    for (const label of shelf().querySelectorAll<HTMLElement>('[data-chip-label]')) {
      expect(label).toHaveAttribute('aria-hidden', 'true');
      expect(label.querySelector('button')).toBeNull();
      // A press can focus them, though Tab never stops there, and they hand
      // it straight on to the opener under them, so focus a script moves on
      // from there is a mouse's and draws no ring.
      expect(label).toHaveAttribute('tabindex', '-1');
    }
    for (const x of [...removeXs(), resetX()]) {
      expect(x.closest('[aria-hidden]')).toBeNull();
    }
    // React gives each element it renders with an onClick a native onclick,
    // and Chromium lists a clickable element in the accessibility tree. So the
    // menu's click is on the hidden words, never on the unit around them, or
    // every setting would be a nameless stop over the opener.
    const clickable = Array.from(shelf().querySelectorAll<HTMLElement>('*')).filter((el) => el.onclick !== null);
    expect(clickable.filter((el) => el.hasAttribute('data-chip-label'))).toHaveLength(8);
    for (const el of clickable) {
      expect(el instanceof HTMLButtonElement || el.closest('[aria-hidden="true"]') !== null).toBe(true);
    }
    // Each ✕ beside its words, never inside them.
    for (const x of removeXs()) expect(x.parentElement!.querySelector(':scope > [data-chip-label]')).not.toBeNull();
    // The opener comes first, so the paragraph, positioned after it, paints over it.
    expect(opener().nextElementSibling).toBe(lines());
    expect(lines()).toHaveClass('relative');
    expect(opener()).toHaveClass('absolute');
  });

  it.each(['Enter', ' '])('ignores a held %j, so autorepeat cannot walk the shelf clear', (key) => {
    everything();
    renderBraindump();
    const first = removeXs()[0];
    first.focus();
    // A repeated keydown's default (the click) is cancelled; a fresh one's is not.
    expect(fireEvent.keyDown(first, { key, repeat: true })).toBe(false);
    expect(fireEvent.keyDown(first, { key })).toBe(true);
  });

  // The look carries focus in every theme; the accent line could not alone,
  // since Paper's lime barely parts from its ground. The line is inside the
  // box, where the paragraph leaves no room around a ✕ for a ring, at the
  // accent's full strength (the base layer's ring colour is halved), and in
  // whole pixels: Chromium floors an outline's width, so a 1.5px line drew 1px.
  it.each([{ variant: 'sidebar' as const }, { variant: 'mobile' as const }])(
    'draws focus on each ✕ and Reset in the $variant mount as the pointer on it would, with a 2px accent line inside',
    ({ variant }) => {
      touch.current = variant === 'mobile';
      everything();
      renderBraindump(variant);
      const look = ['focus-visible:bg-accent', 'focus-visible:text-foreground'];
      const line = ['focus-visible:outline-solid', 'focus-visible:outline-2', 'focus-visible:outline-ring'];
      for (const x of removeXs()) {
        expect(x).toHaveClass('hover:bg-accent', 'hover:text-foreground', ...look, ...line);
        expect(x).toHaveClass('focus-visible:outline-offset-[-3px]');
      }
      expect(resetX()).toHaveClass('hover:bg-accent', 'hover:text-foreground', ...look, ...line);
      expect(resetX()).toHaveClass('focus-visible:outline-offset-[-2px]');
      for (const target of [...removeXs(), resetX()]) {
        expect(target.className).not.toMatch(/outline-\[\d*\.\d+px\]/);
        expect(target.className).not.toMatch(/outline-ring\//);
      }
    }
  );
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

  // The words take the pointer for their ✕s, so they open the menu themselves,
  // through the opener's own handle: focus comes back to the opener.
  it.each([
    { name: 'a phrase', words: () => wordsIn(clause('group')!) },
    { name: 'a value', words: () => wordsIn(clause('priority')!) },
    {
      name: 'the name inside a value',
      words: () => wordsIn(clause('priority')!).querySelector<HTMLElement>('.truncate')!,
    },
  ])('opens the pointer dropdown from the words of $name, and Escape brings focus back to the text', async ({
    words,
  }) => {
    seed({ braindumpGroupBy: 'project', braindumpFilters: filters({ priorities: ['high'] }) });
    renderBraindump();

    fireEvent.click(words());

    const menu = await screen.findByTestId('display-menu');
    expect(menu).toHaveAttribute('data-display-variant', 'menu');
    expect(screen.getAllByTestId('display-trigger-braindump')).toHaveLength(1);
    // Opened, and nothing taken off on the way.
    expect(useViewStore.getState().braindumpGroupBy).toBe('project');
    expect(useViewStore.getState().braindumpFilters.priorities).toEqual(['high']);

    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(opener()));
  });

  it("opens nothing from a click's follow-ons, which land where the first left the paragraph", async () => {
    seed({ braindumpGroupBy: 'project', braindumpSortBy: 'title', braindumpFilters: filters({ priorities: ['high'] }) });
    renderBraindump();
    // A double-click on a ✕: the first takes its setting off, and the second
    // lands on whatever the paragraph moved under the pointer, the next
    // setting's words or the opener between them.
    fireEvent.click(removeX('Remove Sorted by Title A–Z'), { detail: 1 });
    fireEvent.click(wordsIn(clause('priority')!), { detail: 2 });
    fireEvent.click(opener(), { detail: 2 });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByTestId('display-menu')).toBeNull();
    expect(useViewStore.getState().braindumpSortBy).toBe('default');
    expect(useViewStore.getState().braindumpFilters.priorities).toEqual(['high']);

    // A click of its own still opens it.
    fireEvent.click(wordsIn(clause('priority')!), { detail: 1 });
    expect(await screen.findByTestId('display-menu')).toBeInTheDocument();
  });

  it('opens nothing from a press on a ✕ let go over its own words, which clicks the setting around both', async () => {
    seed({ braindumpGroupBy: 'project', braindumpFilters: filters({ priorities: ['high'] }) });
    renderBraindump();
    const unit = removeX('Remove Priority: High').parentElement!;
    expect(unit).toContainElement(wordsIn(unit));

    fireEvent.click(unit);

    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByTestId('display-menu')).toBeNull();
    expect(useViewStore.getState().braindumpFilters.priorities).toEqual(['high']);
  });

  it.each(['Enter', ' '])(
    'ignores a held %j on its text, so autorepeat cannot open the menu again as a pick hands focus back',
    (key) => {
      seed({ braindumpGroupBy: 'project' });
      renderBraindump();
      opener().focus();
      expect(fireEvent.keyDown(opener(), { key, repeat: true })).toBe(false);
      expect(fireEvent.keyDown(opener(), { key })).toBe(true);
    }
  );

  // lib/click-away.ts takes a click on anything that is no control, inside the
  // desktop shell, for a click on nothing, and lets go of the item selection
  // and the docked item panel. The words are no control, and the menu's click
  // on them cost both, as a click on the opener never did.
  it("keeps the selection through a click on a setting's words, as through one on the opener", () => {
    everything();
    renderBraindump();
    document.body.setAttribute(CLICK_AWAY_SCOPE_ATTR, '');
    try {
      for (const target of [opener(), lines(), ...units(), ...units().map(wordsIn), ...clauses()]) {
        expect(isClickAwayTarget(target)).toBe(false);
      }
      // The shelf's own padding stays empty space, as it was.
      expect(isClickAwayTarget(shelf())).toBe(true);
    } finally {
      document.body.removeAttribute(CLICK_AWAY_SCOPE_ATTR);
    }
  });

  // Kept on the words, focus sat on an aria-hidden node, which Chromium
  // un-hides with a warning, and a key drew a ring around one setting and did
  // nothing. On the opener, the next key opens the menu.
  it("hands the focus a press gives a setting's words straight on to the opener under them, without scrolling", () => {
    everything();
    renderBraindump();
    const scrolls: (FocusOptions | undefined)[] = [];
    const real = HTMLElement.prototype.focus;
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions
    ) {
      if (this === opener()) scrolls.push(options);
      real.call(this, options);
    });
    try {
      expect(units()).toHaveLength(8);
      for (const unit of units()) {
        act(() => removeXs()[0].focus());
        act(() => wordsIn(unit).focus());
        expect(document.activeElement).toBe(opener());
      }
      expect(scrolls).toEqual(Array(8).fill({ preventScroll: true }));
    } finally {
      spy.mockRestore();
    }
  });

  it('takes the pointer on every phrase and value as the opener under it would (the arrow, and no selection), on Reset, and nowhere between', () => {
    everything();
    renderBraindump();
    // One target per ✕: each phrase, and each value.
    expect(removeXs()).toHaveLength(8);
    expect(units()).toHaveLength(8);
    for (const unit of units()) {
      // A target of its own, over a paragraph that lets the gaps between the
      // settings through to the opener, where the pointer hovers. A coarse
      // pointer never does, so there the words let a tap through to the
      // opener too, as on the phone.
      expect(unit).toHaveClass('pointer-events-auto', 'pointer-coarse:pointer-events-none');
      // …that says what the opener would: the arrow, not a text cursor, and no
      // selection from a drag, a double-click or a long press.
      expect(unit).toHaveClass('cursor-default', 'select-none');
    }
    expect(lines()).toHaveClass('pointer-events-none');

    // Reset sits in the paragraph too, outside every unit, so its own class is
    // all that takes its click: without it the click falls through to the
    // opener and opens the menu instead of resetting. And it is drawn at rest,
    // unlike a ✕.
    expect(lines()).toContainElement(resetX());
    expect(resetX()).toHaveClass('pointer-events-auto', 'text-muted-foreground');
    expect(resetX()).not.toHaveClass('pointer-events-none');
    expect(resetX()).not.toHaveClass('text-transparent');

    // Nothing else in the paragraph takes the pointer — a setting around its
    // words, a run between its values, the last phrase grown to its line's
    // end, the room Reset's slot keeps — so a click between two things on
    // screen only ever opens the menu.
    const targets = [...units(), resetX()];
    const between = Array.from(lines().querySelectorAll('*')).filter(
      (el) => !targets.some((t) => t.contains(el))
    );
    expect(between).toEqual(expect.arrayContaining([...clauses(), resetX().parentElement]));
    expect(between.filter((el) => pointerAtRest(el) !== 'none').map((el) => el.className)).toEqual([]);
  });

  // Where nothing hovers, a setting's words have nothing to draw, and a span
  // that took the tap stood between the opener and a screen reader's touch
  // exploration, which found a node with no name there instead of the button
  // that reads the whole summary.
  it("lets a tap on a setting's words through to the opener on the phone, and takes it on each ✕ and Reset", () => {
    touch.current = true;
    everything();
    renderBraindump('mobile');
    expect(units()).toHaveLength(8);
    for (const unit of units()) {
      expect(pointerAtRest(unit)).toBe('none');
      expect(pointerAtRest(unit.querySelector('[data-chip-label]')!)).toBe('none');
      expect(unit.className).not.toMatch(/pointer-events-auto/);
    }
    for (const x of [...removeXs(), resetX()]) expect(pointerAtRest(x)).toBe('auto');
    expect(pointerAtRest(opener())).toBe('auto');
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

  it('brings focus back to the shelf showing as it closes, even one a later pick put back', async () => {
    // Untick the one priority and the shelf goes; tick another and a new one
    // comes. The button that opened the menu is gone, but a shelf is there.
    seed({ braindumpFilters: filters({ priorities: ['high'] }) });
    renderBraindump();

    fireEvent.click(opener());
    fireEvent.click(await screen.findByRole('menuitem', { name: /Priority/ }));
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /High/ }));
    expect(queryShelf()).toBeNull();
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Medium/ }));
    expect(clause('priority')).toHaveTextContent(/^Medium$/);

    fireEvent.keyDown(screen.getByTestId('display-menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('display-menu')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener()));
  });

  it('forgets the text when the trigger opens the menu again before it has gone', async () => {
    // Held mounted through an exit animation, as a browser plays one: the
    // close never reached its focus return, and the trigger's own opening has
    // nothing to give focus back to but itself.
    const exit = document.createElement('style');
    exit.textContent = '[data-testid="display-menu"][data-state="closed"] { animation-name: exit; }';
    document.head.append(exit);
    try {
      seed({ braindumpGroupBy: 'project' });
      renderBraindump();
      const menu = () => screen.getByTestId('display-menu');

      fireEvent.click(opener());
      fireEvent.keyDown(menu(), { key: 'Escape' });
      await waitFor(() => expect(menu()).toHaveAttribute('data-state', 'closed'));
      // The opening edge. In a browser the same press also lands on the
      // closing menu's outside-press listener, still armed through the exit,
      // which shuts it again at once; jsdom leaves it open. Either way the
      // opening has cleared the text, and the Escape closes whatever is up.
      fireEvent.pointerDown(trigger(), { button: 0, ctrlKey: false });

      fireEvent.keyDown(menu(), { key: 'Escape' });
      await finishExit();
      await waitFor(() => expect(document.activeElement).toBe(trigger()));
    } finally {
      exit.remove();
    }
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

  describe('the phone sheet, once it has gone', () => {
    const sheet = () => screen.getByTestId('display-menu');

    beforeEach(() => {
      touch.current = true;
    });

    it('brings focus back to the text that opened it', async () => {
      seed({ braindumpGroupBy: 'project' });
      renderBraindump('mobile');

      fireEvent.click(opener());
      fireEvent.keyDown(sheet(), { key: 'Escape' });
      await finishExit();

      await waitFor(() => expect(document.activeElement).toBe(opener()));
    });

    it("brings focus back to the text when a setting's words opened it", async () => {
      seed({ braindumpGroupBy: 'project' });
      renderBraindump('mobile');

      fireEvent.click(wordsIn(clause('group')!));
      expect(sheet()).toHaveAttribute('data-state', 'open');
      fireEvent.keyDown(sheet(), { key: 'Escape' });
      await finishExit();

      await waitFor(() => expect(document.activeElement).toBe(opener()));
    });

    it('sends focus to the trigger when the trigger opened it', async () => {
      seed({ braindumpGroupBy: 'project' });
      renderBraindump('mobile');

      fireEvent.click(trigger());
      fireEvent.keyDown(sheet(), { key: 'Escape' });
      await finishExit();

      await waitFor(() => expect(document.activeElement).toBe(trigger()));
    });

    it('brings focus back to the shelf showing as it closes, even one a later pick put back', async () => {
      seed({ braindumpFilters: filters({ priorities: ['high'] }) });
      renderBraindump('mobile');

      fireEvent.click(opener());
      fireEvent.click(screen.getByTestId('display-section-priority'));
      fireEvent.click(within(sheet()).getByRole('menuitemcheckbox', { name: /High/ }));
      expect(queryShelf()).toBeNull();
      fireEvent.click(within(sheet()).getByRole('menuitemcheckbox', { name: /Medium/ }));
      expect(clause('priority')).toHaveTextContent(/^Medium$/);

      fireEvent.keyDown(sheet(), { key: 'Escape' });
      await finishExit();

      await waitFor(() => expect(document.activeElement).toBe(opener()));
    });

    it('forgets the text when the trigger opens it again before it has gone', async () => {
      seed({ braindumpGroupBy: 'project' });
      renderBraindump('mobile');

      fireEvent.click(opener());
      fireEvent.keyDown(sheet(), { key: 'Escape' });
      await waitFor(() => expect(sheet()).toHaveAttribute('data-state', 'closed'));
      // Still sliding out, so that close never reached its focus return. On a
      // phone the overlay still covers the trigger here and takes the tap, so
      // this pins the opening edge's rule where a click can reach it: an
      // opening clears whatever an earlier one asked for.
      fireEvent.click(trigger());
      expect(sheet()).toHaveAttribute('data-state', 'open');

      fireEvent.keyDown(sheet(), { key: 'Escape' });
      await finishExit();
      await waitFor(() => expect(document.activeElement).toBe(trigger()));
    });
  });
});

describe('the paragraph', () => {
  const FILTERS = ['priority', 'project', 'goal'];
  const PHRASES = ['group', 'sort', 'hide-finished'];

  it('is one wrapping run, each setting one item of it, in the menu order', () => {
    everything();
    renderBraindump();
    // The settings wrap BETWEEN one another, like the words of a sentence:
    // one flex-wrap box, every setting a direct item of it, and nothing
    // gathering some of them into a line of their own.
    expect(lines().className).toMatch(FLEX_BOX);
    expect(lines()).toHaveClass('flex-wrap', 'min-w-0', 'flex-1');
    expect(Array.from(lines().children, (c) => c.getAttribute('data-clause'))).toEqual([
      'group',
      'sort',
      'priority',
      'project',
      'goal',
      'hide-finished',
    ]);
  });

  // Every phrase has its wrapper whether or not Reset follows it, so none
  // changes parents as Reset comes and goes (the focus cases above). Where no
  // Reset follows, the wrapper has no box at all, which keeps the unit the
  // clause's own flex item: a box between them would take the words' width
  // and never let them truncate.
  it('wraps every phrase alike, in a box only where Reset follows it', () => {
    seed({ braindumpGroupBy: 'project', braindumpSortBy: 'title', braindumpFilters: filters({ hideFinished: true }) });
    renderBraindump();
    const wrapper = (id: string) => clause(id)!.firstElementChild as HTMLElement;
    expect(queryReset()).toBeNull();
    for (const id of ['group', 'sort', 'hide-finished']) {
      expect(wrapper(id).className).toBe('contents');
      expect(wrapper(id)).toContainElement(wordsIn(clause(id)!));
    }

    act(() => useViewStore.setState({ braindumpFilters: filters({ priorities: ['high'], hideFinished: true }) }));

    expect(wrapper('group').className).toBe('contents');
    expect(wrapper('sort').className).toBe('contents');
    expect(wrapper('hide-finished')).toHaveClass('grow');
    expect(wrapper('hide-finished')).not.toHaveClass('contents');
    expect(wrapper('hide-finished')).toContainElement(resetX());
  });

  it("measures nothing: no observer, no layout read, no font wait, no fit written behind React's back", async () => {
    let fontReads = 0;
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      get: () => {
        fontReads += 1;
        return { ready: Promise.resolve() };
      },
    });
    // Nothing set at first, so the shelf arrives in a braindump dnd-kit has
    // already built its own observers around.
    renderBraindump();
    expect(queryShelf()).toBeNull();
    const built = observers.made.length;
    const reads = watchLayoutReads();
    try {
      act(() =>
        useViewStore.setState({ braindumpGroupBy: 'project', braindumpFilters: filters({ hideFinished: true }) })
      );
      // And a change of text, which the measured shelf re-fit on.
      act(() =>
        useViewStore.setState({
          braindumpFilters: filters({ hideFinished: true, priorities: ['high', 'low'] }),
        })
      );
      expect(valueLabels('priority')).toEqual(['High', 'Low']);
      // Nor a frame or a task later, where a measure put off would land.
      await settle();

      expect(observers.made).toHaveLength(built);
      expect(observers.made.flatMap((o) => o.els).filter((el) => shelf().contains(el))).toEqual([]);
      expect(reads.readsIn(shelf())).toEqual([]);
      expect(fontReads).toBe(0);
    } finally {
      reads.stop();
    }
    // No fit on any node, and none of what the measured shelf kept to find one.
    expect(document.querySelector('[data-fit]')).toBeNull();
    expect(shelf().querySelector('[data-line], [data-shelf-probe], [data-shelf-sample]')).toBeNull();
  });

  // A seam sets a filter apart from what is on either side of it, so the sort
  // never reads on into "● High ● Medium" and one filter's values never run on
  // into the next's. Two phrases read apart already, by their lead words.
  it.each([
    {
      name: 'three phrases',
      view: {
        braindumpGroupBy: 'project',
        braindumpSortBy: 'title',
        braindumpFilters: filters({ hideFinished: true }),
      },
      seams: [],
    },
    {
      name: 'a filter between two phrases',
      view: { braindumpGroupBy: 'project', braindumpFilters: filters({ priorities: ['high'], hideFinished: true }) },
      seams: ['group', 'priority'],
    },
    {
      name: 'a filter last, after two phrases',
      view: fourToTakeOff(),
      seams: ['sort'],
    },
    {
      name: 'two filters side by side',
      view: { braindumpFilters: filters({ priorities: ['high'], containers: ['project:Work'] }) },
      seams: ['priority'],
    },
    { name: 'a filter alone', view: { braindumpFilters: filters({ priorities: ['high', 'low'] }) }, seams: [] },
    {
      name: 'every setting',
      view: {
        braindumpGroupBy: 'project',
        braindumpSortBy: 'title',
        braindumpFilters: filters({
          priorities: ['high'],
          containers: ['project:Work'],
          goals: ['g1'],
          hideFinished: true,
        }),
      },
      seams: ['sort', 'priority', 'project', 'goal'],
    },
  ] satisfies { name: string; view: ViewSeed; seams: string[] }[])(
    'sets a seam where a filter meets the next setting, never between two phrases nor after the last: $name',
    ({ view, seams }) => {
      seed(view);
      renderBraindump();
      const seamed = clauses().filter((c) => c.classList.contains('mr-[8px]'));
      expect(seamed.map((c) => c.getAttribute('data-clause'))).toEqual(seams);
      // A margin on the setting BEFORE the seam, which never shrinks for it: a
      // filter as wide as its line hangs the 8px past the line's end rather
      // than take them from its values…
      for (const c of seamed) expect(c).toHaveClass('shrink-0');
      // …and never one on the setting after it, so a line never starts indented.
      for (const c of clauses()) expect(c.className).not.toMatch(/(^|[\s:])-?(ml|mx|ms|pl|px|ps)-/);
    }
  );

  // 5px in every mode, between settings and between a filter's values: the
  // reach a ✕ takes above and below itself on the phone, and on the desktop
  // under a coarse pointer. With less, one row's reach lay over the next row's
  // words, and a tap on a name took a different setting off.
  it.each([{ variant: 'sidebar' as const }, { variant: 'mobile' as const }])(
    "keeps its lines 5px apart, and a filter's, in the $variant mount",
    ({ variant }) => {
      everything();
      renderBraindump(variant);
      expect(lines()).toHaveClass('gap-y-[5px]');
      for (const id of FILTERS) expect(clause(id)).toHaveClass('gap-y-[5px]');
    }
  );

  // Glyph to glyph: on a pointer a ✕ takes no room, and the words' 1px of
  // padding makes 19 between settings 20 and a filter's 15 between values 16.
  // Past an in-flow ✕ — the phone, and the desktop under a coarse pointer —
  // 16 and 10.
  it.each([
    {
      variant: 'sidebar' as const,
      settings: ['gap-x-[19px]', 'pointer-coarse:gap-x-[16px]'],
      values: ['gap-x-[15px]', 'pointer-coarse:gap-x-[10px]'],
      words: ['pr-px', 'pointer-coarse:pr-0'],
      not: ['gap-x-[16px]', 'gap-x-[10px]'],
    },
    {
      variant: 'mobile' as const,
      settings: ['gap-x-[16px]'],
      values: ['gap-x-[10px]'],
      words: [],
      not: ['gap-x-[19px]', 'gap-x-[15px]', 'pr-px'],
    },
  ])(
    "spaces the settings and a filter's values for the $variant mount",
    ({ variant, settings, values, words, not }) => {
      everything();
      renderBraindump(variant);
      expect(lines()).toHaveClass(...settings);
      for (const id of FILTERS) expect(clause(id)).toHaveClass(...values);
      const allWords = Array.from(shelf().querySelectorAll('[data-chip-label]'));
      expect(allWords).toHaveLength(8);
      if (words.length > 0) for (const w of allWords) expect(w).toHaveClass(...words);
      for (const el of [lines(), ...clauses(), ...allWords]) {
        for (const cls of not) expect(el).not.toHaveClass(cls);
      }
    }
  );

  it('carries every rule the paragraph lays out by, as classes', () => {
    // jsdom cannot lay any of this out, so the classes are the assertion, and
    // each is load-bearing. A filter is one item of the paragraph that wraps
    // its values only between one another, and only once it is as wide as a
    // line: without flex-wrap its values run off the line's end, and without
    // max-w-full it never stops at the line's width to wrap them. A value
    // never wraps apart from its ✕ and ellipsizes its name past a line; a
    // phrase never breaks at all, and ellipsizes past a line too, its ✕ never
    // shrinking away.
    everything();
    renderBraindump();

    for (const id of FILTERS) {
      const run = clause(id)!;
      expect(run.parentElement).toBe(lines());
      expect(run.className).toMatch(FLEX_BOX);
      expect(run).toHaveClass('flex-wrap', 'min-w-0', 'max-w-full');
      const values = run.querySelectorAll(':scope > [data-value]');
      expect(values.length).toBe(run.children.length);
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        expect(value.className).toMatch(FLEX_BOX);
        expect(value).toHaveClass('min-w-0', 'max-w-full');
        expect(value).not.toHaveClass('flex-wrap');
        const [label, x] = Array.from(value.children);
        expect(label).toHaveClass('min-w-0');
        expect(label.lastElementChild).toHaveClass('truncate');
        expect(x).toHaveClass('shrink-0');
        expect(x).toHaveAttribute('data-shelf-remove');
      }
    }
    for (const id of PHRASES) {
      const phrase = clause(id)!;
      expect(phrase.parentElement).toBe(lines());
      expect(phrase.className).toMatch(FLEX_BOX);
      expect(phrase).toHaveClass('min-w-0', 'max-w-full');
      expect(phrase).not.toHaveClass('flex-wrap');
      const unit = wordsIn(phrase).parentElement!;
      expect(unit.className).toMatch(FLEX_BOX);
      expect(unit).toHaveClass('min-w-0', 'max-w-full');
      const [label, x] = Array.from(unit.children);
      expect(label).toHaveClass('min-w-0', 'truncate');
      expect(x).toHaveClass('shrink-0');
      expect(x).toHaveAttribute('data-shelf-remove');
    }
  });
});

describe('the two mounts', () => {
  it('gives the phone 28px targets, and the sidebar the same only under a coarse pointer', () => {
    seed(fourToTakeOff());

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
    // 14px wide, reaching 7px right and only the 4px gap left, so a tap on
    // the words beside it still opens the menu.
    expect(removeXs()).toHaveLength(4);
    for (const x of removeXs()) {
      expect(x).toHaveClass(
        'w-[14px]',
        'relative',
        'before:absolute',
        'before:-left-[4px]',
        'before:-right-[7px]',
        'before:-inset-y-[5px]',
        "before:content-['']"
      );
    }
    // Nothing clips a reach: no box between a target and the shelf's own
    // edge, the shelf's included, cuts off what hangs past the target.
    for (const target of [...removeXs(), resetX(), opener()]) expect(clippersAbove(target)).toEqual([]);
    // The phone tab has no collapsing column to ride out.
    expect(shelf().style.minWidth).toBe('');
    cleanup();

    renderBraindump('sidebar');
    // No reach at rest, so the sidebar keeps its density…
    expect(opener()).not.toHaveClass('before:absolute');
    expect(resetX()).not.toHaveClass('before:absolute');
    expect(removeXs()).toHaveLength(4);
    for (const x of removeXs()) expect(x).not.toHaveClass('before:absolute');
    // …and a tablet on the desktop shell gets the phone's from the stylesheet,
    // so it never paints a frame of the pointer layout first.
    expect(opener()).toHaveClass(
      'pointer-coarse:before:absolute',
      'pointer-coarse:before:inset-x-0',
      'pointer-coarse:before:-inset-y-[5px]',
      "pointer-coarse:before:content-['']"
    );
    expect(resetX()).toHaveClass(
      'pointer-coarse:relative',
      'pointer-coarse:before:absolute',
      'pointer-coarse:before:-inset-x-[6px]',
      'pointer-coarse:before:-inset-y-[5px]',
      "pointer-coarse:before:content-['']"
    );
    for (const x of removeXs()) {
      expect(x).toHaveClass(
        'pointer-coarse:before:absolute',
        'pointer-coarse:before:-left-[4px]',
        'pointer-coarse:before:-right-[7px]',
        'pointer-coarse:before:-inset-y-[5px]',
        "pointer-coarse:before:content-['']"
      );
    }
    // The narrowest column, less the capsule's 10px sides.
    expect(shelf().style.minWidth).toBe(`${SIDEBAR_MIN_WIDTH - 20}px`);
  });

  it('draws a ✕ on a pointer only under its setting or on keyboard focus, and takes no hit until then', () => {
    everything();
    renderBraindump();
    expect(removeXs()).toHaveLength(8);
    for (const x of removeXs()) {
      // At rest, clear ink AND no hit: the gaps between the settings are the
      // opener's, and a click there can never land on a ✕ that was not drawn.
      // A colour, never an opacity, with no plain ink beside it to outrank it.
      expect(x).toHaveClass('text-transparent', 'pointer-events-none');
      expect(x).not.toHaveClass('text-muted-foreground');
      expect(x).not.toHaveClass('pointer-events-auto');
      // Drawn, and hit, while its setting is under the pointer, or on keyboard
      // focus, which draws it as the pointer on the ✕ itself would: full ink
      // on its plate.
      expect(x).toHaveClass(
        'group-hover/unit:text-muted-foreground',
        'group-hover/unit:pointer-events-auto',
        'focus-visible:text-foreground',
        'focus-visible:bg-accent',
        'focus-visible:pointer-events-auto'
      );
      // Forced colours paint the clear ink in a system colour, so every ✕ is
      // drawn at rest there; it takes its hit at rest too, ink and hits together.
      expect(x).toHaveClass('forced-colors:pointer-events-auto');
      // Its corners are rounded and Chromium hit-tests the rounding, so a
      // square box of its own takes them: a sweep along a line's top or bottom
      // row from the words onto the ✕ crosses no ground that is neither's.
      expect(x).toHaveClass('after:absolute', 'after:inset-0', "after:content-['']");
      // Out of flow, in the gap after its words, from the edge of the very
      // setting whose hover draws it.
      expect(x).toHaveClass('absolute', 'left-full', 'top-0');
      const unit = x.parentElement!;
      expect(unit).toHaveClass('group/unit', 'relative');
      expect(unit.querySelector(':scope > [data-chip-label]')).not.toBeNull();
      // It hangs past its words — the last on a line into the shelf's inset —
      // so nothing between it and the shelf's edge may clip it.
      expect(clippersAbove(x)).toEqual([]);
      // Under a coarse pointer, which never hovers, it is the phone's ✕: in
      // flow, drawn, and hit.
      expect(x).toHaveClass(
        'pointer-coarse:relative',
        'pointer-coarse:left-auto',
        'pointer-coarse:top-auto',
        'pointer-coarse:ml-[4px]',
        'pointer-coarse:pointer-events-auto',
        'pointer-coarse:text-muted-foreground'
      );
    }
  });

  it('draws every ✕ on the phone, in flow after its words, where nothing hovers', () => {
    touch.current = true;
    everything();
    renderBraindump('mobile');
    expect(removeXs()).toHaveLength(8);
    for (const x of removeXs()) {
      expect(x).toHaveClass('relative', 'ml-[4px]', 'text-muted-foreground');
      // Takes a tap, whichever class says so: its own does today.
      expect(pointerAtRest(x)).toBe('auto');
      // None of the pointer's: nothing clear at rest, and nothing waiting on a
      // hover or a focus to be drawn or hit (focus only deepens its ink).
      for (const cls of ['absolute', 'left-full', 'top-0', 'text-transparent', 'pointer-events-none']) {
        expect(x).not.toHaveClass(cls);
      }
      expect(x.className).not.toMatch(/group-hover|focus-visible:pointer|pointer-coarse:/);
    }
  });

  it("lights a setting's words under the pointer or while its ✕ has keyboard focus, on a pointer only", () => {
    everything();
    renderBraindump();
    expect(shelf().querySelectorAll('[data-chip-label]')).toHaveLength(8);
    for (const words of shelf().querySelectorAll('[data-chip-label]')) {
      expect(words).toHaveClass(
        'group-hover/unit:text-foreground',
        'group-has-[:focus-visible]/unit:text-foreground'
      );
    }
    // The lead words keep their own muted ink, which the hover does not reach.
    const lead = wordsIn(clause('group')!).firstElementChild!;
    expect(lead).toHaveTextContent(/^Grouped by$/);
    expect(lead).toHaveClass('text-muted-foreground');
    expect(lead.className).not.toMatch(/group-hover|group-has/);
    cleanup();

    // On the phone nothing hovers, and a tap opens the sheet over the words at once.
    renderBraindump('mobile');
    expect(shelf().querySelectorAll('[data-chip-label]')).toHaveLength(8);
    for (const words of shelf().querySelectorAll('[data-chip-label]')) {
      expect(words.className).not.toMatch(/group-hover|group-has/);
    }
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

    // Label in Name: what is on screen is what the button is called, with a
    // pause between settings and between values. One sr-only copy, since the
    // words on screen are aria-hidden (the ✕s cannot sit inside a button).
    expect(opener()).toHaveAccessibleName('Grouped by Project; High, Low; Work, No project; Learn Chinese');
    // …and that copy says what the words on screen say, word for word.
    const words = (t: string) => t.replace(/[;,]/g, ' ').split(/\s+/).filter(Boolean);
    const onScreen = Array.from(shelf().querySelectorAll('[data-chip-label]'), (l) => l.textContent ?? '');
    expect(words(onScreen.join(' '))).toEqual(words(opener().textContent ?? ''));
    expect(opener()).not.toHaveAttribute('aria-label');
    // Said, and never drawn: the copy is sr-only and the description hidden,
    // so neither paints the text a second time under the words. The name and
    // the description compute the same either way, so only the class and the
    // attribute can tell.
    expect(opener().children).toHaveLength(1);
    expect(opener().firstElementChild).toHaveClass('sr-only');
    expect(document.getElementById(opener().getAttribute('aria-describedby')!)).toHaveAttribute('hidden');
    // Under the words, which let a click through to it, and covering them.
    expect(opener()).toHaveClass('absolute', 'inset-0');
    expect(shelf().querySelector('[data-shelf-lines]')).toHaveClass('pointer-events-none', 'relative');
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

  it.each([
    { name: 'Reset button', x: () => resetX(), tip: 'Reset display' },
    { name: 'per-setting ✕', x: () => removeXs()[0], tip: 'Remove' },
  ])("gives the $name the header's own tooltip on a pointer, never a native title", async ({ x, tip }) => {
    seed(fourToTakeOff());
    renderBraindump();
    // A native title as well would fire two tooltips for one hover.
    expect(x()).not.toHaveAttribute('title');
    fireEvent.pointerEnter(x());
    fireEvent.pointerMove(x());
    expect(await screen.findByRole('tooltip')).toHaveTextContent(tip);
  });

  // The sidebar's paragraph wraps as the canvas's does, so a tip there hangs
  // over the line below too (a ✕'s over the ✕ under it), and lets a click
  // through to it as well.
  it.each([
    { name: 'Reset button', x: () => resetX() },
    { name: 'per-setting ✕', x: () => removeXs()[0] },
  ])('lets a click through the tip of the $name in the sidebar too', async ({ x }) => {
    seed(fourToTakeOff());
    renderBraindump();
    fireEvent.pointerEnter(x());
    fireEvent.pointerMove(x());
    const tip = (await screen.findByRole('tooltip')).closest('[data-slot="tooltip-content"]')!;
    expect(tip).toHaveAttribute('data-pass-through');
    expect(
      tip.parentElement!.matches('[data-radix-popper-content-wrapper]:has(> [data-pass-through])')
    ).toBe(true);
  });

  it.each([
    { name: 'Reset button', x: () => resetX() },
    { name: 'per-setting ✕', x: () => removeXs()[0] },
  ])('gives the phone $name no tooltip, as the rest of that header has none', async ({ x }) => {
    touch.current = true;
    seed(fourToTakeOff());
    renderBraindump('mobile');
    fireEvent.pointerEnter(x());
    fireEvent.pointerMove(x());
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(x()).not.toHaveAttribute('title');
  });

  it('resets on the phone from the sheet its text opens, and focus lands on the trigger', async () => {
    touch.current = true;
    seed({ braindumpGroupBy: 'project', braindumpFilters: filters({ hideFinished: true }) });
    renderBraindump('mobile');

    fireEvent.click(opener());
    fireEvent.click(within(screen.getByTestId('display-menu')).getByTestId('display-reset'));

    expect(queryShelf()).toBeNull();
    expect(useViewStore.getState().braindumpGroupBy).toBe('none');
    await finishExit();
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
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
