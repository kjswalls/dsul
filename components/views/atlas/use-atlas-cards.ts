'use client';

import { useMemo } from 'react';
import { usePlannerStore } from '@/lib/planner-store';
import { useAwayStore } from '@/lib/away-store';
import { useToday } from '@/lib/collections';
import { useGoalsForDisplay } from '@/lib/extension-gates';
import { milestoneItemIds } from '@/lib/goals';
import { buildAtlasCards, type AtlasCard } from '@/lib/atlas-model';

const NO_GOALS: readonly never[] = [];

/**
 * Atlas's cards, from narrow planner subscriptions, derived once per change
 * (lib/atlas-model.ts). The only place a member's `todayState` is derived, so
 * no card subscribes to a schedule of its own: a per-card schedule hook would
 * re-render every card on every tick anywhere.
 */
export function useAtlasCards(): { cards: AtlasCard[]; todayStr: string; milestoneIds: ReadonlySet<string> } {
  const items = usePlannerStore((s) => s.items);
  const tasks = usePlannerStore((s) => s.tasks);
  const habits = usePlannerStore((s) => s.habits);
  const projects = usePlannerStore((s) => s.projects);
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const storeGoals = usePlannerStore((s) => s.goals);
  const collectionsAvailable = usePlannerStore((s) => s.collectionsAvailable);
  const goalsAvailable = usePlannerStore((s) => s.goalsAvailable);
  const away = useAwayStore((s) => s.periods);
  // Goals start OFF (an extension): empty while it is.
  const goals = useGoalsForDisplay(storeGoals ?? NO_GOALS);
  const { todayStr, tz } = useToday();
  const milestoneIds = useMemo(() => milestoneItemIds(goals), [goals]);

  const cards = useMemo(
    () =>
      buildAtlasCards({
        items,
        tasks,
        habits,
        projects,
        routines,
        seasons,
        goals,
        away,
        tz,
        todayStr,
        collectionsAvailable,
        goalsAvailable,
        milestoneIds,
      }),
    [items, tasks, habits, projects, routines, seasons, goals, away, tz, todayStr, collectionsAvailable, goalsAvailable, milestoneIds],
  );
  return { cards, todayStr, milestoneIds };
}
