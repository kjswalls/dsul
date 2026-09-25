import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { OrganizeConsole } from '@/components/planner/organize/organize-console';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { enableGoalsAndOrganize } from './support/extensions';
import type { Goal, Item } from '@/lib/planner-types';

/**
 * The goal pane in the item edit pane's grammar (2026-09-25): whisper and ⋯,
 * serif title, one chip row, the why as serif notes, one section per role. What
 * is pinned here is what the redesign was FOR — one heading per list, no empty
 * blocks, a milestone you can tick where you read it, a delete that is not a
 * red zone — plus the "+ New" fields that make a goal whole at birth.
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

// next/link needs the app router's context; the pane's links are not under test.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
}));

const TODAY = '2026-08-12';

const task = (id: string, title: string, extra: Partial<Item> = {}): Item =>
  ({ id, type: 'task', title, status: 'pending', order: 0, isScheduled: false, ...extra }) as Item;

const goal = (extra: Partial<Goal> = {}): Goal => ({
  id: 'g1',
  name: 'Speak fluent Chinese',
  state: 'active',
  memberIds: [],
  milestoneIds: [],
  checkinIds: [],
  ...extra,
});

function seed(state: Partial<ReturnType<typeof usePlannerStore.getState>>) {
  usePlannerStore.setState({
    items: [],
    routines: [],
    programs: [],
    projects: [],
    itemTypes: [],
    goals: [],
    goalsAvailable: true,
    collectionsAvailable: true,
    itemTypesAvailable: true,
    isLoading: false,
    userId: 'u1',
    userTimezone: 'UTC',
    ...state,
  });
}

const id = (testId: string) => screen.getByTestId(testId);
const maybe = (testId: string) => screen.queryByTestId(testId);
const click = (testId: string) => fireEvent.click(id(testId));

const openGoal = () => {
  render(<OrganizeConsole open onOpenChange={() => {}} section="goals" />);
  click('goal-row');
};

beforeEach(() => {
  enableGoalsAndOrganize();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
  useUIStore.setState({ confirmRequest: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the goal pane', () => {
  it('reads as the edit pane: whisper, one chip row, and no nested column', () => {
    seed({ goals: [goal({ startsOn: '2026-08-01', targetOn: '2027-03-01' })] });
    openGoal();
    expect(id('goal-whisper')).toHaveTextContent('Goal');
    expect(id('goal-state-chip')).toHaveTextContent('Active');
    expect(id('goal-window-chip')).toHaveTextContent('Aug 1');
    expect(id('goal-window-chip')).toHaveTextContent('Mar 1');
    // The double DetailColumn (double padding, two scrollers) is gone.
    expect(screen.getAllByTestId('organize-detail')).toHaveLength(1);
  });

  it('gives an empty section its heading and add row, and nothing else', () => {
    seed({ goals: [goal()] });
    openGoal();
    const milestones = id('goal-milestone-members');
    expect(milestones).toHaveTextContent(/^Milestones/);
    expect(milestones).not.toHaveTextContent('0 items');
    expect(milestones).not.toHaveTextContent('Nothing in here yet');
    expect(milestones).not.toHaveTextContent('·');
    expect(within(milestones).getByTestId('goal-new-milestone-new-name')).toBeInTheDocument();
    expect(within(milestones).getByTestId('goal-milestone-member-add')).toHaveTextContent(
      'Link existing'
    );
  });

  it('says who qualifies at the top of the milestone picker', () => {
    seed({ goals: [goal()] });
    openGoal();
    click('goal-milestone-member-add');
    expect(id('goal-milestone-member-hint')).toHaveTextContent(
      'One-time items only. A repeating item never finishes.'
    );
  });

  it('makes a milestone from the add row, linked in the same gesture', () => {
    seed({ goals: [goal()] });
    openGoal();
    const field = id('goal-new-milestone-new-name');
    fireEvent.change(field, { target: { value: 'Order dinner in Mandarin' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    const made = usePlannerStore.getState().items.find((i) => i.title === 'Order dinner in Mandarin');
    expect(made).toBeDefined();
    expect(usePlannerStore.getState().goals[0].milestoneIds).toEqual([made!.id]);
    expect((field as HTMLInputElement).value).toBe('');
  });

  it('ticks a milestone through the item’s own action, and mutes rather than strikes it', () => {
    seed({
      items: [task('m1', 'Finish HSK 3 vocab deck'), task('m2', 'Hold a call')],
      goals: [goal({ milestoneIds: ['m1', 'm2'] })],
    });
    openGoal();
    expect(id('goal-milestone-members')).toHaveTextContent('Milestones · 0 of 2');

    fireEvent.click(screen.getAllByTestId('goal-milestone-check')[0]);
    expect(usePlannerStore.getState().items.find((i) => i.id === 'm1')?.status).toBe('completed');
    expect(id('goal-milestone-members')).toHaveTextContent('Milestones · 1 of 2');

    const row = screen.getAllByTestId('goal-milestone-member')[0];
    expect(row).toHaveAttribute('data-done');
    const title = within(row).getByTitle('Finish HSK 3 vocab deck');
    expect(title).toHaveClass('text-muted-foreground');
    expect(title.className).not.toContain('line-through');
  });

  it('says when a check-in was last done', () => {
    seed({
      items: [
        task('c1', 'Sunday language review', {
          startDate: '2026-07-01',
          repeatFrequency: 'custom',
          repeatDays: [0],
          completedDates: ['2026-08-02', '2026-08-09'],
        } as Partial<Item>),
      ],
      goals: [goal({ checkinIds: ['c1'] })],
    });
    openGoal();
    expect(id('goal-checkin-member')).toHaveTextContent('last Aug 9');
  });

  it('writes status through the chip', () => {
    seed({ goals: [goal()] });
    openGoal();
    click('goal-state-chip');
    click('goal-state-achieved');
    expect(usePlannerStore.getState().goals[0].state).toBe('achieved');
  });

  it('keeps delete behind ⋯, with no filled red button on the pane', () => {
    seed({ goals: [goal()] });
    openGoal();
    expect(maybe('delete-goal')).toBeNull();
    expect(id('organize-detail').querySelector('.bg-destructive')).toBeNull();

    fireEvent.pointerDown(id('goal-more'), { pointerType: 'mouse', button: 0, ctrlKey: false });
    click('delete-goal');
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(useUIStore.getState().confirmRequest?.title).toBe('Delete Speak fluent Chinese?');
  });
});

describe('Escape inside the goal pane', () => {
  // Radix decides on Escape at the document's capture phase, before any React
  // onKeyDown — so a field that clears on Escape must ALSO be a ladder rung, or
  // the press closes the console with the typing in it (escape-ladder.tsx).
  it('clears a half-typed add row without closing the console', () => {
    seed({ goals: [goal()] });
    const onOpenChange = vi.fn();
    render(<OrganizeConsole open onOpenChange={onOpenChange} section="goals" />);
    click('goal-row');
    for (const prefix of ['goal-new-milestone', 'goal-new-checkin', 'goal-new-member']) {
      const field = id(`${prefix}-new-name`) as HTMLInputElement;
      field.focus();
      fireEvent.change(field, { target: { value: 'Half a thought' } });
      fireEvent.keyDown(field, { key: 'Escape' });
      expect(field.value).toBe('');
    }
    expect(onOpenChange).not.toHaveBeenCalled();

    // …and with nothing left to clear, the next press leaves.
    fireEvent.keyDown(id('goal-new-member-new-name'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('clears the "+ New" why without closing the console or losing the name', () => {
    seed({ goals: [goal({ id: 'g0', name: 'Older goal' })] });
    const onOpenChange = vi.fn();
    render(<OrganizeConsole open onOpenChange={onOpenChange} section="goals" />);
    click('goal-new');
    fireEvent.change(id('goal-new-name'), { target: { value: 'Run a marathon' } });
    const why = id('goal-new-why') as HTMLTextAreaElement;
    why.focus();
    fireEvent.change(why, { target: { value: 'To prove I can.' } });
    fireEvent.keyDown(why, { key: 'Escape' });

    expect(why.value).toBe('');
    expect(id('goal-new-name')).toHaveValue('Run a marathon');
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('supporting work', () => {
  it('makes a plain member task from the add row', () => {
    seed({ goals: [goal()] });
    openGoal();
    const field = id('goal-new-member-new-name');
    fireEvent.change(field, { target: { value: 'Book a tutor' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    const made = usePlannerStore.getState().items.find((i) => i.title === 'Book a tutor');
    expect(made).toMatchObject({ type: 'task', status: 'pending', isScheduled: false });
    const g = usePlannerStore.getState().goals[0];
    expect(g.memberIds).toEqual([made!.id]);
    // A member, not a milestone or a check-in.
    expect(g.milestoneIds).toEqual([]);
    expect(g.checkinIds).toEqual([]);
  });
});

describe('making a goal in the console', () => {
  it('starts the window on the USER\'s today, not the browser\'s', () => {
    // 23:30 UTC is already tomorrow in Auckland — the "new" dialog's today.
    vi.setSystemTime(new Date('2026-08-12T23:30:00.000Z'));
    seed({ goals: [goal({ id: 'g0', name: 'Older goal' })], userTimezone: 'Pacific/Auckland' });
    render(<OrganizeConsole open onOpenChange={() => {}} section="goals" />);
    click('goal-new');
    expect(id('goal-new-window-chip')).toHaveTextContent('From Today');

    fireEvent.change(id('goal-new-name'), { target: { value: 'Run a marathon' } });
    click('goal-add');
    const made = usePlannerStore.getState().goals.find((g) => g.name === 'Run a marathon');
    expect(made?.startsOn).toBe('2026-08-13');
  });

  it('asks for the why and the window, and writes them in the one addGoal', () => {
    seed({ goals: [goal({ id: 'g0', name: 'Older goal' })] });
    render(<OrganizeConsole open onOpenChange={() => {}} section="goals" />);
    click('goal-new');
    // The window starts today; the target is the half left to ask.
    expect(id('goal-new-window-chip')).toHaveTextContent('From Today');

    fireEvent.change(id('goal-new-name'), { target: { value: 'Run a marathon' } });
    fireEvent.change(id('goal-new-why'), { target: { value: '  To prove I can.  ' } });

    click('goal-add');
    const made = usePlannerStore.getState().goals.find((g) => g.name === 'Run a marathon');
    // Born whole — not born bare and patched, which would be two writes and
    // two undo entries for one act.
    expect(made).toMatchObject({ why: 'To prove I can.', startsOn: TODAY, state: 'active' });
    expect(made?.targetOn).toBeUndefined();
    // …and the console lands on it.
    expect(id('goal-name-input')).toHaveValue('Run a marathon');
  });
});
