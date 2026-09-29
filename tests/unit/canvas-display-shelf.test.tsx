import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react';

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
 * (memory/plans/display-menu.md, "Containment is load-bearing on the desktop").
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
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
import { RailTooltip } from '@/components/primitives/pills';
import { MobileHeader } from '@/components/mobile/mobile-header';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { EMPTY_VIEW_FILTERS, type ViewFilters } from '@/lib/filters';
import type { Goal } from '@/lib/planner-types';
import { useEODStore } from '@/lib/eod-store';
import { resetNoticeAnchors } from '@/lib/notice-anchors';
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
const removeXs = () => screen.queryAllByTestId('display-shelf-remove-canvas');
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
    // Two settings, so the reset ✕ is drawn beside the two settings' own.
    seed({ canvasGroupBy: 'project', canvasSortBy: 'title' });
    const { container } = renderCapsule();
    const capsule = container.firstElementChild!;

    // Date row, pill, shelf — and only the shelf is new: at rest the capsule
    // keeps its two rows and its gap adds nothing.
    expect(capsule.children).toHaveLength(3);
    expect(capsule.lastElementChild).toBe(shelf());
    expect(capsule.children[1]).toContainElement(trigger());

    // The capsule is sized by its content; without containment it would grow to
    // the shelf's whole line and the shelf would never stack.
    expect(shelf()).toHaveClass('contain-inline-size', 'px-4', 'pr-3.5', 'pt-1', 'pb-px');
    // One class to an assertion: a negated toHaveClass with several passes as
    // soon as any one of them is gone.
    expect(shelf()).not.toHaveClass('px-[15px]');
    expect(shelf()).not.toHaveClass('pt-2');
    expect(shelf()).not.toHaveClass('pb-[3px]');
    // The width floor is the sidebar's, for its fold; the capsule has none.
    expect(shelf().style.minWidth).toBe('');
    expect(opener()).not.toHaveClass('before:absolute');
    expect(resetX()).not.toHaveClass('before:absolute');
    expect(removeXs()).toHaveLength(2);
    for (const x of removeXs()) expect(x).not.toHaveClass('before:absolute');
    // A ✕ reaches nothing past itself here, so wrapped rows keep no gap for it.
    const lines = shelf().querySelector('[data-shelf-lines]')!;
    expect(lines).not.toHaveClass('[&_[data-clause]]:gap-y-[5px]');
    expect(lines).not.toHaveClass('[&_[data-line]]:gap-y-[5px]');
  });

  it('goes when the last setting does, and the capsule is back to two rows', () => {
    seed({ canvasGroupBy: 'project' });
    const { container } = renderCapsule();

    act(() => useViewStore.getState().setCanvasGroupBy('none'));

    expect(queryShelf()).toBeNull();
    expect(container.firstElementChild!.children).toHaveLength(2);
  });

  it('names the type filter in the menu’s words, led as grouping is, never as a bare noun', () => {
    seed({ canvasGroupBy: 'project', typeFilter: 'tasks' });
    renderCapsule();

    const type = shelf().querySelector('[data-clause="type"]')!;
    expect(type).toHaveTextContent(/^Showing Tasks$/);
    // The lead is muted as "Grouped by" is, so the value reads as the menu's row.
    const lead = type.querySelector('[data-chip-label]')!.firstElementChild;
    expect(lead).toHaveTextContent(/^Showing$/);
    expect(lead).toHaveClass('text-muted-foreground');
    expect(shelf().querySelector('[data-clause="group"]')).toHaveTextContent(/^Grouped by Project$/);
    // Its ✕ says the same words.
    expect(within(type as HTMLElement).getByTestId('display-shelf-remove-canvas')).toHaveAccessibleName(
      'Remove Showing Tasks'
    );
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
    seed({ canvasGroupBy: 'project', canvasSortBy: 'title' });
    renderCapsule();
    // BEFORE: React batches the reset's re-render past the handler either
    // way, so only what the trigger sees as focus lands can tell the order.
    let setWhenFocused: string | null = null;
    trigger().addEventListener('focus', () => {
      setWhenFocused = useViewStore.getState().canvasGroupBy;
    });
    resetX().focus();

    fireEvent.click(resetX());

    expect(queryShelf()).toBeNull();
    // Not <body>, where a focused button that unmounts leaves it — which is
    // where it would go if the capsule forgot to hand the shelf the menu's ref.
    expect(document.activeElement).toBe(trigger());
    expect(setWhenFocused).toBe('project');
  });

  it('takes one canvas setting off with its own ✕, and leaves the braindump alone', () => {
    seed({
      canvasGroupBy: 'project',
      canvasFilters: filters({ priorities: ['high', 'low'] }),
      braindumpGroupBy: 'project',
      braindumpFilters: filters({ priorities: ['high'] }),
    });
    renderCapsule();
    const high = removeXs().find((x) => x.getAttribute('aria-label') === 'Remove Priority: High')!;

    fireEvent.click(high);

    const v = useViewStore.getState();
    expect(v.canvasFilters.priorities).toEqual(['low']);
    expect(v.canvasGroupBy).toBe('project');
    expect(v.braindumpFilters.priorities).toEqual(['high']);
    expect(v.braindumpGroupBy).toBe('project');
    // Focus went on to the next ✕ before this one left.
    expect(document.activeElement).toHaveAccessibleName('Remove Priority: Low');
  });

  it('takes the type filter off with its own ✕, and nothing else', () => {
    seed({ typeFilter: 'tasks', canvasGroupBy: 'project', braindumpGroupBy: 'project' });
    renderCapsule();
    const type = removeXs().find((x) => x.getAttribute('aria-label') === 'Remove Showing Tasks')!;

    fireEvent.click(type);

    const v = useViewStore.getState();
    expect(v.typeFilter).toBe('all');
    expect(v.canvasGroupBy).toBe('project');
    expect(v.braindumpGroupBy).toBe('project');
  });

  it('draws the reset ✕ only while the line wears more than one ✕', () => {
    seed({ canvasGroupBy: 'project' });
    renderCapsule();
    expect(removeXs()).toHaveLength(1);
    expect(screen.queryByTestId('display-shelf-reset-canvas')).toBeNull();

    // Still one setting, but two values, and so two ✕s.
    act(() =>
      useViewStore.setState({
        canvasGroupBy: 'none',
        canvasFilters: filters({ priorities: ['high', 'low'] }),
      })
    );
    expect(removeXs()).toHaveLength(2);
    expect(resetX()).toBeInTheDocument();
  });

  it('hands focus to the Display trigger before the last setting goes by its ✕', () => {
    seed({ canvasGroupBy: 'project' });
    renderCapsule();
    // BEFORE, as the reset's: only what the trigger sees as focus lands can
    // tell the order.
    let setWhenFocused: string | null = null;
    trigger().addEventListener('focus', () => {
      setWhenFocused = useViewStore.getState().canvasGroupBy;
    });
    const [only] = removeXs();
    only.focus();

    fireEvent.click(only);

    expect(queryShelf()).toBeNull();
    // Not <body>: the capsule handed the shelf the menu's ref.
    expect(document.activeElement).toBe(trigger());
    expect(setWhenFocused).toBe('project');
  });

  it.each([
    { name: 'reset', x: () => resetX(), tip: 'Reset display' },
    { name: 'per-setting', x: () => removeXs()[0], tip: 'Remove' },
  ])('names its $name ✕ in a tooltip on a pointer, and never with a native title', async ({ x, tip }) => {
    seed({ canvasGroupBy: 'project', canvasSortBy: 'title' });
    renderCapsule();
    expect(x()).not.toHaveAttribute('title');

    fireEvent.pointerEnter(x());
    fireEvent.pointerMove(x());
    expect(await screen.findByRole('tooltip')).toHaveTextContent(tip);
  });

  /**
   * In the stack a ✕'s tip covers the ✕ on the line below, and moving down to
   * press that one pressed the tip instead. jsdom applies no stylesheet, so
   * this pins the two halves the click depends on: the attribute on each ✕'s
   * tip, and the rule in globals.css that lets the click through the wrapper
   * Radix positions the tip in, matched against the wrapper actually drawn.
   */
  const PASS_THROUGH = '[data-radix-popper-content-wrapper]:has(> [data-pass-through])';

  it.each([
    { name: 'reset', x: () => resetX() },
    { name: 'per-setting', x: () => removeXs()[0] },
  ])('lets a click through its $name ✕’s tip to whatever the tip covers', async ({ x }) => {
    seed({ canvasGroupBy: 'project', canvasSortBy: 'title' });
    renderCapsule();

    fireEvent.pointerEnter(x());
    fireEvent.pointerMove(x());
    const tip = (await screen.findByRole('tooltip')).closest('[data-slot="tooltip-content"]')!;

    expect(tip).toHaveAttribute('data-pass-through');
    expect(tip.parentElement!.matches(PASS_THROUGH)).toBe(true);
  });

  it('leaves every other rail tip as it was: one without passThrough takes the click', async () => {
    render(
      <RailTooltip label="Plain">
        <button type="button">plain</button>
      </RailTooltip>
    );
    const trigger = screen.getByRole('button', { name: 'plain' });
    fireEvent.pointerEnter(trigger);
    fireEvent.pointerMove(trigger);
    const tip = (await screen.findByRole('tooltip')).closest('[data-slot="tooltip-content"]')!;

    expect(tip).not.toHaveAttribute('data-pass-through');
    expect(tip.parentElement!.matches(PASS_THROUGH)).toBe(false);
  });

  it('has the rule that lets the click through, and nothing else in it', () => {
    const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
    const at = css.indexOf(`${PASS_THROUGH} {`);
    expect(at, 'the pass-through rule is gone from globals.css').toBeGreaterThan(-1);
    const open = css.indexOf('{', at);
    expect(css.slice(open + 1, css.indexOf('}', open)).trim()).toBe('pointer-events: none;');
  });

  it('has the rule at the top level, where nothing can scope it away or undo it', () => {
    const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
    const at = css.indexOf(`${PASS_THROUGH} {`);
    expect(at).toBeGreaterThan(-1);
    // Comments aside, every block opened before the rule closes before it: no
    // @media, @supports or @layer around it.
    const before = css.slice(0, at).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(before.split('{').length - before.split('}').length).toBe(0);
    // And nothing after it gives a tip's content its own pointer-events back.
    const after = css.slice(at + PASS_THROUGH.length).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(after).not.toMatch(/tooltip-content[^{]*\{[^}]*pointer-events/);
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
    seed({ canvasGroupBy: 'project', canvasSortBy: 'title' });
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
    // 28px targets on a thumb's surface, as the Braindump tab's: the text and
    // the reset ✕ reach 5px above and below, and each setting's ✕ is 25 × 28px,
    // reaching only the 4px gap toward its words.
    expect(opener()).toHaveClass('before:absolute', 'before:-inset-y-[5px]');
    expect(resetX()).toHaveClass('before:absolute', 'before:-inset-x-[6px]', 'before:-inset-y-[5px]');
    expect(removeXs()).toHaveLength(2);
    for (const x of removeXs()) {
      expect(x).toHaveClass('w-3.5', 'before:absolute', 'before:-left-1', 'before:-right-[7px]', 'before:-inset-y-[5px]');
    }
  });

  it('comes after the review notice while one is owed, so the date keeps its cluster', () => {
    resetNoticeAnchors();
    seed({ canvasGroupBy: 'project' }, { selectedDate: new Date() });
    useEODStore.setState({
      _hasHydrated: true,
      eodReviewEnabled: true,
      eodReviewTime: '00:00',
      lastEodReviewDate: null,
      eodDeferredDate: null,
    });
    try {
      renderPhoneHeader();

      const card = shelf().parentElement!;
      const notice = screen.getByTestId('notice-slot');
      expect(card).toContainElement(notice);
      expect(card.lastElementChild).toBe(shelf());
      expect(shelf().previousElementSibling).toBe(notice);
    } finally {
      useEODStore.setState({ eodReviewEnabled: false, _hasHydrated: false });
    }
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

  it('comes and goes with the tab, with its hooks above the early return', async () => {
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
    fireEvent.click(opener());
    expect(await screen.findByTestId('display-menu')).toBeInTheDocument();
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

  it('resets from the sheet its text opens, and focus lands on the icon trigger', async () => {
    touch.current = true;
    seed({ canvasGroupBy: 'project', canvasFilters: filters({ hideFinished: true }) });
    renderPhoneHeader();

    fireEvent.click(opener());
    fireEvent.click(within(screen.getByTestId('display-menu')).getByTestId('display-reset'));

    expect(queryShelf()).toBeNull();
    expect(useViewStore.getState().canvasGroupBy).toBe('none');
    await finishExit();
    // Through the card's [&>button] wrapper, to the icon trigger itself.
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it.each([
    { name: 'the last setting’s ✕', view: { canvasGroupBy: 'project' } as ViewSeed, x: () => removeXs()[0] },
    {
      name: 'the reset ✕',
      view: { canvasGroupBy: 'project', canvasSortBy: 'title' } as ViewSeed,
      x: () => resetX(),
    },
  ])('hands focus to the icon trigger when $name takes the shelf away', ({ view, x }) => {
    touch.current = true;
    seed(view);
    renderPhoneHeader();
    const pressed = x();
    pressed.focus();

    fireEvent.click(pressed);

    expect(queryShelf()).toBeNull();
    // Through the card's [&>button] wrapper, to the icon trigger itself, not <body>.
    expect(document.activeElement).toBe(trigger());
  });

  it('takes one canvas value off with its own ✕, hands focus on, and leaves the braindump alone', () => {
    touch.current = true;
    seed({
      canvasFilters: filters({ priorities: ['high', 'low'] }),
      braindumpFilters: filters({ priorities: ['high'] }),
    });
    renderPhoneHeader();
    const high = removeXs().find((x) => x.getAttribute('aria-label') === 'Remove Priority: High')!;
    high.focus();

    fireEvent.click(high);

    expect(useViewStore.getState().canvasFilters.priorities).toEqual(['low']);
    expect(useViewStore.getState().braindumpFilters.priorities).toEqual(['high']);
    expect(document.activeElement).toHaveAccessibleName('Remove Priority: Low');
  });

  it('keeps 5px between the rows a line or a list wraps into, the reach each ✕ takes', () => {
    // With none, a ✕'s reach lay over the next row's words, and a tap on a
    // name took a different setting off.
    seed({ canvasFilters: filters({ containers: ['project:Work', 'project:Home'] }) });
    renderPhoneHeader();
    const lines = shelf().querySelector('[data-shelf-lines]')!;
    expect(lines).toHaveClass('[&_[data-clause]]:gap-y-[5px]', '[&_[data-line]]:gap-y-[5px]');
  });

  it('has nothing that can fade a lime glyph between it and the header', () => {
    seed(...LIME_SEED);
    renderPhoneHeader();
    expectNothingFadesLime(shelf().closest('header')!);
  });
});
