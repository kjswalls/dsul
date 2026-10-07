import { RecipeManifestSchema, type RecipeManifest } from '@/lib/mods/schema';
import { validateRecipeCore } from '../validate-core';

/** The user_mods columns the server reads. Never `source` or `store`. */
export const RECIPE_ROW_COLUMNS = 'id,user_id,kind,enabled,manifest';

export interface RecipeRow {
  id: string;
  user_id: string;
  kind: string;
  enabled: boolean;
  manifest: unknown;
}

/**
 * A row's manifest, shape only, or null. Owner-asserted, so parsed every time;
 * the run rules (validateRecipeCore) are asked once the user's custom types
 * are known.
 */
export function recipeShape(row: RecipeRow): RecipeManifest | null {
  if (row.kind !== 'recipe' || row.enabled !== true) return null;
  const parsed = RecipeManifestSchema.safeParse(row.manifest);
  return parsed.success ? parsed.data : null;
}

/** The run rules, with the user's own custom types. */
export function runnable(m: RecipeManifest, customTypeNames: string[]): boolean {
  return validateRecipeCore(m, { customTypeNames }).length === 0;
}

export const missingTable = (error: { code?: string } | null | undefined) =>
  error?.code === '42P01' || error?.code === 'PGRST205';
