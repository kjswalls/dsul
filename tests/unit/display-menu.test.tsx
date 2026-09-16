import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent, waitFor } from '@testing-library/react';

/**
 * The Display menu — what it writes, and what it refuses to render.
 *
 * These are render tests rather than logic tests because the defects this menu
 * replaces were all in the wiring, not the arithmetic: a Clear row that reset
 * filters but not the grouping its own dot counted, a type control living in a
 * different component from the filters it belongs with, and two popovers whose
 * bodies had drifted apart. Every case below asserts a STORE WRITE or a rendered
 * absence, which is where that class of bug lives.
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
 * Which shell the menu draws is one boolean, and both are exercised in this
 * file. `useIsMobile` reads matchMedia, which tests/unit/setup.ts pins to "no
 * match" — so the default here is the POINTER shell and every case written
 * before the sheet existed stays on it, unchanged. The touch block below flips
 * this for its own cases and puts it back.
 *
 * A ref object rather than a bare `let`, because vi.mock's factory is hoisted
 * above the module scope it would otherwise close over.
 */
const touch = vi.hoisted(() => ({ current: false }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => touch.current }));

// MobileHeader renders UserProfileDropdown, which calls useRouter — outside a
// Next tree that throws "invariant expected app router to be mounted".
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { DisplayMenu } from '@/components/primitives/display-menu';
import { MobileHeader } from '@/components/mobile/mobile-header';
import { usePlannerStore } from '@/lib/planner-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { useViewStore } from '@/lib/view-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import { enableGoalsAndOrganize } from './support/extensions';
import type { Goal, Routine, Program } from '@dsul/types';

/**
 * jsdom implements neither PointerEvent nor pointer capture, and Radix's menus
 * open on pointerdown and call hasPointerCapture on the way. Shimmed locally
 * rather than in tests/unit/setup.ts so this file carries its own requirements.
 */
beforeAll(() => {
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const view = () => useViewStore.getState();

function seed(viewOverrides: Partial<ReturnType<typeof view>> = {}) {
  // The Goal section and the Goal grouping value ride the Goals extension,
  // which ships OFF. This file is about what the menu DOES with them, so it
  // says so once here; the gate's own behaviour is pinned in
  // extension-gates-goals.test.tsx.
  enableGoalsAndOrganize();
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: 'UTC',
    items: [],
    // ONE container list since 039. 'Health' used to be a habit group and is
    // kept in the fixtures so the assertions that used to prove the two
    // namespaces stayed apart now prove they are one.
    projects: [
      { id: 'p1', name: 'Work', emoji: '💼' },
      { id: 'p2', name: 'Home', emoji: '🏠' },
      { id: 'g1', name: 'Health', emoji: '🌱' },
    ],
    // Reset the gate containers each test so a Paused-scopes fixture can't leak
    // into the next case's menu.
    routines: [],
    programs: [],
    // Goals reset for the same reason, and one more: seed() does not clear what
    // it does not name, so a Goal fixture would otherwise still be filtering
    // two tests later.
    goals: [],
    goalsAvailable: true,
    showPausedOnGrid: false,
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
    ...viewOverrides,
  });
}

/**
 * Radix's DropdownMenuTrigger opens on POINTERDOWN, not click — a click alone
 * leaves the menu shut and every query below it fails for the wrong reason.
 * Sub-triggers and items do respond to click.
 */
const openMenu = (surface: 'canvas' | 'braindump' = 'canvas') =>
  fireEvent.pointerDown(screen.getByTestId(`display-trigger-${surface}`), {
    button: 0,
    ctrlKey: false,
  });

/** Open the menu, then a named submenu. */
async function openSub(section: string) {
  openMenu();
  fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(section) }));
}

beforeEach(() => seed());
afterEach(cleanup);

describe('what the Display menu writes', () => {
  it('toggles a priority into the surface it belongs to, and leaves the other alone', async () => {
    render(<DisplayMenu surface="canvas" />);

    await openSub('Priority');
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /High/ }));

    expect(view().canvasFilters.priorities).toEqual(['high']);
    // The two surfaces share a SHAPE, never an object. EMPTY_VIEW_FILTERS is a
    // module-level constant handed to both at init; a `patch` that mutated it in
    // place instead of spreading would show up right here.
    expect(view().braindumpFilters.priorities).toEqual([]);
  });

  it('writes a container as a prefixed ref, not a bare name', async () => {
    render(<DisplayMenu surface="canvas" />);

    await openSub('Project');
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Health/ }));

    // Still prefixed after 039, and no longer because a second namespace
    // exists: these keys share a keyspace with `priority:high` and `goal:none`,
    // and a bare name would collide with them.
    expect(view().canvasFilters.containers).toEqual(['project:Health']);
  });

  it('offers the unset value, from the registry unsetLabel', async () => {
    render(<DisplayMenu surface="canvas" />);

    await openSub('Project');
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /No project/ }));

    expect(view().canvasFilters.containers).toEqual(['none:']);
  });
});

describe('multi-select keeps the menu open; single-select closes it', () => {
  it('lets three container picks be three clicks rather than three re-opens', async () => {
    render(<DisplayMenu surface="canvas" />);

    await openSub('Project');
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Work/ }));
    // Still open — no re-opening between clicks.
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Home/ }));
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Health/ }));

    expect(view().canvasFilters.containers).toEqual([
      'project:Work', 'project:Home', 'project:Health',
    ]);
  });

  it('closes on a grouping pick, because the choice is complete', async () => {
    render(<DisplayMenu surface="canvas" />);

    await openSub('Grouping');
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Priority/ }));

    expect(view().canvasGroupBy).toBe('priority');
    expect(screen.queryByTestId('display-menu')).toBeNull();
  });
});

describe('grouping options carry live examples of what they would produce', () => {
  it('names the user own containers under the container axes, capped at two', async () => {
    render(<DisplayMenu surface="canvas" />);
    await openSub('Grouping');

    // seed() has three projects — Work, Home, Health — so the row shows the
    // first two and an ellipsis, not the whole list.
    expect(await screen.findByRole('menuitemradio', { name: /Project/ })).toHaveTextContent(
      'Work, Home…'
    );
  });

  it('names the static axes from their own vocabulary', async () => {
    render(<DisplayMenu surface="canvas" />);
    await openSub('Grouping');

    expect(await screen.findByRole('menuitemradio', { name: /Priority/ })).toHaveTextContent(
      'High, Medium…'
    );
    expect(await screen.findByRole('menuitemradio', { name: /Time bucket/ })).toHaveTextContent(
      'Anytime, Morning…'
    );
  });

  it('leaves an axis with nothing to name bare — no second line', async () => {
    // seed() clears routines, so grouping by Routine has no example to give.
    render(<DisplayMenu surface="canvas" />);
    await openSub('Grouping');

    const routine = await screen.findByRole('menuitemradio', { name: /Routine/ });
    expect(routine).toHaveTextContent('Routine');
    expect(routine.textContent).not.toMatch(/,/);
  });

  it('mirrors the braindump two sections under its Type axis', async () => {
    render(<DisplayMenu surface="braindump" />);
    openMenu('braindump');
    fireEvent.click(await screen.findByRole('menuitem', { name: /Grouping/ }));

    expect(await screen.findByRole('menuitemradio', { name: /Type/ })).toHaveTextContent(
      'Tasks, Habits'
    );
  });
});

describe('Reset display', () => {
  it('clears the grouping and the type filter its own count includes', async () => {
    // The live defect: today's Clear row resets filters only, while the trigger
    // dot counts grouping as active — so the dot stays lit after clearing, with
    // no way to put it out from the panel that lit it.
    seed({
      canvasGroupBy: 'priority',
      typeFilter: 'habits',
      canvasFilters: { ...EMPTY_VIEW_FILTERS, priorities: ['high'], hideFinished: true },
    });
    render(<DisplayMenu surface="canvas" />);

    openMenu();
    fireEvent.click(await screen.findByTestId('display-reset'));

    expect(view().canvasGroupBy).toBe('none');
    expect(view().typeFilter).toBe('all');
    expect(view().canvasFilters).toEqual(EMPTY_VIEW_FILTERS);
  });

  it('leaves Show paused alone — it is app-wide, not this surface s preference', async () => {
    // Captioned "Everywhere" for exactly this reason. Resetting one surface must
    // not silently change what the other five show.
    seed({ canvasFilters: { ...EMPTY_VIEW_FILTERS, hideFinished: true } });
    usePlannerStore.setState({ showPausedOnGrid: true });
    render(<DisplayMenu surface="canvas" />);

    openMenu();
    fireEvent.click(await screen.findByTestId('display-reset'));

    expect(usePlannerStore.getState().showPausedOnGrid).toBe(true);
  });

  it('is mounted and disabled at rest, so the panel cannot jump height', async () => {
    render(<DisplayMenu surface="canvas" />);

    openMenu();
    const reset = await screen.findByTestId('display-reset');

    // Present, not absent — today's conditionally-mounted Clear row is what
    // makes the panel resize on the first tick.
    expect(reset).toBeInTheDocument();
    expect(reset).toHaveAttribute('data-disabled');
  });

  it('counts grouping, ordering and type alongside the filter clauses', async () => {
    seed({
      canvasGroupBy: 'priority',
      canvasSortBy: 'title',
      typeFilter: 'habits',
      canvasFilters: { ...EMPTY_VIEW_FILTERS, priorities: ['high'], hideFinished: true },
    });
    render(<DisplayMenu surface="canvas" />);

    // grouping + ordering + type + one priority + hideFinished
    expect(screen.getByTestId('display-trigger-canvas')).toHaveAttribute(
      'aria-label',
      'Display (5 active)'
    );
  });

  it('clears the ordering too', async () => {
    seed({ canvasSortBy: 'priority', braindumpSortBy: 'title' });
    render(<DisplayMenu surface="canvas" />);

    openMenu();
    fireEvent.click(await screen.findByTestId('display-reset'));

    expect(view().canvasSortBy).toBe('default');
    // Not the other surface's — Reset is per-surface.
    expect(view().braindumpSortBy).toBe('title');
  });
});

describe('Ordering', () => {
  it('writes to the surface it is mounted on', async () => {
    render(<DisplayMenu surface="braindump" trigger="icon" align="start" />);

    openMenu('braindump');
    fireEvent.click(await screen.findByRole('menuitem', { name: /Ordering/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Title/ }));

    expect(view().braindumpSortBy).toBe('title');
    expect(view().canvasSortBy).toBe('default');
  });

  it('is blocked on Buckets, where the timed spine has to stay in time order', async () => {
    // inferDropTime resolves a drop as +-30 min from its NEIGHBOUR's time, so
    // re-sorting the spine would assign a time contradicting where the row
    // visibly landed.
    seed({ layout: 'buckets' });
    render(<DisplayMenu surface="canvas" />);

    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Ordering/ }));

    const byTitle = await screen.findByRole('menuitemradio', { name: /Title/ });
    expect(byTitle).toHaveAttribute('data-disabled');
    expect(byTitle).toHaveTextContent('List only');
    // Default stays live — it is how you turn an ordering off from here.
    expect(screen.getByRole('menuitemradio', { name: /Default/ })).not.toHaveAttribute(
      'data-disabled'
    );
  });

  it('stays available on Week x List, where each day section is its own list', async () => {
    // Scope does not block ordering, unlike grouping.
    seed({ scope: 'week', layout: 'list' });
    render(<DisplayMenu surface="canvas" />);

    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Ordering/ }));

    expect(await screen.findByRole('menuitemradio', { name: /Title/ })).not.toHaveAttribute(
      'data-disabled'
    );
  });

  it('keeps its row mounted on Schedule so the count has somewhere to live', async () => {
    // Same rule as Grouping: nothing clears canvasSortBy on a layout change.
    seed({ layout: 'schedule', canvasSortBy: 'title' });
    render(<DisplayMenu surface="canvas" />);

    expect(screen.getByTestId('display-trigger-canvas')).toHaveAttribute(
      'aria-label',
      'Display (1 active)'
    );

    openMenu();
    const row = within(await screen.findByTestId('display-menu')).getByRole('menuitem', {
      name: /Ordering/,
    });
    expect(row).toHaveTextContent('Title');
    expect(row).toHaveTextContent('List only');
  });
});

describe('each surface renders only what it can honour', () => {
  it('withholds Type and Show paused from the braindump', async () => {
    render(<DisplayMenu surface="braindump" trigger="icon" align="start" />);

    openMenu('braindump');
    const menu = await screen.findByTestId('display-menu');

    // Type: the braindump's corpus is single-type today, and grouping by Type
    // already answers "what is in here" at that size.
    expect(within(menu).queryByRole('menuitem', { name: /Type/ })).toBeNull();
    // Show paused is a canvas-grid preference; the braindump is dateless.
    expect(within(menu).queryByRole('menuitemcheckbox', { name: /Show paused/ })).toBeNull();
    // But the two axes it CAN answer are both there.
    expect(within(menu).getByRole('menuitem', { name: /Priority/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Project/ })).toBeInTheDocument();
  });

  it('honours Schedule outright, and keeps Time bucket to the Anytime strip', async () => {
    // Phase 5b put the partition on x — lanes where the field affords them,
    // focus where it does not — so most values carry no qualification at all.
    // Time bucket is the exception: y already IS time.
    seed({ layout: 'schedule' });
    render(<DisplayMenu surface="canvas" />);

    await openSub('Grouping');

    const priority = await screen.findByRole('menuitemradio', { name: /Priority/ });
    expect(priority).not.toHaveAttribute('data-disabled');
    expect(priority).not.toHaveTextContent('Anytime only');

    const bucket = screen.getByRole('menuitemradio', { name: /Time bucket/ });
    expect(bucket).not.toHaveAttribute('data-disabled');
    expect(bucket).toHaveTextContent('Anytime only');
  });

  it('honours grouping on week now that the week surfaces section their own rows', async () => {
    // It used to answer 'Day only' for every value on every week layout. Week x
    // List is seven independent lists and Week x Buckets is 28 independent
    // cells; both partition per unit, so there was nothing the axis could not
    // reach — only a rule saying it could not.
    seed({ scope: 'week', layout: 'list' });
    render(<DisplayMenu surface="canvas" />);

    await openSub('Grouping');

    const priority = await screen.findByRole('menuitemradio', { name: /Priority/ });
    expect(priority).not.toHaveAttribute('data-disabled');
    expect(priority).not.toHaveTextContent('Day only');
    // Nothing is blocked here, so no escape row is offered — it would resolve
    // nothing, and an action that does nothing is worse than no action.
    expect(screen.queryByRole('menuitem', { name: /Switch to/ })).toBeNull();
  });

  it('keeps the Grouping row mounted where the count still includes it', async () => {
    // Neither setScope nor setLayout clears canvasGroupBy, so grouping on
    // Day x List and switching to Buckets leaves a clause set. Hiding the
    // section left the trigger reading "Display (1 active)" over a panel where
    // nothing was set and nothing could unset it.
    //
    // Time bucket on Buckets is the one combination left that is genuinely
    // inert, which is what makes it the case to pin.
    seed({ layout: 'buckets', canvasGroupBy: 'bucket' });
    render(<DisplayMenu surface="canvas" />);

    expect(screen.getByTestId('display-trigger-canvas')).toHaveAttribute(
      'aria-label',
      'Display (1 active)'
    );

    openMenu();
    const row = within(await screen.findByTestId('display-menu')).getByRole('menuitem', {
      name: /Grouping/,
    });
    // The row accounts for the clause AND says why it is doing nothing.
    expect(row).toHaveTextContent('Time bucket');
    expect(row).toHaveTextContent('Already by bucket');
  });

  it('states the phone s own scope rather than inheriting one it never renders by', async () => {
    // Mobile is day-only by construction, but `scope` persists across the 768px
    // breakpoint, so the phone states its scope rather than reading one it never
    // renders by.
    //
    // Seeded on BUCKETS deliberately. `groupBySupport` reads `scope` in exactly
    // one arm — `layout === 'buckets'`, where day says "Untimed rows only" and
    // week says nothing — and returns FULL for every scope on list. Phase 5a
    // deleted the blanket `if (scope === 'week') return 'Day only'` this case
    // used to catch, and on `layout: 'list'` it then asserted a truth
    // independent of the prop: it stayed green with `scope` ignored entirely.
    seed({ scope: 'week', layout: 'buckets' });
    render(<DisplayMenu surface="canvas" trigger="icon" scope="day" />);

    await openSub('Grouping');

    // The DAY rail, on a store that says week.
    expect(await screen.findByRole('menuitemradio', { name: /Priority/ })).toHaveTextContent(
      'Untimed rows only'
    );
  });

  it('reports the WEEK rail when no scope prop overrides the store', async () => {
    // The other half of the case above — without it, "shows the day rail" could
    // be true because the rail is the same everywhere.
    seed({ scope: 'week', layout: 'buckets' });
    render(<DisplayMenu surface="canvas" />);

    await openSub('Grouping');

    expect(await screen.findByRole('menuitemradio', { name: /Priority/ })).not.toHaveTextContent(
      'Untimed rows only'
    );
  });

  it('announces the escape row as an action, not as an unselected option', async () => {
    // Deriving the role from close-behaviour made "Switch to List" an extra,
    // unselected radio in a set of five real grouping values. The Ordering
    // submenu still carries one on every non-List layout, so this is the set a
    // screen reader meets in the default view.
    seed({ layout: 'buckets' });
    render(<DisplayMenu surface="canvas" />);

    await openSub('Ordering');
    const escape = await screen.findByRole('menuitem', { name: /Switch to List/ });

    expect(escape).not.toHaveAttribute('aria-checked');
  });

  it('keeps the one value Buckets cannot honour visible, disabled, and explained', async () => {
    // Four cards of one bucket each, sectioned by bucket, is four cards holding
    // one section apiece — the view IS the partition. Hiding the row would make
    // the menu change shape as you switch layouts; disabling it with the reason
    // states the truth instead.
    seed({ layout: 'buckets' });
    render(<DisplayMenu surface="canvas" />);

    await openSub('Grouping');

    const bucket = await screen.findByRole('menuitemradio', { name: /Time bucket/ });
    expect(bucket).toHaveAttribute('data-disabled');
    expect(bucket).toHaveTextContent('Already by bucket');

    // Priority is honoured there now — in the untimed section, which the rail
    // says. It used to be disabled with 'List only'.
    const priority = screen.getByRole('menuitemradio', { name: /Priority/ });
    expect(priority).not.toHaveAttribute('data-disabled');
    expect(priority).toHaveTextContent('Untimed rows only');
  });

  it('offers the one-click escape only while the current value is inert', async () => {
    // It used to ride every non-List layout, where it resolved nothing because
    // nothing was blocked. Now it appears exactly when it fixes something.
    seed({ layout: 'buckets', canvasGroupBy: 'project' });
    render(<DisplayMenu surface="canvas" />);

    await openSub('Grouping');
    expect(await screen.findByRole('menuitemradio', { name: /Priority/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Switch to List/ })).toBeNull();

    cleanup();
    seed({ layout: 'buckets', canvasGroupBy: 'bucket' });
    render(<DisplayMenu surface="canvas" />);

    await openSub('Grouping');
    // menuitem, not menuitemradio — it is an action, not a value in the set.
    fireEvent.click(await screen.findByRole('menuitem', { name: /Switch to List/ }));

    expect(view().layout).toBe('list');
  });
});

/**
 * The mobile mount, tested through MobileHeader rather than through DisplayMenu.
 *
 * Both defects here were in the MOUNT, not the component, and a props-level test
 * passes with the mount wrong — which is exactly what happened. Reverting
 * mobile-header.tsx to the shipped `<DisplayMenu surface="canvas"
 * trigger="icon" />` leaves every other case in this file green and fails the
 * three tab cases plus the scope case below.
 */
describe('the mobile header mount', () => {
  const renderHeader = () =>
    render(<MobileHeader settingsHref="/settings/day" onOpenBugReport={() => {}} />);

  afterEach(() => useMobileNavStore.setState({ activeTab: 'today' }));

  it('does not ride the Braindump tab, where a second identical trigger already sits', () => {
    // MobileShell renders MobileHeader above every activeTab guard
    // (mobile-shell.tsx:55), so an ungated mount appears on all three tabs. On
    // Braindump that is two pixel-identical triggers with the same accessible
    // name, the header one writing canvasFilters while the list below reads
    // braindumpFilters — "Hide finished" would move nothing.
    useMobileNavStore.setState({ activeTab: 'braindump' });
    renderHeader();

    expect(screen.queryByTestId('display-trigger-canvas')).toBeNull();
  });

  it('does not ride the Chat tab, which reads no view store at all', () => {
    useMobileNavStore.setState({ activeTab: 'chat' });
    renderHeader();

    expect(screen.queryByTestId('display-trigger-canvas')).toBeNull();
  });

  it('mounts on Today', () => {
    useMobileNavStore.setState({ activeTab: 'today' });
    renderHeader();

    expect(screen.getByTestId('display-trigger-canvas')).toBeInTheDocument();
  });

  it('answers for DAY under a stale week scope, because the phone is day-only', async () => {
    // `scope` persists across the 768px breakpoint, and useIsMobile is a live
    // matchMedia listener — a narrowed desktop window, a snapped half-screen or
    // a rotated tablet all reach the phone shell carrying whatever scope was
    // last set. MobileViewRouter ignores it and renders day either way, so the
    // menu must too.
    //
    // Buckets, not list: that is the only layout whose answer differs by scope
    // (see the DisplayMenu case above), and it is the phone's default. On list
    // this asserted something true with or without the prop.
    seed({ scope: 'week', layout: 'buckets' });
    useMobileNavStore.setState({ activeTab: 'today' });
    renderHeader();

    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Grouping/ }));

    expect(await screen.findByRole('menuitemradio', { name: /Priority/ })).toHaveTextContent(
      'Untimed rows only'
    );
  });
});

describe('the Paused scopes list', () => {
  it('lists off scopes, hides on ones, and turns one back on when clicked', async () => {
    const setProgramState = vi.fn();
    usePlannerStore.setState({
      programs: [
        { id: 'off', name: 'Summer', state: 'paused', itemIds: [], routineIds: [] },
        { id: 'on', name: 'Term', state: 'active', itemIds: [], routineIds: [] },
      ] as Program[],
      setProgramState,
    });
    render(<DisplayMenu surface="canvas" />);
    openMenu();

    // The off scope is offered here; the on one toggles from its own group
    // header instead, so it is deliberately NOT in this list.
    expect(await screen.findByRole('menuitem', { name: /Summer/ })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Term/ })).toBeNull();

    fireEvent.click(screen.getByRole('menuitem', { name: /Summer/ }));
    // Rangeless → auto already yields on, so turning it on returns it to auto,
    // never a raw 'active' that would discard the program's dates.
    expect(setProgramState).toHaveBeenCalledWith('off', 'auto');
  });

  it('excludes a routine merely held off by a program — the program is listed instead', async () => {
    usePlannerStore.setState({
      routines: [{ id: 'r', name: 'Mornings', itemIds: [] }] as Routine[],
      programs: [
        { id: 'p', name: 'Term', state: 'paused', itemIds: [], routineIds: ['r'] },
      ] as Program[],
    });
    render(<DisplayMenu surface="braindump" />);
    openMenu('braindump');

    // The routine's own switch is still on (localOn), so it is not a recovery
    // row — the blocking program is, and turning it on brings the routine back.
    expect(await screen.findByRole('menuitem', { name: /Term/ })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Mornings/ })).toBeNull();
  });
});

describe('the Goal clause', () => {
  /**
   * The aspire axis in the menu. Everything here is about the two things a goal
   * is NOT: not a ref (it is filtered by id), and not a partition (an item can
   * serve several, so the clause unions rather than choosing).
   */
  const goal = (over: Partial<Goal> & { id: string; name: string }): Goal => ({
    state: 'active',
    memberIds: [],
    milestoneIds: [],
    checkinIds: [],
    ...over,
  });

  const seedGoals = (goals: Goal[], available = true) =>
    usePlannerStore.setState({ goals, goalsAvailable: available });

  it('writes the goal ID, never its name', async () => {
    // Goal names are not unique and rename shipped with the feature, which is
    // why the container ref grammar refuses goals outright.
    seedGoals([goal({ id: 'g1', name: 'Learn Chinese' })]);
    render(<DisplayMenu surface="canvas" />);

    await openSub('Goal');
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Learn Chinese/ }));

    expect(view().canvasFilters.goals).toEqual(['g1']);
    // The other surface is untouched, like every other clause here.
    expect(view().braindumpFilters.goals).toEqual([]);
    // And it lands in its OWN field — a goal must never reach `containers`,
    // where passesContainerFilter would read it as a ref.
    expect(view().canvasFilters.containers).toEqual([]);
  });

  it('takes a second goal alongside the first, because the clause is a union', async () => {
    seedGoals([goal({ id: 'g1', name: 'Learn Chinese' }), goal({ id: 'g2', name: 'Marathon' })]);
    render(<DisplayMenu surface="braindump" trigger="icon" align="start" />);

    openMenu('braindump');
    fireEvent.click(await screen.findByRole('menuitem', { name: /Goal/ }));
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Learn Chinese/ }));
    // Still open — multi-select, exactly like the container rows.
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Marathon/ }));

    expect(view().braindumpFilters.goals).toEqual(['g1', 'g2']);
  });

  it('offers no unset value, because the aspire axis has none', async () => {
    // The Project section carries "No project" — an item answers that axis
    // with a value that may be empty. An item does not answer the goal axis at
    // all: it serves a goal or it does not (CONTAINER_KINDS.goal.unsetLabel is
    // null). Grouping still mints a loose "No goal" section, because grouping
    // may never drop a row.
    seedGoals([goal({ id: 'g1', name: 'Learn Chinese' })]);
    render(<DisplayMenu surface="canvas" />);

    await openSub('Goal');

    expect(screen.queryByRole('menuitemcheckbox', { name: /No goal/ })).toBeNull();
  });

  it('lists live goals only — but keeps a SELECTED one that has ended', async () => {
    // Achieving a goal while it is filtering must not strand the clause: the
    // trigger still counts it, so the row that unsets it has to stay reachable.
    // seed() first: it resets the planner fixture, goals included.
    seed({ canvasFilters: { ...EMPTY_VIEW_FILTERS, goals: ['g2'] } });
    seedGoals([
      goal({ id: 'g1', name: 'Learn Chinese' }),
      goal({ id: 'g2', name: 'Ship v1', state: 'achieved' }),
      goal({ id: 'g3', name: 'Old thing', state: 'abandoned' }),
    ]);
    render(<DisplayMenu surface="canvas" />);

    await openSub('Goal');

    expect(await screen.findByRole('menuitemcheckbox', { name: /Learn Chinese/ })).toBeTruthy();
    const ended = screen.getByRole('menuitemcheckbox', { name: /Ship v1/ });
    expect(ended).toHaveAttribute('aria-checked', 'true');
    // Unselected and ended: not offered.
    expect(screen.queryByRole('menuitemcheckbox', { name: /Old thing/ })).toBeNull();

    fireEvent.click(ended);
    expect(view().canvasFilters.goals).toEqual([]);
  });

  it('keeps the section at ZERO goals, and says so', async () => {
    // The counterpart to the gate below. `goals.length` is not the condition:
    // with the feature available and nothing in it, an absent section reads as
    // a missing feature, and the empty panel is where the menu explains itself.
    seedGoals([]);
    render(<DisplayMenu surface="canvas" />);

    await openSub('Goal');

    expect(await screen.findByText(/No goals yet/)).toBeTruthy();
  });

  it('withholds the section entirely when goals are unavailable', async () => {
    // `goalsAvailable` is the table-unreachable signal (planner-store), not a
    // count. With the feature present but empty the section stays and says so.
    seedGoals([], false);
    render(<DisplayMenu surface="canvas" />);

    openMenu();
    const menu = await screen.findByTestId('display-menu');

    expect(within(menu).queryByRole('menuitem', { name: /Goal/ })).toBeNull();
  });

  it('counts a goal clause in the trigger, and Reset clears it', async () => {
    seed({ canvasFilters: { ...EMPTY_VIEW_FILTERS, goals: ['g1'] } });
    seedGoals([goal({ id: 'g1', name: 'Learn Chinese' })]);
    render(<DisplayMenu surface="canvas" />);

    expect(screen.getByTestId('display-trigger-canvas')).toHaveAttribute(
      'aria-label',
      'Display (1 active)'
    );

    openMenu();
    fireEvent.click(await screen.findByTestId('display-reset'));

    expect(view().canvasFilters.goals).toEqual([]);
  });

  it('names the single selected goal on the section rail', async () => {
    seed({ canvasFilters: { ...EMPTY_VIEW_FILTERS, goals: ['g1'] } });
    seedGoals([goal({ id: 'g1', name: 'Learn Chinese' })]);
    render(<DisplayMenu surface="canvas" />);

    openMenu();
    const row = within(await screen.findByTestId('display-menu')).getByRole('menuitem', {
      name: /Goal/,
    });

    expect(row).toHaveTextContent('Learn Chinese');
  });

  it('offers Goal as a grouping on both surfaces', async () => {
    render(<DisplayMenu surface="braindump" trigger="icon" align="start" />);

    openMenu('braindump');
    fireEvent.click(await screen.findByRole('menuitem', { name: /Grouping/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Goal/ }));

    expect(view().braindumpGroupBy).toBe('goal');
  });

  it('gives a DELETED goal a row, so the clause it left behind can be cleared', async () => {
    // The gap the "keeps a selected-but-ended goal" case above does not cover.
    // An ended goal is still IN the store; a deleted one is not in `goals` at
    // all, so neither half of the live-plus-selected list can name it — and the
    // trigger goes on counting an id with nothing in the panel to untick.
    //
    // A row rather than a store-side sweep on `removeGoal`: see the section's
    // own comment. Dropping the id on delete has no inverse, so undo would
    // restore the goal and leave the clause cleared.
    seed({ canvasFilters: { ...EMPTY_VIEW_FILTERS, goals: ['gone'] } });
    seedGoals([goal({ id: 'g1', name: 'Learn Chinese' })]);
    render(<DisplayMenu surface="canvas" />);

    // Counted, so a row has to account for it.
    expect(screen.getByTestId('display-trigger-canvas')).toHaveAttribute(
      'aria-label',
      'Display (1 active)'
    );

    await openSub('Goal');
    const stranded = await screen.findByRole('menuitemcheckbox', { name: /Unknown goal/ });
    expect(stranded).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(stranded);
    expect(view().canvasFilters.goals).toEqual([]);
  });

  it('keeps the section when goals are unavailable but a selection is stranded in it', async () => {
    // The same failure with a different cause: the goals table was unreachable
    // this session, so `goalsAvailable` withholds the section — and it would
    // take the only row that can clear a persisted selection with it. Reset
    // display is not the answer; it clears every other clause too.
    seed({ canvasFilters: { ...EMPTY_VIEW_FILTERS, goals: ['gone'], priorities: ['high'] } });
    seedGoals([], false);
    render(<DisplayMenu surface="canvas" />);

    await openSub('Goal');
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Unknown goal/ }));

    expect(view().canvasFilters.goals).toEqual([]);
    // Only the goal clause went — the point of not sending the user to Reset.
    expect(view().canvasFilters.priorities).toEqual(['high']);
  });
});

/**
 * The touch shell — one bottom sheet that drills, in place of nested submenus.
 *
 * A Radix submenu is a hover-and-aim pattern: on a phone the second tier opens
 * off-screen or under the thumb, with no way back to the tier it came from.
 * These cases pin the three things that split can get wrong — that the second
 * tier is REACHABLE and RETURNABLE, that a row writes exactly what its pointer
 * twin writes, and that the pointer shell is still the pointer shell.
 *
 * vaul holds its content through the exit transition and jsdom fires no
 * transitionend, so a closed sheet is asserted by `data-state`, not by absence
 * (the same reading tests/unit/mobile-dock.test.tsx takes).
 */
describe('the touch shell', () => {
  beforeEach(() => {
    touch.current = true;
  });
  afterEach(() => {
    touch.current = false;
  });

  /** vaul's trigger is a Radix Dialog trigger: it opens on CLICK, not pointerdown. */
  const openSheet = (surface: 'canvas' | 'braindump' = 'canvas') =>
    fireEvent.click(screen.getByTestId(`display-trigger-${surface}`));

  const pane = () => screen.getByTestId('display-sheet-pane');

  /** Open the sheet and drill into a section by its id. */
  async function drill(section: string) {
    openSheet();
    fireEvent.click(await screen.findByTestId(`display-section-${section}`));
    return pane();
  }

  it('opens a sheet rather than a dropdown, and keeps the second tier behind it', async () => {
    render(<DisplayMenu surface="canvas" trigger="icon" scope="day" />);
    openSheet();

    expect(await screen.findByTestId('display-menu')).toHaveAttribute(
      'data-display-variant',
      'sheet'
    );
    expect(pane()).toHaveAttribute('data-pane', 'root');

    // The root is sections, not values: every grouping/ordering/type/priority
    // option lives one level down. Flattening them here is the design this
    // shell deliberately did not pick — see the header of display-menu.tsx.
    expect(within(pane()).queryAllByRole('menuitemradio')).toHaveLength(0);
    expect(screen.getByTestId('display-section-grouping')).toHaveTextContent('Grouping');
    // The rail still says what it is set to, exactly as the submenu trigger does.
    expect(screen.getByTestId('display-section-priority')).toHaveTextContent('Any');
  });

  it('drills into a section and comes back — the affordance a submenu never had', async () => {
    render(<DisplayMenu surface="canvas" />);
    await drill('grouping');

    expect(pane()).toHaveAttribute('data-pane', 'grouping');
    expect(await screen.findByRole('menuitemradio', { name: /Time bucket/ })).toBeInTheDocument();
    // The sections themselves are gone while drilled: one level is on screen at
    // a time, which is what makes the back button meaningful.
    expect(screen.queryByTestId('display-section-priority')).toBeNull();

    fireEvent.click(screen.getByTestId('display-back'));

    expect(pane()).toHaveAttribute('data-pane', 'root');
    expect(screen.getByTestId('display-section-priority')).toBeInTheDocument();
  });

  /**
   * One property, every close path: the next opening starts at the root.
   *
   * The first version of this closed with Escape alone — which is vaul's OWN
   * dismissal, and the only kind that reaches a controlled `onOpenChange`. Every
   * close the sheet performed itself skipped the reset, so a phone that picked a
   * grouping value re-opened on the Grouping pane with Filter, Show, Paused
   * scopes and Reset all behind a back chevron. Parameterised so that deleting
   * the reset turns ALL of these red rather than none of them.
   *
   * A swipe-down is absent because jsdom cannot produce one, not because it goes
   * unpinned: vaul measures a drag through `getComputedStyle(el).transform`,
   * which jsdom leaves undefined and `getTranslate` throws on. It resolves
   * through vaul's own `closeDrawer()` — the same controlled `onOpenChange(false)`
   * the backdrop and Escape rows below take.
   */
  const closePaths: {
    name: string;
    prepare?: () => void;
    section: string;
    close: () => void;
  }[] = [
    {
      name: 'Escape',
      section: 'priority',
      close: () => fireEvent.keyDown(screen.getByTestId('display-menu'), { key: 'Escape' }),
    },
    {
      name: 'a backdrop tap',
      section: 'container',
      close: () => {
        const overlay = document.querySelector('[data-slot="drawer-overlay"]')!;
        fireEvent.pointerDown(overlay, { button: 0, ctrlKey: false, pointerType: 'mouse' });
        fireEvent.click(overlay);
      },
    },
    {
      // The primary interaction this shell exists for, and the one the Escape-
      // only version missed: every Grouping / Ordering / Type pick closes here.
      name: 'a single-select pick',
      section: 'grouping',
      close: () => fireEvent.click(screen.getByRole('menuitemradio', { name: /Priority/ })),
    },
    {
      name: 'the Switch to List escape',
      prepare: () => seed({ layout: 'buckets', canvasGroupBy: 'bucket' }),
      section: 'grouping',
      close: () => fireEvent.click(screen.getByRole('menuitem', { name: /Switch to List/ })),
    },
  ];

  it.each(closePaths)(
    're-opens on the root after $name, because a pane is where you stood',
    async ({ prepare, section, close }) => {
      prepare?.();
      render(<DisplayMenu surface="canvas" />);
      await drill(section);
      expect(pane()).toHaveAttribute('data-pane', section);

      close();
      await waitFor(() =>
        expect(screen.getByTestId('display-menu')).toHaveAttribute('data-state', 'closed')
      );
      // Still showing what it was showing: the reset is on the OPENING edge, so
      // the body cannot change under the exit animation.
      expect(pane()).toHaveAttribute('data-pane', section);

      openSheet();
      expect(pane()).toHaveAttribute('data-pane', 'root');
    }
  );

  it('writes what its pointer twin writes, and dismisses on a completed choice', async () => {
    render(<DisplayMenu surface="canvas" />);
    await drill('grouping');

    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Priority/ }));

    expect(view().canvasGroupBy).toBe('priority');
    // Single-select closes the whole sheet, the way the dropdown closes: the
    // choice is complete, and the surface behind it has just changed shape.
    await waitFor(() =>
      expect(screen.getByTestId('display-menu')).toHaveAttribute('data-state', 'closed')
    );
  });

  it('writes the flat Show rows, which only the sheet root ever draws', async () => {
    // These two live below the sections rather than inside one, so nothing above
    // covers them: the pointer cases reach them through MenuEntries.
    render(<DisplayMenu surface="canvas" />);
    openSheet();

    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Hide finished/ }));
    expect(view().canvasFilters.hideFinished).toBe(true);

    // Everywhere, not this surface — a planner-store setting reachable here.
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Show paused/ }));
    expect(usePlannerStore.getState().showPausedOnGrid).toBe(true);

    // Both are multi-select, so the sheet is still up and still on the root.
    expect(pane()).toHaveAttribute('data-pane', 'root');
    expect(screen.getByTestId('display-menu')).toHaveAttribute('data-state', 'open');
  });

  it('writes a priority value, and the unset one, from the drilled pane', async () => {
    render(<DisplayMenu surface="canvas" />);
    await drill('priority');

    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /^High/ }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /No priority/ }));

    expect(view().canvasFilters.priorities).toEqual(['high', 'none']);
    // The two surfaces share a SHAPE, never an object — see the pointer twin.
    expect(view().braindumpFilters.priorities).toEqual([]);
  });

  it('turns a paused scope back on from the root, without closing the sheet', async () => {
    const setProgramState = vi.fn();
    usePlannerStore.setState({
      programs: [
        { id: 'off', name: 'Summer', state: 'paused', itemIds: [], routineIds: [] },
      ] as Program[],
      setProgramState,
    });
    render(<DisplayMenu surface="canvas" />);
    openSheet();

    fireEvent.click(await screen.findByRole('menuitem', { name: /Summer/ }));

    // Rangeless → auto already yields on, so turning it on returns it to auto.
    expect(setProgramState).toHaveBeenCalledWith('off', 'auto');
    // keepOpen, exactly as on pointer: several scopes come back without re-opening.
    expect(screen.getByTestId('display-menu')).toHaveAttribute('data-state', 'open');
  });

  it('moves focus with the drill, in both directions', async () => {
    // The pressed button unmounts on every one of these transitions, and a
    // focused element that unmounts leaves focus on <body> — where arrows, tab
    // order and a screen reader's reading cursor all restart from the top of the
    // document. Radix gives the desktop submenu this; the sheet does it by hand.
    render(<DisplayMenu surface="canvas" />);
    openSheet();
    await screen.findByTestId('display-section-grouping');

    fireEvent.click(screen.getByTestId('display-section-grouping'));
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /^None/ }));

    fireEvent.click(screen.getByTestId('display-back'));
    // Back lands on the row you came from, not the top of the list.
    expect(document.activeElement).toBe(screen.getByTestId('display-section-grouping'));
  });

  it('does not claim a menu container it has no keyboard contract for', async () => {
    // A row's ROLE is shared with the model and still says what the row means.
    // The CONTAINER is not: role="menu" promises roving tabindex, arrow wrap,
    // Home/End and typeahead — Radix's for the dropdown, nobody's here — and
    // claiming it flips a screen reader into application mode where the arrows
    // it was just told to use do nothing.
    render(<DisplayMenu surface="canvas" />);
    openSheet();

    expect(await screen.findByTestId('display-sheet-pane')).toHaveAttribute('role', 'group');
    expect(screen.getByTestId('display-section-grouping')).toHaveAttribute('role', 'menuitem');
    expect(screen.getByRole('menuitemcheckbox', { name: /Hide finished/ })).toBeInTheDocument();
  });

  it('keeps the sheet on its pane for multi-select, so three picks are three taps', async () => {
    render(<DisplayMenu surface="canvas" />);
    await drill('container');

    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Work/ }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Home/ }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Health/ }));

    expect(view().canvasFilters.containers).toEqual([
      'project:Work',
      'project:Home',
      'project:Health',
    ]);
    expect(pane()).toHaveAttribute('data-pane', 'container');
    expect(screen.getByTestId('display-menu')).toHaveAttribute('data-state', 'open');
  });

  it('carries the disabled reason down with the value it belongs to', async () => {
    // The rail is the whole explanation for an inert value, and it is the first
    // thing a re-layout for touch drops. Buckets × Time bucket is the one
    // combination that is genuinely inert (Phase 5a).
    seed({ layout: 'buckets' });
    render(<DisplayMenu surface="canvas" />);
    await drill('grouping');

    const bucket = await screen.findByRole('menuitemradio', { name: /Time bucket/ });
    expect(bucket).toHaveAttribute('data-disabled');
    expect(bucket).toHaveTextContent('Already by bucket');
    expect(screen.getByRole('menuitemradio', { name: /Priority/ })).toHaveTextContent(
      'Untimed rows only'
    );
  });

  it('announces an action row as an action here too', async () => {
    // The shell does not change what a row MEANS, so "Switch to List" is a
    // menuitem in both — never a sixth unselected radio in a set of five.
    seed({ layout: 'buckets', canvasGroupBy: 'bucket' });
    render(<DisplayMenu surface="canvas" />);
    await drill('grouping');

    const escape = await screen.findByRole('menuitem', { name: /Switch to List/ });
    expect(escape).not.toHaveAttribute('aria-checked');

    fireEvent.click(escape);
    expect(view().layout).toBe('list');
  });

  it('offers Reset from the root, disabled when nothing is set', async () => {
    render(<DisplayMenu surface="canvas" />);
    openSheet();
    expect(await screen.findByTestId('display-reset')).toBeDisabled();

    cleanup();
    seed({ canvasGroupBy: 'priority', canvasFilters: { ...EMPTY_VIEW_FILTERS, hideFinished: true } });
    render(<DisplayMenu surface="canvas" />);
    openSheet();
    fireEvent.click(await screen.findByTestId('display-reset'));

    expect(view().canvasGroupBy).toBe('none');
    expect(view().canvasFilters).toEqual(EMPTY_VIEW_FILTERS);
  });

  it('puts the Goal section on a phone too, and writes the id from the drilled pane', async () => {
    // The whole reason the section is a `Section` in `filterSections` rather
    // than inline JSX: the sheet renders that array and nothing else, so a Goal
    // filter written against the pointer shell's components exists on desktop
    // only. Group-by Goal reached both shells for free — it is data in
    // lib/view-options.ts — which is exactly what made the gap easy to miss.
    usePlannerStore.setState({
      goals: [
        { id: 'g1', name: 'Learn Chinese', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [] },
        { id: 'g2', name: 'Marathon', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [] },
      ] as Goal[],
    });
    render(<DisplayMenu surface="canvas" />);
    await drill('goal');

    expect(pane()).toHaveAttribute('data-pane', 'goal');
    // The note is an Entry, so it crosses; a bare <div> under the rows would not.
    expect(within(pane()).getByText(/Milestones and check-ins count as members/)).toBeTruthy();

    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Learn Chinese/ }));
    // Multi-select, exactly as on pointer: the union is built without re-opening.
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Marathon/ }));

    expect(view().canvasFilters.goals).toEqual(['g1', 'g2']);
    expect(pane()).toHaveAttribute('data-pane', 'goal');
    expect(screen.getByTestId('display-menu')).toHaveAttribute('data-state', 'open');
  });

  it('withholds the same sections from the braindump that the dropdown does', async () => {
    render(<DisplayMenu surface="braindump" trigger="icon" align="start" />);
    openSheet('braindump');
    await screen.findByTestId('display-sheet-pane');

    expect(screen.queryByTestId('display-section-type')).toBeNull();
    expect(screen.queryByRole('menuitemcheckbox', { name: /Show paused/ })).toBeNull();
    expect(screen.getByTestId('display-section-priority')).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: /Hide finished/ })).toBeInTheDocument();
  });

  it('gives every pressable thing in every pane a 44px floor', async () => {
    // The one rule that is invisible until a thumb misses. Asserted on the CLASS
    // because jsdom lays nothing out — `min-h-11` and `size-11` are both 44px,
    // and no third spelling is allowed in here.
    //
    // Walked pane by pane, radios included. The root-only version of this stayed
    // green with SheetRow mutated to `min-h-7` for radio rows, because the root
    // draws no menuitemradio at all: every Grouping / Ordering / Type value row —
    // the majority of the rows a phone ever presses — sat outside what it counted.
    const rows = (root: HTMLElement) =>
      within(root)
        .queryAllByRole('menuitem')
        .concat(within(root).queryAllByRole('menuitemcheckbox'))
        .concat(within(root).queryAllByRole('menuitemradio'));

    // Three goals so the Goal pane has rows to measure — seed() empties them,
    // and an empty pane would sail past `measure`'s own floor below.
    usePlannerStore.setState({
      goals: [
        { id: 'g1', name: 'Learn Chinese', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [] },
        { id: 'g2', name: 'Marathon', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [] },
        { id: 'g3', name: 'Ship v1', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [] },
      ] as Goal[],
    });
    render(<DisplayMenu surface="canvas" />);
    openSheet();
    await screen.findByTestId('display-sheet-pane');

    const measured: HTMLElement[] = [];
    const measure = (found: HTMLElement[]) => {
      expect(found.length).toBeGreaterThan(2);
      for (const el of found) expect(el.className).toMatch(/(^|\s)(min-h-11|size-11)(\s|$)/);
      measured.push(...found);
    };

    measure(rows(pane()));

    for (const section of ['grouping', 'ordering', 'type', 'priority', 'container', 'goal']) {
      fireEvent.click(screen.getByTestId(`display-section-${section}`));
      expect(pane()).toHaveAttribute('data-pane', section);
      measure(rows(pane()));

      // The back affordance is drawn only while drilled, so it is measured here.
      expect(screen.getByTestId('display-back').className).toMatch(/(^|\s)size-11(\s|$)/);
      fireEvent.click(screen.getByTestId('display-back'));
    }

    // Guards the walk itself. Grouping's 7 values, Ordering's 3 and Type's 3 are
    // the rows the root-only version never saw; if the drill stopped opening,
    // every assertion above would pass over an empty pane and this would not.
    // (Grouping was 6 before the aspire axis added Goal to the vocabulary.)
    expect(measured.filter((el) => el.getAttribute('role') === 'menuitemradio')).toHaveLength(13);
  });
});

describe('the pointer shell is still the pointer shell', () => {
  it('draws a dropdown with real submenus while useIsMobile says no', async () => {
    // The guard on "do not change desktop". Every other case in this file is
    // written against this shell, but none of them would notice the sheet being
    // served to a mouse — they query roles the sheet also carries, on purpose.
    render(<DisplayMenu surface="canvas" />);
    openMenu();

    const menu = await screen.findByTestId('display-menu');
    expect(menu).toHaveAttribute('data-display-variant', 'menu');
    expect(menu.getAttribute('data-slot')).toBe('dropdown-menu-content');
    expect(screen.queryByTestId('display-sheet-pane')).toBeNull();
    // The section rows are Radix sub-triggers, which is what opens on hover.
    expect(
      within(menu).getByRole('menuitem', { name: /Grouping/ }).getAttribute('data-slot')
    ).toBe('dropdown-menu-sub-trigger');
  });
});
