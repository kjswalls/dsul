import { OFFICIAL_EXTENSIONS, resolveEnabled } from '@/lib/extension-registry';
import { stakeEligible } from '@/lib/stakes/day';
import { goalForTitle } from '@/lib/stakes/goal-map';
import type { Item } from '@/lib/planner-types';
import { isVerbStep, type RecipeWriteStep } from './validate-core';

/**
 * The stake lock's rule (memory/plans/mods.md, "Stakes"), pure, so the browser
 * engine (./stake-lock.ts reads the extensions store) and the server runner
 * (./server/context.ts reads user_extensions) ask the same question: while any
 * stake adapter is on, a recipe runs no verb on a stake-eligible item and
 * creates nothing titled after a Beeminder goal. A recipe that ticks the habit
 * a pledge rides on would be a way to pay nothing for a day not done.
 *
 * The slugs come from the extension manifest, not STAKE_ADAPTERS, because
 * lib/stakes/settle.ts pulls the server adapters in. A test holds the two equal.
 */
export const STAKE_EXTENSION_SLUGS: readonly string[] = OFFICIAL_EXTENSIONS.filter(
  (e) => e.shelf === 'stakes'
).map((e) => e.slug);

export interface StakeFacts {
  /** Whether the lock holds: an adapter on, or the answer unknown. */
  lockOn: boolean;
  /** Whether the Beeminder config was read; without it no create gets through. */
  configsKnown: boolean;
  /** The Beeminder extension's config. */
  beeminder: Record<string, unknown>;
}

/**
 * Whether the lock is on, from the user's switch rows: null (no table) is
 * every extension at its manifest default, which is off. Ignores the stakes
 * master switch on purpose: an adapter switched on is enough, the stricter
 * reading of "any adapter is on".
 */
export function stakeLockFrom(enabled: Record<string, boolean> | null): boolean {
  if (enabled === null) return false;
  return STAKE_EXTENSION_SLUGS.some((slug) => resolveEnabled(enabled, slug));
}

/** 'stake' when the lock refuses this step, else null. */
export function stakeRefusalWith(step: RecipeWriteStep, item: Item | undefined, facts: StakeFacts): 'stake' | null {
  if (!facts.lockOn) return null;
  if (isVerbStep(step)) return item && stakeEligible(item) ? 'stake' : null;
  if (!facts.configsKnown) return 'stake';
  return goalForTitle(facts.beeminder, step.title) ? 'stake' : null;
}


/**
 * The same lock for a mod's `$.items.edit` (build order 8), pure: while it
 * holds, a mod may not change a stake-eligible item's title or project, nor
 * give any item a title in the Beeminder goal map. Unknown configs refuse a
 * title, as stakeRefusalWith refuses a create. 'stake' when refused, else null.
 */
export function stakeEditRefusalWith(
  item: Item,
  edit: { title?: string; project?: string | null },
  facts: StakeFacts
): 'stake' | null {
  if (!facts.lockOn) return null;
  const titleChanges = edit.title !== undefined && edit.title !== item.title;
  const projectChanges = edit.project !== undefined && (edit.project ?? null) !== (item.project ?? null);
  if ((titleChanges || projectChanges) && stakeEligible(item)) return 'stake';
  if (edit.title === undefined) return null;
  if (!facts.configsKnown) return 'stake';
  return goalForTitle(facts.beeminder, edit.title) ? 'stake' : null;
}
