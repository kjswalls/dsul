import { describe, it, expect } from 'vitest';
import { groupRows, type GroupableRow, type RowGroup } from '@/lib/grouping';
import type { Task, HabitItem, Routine, Season } from '@/lib/planner-types';

/**
 * Group-by-season — the routine grouping's sibling, with the one thing routine
 * grouping never has to do: resolve TRANSITIVE membership. A season gates work
 * directly (season_items) AND through the routines it holds (season_routines →
 * routine_items), so the school-year season that contains a Chinese routine
 * groups that routine's habits under itself. Reading `season.itemIds` alone
 * would silently drop every item a season only reaches via a routine.
 *
 * Everything else is the routine contract, and it is here for the same reason
 * group-by-routine.test.ts is: one row / one group, key by id / label by name,
 * a trailing loose bucket, no empty headings.
 */

const task = (id: string, over: Partial<Task> = {}): Task =>
  ({ id, title: `Task ${id}`, status: 'pending', isScheduled: true, order: 0, timeBucket: 'morning', ...over }) as Task;

const habit = (id: string, over: Partial<HabitItem> = {}): HabitItem =>
  ({ id, title: `HabitItem ${id}`, project: 'G', streak: 0, status: 'pending', completedDates: [], skippedDates: [], repeatFrequency: 'daily', timeBucket: 'morning', ...over }) as HabitItem;

const routine = (id: string, name: string, itemIds: string[]): Routine => ({ id, name, itemIds });

const season = (id: string, name: string, itemIds: string[], routineIds: string[] = []): Season =>
  ({ id, name, state: 'auto', itemIds, routineIds }) as Season;

/** Habits then tasks — the row order `flattenDayRows` hands every surface. */
function groups(
  tasks: Task[],
  habits: HabitItem[],
  seasons: Season[],
  routines: Routine[] = []
): RowGroup<GroupableRow>[] {
  const rows: GroupableRow[] = [
    ...habits.map((h) => ({ itemType: 'habit' as const, item: h })),
    ...tasks.map((t) => ({ itemType: 'task' as const, item: t })),
  ];
  return groupRows(rows, 'season', { seasons, routines });
}

const ids = (g: RowGroup<GroupableRow>) => g.rows.map((r) => r.item.id);

describe('groupRows — group by season', () => {
  it('puts habits and tasks a season holds directly under the same section', () => {
    const out = groups([task('t1')], [habit('h1')], [season('p', 'Summer', ['h1', 't1'])]);
    expect(out.map((g) => g.label)).toEqual(['Summer']);
    expect(ids(out[0])).toEqual(['h1', 't1']);
  });

  it('pulls in a member reachable ONLY through a routine the season holds', () => {
    // The transitive walk — the whole reason seasonGroups is not routineGroups
    // with the names swapped. h1 is in no season directly; it rides in through
    // the Chinese routine the season contains.
    const out = groups(
      [],
      [habit('h1')],
      [season('p', 'School year', [], ['r'])],
      [routine('r', 'Chinese', ['h1'])]
    );
    expect(out.map((g) => g.label)).toEqual(['School year']);
    expect(ids(out[0])).toEqual(['h1']);
  });

  it('orders a season’s own items before the items it reaches via routines', () => {
    // seasonMemberIds walks direct itemIds first, then each routine in
    // routineIds order — the order the group renders in, since sortRows('default')
    // is identity. 'b' is direct; 'a' arrives only through the routine.
    const out = groups(
      [task('a'), task('b')],
      [],
      [season('p', 'P', ['b'], ['r'])],
      [routine('r', 'R', ['a'])]
    );
    expect(ids(out[0])).toEqual(['b', 'a']);
  });

  it('renders a multi-season item once, in the first season that claims it', () => {
    // One row / one group under the OR rule — a duplicate is two checkboxes for
    // one obligation, exactly as with routines.
    const out = groups([task('a')], [], [season('p1', 'First', ['a']), season('p2', 'Second', ['a'])]);
    expect(out.map((g) => g.label)).toEqual(['First']);
    expect(out.flatMap(ids)).toEqual(['a']);
  });

  it('does not double-count an item that is both a direct member and in a held routine', () => {
    // Deduped within the season, at its direct position — otherwise the same
    // item would render twice under one heading.
    const out = groups(
      [task('x')],
      [],
      [season('p', 'P', ['x'], ['r'])],
      [routine('r', 'R', ['x'])]
    );
    expect(out.map((g) => g.label)).toEqual(['P']);
    expect(ids(out[0])).toEqual(['x']);
  });

  it('keeps two same-named seasons apart', () => {
    // Names are not unique — no UNIQUE on the column, rename ships from day one.
    // Keyed on the name they would merge into one heading holding both.
    const out = groups(
      [task('a'), task('b')],
      [],
      [season('p1', 'Term', ['a']), season('p2', 'Term', ['b'])]
    );
    expect(out.map((g) => g.label)).toEqual(['Term', 'Term']);
    expect(out.map((g) => g.key)).toEqual(['p1', 'p2']);
    expect(out.map(ids)).toEqual([['a'], ['b']]);
  });

  it('collects everything unclaimed under one trailing group', () => {
    const out = groups([task('a'), task('loose')], [], [season('p', 'P', ['a'])]);
    expect(out.map((g) => g.label)).toEqual(['P', 'No season']);
    expect(ids(out[1])).toEqual(['loose']);
  });

  it('tags the real season section as a gate, and the loose bucket as none', () => {
    const out = groups([task('a'), task('loose')], [], [season('p', 'P', ['a'])]);
    expect(out[0].gate).toEqual({ kind: 'season', id: 'p' });
    expect(out[1].gate).toBeUndefined();
  });

  it('gives the unclaimed group a key a season cannot collide with', () => {
    // Group keys ARE React keys — a season the user literally named "No season"
    // would otherwise mount two sections under one key.
    const out = groups([task('a'), task('loose')], [], [season('p', 'No season', ['a'])]);
    expect(out.map((g) => g.label)).toEqual(['No season', 'No season']);
    expect(new Set(out.map((g) => g.key)).size).toBe(2);
  });

  it('drops a season with nothing on this day rather than showing an empty heading', () => {
    const out = groups([task('a')], [], [season('p1', 'On', ['a']), season('p2', 'Off', ['x'])]);
    expect(out.map((g) => g.label)).toEqual(['On']);
  });

  it('ignores a held routine id that resolves to no routine', () => {
    // Member arrays can dangle — a routine can be deleted while a season still
    // lists it. The walk skips the missing routine; the direct member survives.
    const out = groups([task('a')], [], [season('p', 'P', ['a'], ['ghost'])], []);
    expect(out.map((g) => g.label)).toEqual(['P']);
    expect(ids(out[0])).toEqual(['a']);
  });

  it('falls back to one group when the user owns no seasons', () => {
    const out = groups([task('a')], [habit('h')], []);
    expect(out.map((g) => g.label)).toEqual(['No season']);
  });
});
