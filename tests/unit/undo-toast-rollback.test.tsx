import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';

/**
 * The undo row, and what the container rollback must not do to it.
 *
 * The surface is a strip above the dock now rather than a sonner toast
 * (components/notices/undo-strip.tsx), so these assertions read the store the
 * hook writes instead of a mocked toast() call. The claims are unchanged — they
 * were never about sonner.
 *
 * `useUndoToast` decides "is this new?" by comparing `actionLog[0].id` against
 * the last one it saw. That is a perfectly good test for the append-only log it
 * was written against — every entry arrives at the front and stays there.
 *
 * `undoFailedCreate` is the first thing in the app that reaches backwards into
 * an already-published log. Its FIRST design popped the failed create's entry
 * off the stack, which changes what `actionLog[0]` IS: the previous entry slides
 * back into the front, its id does not match the ref, and the hook reads that as
 * a brand-new action. The user sees the toast for something they did a minute
 * ago pop up a second time, unprompted, with an Undo button now wired to a
 * different step of the stack than the sentence above it names.
 *
 * `ced2230` replaced the pop with a relabel precisely because reaching backwards
 * is hostile to readers like this one — but the reason it is safe is a property
 * of the log (ids stable, length never shrinks), not of the rollback, and
 * nothing was holding that property in place. These tests hold it.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
  createItem: vi.fn(async () => {}),
  updateItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  createProject: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  deleteProject: vi.fn(async () => {}),
  renameContainerMembers: vi.fn(async () => {}),
  itemDbType: (item: { type: string; customType?: string }) =>
    item.type === 'custom' ? item.customType : item.type,
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

// sonner is still mocked: the planner store reaches for toast.error on a failed
// write, and this file makes one fail on purpose.
vi.mock('sonner', () => ({
  toast: Object.assign(() => 'toast-id', { error: vi.fn(), dismiss: vi.fn() }),
}));

import { usePlannerStore } from '@/lib/planner-store';
import { useUndoStripStore } from '@/lib/undo-strip-store';
import { useUndoToast } from '@/hooks/use-undo-toast';
import * as db from '@/lib/db';

/**
 * Every row the hook has raised, in order. The strip holds ONE at a time — a
 * replacement is the point — so "did this action speak?" has to be recorded as
 * it happens rather than read off the store at the end.
 */
const raised: string[] = [];
useUndoStripStore.subscribe((state, prev) => {
  if (state.entry && state.entry.id !== prev.entry?.id) raised.push(state.entry.label);
});

const store = () => usePlannerStore.getState();
const settle = () => new Promise((r) => setTimeout(r, 0));

const duplicate = Object.assign(new Error('duplicate key value violates unique constraint'), {
  code: '23505',
});

beforeEach(async () => {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue([]);
  vi.mocked(db.fetchProjects).mockResolvedValue([]);
  vi.mocked(db.createProject).mockResolvedValue(undefined);
  await store().initializeStore('user-1');
  useUndoStripStore.setState({ entry: null });
  raised.length = 0;
});

afterEach(cleanup);

/** A significant action, so the hook is actually armed when the rollback runs. */
const deleteAProject = async () => {
  vi.mocked(db.createProject).mockResolvedValueOnce(undefined);
  store().addProject('Reading', 'icon:Book');
  await settle();
  const id = store().projects.find((p) => p.name === 'Reading')!.id;
  store().removeProject(id);
  await settle();
};

describe('a rollback under a live undo row', () => {
  it('does not raise the previous action a second time', async () => {
    const { rerender } = renderHook(() => useUndoToast());

    await deleteAProject();
    rerender();
    expect(raised).toEqual(['Delete project: Reading']);

    // A create goes out and the database refuses it. Nothing the user did.
    vi.mocked(db.createProject).mockRejectedValueOnce(duplicate);
    store().addProject('Work', 'icon:Briefcase');
    await settle();
    rerender();

    // Pop the entry instead of relabelling it and "Delete project: Reading"
    // surfaces again here, minutes later, wired to the wrong step.
    expect(raised).toEqual(['Delete project: Reading']);
  });

  it('leaves the log the same length, so nothing slides into the front', async () => {
    await deleteAProject();
    const before = store().actionLog.map((a) => a.id);

    vi.mocked(db.createProject).mockRejectedValueOnce(duplicate);
    store().addProject('Work', 'icon:Briefcase');
    await settle();

    // The refused create's own entry stays — relabelled, not removed — so every
    // id that was in front of it is still in front of it, at the same index.
    const after = store().actionLog.map((a) => a.id);
    expect(after.slice(1)).toEqual(before);
    expect(store().actionLog[0].label).toBe('Couldn’t add project: Work');
  });

  it('still speaks for the NEXT real action, so the ref did not go stale', async () => {
    const { rerender } = renderHook(() => useUndoToast());
    await deleteAProject();
    rerender();

    vi.mocked(db.createProject).mockRejectedValueOnce(duplicate);
    store().addProject('Work', 'icon:Briefcase');
    await settle();
    rerender();

    vi.mocked(db.createProject).mockResolvedValueOnce(undefined);
    store().addProject('Errands', 'icon:Book');
    await settle();
    const id = store().projects.find((p) => p.name === 'Errands')!.id;
    store().removeProject(id);
    await settle();
    rerender();

    expect(raised).toEqual(['Delete project: Reading', 'Delete project: Errands']);
  });
});
