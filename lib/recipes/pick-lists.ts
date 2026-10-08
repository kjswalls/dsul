'use client';

import { createClient } from '@/lib/supabase';
import { fetchItemTypes, fetchProjects } from '@/lib/db';
import type { ItemTypeDef } from '@/lib/planner-types';

/**
 * What the recipe builder offers to pick from: items by title, project names,
 * your own types. Fetched by the builder itself, small and on open, because it
 * lives on /settings, a lean route that never loads the planner
 * (lib/route-data.ts, tests/unit/route-data.test.ts): read from the planner
 * store there, every list would be empty.
 */

/** Enough to pick from; a longer list is searched, not scrolled. */
const ITEM_LIMIT = 500;

export interface RecipePickLists {
  items: { id: string; title: string }[];
  projects: string[];
  types: Pick<ItemTypeDef, 'name' | 'label'>[];
}

export const EMPTY_PICK_LISTS: RecipePickLists = { items: [], projects: [], types: [] };

export async function fetchRecipePickLists(userId: string): Promise<RecipePickLists> {
  const [items, projects, types] = await Promise.all([
    createClient()
      .from('items')
      .select('id,title')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .is('parent_item_id', null)
      .order('title', { ascending: true })
      .limit(ITEM_LIMIT)
      .then(({ data, error }) => {
        if (error) throw error;
        return (data ?? []) as { id: string; title: string }[];
      }),
    fetchProjects(userId),
    fetchItemTypes(userId),
  ]);
  return {
    items,
    projects: projects.map((p) => p.name),
    types: (types ?? []).map((t) => ({ name: t.name, label: t.label })),
  };
}
