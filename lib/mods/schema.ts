import { z } from 'zod';
import { TimeBucketSchema } from '@dsul/types';
import type { ModEvent } from '@/lib/mod-events';
import type { VerbId } from '@/lib/verb-gates';
import { isLayoutTheme, type LayoutTheme } from '@/lib/layout-themes';
import { DRAFT_SLUG, USER_THEME_SLUG_RE } from '@/lib/user-themes/css';
import { DARK_BASES, LIGHT_BASES, ThemeManifestSchema, type ThemeManifest } from './theme-grammar';
import { MOD_COMMANDS_MAX, MOD_PANELS_MAX, MOD_SETTINGS_MAX } from './limits';
import {
  MOD_NAME_MAX,
  isModLabel,
  isModName,
  isPlainModText,
  isSafeTypedValue,
  normalizeModText,
  passesLabelRule,
  passesSurfaceRule,
  URL_RE,
} from './labels';
import { MOD_ICON_NAMES } from './ui/icons-list';
import { ModIdentSchema } from './protocol';

export {
  BARE_DOMAIN_RE,
  CONTROL_RE,
  KEY_SHAPED_RE,
  MOD_LABEL_FORBIDDEN_RE,
  MOD_NAME_MAX,
  URL_RE,
  isMixedScript,
  isModLabel,
  isModName,
  isPlainModText,
  modDisplayLabel,
  normalizeModText,
  passesLabelRule,
  passesSurfaceRule,
  isSafeTypedValue,
  surfaceMessage,
  SECRET_SHAPED_RE,
  MOD_SURFACE_FORBIDDEN_RE,
} from './labels';
/** The events a mod hears: lib/mods/protocol.ts, self-contained for the worker bundle. */
export { MOD_EVENT_KINDS, type ModEventKind } from './protocol';

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
/** 061's octet_length caps on source and store. */
export const MOD_SOURCE_MAX_BYTES = 65536;
export const MOD_STORE_MAX_BYTES = 65536;
/** A run stops at 25 writes (mods.md, "Runs"), so a recipe holds at most 25 steps. */
export const RECIPE_MAX_STEPS = 25;

export const ModSlugSchema = z.string().regex(MOD_SLUG_RE);

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
export const LOOK_REF_RE = /^[a-z][a-z0-9-]{0,31}$/;

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

export const StepTitleSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((s) => !URL_RE.test(s), { message: 'No links in a title.' });

// Closed enums, so no recipe (or mod, lib/mods/broker-core.ts) argument ever
// reaches setLayout unparsed.
export const GotoStepSchema = z
  .object({
    do: z.literal('goto'),
    scope: z.enum(['day', 'week']),
    layout: z.enum(['buckets', 'schedule', 'list']),
  })
  .strict();
export const SetThemeStepSchema = z
  .object({ do: z.literal('setTheme'), mode: z.enum(['light', 'dark']), theme: z.string().regex(LOOK_REF_RE) })
  .strict();
export const ApplyLookStepSchema = z.object({ do: z.literal('applyLook'), look: z.string().regex(LOOK_REF_RE) }).strict();

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
  GotoStepSchema,
  z.object({ do: z.literal('organize') }).strict(),
  SetThemeStepSchema,
  ApplyLookStepSchema,
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

/** What a mod may ask `$` for. Anything else it is refused at the call. */
export const MOD_USES = ['items:read', 'items:write', 'ui', 'storage', 'look'] as const;
export type ModUse = (typeof MOD_USES)[number];

/**
 * A title a mod writes: a recipe's title rule (120, no link), trimmed and
 * NFKC-normalised, with no format or control character, no bare domain and
 * nothing shaped like a key (./labels.ts).
 */
export const ModTitleSchema = z
  .string()
  .transform((s) => normalizeModText(s.trim()))
  .pipe(StepTitleSchema.refine(isPlainModText, { message: 'Plain text only.' }));

/** A toast a mod shows: a title, under the label rule too, since it sits under host chrome. */
export const ModToastTextSchema = ModTitleSchema.pipe(
  z.string().refine(passesLabelRule, { message: 'That text cannot be shown.' })
);

const unique = (xs: readonly string[]) => new Set(xs).size === xs.length;

export const ModCommandSchema = z
  .object({
    // `run` is a recipe's own command id (`mod.<slug>.run`), and slugs are unique across kinds.
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,29}$/)
      .refine((id) => id !== 'run', { message: 'Pick another id.' }),
    label: z.string().refine(isModLabel, { message: 'That label cannot be shown.' }),
    keywords: z.array(z.string().max(30).refine(isModLabel)).max(5).optional(),
  })
  .strict();
export type ModCommand = z.infer<typeof ModCommandSchema>;

/** A panel id or setting key: the slug rule, as the protocol holds it. */
const ModIdent = ModIdentSchema;

/** A label a panel or setting shows under host chrome: the label rule and the stricter surface rule, 40 at most. */
const PanelLabel = z
  .string()
  .max(40)
  .refine((s) => isModLabel(s) && passesSurfaceRule(s), { message: 'That label cannot be shown.' });

/**
 * A panel a mod draws (build order 9). Any panel opens in the rail (desktop)
 * or the sheet (phone); one with `card` also shows under the braindump. Panel
 * ids are their own namespace, so `run` is fine here.
 */
export const ModPanelSchema = z
  .object({
    id: ModIdent,
    label: PanelLabel,
    icon: z.enum(MOD_ICON_NAMES).optional(),
    card: z.boolean().optional(),
  })
  .strict();
export type ModPanel = z.infer<typeof ModPanelSchema>;

const finite = z.number().finite();

/** A value the person sets for the mod in Make. The mod reads them through `$.settings.get` and never writes them. */
export const ModSettingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('toggle'), key: ModIdent, label: PanelLabel, default: z.boolean().optional() }).strict(),
  z
    .object({
      kind: z.literal('number'),
      key: ModIdent,
      label: PanelLabel,
      default: finite.optional(),
      min: finite.optional(),
      max: finite.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('text'),
      key: ModIdent,
      label: PanelLabel,
      default: z
        .string()
        .max(100)
        .refine((t) => !t.includes('\n') && passesSurfaceRule(t), { message: 'That text cannot be shown.' })
        .optional(),
      maxLength: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('select'),
      key: ModIdent,
      label: PanelLabel,
      options: z.array(z.object({ value: ModIdent, label: PanelLabel }).strict()).min(1).max(6),
      default: ModIdent.optional(),
    })
    .strict(),
]);
export type ModSetting = z.infer<typeof ModSettingSchema>;

/**
 * A mod's manifest, declared in its source (`export const manifest = {...}`)
 * and stored in user_mods.manifest at save (build order 8). No slug or name:
 * those are the row's, as a Look's are. `panels` and `settings` are build
 * order 9's, and default to none, so a build order 8 manifest still parses.
 */
export const ModManifestSchema = z
  .object({
    version: z.literal(1),
    uses: z
      .array(z.enum(MOD_USES))
      .max(MOD_USES.length)
      .refine(unique, { message: 'Each use once.' }),
    commands: z
      .array(ModCommandSchema)
      .max(MOD_COMMANDS_MAX)
      .refine((cs) => unique(cs.map((c) => c.id)), { message: 'Each command id once.' })
      .default([]),
    panels: z
      .array(ModPanelSchema)
      .max(MOD_PANELS_MAX)
      .refine((ps) => unique(ps.map((p) => p.id)), { message: 'Each panel id once.' })
      .refine((ps) => ps.filter((p) => p.card).length <= 1, { message: 'One card panel at most.' })
      .default([]),
    settings: z
      .array(ModSettingSchema)
      .max(MOD_SETTINGS_MAX)
      .refine((ss) => unique(ss.map((x) => x.key)), { message: 'Each setting key once.' })
      .refine((ss) => ss.every(settingDeclarationOk), {
        message: 'A setting\'s default must be one of its own values.',
      })
      .default([]),
  })
  .strict()
  .refine((m) => m.panels.length === 0 || m.uses.includes('ui'), {
    message: 'Panels need "ui" in uses.',
    path: ['panels'],
  });
export type ModManifest = z.infer<typeof ModManifestSchema>;

/** A select's default among its options; a number's min no more than its max, and its default between them. */
function settingDeclarationOk(s: ModSetting): boolean {
  if (s.kind === 'select') return s.default === undefined || s.options.some((o) => o.value === s.default);
  if (s.kind === 'number') {
    if (s.min !== undefined && s.max !== undefined && s.min > s.max) return false;
    if (s.default === undefined) return true;
    return (s.min === undefined || s.default >= s.min) && (s.max === undefined || s.default <= s.max);
  }
  if (s.kind === 'text') return s.default === undefined || s.maxLength === undefined || s.default.length <= s.maxLength;
  return true;
}

/** A row's stored manifest, parsed, or null. Never trusted because the app wrote it. */
export function parseModManifest(row: { kind: ModKind; manifest: unknown }): ModManifest | null {
  if (row.kind !== 'mod') return null;
  const parsed = ModManifestSchema.safeParse(row.manifest);
  return parsed.success ? parsed.data : null;
}

/** True when the new manifest asks for a use the old one did not. */
export function usesWidened(before: Pick<ModManifest, 'uses'> | null, after: Pick<ModManifest, 'uses'>): boolean {
  const had = new Set(before?.uses ?? []);
  return after.uses.some((u) => !had.has(u));
}

/** Whether a manifest declares a card panel, the one under the braindump. */
export function hasCard(m: Pick<ModManifest, 'panels'> | null): boolean {
  return !!m?.panels?.some((p) => p.card);
}

/**
 * True when a save asks for more than the person switched on: a wider `uses`,
 * or a first card panel, which puts the mod somewhere the person did not see
 * it before. Such a save is saved switched off. Any other panel or settings
 * change keeps the mod on.
 */
export function consentWidened(
  before: Pick<ModManifest, 'uses' | 'panels'> | null,
  after: Pick<ModManifest, 'uses' | 'panels'>
): boolean {
  return usesWidened(before, after) || (!hasCard(before) && hasCard(after));
}

export type ModSettingValue = boolean | number | string | null;

/**
 * The values the person set (store['@settings']), held to what the manifest
 * declares now: each declared key's stored value when it still fits, else its
 * default, else null. Undeclared keys are dropped. A text value shaped like a
 * secret falls back too. Never throws.
 */
export function parseModSettings(
  manifest: Pick<ModManifest, 'settings'> | null,
  raw: unknown
): Record<string, ModSettingValue> {
  const out: Record<string, ModSettingValue> = {};
  const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  for (const s of manifest?.settings ?? []) {
    const v = Object.hasOwn(stored, s.key) ? stored[s.key] : undefined;
    out[s.key] = settingFits(s, v) ? (v as ModSettingValue) : (s.default ?? null);
  }
  return out;
}

function settingFits(s: ModSetting, v: unknown): boolean {
  switch (s.kind) {
    case 'toggle':
      return typeof v === 'boolean';
    case 'number':
      return (
        typeof v === 'number' &&
        Number.isFinite(v) &&
        (s.min === undefined || v >= s.min) &&
        (s.max === undefined || v <= s.max)
      );
    case 'text':
      return typeof v === 'string' && v.length <= (s.maxLength ?? 200) && isSafeTypedValue(v);
    case 'select':
      return typeof v === 'string' && s.options.some((o) => o.value === v);
  }
}

/** Keys sorted at every depth, so jsonb's key order and the code's compare equal. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * The stored manifest against the one the loaded code declares, both parsed
 * first (so a missing `commands` and `[]` agree). Unequal, or either invalid,
 * is false: the stored copy is what ⌘K and the broker trust.
 */
export function manifestsEqual(a: unknown, b: unknown): boolean {
  const pa = ModManifestSchema.safeParse(a);
  const pb = ModManifestSchema.safeParse(b);
  return pa.success && pb.success && canonicalJson(pa.data) === canonicalJson(pb.data);
}
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
