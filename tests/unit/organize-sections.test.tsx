import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { OrganizeConsole } from '@/components/planner/organize/organize-console';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { enableGoalsAndOrganize } from './support/extensions';
import { accentColorForName } from '@/lib/accent-colors';
import { ITEM_TYPES } from '@/lib/item-registry';
import type { Item, Program, Project, Routine } from '@/lib/planner-types';

/**
 * The Organize console's SECTION BODIES (memory/plans/organize-console.md,
 * Phase 2). The frame's own contracts live in organize-console.test.tsx.
 *
 * What these are for: every sentence this console shows before a destructive or
 * non-obvious write is computed, and each one is wrong in a different way if its
 * expression drifts from the store action it describes. The delete copy in the
 * dialogs this replaces was wrong three separate ways for a year — silently,
 * because nothing asserted it. So the copy is pinned here, not just the wiring.
 */

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

/* ── fixtures ─────────────────────────────────────────────────────────── */

const TODAY = '2026-08-12';

const habit = (id: string, title: string, extra: Partial<Item> = {}): Item =>
  ({
    id,
    type: 'habit',
    title,
    status: 'pending',
    repeatFrequency: 'daily',
    completedDates: [],
    skippedDates: [],
    streak: 0,
    project: 'Personal',
    order: 0,
    isScheduled: false,
    ...extra,
  }) as Item;

const task = (id: string, title: string, extra: Partial<Item> = {}): Item =>
  ({ id, type: 'task', title, status: 'pending', order: 0, isScheduled: false, ...extra }) as Item;

const routine = (id: string, name: string, extra: Partial<Routine> = {}): Routine => ({
  id,
  name,
  itemIds: [],
  ...extra,
});

const program = (id: string, name: string, extra: Partial<Program> = {}): Program => ({
  id,
  name,
  state: 'auto',
  itemIds: [],
  routineIds: [],
  ...extra,
});

/** A pause that started yesterday, so isPausedOn's lower bound is satisfied. */
const PAUSED_AT = '2026-08-11T09:00:00.000Z';

type StoreState = ReturnType<typeof usePlannerStore.getState>;

function seed(state: Partial<StoreState>) {
  usePlannerStore.setState({
    items: [],
    routines: [],
    programs: [],
    projects: [],
    itemTypes: [],
    collectionsAvailable: true,
    itemTypesAvailable: true,
    isLoading: false,
    userId: 'u1',
    userTimezone: 'UTC',
    ...state,
  });
}

const open = (section: string) =>
  render(<OrganizeConsole open onOpenChange={() => {}} section={section} />);

const id = (testId: string) => screen.getByTestId(testId);
const maybe = (testId: string) => screen.queryByTestId(testId);
const click = (testId: string) => fireEvent.click(id(testId));

/**
 * Drive a Radix Select the way a user does, rather than calling its
 * `onValueChange` directly — the bug this exists to catch was a CONTROLLED value
 * snapping back, which a synthetic handler call cannot reproduce because it
 * never re-renders the trigger. Opens on pointerdown (setup.ts stubs the pointer
 * capture jsdom lacks) and picks by option role, since the trigger renders the
 * selected label too and a bare text query would match both.
 */
const pick = (triggerTestId: string, option: string) => {
  fireEvent.pointerDown(id(triggerTestId), { pointerType: 'mouse', button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole('option', { name: option }));
};

/**
 * Pick from a status chip — a PropertyChip popover, which opens on click. The
 * option ids are `${chip prefix}-${value}` and only exist while it is open.
 */
const choose = (chipPrefix: string, value: string) => {
  click(`${chipPrefix}-chip`);
  click(`${chipPrefix}-${value}`);
};

/**
 * The delete sentence, as the confirm behind the pane's ⋯ menu states it. The
 * goal, program and routine panes carry their delete there (2026-09-25), so
 * the consequence is said once, in the prompt, instead of under a red zone.
 * Radix's DropdownMenuTrigger opens on pointerdown; the pane runs the action
 * once the menu has closed, which FocusScope schedules on a timer.
 */
const deleteSentence = (prefix: string): string => {
  fireEvent.pointerDown(id(`${prefix}-more`), { pointerType: 'mouse', button: 0, ctrlKey: false });
  click(`${prefix}-delete`);
  // Not yet: the confirm waits for the menu to hand focus back, or the menu's
  // focus return would land after the dialog opened and steal its focus.
  expect(useUIStore.getState().confirmRequest).toBeNull();
  act(() => {
    vi.runOnlyPendingTimers();
  });
  const request = useUIStore.getState().confirmRequest;
  expect(request).not.toBeNull();
  return String(request?.description ?? '');
};

beforeEach(() => {
  // The sections are the console's, and the console ships off — see
  // tests/unit/support/extensions.ts for why this is stated per suite.
  enableGoalsAndOrganize();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
  useUIStore.setState({ confirmRequest: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/* ── routines ─────────────────────────────────────────────────────────── */

describe('the routines section', () => {
  it('counts only members that still resolve', () => {
    // Member ids may name a TRASHED item — join rows outlive a soft delete by
    // design — so a raw `.length` would put "3" on the row and "1" in the detail
    // one click away, and the console would disagree with itself permanently.
    seed({
      items: [habit('i1', 'Stretch')],
      routines: [routine('r1', 'Morning', { itemIds: ['i1', 'gone-1', 'gone-2'] })],
    });
    open('routines');
    expect(within(id('routine-row')).getByText('1')).toBeInTheDocument();
  });

  it('labels a paused routine with its return date, and nothing when it is live', () => {
    seed({
      routines: [
        routine('r1', 'Morning', { pausedAt: PAUSED_AT, pausedUntil: '2026-09-01' }),
        routine('r2', 'Evening'),
      ],
    });
    open('routines');
    // Only the exception is labelled — a live container wears no marker at all.
    expect(screen.getAllByTestId('routine-paused-pill')).toHaveLength(1);
    expect(screen.getByTestId('routine-paused-pill')).toHaveTextContent('Until Sep 1');
  });

  it('offers the resume date only while paused', () => {
    seed({ routines: [routine('r1', 'Morning')] });
    open('routines');
    click('routine-row');

    // Live: no resume field, because a return date on something that is on is a
    // control with nothing to do.
    expect(maybe('routine-resume')).toBeNull();

    choose('routine-state', 'paused');
    expect(usePlannerStore.getState().routines[0].pausedAt).toBeTruthy();
    expect(id('routine-resume')).toBeInTheDocument();
  });

  /**
   * Driven against the REAL store action, deliberately.
   *
   * The first version of this test replaced setRoutinePaused with a vi.fn() and
   * asserted the call — which passed while the control wrote nothing at all,
   * because the store's idempotence guard rejected every call the field could
   * make. A spy proves the button is wired to a name; only the real action
   * proves the column moved.
   */
  it('clears the resume date through the store, not just the spy', () => {
    seed({
      routines: [routine('r1', 'Morning', { pausedAt: PAUSED_AT, pausedUntil: '2026-09-01' })],
    });
    open('routines');
    click('routine-row');
    expect(id('routine-resume')).toHaveTextContent('Sep 1');

    // The clear lives under the chip's calendar.
    click('routine-resume');
    click('routine-resume-clear');
    expect(usePlannerStore.getState().routines[0].pausedUntil).toBeUndefined();
    // Still paused — clearing the return date is not a resume.
    expect(usePlannerStore.getState().routines[0].pausedAt).toBe(PAUSED_AT);
    expect(id('routine-paused-note')).toHaveTextContent('hidden until you resume');
  });

  it('shows the resume field and its note once the routine is paused', () => {
    seed({
      routines: [routine('r1', 'Morning', { pausedAt: PAUSED_AT, pausedUntil: '2026-09-01' })],
    });
    open('routines');
    click('routine-row');
    expect(id('routine-resume')).toHaveTextContent('Sep 1');
    expect(id('routine-paused-note')).toHaveTextContent(
      'Its items come back on Sep 1, on their own.'
    );
    // Streaks and history are untouched by a pause, and the note has to say so —
    // it is the single most common reason people refuse to pause anything.
    expect(id('routine-paused-note')).toHaveTextContent('Streaks and history stay exactly as they are');
  });

  it('says a paused routine’s items come back when it is deleted', () => {
    // "Delete" reads as subtraction, and here it ADDS rows back to the grid.
    seed({
      items: [habit('i1', 'Stretch'), habit('i2', 'Read')],
      routines: [
        routine('r1', 'Morning', { itemIds: ['i1', 'i2'], pausedAt: PAUSED_AT }),
      ],
    });
    open('routines');
    click('routine-row');
    const sentence = deleteSentence('routine');
    expect(sentence).toContain('its 2 items stay exactly as they are');
    expect(sentence).toContain('they come back into view');
  });

  it('drops the come-back clause when the routine was never hiding anything', () => {
    seed({
      items: [habit('i1', 'Stretch')],
      routines: [routine('r1', 'Morning', { itemIds: ['i1'] })],
    });
    open('routines');
    click('routine-row');
    const sentence = deleteSentence('routine');
    expect(sentence).toContain('its 1 item stays exactly as it is');
    expect(sentence).not.toContain('come back into view');
  });
});

/* ── effective state (Phase 5b) ───────────────────────────────────────── */

describe('a routine a program is holding off', () => {
  /**
   * The correctness fix this phase exists for.
   *
   * `RoutineDetail` resolved `isPausedOn` alone — the routine's OWN switch — so
   * a routine held off by a program rendered `Active`, with its members at full
   * contrast and a delete confirm that said nothing about items reappearing,
   * while the ScopeRail one column away reported it off. Both were reading the
   * same store; only one of them was resolving the whole rule.
   *
   * `off` here is a program whose season has passed, so `isProgramActiveOn`
   * returns false for a reason with no manual flag involved — the case a
   * `state === 'paused'` check would have missed.
   */
  const held = () =>
    seed({
      items: [habit('i1', 'Stretch'), habit('i2', 'Read')],
      routines: [routine('r1', 'Morning', { itemIds: ['i1', 'i2'] })],
      programs: [
        program('p1', 'Summer', { routineIds: ['r1'], startsOn: '2026-06-01', endsOn: '2026-07-31' }),
      ],
    });

  it('keeps the switch on LOCAL truth — that is the value it writes', () => {
    held();
    open('routines');
    click('routine-row');
    // Rendering this as Paused would be a lie about the stored value, and
    // turning the program back on would hand back a routine the user believes
    // they switched off.
    expect(id('routine-state-chip')).toHaveTextContent('Active');
    click('routine-state-chip');
    expect(id('routine-state-active')).toHaveAttribute('data-selected');
    expect(id('routine-state-paused')).not.toHaveAttribute('data-selected');
    // And no resume field, which belongs to the routine's own pause.
    expect(maybe('routine-resume')).toBeNull();
  });

  it('says who is overruling it, and when its items come back', () => {
    seed({
      items: [habit('i1', 'Stretch')],
      routines: [routine('r1', 'Morning', { itemIds: ['i1'] })],
      // Starts in the future, so programResumeDate has a date to give.
      programs: [program('p1', 'Summer', { routineIds: ['r1'], startsOn: '2026-09-01' })],
    });
    open('routines');
    click('routine-row');
    const note = id('routine-held-note');
    expect(note).toHaveTextContent('“Summer” is off');
    // Two subjects, two sentences: the ROUTINE is not carrying, and a counted
    // number of its ITEMS are actually hidden. Running them together is what
    // made this note lie about members another path was still carrying.
    expect(note).toHaveTextContent('this routine isn’t carrying anything');
    expect(note).toHaveTextContent('1 item is hidden');
    expect(note).toHaveTextContent('Sep 1');
  });

  it('promises no date when the blocking program has none to give', () => {
    seed({
      items: [habit('i1', 'Stretch')],
      routines: [routine('r1', 'Morning', { itemIds: ['i1'] })],
      // Switched off by hand: no scheduled return exists, and inventing one is
      // the exact failure the binding-constraint rule guards against.
      programs: [program('p1', 'Summer', { routineIds: ['r1'], state: 'paused' })],
    });
    open('routines');
    click('routine-row');
    expect(id('routine-held-note')).toHaveTextContent('when one of those programs does');
  });

  it('stays quiet while ANY holder is carrying it', () => {
    // Disjunctive, exactly as the resolver: one live program is enough, however
    // many others are off. Naming "Summer" here would report a suppression that
    // is not happening.
    seed({
      items: [habit('i1', 'Stretch')],
      routines: [routine('r1', 'Morning', { itemIds: ['i1'] })],
      programs: [
        program('p1', 'Summer', { routineIds: ['r1'], startsOn: '2026-06-01', endsOn: '2026-07-31' }),
        program('p2', 'Term', { routineIds: ['r1'], state: 'active' }),
      ],
    });
    open('routines');
    click('routine-row');
    expect(maybe('routine-held-note')).toBeNull();
  });

  it('counts the blockers rather than naming them all', () => {
    seed({
      items: [habit('i1', 'Stretch')],
      routines: [routine('r1', 'Morning', { itemIds: ['i1'] })],
      programs: [
        program('p1', 'Summer', { routineIds: ['r1'], state: 'paused' }),
        program('p2', 'Term', { routineIds: ['r1'], state: 'paused' }),
      ],
    });
    open('routines');
    click('routine-row');
    expect(id('routine-held-note')).toHaveTextContent('All 2 programs holding it are off');
  });

  it('warns that deleting it puts the items BACK, which the local check missed', () => {
    held();
    open('routines');
    click('routine-row');
    // Deleting the routine removes the whole activation path, so these items
    // are on screen again the moment it goes — and the old copy, keyed on the
    // local pause, said nothing at all.
    expect(deleteSentence('routine')).toContain('they come back into view');
  });

  it('greys the members on EFFECTIVE state, not the local switch', () => {
    held();
    open('routines');
    click('routine-row');
    const rows = screen.getAllByTestId('routine-member');
    for (const row of rows) {
      expect(within(row).getByTitle(/Stretch|Read/)).toHaveClass('text-muted-foreground');
    }
  });
});

describe('a member the routine is NOT the only path to', () => {
  /**
   * The review's HIGH, and it is the branch's signature failure again: the false
   * claim was inside the longest comment the phase added.
   *
   * `routineStandingOn` answers "is THIS ROUTINE carrying anything". The pane
   * spent that answer as "is THIS ITEM on the grid". Those differ exactly when
   * an item has a second live path — which is the situation the disjunctive rule
   * exists to create, so it is not an exotic case.
   *
   * The repo already had the right shape: `wouldHide` in programs.tsx answers
   * with an `inactiveItemIdsOn` DELTA rather than a container's own state.
   */
  const twoRoutines = () =>
    seed({
      items: [habit('i1', 'Stretch')],
      routines: [
        routine('r1', 'Morning', { itemIds: ['i1'] }),
        routine('r2', 'Evening', { itemIds: ['i1'] }),
      ],
      // Holds Morning only, and is out of season.
      programs: [
        program('p1', 'Summer', { routineIds: ['r1'], startsOn: '2026-06-01', endsOn: '2026-07-31' }),
      ],
    });

  it('does not grey an item that another routine is still carrying', () => {
    twoRoutines();
    open('routines');
    fireEvent.click(screen.getAllByTestId('routine-row')[0]); // Morning
    expect(within(id('routine-member')).getByTitle('Stretch')).toHaveClass('text-foreground');
  });

  it('does not promise a delete will bring back what never left', () => {
    twoRoutines();
    open('routines');
    fireEvent.click(screen.getAllByTestId('routine-row')[0]);
    expect(deleteSentence('routine')).not.toContain('come back into view');
  });

  it('says the routine is not carrying them, without claiming they are hidden', () => {
    twoRoutines();
    open('routines');
    fireEvent.click(screen.getAllByTestId('routine-row')[0]);
    const note = id('routine-held-note');
    // Both halves have to be true at once: the ROUTINE really is held off (that
    // is the local/effective split, and it is worth saying), and its items
    // really are still on the user's day.
    expect(note).toHaveTextContent('“Summer” is off');
    expect(note).not.toHaveTextContent('hidden');
    expect(note).toHaveTextContent('still on your day');
  });

  it('does not promise a return for an item a SECOND path keeps hidden', () => {
    // The other direction: deleting this routine changes nothing, because the
    // program holds the item directly too.
    seed({
      items: [habit('i1', 'Stretch')],
      routines: [routine('r1', 'Morning', { itemIds: ['i1'] })],
      programs: [
        program('p1', 'Summer', { routineIds: ['r1'], itemIds: ['i1'], state: 'paused' }),
      ],
    });
    open('routines');
    click('routine-row');
    expect(deleteSentence('routine')).not.toContain('come back into view');
    // …and it IS greyed, because it is genuinely not on the grid.
    expect(within(id('routine-member')).getByTitle('Stretch')).toHaveClass('text-muted-foreground');
  });
});

describe('IN N PROGRAMS — the reverse view', () => {
  const seeded = () =>
    seed({
      items: [habit('i1', 'Stretch')],
      routines: [routine('r1', 'Morning', { itemIds: ['i1'] })],
      programs: [
        program('p1', 'Summer', { routineIds: ['r1'], state: 'paused' }),
        program('p2', 'Term', { routineIds: ['r1'], state: 'active' }),
        program('p3', 'Other', { routineIds: [], state: 'active' }),
      ],
    });

  it('lists the holders and no one else, saying which is carrying it', () => {
    seeded();
    open('routines');
    click('routine-row');
    const rows = screen.getAllByTestId('routine-holder');
    expect(rows.map((r) => r.getAttribute('data-program-id'))).toEqual(['p1', 'p2']);
    expect(rows[0]).toHaveAttribute('data-holder-state', 'off');
    expect(rows[1]).toHaveAttribute('data-holder-state', 'carrying');
  });

  it('never says a live program is CARRYING a routine the user switched off', () => {
    // Both on one pane, three lines apart: "Its items are hidden until you
    // resume" above, and a holder row claiming to carry them below.
    seed({
      items: [habit('i1', 'Stretch')],
      routines: [routine('r1', 'Morning', { itemIds: ['i1'], pausedAt: PAUSED_AT })],
      programs: [program('p1', 'Term', { routineIds: ['r1'], state: 'active' })],
    });
    open('routines');
    click('routine-row');
    expect(id('routine-paused-note')).toBeInTheDocument();
    const row = id('routine-holder');
    expect(row).toHaveAttribute('data-holder-state', 'idle');
    expect(row).not.toHaveTextContent('carrying');
  });

  it('is absent entirely for a routine no program holds', () => {
    seed({
      items: [habit('i1', 'Stretch')],
      routines: [routine('r1', 'Morning', { itemIds: ['i1'] })],
    });
    open('routines');
    click('routine-row');
    expect(maybe('routine-holders')).toBeNull();
  });

  it('lands on that program, SELECTED — the point of the jump', () => {
    seeded();
    open('routines');
    click('routine-row');
    fireEvent.click(screen.getAllByTestId('routine-holder')[0]);

    // A section change through the rail clears the selection by design. This one
    // must not: arriving at the Programs list with nothing selected would make
    // the user find the program the previous screen just named.
    expect(id('program-detail')).toHaveAttribute('data-program-id', 'p1');
  });
});

/* ── programs ─────────────────────────────────────────────────────────── */

describe('the programs section', () => {
  it('counts routines as well as items', () => {
    // A program is usually built out of routines; counting only itemIds would
    // read as empty for the most common shape there is.
    seed({
      items: [task('i1', 'Plan')],
      routines: [routine('r1', 'Morning')],
      programs: [program('p1', 'Term', { itemIds: ['i1'], routineIds: ['r1'] })],
    });
    open('programs');
    expect(within(id('program-row')).getByText('2')).toBeInTheDocument();
  });

  it('renders the date range under Dates and nowhere else', () => {
    seed({ programs: [program('p1', 'Term', { state: 'active' })] });
    open('programs');
    click('program-row');
    // On and Off are manual overrides that always win, so pickers beside them
    // would be controls with no effect.
    expect(maybe('program-runs-chip')).toBeNull();

    choose('program-state', 'auto');
    expect(id('program-runs-chip')).toBeInTheDocument();
    click('program-runs-chip');
    expect(id('program-runs-start')).toBeInTheDocument();
    expect(id('program-runs-end')).toBeInTheDocument();
  });

  it.each([
    ['active' as const, {}, 'On until you say otherwise'],
    ['paused' as const, {}, 'Off. Everything it holds is hidden'],
    ['auto' as const, {}, 'Always on. Give it a start or an end'],
    ['auto' as const, { startsOn: '2026-06-01', endsOn: '2026-08-31' }, 'Runs Jun 1 to Aug 31, inclusive. On now.'],
    ['auto' as const, { startsOn: '2026-09-01' }, 'Runs from Sep 1, inclusive. Off right now'],
  ])('states what %s with %o actually means', (state, dates, expected) => {
    seed({ programs: [program('p1', 'Term', { state, ...dates })] });
    open('programs');
    click('program-row');
    expect(id('program-state-note')).toHaveTextContent(expected);
  });

  it('hides the swap verb when no other program is on', () => {
    // With nothing to switch away FROM, "Switch to this" and "On" would be the
    // same button wearing two labels.
    seed({ programs: [program('p1', 'Term', { state: 'paused' })] });
    open('programs');
    click('program-row');
    expect(maybe('program-swap')).toBeNull();
  });

  it('names what the swap would turn off', () => {
    seed({
      programs: [
        program('p1', 'Term', { state: 'paused' }),
        program('p2', 'Summer', { state: 'active' }),
      ],
    });
    open('programs');
    fireEvent.click(screen.getAllByTestId('program-row')[0]);
    expect(id('program-swap')).toHaveTextContent('Turns off Summer');
    // One gesture, one undo — swapToProgram writes every program in a single
    // set() precisely so this promise is true.
    expect(id('program-swap')).toHaveTextContent('One undo puts it all back');
  });

  it('confirms an attach only when it would really hide something', () => {
    // The count comes from a resolver DELTA, not from member arrays: an item
    // already hidden, or held by a second live path, must not be counted toward
    // a warning about work that will vanish.
    seed({
      items: [habit('i1', 'Stretch')],
      routines: [routine('r1', 'Morning', { itemIds: ['i1'] })],
      programs: [program('p1', 'Term', { state: 'paused' })],
    });
    open('programs');
    click('program-row');
    click('program-routine-add');
    click('program-routine-candidate');

    const request = useUIStore.getState().confirmRequest;
    expect(request?.title).toBe('This will hide 1 item for now');
    expect(request?.testId).toBe('program-routine-attach-confirm');
    // Nothing is written until it is answered.
    expect(usePlannerStore.getState().programs[0].routineIds).toEqual([]);
  });

  it('attaches straight through when the program is already on', () => {
    seed({
      items: [habit('i1', 'Stretch')],
      routines: [routine('r1', 'Morning', { itemIds: ['i1'] })],
      programs: [program('p1', 'Term', { state: 'active' })],
    });
    open('programs');
    click('program-row');
    click('program-routine-add');
    click('program-routine-candidate');

    expect(useUIStore.getState().confirmRequest).toBeNull();
    expect(usePlannerStore.getState().programs[0].routineIds).toEqual(['r1']);
  });

  it('never offers reorder controls on a program’s items', () => {
    // `program_items` has no sort_order column, so an order arranged here would
    // survive until the next fetch and then silently reshuffle.
    seed({
      items: [task('i1', 'Plan'), task('i2', 'Book')],
      programs: [program('p1', 'Term', { itemIds: ['i1', 'i2'] })],
    });
    open('programs');
    click('program-row');
    expect(screen.getAllByTestId('program-member')).toHaveLength(2);
    expect(maybe('program-member-up')).toBeNull();
    expect(maybe('program-member-down')).toBeNull();
  });
});

/* ── labels ───────────────────────────────────────────────────────────── */

describe('the label sections', () => {
  it('counts a container’s items, not its tasks', () => {
    // removeProject reaches EVERY type since 039 — a Goal and a habit filed
    // under this container are as much its members as the task is, so the noun
    // is "items" and the count includes all three. It was two before the
    // collapse, when a habit answered on the other half of the axis.
    seed({
      items: [
        task('i1', 'Plan', { project: 'Work' }),
        { ...task('i2', 'Ship'), type: 'custom', customType: 'goal', project: 'Work' } as Item,
        habit('i3', 'Stretch', { project: 'Work' }),
      ],
      projects: [{ id: 'pr1', name: 'Work', emoji: 'icon:Briefcase' }],
    });
    open('projects');
    expect(within(id('project-row')).getByText('3')).toBeInTheDocument();
    click('project-row');
    expect(id('project-meta')).toHaveTextContent('Project · 3 items');
  });

  it('names the container the habits will actually land in', () => {
    // The old habit-group copy claimed deleting "unassigns it from all habits".
    // It does not: a type whose container is REQUIRED is reassigned, and the
    // user was never told where. One delete action since 039, so the project
    // sentence has to carry both halves — most items are unfiled, habits move.
    seed({
      items: [habit('i1', 'Stretch', { project: 'Morning' })],
      projects: [
        { id: 'g1', name: 'Morning', emoji: 'icon:Sun' },
        { id: 'g2', name: 'Evening', emoji: 'icon:Moon' },
      ],
    });
    open('projects');
    fireEvent.click(screen.getAllByTestId('project-row')[0]);
    const zone = id('project-delete').closest('div')?.parentElement;
    expect(zone).toHaveTextContent('The habit moves to “Evening”');
    expect(zone).toHaveTextContent('⌘Z brings it back');
  });

  it('says nothing about a destination when no member needs one', () => {
    // A task is unfiled, not reassigned, so the sentence must not promise it a
    // new home. `containerRequired` is the whole difference.
    seed({
      items: [task('i1', 'Plan', { project: 'Morning' })],
      projects: [
        { id: 'g1', name: 'Morning', emoji: 'icon:Sun' },
        { id: 'g2', name: 'Evening', emoji: 'icon:Moon' },
      ],
    });
    open('projects');
    fireEvent.click(screen.getAllByTestId('project-row')[0]);
    const zone = id('project-delete').closest('div')?.parentElement;
    expect(zone).toHaveTextContent('stops being filed under Morning');
    expect(zone).not.toHaveTextContent('moves to');
  });

  it('warns that an item type is the one delete with no way back', () => {
    seed({
      items: [{ ...task('i1', 'Ship'), type: 'custom', customType: 'goal' } as Item],
      itemTypes: [{ id: 't1', name: 'goal', label: 'Goal', labelPlural: 'Goals' }],
    });
    open('types');
    click('type-row');
    const zone = id('type-delete').closest('div')?.parentElement;
    expect(zone).toHaveTextContent('Your one existing goal is kept');
    expect(zone).toHaveTextContent('isn’t undoable');
    // The filled destructive button is spent here and nowhere else in the
    // console. Dressing all five the same way is what taught users to read none.
    expect(id('type-delete').className).toContain('bg-destructive text-destructive-foreground');
  });

  it('keeps the other four delete buttons quiet', () => {
    seed({ projects: [{ id: 'pr1', name: 'Work', emoji: 'icon:Briefcase' }] });
    open('projects');
    click('project-row');
    // An outline, not a fill. `hover:bg-destructive/10` is in there, so the
    // assertion has to name the filled pair rather than the substring.
    expect(id('project-delete').className).not.toContain('bg-destructive text-destructive-foreground');
    expect(id('project-delete').className).toContain('border-destructive/40');
  });

  it('hashes an item type’s accent from its slug, not its label', () => {
    // item-registry's buildCustomTypeConfig derives a custom type's accent from
    // `def.name` — the slug — because that is the value in items.type. Hashing
    // the label instead makes the console the one surface in the app that paints
    // a multi-word type a different colour from the add dialog and the chips.
    seed({ itemTypes: [{ id: 't1', name: 'side-quest', label: 'Side Quest', labelPlural: 'Side Quests' }] });
    open('types');
    const glyph = id('type-row').querySelector('span[style]') as HTMLElement;
    expect(glyph.style.color).toBe(accentColorForName('side-quest'));
    expect(glyph.style.color).not.toBe(accentColorForName('Side Quest'));
  });

  it('lets a colour be set AND put back to Auto', () => {
    // Auto is ColorSwatchPicker's "clear the stored colour", and it says so by
    // calling onSelect(undefined) — so a patch filtered on `!== undefined`
    // drops exactly the case that matters and the swatch becomes one-way.
    seed({ projects: [{ id: 'pr1', name: 'Work', emoji: 'icon:Briefcase', color: 'var(--accent-3)' }] });
    open('projects');
    click('project-row');

    fireEvent.click(screen.getByRole('button', { name: /Project color/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Auto$/i }));
    expect(usePlannerStore.getState().projects[0].color).toBeUndefined();
  });

  it('selects the container that already had the name, whatever its case', () => {
    // addProject de-duplicates case-insensitively since 039, so "personal"
    // against an existing "Personal" creates nothing. An exact-only lookup
    // would then wipe the selection and leave no container, no selection and no
    // explanation.
    seed({ projects: [{ id: 'g1', name: 'Personal', emoji: 'icon:Star' }] });
    open('projects');
    // Creating starts from the list head now, and the form it opens owns the
    // detail pane. See CreateForm.
    click('project-new');
    fireEvent.change(id('project-new-name'), { target: { value: 'personal' } });
    fireEvent.click(id('project-add'));

    expect(usePlannerStore.getState().projects).toHaveLength(1);
    expect(id('project-detail')).toHaveAttribute('data-project-id', 'g1');
  });

  /* ── renaming, unparked by migration 027 ─────────────────────────────── */

  const openWork = () => {
    seed({
      items: [task('i1', 'Plan', { project: 'Work', projectId: 'pr1' })],
      projects: [
        { id: 'pr1', name: 'Work', emoji: 'icon:Briefcase' },
        { id: 'pr2', name: 'Home', emoji: 'icon:House' },
      ],
    });
    open('projects');
    // By id, not `click('project-row')` — two projects are seeded so the plain
    // testid matches both, and list order is not this test's business.
    fireEvent.click(
      screen.getAllByTestId('project-row').find((r) => r.dataset.projectId === 'pr1')!
    );
  };

  it('renames a project and carries its items with it', () => {
    // The whole point of Phase 0. Before stable ids this input was read-only,
    // because a rename left every member holding a string nothing resolved.
    openWork();
    const field = id('project-name-input') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Deep Work' } });
    fireEvent.blur(field);

    expect(usePlannerStore.getState().projects[0].name).toBe('Deep Work');
    expect((usePlannerStore.getState().items[0] as { project?: string }).project).toBe('Deep Work');
  });

  it('refuses a name another project already has, and SAYS so', () => {
    // Both tables are UNIQUE (user_id, name) and the rename's two writes do not
    // fail together: the container UPDATE raises 23505 and is swallowed, while
    // the id-keyed member fan-out succeeds. Work would keep its name while its
    // items all claimed "Home" — which reads as them moving into Home.
    openWork();
    const field = id('project-name-input') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'home' } });
    fireEvent.blur(field);

    expect(id('project-name-problem')).toHaveTextContent('already have a project called');
    expect(usePlannerStore.getState().projects[0].name).toBe('Work');
    expect((usePlannerStore.getState().items[0] as { project?: string }).project).toBe('Work');
    // The typed text stays — snapping back would leave nothing to correct.
    expect(field.value).toBe('home');
  });

  it('keeps focus on a refused name, so Escape still reverts it', () => {
    // Enter blurs only on acceptance. Blurred while refused, the name is
    // stranded: the Escape rung requires focus, so the next Escape would close
    // the whole console instead of putting the old name back.
    openWork();
    const field = id('project-name-input') as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: 'Home' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(document.activeElement).toBe(field);
    expect(maybe('project-name-problem')).not.toBeNull();
  });

  it('does not carry a refusal to the next project selected', () => {
    // The sentence belongs to the draft that earned it. Left behind, it is
    // re-parented onto another container and accuses it of a clash it does not
    // have.
    openWork();
    const field = id('project-name-input') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Home' } });
    fireEvent.blur(field);
    expect(maybe('project-name-problem')).not.toBeNull();

    fireEvent.click(
      screen.getAllByTestId('project-row').find((r) => r.dataset.projectId === 'pr2')!
    );
    expect(maybe('project-name-problem')).toBeNull();
  });

  it('still allows fixing your own capitalisation', () => {
    // The collision test excludes self, or a rename to your own name in a
    // different case would be refused as a clash with yourself.
    openWork();
    const field = id('project-name-input') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'WORK' } });
    fireEvent.blur(field);
    expect(usePlannerStore.getState().projects[0].name).toBe('WORK');
    expect(maybe('project-name-problem')).toBeNull();
  });

  it('leaves an item type’s SLUG alone while its label is renamed', () => {
    // The one container whose name is identity rather than a label: items.type
    // stores the slug, so it can never follow a rename — 027 changes nothing
    // here. The row edits the label and the meta line shows the slug.
    seed({ itemTypes: [{ id: 't1', name: 'goal', label: 'Goal', labelPlural: 'Goals' }] });
    open('types');
    click('type-row');
    const field = id('type-name-input') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Objective' } });
    fireEvent.blur(field);

    const def = usePlannerStore.getState().itemTypes[0];
    expect(def.label).toBe('Objective');
    expect(def.name).toBe('goal');
    expect(id('type-meta')).toHaveTextContent('goal');
  });

  it('refuses a reserved or duplicate item-type slug, and SAYS why', () => {
    // The dialog this replaced greyed the button out and explained nothing, so
    // the only way to learn the rules was to fail at them.
    seed({ itemTypes: [{ id: 't1', name: 'goal', label: 'Goal', labelPlural: 'Goals' }] });
    open('types');
    click('type-new');
    const field = id('type-new-name');

    fireEvent.change(field, { target: { value: 'Task' } });
    expect(id('type-add')).toBeDisabled();
    expect(id('type-new-problem')).toHaveTextContent('“task” is a built-in name');

    fireEvent.change(field, { target: { value: 'Goal' } });
    // A pre-existing type named after an organizer is a duplicate first: to its
    // owner "you already have one" is the truer sentence.
    expect(id('type-new-problem')).toHaveTextContent('You already have a type called “Goal”');

    // An organizer noun nobody has as a type is refused with its own sentence —
    // the "new" dialog lists the Routine organizer one row away.
    fireEvent.change(field, { target: { value: 'Routine' } });
    expect(id('type-add')).toBeDisabled();
    expect(id('type-new-problem')).toHaveTextContent('“routine” is an organizer, not a type');

    // The derivation is where the surprise is, so the message names the slug.
    fireEvent.change(field, { target: { value: '99 Bottles' } });
    expect(id('type-new-problem')).toHaveTextContent('Start with a letter');

    fireEvent.change(field, { target: { value: 'Side Quest' } });
    expect(maybe('type-new-problem')).toBeNull();
    expect(id('type-add')).not.toBeDisabled();
  });

  it('says nothing about an empty field', () => {
    // A resting state is not an error.
    seed({ itemTypes: [] });
    open('types');
    expect(maybe('type-new-problem')).toBeNull();
    fireEvent.change(id('type-new-name'), { target: { value: '   ' } });
    expect(maybe('type-new-problem')).toBeNull();
  });

  it('carries an auto-derived plural through a rename, but never a custom one', () => {
    seed({
      itemTypes: [
        { id: 't1', name: 'goal', label: 'Goal', labelPlural: 'Goals' },
        { id: 't2', name: 'person', label: 'Person', labelPlural: 'People' },
      ],
    });
    open('types');

    // "Goals" is exactly `${label}s`, so it was never touched — it follows.
    fireEvent.click(screen.getAllByTestId('type-row')[0]);
    const name = id('type-name-input') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Objective' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    let t = usePlannerStore.getState().itemTypes.find((x) => x.id === 't1')!;
    expect(t.label).toBe('Objective');
    expect(t.labelPlural).toBe('Objectives');
    // The slug is what items are stored as, and never moves.
    expect(t.name).toBe('goal');

    // "People" is irregular — someone chose it, so a rename must not clobber it.
    fireEvent.click(screen.getAllByTestId('type-row')[1]);
    const name2 = id('type-name-input') as HTMLInputElement;
    fireEvent.change(name2, { target: { value: 'Human' } });
    fireEvent.keyDown(name2, { key: 'Enter' });
    t = usePlannerStore.getState().itemTypes.find((x) => x.id === 't2')!;
    expect(t.label).toBe('Human');
    expect(t.labelPlural).toBe('People');
  });

  it('edits the plural on its own, buffered on Enter', () => {
    seed({ itemTypes: [{ id: 't1', name: 'goal', label: 'Goal', labelPlural: 'Goals' }] });
    open('types');
    click('type-row');
    const field = id('type-plural') as HTMLInputElement;

    fireEvent.change(field, { target: { value: 'Goalz' } });
    // Not yet — a keystroke is not a decision.
    expect(usePlannerStore.getState().itemTypes[0].labelPlural).toBe('Goals');

    fireEvent.keyDown(field, { key: 'Enter' });
    expect(usePlannerStore.getState().itemTypes[0].labelPlural).toBe('Goalz');
  });
});

/* ── the project time block ───────────────────────────────────────────── */

describe('the project time block', () => {
  const project = (extra: Partial<Project> = {}): Project => ({
    id: 'pr1',
    name: 'Work',
    emoji: 'icon:Briefcase',
    ...extra,
  });

  const openProject = (p: Project) => {
    seed({ projects: [p] });
    open('projects');
    click('project-row');
  };

  it('writes all three fields the grid needs when switched on', () => {
    // lib/day-items.ts renders a block only when startTime, timeBucket AND
    // repeatFrequency all hold. Writing two of three leaves the switch reading
    // on with nothing on the grid.
    openProject(project());
    expect(maybe('project-start-time')).toBeNull();

    click('project-block-toggle');
    const p = usePlannerStore.getState().projects[0];
    expect(p.timeBucket).toBe('morning');
    expect(p.startTime).toBe('05:00');
    expect(p.repeatFrequency).toBe('daily');
  });

  it('remembers the setup when switched off', () => {
    // Off clears only what the predicate reads. Throwing away the duration and
    // the repeat would make the switch a destructive control with no warning.
    openProject(
      project({ timeBucket: 'evening', startTime: '19:00', duration: 90, repeatFrequency: 'weekdays' })
    );
    click('project-block-toggle');
    const p = usePlannerStore.getState().projects[0];
    expect(p.startTime).toBeUndefined();
    expect(p.timeBucket).toBeUndefined();
    expect(p.duration).toBe(90);
    expect(p.repeatFrequency).toBe('weekdays');
  });

  it('moves the start time with the part of day', () => {
    // A 5am start filed under Evening is a block the grid draws outside its band.
    openProject(project({ timeBucket: 'morning', startTime: '05:00', repeatFrequency: 'daily' }));
    click('project-bucket-evening');
    const p = usePlannerStore.getState().projects[0];
    expect(p.timeBucket).toBe('evening');
    expect(p.startTime).toBe('17:00');
  });

  it('leaves a re-picked part of day alone', () => {
    // A segment is a button, not a Radix Select — a confirming click on the lit
    // one fires its handler too. Re-seeding the band opening there would throw
    // away a start time the user typed, on a gesture that changes nothing.
    openProject(project({ timeBucket: 'afternoon', startTime: '14:30', repeatFrequency: 'daily' }));
    click('project-bucket-afternoon');
    const p = usePlannerStore.getState().projects[0];
    expect(p.startTime).toBe('14:30');
    expect(p.timeBucket).toBe('afternoon');
  });

  it('reveals the custom minutes field through the Custom… option', () => {
    // THE ENTRY PATH, not the field. Seeding a non-preset duration mounts the
    // field directly and proves nothing about how a user reaches it: every
    // project starts on a preset (60 by default), so if picking Custom… does not
    // reveal the field, no duration outside the eight presets is reachable at
    // all. Choosing it must also write nothing — a placeholder would put a
    // number on the grid the user never chose.
    openProject(project({ timeBucket: 'morning', startTime: '05:00', duration: 60, repeatFrequency: 'daily' }));
    expect(maybe('project-duration-custom')).toBeNull();

    pick('project-duration', 'Custom…');
    expect(maybe('project-duration-custom')).not.toBeNull();
    expect(usePlannerStore.getState().projects[0].duration).toBe(60);

    const field = id('project-duration-custom') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '75' } });
    fireEvent.blur(field);
    expect(usePlannerStore.getState().projects[0].duration).toBe(75);
  });

  it('keeps the custom field open when the typed value happens to be a preset', () => {
    // Otherwise the field vanishes the instant it commits — typing 90 in a field
    // the user opened deliberately collapses it back to the list they left.
    openProject(project({ timeBucket: 'morning', startTime: '05:00', duration: 60, repeatFrequency: 'daily' }));
    pick('project-duration', 'Custom…');

    const field = id('project-duration-custom') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '90' } });
    fireEvent.blur(field);
    expect(usePlannerStore.getState().projects[0].duration).toBe(90);
    expect(maybe('project-duration-custom')).not.toBeNull();
  });

  it('picking a preset closes the custom field and writes the preset', () => {
    openProject(project({ timeBucket: 'morning', startTime: '05:00', duration: 25, repeatFrequency: 'daily' }));
    expect(maybe('project-duration-custom')).not.toBeNull();

    pick('project-duration', '45 minutes');
    expect(usePlannerStore.getState().projects[0].duration).toBe(45);
    expect(maybe('project-duration-custom')).toBeNull();
  });

  it('buffers the custom duration instead of writing every digit', () => {
    // Live-binding would write `6` on the way to `60` and put a six-minute block
    // on the grid for as long as it takes to type the second digit.
    openProject(project({ timeBucket: 'morning', startTime: '05:00', duration: 25, repeatFrequency: 'daily' }));
    const field = id('project-duration-custom') as HTMLInputElement;

    fireEvent.change(field, { target: { value: '5' } });
    expect(usePlannerStore.getState().projects[0].duration).toBe(25);
    fireEvent.change(field, { target: { value: '50' } });
    fireEvent.blur(field);
    expect(usePlannerStore.getState().projects[0].duration).toBe(50);
  });

  it('refuses a duration that is not a positive number', () => {
    openProject(project({ timeBucket: 'morning', startTime: '05:00', duration: 25, repeatFrequency: 'daily' }));
    const field = id('project-duration-custom') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '0' } });
    fireEvent.blur(field);
    expect(usePlannerStore.getState().projects[0].duration).toBe(25);
    expect(field.value).toBe('25');
  });

  it('keeps a legacy “weekly” project editable', () => {
    // The DB really holds 'weekly' on old rows even though Project's type has no
    // such member — day-items.ts routes it to the arm that reads repeatDays, so
    // it renders on the grid. Hiding the day grid would leave the user looking
    // at a block they can neither see the days of nor change.
    openProject(
      project({
        timeBucket: 'morning',
        startTime: '09:00',
        repeatFrequency: 'weekly' as Project['repeatFrequency'],
        repeatDays: [1, 3],
      })
    );
    expect(id('project-days')).toBeInTheDocument();
    expect(id('project-day-1')).toHaveAttribute('aria-pressed', 'true');
    expect(id('project-day-2')).toHaveAttribute('aria-pressed', 'false');

    click('project-day-2');
    expect(usePlannerStore.getState().projects[0].repeatDays).toEqual([1, 2, 3]);
  });
});

/* ── the section filter ───────────────────────────────────────────────── */

describe('the section filter', () => {
  const three = () =>
    seed({
      routines: [routine('r1', 'Morning'), routine('r2', 'Evening'), routine('r3', 'Weekend')],
    });

  it('filters the current section and reports the match count', () => {
    three();
    open('routines');
    fireEvent.change(id('routine-filter'), { target: { value: 'en' } });
    // Evening and Weekend, not Morning.
    expect(screen.getAllByTestId('routine-row')).toHaveLength(2);
  });

  it('says nothing matches rather than "no routines yet"', () => {
    three();
    open('routines');
    fireEvent.change(id('routine-filter'), { target: { value: 'zzz' } });
    expect(screen.queryAllByTestId('routine-row')).toHaveLength(0);
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
    expect(screen.queryByText('No routines yet.')).toBeNull();
  });

  it('clears on Escape without closing the plate', () => {
    three();
    const onOpenChange = vi.fn();
    render(<OrganizeConsole open onOpenChange={onOpenChange} section="routines" />);
    const field = id('routine-filter') as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: 'zzz' } });
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(field.value).toBe('');
    expect(screen.getAllByTestId('routine-row')).toHaveLength(3);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('lets the next Escape leave, once there is nothing left to clear', () => {
    // The rung is claimed only when it has work to do. A rung that swallowed
    // every press would strand the keyboard user inside the plate — and would
    // exhaust the e2e closeManager helpers' four-press budget.
    three();
    const onOpenChange = vi.fn();
    render(<OrganizeConsole open onOpenChange={onOpenChange} section="routines" />);
    const field = id('routine-filter') as HTMLInputElement;
    field.focus();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('is focused by / from anywhere on the plate', () => {
    three();
    open('routines');
    fireEvent.keyDown(id('organize-console'), { key: '/' });
    expect(document.activeElement).toBe(id('routine-filter'));
  });

  it('lets a slash be typed into a text field', () => {
    three();
    open('routines');
    click('routine-new');
    const draft = id('routine-new-name');
    draft.focus();
    fireEvent.keyDown(draft, { key: '/' });
    expect(document.activeElement).toBe(draft);
  });

  it('clears a half-typed new name before it leaves', () => {
    three();
    const onOpenChange = vi.fn();
    render(<OrganizeConsole open onOpenChange={onOpenChange} section="routines" />);
    click('routine-new');
    const draft = id('routine-new-name') as HTMLInputElement;
    draft.focus();
    fireEvent.change(draft, { target: { value: 'Half typ' } });
    fireEvent.keyDown(draft, { key: 'Escape' });

    expect(draft.value).toBe('');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('puts a dirty rename back before it leaves', () => {
    seed({ routines: [routine('r1', 'Morning')] });
    const onOpenChange = vi.fn();
    render(<OrganizeConsole open onOpenChange={onOpenChange} section="routines" />);
    click('routine-row');
    const field = id('routine-name-input') as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: 'Mornin' } });
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(field.value).toBe('Morning');
    expect(onOpenChange).not.toHaveBeenCalled();
    // And the reset must not have written — Escape is a cancel, not a save.
    expect(usePlannerStore.getState().routines[0].name).toBe('Morning');
  });

  it('closes an open member search before it leaves', () => {
    seed({
      items: [habit('i1', 'Stretch')],
      routines: [routine('r1', 'Morning')],
    });
    const onOpenChange = vi.fn();
    render(<OrganizeConsole open onOpenChange={onOpenChange} section="routines" />);
    click('routine-row');
    click('routine-member-add');
    expect(id('routine-member-search')).toBeInTheDocument();

    fireEvent.keyDown(id('routine-member-search'), { key: 'Escape' });
    expect(maybe('routine-member-search')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('steps down into the first match', () => {
    three();
    open('routines');
    const field = id('routine-filter');
    fireEvent.change(field, { target: { value: 'week' } });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveAttribute('data-routine-id', 'r3');
  });
});

/* ── member rows and the picker (Phase 5c, 5d) ────────────────────────── */

describe('a member row', () => {
  const mixed = () =>
    seed({
      items: [
        habit('i1', 'Stretch', { startTime: '07:30' }),
        task('i2', 'Stretch', { timeBucket: 'evening' }),
        task('i3', 'Email', { timeBucket: 'anytime' }),
      ],
      routines: [routine('r1', 'Morning', { itemIds: ['i1', 'i2', 'i3'] })],
    });

  it('carries a type glyph, so two items with ONE title are two rows', () => {
    /**
     * Both are called "Stretch". Without the glyph these rows are identical,
     * here and in the search that adds them — and picking the wrong one is a
     * silent write that only diverges later, when the habit keeps recurring.
     *
     * ASSERTED AGAINST THE REGISTRY TOKEN, not merely "the two differ". The
     * first version compared the two svg class attributes, and passed with BOTH
     * `glyph` entries deleted from ITEM_TYPES — because CategoryIcon's
     * name-hash fallback already yields different icons for "Task" and "Habit".
     * It tested the fallback and called it a test of the feature.
     */
    mixed();
    open('routines');
    click('routine-row');
    const rows = screen.getAllByTestId('routine-member');
    const glyphOf = (row: HTMLElement) => row.querySelector('svg');
    // lucide stamps `lucide-<kebab>` from the icon's own name, so the registry's
    // token is checkable end to end without hard-coding a class here.
    const fromToken = (type: 'task' | 'habit') => {
      const token = ITEM_TYPES[type].glyph;
      expect(token).toBeDefined();
      return `lucide-${token!.replace('icon:', '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
    };

    expect(glyphOf(rows[0])).toHaveClass(fromToken('habit'));
    expect(glyphOf(rows[1])).toHaveClass(fromToken('task'));
    expect(fromToken('habit')).not.toEqual(fromToken('task'));
  });

  it('shows a clock time in tabular figures and a bucket name in prose', () => {
    mixed();
    open('routines');
    click('routine-row');
    const metas = screen.getAllByTestId('routine-member-meta');
    expect(metas[0]).toHaveTextContent('07:30');
    expect(metas[0]).toHaveClass('font-num');
    // Mono on a word is instrumentation cosplay: tabular figures exist to line
    // digits up, and "Evening" has none to line up.
    expect(metas[1]).toHaveTextContent('Evening');
    expect(metas[1]).not.toHaveClass('font-num');
  });

  it('says nothing at all for an unscheduled item', () => {
    // Most rows in a braindump-fed routine are unscheduled, so "anytime" would
    // be the loudest repeated thing on the pane while carrying no signal.
    mixed();
    open('routines');
    click('routine-row');
    expect(screen.getAllByTestId('routine-member-meta')[2]).toHaveTextContent('');
  });
});

describe('the member picker', () => {
  const three = () =>
    seed({
      items: [habit('i1', 'Stretch'), habit('i2', 'Read'), task('i3', 'Email')],
      routines: [routine('r1', 'Morning')],
    });

  const openPicker = () => {
    open('routines');
    click('routine-row');
    click('routine-member-add');
  };

  it('browses on an empty query, rather than demanding the title up front', () => {
    // The old picker showed nothing until you typed, which quietly required you
    // to already know the name of the thing you were looking for.
    three();
    openPicker();
    expect(screen.getAllByTestId('routine-member-candidate')).toHaveLength(3);
  });

  it('walks the list with ↑/↓ and commits the HIGHLIGHTED row', () => {
    three();
    openPicker();
    const field = id('routine-member-search');

    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(screen.getAllByTestId('routine-member-candidate')[1]).toHaveAttribute('data-active');

    fireEvent.keyDown(field, { key: 'Enter' });
    expect(usePlannerStore.getState().routines[0].itemIds).toEqual(['i2']);
  });

  it('never walks off either end', () => {
    three();
    openPicker();
    const field = id('routine-member-search');
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(screen.getAllByTestId('routine-member-candidate')[0]).toHaveAttribute('data-active');

    for (let i = 0; i < 9; i++) fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(usePlannerStore.getState().routines[0].itemIds).toEqual(['i3']);
  });

  it('stays open after an add, with the query cleared and the cursor home', () => {
    // Collecting is almost never one act. Closing after each add made building
    // a four-item routine four round trips through a button 30px away.
    three();
    openPicker();
    // TYPES FIRST. The original drove this with ↓↵ alone, so `toHaveValue('')`
    // was true before the add as well as after — the "query cleared" half of the
    // claim was unpinned, and deleting `setQuery('')` from add() left the whole
    // suite green. Playwright cannot cover it either: `.fill()` focuses the
    // field itself, so the refocus half is invisible there too.
    fireEvent.change(id('routine-member-search'), { target: { value: 'read' } });
    fireEvent.keyDown(id('routine-member-search'), { key: 'Enter' });

    expect(id('routine-member-search')).toHaveValue('');
    // And the cursor is back in the field, so the next one is ↓↵ away rather
    // than a click away.
    expect(document.activeElement).toBe(id('routine-member-search'));
    const rows = screen.getAllByTestId('routine-member-candidate');
    // The added one is gone from the pool, and the highlight is back at the top
    // rather than sitting on whatever slid into index 1.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('data-active');
    expect(rows[0]).toHaveAttribute('data-item-id', 'i1');
  });

  it('resets the cursor as the query narrows, so ↵ commits what is lit', () => {
    three();
    openPicker();
    const field = id('routine-member-search');
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    // A cursor at index 2 against a one-row list is either a missing highlight
    // or an add of the wrong thing, depending on how it is clamped.
    fireEvent.change(field, { target: { value: 'read' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(usePlannerStore.getState().routines[0].itemIds).toEqual(['i2']);
  });

  it('says nothing matches INSIDE the list, and ↵ there does nothing', () => {
    three();
    openPicker();
    const field = id('routine-member-search');
    fireEvent.change(field, { target: { value: 'zzz' } });
    expect(id('routine-member-none')).toHaveTextContent('Nothing matches “zzz”');

    fireEvent.keyDown(field, { key: 'Enter' });
    expect(usePlannerStore.getState().routines[0].itemIds).toEqual([]);
    // And the field is still the thing with focus, so typing continues to work.
    expect(maybe('routine-member-search')).toBeInTheDocument();
  });

  it('distinguishes an empty POOL from an empty search', () => {
    // Telling someone to refine a search that cannot succeed is the worse of
    // the two wrong answers here.
    seed({
      items: [habit('i1', 'Stretch')],
      routines: [routine('r1', 'Morning', { itemIds: ['i1'] })],
    });
    openPicker();
    expect(id('routine-member-none')).toHaveTextContent('Everything is already in here.');
  });

  it('keeps a highlight when the pool shrinks under it', () => {
    /**
     * The cursor is bounded at every point the USER can move it, so this is the
     * one path that can leave it dangling: the list shrinking on its own. The
     * picker now stays open across adds, which makes the window it is open for
     * much longer, and `items` is written by more than this pane — another tab,
     * the agent API, a realtime update, a redo.
     *
     * Unclamped, `candidates[cursor]` is undefined: the highlight vanishes,
     * `aria-activedescendant` points at nothing, and ↑ has to be pressed once
     * per index of overshoot before anything lights up again.
     */
    three();
    openPicker();
    const field = id('routine-member-search');
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });

    act(() => {
      usePlannerStore.setState({ items: [habit('i1', 'Stretch')] } as never);
    });

    const rows = screen.getAllByTestId('routine-member-candidate');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('data-active');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(usePlannerStore.getState().routines[0].itemIds).toEqual(['i1']);
  });

  it('survives ↓ against an empty list, which used to park it at -1', () => {
    /**
     * `Math.min(active + 1, candidates.length - 1)` is `Math.min(1, -1)` when
     * the list is empty, and the original clamp only bounded the TOP — so the
     * cursor stuck at -1 and stayed there once the list refilled. Reachable
     * without leaving the pane: open the picker on a routine that already holds
     * everything, press ↓, then free an item with its trash button.
     */
    seed({
      items: [habit('i1', 'Stretch')],
      routines: [routine('r1', 'Morning', { itemIds: ['i1'] })],
    });
    openPicker();
    expect(id('routine-member-none')).toHaveTextContent('Everything is already in here.');

    fireEvent.keyDown(id('routine-member-search'), { key: 'ArrowDown' });
    // Free the item again, which refills the pool.
    click('routine-member-remove');

    const rows = screen.getAllByTestId('routine-member-candidate');
    expect(rows[0]).toHaveAttribute('data-active');
    fireEvent.keyDown(id('routine-member-search'), { key: 'Enter' });
    expect(usePlannerStore.getState().routines[0].itemIds).toEqual(['i1']);
  });

  it('keeps pointer and keyboard on ONE cursor', () => {
    // Two independent notions of "current" is the classic way a picker adds the
    // row the highlight was not on.
    three();
    openPicker();
    fireEvent.mouseMove(screen.getAllByTestId('routine-member-candidate')[2]);
    fireEvent.keyDown(id('routine-member-search'), { key: 'Enter' });
    expect(usePlannerStore.getState().routines[0].itemIds).toEqual(['i3']);
  });
});

/* ── making something (N1) ────────────────────────────────────────────────── */

describe('making a program in the console', () => {
  const day = (label: string) =>
    screen.getAllByRole('button').find((b) => b.getAttribute('aria-label')?.includes(label))!;

  it('writes the Runs range in the one addProgram, as auto', () => {
    // `auto`, so the dates ARE the switch; one call, so it is one undo entry.
    seed({ programs: [] });
    const addProgram = vi.fn(() => 'p-new');
    usePlannerStore.setState({ addProgram });
    open('programs');
    click('program-new');
    fireEvent.change(id('program-new-name'), { target: { value: 'Autumn term' } });
    click('program-new-runs-chip');
    fireEvent.click(day('August 20th, 2026'));
    // Setting the start flips the calendar to the end, for the second half.
    fireEvent.click(day('August 30th, 2026'));
    click('program-add');

    expect(addProgram).toHaveBeenCalledTimes(1);
    expect(addProgram).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Autumn term',
        state: 'auto',
        startsOn: '2026-08-20',
        endsOn: '2026-08-30',
        itemIds: [],
        routineIds: [],
      })
    );
  });
});

describe('the create flow lives in the detail pane', () => {
  const three = () =>
    seed({
      routines: [routine('r1', 'Morning'), routine('r2', 'Evening'), routine('r3', 'Weekend')],
    });

  it('opens the form from the list head, not a row pinned under the list', () => {
    three();
    open('routines');
    // Nothing on screen until asked: the old create row was mounted always,
    // 26px under a scrolling list.
    expect(maybe('routine-create-form')).toBeNull();

    click('routine-new');

    expect(id('routine-create-form')).toBeTruthy();
    // It owns the detail pane, so the teaching line is gone while it is up.
    expect(id('organize-detail').textContent).toContain('A routine groups items');
  });

  it('creates on the button and selects what it made', () => {
    three();
    open('routines');
    click('routine-new');
    fireEvent.change(id('routine-new-name'), { target: { value: 'Gym block' } });
    click('routine-add');

    const made = usePlannerStore.getState().routines.find((r) => r.name === 'Gym block');
    expect(made).toBeTruthy();
    // The form gives way to the new thing's detail — not back to a teaching line.
    expect(maybe('routine-create-form')).toBeNull();
    expect(id('routine-detail')).toHaveAttribute('data-routine-id', made!.id);
  });

  it('creates on Enter too', () => {
    three();
    open('routines');
    click('routine-new');
    fireEvent.change(id('routine-new-name'), { target: { value: 'Evening pages' } });
    fireEvent.keyDown(id('routine-new-name'), { key: 'Enter' });

    expect(usePlannerStore.getState().routines.map((r) => r.name)).toContain('Evening pages');
  });

  it('refuses a blank name rather than making an unnamed row', () => {
    three();
    open('routines');
    click('routine-new');
    fireEvent.change(id('routine-new-name'), { target: { value: '   ' } });

    expect(id('routine-add')).toBeDisabled();
    click('routine-add');
    expect(usePlannerStore.getState().routines).toHaveLength(3);
  });

  it('cancels back to the list without creating', () => {
    three();
    open('routines');
    click('routine-new');
    fireEvent.change(id('routine-new-name'), { target: { value: 'Nope' } });
    click('routine-cancel');

    expect(maybe('routine-create-form')).toBeNull();
    expect(usePlannerStore.getState().routines).toHaveLength(3);
  });

  it('stands in for an EMPTY section, with nothing to cancel back to', () => {
    seed({ routines: [] });
    open('routines');

    // No click needed: with no rows, "make your first" and the empty state are
    // the same screen.
    expect(id('routine-create-form')).toBeTruthy();
    expect(maybe('routine-cancel')).toBeNull();
  });

  it('does NOT steal the cursor when it is merely standing in for empty', () => {
    // The rail walk is the case: ↓ onto a section with nothing in it must not
    // rip focus out of the rail and into a name field.
    seed({ routines: [] });
    open('routines');
    expect(document.activeElement).not.toBe(id('routine-new-name'));
  });

  it('takes the cursor when the user actually asked to create', () => {
    three();
    open('routines');
    click('routine-new');
    expect(document.activeElement).toBe(id('routine-new-name'));
  });

  it('leaves the create form on a section change', () => {
    three();
    open('routines');
    click('routine-new');
    fireEvent.change(id('routine-new-name'), { target: { value: 'Half typed' } });

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Programs' }), { button: 0 });

    // Arriving in Programs still offering to name a ROUTINE would be the
    // console losing its place, wearing a form.
    expect(maybe('routine-create-form')).toBeNull();
  });

  it('clears a half-typed name before it leaves the form', () => {
    three();
    open('routines');
    click('routine-new');
    const field = id('routine-new-name') as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: 'Half typ' } });

    fireEvent.keyDown(field, { key: 'Escape' });
    expect((id('routine-new-name') as HTMLInputElement).value).toBe('');
    // Still in the form — one Escape is one step back, not two.
    expect(id('routine-create-form')).toBeTruthy();
  });
});

/* ── the Overview (the console's front door) ──────────────────────────────── */

describe('the Overview maps the console', () => {
  const stocked = () =>
    seed({
      routines: [routine('r1', 'Morning'), routine('r2', 'Evening')],
      projects: [{ id: 'p1', name: 'Work', emoji: 'icon:Briefcase' }],
    });

  it('cards every available section but itself, with live counts', () => {
    stocked();
    open('overview');

    const cards = screen.getAllByTestId('overview-card').map((c) => c.getAttribute('data-section'));
    // Everything the rail holds, minus the map itself.
    expect(cards).toEqual(['routines', 'programs', 'goals', 'projects', 'types', 'trash']);
    const routinesCard = cards.indexOf('routines');
    expect(screen.getAllByTestId('overview-card')[routinesCard].textContent).toContain('2');
  });

  it('says what each section is for, in a line rather than a paragraph', () => {
    stocked();
    open('overview');
    // The blurb, not the section's full definition — that lives in the section,
    // where it is the empty state and the create form's hint.
    expect(screen.getByTestId('organize-overview').textContent).toContain(
      'Pause a stack of items together.'
    );
  });

  it('gives the trash NO count — the bin never enters the store', () => {
    stocked();
    open('overview');
    const trash = screen
      .getAllByTestId('overview-card')
      .find((c) => c.getAttribute('data-section') === 'trash')!;
    expect(trash.textContent).toContain('Trash');
    // A count here would mean a fetch on every console open. See sections/trash.
    expect(trash.querySelector('.font-num')).toBeNull();
  });

  it('opens a section when its card is clicked', () => {
    stocked();
    open('overview');

    fireEvent.click(
      screen.getAllByTestId('overview-card').find((c) => c.getAttribute('data-section') === 'routines')!
    );

    expect(screen.getByRole('tab', { name: 'Routines' })).toHaveAttribute('aria-selected', 'true');
    expect(maybe('routine-create-form')).toBeNull();
  });

  it('"New" lands in the section WITH its create form already open', () => {
    stocked();
    open('overview');

    fireEvent.click(
      screen.getAllByTestId('overview-new').find((c) => c.getAttribute('data-section') === 'routines')!
    );

    expect(screen.getByRole('tab', { name: 'Routines' })).toHaveAttribute('aria-selected', 'true');
    expect(id('routine-create-form')).toBeTruthy();
  });

  it('offers no "New" for the trash', () => {
    stocked();
    open('overview');
    const news = screen.getAllByTestId('overview-new').map((n) => n.getAttribute('data-section'));
    expect(news).not.toContain('trash');
  });
});

/* ── what the Phase 5 review caught ───────────────────────────────────────── */

describe('the create form holds up under the review', () => {
  const three = () =>
    seed({
      routines: [routine('r1', 'Morning'), routine('r2', 'Evening'), routine('r3', 'Weekend')],
    });

  it('focuses the field when "+ New" is pressed in an EMPTY section', () => {
    // The form is ALREADY mounted there (standing in for the empty list), and
    // React applies `autoFocus` at mount only — so the section's one primary
    // verb used to answer with no cursor and no visible change. Every section is
    // empty on a new account, which is now every account by default.
    seed({ routines: [] });
    open('routines');
    expect(document.activeElement).not.toBe(id('routine-new-name'));

    click('routine-new');

    expect(document.activeElement).toBe(id('routine-new-name'));
  });

  it('does not wipe a typed name on an Escape aimed somewhere else', () => {
    // The clear rung is guarded on focus, the way the old create row's was.
    three();
    open('routines');
    click('routine-new');
    fireEvent.change(id('routine-new-name'), { target: { value: 'Half typed' } });

    const filter = id('routine-filter');
    filter.focus();
    fireEvent.keyDown(filter, { key: 'Escape' });

    // Neither wiped nor closed out from under the typing: the form does not
    // claim a keystroke aimed at another control.
    expect(id('routine-create-form')).toBeTruthy();
    expect((id('routine-new-name') as HTMLInputElement).value).toBe('Half typed');
  });

  it('selecting a row leaves the create form', () => {
    // The form and the selection share the detail pane and `creating` wins, so
    // a click on a row used to look like it did nothing.
    three();
    open('routines');
    click('routine-new');
    expect(id('routine-create-form')).toBeTruthy();

    fireEvent.click(screen.getAllByTestId('routine-row')[1]);

    expect(maybe('routine-create-form')).toBeNull();
    expect(id('routine-detail')).toHaveAttribute('data-routine-id', 'r2');
  });
});

describe('the Overview only offers a New it can honour', () => {
  it('drops "New" for a section whose table is unreachable', () => {
    // Offering it sent the user to a pane with no form, while the footer claimed
    // they were making something.
    seed({ itemTypes: [], itemTypesAvailable: false });
    open('overview');

    const news = screen.getAllByTestId('overview-new').map((n) => n.getAttribute('data-section'));
    expect(news).not.toContain('types');
    expect(news).toContain('routines');
  });

  it('drops every "New" while the first fetch is still in flight', () => {
    // Creating inside the load window is erased by initializeStore's set() —
    // the same three-part gate every section computes for itself.
    seed({ isLoading: true });
    open('overview');
    expect(screen.queryAllByTestId('overview-new')).toHaveLength(0);
  });
});
