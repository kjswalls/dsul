// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * EVERY FIELD AT BIRTH (Kirby, 2026-09-26).
 *
 * The "new" dialog and the console's "+ New" render one body
 * (organize/container-fields.tsx). Pinned here:
 *
 *  1. Status, dates, colour, the why and every membership arrive in ONE add.
 *  2. The verbs' own write rules apply at birth: a paused routine carries the
 *     pause columns resolvePauseWrite would write, an achieved goal its stamp.
 *  3. The body says what creating will do to the user's day, from the resolver.
 *  4. The member pickers own their keys inside the dialog: Enter in a search box
 *     never creates the container, Escape closes the picker, not the dialog.
 *  5. The console's create pane is the same body.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useParams: () => ({}),
}));

vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  fetchTrashedNames: vi.fn(async () => ({ projects: [] })),
  fetchItemEvents: vi.fn(async () => []),
  getItemEventsAvailable: () => false,
  // The writes a signed-in create makes — stubbed, never the network.
  createItem: vi.fn(async () => {}),
  createGoal: vi.fn(async () => {}),
  createRoutine: vi.fn(async () => {}),
  createProgram: vi.fn(async () => {}),
  updateProgram: vi.fn(async () => {}),
}));

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

vi.mock('vaul', () => ({
  Drawer: {
    Root: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Overlay: () => null,
    Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Title: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    Description: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
    Close: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
    Handle: () => null,
  },
}));

import { ContainerDialog } from '@/components/planner/container-dialog';
import { OrganizeConsole } from '@/components/planner/organize/organize-console';
import {
  buildGoal,
  buildProgram,
  buildRoutine,
  draftConsequence,
  initialDraft,
} from '@/components/planner/organize/container-fields';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore, type NewContainerKind } from '@/lib/ui-store';
import { EXT_GOALS, EXT_ORGANIZE } from '@/lib/extension-registry';
import { enableExtensions } from './support/extensions';
import type { Item, Routine } from '@/lib/planner-types';

const habit = (id: string, title: string): Item =>
  ({
    id,
    type: 'habit',
    title,
    status: 'pending',
    repeatFrequency: 'daily',
    completedDates: [],
    skippedDates: [],
    streak: 0,
  }) as unknown as Item;

const task = (id: string, title: string, extra: Record<string, unknown> = {}): Item =>
  ({ id, type: 'task', title, status: 'pending', order: 0, isScheduled: false, ...extra }) as Item;

const seed = (over: Record<string, unknown> = {}) =>
  usePlannerStore.setState({
    items: [habit('h1', 'Stretch'), habit('h2', 'Journal'), task('t1', 'Run a 10k', { startDate: '2026-10-10' })],
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

// Tests swap store actions for spies; put the real ones back each time.
const pristine = usePlannerStore.getState();

beforeEach(() => {
  usePlannerStore.setState(pristine, true);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));
  enableExtensions(EXT_GOALS, EXT_ORGANIZE);
  seed();
  toastMock.mockClear();
  useUIStore.setState({ activeDialog: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const TODAY = '2026-09-26';
const NOW = '2026-09-26T12:00:00.000Z';

const newContainer = (kind: NewContainerKind, title = 'Mornings', onOpenChange = vi.fn()) =>
  render(<ContainerDialog state={{ kind, title }} onOpenChange={onOpenChange} />);

const id = (t: string) => screen.getByTestId(t);
const click = (t: string) => fireEvent.click(id(t));

/** Open a member section's picker and pick one candidate by title. */
function link(prefix: string, title: string) {
  // The picker stays open across adds (member-list.tsx), so only open it once.
  if (!screen.queryByTestId(`${prefix}-member-search`)) click(`${prefix}-member-add`);
  const row = screen
    .getAllByTestId(`${prefix}-member-candidate`)
    .find((b) => b.textContent?.includes(title));
  fireEvent.click(row!);
}

/* ── the builders ───────────────────────────────────────────────────────── */

describe('the builders', () => {
  it('stamps a goal born achieved, and leaves an active one unstamped', () => {
    const d = { ...initialDraft('goal', TODAY), goalState: 'achieved' as const };
    expect(buildGoal('Ship it', undefined, d, NOW)).toMatchObject({ state: 'achieved', achievedAt: NOW });
    const active = buildGoal('Ship it', undefined, initialDraft('goal', TODAY), NOW);
    expect(active.state).toBe('active');
    expect(active.achievedAt).toBeUndefined();
  });

  it('gives a routine born paused the pause columns the verb writes', () => {
    const d = { ...initialDraft('routine', TODAY), routinePaused: true, pausedUntil: '2026-10-05' };
    expect(buildRoutine('Mornings', undefined, d, TODAY, NOW, 'UTC')).toMatchObject({
      pausedAt: NOW,
      pausedUntil: '2026-10-05',
    });
    const live = buildRoutine('Mornings', undefined, initialDraft('routine', TODAY), TODAY, NOW, 'UTC');
    expect(live.pausedAt).toBeUndefined();
  });

  it('never turns a stale resume date into an endless pause', () => {
    // Picked as "tomorrow", then the dialog sat open past midnight.
    const d = { ...initialDraft('routine', TODAY), routinePaused: true, pausedUntil: TODAY };
    expect(buildRoutine('Mornings', undefined, d, TODAY, NOW, 'UTC').pausedUntil).toBe('2026-09-27');
  });

  it('keeps a program\'s dates under a manual state, as the row does', () => {
    const d = { ...initialDraft('program', TODAY), programState: 'paused' as const, startsOn: '2026-10-01' };
    expect(buildProgram('Term', undefined, d)).toMatchObject({ state: 'paused', startsOn: '2026-10-01' });
  });
});

describe('draftConsequence', () => {
  const items = [habit('h1', 'Stretch'), habit('h2', 'Journal')];

  it('counts what a paused routine or an off program would hide', () => {
    const d = { ...initialDraft('routine', TODAY), routinePaused: true, itemIds: ['h1', 'h2'] };
    expect(draftConsequence('routine', d, { items, routines: [], programs: [] }, TODAY, NOW, 'UTC')).toEqual({
      hides: 2,
      shows: 0,
    });
    const off = { ...initialDraft('program', TODAY), programState: 'paused' as const, itemIds: ['h1'] };
    expect(draftConsequence('program', off, { items, routines: [], programs: [] }, TODAY, NOW, 'UTC')).toEqual({
      hides: 1,
      shows: 0,
    });
  });

  it('counts an item a paused routine hides that a live new one would carry back', () => {
    const paused: Routine = { id: 'r1', name: 'Old', pausedAt: '2026-09-01T00:00:00Z', itemIds: ['h1'] };
    const d = { ...initialDraft('routine', TODAY), itemIds: ['h1'] };
    expect(
      draftConsequence('routine', d, { items, routines: [paused], programs: [] }, TODAY, NOW, 'UTC')
    ).toEqual({ hides: 0, shows: 1 });
  });

  it('counts liveness, not today\'s open loops — a habit ticked today and undated work both count', () => {
    const ticked = habit('h1', 'Stretch');
    (ticked as unknown as { completedDates: string[] }).completedDates = [TODAY];
    const undated = task('t9', 'Someday');
    const d = { ...initialDraft('routine', TODAY), routinePaused: true, itemIds: ['h1', 't9'] };
    expect(
      draftConsequence('routine', d, { items: [ticked, undated], routines: [], programs: [] }, TODAY, NOW, 'UTC')
    ).toEqual({ hides: 2, shows: 0 });
  });

  it('says nothing for a goal, which never hides', () => {
    const d = { ...initialDraft('goal', TODAY), memberIds: ['h1'] };
    expect(draftConsequence('goal', d, { items, routines: [], programs: [] }, TODAY, NOW, 'UTC')).toEqual({
      hides: 0,
      shows: 0,
    });
  });
});

/* ── the dialog ─────────────────────────────────────────────────────────── */

describe('the "new" dialog, every field', () => {
  it('creates a paused routine with its items in ONE addRoutine', () => {
    const addRoutine = vi.fn(() => 'r-new');
    usePlannerStore.setState({ addRoutine });
    newContainer('routine');

    link('routine-dialog-items', 'Stretch');
    link('routine-dialog-items', 'Journal');
    click('routine-dialog-state-chip');
    click('routine-dialog-state-paused');
    expect(id('routine-dialog-note-hides').textContent).toContain('puts 2 items on hold');

    click('routine-dialog-add');
    expect(addRoutine).toHaveBeenCalledTimes(1);
    expect(addRoutine).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Mornings', itemIds: ['h1', 'h2'], pausedAt: NOW })
    );
  });

  it('links a milestone to a new goal, and offers it to no other role', () => {
    const addGoal = vi.fn(() => 'g-new');
    usePlannerStore.setState({ addGoal });
    newContainer('goal', 'Run a half');

    link('goal-dialog-milestones', 'Run a 10k');
    // The supporting-work picker must not offer the item already a milestone.
    click('goal-dialog-supporting-member-add');
    const offered = screen
      .queryAllByTestId('goal-dialog-supporting-member-candidate')
      .map((b) => b.getAttribute('data-item-id'));
    expect(offered).toEqual(['h1', 'h2']);

    click('goal-dialog-add');
    expect(addGoal).toHaveBeenCalledWith(
      expect.objectContaining({ milestoneIds: ['t1'], memberIds: [], checkinIds: [], state: 'active' })
    );
  });

  it('shows the empty sections as prompts, not a blank form', () => {
    newContainer('goal', 'Run a half');
    expect(id('goal-dialog-milestones-empty-hint')).toBeTruthy();
    expect(id('goal-dialog-checkins-empty-hint')).toBeTruthy();
    expect(id('goal-dialog-supporting-empty-hint')).toBeTruthy();
  });

  it('never creates from an Enter inside a member search box', () => {
    const addRoutine = vi.fn(() => 'r-new');
    usePlannerStore.setState({ addRoutine });
    newContainer('routine');
    click('routine-dialog-items-member-add');
    const search = id('routine-dialog-items-member-search');
    fireEvent.change(search, { target: { value: 'zzz no match' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(addRoutine).not.toHaveBeenCalled();
  });

  it('never creates from a plain Enter in the why, and does from ⌘-Enter', () => {
    const addGoal = vi.fn(() => 'g-new');
    usePlannerStore.setState({ addGoal });
    newContainer('goal', 'Run a half');
    const why = id('goal-dialog-why');
    fireEvent.change(why, { target: { value: 'For Sam' } });
    fireEvent.keyDown(why, { key: 'Enter' });
    expect(addGoal).not.toHaveBeenCalled();
    fireEvent.keyDown(why, { key: 'Enter', metaKey: true });
    expect(addGoal).toHaveBeenCalledWith(expect.objectContaining({ why: 'For Sam' }));
  });

  it('closes an open picker on Escape before it closes the dialog', () => {
    const onOpenChange = vi.fn();
    newContainer('routine', 'Mornings', onOpenChange);
    click('routine-dialog-items-member-add');
    fireEvent.keyDown(id('routine-dialog-items-member-search'), { key: 'Escape' });
    expect(screen.queryByTestId('routine-dialog-items-member-search')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    // The control: with nothing left to claim it, Escape DOES close — so the
    // assertion above is about the ladder, not an Escape that goes nowhere.
    fireEvent.keyDown(id('routine-dialog-name'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says when a new live routine gives a held item a path back', () => {
    seed({ routines: [{ id: 'r1', name: 'Old', pausedAt: '2026-09-01T00:00:00Z', itemIds: ['h1'] }] });
    newContainer('routine');
    link('routine-dialog-items', 'Stretch');
    expect(id('routine-dialog-note-shows').textContent).toContain('1 item on hold comes back');
  });

  it('stamps a goal made Achieved through the status chip', () => {
    const addGoal = vi.fn(() => 'g-new');
    usePlannerStore.setState({ addGoal });
    newContainer('goal', 'Ran a 5k');
    click('goal-dialog-state-chip');
    click('goal-dialog-state-achieved');
    click('goal-dialog-add');
    expect(addGoal).toHaveBeenCalledWith(expect.objectContaining({ state: 'achieved', achievedAt: NOW }));
  });

  it('asks a program for its status, and says an Off program hides what it holds', () => {
    const addProgram = vi.fn(() => 'p-new');
    usePlannerStore.setState({ addProgram });
    newContainer('program', 'Autumn term');
    link('program-dialog-items', 'Stretch');
    click('program-dialog-state-chip');
    click('program-dialog-state-paused');
    // Off: the Runs range has no effect, so it is not offered.
    expect(screen.queryByTestId('program-dialog-runs-chip')).toBeNull();
    expect(id('program-dialog-note-hides').textContent).toContain('puts 1 item on hold');
    click('program-dialog-add');
    expect(addProgram).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'paused', itemIds: ['h1'], routineIds: [] })
    );
  });
});

/* ── the console mirrors it ─────────────────────────────────────────────── */

describe('the console "+ New"', () => {
  it('is the same body, and writes its members in the one add', () => {
    seed({ routines: [{ id: 'r0', name: 'Older', itemIds: [] }] });
    const addRoutine = vi.fn(() => 'r-new');
    usePlannerStore.setState({ addRoutine });
    render(<OrganizeConsole open onOpenChange={() => {}} section="routines" />);
    click('routine-new');
    expect(id('routine-new-fields')).toBeTruthy();
    fireEvent.change(id('routine-new-name'), { target: { value: 'Evenings' } });
    link('routine-new-items', 'Journal');
    click('routine-add');
    expect(addRoutine).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Evenings', itemIds: ['h2'] })
    );
  });
});

/* ── the store ──────────────────────────────────────────────────────────── */

describe('addRoutine at birth', () => {
  it('records a release when its members come back, as an edit would', async () => {
    const { clearReleased, releasedOn } = await import('@/lib/sweep-grace');
    clearReleased();
    seed({
      userId: null,
      items: [task('t1', 'Taxes', { startDate: TODAY, isScheduled: true, timeBucket: 'morning' })],
      routines: [{ id: 'r1', name: 'Old', pausedAt: '2026-09-01T00:00:00Z', itemIds: ['t1'] }],
    });
    usePlannerStore.getState().addRoutine({ name: 'New', itemIds: ['t1'] });
    expect(releasedOn('t1')).toBe(TODAY);
  });
});

describe('addGoal', () => {
  it('refuses an item given two roles, rather than showing a goal the database refuses', () => {
    seed({ userId: null });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const made = usePlannerStore.getState().addGoal({
      name: 'Twice',
      state: 'active',
      memberIds: ['t1'],
      milestoneIds: ['t1'],
      checkinIds: [],
    });
    expect(made).toBe('');
    expect(usePlannerStore.getState().goals).toEqual([]);
    errors.mockRestore();
  });
});

describe('new items and programs at birth', () => {
  it('creates a typed-in milestone and links it, in ONE undo entry', () => {
    seed({ items: [] });
    newContainer('goal', 'Half marathon');
    const field = id('goal-dialog-create-milestone-new-name');
    fireEvent.change(field, { target: { value: 'Run a 10k' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(id('goal-dialog-create-milestone-row').textContent).toContain('Run a 10k');
    // Nothing exists until the goal is created.
    expect(usePlannerStore.getState().items).toEqual([]);

    const before = usePlannerStore.getState().actionLog.length;
    click('goal-dialog-add');
    const s = usePlannerStore.getState();
    const made = s.items.find((i) => i.title === 'Run a 10k')!;
    expect(made).toMatchObject({ type: 'task', status: 'pending' });
    expect(s.goals[0]).toMatchObject({ name: 'Half marathon', milestoneIds: [made.id] });
    // The item and the goal arrive as ONE history entry.
    expect(s.actionLog.length - before).toBe(1);
    expect(s.actionLog[0].label).toBe('Add goal: Half marathon'); // newest first
  });

  it('drops a typed-in item the user takes back before creating', () => {
    seed({ items: [] });
    newContainer('routine');
    const field = id('routine-dialog-create-item-new-name');
    fireEvent.change(field, { target: { value: 'Floss' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    click('routine-dialog-create-item-remove');
    click('routine-dialog-add');
    expect(usePlannerStore.getState().items).toEqual([]);
  });

  it('puts a new routine into a program, and says when that program is off', () => {
    const addRoutine = vi.fn(() => 'r-new');
    seed({
      programs: [{ id: 'p1', name: 'Summer', state: 'paused', itemIds: [], routineIds: [] }],
    });
    usePlannerStore.setState({ addRoutine });
    newContainer('routine');
    link('routine-dialog-items', 'Stretch');
    click('routine-dialog-program');
    expect(id('routine-dialog-note-hides').textContent).toContain('puts 1 item on hold');
    click('routine-dialog-add');
    expect(addRoutine).toHaveBeenCalledWith(
      expect.objectContaining({ itemIds: ['h1'] }),
      expect.objectContaining({ programIds: ['p1'] })
    );
  });
});
