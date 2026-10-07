import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, cleanup, fireEvent } from '@testing-library/react';

/**
 * The Goals extension's gate — what "off" costs, and what it must never cost.
 *
 * Two obligations, and this file exists because they pull in opposite
 * directions. A gate that does too little leaves the feature acting while the
 * user has switched it off; a gate that does too much either takes the
 * extension out of the catalogue (so it can never be switched back on) or —
 * far worse here — takes a user's WORK off the screen with it.
 *
 * The second is the sharp one for goals specifically. Goals are an `aspire`
 * container (lib/container-registry.ts): membership switches nothing, so a goal
 * hides no item when it is ON, and the gate must not become the one thing about
 * goals that can hide an item. Every case in "no item disappears" is a check on
 * that, and the stranded-filter case is the exact shape it would take: a Goal
 * filter left set by the switch, resolving to an empty set instead of to
 * "cannot narrow", would empty the canvas with nothing on screen to say why.
 *
 * See lib/extension-gates.ts for what inert means per surface.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchHabitGroups: vi.fn(async () => []),
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
  createHabitGroup: vi.fn(async () => {}),
  updateHabitGroup: vi.fn(async () => {}),
  deleteHabitGroup: vi.fn(async () => {}),
  restoreHabitGroup: vi.fn(async () => {}),
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
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

/** The goal page reads useParams and pushes with useRouter. */
const routeParams = vi.hoisted(() => ({ current: { id: 'g1' } as Record<string, string> }));
vi.mock('next/navigation', () => ({
  useParams: () => routeParams.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/goal/g1',
  useSearchParams: () => new URLSearchParams(),
}));

import GoalPage from '@/app/goal/[id]/page';
import { DisplayMenu } from '@/components/primitives/display-menu';
import { TaskRow, type RowItem } from '@/components/primitives/task-row';
import { chatTransport } from '@/lib/chat-transport';
import { configureConversations, conversationsSettled, useConversationsStore } from '@/lib/conversations-store';
import { fakeApi } from './helpers/conversations-fakes';
import { seedAI, OPENCLAW_PLUGIN } from './helpers/ai-fixtures';
import { useDayItemsForDates } from '@/hooks/use-day-items';
import {
  extensionEnabled,
  groupByOptionsFor,
  resolvedCanvasGroupBy,
  useCanvasGroupBy,
  useGoalFilterIds,
} from '@/lib/extension-gates';
import { CANVAS_GROUP_BY_OPTIONS } from '@/lib/view-options';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import {
  EXT_GOALS,
  OFFICIAL_EXTENSIONS,
  extensionManifest,
  resolveEnabled,
} from '@/lib/extension-registry';
import {
  ALL_PANES,
  extensionPaneId,
  isPaneId,
  settingsForPane,
  DESTINATIONS,
} from '@/lib/settings/manifest';
import {
  STATIC_COMMANDS,
  findCommand,
  isAvailable,
  resolveCommands,
  type CommandContext,
} from '@/lib/commands';
import { enableExtensions, disableExtensions } from './support/extensions';
import type { DayItems } from '@/lib/day-items';
import type { Goal, Item } from '@/lib/planner-types';

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

const ctx: CommandContext = {
  theme: { resolved: 'light', value: 'light', set: () => {} },
  openChat: () => {},
  userId: 'user-1',
  isMobile: false,
};

const DAY = [new Date('2026-07-15T12:00:00Z')];

const MEMBER: Item = {
  type: 'task',
  id: 't-member',
  title: 'Study characters',
  status: 'pending',
  isScheduled: false,
  order: 0,
  startDate: '2026-07-15',
  timeBucket: 'morning',
} as unknown as Item;

const OUTSIDER: Item = {
  type: 'task',
  id: 't-outsider',
  title: 'Unrelated errand',
  status: 'pending',
  isScheduled: false,
  order: 1,
  startDate: '2026-07-15',
  timeBucket: 'morning',
} as unknown as Item;

const GOAL: Goal = {
  id: 'g1',
  name: 'Learn Chinese',
  state: 'active',
  memberIds: ['t-member'],
  milestoneIds: [],
  checkinIds: [],
} as unknown as Goal;

/** Every id a column shows, whatever bucket or kind it landed in. */
const idsOf = (d: DayItems): string[] => [
  ...Object.values(d.tasksByBucket).flat().map((t) => t.id),
  ...Object.values(d.habitsByBucket).flat().map((h) => h.id),
];

function seed({ goalFilter = false }: { goalFilter?: boolean } = {}) {
  const items = [MEMBER, OUTSIDER];
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: 'UTC',
    isLoading: false,
    selectedDate: DAY[0],
    items,
    tasks: items as never,
    habits: [] as never,
    projects: [],
    habitGroups: [],
    routines: [],
    seasons: [],
    goals: [GOAL],
    goalsAvailable: true,
    showCompletedTasks: true,
    showPausedOnGrid: false,
  } as never);
  useViewStore.setState({
    scope: 'day',
    layout: 'list',
    typeFilter: 'all',
    canvasGroupBy: 'none',
    braindumpGroupBy: 'none',
    canvasSortBy: 'default',
    braindumpSortBy: 'default',
    canvasFilters: goalFilter ? { ...EMPTY_VIEW_FILTERS, goals: ['g1'] } : EMPTY_VIEW_FILTERS,
    braindumpFilters: EMPTY_VIEW_FILTERS,
  });
}

const day = () => renderHook(() => useDayItemsForDates(DAY)).result.current[0];

/** Radix's DropdownMenuTrigger opens on pointerdown, not click. */
const openMenu = () =>
  fireEvent.pointerDown(screen.getByTestId('display-trigger-canvas'), {
    button: 0,
    ctrlKey: false,
  });

beforeEach(() => {
  useExtensionsStore.setState({ enabled: {} });
  seed();
});
afterEach(cleanup);

/* ── it must stop ACTING ───────────────────────────────────────────────────*/

describe('Goals switched off — the behaviour stops', () => {
  it('does not offer the Goal filter section', async () => {
    disableExtensions(EXT_GOALS);
    render(<DisplayMenu surface="canvas" />);
    openMenu();

    expect(await screen.findByRole('menuitem', { name: /Priority/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /^Goal/ })).toBeNull();
  });

  it('does not offer Goal as a grouping value', async () => {
    disableExtensions(EXT_GOALS);
    render(<DisplayMenu surface="canvas" />);
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Grouping/ }));

    // The neighbouring values are still there, so this is the Goal row missing
    // rather than the submenu failing to open.
    expect(await screen.findByRole('menuitemradio', { name: /Project/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: /Goal/ })).toBeNull();
  });

  it('resolves a stored "group by goal" to none, without rewriting the store', () => {
    useViewStore.setState({ canvasGroupBy: 'goal' });

    disableExtensions(EXT_GOALS);
    expect(renderHook(() => useCanvasGroupBy()).result.current).toBe('none');
    // The user's choice survives the switch — flipping it back restores the
    // grouping rather than silently leaving them on 'none'.
    expect(useViewStore.getState().canvasGroupBy).toBe('goal');

    cleanup();
    enableExtensions(EXT_GOALS);
    expect(renderHook(() => useCanvasGroupBy()).result.current).toBe('goal');
  });

  it('stops resolving goal membership for the canvas', () => {
    seed({ goalFilter: true });

    disableExtensions(EXT_GOALS);
    expect(renderHook(() => useGoalFilterIds([GOAL], ['g1'])).result.current).toBeNull();

    cleanup();
    enableExtensions(EXT_GOALS);
    expect([...(renderHook(() => useGoalFilterIds([GOAL], ['g1'])).result.current ?? [])]).toEqual([
      't-member',
    ]);
  });

  it('says the extension is off on /goal/[id], rather than "not found"', () => {
    disableExtensions(EXT_GOALS);
    render(<GoalPage />);

    expect(screen.getByTestId('goal-page-extension-off')).toBeInTheDocument();
    // Not the not-found state — the goal is right there in the store, and
    // telling the user it is gone would be a lie about their data.
    expect(screen.queryByText('Goal not found')).toBeNull();
    expect(screen.queryByText('Learn Chinese')).toBeNull();
  });

  it('withdraws the per-goal palette rows, which are data rather than catalogue', () => {
    disableExtensions(EXT_GOALS);
    expect(resolveCommands(ctx).some((c) => c.id === 'goal.open.g1')).toBe(false);

    enableExtensions(EXT_GOALS);
    expect(resolveCommands(ctx).some((c) => c.id === 'goal.open.g1')).toBe(true);
  });
});

/* ── it must not take anyone's WORK with it ────────────────────────────────*/

describe('Goals switched off — no item disappears', () => {
  it('shows every item it showed before, with no goal clause set', () => {
    enableExtensions(EXT_GOALS);
    const on = idsOf(day()).sort();
    cleanup();

    disableExtensions(EXT_GOALS);
    const off = idsOf(day()).sort();

    expect(off).toEqual(on);
    expect(off).toEqual(['t-member', 't-outsider']);
  });

  it('goes INERT on a stranded goal filter rather than emptying the surface', () => {
    // The failure this whole gate is written around. With Goals on, the clause
    // narrows to the goal's one member; with Goals off it must narrow NOTHING —
    // not narrow to zero, which would blank the canvas with no row left in the
    // Display menu to explain or clear it.
    seed({ goalFilter: true });

    enableExtensions(EXT_GOALS);
    expect(idsOf(day())).toEqual(['t-member']);
    cleanup();

    disableExtensions(EXT_GOALS);
    expect(idsOf(day()).sort()).toEqual(['t-member', 't-outsider']);
    // And the selection is still on disk, so switching back on restores it
    // rather than making the user rebuild the filter.
    expect(useViewStore.getState().canvasFilters.goals).toEqual(['g1']);
  });

  it('leaves goals, memberships and roles untouched — off writes nothing', () => {
    seed({ goalFilter: true });
    disableExtensions(EXT_GOALS);
    day();
    render(<DisplayMenu surface="canvas" />);
    openMenu();

    expect(usePlannerStore.getState().goals).toEqual([GOAL]);
    expect(usePlannerStore.getState().items.map((i) => i.id)).toEqual([
      't-member',
      't-outsider',
    ]);
  });

  it('does not count the stranded clause in the trigger, which has no row for it', () => {
    seed({ goalFilter: true });

    disableExtensions(EXT_GOALS);
    render(<DisplayMenu surface="canvas" />);
    // A count with no row behind it is the "Display (1 active)" over an empty
    // panel that lib/view-options.ts already argues against for a stranded
    // group-by. Same rule, same reason.
    expect(screen.getByTestId('display-trigger-canvas')).toHaveAttribute(
      'aria-label',
      'Display'
    );
    expect(screen.getByTestId('display-trigger-canvas')).toHaveAttribute(
      'data-active',
      'false'
    );
  });
});

/* ── the reads that must NEVER be gated ────────────────────────────────────*/

describe('Goals switched off — the milestone protection stays on', () => {
  /**
   * The most important test on the branch, and the one whose absence is
   * invisible: gating `milestoneItemIds` leaves the entire suite green.
   *
   * Eight reads subtract that set (listed in lib/extension-gates.ts); the three
   * in planner-store are the ENFORCEMENT — the last line before the write. A
   * milestone's `startDate` is the goal's TARGET date, and a bulk verb that
   * overwrites it has destroyed something switching the extension back on
   * cannot restore. So "off" must never reach these, and this is what says so.
   */
  const milestone = (): Item =>
    ({
      type: 'task',
      id: 't-milestone',
      title: 'HSK 3 exam',
      status: 'pending',
      isScheduled: false,
      order: 0,
      startDate: '2026-09-01',
      timeBucket: 'morning',
    }) as unknown as Item;

  function seedMilestone() {
    const items = [milestone(), OUTSIDER];
    usePlannerStore.setState({
      userId: 'user-1',
      userTimezone: 'UTC',
      items,
      tasks: items as never,
      habits: [] as never,
      goals: [
        { ...GOAL, memberIds: [], milestoneIds: ['t-milestone'] } as unknown as Goal,
      ],
      goalsAvailable: true,
    } as never);
  }

  /** `startDate` lives on the task half of the Item union; these fixtures are tasks. */
  const startDateOf = (id: string) =>
    (usePlannerStore.getState().items.find((i) => i.id === id) as { startDate?: string })
      ?.startDate;

  beforeEach(() => {
    disableExtensions(EXT_GOALS);
    seedMilestone();
  });

  it('refuses to bulk-move a milestone, and still moves everything else', () => {
    usePlannerStore
      .getState()
      .moveTasksToDate(['t-milestone', 't-outsider'], '2026-07-20');

    expect(startDateOf('t-milestone')).toBe('2026-09-01');
    expect(startDateOf('t-outsider')).toBe('2026-07-20');
  });

  it('refuses to bulk-unschedule a milestone', () => {
    usePlannerStore.getState().unscheduleTasks(['t-milestone', 't-outsider']);

    expect(startDateOf('t-milestone')).toBe('2026-09-01');
    expect(startDateOf('t-outsider')).toBeUndefined();
  });

  it('refuses to give a milestone a clock time on a drop', () => {
    usePlannerStore
      .getState()
      .scheduleItemsAt(['t-milestone', 't-outsider'], 'morning', '09:00', '2026-07-20');

    expect(startDateOf('t-milestone')).toBe('2026-09-01');
    expect(startDateOf('t-outsider')).toBe('2026-07-20');
  });
});

/* ── the surfaces the first pass left unpinned ─────────────────────────────*/

describe('Goals switched off — the remaining surfaces', () => {
  const row = (): RowItem => ({
    itemType: 'task',
    item: usePlannerStore.getState().items.find((i) => i.id === 't-member') as never,
  }) as unknown as RowItem;

  it('drops the goal role glyph from a row, and nothing else about the row', () => {
    usePlannerStore.setState({
      goals: [{ ...GOAL, memberIds: [], milestoneIds: ['t-member'] } as unknown as Goal],
    } as never);

    enableExtensions(EXT_GOALS);
    render(<TaskRow row={row()} />);
    expect(screen.getByTestId('item-goal-role')).toHaveAttribute(
      'data-goal-role',
      'milestone'
    );
    cleanup();

    disableExtensions(EXT_GOALS);
    render(<TaskRow row={row()} />);
    // The GLYPH goes; the ROW stays. That asymmetry is the aspire contract — a
    // goal may add a mark to a row and may never take the row away.
    expect(screen.queryByTestId('item-goal-role')).toBeNull();
    expect(screen.getByText('Study characters')).toBeInTheDocument();
  });

  it('stops telling the AI about goals', async () => {
    const posted: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: unknown, init: { body?: string } = {}) => {
      // The plugin path reads its URL and key lazily, once per account.
      if (url === '/api/agent/chat-url') {
        return {
          ok: true,
          json: async () => ({ chatUrl: 'https://example.test/chat', agentId: null, chatToken: 'k' }),
        } as never;
      }
      posted.push(JSON.parse(init.body ?? '{}').context ?? '');
      return { ok: true, json: async () => ({ content: 'ok' }) } as never;
    }) as never;
    const unseed = seedAI(OPENCLAW_PLUGIN);
    // The real transport (it is what posts the context); the saves go to a fake.
    configureConversations({ api: fakeApi().api, transport: chatTransport });
    const chat = useConversationsStore.getState();

    enableExtensions(EXT_GOALS);
    await chat.send(chat.newDraft(), 'how am I doing');

    disableExtensions(EXT_GOALS);
    await chat.send(chat.newDraft(), 'how am I doing');

    await conversationsSettled();
    globalThis.fetch = original;
    unseed();
    // The heading is emitted only when the goals array is non-empty, so its
    // presence and absence is the whole assertion. The rest of the context is
    // byte-identical either way — this removes a section, it does not reshape
    // the prompt.
    expect(posted[0]).toContain('### Long-term goals');
    expect(posted[1]).not.toContain('### Long-term goals');
  });

  it('does not offer Goal in the ⌘K palette, nor tick a stored one', () => {
    useViewStore.setState({ canvasGroupBy: 'goal' });

    disableExtensions(EXT_GOALS);
    // The palette used to be the ONE place that disagreed with the canvas about
    // what the canvas was doing: it offered Goal and marked it active while
    // every surface — and the Display menu beside it — reported 'none'.
    expect(groupByOptionsFor(CANVAS_GROUP_BY_OPTIONS).map((o) => o.value)).not.toContain(
      'goal'
    );
    expect(resolvedCanvasGroupBy()).toBe('none');
    const options = findCommand('view.groupBy', ctx)!.argument as {
      options: (c: CommandContext) => { value: string; active?: boolean }[];
    };
    expect(options.options(ctx).map((o) => o.value)).not.toContain('goal');
    expect(options.options(ctx).find((o) => o.active)?.value).toBe('none');

    enableExtensions(EXT_GOALS);
    expect(options.options(ctx).map((o) => o.value)).toContain('goal');
    expect(options.options(ctx).find((o) => o.active)?.value).toBe('goal');
  });

  it('does not let Reset display destroy a clause it is not showing', async () => {
    // Reset clears what the menu OWNS. While Goals is off the menu renders no
    // goal row and the trigger does not count one — so clearing it here would
    // silently destroy a selection the user cannot see, and switching Goals
    // back on would return an empty filter instead of the one they left.
    seed({ goalFilter: true });
    useViewStore.setState({
      canvasGroupBy: 'goal',
      canvasFilters: { ...EMPTY_VIEW_FILTERS, goals: ['g1'], priorities: ['high'] },
    });

    disableExtensions(EXT_GOALS);
    render(<DisplayMenu surface="canvas" />);
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Reset display/ }));

    // The clauses the menu DOES show are cleared…
    expect(useViewStore.getState().canvasFilters.priorities).toEqual([]);
    // …and the ones it does not are left exactly where the user left them.
    expect(useViewStore.getState().canvasFilters.goals).toEqual(['g1']);
    expect(useViewStore.getState().canvasGroupBy).toBe('goal');
  });
});

/* ── a gate may never throw ────────────────────────────────────────────────*/

describe('a gate read that throws', () => {
  it('falls back to the manifest default instead of taking the surface down', () => {
    // These run inside the canvas render, so a gate that threw would take down
    // the surface it was protecting — strictly worse than the feature it gates.
    const hostile = new Proxy({} as Record<string, boolean>, {
      get() {
        throw new Error('store read exploded');
      },
    });
    useExtensionsStore.setState({ enabled: hostile });

    let answer: boolean | undefined;
    expect(() => {
      answer = extensionEnabled(EXT_GOALS);
    }).not.toThrow();
    // Asserted against the MANIFEST rather than against a literal false, so the
    // day an extension ships defaultEnabled: true this tracks it instead of
    // quietly switching that account's feature off on a transient read.
    expect(answer).toBe(extensionManifest(EXT_GOALS)!.defaultEnabled);
  });
});

/* ── and it must stay findable ─────────────────────────────────────────────*/

describe('Goals switched off — still in the catalogue', () => {
  beforeEach(() => disableExtensions(EXT_GOALS));

  it('keeps its manifest row, which is what generates every way of finding it', () => {
    expect(OFFICIAL_EXTENSIONS.map((e) => e.slug)).toContain(EXT_GOALS);
    const manifest = extensionManifest(EXT_GOALS);
    expect(manifest?.name).toBe('Goals');
    expect(manifest?.description).toBeTruthy();
    // Ships off per the weight ledger — and that is the default the rest of
    // this file is testing against.
    expect(manifest?.defaultEnabled).toBe(false);
    expect(resolveEnabled({}, EXT_GOALS)).toBe(false);
  });

  it('keeps its settings pane and the one switch that turns it back on', () => {
    const pane = extensionPaneId(EXT_GOALS);
    expect(isPaneId(pane)).toBe(true);
    expect(ALL_PANES.map((p) => p.id)).toContain(pane);

    const records = settingsForPane(pane);
    const toggle = records.find((r) => r.control === 'switch' && !r.dependsOn);
    expect(toggle).toBeDefined();
    // Reads OFF and is still rendered, which is the whole "inert but findable"
    // promise: a row that vanished with the feature could never switch it back.
    expect(toggle!.read({} as never)).toBe(false);
  });

  it('keeps its search hits — the destination and the toggle keywords', () => {
    expect(DESTINATIONS.some((d) => d.id === 'dest.goals')).toBe(true);
    const toggle = settingsForPane(extensionPaneId(EXT_GOALS)).find(
      (r) => r.control === 'switch'
    );
    expect(toggle?.keywords).toEqual(expect.arrayContaining(['goal', 'milestone']));
  });

  it('keeps the Organize goals command, greyed rather than deleted', () => {
    // Deleting the row would make the palette the one place the feature stops
    // existing; `availableWhen` renders it and blocks the run instead.
    const command = STATIC_COMMANDS.find((c) => c.id === 'app.goals');
    expect(command).toBeDefined();
    expect(isAvailable(command!, ctx)).toBe(false);

    enableExtensions(EXT_GOALS);
    expect(isAvailable(command!, ctx)).toBe(true);
  });
});
