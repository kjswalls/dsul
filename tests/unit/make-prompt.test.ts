import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));

import { z } from 'zod';
import { TimeBucketSchema } from '@dsul/types';
import {
  JSON_ONLY_LINE,
  MAKE_EXAMPLES,
  MAKE_KINDS,
  NAMES_LEAD,
  STEP_WORDS,
  TOKEN_WORDS,
  TRIGGER_WORDS,
  fixedPrompt,
  framedNames,
  makeSystem,
} from '@/lib/ai-server/make-prompt';
import { EMPTY_MAKE_CONTEXT, type MakeContext } from '@/lib/ai-server/make-context';
import {
  LookManifestSchema,
  RecipeFiltersSchema,
  RecipeManifestSchema,
  RecipeStepSchema,
  RecipeTriggerSchema,
  type RecipeStep,
  type RecipeTrigger,
} from '@/lib/mods/schema';
import {
  ALPHA_BOUNDS,
  COLOR_KEYS,
  DARK_BASES,
  LIGHT_BASES,
  RADIUS_MAX,
  RELAY_KEYS,
  RELAY_MAX,
  SHADOW_PRESETS,
  THEME_FONT_KEYS,
  ThemeManifestSchema,
  type ColorKey,
  type RelayKey,
} from '@/lib/mods/theme-grammar';
import { LAYOUTS } from '@/lib/layout-themes';
import { LOOKS } from '@/lib/looks';
import { parseMakeDraft } from '@/lib/make-draft';

/**
 * The fixed prompt for "Write with AI" (lib/ai-server/make-prompt.ts) is
 * generated from the schemas. This is its drift test: every value a schema
 * takes is in the prompt for its kind, so a new trigger, step, token, preset,
 * font, base or layout cannot ship without the model being told of it.
 */

const recipe = fixedPrompt('recipe');
const theme = fixedPrompt('theme');
const look = fixedPrompt('look');
const q = (s: string) => JSON.stringify(s);

function discriminators(options: readonly z.ZodTypeAny[], key: string): string[] {
  return options.flatMap((o) => {
    const d = (o as z.AnyZodObject).shape[key];
    return d instanceof z.ZodEnum ? (d.options as string[]) : [String((d as z.ZodLiteral<string>).value)];
  });
}
function fieldNames(options: readonly z.ZodTypeAny[]): string[] {
  return [...new Set(options.flatMap((o) => Object.keys((o as z.AnyZodObject).shape)))];
}

describe('the recipe prompt', () => {
  const ons = discriminators(RecipeTriggerSchema.options, 'on');
  const dos = discriminators(RecipeStepSchema.options, 'do');

  it('names every trigger, step and field the schema takes', () => {
    for (const on of ons) expect(recipe, on).toContain(`- ${q(on)}: ${TRIGGER_WORDS[on as RecipeTrigger['on']]}`);
    for (const d of dos) expect(recipe, d).toContain(`- ${q(d)}: ${STEP_WORDS[d as RecipeStep['do']]}`);
    for (const f of [...fieldNames(RecipeTriggerSchema.options), ...fieldNames(RecipeStepSchema.options)]) {
      expect(recipe, f).toContain(q(f));
    }
    for (const k of Object.keys(RecipeFiltersSchema.shape)) expect(recipe, k).toContain(`- ${q(k)}`);
  });

  it('prints every part of day and the go-to enums', () => {
    for (const b of TimeBucketSchema.options) expect(recipe).toContain(q(b));
    for (const v of ['day', 'week', 'buckets', 'schedule', 'list', 'light', 'dark']) expect(recipe).toContain(q(v));
  });

  it('names the theme and Look ids a step may use', () => {
    for (const b of [...LIGHT_BASES, ...DARK_BASES]) expect(recipe).toContain(q(b));
    for (const l of LOOKS) expect(recipe).toContain(q(l.id));
  });

  it('teaches the rules a draft is refused or held for', () => {
    expect(recipe).toContain('"item" is always "trigger"');
    expect(recipe).toContain('Never add habits');
    expect(recipe).toContain('A recipe at a set time ("time") only adds, completes, skips or reschedules');
  });

  it('the word tables cover the schema exactly, both ways', () => {
    expect(Object.keys(TRIGGER_WORDS).sort()).toEqual([...ons].sort());
    expect(Object.keys(STEP_WORDS).sort()).toEqual([...dos].sort());
  });
});

describe('the theme prompt', () => {
  it('names every token, its alpha range, the relay lists and their mode', () => {
    for (const k of COLOR_KEYS) expect(theme, k).toContain(`- ${q(k)}: ${TOKEN_WORDS[k]}`);
    for (const k of RELAY_KEYS) expect(theme, k).toContain(`- ${q(k)}:`);
    for (const [k, [lo, hi]] of Object.entries(ALPHA_BOUNDS) as [ColorKey, [number, number]][]) {
      expect(theme, k).toContain(`- ${q(k)}: N from ${Math.round(lo * 100)}% to ${Math.round(hi * 100)}%`);
    }
    expect(theme).toContain(`a list of 1 to ${RELAY_MAX} colours`);
    expect(Object.keys(TOKEN_WORDS).sort()).toEqual([...COLOR_KEYS, ...RELAY_KEYS].sort());
    const _exhaustive: Record<ColorKey | RelayKey, string> = TOKEN_WORDS;
    void _exhaustive;
  });

  it('every preset, font, radius bound and base, split by mode', () => {
    for (const s of SHADOW_PRESETS) expect(theme).toContain(q(s));
    for (const f of THEME_FONT_KEYS) expect(theme).toContain(q(f));
    expect(theme).toContain(`from 0 to ${RADIUS_MAX}`);
    const light = theme.slice(theme.indexOf('Light:'), theme.indexOf('Dark:'));
    const dark = theme.slice(theme.indexOf('Dark:'), theme.indexOf('\n', theme.indexOf('Dark:')));
    for (const b of LIGHT_BASES) expect(light).toContain(q(b));
    for (const b of DARK_BASES) expect(dark).toContain(q(b));
  });

  it('never invites the contrast override', () => {
    expect(theme).toContain('Never set "contrastOverride"');
  });
});

describe('the Look prompt', () => {
  it('every layout, and the built-in bases of each mode', () => {
    for (const l of LAYOUTS) expect(look).toContain(`- ${q(l.value)}: ${l.label}.`);
    for (const b of LIGHT_BASES) expect(look).toContain(q(b));
    for (const b of DARK_BASES) expect(look).toContain(q(b));
  });
});

describe('the examples', () => {
  it.each(MAKE_KINDS)('the %s example passes its schema and the draft checks, with no problems', (kind) => {
    const ex = MAKE_EXAMPLES[kind];
    const schema = { recipe: RecipeManifestSchema, theme: ThemeManifestSchema, look: LookManifestSchema }[kind];
    expect(schema.safeParse(ex.manifest).success).toBe(true);
    const result = parseMakeDraft(JSON.stringify(ex), kind, { recipe: { customTypeNames: [] }, rows: [] });
    expect(result).toMatchObject({ ok: true, problems: [] });
    expect(fixedPrompt(kind)).toContain(`Example: ${JSON.stringify(ex)}`);
  });
});

describe('the whole prompt', () => {
  it.each(MAKE_KINDS)('%s: asks for JSON, prefers a recipe, no em dash, no old name', (kind) => {
    const text = makeSystem(kind, EMPTY_MAKE_CONTEXT).join('\n\n');
    expect(text).toContain('JSON');
    expect(text).toContain('Prefer a recipe whenever it could be either');
    expect(text).not.toMatch(/—/);
    expect(text).not.toMatch(/\bBeacon\b/i);
  });

  it('runtime names enter only in the second part, JSON-encoded, after the data line', () => {
    const ctx: MakeContext = {
      projects: ['Work "plans"', 'Home'],
      types: [{ name: 'chore', label: 'Chore' }],
      themes: [{ ref: 'u-1234abcd', name: 'Moss', mode: 'light' }],
      looks: [{ ref: 'u-9999aaaa', name: 'Deep' }],
    };
    const [fixed, names, last] = makeSystem('recipe', ctx);
    expect(fixed).toBe(fixedPrompt('recipe'));
    for (const needle of ['Moss', 'Deep', 'chore', 'u-1234abcd', 'Home']) expect(fixed).not.toContain(needle);
    expect(names.startsWith(NAMES_LEAD)).toBe(true);
    expect(names).toContain(JSON.stringify(ctx.projects));
    expect(names).toContain(JSON.stringify(ctx.themes));
    expect(names).toBe(framedNames(ctx));
    expect(last).toBe(JSON_ONLY_LINE);
  });
});
