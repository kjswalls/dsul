import type { SupabaseClient } from '@supabase/supabase-js';
import { capabilityShape } from './item-pause';
import { getItemTypeConfig, itemTypeName } from './item-registry';
import { roleStillValid } from './goals';
import type { GoalRole, Item } from './planner-types';

/**
 * GOAL ROLES THAT AN ITEM WRITE LEFT UNTRUE, TAKEN BACK.
 *
 * Decision 3's second enforcement point (memory/plans/long-term-goals.md): an item write that
 * invalidates a held role demotes it, never blocks the write. The store does it on the web
 * with a receipt (planGoalRoleDemotion); this is the server's copy, which the agent PATCH
 * (lib/agent-api.ts) and the iPhone app's repeat edit (lib/app-api.ts) both run. It takes
 * any client: the agent's service client, scoped by user here, or the app's session client,
 * scoped by RLS as well.
 */

/** The four columns a role predicate is asked about. */
export interface RoleRow {
  id: string;
  type: string;
  parent_item_id: string | null;
  repeat_frequency: string | null;
}

/**
 * The registry shape a role predicate needs — capability plus recurrence.
 *
 * `repeat_frequency` falls back to the TYPE's default rather than to undefined.
 * The column is nullable and an agent-created habit leaves it NULL, but every
 * reader in the app defaults a habit to daily (lib/db.ts's row mapper does it
 * explicitly), so a NULL habit recurs on every surface the user sees. Read raw,
 * it would be refused as a check-in — "this item does not repeat" — about an
 * item the console's own picker offers as eligible.
 */
export function roleShape(row: RoleRow): Item {
  const shape = capabilityShape(row) as unknown as Record<string, unknown>;
  const fallback = getItemTypeConfig(itemTypeName(shape as unknown as Item)).defaultFrequency;
  return {
    ...shape,
    repeatFrequency: row.repeat_frequency ?? fallback,
  } as unknown as Item;
}

/**
 * Decision 3's second enforcement point: an item write that invalidates a held
 * goal role demotes it, never blocks the write.
 *
 * The store does this on the UI path with a receipt toast; an agent PATCH is
 * the OTHER way `repeatFrequency` flips, and until this existed an OpenClaw
 * write could make a milestone recurring with nothing taking the role back —
 * leaving a goal permanently behind on an item whose scalar status migration
 * 016 has frozen.
 *
 * Runs AFTER the item update, against the stored row: the body may carry a
 * partial patch, and it is the resulting shape that decides the role. Failures
 * here do not fail the PATCH — the item edit is the caller's request and it has
 * already succeeded; the role is dsul's bookkeeping.
 */
export async function demoteInvalidGoalRoles(
  client: SupabaseClient,
  userId: string,
  itemId: string,
): Promise<{ goalId: string; from: GoalRole }[]> {
  const { data: rows, error } = await client
    .from('goal_items')
    .select('goal_id, role')
    .eq('user_id', userId)
    .eq('item_id', itemId)
    .neq('role', 'member');
  if (error) throw error;
  const held = (rows ?? []) as { goal_id: string; role: GoalRole }[];
  if (held.length === 0) return [];

  const { data: item, error: itemError } = await client
    .from('items')
    .select('id, type, parent_item_id, repeat_frequency')
    .eq('id', itemId)
    .eq('user_id', userId)
    .maybeSingle();
  if (itemError) throw itemError;
  if (!item) return [];
  // The same shape the GRANT predicates are asked about, so the two agree.
  const shape = roleShape(item as RoleRow);

  // Snapshotted BEFORE the write: the receipt names the role being taken away,
  // and reading it back off the row afterwards would report 'member' every time.
  const invalid = held
    .filter((r) => !roleStillValid(r.role, shape))
    .map((r) => ({ goalId: r.goal_id, from: r.role }));
  if (invalid.length === 0) return [];

  // One row per goal — the PK is (goal_id, item_id), so this is an in-place
  // role change, never an insert that could collide with a plain membership.
  const { error: writeError } = await client
    .from('goal_items')
    // `sort_order` is cleared with the role. goalMemberRows emits it as null
    // off the member array for a stated reason — a demoted milestone that kept
    // its old ordinal sorts ahead of every real member in the array fetchGoals
    // hands back, and nothing later would reset it.
    .update({ role: 'member', sort_order: null })
    .eq('user_id', userId)
    .eq('item_id', itemId)
    .in('goal_id', invalid.map((r) => r.goalId));
  if (writeError) throw writeError;

  return invalid;
}
