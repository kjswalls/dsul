import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react';

/**
 * The Display shelf on the canvas: under the view pill in the desktop header
 * capsule, and at the foot of the phone's Today card.
 *
 * The shelf itself — what it says, how it wraps, how its opener hands focus
 * around — is pinned through the braindump in display-shelf.test.tsx, and the
 * words through display-summary.test.ts. What can go wrong HERE is the mount:
 * a capsule that forgets the menu's ref (the text then opens nothing, and the ✕
 * drops focus on <body>), a shelf that is not contained (the capsule grows to
 * the paragraph's whole line and the paragraph never wraps), a mount with the
 * other device's targets (✕s drawn at rest under the pill, or a phone's ✕s
 * waiting on a hover it can never do), a phone mount whose hook sits below the
 * Today-only early return, or a shelf reading the braindump's settings. So can
 * the type filter, the one setting only the canvas has, which the braindump's
 * suite never meets. Each case below goes through the real HeaderCapsule or
 * MobileHeader.
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
import { EMPTY_VIEW_FILTERS, NO_PRIORITY, type ViewFilters } from '@/lib/filters';
import type { Goal } from '@/lib/planner-types';
import { useEODStore } from '@/lib/eod-store';
import { resetNoticeAnchors } from '@/lib/notice-anchors';
import { enableGoalsAndOrganize } from './support/extensions';

/** jsdom has no pointer capture, which Radix's menus ask for on the way open. */
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
/** Reset display: the menu row's own glyph at the end of the paragraph, not one more ✕. */
const resetButton = () => screen.getByTestId('display-shelf-reset-canvas');
const queryReset = () => screen.queryByTestId('display-shelf-reset-canvas');
/** Every setting's ✕, one per phrase and one per value, in reading order; Reset is not one. */
const removeXs = () => screen.queryAllByTestId('display-shelf-remove-canvas');
const trigger = () => screen.getByTestId('display-trigger-canvas');

/**
 * Four ✕s between the settings, the fewest Reset shows for, ending the
 * paragraph in each of the two ways it can: with a filter's run of values,
 * which Reset joins as the run's last item, and with a phrase, which Reset is
 * held to. The phrase ending has the type filter in it, which only the canvas
 * has.
 */
const FOUR_ENDING_IN_A_FILTER: ViewSeed = {
  canvasGroupBy: 'project',
  canvasSortBy: 'title',
  canvasFilters: filters({ priorities: ['high', 'low'] }),
};
const FOUR_ENDING_IN_A_PHRASE: ViewSeed = {
  canvasGroupBy: 'project',
  canvasSortBy: 'title',
  typeFilter: 'tasks',
  canvasFilters: filters({ hideFinished: true }),
};

/**
 * Reset ends the paragraph, the last thing in the last setting, wearing the
 * menu row's glyph. After a filter it is the run's own last item, so it wraps
 * alone rather than take the last value with it; after a phrase it is held to
 * that phrase, one unbreakable pair, so it never takes a line alone. Either
 * way it sits outside every setting's own target, so hovering it neither
 * lights a setting's words nor draws their ✕.
 */
function expectResetLast(ending: 'filter' | 'phrase') {
  const settings = shelf().querySelectorAll('[data-clause]');
  const last = settings[settings.length - 1];
  /** Every phrase and value as the pointer meets it: the span around its words and its ✕. */
  const units = Array.from(shelf().querySelectorAll('[data-chip-label]'), (words) => words.parentElement!);
  const slot = resetButton().parentElement!;
  if (ending === 'filter') {
    expect(slot.parentElement).toBe(last);
    expect(last.lastElementChild).toBe(slot);
  } else {
    const pair = slot.parentElement!;
    expect(pair.parentElement).toBe(last);
    expect(pair.children).toHaveLength(2);
    expect(pair.firstElementChild).toBe(units.at(-1));
    expect(pair.lastElementChild).toBe(slot);
  }
  expect(units.some((unit) => unit.contains(resetButton()))).toBe(false);
  const buttons = shelf().querySelectorAll('button');
  expect(buttons[buttons.length - 1]).toBe(resetButton());
  expect(resetButton().querySelector('svg')).toHaveClass('lucide-rotate-ccw');
}

/** A phrase and two filters, so the paragraph and two runs of values can each wrap. */
const TWO_RUNS: ViewSeed = {
  canvasGroupBy: 'project',
  canvasFilters: filters({ priorities: ['high', 'low'], containers: ['project:Work', 'project:Home'] }),
};

/**
 * 5px between the rows the paragraph wraps into, and between the rows a
 * filter's values wrap into: the reach a ✕ takes above and below itself
 * wherever one is in flow. With none, a ✕'s reach lay over the next row's
 * words, and a tap on a name took a different setting off.
 */
function expectFiveBetweenRows() {
  expect(shelf().querySelector('[data-shelf-lines]')).toHaveClass('flex-wrap', 'gap-y-[5px]');
  const runs = shelf().querySelectorAll('[data-clause="priority"], [data-clause="project"]');
  expect(runs).toHaveLength(2);
  for (const run of runs) expect(run).toHaveClass('flex-wrap', 'gap-y-[5px]');
}

/**
 * The Low dot is --priority-low and this project's square --accent-8, both
 * lime, drawn at rest as data glyphs — which is only allowed while nothing
 * between them and the surface can fade them. The braindump's mount is walked
 * the same way in display-shelf.test.tsx; each mount has its own ancestors,
 * and each canvas mount merges a className of its own onto the shelf's root,
 * which the braindump's does not.
 */
const LIME_SEED: [ViewSeed, PlannerSeed] = [
  { canvasFilters: filters({ priorities: ['low'], containers: ['project:Wind-down'] }) },
  { projects: [{ id: 'p9', name: 'Wind-down', emoji: '🌙', color: 'var(--accent-8)' }] },
];

/**
 * A class that can take a glyph below full strength, at rest or during a
 * change: any opacity (behind a variant too), a transition that carries one
 * (the bare utility and -all do; -colors and -transform do not), or any
 * animation (tw-animate-css's fade-in starts from 0).
 */
const CAN_FADE = /opacity|(^|[\s:])(transition(-all)?(\s|$)|animate-|fade-)/;

function expectNothingFadesLime(surface: Element) {
  const lime = [...shelf().querySelectorAll<HTMLElement>('[style]')].filter((el) =>
    /var\(--priority-low\)|var\(--accent-8\)/.test(el.getAttribute('style') ?? '')
  );
  expect(lime).toHaveLength(2);
  for (const glyph of lime) {
    let node: HTMLElement | null = glyph;
    while (node) {
      expect(node.getAttribute('class') ?? '').not.toMatch(CAN_FADE);
      expect(node.style.opacity).toBe('');
      if (node === surface) break;
      node = node.parentElement;
    }
    expect(node).toBe(surface);
  }
  // Nor does anything in the shelf fade or animate at all, its root included:
  // the root is where the mount's own classes land.
  for (const el of [shelf(), ...shelf().querySelectorAll('*')]) {
    expect(el.getAttribute('class') ?? '').not.toMatch(/opacity|transition|animate-|fade-/);
  }
}

/**
 * Every layout read made from here until `stop`, for a case to ask which of
 * them landed on the shelf: a box's size or place on either axis, its rects,
 * or its computed style. jsdom answers each one with 0 or an empty value, so a
 * shelf that measured would still render; the reads themselves are the
 * evidence. The braindump's suite watches the same reads.
 */
function watchLayoutReads() {
  const getters = [
    vi.spyOn(Element.prototype, 'getBoundingClientRect'),
    vi.spyOn(Element.prototype, 'getClientRects'),
    vi.spyOn(Element.prototype, 'clientWidth', 'get'),
    vi.spyOn(Element.prototype, 'clientHeight', 'get'),
    vi.spyOn(Element.prototype, 'scrollWidth', 'get'),
    vi.spyOn(Element.prototype, 'scrollHeight', 'get'),
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get'),
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get'),
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get'),
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get'),
  ];
  // Called with the element rather than on it, so it is the argument that says where.
  const styles = vi.spyOn(window, 'getComputedStyle');
  return {
    readsIn: (root: Element) =>
      [...getters.flatMap((s) => s.mock.contexts as unknown[]), ...styles.mock.calls.map(([el]) => el)].filter(
        (el) => el instanceof Element && root.contains(el)
      ),
    stop: () => [...getters, styles].forEach((s) => s.mockRestore()),
  };
}

/**
 * Past anything a measure could be put off to: two frames, then a task. The
 * measured shelf compared its widths a frame after a resize, and measured
 * again once the fonts were in.
 */
async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
    // Four ✕s, so Reset is drawn after the settings' own.
    seed(FOUR_ENDING_IN_A_FILTER);
    const { container } = renderCapsule();
    const capsule = container.firstElementChild!;

    // Date row, pill, shelf — and only the shelf is new: at rest the capsule
    // keeps its two rows and its gap adds nothing.
    expect(capsule.children).toHaveLength(3);
    expect(capsule.lastElementChild).toBe(shelf());
    expect(capsule.children[1]).toContainElement(trigger());

    // The capsule is sized by its content; without containment it would grow to
    // the paragraph's whole line and the paragraph would never wrap.
    expect(shelf()).toHaveClass('contain-inline-size', 'px-4', 'pr-3.5', 'pt-1', 'pb-px');
    // One class to an assertion: a negated toHaveClass with several passes as
    // soon as any one of them is gone.
    expect(shelf()).not.toHaveClass('px-[15px]');
    expect(shelf()).not.toHaveClass('pt-2');
    expect(shelf()).not.toHaveClass('pb-[3px]');
    // The width floor is the sidebar's, for its fold; the capsule has none.
    expect(shelf().style.minWidth).toBe('');
    // A pointer's targets: no reach past the text, Reset or any ✕…
    expect(opener()).not.toHaveClass('before:absolute');
    expect(resetButton()).not.toHaveClass('before:absolute');
    expect(removeXs()).toHaveLength(4);
    for (const x of removeXs()) expect(x).not.toHaveClass('before:absolute');
    // …until the pointer is coarse (a tablet on this shell), which never
    // hovers: the stylesheet gives it the phone's 28px, with no render to wait
    // for, so it never paints a frame of the pointer's targets first.
    expect(opener()).toHaveClass('pointer-coarse:before:absolute', 'pointer-coarse:before:-inset-y-[5px]');
    expect(resetButton()).toHaveClass(
      'pointer-coarse:relative',
      'pointer-coarse:before:absolute',
      'pointer-coarse:before:-inset-x-[6px]',
      'pointer-coarse:before:-inset-y-[5px]'
    );
  });

  it.each([
    { name: 'two phrases and a filter’s two values', view: FOUR_ENDING_IN_A_FILTER },
    { name: 'four phrases, the type filter among them', view: FOUR_ENDING_IN_A_PHRASE },
  ])('draws a ✕ only under the pointer or with keyboard focus, and takes no click till then: $name', ({ view }) => {
    seed(view);
    renderCapsule();
    expect(removeXs()).toHaveLength(4);

    for (const x of removeXs()) {
      // Beside its words, in its own setting's target: the hover that draws it
      // is its own setting's, and no other's. The target takes the pointer
      // itself, as the paragraph around it does not, or nothing ever hovers
      // it; and it is the box the ✕ is placed against, or every ✕ is placed
      // against the paragraph instead of beside its own words.
      expect(x.parentElement).toHaveClass('group/unit', 'relative', 'pointer-events-auto');
      expect(x.previousElementSibling).toHaveAttribute('data-chip-label');
      // At rest the paragraph is words alone. The ✕ is in the gap after its
      // words, out of flow, in clear ink and not there to hit: the gap is the
      // text's ground, so a click aimed between two settings opens the menu,
      // and can never land on a ✕ that was not drawn when the pointer got there.
      expect(x).toHaveClass('absolute', 'left-full', 'top-0', 'text-transparent', 'pointer-events-none');
      expect(x).not.toHaveClass('text-muted-foreground');
      expect(x).not.toHaveClass('pointer-events-auto');
      expect(x).not.toHaveClass('relative');
      // Its setting under the pointer, or keyboard focus on the ✕ itself,
      // draws it and lets it take the click.
      expect(x).toHaveClass(
        'group-hover/unit:text-muted-foreground',
        'group-hover/unit:pointer-events-auto',
        'focus-visible:text-muted-foreground',
        'focus-visible:pointer-events-auto'
      );
      // A coarse pointer never hovers, so there the ✕ is the phone's: drawn,
      // in flow 4px after its words, with the phone's 25 × 28px reach.
      expect(x).toHaveClass(
        'pointer-coarse:relative',
        'pointer-coarse:left-auto',
        'pointer-coarse:top-auto',
        'pointer-coarse:ml-[4px]',
        'pointer-coarse:text-muted-foreground',
        'pointer-coarse:pointer-events-auto',
        'pointer-coarse:before:absolute',
        'pointer-coarse:before:-left-[4px]',
        'pointer-coarse:before:-right-[7px]',
        'pointer-coarse:before:-inset-y-[5px]'
      );
    }
  });

  it("measures nothing: no observer, no layout read, no font wait, no fit written behind React's back", async () => {
    // jsdom has no ResizeObserver, and a shelf that guarded its own would make
    // none here whatever it made in a browser, so one is put in that records
    // every observer made and what each was asked to watch. Nor has it
    // document.fonts, which the measured shelf waited on before measuring
    // again, so one is put in that counts its reads.
    const made: Element[][] = [];
    class RecordingResizeObserver {
      private readonly watched: Element[] = [];
      constructor() {
        made.push(this.watched);
      }
      observe(el: Element) {
        this.watched.push(el);
      }
      unobserve() {}
      disconnect() {}
    }
    const real = globalThis.ResizeObserver;
    globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver;
    let fontReads = 0;
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      get: () => {
        fontReads += 1;
        return { ready: Promise.resolve() };
      },
    });
    try {
      // Nothing set at first, so the shelf arrives in a capsule that has
      // already made whatever it makes of its own, and its share is whatever
      // is made beyond that.
      renderCapsule();
      expect(queryShelf()).toBeNull();
      const atRest = { observers: made.length, fontReads };
      const reads = watchLayoutReads();
      try {
        act(() => useViewStore.setState(FOUR_ENDING_IN_A_FILTER));
        expect(shelf()).toBeInTheDocument();
        // And a change of text, on which a fit would measure again.
        act(() =>
          useViewStore.setState({ canvasFilters: filters({ priorities: ['high', 'medium', 'low'] }) })
        );
        expect(removeXs()).toHaveLength(5);
        // Nor a frame or a task later, where a measure put off would land.
        await settle();

        // No observer past the capsule's own, none watching the shelf, no
        // layout read off anything in it, and no wait on a font.
        expect(made).toHaveLength(atRest.observers);
        for (const watched of made) for (const el of watched) expect(shelf().contains(el)).toBe(false);
        expect(reads.readsIn(shelf())).toEqual([]);
        expect(fontReads).toBe(atRest.fontReads);
      } finally {
        reads.stop();
      }
      // Plain CSS wrapping: no fit written on any node behind React's back,
      // and nothing drawn only to be measured.
      expect(document.querySelector('[data-fit]')).toBeNull();
      expect(shelf().querySelector('[data-line], [data-shelf-probe], [data-shelf-sample]')).toBeNull();
    } finally {
      if (real) globalThis.ResizeObserver = real;
      else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      delete (document as { fonts?: unknown }).fonts;
    }
  });

  // The type filter is the canvas's alone, so the braindump's seam cases in
  // display-shelf.test.tsx never meet it. It is a phrase: a seam sets it apart
  // from a filter after it, as it does any setting, and only the plain gap
  // from a phrase on either side.
  it.each([
    { name: 'between two phrases', view: FOUR_ENDING_IN_A_PHRASE, seams: [] },
    {
      name: 'before a filter',
      view: { canvasSortBy: 'title', typeFilter: 'tasks', canvasFilters: filters({ priorities: ['high'] }) },
      seams: ['type'],
    },
  ] satisfies { name: string; view: ViewSeed; seams: string[] }[])(
    'reads the type filter as a phrase, with a seam only where it meets a filter: $name',
    ({ view, seams }) => {
      seed(view);
      renderCapsule();
      const settings = Array.from(shelf().querySelectorAll('[data-clause]'));
      expect(settings.map((c) => c.getAttribute('data-clause'))).toContain('type');
      const seamed = settings.filter((c) => c.classList.contains('mr-[8px]'));
      expect(seamed.map((c) => c.getAttribute('data-clause'))).toEqual(seams);
      for (const c of seamed) expect(c).toHaveClass('shrink-0');
    }
  );

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

  it.each([
    { name: 'a phrase', words: () => shelf().querySelector('[data-clause="group"] [data-chip-label]')! },
    { name: 'a value', words: () => shelf().querySelector('[data-value="high"] [data-chip-label]')! },
  ])('opens the canvas menu from the words of $name, and Escape brings focus back to the text', async ({ words }) => {
    // Each setting takes the pointer for its ✕, so a click on its words lands
    // on it rather than on the text underneath, and must open what the text does.
    seed({ canvasGroupBy: 'project', canvasFilters: filters({ priorities: ['high', 'low'] }) });
    renderCapsule();

    fireEvent.click(words());

    // The label trigger's own dropdown, through the same handle as the text.
    const menu = await screen.findByTestId('display-menu');
    expect(menu).toHaveAttribute('data-display-variant', 'menu');
    expect(screen.getAllByTestId('display-trigger-canvas')).toHaveLength(1);

    // Handed the text to come back to, which is on screen to take it.
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(opener()));
  });

  it('keeps a ✕’s click for the ✕: its value goes, and the words around it open nothing', () => {
    seed({ canvasGroupBy: 'project', canvasFilters: filters({ priorities: ['high', 'low'] }) });
    renderCapsule();
    const low = removeXs().find((x) => x.getAttribute('aria-label') === 'Remove Priority: Low')!;

    fireEvent.click(low);

    expect(useViewStore.getState().canvasFilters.priorities).toEqual(['high']);
    // The ✕ sits inside its value's target, whose click opens the menu, and the
    // menu opens within the click that asks for it.
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('display-menu')).toBeNull();
  });

  it('Reset leaves the stores exactly as the menu’s Reset row does, and the braindump alone', async () => {
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
    fireEvent.click(resetButton());

    expect(snapshot()).toEqual(byMenu);
    expect(snapshot().braindumpGroupBy).toBe('project');
    expect(snapshot().braindumpFilters).toEqual(filters({ priorities: ['low'] }));
  });

  it('hands focus to the Display trigger before the reset takes the shelf away', () => {
    seed(FOUR_ENDING_IN_A_FILTER);
    renderCapsule();
    // BEFORE: React batches the reset's re-render past the handler either
    // way, so only what the trigger sees as focus lands can tell the order.
    let setWhenFocused: string | null = null;
    trigger().addEventListener('focus', () => {
      setWhenFocused = useViewStore.getState().canvasGroupBy;
    });
    resetButton().focus();

    fireEvent.click(resetButton());

    expect(queryShelf()).toBeNull();
    // Not <body>, where a focused button that unmounts leaves it — which is
    // where it would go if the capsule forgot to hand the shelf the menu's ref.
    expect(document.activeElement).toBe(trigger());
    expect(setWhenFocused).toBe('project');
    // And the press was Reset's alone: no menu came up behind it.
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
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

  it('draws Reset only while the settings wear more than three ✕s between them', () => {
    // Up to three, the ✕s and the menu's row already clear the lot in as many
    // clicks, and the glyph would only cost the line its room. It counts ✕s,
    // not settings.
    seed({ canvasGroupBy: 'project' });
    renderCapsule();
    expect(removeXs()).toHaveLength(1);
    expect(queryReset()).toBeNull();

    // Still one setting, but two values, and so two ✕s.
    act(() =>
      useViewStore.setState({
        canvasGroupBy: 'none',
        canvasFilters: filters({ priorities: ['high', 'low'] }),
      })
    );
    expect(removeXs()).toHaveLength(2);
    expect(queryReset()).toBeNull();

    // Three settings, three ✕s.
    act(() =>
      useViewStore.setState({
        canvasGroupBy: 'project',
        canvasSortBy: 'title',
        typeFilter: 'tasks',
        canvasFilters: EMPTY_VIEW_FILTERS,
      })
    );
    expect(removeXs()).toHaveLength(3);
    expect(queryReset()).toBeNull();

    // One setting again, with four values: four ✕s, and Reset is the last of
    // the run.
    act(() =>
      useViewStore.setState({
        canvasGroupBy: 'none',
        canvasSortBy: 'default',
        typeFilter: 'all',
        canvasFilters: filters({ priorities: ['high', 'medium', 'low', NO_PRIORITY] }),
      })
    );
    expect(removeXs()).toHaveLength(4);
    expectResetLast('filter');

    // Four phrases, and Reset is held to the last of them.
    act(() => useViewStore.setState(FOUR_ENDING_IN_A_PHRASE));
    expect(removeXs()).toHaveLength(4);
    expectResetLast('phrase');

    // And it goes with the fourth ✕.
    fireEvent.click(removeXs()[0]);
    expect(removeXs()).toHaveLength(3);
    expect(queryReset()).toBeNull();
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
    { name: 'Reset', x: () => resetButton(), tip: 'Reset display' },
    { name: 'a setting’s ✕', x: () => removeXs()[0], tip: 'Remove' },
  ])('names $name in a tooltip on a pointer, and never with a native title', async ({ x, tip }) => {
    seed(FOUR_ENDING_IN_A_FILTER);
    renderCapsule();
    expect(x()).not.toHaveAttribute('title');

    fireEvent.pointerEnter(x());
    fireEvent.pointerMove(x());
    expect(await screen.findByRole('tooltip')).toHaveTextContent(tip);
  });

  /**
   * Where the paragraph wraps, a tip hangs over the line below, and moving
   * down to press something there pressed the tip instead. jsdom applies no
   * stylesheet, so this pins the two halves the click depends on: the
   * attribute on each tip, and the rule in globals.css that lets the click
   * through the wrapper Radix positions the tip in, matched against the
   * wrapper actually drawn.
   */
  const PASS_THROUGH = '[data-radix-popper-content-wrapper]:has(> [data-pass-through])';

  it.each([
    { name: 'Reset', x: () => resetButton() },
    { name: 'a setting’s ✕', x: () => removeXs()[0] },
  ])('lets a click through the tip of $name to whatever the tip covers', async ({ x }) => {
    seed(FOUR_ENDING_IN_A_FILTER);
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

  it('keeps the phone’s 5px between the rows its paragraph or a filter wraps into', () => {
    // Lines are 5px apart whatever the pointer. A coarse one on this shell
    // puts every ✕ in flow with the phone's reach, and the stylesheet decides
    // that with no render to add a class, so the room for the reach has to be
    // there already.
    seed(TWO_RUNS);
    renderCapsule();
    expectFiveBetweenRows();
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
    // Four ✕s, so Reset is drawn after the settings' own.
    seed(FOUR_ENDING_IN_A_PHRASE);
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
    // Reset reach 5px above and below, and each setting's ✕ is 25 × 28px,
    // reaching only the 4px gap toward its words.
    expect(opener()).toHaveClass('before:absolute', 'before:-inset-y-[5px]');
    expect(resetButton()).toHaveClass(
      'relative',
      'before:absolute',
      'before:-inset-x-[6px]',
      'before:-inset-y-[5px]'
    );
    expect(removeXs()).toHaveLength(4);
    for (const x of removeXs()) {
      expect(x).toHaveClass(
        'w-[14px]',
        'before:absolute',
        'before:-left-[4px]',
        'before:-right-[7px]',
        'before:-inset-y-[5px]'
      );
      // Nothing hovers on a phone, so no ✕ waits for it: each is drawn at
      // rest, in flow 4px after its words, and takes the tap.
      expect(x).toHaveClass('relative', 'ml-[4px]', 'text-muted-foreground', 'pointer-events-auto');
      expect(x).not.toHaveClass('absolute');
      expect(x).not.toHaveClass('text-transparent');
      expect(x).not.toHaveClass('pointer-events-none');
    }
    // Nor do the words take ink from a hover or from their ✕'s focus. Under a
    // pointer that ink says which setting a ✕ that shows only on hover will
    // take off; here every ✕ is drawn beside its words already.
    for (const el of shelf().querySelectorAll('*')) {
      expect(el.getAttribute('class') ?? '').not.toMatch(/(^|\s)group-(hover|has-\[:focus-visible\])\//);
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
    { name: 'Reset', view: FOUR_ENDING_IN_A_PHRASE, x: () => resetButton() },
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

  it('keeps 5px between the rows its paragraph or a filter wraps into, the reach each ✕ takes', () => {
    seed(TWO_RUNS);
    renderPhoneHeader();
    expectFiveBetweenRows();
  });

  it('has nothing that can fade a lime glyph between it and the header', () => {
    seed(...LIME_SEED);
    renderPhoneHeader();
    expectNothingFadesLime(shelf().closest('header')!);
  });
});
