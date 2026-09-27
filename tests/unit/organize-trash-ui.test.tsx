import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The Trash SECTION — the console's one heterogeneous list, and its one
 * per-row action.
 *
 * What is worth pinning here rather than in the store tests:
 *
 *  - The KIND is on the row as a word. Every other section is homogeneous, so
 *    its column header names the kind for every row at once; this one is not,
 *    and a name-hashed CategoryIcon encodes no kind whatsoever. A trashed task
 *    and a trashed project both called "Reading" would otherwise be
 *    pixel-identical, and ⌘Z after restoring the wrong one is not a recovery.
 *  - A FAILED fetch says so. Rendering an empty list would tell someone hunting
 *    for a deleted routine that it is gone for good — the one wrong answer this
 *    surface can give.
 *  - The Restore control is a real button, always visible, and carries
 *    `data-organize-row` so the filter's ↓ still lands somewhere useful.
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

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }) }));

const listDeleted = vi.fn();
const createProject = vi.fn(async () => {});
const fetchTrashedNames = vi.fn(async () => ({ projects: [], groups: [] }));
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listDeleted: (...args: unknown[]) => listDeleted(...args),
    createProject: (...args: unknown[]) => createProject(...(args as [])),
    fetchTrashedNames: (...args: unknown[]) => fetchTrashedNames(...(args as [])),
  };
});

import { OrganizeConsole } from '@/components/planner/organize/organize-console';
import { daysUntilPurge, whenGone } from '@/components/planner/organize/sections/trash';
import { heldByTrash, useTrashedNames } from '@/components/planner/organize/use-trashed-names';
import { usePlannerStore } from '@/lib/planner-store';
import { enableGoalsAndOrganize } from './support/extensions';
import type { TrashEntry } from '@/lib/db';

const DELETED = '2026-08-12T10:00:00.000Z';

const restoreFromTrash = vi.fn();

beforeEach(() => {
  // Trash lives in the console, and the console ships off.
  enableGoalsAndOrganize();
  listDeleted.mockReset();
  createProject.mockReset();
  createProject.mockResolvedValue(undefined);
  fetchTrashedNames.mockClear();
  restoreFromTrash.mockReset();
  usePlannerStore.setState({
    userId: 'u1',
    isLoading: false,
    items: [],
    projects: [],
    routines: [],
    seasons: [],
    itemTypes: [],
    restoreFromTrash,
  } as never);
});

afterEach(cleanup);

const openTrash = () =>
  render(<OrganizeConsole open onOpenChange={() => {}} section="trash" />);

const entry = (over: Partial<TrashEntry>): TrashEntry =>
  ({
    kind: 'item', id: 'i1', name: 'A task', deletedAt: DELETED,
    entity: { type: 'task', id: 'i1', title: 'A task', status: 'pending', isScheduled: false, order: 0 },
    ...over,
  }) as TrashEntry;

describe('the Trash section', () => {
  it('names the KIND on every row, because the list mixes them', async () => {
    listDeleted.mockResolvedValue([
      entry({ kind: 'item', id: 'i1', name: 'Reading' }),
      entry({ kind: 'project', id: 'p1', name: 'Reading', entity: { id: 'p1', name: 'Reading', emoji: 'x' } }),
    ]);
    openTrash();

    const rows = await screen.findAllByTestId('trash-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Item');
    expect(rows[1].textContent).toContain('Project');
  });

  it('says how many subtasks come back with a parent', async () => {
    listDeleted.mockResolvedValue([
      entry({ name: 'Plan trip', children: [entry({ id: 'k1' }).entity, entry({ id: 'k2' }).entity] as never }),
    ]);
    openTrash();
    expect((await screen.findByTestId('trash-row')).textContent).toContain('2 subtasks');
  });

  it('says how many members will re-file with a container', async () => {
    listDeleted.mockResolvedValue([
      entry({ kind: 'project', id: 'p1', name: 'Work', memberIds: ['a', 'b', 'c'],
        entity: { id: 'p1', name: 'Work', emoji: 'x' } }),
    ]);
    openTrash();
    expect((await screen.findByTestId('trash-row')).textContent).toContain('3 items refile');
  });

  it('hands the whole entry to the store and drops the row', async () => {
    const row = entry({ name: 'A task' });
    listDeleted.mockResolvedValue([row]);
    openTrash();

    fireEvent.click(await screen.findByTestId('trash-restore'));

    expect(restoreFromTrash).toHaveBeenCalledWith(row);
    // Dropped locally rather than refetched — the bin is a snapshot, and a row
    // that stays after a successful restore reads as the restore not working.
    await waitFor(() => expect(screen.queryByTestId('trash-row')).toBeNull());
  });

  it('reports a failed fetch instead of rendering an empty bin', async () => {
    listDeleted.mockRejectedValue(new Error('network'));
    openTrash();

    expect(await screen.findByTestId('trash-failed')).toBeTruthy();
    expect(screen.queryByTestId('trash-empty')).toBeNull();
  });

  it('keeps saying the fetch failed once the user types in the filter', async () => {
    // ListColumn's centralised no-match branch replaces CHILDREN, not just an
    // empty row list — so one keystroke used to swap "Couldn't load the trash"
    // for "Nothing matches 'x'", turning an outage into a confident claim that
    // the thing you are hunting for is not in the bin.
    listDeleted.mockRejectedValue(new Error('network'));
    openTrash();
    await screen.findByTestId('trash-failed');

    fireEvent.change(screen.getByTestId('trash-filter'), { target: { value: 'x' } });

    expect(screen.getByTestId('trash-failed')).toBeTruthy();
  });

  it('still says "nothing matches" when a LOADED bin has no match', async () => {
    // The suppression must be scoped to "we have no answer", not to the whole
    // section — otherwise filtering a real bin silently shows an empty list.
    listDeleted.mockResolvedValue([entry({ name: 'Groceries' })]);
    openTrash();
    await screen.findByTestId('trash-row');

    fireEvent.change(screen.getByTestId('trash-filter'), { target: { value: 'zzz' } });

    expect(screen.queryByTestId('trash-row')).toBeNull();
    expect(screen.getByTestId('organize-list').textContent).toContain('Nothing matches');
  });

  it('puts the kind in the Restore button’s accessible name', async () => {
    listDeleted.mockResolvedValue([
      entry({ kind: 'item', id: 'i1', name: 'Reading' }),
      entry({ kind: 'project', id: 'p1', name: 'Reading', entity: { id: 'p1', name: 'Reading', emoji: 'x' } }),
    ]);
    openTrash();
    await screen.findAllByTestId('trash-row');

    // Two rows, two DISTINCT accessible names — otherwise a screen-reader user
    // is choosing between them blind.
    expect(screen.getByLabelText('Restore item Reading')).toBeTruthy();
    expect(screen.getByLabelText('Restore project Reading')).toBeTruthy();
  });

  it('distinguishes an empty bin from one that never loaded', async () => {
    listDeleted.mockResolvedValue([]);
    openTrash();
    expect(await screen.findByTestId('trash-empty')).toBeTruthy();
  });

  it('filters on the name AND the kind', async () => {
    listDeleted.mockResolvedValue([
      entry({ kind: 'item', id: 'i1', name: 'Groceries' }),
      entry({ kind: 'routine', id: 'r1', name: 'Morning', entity: { id: 'r1', name: 'Morning', itemIds: [] } }),
    ]);
    openTrash();
    await screen.findAllByTestId('trash-row');

    fireEvent.change(screen.getByTestId('trash-filter'), { target: { value: 'routine' } });

    const rows = screen.getAllByTestId('trash-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Morning');
  });

  it('puts the filter’s ArrowDown target on the Restore button', async () => {
    // `data-organize-row` is looked up with querySelector at any depth, so the
    // hook works from the verb — and Enter then does the only thing a trash row
    // can do. See detail-parts.tsx's FilterRow.
    listDeleted.mockResolvedValue([entry({})]);
    openTrash();
    const restore = await screen.findByTestId('trash-restore');
    expect(restore.hasAttribute('data-organize-row')).toBe(true);
    expect(restore.tagName).toBe('BUTTON');
  });
});

describe('the Trash preview', () => {
  it('opens a READ-ONLY preview when a row is selected', async () => {
    listDeleted.mockResolvedValue([
      entry({
        kind: 'item', id: 'i1', name: 'Call dentist',
        entity: {
          type: 'task', id: 'i1', title: 'Call dentist', status: 'pending',
          isScheduled: true, order: 0, startDate: '2026-08-25', timeBucket: 'afternoon',
          project: 'Health', notes: 'ask about the crown',
        },
      }),
    ]);
    openTrash();

    fireEvent.click(await screen.findByTestId('trash-select'));

    const preview = await screen.findByTestId('trash-preview');
    expect(preview.textContent).toContain('Call dentist');
    expect(preview.textContent).toContain('Task'); // the item's TYPE, not the generic "Item"
    expect(preview.textContent).toContain('Health'); // project fact
    expect(preview.textContent).toContain('ask about the crown'); // notes
    // The one guardrail: no editable control. ItemDialog's panel writes for a
    // binned id vanish silently, so the preview must never present a field.
    expect(preview.querySelector('input')).toBeNull();
    expect(preview.querySelector('textarea')).toBeNull();
  });

  it('lists the subtasks that come back with a parent', async () => {
    listDeleted.mockResolvedValue([
      entry({
        kind: 'item', id: 'i1', name: 'Plan trip',
        children: [
          { type: 'task', id: 'k1', title: 'Book flights', status: 'completed', isScheduled: false, order: 0 },
          { type: 'task', id: 'k2', title: 'Pack bags', status: 'pending', isScheduled: false, order: 0 },
        ] as never,
      }),
    ]);
    openTrash();

    fireEvent.click(await screen.findByTestId('trash-select'));

    const preview = await screen.findByTestId('trash-preview');
    expect(preview.textContent).toContain('2 subtasks come back');
    expect(preview.textContent).toContain('Book flights');
    expect(preview.textContent).toContain('Pack bags');
  });

  it('previews a container with what a restore reconnects', async () => {
    listDeleted.mockResolvedValue([
      entry({
        kind: 'project', id: 'p1', name: 'Side quests', memberIds: ['a', 'b', 'c'],
        entity: { id: 'p1', name: 'Side quests', emoji: 'icon:Folder' },
      }),
    ]);
    openTrash();

    fireEvent.click(await screen.findByTestId('trash-select'));

    const preview = await screen.findByTestId('trash-preview');
    expect(preview.textContent).toContain('re-files the 3 items');
  });

  it('restoring the selected row clears the preview and drops the row', async () => {
    const row = entry({ name: 'A task' });
    listDeleted.mockResolvedValue([row]);
    openTrash();
    fireEvent.click(await screen.findByTestId('trash-select'));
    await screen.findByTestId('trash-preview');

    // Restore from WITHIN the preview — the second copy of the verb.
    fireEvent.click(screen.getByTestId('trash-preview-restore'));

    expect(restoreFromTrash).toHaveBeenCalledWith(row);
    // The row leaves the bin, so the preview it fed must clear rather than
    // describe a ghost.
    await waitFor(() => expect(screen.queryByTestId('trash-preview')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('trash-row')).toBeNull());
  });

  it('offers nothing to select in a failed bin', async () => {
    listDeleted.mockRejectedValue(new Error('network'));
    openTrash();
    await screen.findByTestId('trash-failed');

    expect(screen.queryByTestId('trash-select')).toBeNull();
    expect(screen.queryByTestId('trash-preview')).toBeNull();
  });

  it('keeps Enter on the row a RESTORE, not a select', async () => {
    // The pinned keyboard contract survives the new select affordance: the
    // filter's ArrowDown target — and therefore Enter — is still the Restore
    // verb, never the row-body select button.
    listDeleted.mockResolvedValue([entry({})]);
    openTrash();
    const restore = await screen.findByTestId('trash-restore');
    const select = screen.getByTestId('trash-select');
    expect(restore.hasAttribute('data-organize-row')).toBe(true);
    expect(select.hasAttribute('data-organize-row')).toBe(false);
  });
});

describe('whenGone', () => {
  const at = (iso: string) => new Date(iso).getTime();

  it('rounds DOWN, so the count never runs ahead of the purge', () => {
    // 36 HOURS, not 25. The first version of this test used 25h — where floor
    // and round agree (both 1) — so it could not tell the two apart and stayed
    // green against Math.round. 36h is 1.5 days: floor says 1, round says 2.
    expect(whenGone('2026-08-12T10:00:00.000Z', at('2026-08-13T22:00:00.000Z'))).toBe('1d ago');
  });

  it('reads in hours inside the first day', () => {
    expect(whenGone('2026-08-12T10:00:00.000Z', at('2026-08-12T15:30:00.000Z'))).toBe('5h ago');
  });

  it('says "just now" rather than "0h ago"', () => {
    expect(whenGone('2026-08-12T10:00:00.000Z', at('2026-08-12T10:20:00.000Z'))).toBe('just now');
  });

  it('does not render a negative age from a clock skew', () => {
    // A DAY behind, not an hour. At one hour the `hours < 1` branch already
    // returns "just now", so the negative guard was doing nothing the test
    // could see; at 25 hours behind, without it, Math.floor(-25/24) prints
    // "-2d ago".
    expect(whenGone('2026-08-12T10:00:00.000Z', at('2026-08-11T09:00:00.000Z'))).toBe('just now');
  });

  it('survives a malformed timestamp rather than printing NaN', () => {
    expect(whenGone('not-a-date', at('2026-08-12T10:00:00.000Z'))).toBe('just now');
  });
});

describe('daysUntilPurge', () => {
  const at = (iso: string) => new Date(iso).getTime();

  it('gives the full 30-day window to something just deleted', () => {
    expect(daysUntilPurge('2026-08-12T10:00:00.000Z', at('2026-08-12T10:20:00.000Z'))).toBe(30);
  });

  it('counts down whole elapsed days, matching whenGone', () => {
    // 2 days and 20 hours in: 2 days elapsed, so 28 left — never running ahead
    // of the purge the way rounding up would.
    expect(daysUntilPurge('2026-08-12T10:00:00.000Z', at('2026-08-15T06:00:00.000Z'))).toBe(28);
  });

  it('clamps at 0 rather than going negative past the window', () => {
    expect(daysUntilPurge('2026-07-01T10:00:00.000Z', at('2026-08-12T10:00:00.000Z'))).toBe(0);
  });

  it('gives a malformed or future stamp the benefit of the doubt', () => {
    expect(daysUntilPurge('not-a-date', at('2026-08-12T10:00:00.000Z'))).toBe(30);
    expect(daysUntilPurge('2026-08-20T10:00:00.000Z', at('2026-08-12T10:00:00.000Z'))).toBe(30);
  });
});

describe('heldByTrash', () => {
  const trashed = [{ id: 'p1', name: 'Work' }];

  it('refuses an exact repeat and names the holder', () => {
    expect(heldByTrash(trashed, 'Work', 'project')).toContain('“Work”');
    expect(heldByTrash(trashed, 'Work', 'project')).toContain('Trash');
  });

  it('allows a case variant, because the unique index is case-SENSITIVE', () => {
    // Refusing "work" here would block a name Postgres accepts — the opposite
    // failure, and just as invisible to the person typing.
    expect(heldByTrash(trashed, 'work', 'project')).toBeNull();
  });

  it('says nothing about a free name', () => {
    expect(heldByTrash(trashed, 'Home', 'project')).toBeNull();
  });

  it('names the noun it was given, so the group copy is not about projects', () => {
    expect(heldByTrash(trashed, 'Work', 'habit group')).toContain('habit group');
  });
});

describe('the trashed-name guard does not go stale mid-session', () => {
  /**
   * The hole the review found and the first version's comment denied.
   *
   * `removeProject` FILTERS the row out of state.projects, so after deleting a
   * project without leaving the section there is no live sibling for takenBy to
   * match — and the server bin was fetched before the delete. Two clicks apart,
   * the create row would accept the name, the store would seat a phantom the
   * database refused with 23505, and every item filed into it would fail on the
   * FK. No refetch here: the union is fed by a store subscription, because
   * removeProject does not await its DB write and a refetch would race it.
   */
  it('refuses a name deleted moments ago in the same section, with no refetch', async () => {
    usePlannerStore.setState({
      projects: [{ id: 'p1', name: 'Work', emoji: 'icon:Briefcase' }],
    } as never);

    render(<OrganizeConsole open onOpenChange={() => {}} section="projects" />);
    await screen.findByTestId('project-row');

    // Delete it the way the detail pane does.
    act(() => {
      usePlannerStore.setState({ projects: [] } as never);
    });

    fireEvent.change(screen.getByTestId('project-new-name'), { target: { value: 'Work' } });

    expect(screen.getByTestId('project-new-problem').textContent).toContain('Trash');
    expect(screen.getByTestId('project-add')).toBeDisabled();
  });

  it('lets the name go again once the container is restored', async () => {
    usePlannerStore.setState({
      projects: [{ id: 'p1', name: 'Work', emoji: 'icon:Briefcase' }],
    } as never);
    render(<OrganizeConsole open onOpenChange={() => {}} section="projects" />);
    await screen.findByTestId('project-row');

    act(() => usePlannerStore.setState({ projects: [] } as never));
    // ⌘Z, or a restore out of the Trash — either way it is live again, so the
    // name is no longer held by anything and the guard must stand down.
    act(() =>
      usePlannerStore.setState({
        projects: [{ id: 'p1', name: 'Work', emoji: 'icon:Briefcase' }],
      } as never)
    );

    // The list is populated again, so the create form is no longer standing in
    // for an empty section — open it from the list head.
    fireEvent.click(screen.getByTestId('project-new'));
    fireEvent.change(screen.getByTestId('project-new-name'), { target: { value: 'Work' } });
    expect(screen.queryByTestId('project-new-problem')).toBeNull();
  });

  /**
   * The union tracks LEAVING the live array, and `undoFailedCreate` makes a
   * container leave it — so the store's own rollback fed the guard a name that
   * nothing anywhere is holding.
   *
   * The user's second attempt is then refused with a sentence that is simply
   * false ("a deleted project called Work still has that name"), and pointed at
   * a Trash that does not contain it. Retrying is the ONE thing they can
   * usefully do after `Couldn't create "Work". Nothing was saved.` — and it is
   * the thing this locked them out of, for the rest of the visit, with no way
   * back but a reload.
   *
   * Note the failure here is deliberately NOT 23505. On a unique violation
   * there really is a trashed row holding the name and the server list already
   * carries it, correct id and all; it is every other rejection — offline, RLS,
   * a dropped connection — where the phantom's id is the only thing in the
   * union, and where refusing is pure invention.
   */
  it('lets the user retry a name whose create the database refused', async () => {
    const failed = new Error('network');
    createProject.mockRejectedValueOnce(failed);

    render(<OrganizeConsole open onOpenChange={() => {}} section="projects" />);

    fireEvent.change(screen.getByTestId('project-new-name'), { target: { value: 'Work' } });
    fireEvent.click(screen.getByTestId('project-add'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Gone from the canvas — that part is the rollback working.
    expect(usePlannerStore.getState().projects).toEqual([]);

    fireEvent.change(screen.getByTestId('project-new-name'), { target: { value: 'Work' } });
    expect(screen.queryByTestId('project-new-problem')).toBeNull();
    expect(screen.getByTestId('project-add')).not.toBeDisabled();
  });
});

describe('what the bin lookup costs', () => {
  /**
   * ItemDialog's body now mounts on open (its wrapper unmounts it after the
   * close grace), so an ungated call here no longer fires during first paint —
   * the stakes moved, not the mechanism. Each call of this hook is still two
   * SELECTs, the body still lingers mounted through the ~600ms close grace
   * where an ungated hook would re-ask for a closing surface, and the hook
   * must still ask nothing at all while disabled.
   *
   * These pin the mechanism. The dialog's own half is `enabled: !!state` at its
   * call site, which is not observable from here without standing the whole
   * component up.
   */
  const Probe = ({ on = true }: { on?: boolean }) => {
    useTrashedNames({ enabled: on });
    return null;
  };

  it('asks nothing while disabled, and asks once it is enabled', async () => {
    const view = render(<Probe on={false} />);
    await act(async () => {});
    expect(fetchTrashedNames).not.toHaveBeenCalled();

    view.rerender(<Probe on />);
    await act(async () => {});
    expect(fetchTrashedNames).toHaveBeenCalledTimes(1);
  });

  it('collapses hooks that mount together into one round trip', async () => {
    // The console's Labels pane: Projects and Habit groups each call the hook,
    // both mount in the same tick, and neither knows about the other.
    render(
      <>
        <Probe />
        <Probe />
        <Probe />
      </>
    );
    await act(async () => {});
    expect(fetchTrashedNames).toHaveBeenCalledTimes(1);
  });

  it('does not cache the ANSWER — a later mount reads the bin again', async () => {
    const first = render(<Probe />);
    await act(async () => {});
    first.unmount();

    render(<Probe />);
    await act(async () => {});
    // Sharing an in-flight request is free; sharing a settled one would mean a
    // container binned since the first read stayed invisible for the session.
    expect(fetchTrashedNames).toHaveBeenCalledTimes(2);
  });
});
