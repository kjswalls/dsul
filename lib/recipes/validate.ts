import { getCustomTypeDefs, getItemTypeConfig } from '@/lib/item-registry';
import { canCreateType } from '@/lib/proposal';
import { isDarkLook, isLightLook } from '@/lib/theme-looks';
import { lookById } from '@/lib/looks';
import {
  RECIPE_VERBS,
  RecipeManifestSchema,
  type RecipeManifest,
  type RecipeStep,
  type RecipeTrigger,
  type UserMod,
} from '@/lib/mods/schema';

/**
 * The rules a recipe manifest must pass beyond its shape (memory/plans/mods.md,
 * "Recipes"). Pure. Asked by the builder on Save and by the engine before every
 * run, because a manifest is owner-asserted: the owner can write any JSON the
 * schema takes straight through PostgREST.
 *
 * The schema allows a few things this PR does not run:
 *  - `time` triggers ride the server runner (build order 6);
 *  - `bucket: 'anytime'` has no start, so it would never change;
 *  - item filters and "the item that started it" mean nothing when no item
 *    starts the recipe (a new day, a bucket, ⌘K, the review).
 */

/** The triggers that carry an item, so item filters and `item: 'trigger'` apply. */
export const ITEM_TRIGGERS = ['item.completed', 'item.uncompleted', 'item.skipped', 'item.created'] as const;

export function isItemTrigger(trigger: RecipeTrigger): boolean {
  return (ITEM_TRIGGERS as readonly string[]).includes(trigger.on);
}

/**
 * "Still open today" asks whether the item's loop is open, and a tick or a skip
 * is what closes it, so on those two it could only match a different day's
 * tick. The builder offers it, and the rules accept it, only where it can mean
 * something.
 */
export function openTodayFits(on: string): boolean {
  return on === 'item.uncompleted' || on === 'item.created';
}

export type RecipeVerbStep = Extract<RecipeStep, { do: (typeof RECIPE_VERBS)[number] }>;
export type RecipeCreateStep = Extract<RecipeStep, { do: 'create' }>;
export type RecipeWriteStep = RecipeVerbStep | RecipeCreateStep;
export type RecipeUiStep = Exclude<RecipeStep, RecipeWriteStep>;

export function isVerbStep(step: RecipeStep): step is RecipeVerbStep {
  return (RECIPE_VERBS as readonly string[]).includes(step.do);
}

/** A step that writes an item. UI steps (toast, go to, Organize, theme, Look) are not writes. */
export function isWriteStep(step: RecipeStep): step is RecipeWriteStep {
  return step.do === 'create' || isVerbStep(step);
}

export interface RecipeEnv {
  /** Hydrated custom type slugs. */
  customTypeNames: string[];
}

/** The registry's own copy of the hydrated custom types. */
export function currentRecipeEnv(): RecipeEnv {
  return { customTypeNames: getCustomTypeDefs().map((d) => d.name) };
}

const BUILTIN_TYPES = ['task', 'habit'];

/** Plain problems, one per line, empty when the recipe can run. */
export function validateRecipe(m: RecipeManifest, env: RecipeEnv): string[] {
  const problems: string[] = [];
  const t = m.trigger;
  if (t.on === 'time') problems.push('Recipes that run at a set time are not available yet.');
  if (t.on === 'bucket.changed' && t.bucket === 'anytime') {
    problems.push('Pick morning, afternoon or evening.');
  }

  const itemTrigger = isItemTrigger(t);
  const f = m.filters ?? {};
  if (!itemTrigger && (f.types || f.projects || f.title || f.openToday)) {
    problems.push('Item filters only work when an item starts the recipe.');
  }
  if (f.openToday && itemTrigger && !openTodayFits(t.on)) {
    problems.push('"Still open today" never matches a tick or a skip.');
  }

  m.steps.forEach((step, i) => {
    const n = i + 1;
    if (isVerbStep(step) && step.item === 'trigger' && !itemTrigger) {
      problems.push(`Pick an item for step ${n}.`);
    }
    if (step.do === 'create') {
      const known = BUILTIN_TYPES.includes(step.type) || env.customTypeNames.includes(step.type);
      if (!known) problems.push(`Step ${n} adds a type that does not exist.`);
      else if (!canCreateType(step.type, env)) {
        problems.push(`Step ${n} cannot add ${getItemTypeConfig(step.type).labelPlural.toLowerCase()}.`);
      }
    }
    if (step.do === 'setTheme') {
      const ok = step.mode === 'light' ? isLightLook(step.theme) : isDarkLook(step.theme);
      if (!ok) problems.push(`Pick a ${step.mode} theme for step ${n}.`);
    }
    if (step.do === 'applyLook' && !lookById(step.look)) {
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
