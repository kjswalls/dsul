// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * ORGANIZERS IN THE "NEW" DIALOG (Kirby, 2026-09-25).
 *
 * The type chip's menu grows an "Organizers" group — Goal, Routine, Program,
 * Project — and picking one swaps the dialog to ContainerDialog, a sibling
 * body in the same shell with its own `new-container` slot. The claims pinned
 * here are the ones a later edit could quietly undo:
 *
 *  1. The group is gated PER KIND, the console's own gates plus the table's
 *     availability, and is never offered on a seeded open (a bucket's "+").
 *  2. The hand-off carries what was typed, into the SLOT — a container kind
 *     never reaches the item dialog's type machinery.
 *  3. A goal is born whole: one addGoal carrying its why and window, then the
 *     dialog closes and a toast offers the console door.
 *  4. A project name that is taken — live or by the bin — holds the button,
 *     with a sentence, because addProject refuses it silently.
 *  5. addProject answers with the new id (or null), and the organizer nouns are
 *     reserved for new item types.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useParams: () => ({}),
}));

const trashed = vi.hoisted(() => ({ projects: [] as { id: string; name: string }[] }));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  fetchTrashedNames: vi.fn(async () => ({ projects: trashed.projects })),
  fetchItemEvents: vi.fn(async () => []),
  getItemEventsAvailable: () => false,
}));

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

import { ItemDialog } from '@/components/planner/item-dialog';
import { ContainerDialog, programRunsCopy } from '@/components/planner/container-dialog';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore, type NewContainerKind } from '@/lib/ui-store';
import { findCommand, type CommandContext } from '@/lib/commands';
import { EXT_GOALS, EXT_ORGANIZE } from '@/lib/extension-registry';
import { disableExtensions, enableExtensions } from './support/extensions';

const seed = (over: Record<string, unknown> = {}) =>
  usePlannerStore.setState({
    items: [],
    projects: [],
    routines: [],
    programs: [],
    goals: [],
    itemTypes: [],
    collectionsAvailable: true,
    goalsAvailable: true,
    itemTypesAvailable: true,
    userTimezone: 'UTC',
    isLoading: false,
    userId: 'u1',
    ...over,
  });

beforeEach(() => {
  enableExtensions(EXT_GOALS, EXT_ORGANIZE);
  seed();
  trashed.projects = [];
  toastMock.mockClear();
  useUIStore.setState({ activeDialog: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const capture = (over: Record<string, unknown> = {}) =>
  render(<ItemDialog state={{ mode: 'add', type: 'task', ...over }} onOpenChange={() => {}} />);

const openTypeMenu = () => fireEvent.click(screen.getByTestId('item-dialog-type-chip'));
const kindOptions = () =>
  screen.queryAllByTestId('item-dialog-kind-option').map((o) => o.getAttribute('data-value'));

const newContainer = (
  kind: NewContainerKind,
  over: { title?: string; notes?: string } = {},
  onOpenChange: (open: boolean) => void = () => {}
) => render(<ContainerDialog state={{ kind, ...over }} onOpenChange={onOpenChange} />);

/* ── the type menu ─────────────────────────────────────────────────────── */

describe('the "new" dialog type menu', () => {
  it('lists the four organizers after the item types, with the types row last', () => {
    capture();
    openTypeMenu();
    expect(kindOptions()).toEqual(['goal', 'routine', 'program', 'project']);
    const menu = screen.getAllByTestId('item-dialog-kind-option')[0].parentElement!;
    expect(within(menu).getByText('Organizers')).toBeTruthy();
    expect(within(menu).getByText('Something to reach')).toBeTruthy();
    const rows = within(menu).getAllByRole('button');
    expect(rows[rows.length - 1].textContent).toContain('Organize types…');
  });

  it('gates each organizer on its own switch and table', () => {
    disableExtensions(EXT_GOALS);
    capture();
    openTypeMenu();
    expect(kindOptions()).toEqual(['routine', 'program', 'project']);
    cleanup();

    enableExtensions(EXT_GOALS);
    disableExtensions(EXT_ORGANIZE);
    capture();
    openTypeMenu();
    // Project is the one ungated kind: items need somewhere to be filed.
    expect(kindOptions()).toEqual(['goal', 'project']);
    cleanup();

    enableExtensions(EXT_ORGANIZE);
    seed({ goalsAvailable: false, collectionsAvailable: false });
    capture();
    openTypeMenu();
    expect(kindOptions()).toEqual(['project']);
  });

  it('is never offered on a seeded open — a bucket asks for an item', () => {
    capture({ bucket: 'morning', date: new Date() });
    openTypeMenu();
    expect(kindOptions()).toEqual([]);
    expect(screen.queryByText('Organizers')).toBeNull();
  });

  it('marks an existing custom type that shares an organizer noun', () => {
    seed({ itemTypes: [{ id: 't1', name: 'goal', label: 'Goal', labelPlural: 'Goals' }] });
    capture();
    openTypeMenu();
    const typeRow = screen
      .getAllByTestId('item-dialog-type-option')
      .find((o) => o.getAttribute('data-value') === 'goal')!;
    expect(typeRow.textContent).toContain('· type');
  });

  it('hands the typed title and notes to the new-container slot', () => {
    capture();
    fireEvent.change(screen.getByTestId('item-dialog-title-input'), {
      target: { value: 'Speak fluent Chinese' },
    });
    fireEvent.change(screen.getByTestId('item-dialog-notes'), { target: { value: 'For Yutong' } });
    openTypeMenu();
    fireEvent.click(
      screen.getAllByTestId('item-dialog-kind-option').find((o) => o.getAttribute('data-value') === 'goal')!
    );
    expect(useUIStore.getState().activeDialog).toEqual({
      type: 'new-container',
      kind: 'goal',
      title: 'Speak fluent Chinese',
      notes: 'For Yutong',
    });
  });

  it('takes the handed-off text OUT of the item drafts, so the next "new" starts clean', () => {
    // Add drafts outlive a close. Left behind, the goal's name would be waiting
    // in the next plain `n` — one Enter from a duplicate task.
    const { rerender } = capture();
    fireEvent.change(screen.getByTestId('item-dialog-title-input'), {
      target: { value: 'Speak fluent Chinese' },
    });
    fireEvent.change(screen.getByTestId('item-dialog-notes'), { target: { value: 'For Yutong' } });
    openTypeMenu();
    fireEvent.click(
      screen.getAllByTestId('item-dialog-kind-option').find((o) => o.getAttribute('data-value') === 'goal')!
    );
    rerender(<ItemDialog state={null} onOpenChange={() => {}} />);
    rerender(<ItemDialog state={{ mode: 'add', type: 'task' }} onOpenChange={() => {}} />);
    expect(screen.getByTestId('item-dialog-title-input')).toHaveProperty('value', '');
    expect(screen.getByTestId('item-dialog-notes')).toHaveProperty('value', '');
  });

  it('switches back to an item type from the organizer body, carrying the title', () => {
    newContainer('routine', { title: 'Mornings' });
    fireEvent.click(screen.getByTestId('container-dialog-type-chip'));
    fireEvent.click(
      screen.getAllByTestId('item-dialog-type-option').find((o) => o.getAttribute('data-value') === 'habit')!
    );
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'add', tab: 'habit', title: 'Mornings' });
  });
});

/* ── the organizer body ────────────────────────────────────────────────── */

describe('ContainerDialog', () => {
  it('creates a goal with its why and window in ONE addGoal, closes, and toasts an Open', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    const addGoal = vi.fn(() => 'g-new');
    usePlannerStore.setState({ addGoal });
    const onOpenChange = vi.fn();
    newContainer('goal', { title: 'Speak fluent Chinese', notes: 'For Yutong' }, onOpenChange);

    // The window opens today and waits on its target.
    fireEvent.click(screen.getByTestId('goal-dialog-window-chip'));
    const sep30 = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-label')?.includes('September 30th, 2026'))!;
    fireEvent.click(sep30);
    fireEvent.click(screen.getByTestId('goal-dialog-add'));

    expect(addGoal).toHaveBeenCalledTimes(1);
    expect(addGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Speak fluent Chinese',
        why: 'For Yutong',
        startsOn: '2026-09-25',
        targetOn: '2026-09-30',
        state: 'active',
        memberIds: [],
        milestoneIds: [],
        checkinIds: [],
      })
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toastMock).toHaveBeenCalledWith(
      'Goal added',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Open' }) })
    );
    const { action } = toastMock.mock.calls[0][1] as { action: { onClick: () => void } };
    act(() => action.onClick());
    expect(useUIStore.getState().activeDialog).toEqual({
      type: 'organize',
      section: 'goals',
      focusId: 'g-new',
    });
  });

  const day = (label: string) =>
    screen.getAllByRole('button').find((b) => b.getAttribute('aria-label')?.includes(label))!;

  it('creates a program with its Runs and colour in ONE addProgram, as auto', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    const addProgram = vi.fn(() => 'p-new');
    usePlannerStore.setState({ addProgram });
    newContainer('program', { title: 'Autumn term' });

    fireEvent.click(screen.getByTestId('program-dialog-runs-chip'));
    fireEvent.click(day('October 6th, 2026'));
    fireEvent.click(day('October 20th, 2026'));
    fireEvent.click(screen.getByTestId('program-dialog-color'));
    fireEvent.click(screen.getByRole('button', { name: 'Teal' }));
    fireEvent.click(screen.getByTestId('program-dialog-add'));

    expect(addProgram).toHaveBeenCalledTimes(1);
    expect(addProgram).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Autumn term',
        state: 'auto',
        startsOn: '2026-10-06',
        endsOn: '2026-10-20',
        color: 'var(--accent-2)',
        itemIds: [],
        routineIds: [],
      })
    );
  });

  it('passes the picked colour to addGoal', () => {
    const addGoal = vi.fn(() => 'g-new');
    usePlannerStore.setState({ addGoal });
    newContainer('goal', { title: 'Run a marathon' });
    fireEvent.click(screen.getByTestId('goal-dialog-color'));
    fireEvent.click(screen.getByRole('button', { name: 'Teal' }));
    fireEvent.click(screen.getByTestId('goal-dialog-add'));
    expect(addGoal).toHaveBeenCalledWith(expect.objectContaining({ color: 'var(--accent-2)' }));
  });

  it('submits on Enter from the title, and not with an empty name', () => {
    const addRoutine = vi.fn(() => 'r-new');
    usePlannerStore.setState({ addRoutine });
    newContainer('routine');
    const name = screen.getByTestId('routine-dialog-name');
    expect((screen.getByTestId('routine-dialog-add') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(addRoutine).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: 'Evenings' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(addRoutine).toHaveBeenCalledWith(expect.objectContaining({ name: 'Evenings', itemIds: [] }));
  });

  it('"Add & open" goes straight to the console on the new object', () => {
    usePlannerStore.setState({ addProgram: vi.fn(() => 'p-new') });
    newContainer('program', { title: 'Winter block' });
    fireEvent.click(screen.getByTestId('program-dialog-add-open'));
    expect(useUIStore.getState().activeDialog).toEqual({
      type: 'organize',
      section: 'programs',
      focusId: 'p-new',
    });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('holds a project name that is already taken, case-folded', () => {
    seed({ projects: [{ id: 'p1', name: 'Work', emoji: '' }] });
    newContainer('project', { title: 'work' });
    expect(screen.getByTestId('container-dialog-problem').textContent).toBe(
      'You already have a project called Work.'
    );
    expect((screen.getByTestId('project-dialog-add') as HTMLButtonElement).disabled).toBe(true);
  });

  it('holds a project name the Trash is keeping', async () => {
    trashed.projects = [{ id: 'p9', name: 'Garden' }];
    newContainer('project', { title: 'Garden' });
    expect((await screen.findByTestId('container-dialog-problem')).textContent).toContain('Trash');
    expect((screen.getByTestId('project-dialog-add') as HTMLButtonElement).disabled).toBe(true);
  });

  it('waits out the load window and a missing table', () => {
    seed({ isLoading: true });
    newContainer('goal', { title: 'Run a marathon' });
    expect((screen.getByTestId('goal-dialog-add') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    seed({ collectionsAvailable: false });
    newContainer('routine', { title: 'Mornings' });
    expect((screen.getByTestId('routine-dialog-add') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers no console door for a project while the console is off', () => {
    disableExtensions(EXT_ORGANIZE);
    newContainer('project', { title: 'Garden' });
    expect(screen.queryByTestId('project-dialog-add-open')).toBeNull();
    expect((screen.getByTestId('project-dialog-add') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('programRunsCopy', () => {
  const today = '2026-09-25';
  it('says what the dates will do, and nothing without them', () => {
    expect(programRunsCopy('2026-10-06', '2026-12-14', today)).toMatch(
      /^It switches on by itself on Oct 6 and off after Dec 14\.$/
    );
    expect(programRunsCopy('2026-10-06', undefined, today)).toMatch(/on Oct 6\.$/);
    expect(programRunsCopy(undefined, '2026-12-14', today)).toMatch(/^It's on now/);
    expect(programRunsCopy('2026-09-01', '2026-09-10', today)).toMatch(/already over/);
    expect(programRunsCopy(undefined, undefined, today)).toBeNull();
  });
});

/* ── the store and the palette ─────────────────────────────────────────── */

describe('store and palette', () => {
  it('addProject answers with the new id, writes extras in the same row, and null on a clash', () => {
    seed({ userId: null, projects: [] });
    const id = usePlannerStore.getState().addProject('Deep work', 'icon:Star', { color: 'var(--accent-2)' });
    expect(typeof id).toBe('string');
    expect(usePlannerStore.getState().projects).toEqual([
      expect.objectContaining({ id, name: 'Deep work', emoji: 'icon:Star', color: 'var(--accent-2)' }),
    ]);
    expect(usePlannerStore.getState().addProject('deep WORK', '')).toBeNull();
    expect(usePlannerStore.getState().projects).toHaveLength(1);
  });

  it('reserves the organizer nouns for new item types', () => {
    seed({ userId: null, itemTypes: [] });
    for (const name of ['goal', 'routine', 'program', 'project']) {
      usePlannerStore.getState().addItemType({ name, label: name, labelPlural: `${name}s` });
    }
    expect(usePlannerStore.getState().itemTypes).toEqual([]);
  });

  it('adds New goal / routine / program to the palette, each behind its gate', () => {
    const ctx: CommandContext = {
      theme: { resolved: 'light', value: 'light', set: () => {} },
      openChat: () => {},
      userId: 'u1',
      isMobile: false,
    };
    const goal = findCommand('create.goal', ctx)!;
    expect(goal.label).toBe('New goal');
    expect(goal.shortcut).toBeUndefined();
    goal.run(ctx, undefined);
    expect(useUIStore.getState().activeDialog).toEqual({ type: 'new-container', kind: 'goal' });

    disableExtensions(EXT_ORGANIZE);
    expect(findCommand('create.routine', ctx)!.availableWhen?.(ctx)).toBe(false);
    expect(findCommand('create.program', ctx)!.availableWhen?.(ctx)).toBe(false);
    expect(findCommand('create.goal', ctx)!.availableWhen?.(ctx)).toBe(true);
  });
});
