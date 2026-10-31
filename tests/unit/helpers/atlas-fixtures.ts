import { buildAtlasCards, type AtlasCard, type AtlasModelInput } from '@/lib/atlas-model';
import { milestoneItemIds } from '@/lib/goals';
import type { Goal, HabitItem, Item, Project, Routine, Season, Task } from '@/lib/planner-types';

/** Shared builders for the Atlas PR2 tests (momentum, activity, layouts, drops). */

/** A Tuesday. */
export const TODAY = '2026-03-10';
export const TZ = 'UTC';

export const task = (over: Partial<Item> & { id: string; title?: string }) =>
  ({
    type: 'task',
    title: over.id,
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    ...over,
  }) as Item;

export const habit = (over: Partial<Item> & { id: string; title?: string }) =>
  ({
    type: 'habit',
    title: over.id,
    streak: 0,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
    timeBucket: 'anytime',
    ...over,
  }) as Item;

export const project = (name: string, over: Partial<Project> = {}) =>
  ({ id: `p-${name}`, name, emoji: '', ...over }) as Project;

export const routine = (id: string, itemIds: string[], over: Partial<Routine> = {}) =>
  ({ id, name: id, itemIds, ...over }) as Routine;

export const season = (id: string, over: Partial<Season> = {}) =>
  ({ id, name: id, state: 'active', itemIds: [], routineIds: [], ...over }) as Season;

export const goal = (id: string, over: Partial<Goal> = {}) =>
  ({ id, name: id, state: 'active', memberIds: [], milestoneIds: [], checkinIds: [], ...over }) as Goal;

export function build(over: Partial<AtlasModelInput> & { items: Item[] }): AtlasCard[] {
  const items = over.items;
  const goals = over.goals ?? [];
  return buildAtlasCards({
    tasks: items.filter((i) => i.type !== 'habit') as unknown as Task[],
    habits: items.filter((i) => i.type === 'habit') as unknown as HabitItem[],
    projects: [],
    routines: [],
    seasons: [],
    goals,
    away: [],
    tz: TZ,
    todayStr: TODAY,
    collectionsAvailable: true,
    goalsAvailable: true,
    milestoneIds: milestoneItemIds(goals),
    ...over,
  });
}

export const cardOf = (cards: readonly AtlasCard[], key: string): AtlasCard => {
  const c = cards.find((x) => x.key === key);
  if (!c) throw new Error(`no card ${key}`);
  return c;
};
