import { describe, it, expect, afterEach } from 'vitest';
import { groupResults, parseSearchQuery, searchItems } from '@/lib/search';
import { hydrateCustomTypes } from '@/lib/item-registry';
import type { ItemTypeDef, Task } from '@/lib/planner-types';

describe('type:<name> grammar (Phase 6)', () => {
  it('type:goal sets the type filter to the slug', () => {
    expect(parseSearchQuery('type:goal run')).toEqual({
      text: 'run',
      type: 'goal',
      priority: null,
      project: null,
    });
  });

  it('type:task / type:habit map onto the built-in filters', () => {
    expect(parseSearchQuery('type:task').type).toBe('task');
    expect(parseSearchQuery('type:HABIT').type).toBe('habit');
  });

  it('searchItems matches custom rows by slug and excludes habits', () => {
    const task = { id: 't1', title: 'Run errands', status: 'pending', isScheduled: false, order: 0 } as Task;
    const goal = {
      id: 'g1', title: 'Run a 10k', status: 'pending', isScheduled: false, order: 0,
      type: 'custom', customType: 'goal',
    } as unknown as Task;
    const habit = {
      id: 'h1', title: 'Run daily', project: 'Fitness', streak: 0, status: 'pending',
      completedDates: [], skippedDates: [], dailyCounts: {}, repeatFrequency: 'daily',
    };

    const bySlug = searchItems('type:goal', [task, goal], [habit as never]);
    expect(bySlug.tasks.map((t) => t.id)).toEqual(['g1']);
    expect(bySlug.habits).toEqual([]);

    const byTask = searchItems('type:task run', [task, goal], [habit as never]);
    expect(byTask.tasks.map((t) => t.id)).toEqual(['t1']);
  });
});

describe('groupResults', () => {
  // The registry is module state; every test that hydrates must put it back.
  afterEach(() => hydrateCustomTypes([]));

  const mkTask = (id: string, title = 'Task') =>
    ({ id, title, status: 'pending', isScheduled: false, order: 0 }) as Task;
  const mkGoal = (id: string, title = 'Goal') =>
    ({
      id, title, status: 'pending', isScheduled: false, order: 0,
      type: 'custom', customType: 'goal',
    }) as unknown as Task;
  const mkHabit = (id: string, title = 'Habit') =>
    ({
      id, title, project: 'Fitness', streak: 0, status: 'pending',
      completedDates: [], skippedDates: [], dailyCounts: {}, repeatFrequency: 'daily',
      type: 'habit',
    }) as never;

  const GOAL_DEF = {
    id: 'd1', name: 'goal', label: 'Goal', labelPlural: 'Goals',
  } as ItemTypeDef;

  it('splits built-ins into their own sections, in registry order', () => {
    const groups = groupResults({ tasks: [mkTask('t1')], habits: [mkHabit('h1')] });
    expect(groups.map((g) => [g.type, g.heading])).toEqual([
      ['task', 'Tasks'],
      ['habit', 'Habits'],
    ]);
    expect(groups[0].items.map((i) => i.id)).toEqual(['t1']);
  });

  it('gives a hydrated custom type its own section instead of filing it under Tasks', () => {
    hydrateCustomTypes([GOAL_DEF]);
    const groups = groupResults({ tasks: [mkTask('t1'), mkGoal('g1')], habits: [] });
    expect(groups.map((g) => g.type)).toEqual(['task', 'goal']);
    expect(groups[1].heading).toBe('Goals');
    expect(groups[1].items.map((i) => i.id)).toEqual(['g1']);
  });

  it('keeps items whose type was deleted, in a trailing section', () => {
    // No hydration: 'goal' is not a registry name any more, but the items exist.
    const groups = groupResults({ tasks: [mkTask('t1'), mkGoal('g1')], habits: [] });
    expect(groups.map((g) => g.type)).toEqual(['task', 'goal']);
    expect(groups[1].items.map((i) => i.id)).toEqual(['g1']);
  });

  it('omits empty sections', () => {
    expect(groupResults({ tasks: [], habits: [mkHabit('h1')] }).map((g) => g.type)).toEqual([
      'habit',
    ]);
    expect(groupResults({ tasks: [], habits: [] })).toEqual([]);
  });

  it('caps built-in sections at the counts the omnibar shipped with', () => {
    const groups = groupResults({
      tasks: Array.from({ length: 9 }, (_, i) => mkTask(`t${i}`)),
      habits: Array.from({ length: 9 }, (_, i) => mkHabit(`h${i}`)),
    });
    expect(groups[0].items).toHaveLength(6);
    expect(groups[1].items).toHaveLength(4);
  });

  it('holds a total ceiling across sections', () => {
    hydrateCustomTypes([
      GOAL_DEF,
      { id: 'd2', name: 'errand', label: 'Errand', labelPlural: 'Errands' } as ItemTypeDef,
    ]);
    const custom = (slug: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `${slug}${i}`, title: slug, status: 'pending', isScheduled: false, order: 0,
        type: 'custom', customType: slug,
      })) as unknown as Task[];

    const groups = groupResults({
      tasks: [...Array.from({ length: 9 }, (_, i) => mkTask(`t${i}`)), ...custom('goal', 9), ...custom('errand', 9)],
      habits: Array.from({ length: 9 }, (_, i) => mkHabit(`h${i}`)),
    });

    const total = groups.reduce((n, g) => n + g.items.length, 0);
    expect(total).toBeLessThanOrEqual(12);
    // Every matching type survives: later sections shrink rather than vanish.
    expect(groups.map((g) => [g.type, g.items.length])).toEqual([
      ['task', 6],
      ['habit', 4],
      ['goal', 1],
      ['errand', 1],
    ]);
  });
});

describe('search keyword parser', () => {
  it('empty string returns no filters', () => {
    expect(parseSearchQuery('')).toEqual({ text: '', type: null, priority: null, project: null });
  });

  it('plain text query sets text field only', () => {
    expect(parseSearchQuery('meeting notes')).toEqual({
      text: 'meeting notes',
      type: null,
      priority: null,
      project: null,
    });
  });

  it('"task:" prefix filters to tasks only (#93)', () => {
    expect(parseSearchQuery('task:standup')).toEqual({
      text: 'standup',
      type: 'task',
      priority: null,
      project: null,
    });
  });

  it('"habit:" prefix filters to habits only (#93)', () => {
    expect(parseSearchQuery('habit:water')).toEqual({
      text: 'water',
      type: 'habit',
      priority: null,
      project: null,
    });
  });

  it('"priority:high" keyword sets priority filter', () => {
    expect(parseSearchQuery('priority:high report')).toEqual({
      text: 'report',
      type: null,
      priority: 'high',
      project: null,
    });
  });

  it('"project:" keyword sets project filter', () => {
    expect(parseSearchQuery('project:Website copy')).toEqual({
      text: 'copy',
      type: null,
      priority: null,
      project: 'Website',
    });
  });

  it('unknown keywords are treated as plain text', () => {
    expect(parseSearchQuery('foo:bar baz')).toEqual({
      text: 'foo:bar baz',
      type: null,
      priority: null,
      project: null,
    });
  });

  it('invalid priority values fall back to plain text', () => {
    expect(parseSearchQuery('priority:urgent fix')).toEqual({
      text: 'priority:urgent fix',
      type: null,
      priority: null,
      project: null,
    });
  });

  it('combines type and priority keywords', () => {
    expect(parseSearchQuery('task:report priority:high')).toEqual({
      text: 'report',
      type: 'task',
      priority: 'high',
      project: null,
    });
  });
});

describe('searchItems finds subtasks', () => {
  const parent = { id: 'p1', title: 'Shop for presents', status: 'pending', isScheduled: false, order: 0 } as Task;
  const other = { id: 'p2', title: 'Rug cleaning', status: 'pending', isScheduled: false, order: 1 } as Task;
  const sub = (id: string, title: string, parentItemId: string) =>
    ({ id, title, status: 'pending', isScheduled: false, order: 0, parentItemId }) as Task;

  it('answers a subtask hit with its parent and names the subtask', () => {
    const r = searchItems('imac', [parent, other], [], [sub('s1', 'iMac', 'p1')]);
    expect(r.tasks.map((t) => t.id)).toEqual(['p1']);
    expect(r.viaSubtask).toEqual({ p1: 'iMac' });
  });

  it('does not annotate a parent that matched on its own title', () => {
    const r = searchItems('rug', [parent, other], [], [sub('s1', 'Rug', 'p1'), sub('s2', 'Rug pad', 'p2')]);
    expect(r.tasks.map((t) => t.id)).toEqual(['p1', 'p2']);
    expect(r.viaSubtask).toEqual({ p1: 'Rug' });
  });

  it('lists a parent once however many subtasks match', () => {
    const r = searchItems('a', [parent], [], [sub('s1', 'Art supplies', 'p1'), sub('s2', 'Cabo', 'p1')]);
    expect(r.tasks).toHaveLength(1);
    expect(r.viaSubtask).toEqual({ p1: 'Art supplies' }); // the first match names it
  });

  it('still applies the parent filters, and needs text to match a subtask', () => {
    expect(searchItems('priority:high imac', [parent], [], [sub('s1', 'iMac', 'p1')]).tasks).toEqual([]);
    expect(searchItems('type:habit imac', [parent], [], [sub('s1', 'iMac', 'p1')]).tasks).toEqual([]);
    expect(searchItems('type:task', [parent], [], [sub('s1', 'iMac', 'p1')]).viaSubtask).toBeUndefined();
  });

  it('skips a subtask whose parent is not in the list', () => {
    expect(searchItems('imac', [parent], [], [sub('s1', 'iMac', 'gone')]).tasks).toEqual([]);
  });
});
