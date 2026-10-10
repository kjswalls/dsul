import { describe, it, expect } from 'vitest';
import { findLiveProjectByName } from '@/lib/db';

/** The agent project routes' duplicate check: case folds, trash is ignored, a rename may keep its own name. */

const rows = [
  { id: 'p1', user_id: 'u1', name: 'Work', emoji: 'icon:Briefcase', deleted_at: null },
  { id: 'p2', user_id: 'u1', name: 'YouTube', emoji: '', deleted_at: null },
];

// Records the filters so the test can see the query asked for live rows of one user.
function client(data = rows) {
  const filters: string[] = [];
  const q = {
    select: () => q,
    eq: (col: string, v: unknown) => (filters.push(`${col}=${v}`), q),
    is: (col: string, v: unknown) => (filters.push(`${col} is ${v}`), Promise.resolve({ data, error: null })),
  };
  return { filters, from: () => q };
}

describe('findLiveProjectByName', () => {
  it('finds a live project whatever the case', async () => {
    const c = client();
    expect((await findLiveProjectByName('u1', 'youtube', c))?.id).toBe('p2');
    expect(c.filters).toEqual(['user_id=u1', 'deleted_at is null']);
  });

  it('returns null for a new name', async () => {
    expect(await findLiveProjectByName('u1', 'Sunday Softworks', client())).toBeNull();
  });

  it('lets a project keep its own name in a new case', async () => {
    expect(await findLiveProjectByName('u1', 'WORK', client(), 'p1')).toBeNull();
    expect((await findLiveProjectByName('u1', 'WORK', client(), 'p2'))?.id).toBe('p1');
  });
});
