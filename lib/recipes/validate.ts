import { getCustomTypeDefs } from '@/lib/item-registry';
import { isDarkLook, isLightLook } from '@/lib/theme-looks';
import { isUserThemeSlug } from '@/lib/user-themes/css';
import { lookById } from '@/lib/looks';
import { isUserLookRef } from '@/lib/user-looks';
import { RecipeManifestSchema, type RecipeManifest, type UserMod } from '@/lib/mods/schema';
import { validateRecipeCore, type RecipeEnv } from './validate-core';

/**
 * The browser's recipe rules: ./validate-core.ts (server-safe, shared with the
 * server runner) plus the theme and Look ref checks, which ask client
 * registries. Pure.
 */

export {
  ITEM_TRIGGERS,
  SERVER_WRITE_STEPS,
  isItemTrigger,
  isServerStep,
  isVerbStep,
  isWriteStep,
  openTodayFits,
  stillHolds,
  validateRecipeCore,
  type RecipeCreateStep,
  type RecipeEnv,
  type RecipeUiStep,
  type RecipeVerbStep,
  type RecipeWriteStep,
} from './validate-core';

/** The registry's own copy of the hydrated custom types. */
export function currentRecipeEnv(): RecipeEnv {
  return { customTypeNames: getCustomTypeDefs().map((d) => d.name) };
}

/** Plain problems, one per line, empty when the recipe can run. */
export function validateRecipe(m: RecipeManifest, env: RecipeEnv): string[] {
  const problems = validateRecipeCore(m, env);
  m.steps.forEach((step, i) => {
    const n = i + 1;
    if (step.do === 'setTheme') {
      // One of your themes is taken by its slug's shape: whether it is on, and
      // of this mode, is the theme record's question when the step runs, and a
      // theme that is off or gone then does nothing.
      const ok =
        (step.mode === 'light' ? isLightLook(step.theme) : isDarkLook(step.theme)) || isUserThemeSlug(step.theme);
      if (!ok) problems.push(`Pick a ${step.mode} theme for step ${n}.`);
    }
    // One of your Looks is taken by its ref's shape: whether it is on is the
    // step's question when it runs, and one that is off or gone does nothing.
    if (step.do === 'applyLook' && !lookById(step.look) && !isUserLookRef(step.look)) {
      problems.push(`Pick a Look for step ${n}.`);
    }
  });
  return problems;
}

/**
 * A recipe row's manifest, parsed and checked, or null when it cannot run.
 * Never trusted because the app wrote it (lib/mods/schema.ts).
 */
export function parseRecipe(mod: Pick<UserMod, 'kind' | 'manifest'>, env: RecipeEnv = currentRecipeEnv()): RecipeManifest | null {
  if (mod.kind !== 'recipe') return null;
  const parsed = RecipeManifestSchema.safeParse(mod.manifest);
  if (!parsed.success) return null;
  return validateRecipe(parsed.data, env).length === 0 ? parsed.data : null;
}
