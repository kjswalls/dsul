import { z } from 'zod';
import { TimeBucketSchema } from '@dsul/types';
import type { ModEvent } from '@/lib/mod-events';
import type { VerbId } from '@/lib/item-verbs';
import { isLayoutTheme, type LayoutTheme } from '@/lib/layout-themes';
import { DRAFT_SLUG, USER_THEME_SLUG_RE } from '@/lib/user-themes/css';
import { DARK_BASES, LIGHT_BASES, ThemeManifestSchema, type ThemeManifest } from './theme-grammar';

/**
 * The shapes of what a person makes in Settings → Make (memory/plans/mods.md).
 *
 * Here, not in @dsul/types: none of this is an external contract. Nothing
 * outside the app reads a user_mods row (the agent API and MCP never see one,
 * tests/unit/mods-boundary.test.ts), so a shape can change with the app.
 *
 * The row rules mirror supabase/migrations/061_user_mods.sql, and
 * tests/unit/mods-migration.test.ts pins the two together: a slug or name the
 * client accepts and the CHECK refuses is a save that looks fine and fails.
 *
 * Every manifest is owner-asserted (the owner can write their own row straight
 * through PostgREST), so it is parsed at every load, never trusted because the
 * app wrote it.
 */

export const MOD_KINDS = ['recipe', 'mod', 'theme', 'look'] as const;
export type ModKind = (typeof MOD_KINDS)[number];
export const ModKindSchema = z.enum(MOD_KINDS);

/** 061's slug CHECK, verbatim. */
export const MOD_SLUG_RE = /^[a-z][a-z0-9-]{0,29}$/;
/** 061's name CHECK: char_length, which counts code points. */
export const MOD_NAME_MAX = 60;
/** 061's octet_length caps on source and store. */
export const MOD_SOURCE_MAX_BYTES = 65536;
export const MOD_STORE_MAX_BYTES = 65536;
/** A run stops at 25 writes (mods.md, "Runs"), so a recipe holds at most 25 steps. */
export const RECIPE_MAX_STEPS = 25;

export const ModSlugSchema = z.string().regex(MOD_SLUG_RE);

/** Control characters, C0, DEL and C1: a little stricter than SQL's [[:cntrl:]], never looser. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

export function isModName(s: string): boolean {
  const length = Array.from(s).length;
  return length >= 1 && length <= MOD_NAME_MAX && s.trim() !== '' && !CONTROL_RE.test(s);
}

export function isModSlug(s: string): boolean {
  return MOD_SLUG_RE.test(s);
}

export const ModNameSchema = z.string().refine(isModName, {
  message: `A name is 1 to ${MOD_NAME_MAX} characters, not blank.`,
});

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** One user_mods row as PostgREST returns it. `source` and `store` are optional: Make's list never selects them. */
export const UserModRowSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  kind: ModKindSchema,
  slug: ModSlugSchema,
  /**
   * Looser than ModNameSchema on purpose. 061's CHECK trims only plain spaces
   * and its [[:cntrl:]] is locale-bound, so the owner can store a name that
   * isModName refuses (a lone U+00A0). A row dropped here would vanish from
   * Make with no way to switch it off or delete it, so the read takes what
   * the database took and modLabel() falls back to the slug. Writes (rename)
   * keep the strict rule.
   */
  name: z.string().min(1),
  enabled: z.boolean(),
  /** Validated per kind later, by manifestSchemaFor(kind). */
  manifest: z.unknown(),
  source: z
    .string()
    .refine((s) => utf8Bytes(s) <= MOD_SOURCE_MAX_BYTES)
    .nullable()
    .optional(),
  store: z.record(z.unknown()).optional(),
  disabled_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type UserModRow = z.infer<typeof UserModRowSchema>;

/** The app's side of the boundary (lib/db.ts's itemFromRow, for user_mods). */
export interface UserMod {
  id: string;
  userId: string;
  kind: ModKind;
  slug: string;
  name: string;
  enabled: boolean;
  manifest: unknown;
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export function userModFromRow(row: UserModRow): UserMod {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    slug: row.slug,
    name: row.name,
    enabled: row.enabled,
    manifest: row.manifest,
    disabledReason: row.disabled_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** What Make shows for a row: its name, or its slug when the name is one only the database accepted. */
export function modLabel(mod: Pick<UserMod, 'name' | 'slug'>): string {
  return isModName(mod.name) ? mod.name : mod.slug;
}

/* ── Recipes ──────────────────────────────────────────────────────────────── */

/** The events a recipe can start on: every kind lib/mod-events.ts raises (a test checks both ways). */
export const RECIPE_EVENT_TRIGGERS = [
  'item.completed',
  'item.uncompleted',
  'item.skipped',
  'item.created',
  'review.saved',
] as const satisfies readonly ModEvent['kind'][];

/**
 * The verbs a recipe step may run, from ITEM_VERBS. Excluded on purpose: tick
 * (a toggle, so a step would undo itself), delete, resetStreak and
 * leaveProjectBlock (mods.md, "Steps are verbs, never field writes").
 */
export const RECIPE_VERBS = [
  'complete',
  'skip',
  'unskip',
  'pause',
  'resume',
  'nextDay',
  'reschedule',
  'braindump',
] as const satisfies readonly VerbId[];

/** The verbs that need nothing but the item. `reschedule` has its own step shape. */
const PLAIN_RECIPE_VERBS = [
  'complete',
  'skip',
  'unskip',
  'pause',
  'resume',
  'nextDay',
  'braindump',
] as const satisfies readonly (typeof RECIPE_VERBS)[number][];

const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A built-in or user theme or Look id. Resolved against the registries at run time (PR 4/5). */
const LOOK_REF_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** Titles a recipe writes carry no links (mods.md, "Never reachable"). */
const URL_RE = /https?:\/\/|www\./i;

const ProjectNameSchema = z.string().min(1).max(60);

export const RecipeTriggerSchema = z.discriminatedUnion('on', [
  z.object({ on: z.enum(RECIPE_EVENT_TRIGGERS) }).strict(),
  z.object({ on: z.literal('day.opened') }).strict(),
  z.object({ on: z.literal('bucket.changed'), bucket: TimeBucketSchema.optional() }).strict(),
  z.object({ on: z.literal('time'), at: z.string().regex(TIME_OF_DAY_RE) }).strict(),
  z.object({ on: z.literal('command') }).strict(),
]);

/** All optional, combined with AND. */
export const RecipeFiltersSchema = z
  .object({
    /** Type slugs ('task', 'habit' or a custom one); the registry is asked at run time. */
    types: z.array(ModSlugSchema).min(1).max(10).optional(),
    /** Project names, case-folded at run time (the kind folds case). */
    projects: z.array(ProjectNameSchema).min(1).max(20).optional(),
    title: z.object({ contains: z.string().min(1).max(120) }).strict().optional(),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, { message: 'Each weekday once.' })
      .optional(),
    /** isOpenLoopOn + isItemActiveOn, as lib/stakes/day.ts composes them. */
    openToday: z.literal(true).optional(),
  })
  .strict();

/** The item a step acts on: the one that started the run, or a named one. */
const StepItemSchema = z.union([
  z.literal('trigger'),
  z.object({ id: z.string().uuid() }).strict(),
]);

const StepTitleSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((s) => !URL_RE.test(s), { message: 'No links in a title.' });

export const RecipeStepSchema = z.discriminatedUnion('do', [
  z.object({ do: z.enum(PLAIN_RECIPE_VERBS), item: StepItemSchema }).strict(),
  z
    .object({ do: z.literal('reschedule'), item: StepItemSchema, inDays: z.number().int().min(0).max(365) })
    .strict(),
  z
    .object({
      do: z.literal('create'),
      type: ModSlugSchema,
      title: StepTitleSchema,
      bucket: TimeBucketSchema.optional(),
      project: ProjectNameSchema.optional(),
    })
    .strict(),
  z.object({ do: z.literal('toast'), text: z.string().min(1).max(140) }).strict(),
  // Closed enums, so no recipe argument ever reaches setLayout unparsed.
  z
    .object({
      do: z.literal('goto'),
      scope: z.enum(['day', 'week']),
      layout: z.enum(['buckets', 'schedule', 'list']),
    })
    .strict(),
  z.object({ do: z.literal('organize') }).strict(),
  z
    .object({ do: z.literal('setTheme'), mode: z.enum(['light', 'dark']), theme: z.string().regex(LOOK_REF_RE) })
    .strict(),
  z.object({ do: z.literal('applyLook'), look: z.string().regex(LOOK_REF_RE) }).strict(),
]);

export const RecipeManifestSchema = z
  .object({
    version: z.literal(1),
    trigger: RecipeTriggerSchema,
    filters: RecipeFiltersSchema.default({}),
    steps: z.array(RecipeStepSchema).min(1).max(RECIPE_MAX_STEPS),
  })
  .strict();
export type RecipeManifest = z.infer<typeof RecipeManifestSchema>;
export type RecipeStep = z.infer<typeof RecipeStepSchema>;
export type RecipeTrigger = z.infer<typeof RecipeTriggerSchema>;

/* ── Mods, themes, Looks ──────────────────────────────────────────────────── */

// PLACEHOLDER: the mod manifest (uses, commands, panels, settings) lands with the
// mod runtime, build order 8. Until then a mod row's manifest is unread.
export const ModManifestSchema = z.unknown();
// A theme's token grammar: ./theme-grammar.ts (build order 5).
export { ThemeManifestSchema, type ThemeManifest };

/**
 * One of the owner's own themes, by its `u-` slug. Never the editor's draft
 * slug, which no row has. Whether it names a theme of the right mode is asked
 * at save (lib/user-looks.ts, lookRefProblems) and again when the Look
 * resolves, since the owner can write the row straight through PostgREST.
 */
const OwnThemeRefSchema = z
  .string()
  .regex(USER_THEME_SLUG_RE)
  .refine((s) => s !== DRAFT_SLUG) as unknown as z.ZodType<`u-${string}`>;

/**
 * A Look (build order 5b): a shipped layout with a light and a dark theme.
 * Decision 5, no layout remixes: the layout is one of LAYOUTS, never a slot
 * mix. The built-in lists come from theme-grammar's bases, which a test pins
 * to LIGHT_LOOKS and DARK_LOOKS: lib/theme-looks.ts cannot be imported here
 * (it reads the user-theme registry, which imports this file).
 *
 * No `label`: the name is the row's, as for a theme, so the two cannot drift.
 */
export const LookManifestSchema = z
  .object({
    version: z.literal(1),
    layout: z.custom<LayoutTheme>(isLayoutTheme, { message: 'Pick a layout.' }),
    light: z.union([z.enum(LIGHT_BASES), OwnThemeRefSchema]),
    dark: z.union([z.enum(DARK_BASES), OwnThemeRefSchema]),
  })
  .strict();
export type LookManifest = z.infer<typeof LookManifestSchema>;

export function manifestSchemaFor(kind: ModKind): z.ZodTypeAny {
  switch (kind) {
    case 'recipe':
      return RecipeManifestSchema;
    case 'mod':
      return ModManifestSchema;
    case 'theme':
      return ThemeManifestSchema;
    case 'look':
      return LookManifestSchema;
  }
}
