import { useExtensionsStore } from '@/lib/extensions-store';
import { EXT_BEEMINDER } from '@/lib/extension-registry';
import type { Item } from '@/lib/planner-types';
import { STAKE_EXTENSION_SLUGS, stakeEditRefusalWith, stakeRefusalWith, type StakeFacts } from './stake-rule';
import type { RecipeWriteStep } from './validate';

/**
 * The stake lock in the browser, read from the extensions store. The rule is
 * ./stake-rule.ts, shared with the server runner.
 */
export { STAKE_EXTENSION_SLUGS } from './stake-rule';

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

/** The lock's facts as the extensions store holds them now. */
export function stakeFactsNow(): StakeFacts {
  const ext = useExtensionsStore.getState();
  return {
    lockOn: stakeLockOn(),
    // Without the configs the goal map is unknown, so no create gets through.
    configsKnown: ext.configsLoaded,
    beeminder: ext.configs[EXT_BEEMINDER] ?? {},
  };
}

/** 'stake' when the lock refuses this step, else null. */
export function stakeRefusal(step: RecipeWriteStep, item?: Item): 'stake' | null {
  return stakeRefusalWith(step, item, stakeFactsNow());
}

/** 'stake' when the lock refuses a mod's edit of this item, else null. */
export function stakeEditRefusal(item: Item, edit: { title?: string; project?: string | null }): 'stake' | null {
  return stakeEditRefusalWith(item, edit, stakeFactsNow());
}
