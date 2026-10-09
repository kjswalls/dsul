import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, within } from '@testing-library/react';

/**
 * The right-click menus (components/planner/item-context-menu.tsx,
 * container-context-menu.tsx). What each verb may do is pinned in
 * item-verbs.test.ts; this pins what the MENU adds: it acts on the day the row
 * is drawn on, it lights what it acts on, a selection gets the batch verbs,
 * the container menu's switch writes through the gate toggle, and the press
 * that opens either menu never also chooses from it.
 */

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'light', resolvedTheme: 'light', setTheme: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
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
  setItemSkip: vi.fn(async () => {}),
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
  // No RPC: the per-table fallback, started synchronously (the fetchers above).
  loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
  // The menu reads the agent's rows before offering "Take back" (hooks/use-agent-freshness.ts).
  fetchAgentStates: vi.fn(async () => []),
}));
/** Whether the planner's console (and so the "new" dialog) is mounted. */
const hosted = vi.hoisted(() => ({ current: false }));
vi.mock('@/lib/console-door', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/console-door')>()),
  consoleHosted: () => hosted.current,
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import { TaskRow, type RowItem } from '@/components/primitives/task-row';
import { GroupSection } from '@/components/primitives/group-section';
import { getActionLog, usePlannerStore } from '@/lib/planner-store';
import { resetAgentFreshness } from '@/hooks/use-agent-freshness';
import { useSelectionStore } from '@/lib/selection-store';
import { useUIStore } from '@/lib/ui-store';
import { EXT_ORGANIZE, EXT_STREAKS } from '@/lib/extension-registry';
import { disableExtensions, enableExtensions } from './support/extensions';
import { ItemContextMenu } from '@/components/planner/item-context-menu';
import {
  clearChatState,
  configureConversations,
  conversationsSettled,
  useConversationsStore,
} from '@/lib/conversations-store';
import { useRailStore } from '@/lib/rail-store';
import { useProposalStore } from '@/lib/proposal-store';
import { CONNECTED_MODEL, NOTHING_CONNECTED, OPENCLAW_PLUGIN, seedAI, type SeedAI } from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, flush, summary, type FakeApi, type FakeTransport } from './helpers/conversations-fakes';
import * as db from '@/lib/db';
import type { HabitItem, Item, Task } from '@/lib/planner-types';

const USER = 'user-1';
/** Real today (the clock is pinned) and the day on screen. */
const TODAY = '2026-07-16';
/** A week column to the left of today — what the user right-clicks in. */
const ROW_DAY = '2026-07-14';

const asDate = (ymd: string) => new Date(`${ymd}T12:00:00Z`);
const store = () => usePlannerStore.getState();
const itemById = (id: string) => store().items.find((i) => i.id === id) as unknown as Record<string, unknown>;

const fixtures = (): Item[] =>
  [
    {
      type: 'task',
      id: 'daily',
      title: 'Water the plants',
      status: 'pending',
      isScheduled: false,
      timeBucket: 'anytime',
      order: 0,
      startDate: '2026-07-01',
      repeatFrequency: 'daily',
      completedDates: [],
      skippedDates: [],
    },
    {
      type: 'task',
      id: 'once',
      title: 'File taxes',
      status: 'pending',
      isScheduled: false,
      timeBucket: 'anytime',
      order: 1,
      startDate: TODAY,
      completedDates: [],
      skippedDates: [],
    },
    {
      type: 'task',
      id: 'other',
      title: 'Call mum',
      status: 'pending',
      isScheduled: false,
      timeBucket: 'anytime',
      order: 2,
      startDate: TODAY,
      completedDates: [],
      skippedDates: [],
    },
  ] as unknown as Item[];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(asDate(TODAY));
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(fixtures());
  await store().initializeStore(USER);
  usePlannerStore.setState({ selectedDate: asDate(TODAY), userTimezone: 'UTC', routines: [], seasons: [], goals: [] });
  useSelectionStore.getState().clear();
  useUIStore.setState({ activeDialog: null, confirmRequest: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function LiveRow({ id, date }: { id: string; date?: Date }) {
  const item = usePlannerStore((s) => s.items.find((i) => i.id === id))!;
  const row: RowItem =
    item.type === 'habit'
      ? { itemType: 'habit', item: item as unknown as HabitItem }
      : { itemType: 'task', item: item as unknown as Task };
  return <TaskRow row={row} date={date} />;
}

const cardOf = (id: string) =>
  screen.getAllByTestId('item-card').find((el) => el.getAttribute('data-item-id') === id)!;

function rightClick(el: Element) {
  fireEvent.contextMenu(el, { clientX: 10, clientY: 10 });
  return screen.getByTestId(/context-menu$/);
}

describe('the item right-click menu', () => {
  it('acts on the day the row is drawn on, not the day on screen', () => {
    render(<LiveRow id="daily" date={asDate(ROW_DAY)} />);
    const menu = rightClick(cardOf('daily'));
    const tick = within(menu).getByTestId('item-menu-tick');
    // Not today, so the label does not say "today".
    expect(tick.textContent).toContain('Done');
    expect(tick.textContent).not.toContain('today');
    fireEvent.click(tick);
    expect(itemById('daily').completedDates).toEqual([ROW_DAY]);
  });

  it('keeps the carries off a recurring task (Reschedule stays) and offers them on a dated one-off', () => {
    render(
      <>
        <LiveRow id="daily" />
        <LiveRow id="once" />
      </>
    );
    const series = rightClick(cardOf('daily'));
    expect(within(series).queryByTestId('item-menu-next-day')).toBeNull();
    // Reschedule moves the series start, so a recurring task keeps it.
    expect(within(series).getByTestId('item-menu-reschedule')).toBeTruthy();
    expect(within(series).getByTestId('item-menu-skip')).toBeTruthy();
    fireEvent.keyDown(series, { key: 'Escape' });

    const once = rightClick(cardOf('once'));
    fireEvent.click(within(once).getByTestId('item-menu-next-day'));
    expect(itemById('once').startDate).toBe('2026-07-17');
  });

  it('makes the right-clicked item the selection, so what it acts on is lit', () => {
    useSelectionStore.getState().replace(['other']);
    render(
      <>
        <LiveRow id="once" />
        <LiveRow id="other" />
      </>
    );
    rightClick(cardOf('once'));
    expect([...useSelectionStore.getState().selectedIds]).toEqual(['once']);
  });

  it('acts on the whole selection when the item is part of one', () => {
    useSelectionStore.getState().replace(['once', 'other']);
    render(
      <>
        <LiveRow id="once" />
        <LiveRow id="other" />
      </>
    );
    const menu = rightClick(cardOf('once'));
    expect(menu.textContent).toContain('2 items');
    fireEvent.click(within(menu).getByTestId('item-menu-batch-complete'));
    expect(itemById('once').status).toBe('completed');
    expect(itemById('other').status).toBe('completed');
  });

  it('asks before Delete', () => {
    render(<LiveRow id="once" />);
    fireEvent.click(within(rightClick(cardOf('once'))).getByTestId('item-menu-delete'));
    expect(useUIStore.getState().confirmRequest).toMatchObject({ destructive: true, confirmLabel: 'Delete' });
    expect(itemById('once')).toBeTruthy();
  });

  it('edits properties through the Edit menu\'s own lists', () => {
    render(<LiveRow id="once" />);
    const menu = rightClick(cardOf('once'));
    fireEvent.pointerMove(within(menu).getByTestId('item-menu-edit-priority'));
    fireEvent.keyDown(within(menu).getByTestId('item-menu-edit-priority'), { key: 'ArrowRight' });
    const high = screen
      .getAllByTestId('bulk-priority-option')
      .find((el) => el.getAttribute('data-value') === 'high')!;
    fireEvent.click(high);
    expect(itemById('once').priority).toBe('high');
  });
});

describe('the item menu\'s rare rows', () => {
  afterEach(() => disableExtensions(EXT_STREAKS));

  it('opens the item in the panel, with no "Open as page" beside it', () => {
    render(<LiveRow id="once" />);
    const menu = rightClick(cardOf('once'));
    expect(within(menu).getByTestId('item-menu-open')).toBeInTheDocument();
    expect(within(menu).queryByTestId('item-menu-open-page')).toBeNull();
    expect(within(menu).queryByText('Open as page')).toBeNull();
  });

  it('keeps Copy link and Copy title under one Copy row', () => {
    render(<LiveRow id="once" />);
    const menu = rightClick(cardOf('once'));
    expect(within(menu).queryByTestId('item-menu-copy-link')).toBeNull();
    const trigger = within(menu).getByTestId('item-menu-copy');
    fireEvent.pointerMove(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowRight' });
    const pane = screen.getByTestId('item-menu-copy-content');
    expect(within(pane).getByTestId('item-menu-copy-link')).toHaveTextContent('Link');
    expect(within(pane).getByTestId('item-menu-copy-title')).toHaveTextContent('Title');
  });

  it('puts Reset streak beside Delete, below the line', () => {
    enableExtensions(EXT_STREAKS);
    usePlannerStore.setState({
      items: store().items.map((i) => (i.id === 'daily' ? ({ ...i, type: 'habit', streak: 3, dailyCounts: {} } as unknown as Item) : i)),
    });
    render(<LiveRow id="daily" />);
    const menu = rightClick(cardOf('daily'));
    const reset = within(menu).getByTestId('item-menu-reset-streak');
    // Its section is Reset streak and Delete, nothing else.
    expect(reset.previousElementSibling?.getAttribute('role')).toBe('separator');
    expect(reset.nextElementSibling).toBe(within(menu).getByTestId('item-menu-delete'));
  });
});

describe('the item menu\'s property rows', () => {
  beforeEach(() => {
    hosted.current = false;
    enableExtensions(EXT_ORGANIZE);
    usePlannerStore.setState({ collectionsAvailable: true, projects: [{ id: 'p1', name: 'Work', emoji: '' }] as never });
  });

  /** Open a flyout from its row, the way a keyboard does. */
  function openSub(trigger: HTMLElement) {
    fireEvent.pointerMove(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowRight' });
  }
  /**
   * A property's row: on the menu itself, or, for a container when more than
   * one applies, under "Organize ▸", which this opens first.
   */
  function rowOf(menu: HTMLElement, key: string) {
    const organize = within(menu).queryByTestId('item-menu-edit-organize');
    if (organize && !screen.queryByTestId('item-menu-organize-content')) openSub(organize);
    return screen.queryByTestId(`item-menu-edit-${key}`);
  }
  /** Open one property's flyout from the menu. */
  function openPane(menu: HTMLElement, key: string) {
    openSub(rowOf(menu, key)!);
  }
  const summaryOf = (menu: HTMLElement, key: string) => within(rowOf(menu, key)!).getByTestId('edit-row-summary');

  it('previews every property, "None" where nothing is set', () => {
    usePlannerStore.setState({ routines: [{ id: 'r1', name: 'Mornings', itemIds: [] }] as never });
    store().updateTask('once', { priority: 'high' } as never);
    render(<LiveRow id="once" />);
    const menu = rightClick(cardOf('once'));
    expect(summaryOf(menu, 'priority')).toHaveTextContent('High');
    expect(summaryOf(menu, 'remind')).toHaveTextContent('None');
    expect(summaryOf(menu, 'remind')).toHaveAttribute('data-unset', 'true');
    expect(summaryOf(menu, 'project')).toHaveTextContent('None');
    expect(summaryOf(menu, 'routine')).toHaveTextContent('None');
  });

  it('keeps the containers under one Organize row, previewing the ones set', () => {
    usePlannerStore.setState({ routines: [{ id: 'r1', name: 'Mornings', itemIds: ['once'] }] as never });
    render(<LiveRow id="once" />);
    const menu = rightClick(cardOf('once'));
    // Priority and Remind stay on the menu; the containers do not.
    expect(within(menu).getByTestId('item-menu-edit-priority')).toBeInTheDocument();
    expect(within(menu).queryByTestId('item-menu-edit-project')).toBeNull();
    expect(within(menu).queryByTestId('item-menu-edit-routine')).toBeNull();
    const organize = within(menu).getByTestId('item-menu-edit-organize');
    expect(within(organize).getByTestId('edit-row-summary')).toHaveTextContent(/^Mornings$/);
    openSub(organize);
    const pane = screen.getByTestId('item-menu-organize-content');
    expect(within(pane).getByTestId('item-menu-edit-project')).toBeInTheDocument();
    expect(within(pane).getByTestId('item-menu-edit-routine')).toBeInTheDocument();
  });

  it('leaves a lone container on the menu, with no Organize row to open first', () => {
    render(<LiveRow id="once" />);
    const menu = rightClick(cardOf('once'));
    expect(within(menu).queryByTestId('item-menu-edit-organize')).toBeNull();
    expect(within(menu).getByTestId('item-menu-edit-project')).toBeInTheDocument();
  });

  it('offers New routine… on the planner, opening the "new" dialog with the item in it', () => {
    render(<LiveRow id="once" />);
    // Off the planner the dialog is not mounted, and with no routines the row
    // has nothing else to offer.
    expect(rowOf(rightClick(cardOf('once')), 'routine')).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    cleanup();

    hosted.current = true;
    render(<LiveRow id="once" />);
    const menu = rightClick(cardOf('once'));
    openPane(menu, 'routine');
    const create = screen.getByTestId('bulk-new-option');
    expect(create).toHaveTextContent('New routine…');
    fireEvent.click(create);
    expect(useUIStore.getState().activeDialog).toEqual({
      type: 'new-container',
      kind: 'routine',
      title: undefined,
      notes: undefined,
      itemIds: ['once'],
    });
  });

  it('offers no New routine… with Organize off, as the item dialog shows no band', () => {
    disableExtensions(EXT_ORGANIZE);
    hosted.current = true;
    render(<LiveRow id="once" />);
    expect(rowOf(rightClick(cardOf('once')), 'routine')).toBeNull();
  });

  it('files items into a just-made project only once its row exists', async () => {
    let land!: () => void;
    vi.mocked(db.createProject).mockImplementationOnce(() => new Promise<void>((r) => (land = r)) as never);
    const id = store().addProject('Body', '')!;
    store().setItemsProject(['once'], 'Body');
    expect(itemById('once').projectId).toBe(id);
    await Promise.resolve();
    expect(db.updateItem).not.toHaveBeenCalled();
    land();
    await vi.waitFor(() => expect(db.updateItem).toHaveBeenCalledWith('once', 'task', expect.objectContaining({ projectId: id })));
  });

  it('holds New… back while the Organize console is open over the planner', () => {
    hosted.current = true;
    useUIStore.setState({ activeDialog: { type: 'organize' } });
    render(<LiveRow id="once" />);
    const menu = rightClick(cardOf('once'));
    expect(rowOf(menu, 'routine')).toBeNull();
    openPane(menu, 'project');
    expect(screen.queryByTestId('bulk-new-option')).toBeNull();
  });

  it('removes the item from the routines it is in, at the foot of the pane', () => {
    usePlannerStore.setState({
      routines: [
        { id: 'r1', name: 'Mornings', itemIds: ['once'] },
        { id: 'r2', name: 'Evenings', itemIds: [] },
      ] as never,
    });
    render(<LiveRow id="once" />);
    const menu = rightClick(cardOf('once'));
    expect(summaryOf(menu, 'routine')).toHaveTextContent('Mornings');
    openPane(menu, 'routine');
    const remove = screen.getByTestId('bulk-remove-option');
    expect(remove).toHaveTextContent('Remove from Mornings');
    fireEvent.click(remove);
    expect(store().routines.find((r) => r.id === 'r1')!.itemIds).not.toContain('once');
  });

  it('offers Remove from project only once the item is filed', () => {
    render(<LiveRow id="once" />);
    openPane(rightClick(cardOf('once')), 'project');
    const unfile = () =>
      screen.queryAllByTestId('bulk-project-option').find((el) => el.getAttribute('data-project-id') === '');
    expect(unfile()).toBeUndefined();
    cleanup();

    store().updateTask('once', { project: 'Work' } as never);
    render(<LiveRow id="once" />);
    const menu = rightClick(cardOf('once'));
    expect(summaryOf(menu, 'project')).toHaveTextContent('Work');
    openPane(menu, 'project');
    expect(unfile()).toHaveTextContent('Remove from project');
    fireEvent.click(unfile()!);
    expect(itemById('once').project).toBeUndefined();
  });
});

describe('the container right-click menu', () => {
  it('turns a routine off from its heading, through the gate toggle', () => {
    enableExtensions(EXT_ORGANIZE);
    usePlannerStore.setState({
      routines: [{ id: 'r1', name: 'Mornings', itemIds: [] }] as never,
    });
    render(
      <GroupSection label="Mornings" gate={{ kind: 'routine', id: 'r1' }} variant="canvas">
        <div />
      </GroupSection>
    );
    const menu = rightClick(screen.getByText('Mornings'));
    expect(within(menu).getByTestId('container-menu-open')).toBeTruthy();
    fireEvent.click(within(menu).getByTestId('container-menu-gate'));
    expect((store().routines[0] as { pausedAt?: string }).pausedAt).toBeTruthy();
  });

  it('opens a project heading\'s page by id, resolved from its name', () => {
    usePlannerStore.setState({ projects: [{ id: 'p1', name: 'Work', emoji: '' }] as never });
    render(
      <GroupSection label="Work" groupKey="project:Work">
        <div />
      </GroupSection>
    );
    fireEvent.click(within(rightClick(screen.getByText('Work'))).getByTestId('container-menu-open-page'));
    expect(push).toHaveBeenCalledWith('/project/p1');
  });
});

describe('the right-click that opens a menu (components/ui/context-menu.tsx)', () => {
  /**
   * A right-click as Chromium on Linux and macOS sends it: `contextmenu` on the
   * press, the button still down, so its release is still to come.
   */
  function pressRight(el: Element, at = { clientX: 10, clientY: 10 }) {
    fireEvent.contextMenu(el, { ...at, button: 2, buttons: 2 });
    return screen.getByTestId(/context-menu$/);
  }
  /** Let go of the right button over `row`, without a press on it first. */
  const releaseRight = (row: Element, at = { clientX: 10, clientY: 10 }) =>
    fireEvent.pointerUp(row, { ...at, button: 2, pointerType: 'mouse' });
  const later = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
  const openMenu = () => screen.queryByTestId('item-context-menu');

  it('ignores the release of the press that opened it, whatever row it lands on', () => {
    render(<LiveRow id="once" />);
    const menu = pressRight(cardOf('once'));
    releaseRight(within(menu).getByTestId('item-menu-next-day'), { clientX: 12, clientY: 11 });
    expect(itemById('once').startDate).toBe(TODAY);
    expect(openMenu()).toBeTruthy();
  });

  it('ignores it when the button was held a while but the pointer stayed put', () => {
    render(<LiveRow id="once" />);
    const menu = pressRight(cardOf('once'));
    later(2000);
    releaseRight(within(menu).getByTestId('item-menu-next-day'), { clientX: 14, clientY: 10 });
    expect(itemById('once').startDate).toBe(TODAY);
    expect(openMenu()).toBeTruthy();
  });

  it('ignores it when the pointer drifted but the release came straight away', () => {
    render(<LiveRow id="once" />);
    const menu = pressRight(cardOf('once'));
    later(100);
    releaseRight(within(menu).getByTestId('item-menu-next-day'), { clientX: 60, clientY: 10 });
    expect(itemById('once').startDate).toBe(TODAY);
    expect(openMenu()).toBeTruthy();
  });

  it('still selects a row the press was held and steered onto', () => {
    render(<LiveRow id="once" />);
    const menu = pressRight(cardOf('once'));
    later(400);
    releaseRight(within(menu).getByTestId('item-menu-next-day'), { clientX: 60, clientY: 120 });
    expect(itemById('once').startDate).toBe('2026-07-17');
    expect(openMenu()).toBeNull();
  });

  it('leaves a left click on a row alone, whether or not the release reached the menu', () => {
    render(<LiveRow id="once" />);
    // The release landed off the menu, so the watch is still on when the left press comes.
    const menu = pressRight(cardOf('once'));
    const next = within(menu).getByTestId('item-menu-next-day');
    fireEvent.pointerDown(next, { button: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(next, { button: 0, pointerType: 'mouse' });
    fireEvent.click(next);
    // Once, not twice: the press on the row means its release does not click it too.
    expect(itemById('once').startDate).toBe('2026-07-17');
    expect(openMenu()).toBeNull();

    const again = pressRight(cardOf('once'));
    releaseRight(within(again).getByTestId('item-menu-open'));
    expect(useUIStore.getState().activeDialog).toBeNull();
    fireEvent.click(within(again).getByTestId('item-menu-next-day'));
    expect(itemById('once').startDate).toBe('2026-07-18');
  });

  it('leaves the keyboard alone', () => {
    render(<LiveRow id="once" />);
    const menu = pressRight(cardOf('once'));
    const next = within(menu).getByTestId('item-menu-next-day');
    releaseRight(next);
    fireEvent.keyDown(next, { key: 'Enter' });
    expect(itemById('once').startDate).toBe('2026-07-17');
    expect(openMenu()).toBeNull();
  });

  it('defuses the release without hiding it: the document still hears the button come up', () => {
    // A Mac's Ctrl+click: a held LEFT press, which dnd-kit is watching as a
    // pending drag of the row and lets go of only on document's pointerup.
    const heard = vi.fn();
    document.addEventListener('pointerup', heard);
    try {
      render(<LiveRow id="once" />);
      fireEvent.contextMenu(cardOf('once'), { clientX: 10, clientY: 10, button: 0, buttons: 1, ctrlKey: true });
      const menu = screen.getByTestId('item-context-menu');
      fireEvent.pointerUp(within(menu).getByTestId('item-menu-next-day'), {
        clientX: 10,
        clientY: 10,
        button: 0,
        pointerType: 'mouse',
      });
      expect(itemById('once').startDate).toBe(TODAY);
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('pointerup', heard);
    }
  });

  it('starts no watch for a menu opened with no button held (Windows, the menu key)', () => {
    render(<LiveRow id="once" />);
    const menu = rightClick(cardOf('once'));
    // Radix's own press-drag-release, untouched: there was no press to ignore.
    releaseRight(within(menu).getByTestId('item-menu-next-day'));
    expect(itemById('once').startDate).toBe('2026-07-17');
  });

  it('guards the container menu too', () => {
    enableExtensions(EXT_ORGANIZE);
    usePlannerStore.setState({ routines: [{ id: 'r1', name: 'Mornings', itemIds: [] }] as never });
    render(
      <GroupSection label="Mornings" gate={{ kind: 'routine', id: 'r1' }} variant="canvas">
        <div />
      </GroupSection>
    );
    const menu = pressRight(screen.getByText('Mornings'));
    releaseRight(within(menu).getByTestId('container-menu-gate'));
    expect((store().routines[0] as { pausedAt?: string }).pausedAt).toBeFalsy();
    fireEvent.click(within(menu).getByTestId('container-menu-gate'));
    expect((store().routines[0] as { pausedAt?: string }).pausedAt).toBeTruthy();
  });
});

describe('the item menu\'s AI row', () => {
  /**
   * The asks themselves (gates, labels, prompts) are pinned in
   * item-asks.test.ts and where each one lands in open-chat.test.ts; this pins
   * what the MENU does with them: one row, there only while something can
   * answer, propose or take the item, labelled "AI" whoever answers, listing
   * the asks in order, and running the one picked on the item (or, on a
   * surface that cannot host the item panel, on the way to the item's page).
   * Under a line, the hand-off to the agent (lib/agent-handoff.ts).
   */
  const askFixtures = (): Item[] =>
    [
      ...fixtures(),
      {
        type: 'habit',
        id: 'stretch',
        title: 'Stretch',
        status: 'pending',
        isScheduled: false,
        timeBucket: 'anytime',
        order: 3,
        startDate: '2026-07-01',
        repeatFrequency: 'daily',
        completedDates: [],
        skippedDates: [],
        dailyCounts: {},
        streak: 0,
      },
      // A one-off past its date and still wanted: sitting.
      {
        type: 'task',
        id: 'late',
        title: 'Renew passport',
        status: 'pending',
        isScheduled: false,
        timeBucket: 'anytime',
        order: 4,
        startDate: '2026-07-10',
        completedDates: [],
        skippedDates: [],
      },
      // As far past its date, but paused: set aside, not sitting.
      {
        type: 'task',
        id: 'held',
        title: 'Repaint the fence',
        status: 'pending',
        isScheduled: false,
        timeBucket: 'anytime',
        order: 5,
        startDate: '2026-07-10',
        pausedAt: '2026-07-12T09:00:00.000Z',
        completedDates: [],
        skippedDates: [],
      },
      // A finished one-off: nothing left to start, break down or schedule.
      {
        type: 'task',
        id: 'done',
        title: 'Book the dentist',
        status: 'completed',
        isScheduled: false,
        timeBucket: 'anytime',
        order: 6,
        startDate: TODAY,
        completedDates: [],
        skippedDates: [],
      },
      // A one-off the agent holds, queued and not yet picked up.
      {
        type: 'task',
        id: 'queued',
        title: 'Draft the newsletter',
        status: 'pending',
        isScheduled: false,
        timeBucket: 'anytime',
        order: 7,
        startDate: TODAY,
        assignee: 'openclaw',
        aiStatus: 'queued',
        completedDates: [],
        skippedDates: [],
      },
      // One the agent tried and could not finish, with its report.
      {
        type: 'task',
        id: 'stuck',
        title: 'Book the venue',
        status: 'pending',
        isScheduled: false,
        timeBucket: 'anytime',
        order: 8,
        startDate: TODAY,
        assignee: 'openclaw',
        aiStatus: 'failed',
        aiResult: 'The booking site wanted a login.',
        completedDates: [],
        skippedDates: [],
      },
      // One the agent has finished: its report is the item panel's to keep.
      {
        type: 'task',
        id: 'delivered',
        title: 'Compare flights',
        status: 'pending',
        isScheduled: false,
        timeBucket: 'anytime',
        order: 9,
        startDate: TODAY,
        assignee: 'openclaw',
        aiStatus: 'done',
        aiResult: 'Three options, cheapest on Tuesday.',
        completedDates: [],
        skippedDates: [],
      },
    ] as unknown as Item[];

  let api: FakeApi;
  let tx: FakeTransport;
  let unseed: () => void = () => {};
  let request: ReturnType<typeof vi.fn>;
  const realRequest = useProposalStore.getState().request;

  beforeEach(async () => {
    store().clearStore();
    vi.mocked(db.fetchItems).mockResolvedValue(askFixtures());
    await store().initializeStore(USER);
    usePlannerStore.setState({ selectedDate: asDate(TODAY), userTimezone: 'UTC', routines: [], seasons: [], goals: [] });
    api = fakeApi();
    tx = fakeTransport();
    configureConversations({ api: api.api, transport: tx.transport });
    clearChatState();
    // A plan card is a network ask; what the menu asks for is the point here.
    request = vi.fn(async () => {});
    useProposalStore.setState({ request: request as never });
  });
  afterEach(async () => {
    await conversationsSettled();
    useProposalStore.setState({ request: realRequest });
    unseed();
    unseed = () => {};
    clearChatState();
  });

  /** Open "AI ▸" the way the Edit rows are opened above: hover, then the arrow. */
  function openAsk(menu: HTMLElement) {
    const trigger = within(menu).getByTestId('item-menu-ask');
    fireEvent.pointerMove(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowRight' });
    return screen.getByTestId('item-menu-ask-content');
  }
  const askIds = (content: HTMLElement) =>
    within(content)
      .getAllByTestId(/^item-menu-ask-/)
      .map((el) => el.getAttribute('data-testid')!.slice('item-menu-ask-'.length));
  const askLabel = (content: HTMLElement, id: string) => within(content).getByTestId(`item-menu-ask-${id}`).textContent;

  /** The console's member row: the menu with `openHref`, acting on today. */
  function ConsoleRow({ id }: { id: string }) {
    const item = usePlannerStore((s) => s.items.find((i) => i.id === id))!;
    return (
      <ItemContextMenu item={item} date="today" openHref>
        <div data-testid="console-row">{item.title}</div>
      </ItemContextMenu>
    );
  }

  it('is not there while the gate is unknown, nor when nothing can answer', () => {
    // Fail closed: the moment before the server has answered.
    unseed = seedAI();
    render(<LiveRow id="once" />);
    const unknown = rightClick(cardOf('once'));
    expect(within(unknown).queryByTestId('item-menu-ask')).toBeNull();
    // The rest of the menu is unaffected.
    expect(within(unknown).getByTestId('item-menu-open')).toBeTruthy();
    fireEvent.keyDown(unknown, { key: 'Escape' });
    cleanup();
    unseed();

    unseed = seedAI(NOTHING_CONNECTED);
    render(<LiveRow id="once" />);
    expect(within(rightClick(cardOf('once'))).queryByTestId('item-menu-ask')).toBeNull();
  });

  it('reads "AI" whoever answers: a connected model, or OpenClaw', () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<LiveRow id="once" />);
    expect(within(rightClick(cardOf('once'))).getByTestId('item-menu-ask')).toHaveTextContent(/^AI$/);
    cleanup();
    unseed();

    unseed = seedAI(OPENCLAW_PLUGIN);
    render(<LiveRow id="once" />);
    expect(within(rightClick(cardOf('once'))).getByTestId('item-menu-ask')).toHaveTextContent(/^AI$/);
  });

  it('is one row: the asks live under it, not in the menu', () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<LiveRow id="once" />);
    const menu = rightClick(cardOf('once'));
    expect(within(menu).getAllByTestId(/^item-menu-ask/)).toHaveLength(1);
    expect(screen.queryByTestId('item-menu-ask-content')).toBeNull();
  });

  it('lists the task-shaped asks, in order, for a dated one-off with no time', () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<LiveRow id="once" />);
    const content = openAsk(rightClick(cardOf('once')));
    expect(askIds(content)).toEqual(['ask', 'breakdown', 'start', 'findTime']);
    expect(askLabel(content, 'ask')).toBe('Ask about this…');
    expect(askLabel(content, 'breakdown')).toBe('Break it down');
    expect(askLabel(content, 'start')).toBe('Help me start');
    expect(askLabel(content, 'findTime')).toBe('Find a time for this');
  });

  it('gives a habit its own one ask instead of the task-shaped ones', () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<LiveRow id="stretch" />);
    const content = openAsk(rightClick(cardOf('stretch')));
    expect(askIds(content)).toEqual(['ask', 'keep']);
    expect(askLabel(content, 'keep')).toBe('Make this easier to keep');
  });

  it('offers no "Find a time" on a repeating task: its schedule is its series', () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<LiveRow id="daily" />);
    expect(askIds(openAsk(rightClick(cardOf('daily'))))).toEqual(['ask', 'breakdown', 'start']);
  });

  it('offers only the conversation on a finished one-off', () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<LiveRow id="done" />);
    expect(askIds(openAsk(rightClick(cardOf('done'))))).toEqual(['ask']);
  });

  it('words "start" as getting unstuck once a one-off is sitting, and not while it is paused', () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<LiveRow id="late" />);
    expect(askLabel(openAsk(rightClick(cardOf('late'))), 'start')).toBe('Help me get unstuck');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    cleanup();

    render(<LiveRow id="held" />);
    expect(askLabel(openAsk(rightClick(cardOf('held'))), 'start')).toBe('Help me start');
  });

  it('says "Continue conversation" once the item has its conversation', () => {
    unseed = seedAI(CONNECTED_MODEL);
    useConversationsStore.setState((s) => ({ itemIndex: { ...s.itemIndex, once: 'c-once' } }));
    render(<LiveRow id="once" />);
    expect(askLabel(openAsk(rightClick(cardOf('once'))), 'ask')).toBe('Continue conversation');
  });

  it('warms the conversation list on open, so "Continue conversation" shows without Ask having been opened', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    api.answer.list = () => ({
      ok: true,
      value: { conversations: [summary({ id: 'c-once', itemId: 'once' })], starred: [], nextCursor: null },
    });
    render(<LiveRow id="once" />);
    const content = openAsk(rightClick(cardOf('once')));
    expect(askLabel(content, 'ask')).toBe('Ask about this…');
    expect(api.api.list).toHaveBeenCalledTimes(1);
    await act(async () => {
      await flush();
    });
    expect(askLabel(screen.getByTestId('item-menu-ask-content'), 'ask')).toBe('Continue conversation');
  });

  it('drops the asks that need a plan card when OpenClaw answers over the plugin', () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    render(<LiveRow id="once" />);
    expect(askIds(openAsk(rightClick(cardOf('once'))))).toEqual(['ask', 'start']);
  });

  it('is not offered on a multiselection, whose menu is the batch verbs', () => {
    unseed = seedAI(CONNECTED_MODEL);
    useSelectionStore.getState().replace(['once', 'other']);
    render(
      <>
        <LiveRow id="once" />
        <LiveRow id="other" />
      </>
    );
    const menu = rightClick(cardOf('once'));
    expect(menu.textContent).toContain('2 items');
    expect(within(menu).queryByTestId('item-menu-ask')).toBeNull();
  });

  it('"Ask about this…" opens the item in the slot with its box asked for, and sends nothing', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<LiveRow id="once" />);
    fireEvent.click(within(openAsk(rightClick(cardOf('once')))).getByTestId('item-menu-ask-ask'));
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'once', type: 'task' } });
    expect(useRailStore.getState().pendingFocus).toEqual({ target: 'composer', binding: { kind: 'item', itemId: 'once' } });
    expect(push).not.toHaveBeenCalled();
    await flush();
    expect(tx.inputs).toHaveLength(0);
    expect(api.turns).toEqual([]);
  });

  it('"Help me start" sends its prompt into the item\'s one conversation, with the item open', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<LiveRow id="once" />);
    fireEvent.click(within(openAsk(rightClick(cardOf('once')))).getByTestId('item-menu-ask-start'));
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'once' } });
    await flush();
    await conversationsSettled();
    expect(tx.inputs).toHaveLength(1);
    expect(tx.inputs[0].message).toBe("Help me get started on this. What's the smallest first step I could take?");
    // Said as "this": the conversation already knows which item it is about.
    expect(tx.inputs[0].message).not.toContain('File taxes');
    const thread = useConversationsStore.getState().threads[tx.inputs[0].conversationId];
    expect(thread?.itemId).toBe('once');
  });

  it('"Break it down" opens the item and asks for its card', () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<LiveRow id="once" />);
    fireEvent.click(within(openAsk(rightClick(cardOf('once')))).getByTestId('item-menu-ask-breakdown'));
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'once' } });
    expect(request).toHaveBeenCalledWith('breakdown', undefined, 'once');
  });

  it('"Find a time" asks for a plan card on Ask home, naming the item by id, with no item on top', () => {
    unseed = seedAI(CONNECTED_MODEL);
    render(<LiveRow id="once" />);
    fireEvent.click(within(openAsk(rightClick(cardOf('once')))).getByTestId('item-menu-ask-findTime'));
    expect(request).toHaveBeenCalledTimes(1);
    const [intent, prompt] = request.mock.calls[0];
    expect(intent).toBe('ask');
    expect(prompt).toContain('[once]');
    expect(prompt).toContain('"File taxes"');
    expect(useUIStore.getState().activeDialog).toBeNull();
    expect(useRailStore.getState().summoned).toBe(true);
  });

  describe('on a surface that cannot host the item panel (openHref, the Organize console)', () => {
    it('offers neither "Ask about this…" ("Open item" again) nor "Find a time" (whose card lives in Ask)', () => {
      unseed = seedAI(CONNECTED_MODEL);
      render(<ConsoleRow id="once" />);
      const menu = rightClick(screen.getByTestId('console-row'));
      expect(within(menu).getByTestId('item-menu-ask')).toHaveTextContent(/^AI$/);
      expect(askIds(openAsk(menu))).toEqual(['breakdown', 'start']);
    });

    it('never puts the item in the slot over an open console', () => {
      unseed = seedAI(CONNECTED_MODEL);
      useUIStore.setState({ activeDialog: { type: 'organize' } });
      render(<ConsoleRow id="once" />);
      fireEvent.click(within(openAsk(rightClick(screen.getByTestId('console-row')))).getByTestId('item-menu-ask-start'));
      expect(push).toHaveBeenCalledWith('/item/once');
      // An item armed here would spring open, unasked, on the next trip home.
      // The console's own slot is left as it is, as "Open item" leaves it:
      // ConsoleSlotGuard drops it once the route changes.
      expect(useUIStore.getState().activeDialog).toEqual({ type: 'organize' });
    });

    it('"Help me start" goes to the page and sends into the item\'s conversation there', async () => {
      unseed = seedAI(CONNECTED_MODEL);
      render(<ConsoleRow id="once" />);
      fireEvent.click(within(openAsk(rightClick(screen.getByTestId('console-row')))).getByTestId('item-menu-ask-start'));
      expect(push).toHaveBeenCalledWith('/item/once');
      expect(useUIStore.getState().activeDialog).toBeNull();
      await flush();
      await conversationsSettled();
      expect(tx.inputs).toHaveLength(1);
      expect(useConversationsStore.getState().threads[tx.inputs[0].conversationId]?.itemId).toBe('once');
    });

    it('"Break it down" goes to the page and asks for the card there, arming no slot', () => {
      unseed = seedAI(CONNECTED_MODEL);
      render(<ConsoleRow id="once" />);
      fireEvent.click(
        within(openAsk(rightClick(screen.getByTestId('console-row')))).getByTestId('item-menu-ask-breakdown')
      );
      expect(push).toHaveBeenCalledWith('/item/once');
      expect(request).toHaveBeenCalledWith('breakdown', undefined, 'once');
      expect(useUIStore.getState().activeDialog).toBeNull();
    });
  });

  describe('handing the item to the agent, and taking it back (lib/agent-handoff.ts)', () => {
    /** A paired OpenClaw agent: what `canDelegate` asks, whoever answers chat. */
    const AGENT = { agent: true, agentId: 'kirby-1' };
    const MODEL_AND_AGENT: SeedAI = { ...CONNECTED_MODEL, openclaw: AGENT };
    /** The agent and nothing to chat with: no model, no gateway, no plugin chat. */
    const AGENT_ONLY: SeedAI = { ...NOTHING_CONNECTED, openclaw: AGENT };

    /** What the AI ▸ panel holds, top to bottom: each row's testid, or the line. */
    const rows = (content: HTMLElement) =>
      [...content.children].map(
        (el) => el.getAttribute('data-testid') ?? (el.getAttribute('role') === 'separator' ? '—' : el.tagName)
      );
    const LINE = '—';
    const closeMenu = () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      cleanup();
    };

    it('offers no hand-off with only a model connected: a model has no worker behind it', () => {
      unseed = seedAI(CONNECTED_MODEL);
      render(<LiveRow id="once" />);
      const content = openAsk(rightClick(cardOf('once')));
      expect(rows(content)).toEqual(['item-menu-ask-ask', 'item-menu-ask-breakdown', 'item-menu-ask-start', 'item-menu-ask-findTime']);
      expect(within(content).queryByTestId('item-menu-handoff')).toBeNull();
      expect(within(content).queryByTestId('item-menu-takeback')).toBeNull();
    });

    it('with an agent paired, offers "Hand off to OpenClaw" on a pending one-off, under a line after the asks', () => {
      unseed = seedAI(MODEL_AND_AGENT);
      render(<LiveRow id="once" />);
      const content = openAsk(rightClick(cardOf('once')));
      expect(rows(content)).toEqual([
        'item-menu-ask-ask',
        'item-menu-ask-breakdown',
        'item-menu-ask-start',
        'item-menu-ask-findTime',
        LINE,
        'item-menu-handoff',
      ]);
      expect(within(content).getByTestId('item-menu-handoff')).toHaveTextContent(/^Hand off to OpenClaw$/);
      expect(within(content).queryByTestId('item-menu-takeback')).toBeNull();
    });

    it('offers no hand-off the agent would never pick up: a habit, a repeating task, a finished one-off, a paused one', () => {
      unseed = seedAI(MODEL_AND_AGENT);
      for (const id of ['stretch', 'daily', 'done', 'held']) {
        render(<LiveRow id={id} />);
        const content = openAsk(rightClick(cardOf(id)));
        // The asks are still there; only the hand-off (and its line) is not.
        expect(within(content).getAllByTestId(/^item-menu-ask-/).length, id).toBeGreaterThan(0);
        expect(within(content).queryByTestId('item-menu-handoff'), id).toBeNull();
        expect(within(content).queryByTestId('item-menu-takeback'), id).toBeNull();
        expect(rows(content), id).not.toContain(LINE);
        closeMenu();
      }
    });

    it('with only the agent (nothing to chat with), keeps the AI row, holding just the hand-off', () => {
      unseed = seedAI(AGENT_ONLY);
      render(<LiveRow id="once" />);
      const menu = rightClick(cardOf('once'));
      expect(within(menu).getByTestId('item-menu-ask')).toHaveTextContent(/^AI$/);
      expect(rows(openAsk(menu))).toEqual(['item-menu-handoff']);
      closeMenu();

      // And where there is nothing to hand off either, there is no row at all.
      render(<LiveRow id="stretch" />);
      expect(within(rightClick(cardOf('stretch'))).queryByTestId('item-menu-ask')).toBeNull();
    });

    it('hands off: assignee openclaw, queued, stamped, as one named history entry', async () => {
      unseed = seedAI(MODEL_AND_AGENT);
      render(<LiveRow id="once" />);
      fireEvent.click(within(openAsk(rightClick(cardOf('once')))).getByTestId('item-menu-handoff'));
      expect(itemById('once')).toMatchObject({
        assignee: 'openclaw',
        aiStatus: 'queued',
        aiStatusAt: asDate(TODAY).toISOString(),
      });
      // Its own label, which is what lets the undo strip offer ⌘Z.
      expect(getActionLog()[0].label).toBe('Hand off to OpenClaw: File taxes');
      expect(screen.queryByTestId('item-context-menu')).toBeNull();
      // It opens nothing.
      expect(useUIStore.getState().activeDialog).toBeNull();
      expect(push).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(db.updateItem).toHaveBeenCalledWith(
          'once',
          'task',
          expect.objectContaining({ assignee: 'openclaw', aiStatus: 'queued' })
        )
      );

      // Opened again, the row has turned into the way back.
      const content = openAsk(rightClick(cardOf('once')));
      expect(within(content).queryByTestId('item-menu-handoff')).toBeNull();
      expect(within(content).getByTestId('item-menu-takeback')).toHaveTextContent('Take back from OpenClaw');
    });

    it('offers "Take back from OpenClaw", its status beside it, on an item the agent holds, and no hand-off', () => {
      unseed = seedAI(MODEL_AND_AGENT);
      render(<LiveRow id="queued" />);
      const content = openAsk(rightClick(cardOf('queued')));
      const takeBack = within(content).getByTestId('item-menu-takeback');
      expect(takeBack).toHaveTextContent(/^Take back from OpenClaw\s*Queued$/);
      expect(within(takeBack).getByText('Queued')).toBeTruthy();
      expect(within(content).queryByTestId('item-menu-handoff')).toBeNull();
      expect(rows(content).slice(-2)).toEqual([LINE, 'item-menu-takeback']);
    });

    it("reads the agent's rows on opening, and stops offering \"Take back\" on work the agent has since finished", async () => {
      unseed = seedAI(MODEL_AND_AGENT);
      resetAgentFreshness();
      vi.mocked(db.fetchAgentStates).mockResolvedValueOnce([
        { id: 'queued', assignee: 'openclaw', aiStatus: 'done', aiResult: 'Drafted.', aiStatusAt: '2099-01-01T00:00:00.000Z' },
      ]);
      render(<LiveRow id="queued" />);
      const content = openAsk(rightClick(cardOf('queued')));
      expect(db.fetchAgentStates).toHaveBeenCalledTimes(1);
      expect(within(content).getByTestId('item-menu-takeback')).toBeTruthy();
      await act(async () => {
        await flush();
      });
      // The newer server row landed: the report is the agent's, not the menu's to clear.
      expect(itemById('queued')).toMatchObject({ aiStatus: 'done', aiResult: 'Drafted.' });
      expect(screen.queryByTestId('item-menu-takeback')).toBeNull();
    });

    it('reads nothing for an item nobody holds', () => {
      unseed = seedAI(MODEL_AND_AGENT);
      resetAgentFreshness();
      vi.mocked(db.fetchAgentStates).mockClear();
      render(<LiveRow id="once" />);
      openAsk(rightClick(cardOf('once')));
      expect(db.fetchAgentStates).not.toHaveBeenCalled();
    });

    it('takes back: clears the assignment, its status and the report, as one named history entry', () => {
      unseed = seedAI(MODEL_AND_AGENT);
      render(<LiveRow id="stuck" />);
      const content = openAsk(rightClick(cardOf('stuck')));
      expect(within(within(content).getByTestId('item-menu-takeback')).getByText("Couldn't finish")).toBeTruthy();
      fireEvent.click(within(content).getByTestId('item-menu-takeback'));
      const item = itemById('stuck');
      expect(item.assignee).toBeUndefined();
      expect(item.aiStatus).toBeUndefined();
      expect(item.aiResult).toBeUndefined();
      expect(getActionLog()[0].label).toBe('Take back from OpenClaw: Book the venue');
      expect(screen.queryByTestId('item-context-menu')).toBeNull();
    });

    it('offers take back with nothing connected: taking your own item back never depends on the agent', () => {
      unseed = seedAI(NOTHING_CONNECTED);
      render(<LiveRow id="queued" />);
      const menu = rightClick(cardOf('queued'));
      expect(within(menu).getByTestId('item-menu-ask')).toHaveTextContent(/^AI$/);
      const content = openAsk(menu);
      // No asks, so no line above it either.
      expect(rows(content)).toEqual(['item-menu-takeback']);
      fireEvent.click(within(content).getByTestId('item-menu-takeback'));
      expect(itemById('queued').assignee).toBeUndefined();
      expect(itemById('queued').aiStatus).toBeUndefined();
    });

    it('offers neither once the agent is done: its report is the item panel\'s to keep', () => {
      unseed = seedAI(MODEL_AND_AGENT);
      render(<LiveRow id="delivered" />);
      const content = openAsk(rightClick(cardOf('delivered')));
      expect(within(content).queryByTestId('item-menu-handoff')).toBeNull();
      expect(within(content).queryByTestId('item-menu-takeback')).toBeNull();
      expect(rows(content)).not.toContain(LINE);
      closeMenu();
      unseed();

      // With nothing connected there is then nothing for the row to hold.
      unseed = seedAI(NOTHING_CONNECTED);
      render(<LiveRow id="delivered" />);
      expect(within(rightClick(cardOf('delivered'))).queryByTestId('item-menu-ask')).toBeNull();
    });

    it('still offers the hand-off on the console, since it opens nothing', () => {
      unseed = seedAI(MODEL_AND_AGENT);
      useUIStore.setState({ activeDialog: { type: 'organize' } });
      render(<ConsoleRow id="once" />);
      const content = openAsk(rightClick(screen.getByTestId('console-row')));
      expect(rows(content)).toEqual(['item-menu-ask-breakdown', 'item-menu-ask-start', LINE, 'item-menu-handoff']);
      fireEvent.click(within(content).getByTestId('item-menu-handoff'));
      expect(itemById('once')).toMatchObject({ assignee: 'openclaw', aiStatus: 'queued' });
      expect(push).not.toHaveBeenCalled();
      expect(useUIStore.getState().activeDialog).toEqual({ type: 'organize' });
    });
  });
});
