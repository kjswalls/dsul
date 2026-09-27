import { describe, it, expect, beforeEach, vi } from 'vitest';

// Every write the fake database sees, and whether it has migration 046 yet.
const writes: { table: string; op: 'insert' | 'update'; row: Record<string, unknown> }[] = [];
let hasNotesColumn = false;
let otherError: { code: string; message: string } | null = null;

const answer = (row: Record<string, unknown>) =>
  Promise.resolve({
    error: otherError ??
      ('notes' in row && !hasNotesColumn
        ? { code: 'PGRST204', message: "Could not find the 'notes' column in the schema cache" }
        : null),
  });

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        writes.push({ table, op: 'insert', row });
        return answer(row);
      },
      update: (row: Record<string, unknown>) => {
        writes.push({ table, op: 'update', row });
        const chain = { eq: () => chain, then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => answer(row).then(f, r) };
        return chain;
      },
    }),
  }),
}));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));

import { createProject, createRoutine, updateProgram, updateRoutine } from '@/lib/db';

/**
 * Migration 046 adds `notes` to routines, programs and projects, and a build
 * can reach production before `pnpm db:push` does. PostgREST rejects a whole
 * row naming a column it lacks — so without a fallback, a note riding along
 * would sink a create, and an undo's full-shape restore (which always carries
 * the key) would sink the rename and pause state with it.
 */
describe('container writes before migration 046', () => {
  beforeEach(() => {
    writes.length = 0;
    hasNotesColumn = false;
    otherError = null;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('creates a routine WITH a note by retrying without it', async () => {
    await createRoutine('u1', { id: 'r1', name: 'Evenings', itemIds: [], notes: 'Wind down.' });
    expect(writes.map((w) => 'notes' in w.row)).toEqual([true, false]);
    expect(writes[1].row).toMatchObject({ id: 'r1', name: 'Evenings' });
  });

  it('keeps the rest of an update that carried the note', async () => {
    await updateRoutine('u1', 'r1', { name: 'Nights', notes: undefined });
    expect(writes).toHaveLength(2);
    expect(writes[1].row).toEqual({ name: 'Nights' });
  });

  it('writes nothing more when the note was all there was', async () => {
    await updateProgram('u1', 'p1', { notes: 'Term two.' });
    expect(writes).toHaveLength(1);
  });

  it('creates a project the same way', async () => {
    await createProject('u1', { id: 'pr1', name: 'Home', emoji: '', notes: 'Chores.' });
    expect(writes.map((w) => 'notes' in w.row)).toEqual([true, false]);
  });

  it('writes the note once 046 is there', async () => {
    hasNotesColumn = true;
    await updateRoutine('u1', 'r1', { notes: 'Kept.' });
    expect(writes).toEqual([{ table: 'routines', op: 'update', row: { notes: 'Kept.' } }]);
  });

  it('throws any other error, without retrying', async () => {
    otherError = { code: '42501', message: 'permission denied' };
    await expect(updateRoutine('u1', 'r1', { name: 'x', notes: 'n' })).rejects.toMatchObject({ code: '42501' });
    expect(writes).toHaveLength(1);
  });
});
