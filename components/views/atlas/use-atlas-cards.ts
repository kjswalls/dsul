'use client';

import { useMemo, useState } from 'react';
import { usePlannerStore } from '@/lib/planner-store';
import { useAwayStore } from '@/lib/away-store';
import { useToday } from '@/lib/collections';
import { useGoalsEnabled, useGoalsForDisplay } from '@/lib/extension-gates';
import { milestoneItemIds } from '@/lib/goals';
import { buildAtlasCards, createAtlasCardSharer, type AtlasCard } from '@/lib/atlas-model';
import type { Goal, Season } from '@/lib/planner-types';

const NO_GOALS: readonly never[] = [];
const NO_SEASONS: readonly never[] = [];

/**
 * Atlas's cards, from narrow planner subscriptions, derived once per change
 * (lib/atlas-model.ts). The only place a member's `todayState` is derived, so
 * no card subscribes to a schedule of its own: a per-card schedule hook would
 * re-render every card on every tick anywhere.
 */
export function useAtlasCards(): {
  cards: AtlasCard[];
  todayStr: string;
  tz: string;
  milestoneIds: ReadonlySet<string>;
  /** The goals shown (gated by the Goals extension and loaded), for By goal. */
  goals: readonly Goal[];
  /** Seasons as loaded (empty when routines and seasons are unavailable), for Timeline. */
  seasons: readonly Season[];
  /** Routines and seasons can show (the empty map names only what can). */
  collectionsShown: boolean;
  /** Goals can show: the extension is on and they loaded. */
  goalsShown: boolean;
} {
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
  const goalsOn = useGoalsEnabled();
  const { todayStr, tz } = useToday();
  const milestoneIds = useMemo(() => milestoneItemIds(goals), [goals]);

  // The previous build, so a card that says exactly what it said before keeps
  // its object and memo(AtlasCard) skips it: a tick re-renders one card.
  const [share] = useState(createAtlasCardSharer);
  const cards = useMemo(() => {
    const built = buildAtlasCards({
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
    });
    return share(built);
  }, [share, items, tasks, habits, projects, routines, seasons, goals, away, tz, todayStr, collectionsAvailable, goalsAvailable, milestoneIds]);
  return {
    cards,
    todayStr,
    tz,
    milestoneIds,
    goals: goalsAvailable ? goals : NO_GOALS,
    seasons: collectionsAvailable ? seasons : NO_SEASONS,
    collectionsShown: collectionsAvailable,
    goalsShown: goalsOn && goalsAvailable,
  };
}
