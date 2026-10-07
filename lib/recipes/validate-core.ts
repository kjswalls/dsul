import { getItemTypeConfig } from '@/lib/item-registry';
import { canCreateType } from '@/lib/proposal';
import { isDoneOn, isSkippedOn } from '@/lib/verb-gates';
import { RECIPE_VERBS, type RecipeManifest, type RecipeStep, type RecipeTrigger } from '@/lib/mods/schema';
import type { Item } from '@/lib/planner-types';

/**
 * The rules a recipe manifest must pass beyond its shape (memory/plans/mods.md,
 * "Recipes"), the half that is safe on the server: everything but the theme
 * and Look ref checks, which ask client registries (./validate.ts adds them).
 * Pure. Asked by the builder on Save, by the browser engine before every run
 * and by the server runner (./server/) before every run, because a manifest is
 * owner-asserted: the owner can write any JSON the schema takes straight
 * through PostgREST.
 *
 * The schema allows a few things that never run:
 *  - `bucket: 'anytime'` has no start, so it would never change;
 *  - item filters and "the item that started it" mean nothing when no item
 *    starts the recipe (a new day, a bucket, ⌘K, the review, a time);
 *  - at a set time only the server runs a recipe, and it runs only
 *    SERVER_WRITE_STEPS.
 */

/** The triggers that carry an item, so item filters and `item: 'trigger'` apply. */
export const ITEM_TRIGGERS = ['item.completed', 'item.uncompleted', 'item.skipped', 'item.created'] as const;

export function isItemTrigger(trigger: RecipeTrigger): boolean {
  return (ITEM_TRIGGERS as readonly string[]).includes(trigger.on);
}

/**
 * The steps the server runner can take (memory/plans/mods.md, "On the
 * server"): a timed recipe holds only these, and an item-trigger recipe run
 * for a phone or reminder tick skips the rest with a note.
 */
export const SERVER_WRITE_STEPS = ['create', 'complete', 'skip', 'reschedule'] as const;
export type ServerWriteStepKind = (typeof SERVER_WRITE_STEPS)[number];

export function isServerStep(step: RecipeStep): boolean {
  return (SERVER_WRITE_STEPS as readonly string[]).includes(step.do);
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

const BUILTIN_TYPES = ['task', 'habit'];

/** Plain problems, one per line, empty when the recipe can run (theme and Look refs aside). */
export function validateRecipeCore(m: RecipeManifest, env: RecipeEnv): string[] {
  const problems: string[] = [];
  const t = m.trigger;
  if (t.on === 'bucket.changed' && t.bucket === 'anytime') {
    problems.push('Pick morning, afternoon or evening.');
  }
  if (t.on === 'time' && !m.steps.every(isServerStep)) {
    problems.push("A recipe at a set time runs on dsul's server, so it can only add, complete, skip or reschedule.");
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
  });
  return problems;
}

/** What an item event says happened, as the engines ask it again. */
export interface ItemFact {
  kind: 'item.completed' | 'item.uncompleted' | 'item.skipped' | 'item.created' | 'review.saved';
  date?: string;
}

/**
 * The event, asked again of the item as it is now (lib/mod-events.ts: a
 * consumer re-checks live state). In the browser a ⌘Z or a delete may land
 * between the action and the dispatch; on the server another device's write
 * may land between the commit and the run. Either way, when the event no
 * longer holds nothing runs, not even the steps that never touch the item.
 */
export function stillHolds(e: ItemFact, item: Item | undefined): boolean {
  switch (e.kind) {
    case 'item.completed':
      return !!item && !!e.date && isDoneOn(item, e.date);
    case 'item.uncompleted':
      return !!item && !!e.date && !isDoneOn(item, e.date);
    case 'item.skipped':
      return !!item && !!e.date && isSkippedOn(item, e.date);
    case 'item.created':
      return !!item;
    case 'review.saved':
      return true;
  }
}
