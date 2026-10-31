import type { Goal } from './planner-types';
import type { AtlasCard } from './atlas-model';
import { sortGoalsForDisplay } from './goals';
import { isCollectible } from './item-registry';

/**
 * By goal (design PR2): a lane per goal plus "Not feeding a goal". Pure.
 *
 * A goal holds ITEMS, never containers, so a card's lane is derived: the goal
 * whose `memberIds` (its feeders) hold most of the card's items. Milestones
 * and check-ins are a goal's own track and do not put a card in its lane:
 * unlinking keeps them (design 2.3), so counting them would re-lane a card
 * the user just unlinked, which would read as a spring-back.
 *
 * Items added to a project later do not join the goal on their own; the link
 * toast says so once.
 */

/** The ids a link would add: the card's members a goal may hold (a registry question). */
export function linkableIds(card: AtlasCard): string[] {
  return card.members.filter((m) => isCollectible(m.item)).map((m) => m.item.id);
}

/** Every goal whose feeders hold at least one of the card's items, in display order. */
export function feedsOf(card: AtlasCard, goals: readonly Goal[]): string[] {
  if (card.kind === 'goal') return [];
  const ids = new Set(card.members.map((m) => m.item.id));
  if (ids.size === 0) return [];
  return sortGoalsForDisplay(goals)
    .filter((g) => g.memberIds.some((id) => ids.has(id)))
    .map((g) => g.id);
}

/**
 * The lane a card sits in: a goal card heads its own; any other card goes to
 * the goal holding most of its items as feeders, ties to sortGoalsForDisplay
 * order; null is "Not feeding a goal".
 */
export function laneFor(card: AtlasCard, goals: readonly Goal[]): string | null {
  if (card.kind === 'goal') return goals.some((g) => g.id === card.id) ? card.id : null;
  const ids = new Set(card.members.map((m) => m.item.id));
  if (ids.size === 0) return null;
  let best: string | null = null;
  let most = 0;
  for (const g of sortGoalsForDisplay(goals)) {
    let n = 0;
    for (const id of g.memberIds) if (ids.has(id)) n += 1;
    if (n > most) {
      most = n;
      best = g.id;
    }
  }
  return best;
}

/**
 * The unlink write, per goal: every goal whose feeders hold any of the card's
 * items loses them from `memberIds` only, so milestones and check-ins stay
 * (never `setItemsGoal(..., false)`, which strips all three roles).
 */
export function unlinkPatches(card: AtlasCard, goals: readonly Goal[]): { goalId: string; memberIds: string[] }[] {
  const ids = new Set(card.members.map((m) => m.item.id));
  const out: { goalId: string; memberIds: string[] }[] = [];
  for (const g of goals) {
    if (!g.memberIds.some((id) => ids.has(id))) continue;
    out.push({ goalId: g.id, memberIds: g.memberIds.filter((id) => !ids.has(id)) });
  }
  return out;
}
