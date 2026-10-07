import { useExtensionsStore } from '@/lib/extensions-store';
import { EXT_BEEMINDER, OFFICIAL_EXTENSIONS } from '@/lib/extension-registry';
import { stakeEligible } from '@/lib/stakes/day';
import { goalForTitle } from '@/lib/stakes/goal-map';
import type { Item } from '@/lib/planner-types';
import { isVerbStep, type RecipeWriteStep } from './validate';

/**
 * The stake lock (memory/plans/mods.md, "Stakes"): while any stake adapter is
 * on, a recipe runs no verb on a stake-eligible item and creates nothing titled
 * after a Beeminder goal. A recipe that ticks the habit a pledge rides on would
 * be a way to pay nothing for a day not done.
 *
 * The slugs come from the extension manifest, not STAKE_ADAPTERS, because
 * lib/stakes/settle.ts pulls the server adapters in. A test holds the two equal.
 */
export const STAKE_EXTENSION_SLUGS: readonly string[] = OFFICIAL_EXTENSIONS.filter(
  (e) => e.shelf === 'stakes'
).map((e) => e.slug);

/**
 * Whether the lock is on. Ignores the stakes master switch on purpose: an
 * adapter switched on is enough, the stricter reading of "any adapter is on".
 */
export function stakeLockOn(): boolean {
  const ext = useExtensionsStore.getState();
  // No table: every extension sits at its manifest default, which is off.
  if (!ext.available) return false;
  // Not loaded yet: the answer is unknown, so the lock holds.
  if (!ext.configsLoaded) return true;
  return STAKE_EXTENSION_SLUGS.some((slug) => ext.isEnabled(slug));
}

/** 'stake' when the lock refuses this step, else null. */
export function stakeRefusal(step: RecipeWriteStep, item?: Item): 'stake' | null {
  if (!stakeLockOn()) return null;
  if (isVerbStep(step)) return item && stakeEligible(item) ? 'stake' : null;
  const ext = useExtensionsStore.getState();
  // Without the configs the goal map is unknown, so no create gets through.
  if (!ext.configsLoaded) return 'stake';
  return goalForTitle(ext.configs[EXT_BEEMINDER] ?? {}, step.title) ? 'stake' : null;
}
