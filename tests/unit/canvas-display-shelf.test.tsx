import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';

/**
 * The Display shelf on the canvas: under the view pill in the desktop header
 * capsule, and at the foot of the phone's Today card.
 *
 * The shelf itself — what it says, how it fits, how its opener hands focus
 * around — is pinned through the braindump in display-shelf.test.tsx, and the
 * words through display-summary.test.ts. What can go wrong HERE is the mount:
 * a capsule that forgets the menu's ref (the text then opens nothing, and the ✕
 * drops focus on <body>), a shelf that is not contained (the capsule grows to
 * the whole line and the shelf never stacks), a phone mount whose hook sits
 * below the Today-only early return, or a shelf reading the braindump's
 * settings. Each case below goes through the real HeaderCapsule or MobileHeader.
 *
 * jsdom lays nothing out, so the containment is pinned as the class that
 * provides it; what it does to the capsule's width was measured in Chromium
 * (see the capsule's comment on the mount).
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchPrograms: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
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
/** Which Display shell opens; setup.ts's matchMedia always answers desktop. */
const touch = vi.hoisted(() => ({ current: false }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => touch.current }));
// The phone header renders UserProfileDropdown, which calls useRouter.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { HeaderCapsule } from '@/components/canvas/header-capsule';
import { MobileHeader } from '@/components/mobile/mobile-header';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { EMPTY_VIEW_FILTERS, type ViewFilters } from '@/lib/filters';
import type { Goal } from '@/lib/planner-types';
import { enableGoalsAndOrganize } from './support/extensions';

/** jsdom has no pointer capture or ResizeObserver; Radix needs the one, the shelf guards the other. */
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
});

const GOALS = [
  { id: 'g1', name: 'Learn Chinese', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [] },
] as Goal[];

type ViewSeed = Partial<ReturnType<typeof useViewStore.getState>>;
type PlannerSeed = Partial<ReturnType<typeof usePlannerStore.getState>>;

function seed(view: ViewSeed = {}, planner: PlannerSeed = {}) {
  enableGoalsAndOrganize();
  usePlannerStore.setState({
    userId: 'user-1',
    isLoading: false,
    userTimezone: 'UTC',
    selectedDate: new Date(2026, 7, 24),
    weekStartDay: 'sunday',
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
  useMobileNavStore.setState({ activeTab: 'today' });
}

const filters = (f: Partial<ViewFilters>): ViewFilters => ({ ...EMPTY_VIEW_FILTERS, ...f });

const renderCapsule = () => render(<HeaderCapsule />);
const renderPhoneHeader = () =>
  render(<MobileHeader settingsHref="/settings/day" onOpenBugReport={() => {}} />);

const shelf = () => screen.getByTestId('display-shelf-canvas');
const queryShelf = () => screen.queryByTestId('display-shelf-canvas');
const opener = () => screen.getByTestId('display-shelf-open-canvas');
const resetX = () => screen.getByTestId('display-shelf-reset-canvas');
const trigger = () => screen.getByTestId('display-trigger-canvas');

/**
 * The Low dot is --priority-low and this project's square --accent-8, both
 * lime, drawn at rest as data glyphs — which is only allowed while nothing
 * between them and the surface can fade them. The braindump's mount is walked
 * the same way in display-shelf.test.tsx; each mount has its own ancestors.
 */
const LIME_SEED: [ViewSeed, PlannerSeed] = [
  { canvasFilters: filters({ priorities: ['low'], containers: ['project:Wind-down'] }) },
  { projects: [{ id: 'p9', name: 'Wind-down', emoji: '🌙', color: 'var(--accent-8)' }] },
];

function expectNothingFadesLime(surface: Element) {
  const lime = [...shelf().querySelectorAll<HTMLElement>('[style]')].filter((el) =>
    /var\(--priority-low\)|var\(--accent-8\)/.test(el.getAttribute('style') ?? '')
  );
  expect(lime).toHaveLength(2);
  for (const glyph of lime) {
    let node: HTMLElement | null = glyph;
    while (node) {
      expect(node.getAttribute('class') ?? '').not.toMatch(/(^|[\s:])(opacity-|transition-opacity)/);
      expect(node.style.opacity).toBe('');
      if (node === surface) break;
      node = node.parentElement;
    }
    expect(node).toBe(surface);
  }
}

/** Let a closing sheet go: jsdom plays no animation, and vaul's Presence waits for one. */
async function finishExit() {
  const menu = screen.getByTestId('display-menu');
  await waitFor(() => expect(menu).toHaveAttribute('data-state', 'closed'));
  const end = new Event('animationend');
  Object.defineProperty(end, 'animationName', { value: getComputedStyle(menu).animationName });
  act(() => {
    menu.dispatchEvent(end);
  });
  await waitFor(() => expect(screen.queryByTestId('display-menu')).toBeNull());
}

beforeEach(() => seed());
afterEach(() => {
  cleanup();
  touch.current = false;
});

/** Canvas states, and whether each lights the canvas trigger (and so shows the shelf). */
const states: { name: string; view: ViewSeed; lit: boolean }[] = [
  { name: 'nothing set', view: {}, lit: false },
  { name: 'a grouping', view: { canvasGroupBy: 'project' }, lit: true },
  { name: 'an ordering', view: { canvasSortBy: 'title' }, lit: true },
  { name: 'the type filter', view: { typeFilter: 'habits' }, lit: true },
  { name: 'a filter', view: { canvasFilters: filters({ hideFinished: true }) }, lit: true },
  {
    // The braindump's own settings are the braindump's: the canvas must neither
    // count them nor name them.
    name: 'the braindump settings alone',
    view: {
      braindumpGroupBy: 'project',
      braindumpSortBy: 'title',
      braindumpFilters: filters({ priorities: ['high'], hideFinished: true }),
    },
    lit: false,
  },
];

describe('the desktop mount, under the view pill', () => {
  it.each(states)('shows exactly when the canvas trigger is lit: $name', ({ view, lit }) => {
    seed(view);
    renderCapsule();

    expect(trigger()).toHaveAttribute('data-active', String(lit));
    expect(queryShelf() !== null).toBe(lit);
  });

  it('is the capsule’s third row, contained, with no floor and pointer-sized targets', () => {
    seed({ canvasGroupBy: 'project' });
    const { container } = renderCapsule();
    const capsule = container.firstElementChild!;

    // Date row, pill, shelf — and only the shelf is new: at rest the capsule
    // keeps its two rows and its gap adds nothing.
    expect(capsule.children).toHaveLength(3);
    expect(capsule.lastElementChild).toBe(shelf());
    expect(capsule.children[1]).toContainElement(trigger());

    // The capsule is sized by its content; without containment it would grow to
    // the shelf's whole line and the shelf would never stack.
    expect(shelf()).toHaveClass('contain-inline-size', 'px-4', 'pt-1', 'pb-px');
    expect(shelf()).not.toHaveClass('px-[15px]', 'pt-2', 'pb-[3px]');
    // The width floor is the sidebar's, for its fold; the capsule has none.
    expect(shelf().style.minWidth).toBe('');
    expect(opener()).not.toHaveClass('before:absolute');
    expect(resetX()).not.toHaveClass('before:absolute');
  });

  it('goes when the last setting does, and the capsule is back to two rows', () => {
    seed({ canvasGroupBy: 'project' });
    const { container } = renderCapsule();

    act(() => useViewStore.getState().setCanvasGroupBy('none'));

    expect(queryShelf()).toBeNull();
    expect(container.firstElementChild!.children).toHaveLength(2);
  });

  it('names the type filter by what it hides, not as a bare noun', () => {
    seed({ canvasGroupBy: 'project', typeFilter: 'tasks' });
    renderCapsule();

    expect(shelf().querySelector('[data-clause="type"]')).toHaveTextContent(/^Hide habits$/);
    expect(shelf().querySelector('[data-clause="group"]')).toHaveTextContent(/^Grouped by Project$/);
  });

  it('opens the canvas menu from its text, and Escape brings focus back to the text', async () => {
    seed({ canvasGroupBy: 'project' });
    renderCapsule();

    fireEvent.click(opener());

    // The label trigger's own dropdown, opened through the handle — not a
    // second menu beside it.
    const menu = await screen.findByTestId('display-menu');
    expect(menu).toHaveAttribute('data-display-variant', 'menu');
    expect(screen.getAllByTestId('display-trigger-canvas')).toHaveLength(1);

    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(opener()));
  });

  it('its ✕ leaves the stores exactly as the menu’s Reset row does, and the braindump alone', async () => {
    const view: ViewSeed = {
      canvasGroupBy: 'project',
      canvasSortBy: 'title',
      typeFilter: 'habits',
      canvasFilters: filters({ priorities: ['high'], containers: ['project:Work'], goals: ['g1'], hideFinished: true }),
      // The other surface, which the canvas reset must not reach.
      braindumpGroupBy: 'project',
      braindumpSortBy: 'priority',
      braindumpFilters: filters({ priorities: ['low'] }),
    };
    const snapshot = () => {
      const v = useViewStore.getState();
      return {
        canvasFilters: v.canvasFilters,
        canvasGroupBy: v.canvasGroupBy,
        canvasSortBy: v.canvasSortBy,
        typeFilter: v.typeFilter,
        braindumpFilters: v.braindumpFilters,
        braindumpGroupBy: v.braindumpGroupBy,
        braindumpSortBy: v.braindumpSortBy,
      };
    };

    seed(view);
    renderCapsule();
    fireEvent.pointerDown(trigger(), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByTestId('display-reset'));
    const byMenu = snapshot();
    cleanup();

    seed(view);
    renderCapsule();
    fireEvent.click(resetX());

    expect(snapshot()).toEqual(byMenu);
    expect(snapshot().braindumpGroupBy).toBe('project');
    expect(snapshot().braindumpFilters).toEqual(filters({ priorities: ['low'] }));
  });

  it('hands focus to the Display trigger before the reset takes the shelf away', () => {
    seed({ canvasGroupBy: 'project' });
    renderCapsule();
    resetX().focus();

    fireEvent.click(resetX());

    expect(queryShelf()).toBeNull();
    // Not <body>, where a focused button that unmounts leaves it — which is
    // where it would go if the capsule forgot to hand the shelf the menu's ref.
    expect(document.activeElement).toBe(trigger());
  });

  it('names its ✕ in a tooltip on a pointer, and never with a native title', async () => {
    seed({ canvasGroupBy: 'project' });
    renderCapsule();
    expect(resetX()).not.toHaveAttribute('title');

    fireEvent.pointerEnter(resetX());
    fireEvent.pointerMove(resetX());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Reset display');
  });

  it('has nothing that can fade a lime glyph between it and the capsule', () => {
    seed(...LIME_SEED);
    const { container } = renderCapsule();
    expectNothingFadesLime(container.firstElementChild!);
  });
});

describe('the phone mount, at the foot of the Today card', () => {
  it.each(states)('shows exactly when the canvas trigger is lit: $name', ({ view, lit }) => {
    seed(view);
    renderPhoneHeader();

    expect(trigger()).toHaveAttribute('data-active', String(lit));
    expect(queryShelf() !== null).toBe(lit);
  });

  it('sits last in the card, under the week strip, with touch targets and no floor', () => {
    seed({ canvasGroupBy: 'project' });
    renderPhoneHeader();

    // Last, so the date row, its week and the review notice about that date
    // stay one cluster, and the line sits over the content it describes. No
    // review is owed here, so the week strip is right above it.
    const card = shelf().parentElement!;
    expect(card).toContainElement(screen.getByTestId('header-date'));
    expect(card.lastElementChild).toBe(shelf());
    const strip = shelf().previousElementSibling!;
    expect(strip.querySelectorAll('[data-testid="week-day"]')).toHaveLength(7);

    // The card is as wide as the screen, so no containment; the text sits on
    // the date's edge.
    expect(shelf()).toHaveClass('px-0', 'pt-0', 'pb-px');
    expect(shelf()).not.toHaveClass('contain-inline-size');
    expect(shelf().style.minWidth).toBe('');
    // 28px targets on a thumb's surface.
    expect(opener()).toHaveClass('before:absolute', 'before:-inset-y-[5px]');
    expect(resetX()).toHaveClass('before:absolute', 'before:-inset-x-[6px]');
  });

  it('is not on the Braindump or Chat tab, whatever the canvas holds', () => {
    for (const tab of ['braindump', 'chat'] as const) {
      seed({ canvasGroupBy: 'project', canvasFilters: filters({ hideFinished: true }) });
      useMobileNavStore.setState({ activeTab: tab });
      renderPhoneHeader();

      expect(queryShelf()).toBeNull();
      cleanup();
    }
  });

  it('comes and goes with the tab, with its hooks above the early return', () => {
    // A hook below the Today-only return runs on Today and not on the others,
    // and React throws the moment the count changes between renders.
    seed({ canvasGroupBy: 'project' });
    renderPhoneHeader();
    expect(shelf()).toBeInTheDocument();

    act(() => useMobileNavStore.setState({ activeTab: 'braindump' }));
    expect(queryShelf()).toBeNull();

    act(() => useMobileNavStore.setState({ activeTab: 'today' }));
    expect(shelf()).toBeInTheDocument();

    // And the ref still reaches the menu across the round trip.
    resetX().focus();
    fireEvent.click(resetX());
    expect(document.activeElement).toBe(trigger());
  });

  it('opens the sheet from its text and brings focus back to it', async () => {
    touch.current = true;
    seed({ canvasGroupBy: 'project' });
    renderPhoneHeader();

    fireEvent.click(opener());
    const sheet = screen.getByTestId('display-menu');
    expect(sheet).toHaveAttribute('data-state', 'open');
    expect(sheet).toHaveAttribute('data-display-variant', 'sheet');

    fireEvent.keyDown(sheet, { key: 'Escape' });
    await finishExit();
    await waitFor(() => expect(document.activeElement).toBe(opener()));
  });

  it('hands focus from its ✕ to the icon trigger, through the card’s wrapper', () => {
    touch.current = true;
    seed({ canvasGroupBy: 'project' });
    renderPhoneHeader();
    resetX().focus();

    fireEvent.click(resetX());

    expect(queryShelf()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('has nothing that can fade a lime glyph between it and the header', () => {
    seed(...LIME_SEED);
    renderPhoneHeader();
    expectNothingFadesLime(shelf().closest('header')!);
  });
});
