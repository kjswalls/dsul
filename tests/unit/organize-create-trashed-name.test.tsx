// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The trashed-name refusal, ON THE NEW CREATE FORM.
 *
 * `projects_user_id_name_key` is a plain unique index with no
 * `WHERE deleted_at IS NULL`, so a deleted project keeps its name reserved for
 * the full 30 days while being invisible to the store. Typing that name used to
 * produce a project that opened, took a colour and a time block, and evaporated
 * on the next reload — the insert 23505'd into a `.catch(console.error)` after
 * the optimistic `set()`.
 *
 * `useTrashedNames` + `heldByTrash` close that, and an e2e test has guarded it
 * on the OLD bottom-of-list draft row. This branch moved creation into the third
 * pane (CreateForm), and the guard came with it as a `validate` prop — a prop is
 * easy to drop in a move, and dropping it is SILENT: the form still creates, it
 * just stops refusing. Nothing in the unit suite covered `project-new-problem`,
 * only `type-new-problem`, whose rules are synchronous and local.
 *
 * So this pins the async half: the sentence has to survive a fetch that resolves
 * AFTER the form is already on screen, which is the real order of events.
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

const fetchTrashedNames = vi.fn(async () => ({ projects: [{ id: 'dead-1', name: 'Ghost' }] }));

vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  fetchTrashedNames: (...args: unknown[]) => fetchTrashedNames(...(args as [])),
}));

import { OrganizeConsole } from '@/components/planner/organize/organize-console';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { enableGoalsAndOrganize } from './support/extensions';
import type { Project } from '@/lib/planner-types';

const project = (id: string, name: string): Project => ({
  id,
  name,
  emoji: '📁',
  color: '#888888',
});

beforeEach(() => {
  enableGoalsAndOrganize();
  useUIStore.setState({ confirmRequest: null });
  usePlannerStore.setState({
    items: [],
    projects: [],
    routines: [],
    seasons: [],
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

afterEach(() => {
  cleanup();
  fetchTrashedNames.mockClear();
});

const openProjects = () =>
  render(<OrganizeConsole open onOpenChange={() => {}} section="projects" />);

describe('creating a project whose name the Trash still holds', () => {
  it('refuses it OUT LOUD on the create form, and disables the button', async () => {
    // A live sibling, so the list is not empty and the form is reached the way a
    // user reaches it — through the list head — rather than by auto-open.
    usePlannerStore.setState({ projects: [project('p1', 'Work')] } as never);
    openProjects();

    fireEvent.click(screen.getByTestId('project-new'));
    fireEvent.change(screen.getByTestId('project-new-name'), { target: { value: 'Ghost' } });

    // The bin arrives from the server, so the sentence appears on a later tick
    // than the keystroke. That lateness is the point: a create form that only
    // consulted the bin it had at mount would pass a synchronous assertion and
    // still ship the phantom.
    await waitFor(() =>
      expect(screen.getByTestId('project-new-problem')).toHaveTextContent(/Trash/),
    );
    expect(screen.getByTestId('project-add')).toBeDisabled();
  });

  it('still refuses it when the section is empty and the form auto-opened', async () => {
    // Deleting your only project lands here, which is exactly the sequence that
    // reserves a name and then immediately offers to reuse it.
    openProjects();

    await waitFor(() => expect(screen.getByTestId('project-new-name')).toBeTruthy());
    fireEvent.change(screen.getByTestId('project-new-name'), { target: { value: 'Ghost' } });

    await waitFor(() =>
      expect(screen.getByTestId('project-new-problem')).toHaveTextContent(/Trash/),
    );
    expect(screen.getByTestId('project-add')).toBeDisabled();
  });

  it('says nothing about a name the bin does not hold', async () => {
    usePlannerStore.setState({ projects: [project('p1', 'Work')] } as never);
    openProjects();

    fireEvent.click(screen.getByTestId('project-new'));
    fireEvent.change(screen.getByTestId('project-new-name'), { target: { value: 'Reading' } });

    await waitFor(() => expect(fetchTrashedNames).toHaveBeenCalled());
    expect(screen.queryByTestId('project-new-problem')).toBeNull();
    expect(screen.getByTestId('project-add')).toBeEnabled();
  });
});

/**
 * The look-only preview's landing is not a delete (lib/planner-snapshot.ts).
 *
 * The union above records every project that LEAVES the live array. The
 * preview → fresh landing replaces cached projects with the server's in one
 * set(), so a project the cache had and the server lacks would read as deleted
 * here and its name would be refused — for a row that was never in this
 * session's bin, and may be in no bin at all. The failure drop empties the
 * array outright, and is no delete either. The server's bin speaks for any
 * real deletion.
 */
describe('the preview landing fences no names', () => {
  afterEach(() => {
    usePlannerStore.setState({ isPreview: false, error: null } as never);
  });

  const typeName = async (name: string) => {
    fireEvent.click(screen.getByTestId('project-new'));
    fireEvent.change(screen.getByTestId('project-new-name'), { target: { value: name } });
    await waitFor(() => expect(fetchTrashedNames).toHaveBeenCalled());
  };

  it('preview → fresh: a cached project the server no longer has is not held', async () => {
    usePlannerStore.setState({
      isPreview: true,
      isLoading: true,
      projects: [project('p1', 'Work'), project('p-stale', 'Stale')],
    } as never);
    openProjects();
    usePlannerStore.setState({ isPreview: false, isLoading: false, projects: [project('p1', 'Work')] } as never);

    await typeName('Stale');
    expect(screen.queryByTestId('project-new-problem')).toBeNull();
    expect(screen.getByTestId('project-add')).toBeEnabled();
  });

  it('the failure drop: nothing the preview showed is held', async () => {
    usePlannerStore.setState({
      isPreview: true,
      isLoading: true,
      projects: [project('p1', 'Work'), project('p-stale', 'Stale')],
    } as never);
    openProjects();
    usePlannerStore.setState({ isPreview: false, isLoading: false, error: 'offline', projects: [] } as never);

    await waitFor(() => expect(screen.getByTestId('project-new-name')).toBeTruthy());
    fireEvent.change(screen.getByTestId('project-new-name'), { target: { value: 'Stale' } });
    await waitFor(() => expect(fetchTrashedNames).toHaveBeenCalled());
    expect(screen.queryByTestId('project-new-problem')).toBeNull();
  });

  it('a project removed AFTER the landing is still held (the fence is intact)', async () => {
    usePlannerStore.setState({
      isPreview: true,
      isLoading: true,
      projects: [project('p1', 'Work'), project('p2', 'Errands')],
    } as never);
    openProjects();
    usePlannerStore.setState({
      isPreview: false,
      isLoading: false,
      projects: [project('p1', 'Work'), project('p2', 'Errands')],
    } as never);
    // What removeProject does to the live array.
    usePlannerStore.setState({ projects: [project('p1', 'Work')] } as never);

    await typeName('Errands');
    expect(screen.getByTestId('project-new-problem')).toHaveTextContent(/Trash/);
  });
});
