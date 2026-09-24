// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * The C2 wiring, end to end, in EDIT mode — the case a mocked-onCreate unit test
 * cannot see and where the real bug lived.
 *
 * Inline-creating a container from a membership chip runs, in ONE handler,
 * `toggle(add(...), true)`: the store gains the new container and the toggle
 * must then tick it onto the CURRENT item. In edit mode the toggle used to look
 * the new container up in the render-closure array, which does not yet hold it —
 * so the container was created and the item silently joined nothing. These drive
 * the real dialog and assert the item actually became a member.
 *
 * The db writers are no-oped (the store's optimistic set() is what these read);
 * everything else is the real store and the real dialog.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useParams: () => ({}),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}));

vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  fetchTrashedNames: vi.fn(async () => []),
  fetchItemEvents: vi.fn(async () => []),
  getItemEventsAvailable: () => false,
  createRoutine: vi.fn(async () => {}),
  updateRoutine: vi.fn(async () => {}),
  createProgram: vi.fn(async () => {}),
  updateProgram: vi.fn(async () => {}),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
}));

import { ItemDialog } from '@/components/planner/item-dialog';
import { usePlannerStore } from '@/lib/planner-store';
import { EXT_GOALS, EXT_ORGANIZE } from '@/lib/extension-registry';
import { enableExtensions } from './support/extensions';
import type { Item } from '@/lib/planner-types';

const ITEM: Item = {
  type: 'task',
  id: 't1',
  title: 'Write the deck',
  status: 'pending',
  isScheduled: false,
  order: 0,
} as Item;

beforeEach(() => {
  enableExtensions(EXT_GOALS, EXT_ORGANIZE);
  // Zero of every container, so a just-created one is provably absent from the
  // render-closure array the buggy path read.
  usePlannerStore.setState({
    items: [ITEM],
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
  } as never);
});

afterEach(cleanup);

const openEdit = () =>
  render(
    <ItemDialog
      presentation="panel"
      state={{ mode: 'edit', item: ITEM }}
      onOpenChange={() => {}}
      withDetailSections={false}
    />
  );

/**
 * Panel + edit is CLEARING mode, where an unset container has no chip at rest —
 * it is summoned from the "Add property" seed (see item-dialog.tsx). These cases
 * deliberately start with zero containers, so every one of them starts unset and
 * every one has to be summoned. Matched on `data-value`, never on label copy.
 */
const revealContainer = (kind: 'routine' | 'program' | 'goal') => {
  fireEvent.click(screen.getByTestId('item-clearing-seed'));
  const option = screen
    .getAllByTestId('item-clearing-seed-option')
    .find((el) => el.getAttribute('data-value') === kind);
  if (!option) throw new Error(`no seed option for ${kind}`);
  fireEvent.click(option);
};

const inlineCreate = (kind: 'routine' | 'program' | 'goal', name: string) => {
  // Summoning a property opens its picker on its own — no second click.
  revealContainer(kind);
  fireEvent.click(screen.getByTestId(`item-dialog-${kind}-new-open`));
  fireEvent.change(screen.getByTestId(`item-dialog-${kind}-new-name`), {
    target: { value: name },
  });
  fireEvent.click(screen.getByTestId(`item-dialog-${kind}-new-add`));
};

describe('inline-create attaches the edited item (C2)', () => {
  it('creates a routine and joins the item to it', () => {
    openEdit();
    inlineCreate('routine', 'Morning reset');

    const routines = usePlannerStore.getState().routines;
    expect(routines).toHaveLength(1);
    expect(routines[0].name).toBe('Morning reset');
    expect(routines[0].itemIds).toContain('t1');
  });

  it('creates a program and joins the item to it', () => {
    openEdit();
    inlineCreate('program', 'Autumn term');

    const programs = usePlannerStore.getState().programs;
    expect(programs).toHaveLength(1);
    expect(programs[0].name).toBe('Autumn term');
    expect(programs[0].itemIds).toContain('t1');
  });

  it('creates a goal and joins the item as a plain MEMBER, never a milestone', () => {
    openEdit();
    inlineCreate('goal', 'Run a 10k');

    const goals = usePlannerStore.getState().goals;
    expect(goals).toHaveLength(1);
    expect(goals[0].name).toBe('Run a 10k');
    // The add dialog only ever grants membership — roles are the goal's own call.
    expect(goals[0].memberIds).toContain('t1');
    expect(goals[0].milestoneIds).not.toContain('t1');
    expect(goals[0].checkinIds).not.toContain('t1');
  });
});
