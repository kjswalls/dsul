import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));

import { z } from 'zod';
import { TimeBucketSchema } from '@dsul/types';
import {
  JSON_ONLY_LINE,
  LABEL_AVOID,
  MAKE_EXAMPLES,
  MAKE_KINDS,
  MOD_PROJECTS_LINE,
  NAMES_LEAD,
  SETTING_WORDS,
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
import {
  MOD_USES,
  ModManifestSchema,
  ModSettingSchema,
  passesSurfaceRule,
} from '@/lib/mods/schema';
import { METHOD_USES, RESOLVE_ALLOWED, USER_ACTED } from '@/lib/mods/broker-core';
import {
  MOD_ATOMS_MAX,
  MOD_COMMANDS_MAX,
  MOD_MANIFEST_MAX_BYTES,
  MOD_PANELS_MAX,
  MOD_SETTINGS_MAX,
  MOD_TREE_DEPTH_MAX,
  MOD_TREE_MAX_BYTES,
  MOD_TREE_NODES_MAX,
} from '@/lib/mods/limits';
import { HookEventSchema, MOD_EVENT_KINDS, MOD_METHODS } from '@/lib/mods/protocol';
import { ModNodeSchema, type ModNodeType } from '@/lib/mods/ui/tree';
import { MOD_ICON_NAMES } from '@/lib/mods/ui/icons-list';
import { MOD_TEMPLATE } from '@/lib/mods/template';
import {
  MOD_EVENT_FIELD_WORDS,
  MOD_HOOK_WORDS,
  MOD_METHOD_WORDS,
  MOD_NODE_WORDS,
  MOD_USE_WORDS,
  hooksInWords,
  panelsInWords,
  usesInWords,
} from '@/lib/mods/words';
import * as editorWords from '@/components/settings/mod-editor';
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
  // A mod's example is its source, run by tests/unit/make-mod-roundtrip.test.ts.
  it.each(['recipe', 'theme', 'look'] as const)('the %s example passes its schema and the draft checks, with no problems', (kind) => {
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

  it.each(MAKE_KINDS)('%s: names the kind asked, and offers every other kind, a mod included', (kind) => {
    const text = fixedPrompt(kind);
    expect(text.split('\n')[0]).toContain(`: a ${kind === 'look' ? 'Look' : kind},`);
    expect(text).toContain('{"kind":"none","suggest":"recipe"} (or "theme", "look", "mod", or null)');
    expect(text).toContain(kind === 'mod' ? '"source":' : '"manifest": the manifest described below');
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
    expect(names).toBe(framedNames(ctx, 'recipe'));
    expect(last).toBe(JSON_ONLY_LINE);
  });
});

describe('the mod prompt', () => {
  const mod = fixedPrompt('mod');
  const lines = mod.split('\n');
  const lineWith = (needle: string) => lines.find((l) => l.includes(needle)) ?? '';
  const nodes = (ModNodeSchema as unknown as z.ZodLazy<z.ZodDiscriminatedUnion<'type', z.AnyZodObject[]>>).schema
    .options;

  it('every $ method, with the use it needs', () => {
    for (const m of MOD_METHODS) {
      const line = lineWith(`- $.${m}(`);
      expect(line, m).not.toBe('');
      const use = METHOD_USES[m];
      expect(line, m).toContain(use ? `needs ${q(use)}` : 'needs nothing in "uses"');
    }
  });

  it('the context rules list the broker\'s own sets', () => {
    const acted = lineWith('Only in a "command" or "ui.action" handler');
    for (const m of USER_ACTED) expect(acted, m).toContain(`$.${m}`);
    const drawing = lineWith('While drawing a panel ("ui.resolve")');
    for (const m of RESOLVE_ALLOWED) expect(drawing, m).toContain(`$.${m}`);
    for (const m of MOD_METHODS.filter((x) => !RESOLVE_ALLOWED.has(x))) expect(drawing, m).not.toContain(`$.${m},`);
    expect(mod).toContain('never adds or changes items');
    expect(mod).toContain('check "ok"');
  });

  it('every event kind, with each of its fields', () => {
    for (const option of HookEventSchema.options) {
      const shape = (option as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      const kinds = discriminators([option], 'kind');
      for (const kind of kinds) {
        const line = lineWith(`- ${q(kind)}: ${MOD_HOOK_WORDS[kind as keyof typeof MOD_HOOK_WORDS]}`);
        expect(line, kind).not.toBe('');
        for (const field of Object.keys(shape).filter((k) => k !== 'kind')) expect(line, `${kind}.${field}`).toContain(q(field));
      }
    }
    expect(MOD_EVENT_KINDS.every((k) => mod.includes(`- ${q(k)}:`))).toBe(true);
  });

  it('never words a mod\'s event fields as a recipe\'s', () => {
    expect(mod).not.toContain('the item that started the recipe');
    expect(mod).not.toContain('trigger');
  });

  it('every node type, icon, use, manifest key and setting kind', () => {
    for (const t of discriminators(nodes, 'type')) {
      expect(mod, t).toContain(`- ${q(t)}: ${MOD_NODE_WORDS[t as ModNodeType]}`);
    }
    expect(lineWith('Icon names:')).toContain(MOD_ICON_NAMES.join(', '));
    // Printed once: a field that takes an icon points at the list.
    expect(mod.split(MOD_ICON_NAMES.join(', ')).length).toBe(2);
    for (const u of MOD_USES) expect(mod, u).toContain(`- ${q(u)}: ${MOD_USE_WORDS[u]}`);
    for (const k of Object.keys(ModManifestSchema.innerType().shape)) expect(mod, k).toContain(`- ${q(k)}`);
    for (const k of discriminators(ModSettingSchema.options, 'kind')) expect(mod, k).toContain(`- ${q(k)}: ${SETTING_WORDS[k as keyof typeof SETTING_WORDS]}`);
  });

  it('a button takes two tones, the other toned nodes three', () => {
    expect(lineWith('- "button":')).toContain('"tone" (optional): one of "accent", "muted".');
    for (const t of ['text', 'badge', 'progress', 'stat'] as const) {
      expect(lineWith(`- ${q(t)}: ${MOD_NODE_WORDS[t]}`), t).toContain('"tone" (optional): one of "muted", "accent", "warn"');
    }
  });

  it('states the caps from the constants', () => {
    expect(mod).toContain(`At most ${MOD_COMMANDS_MAX} commands, ${MOD_PANELS_MAX} panels with at most one "card": true, ${MOD_SETTINGS_MAX} settings`);
    expect(mod).toContain(`${MOD_MANIFEST_MAX_BYTES} bytes of manifest`);
    expect(mod).toContain(`at most ${MOD_TREE_NODES_MAX} nodes, nested at most ${MOD_TREE_DEPTH_MAX} deep, and ${MOD_TREE_MAX_BYTES} bytes`);
    expect(mod).toContain(`at most ${MOD_ATOMS_MAX} atoms`);
    expect(mod).toContain('Panels need "ui" in "uses"');
  });

  it('teaches the module shape, and that $ has no AI', () => {
    expect(mod).toContain('export const manifest = {...}');
    expect(mod).toContain('export function register(on)');
    expect(mod).toContain('no AI: $ has none');
    expect(mod).toContain('If a recipe could do it');
    expect(mod).toContain('Make up your own command, panel, setting and atom ids');
    expect(mod).not.toContain('Never invent ids');
    expect(mod).toContain('$.containers.list()');
    expect(mod).toContain('Titles a mod writes are fixed short words');
  });

  it('its one example is the Water template, as one JSON string', () => {
    expect(MAKE_EXAMPLES.mod).toEqual({ kind: 'mod', name: 'Water', source: MOD_TEMPLATE });
    expect(mod).toContain(`Example: ${JSON.stringify(MAKE_EXAMPLES.mod)}`);
  });

  it('every word it tells the model to avoid in a label is one the surface rule refuses', () => {
    for (const w of LABEL_AVOID) expect(passesSurfaceRule(w), w).toBe(false);
    expect(lineWith('Never use these words in them:')).toContain(LABEL_AVOID.join(', '));
  });

  it('names reach it only through framedNames: types, themes and Looks, never a project', () => {
    const ctx: MakeContext = {
      projects: ['PROJECT-SENTINEL'],
      types: [{ name: 'chore', label: 'Chore' }],
      themes: [{ ref: 'u-1234abcd', name: 'Moss', mode: 'light' }],
      looks: [{ ref: 'u-9999aaaa', name: 'Deep' }],
    };
    const [fixed, names, last] = makeSystem('mod', ctx);
    expect(fixed).toBe(fixedPrompt('mod'));
    expect(names).toBe(framedNames(ctx, 'mod'));
    expect(last).toBe(JSON_ONLY_LINE);
    expect(makeSystem('mod', ctx).join('\n')).not.toContain('PROJECT-SENTINEL');
    expect(names).toContain(MOD_PROJECTS_LINE);
    for (const needle of ['Moss', 'Deep', 'chore', 'u-1234abcd']) expect(names).toContain(needle);
    for (const needle of ['Moss', 'Deep', 'chore', 'u-1234abcd']) expect(fixed).not.toContain(needle);
  });
});

describe('the mod word tables (lib/mods/words.ts)', () => {
  const nodeTypes = discriminators(
    (ModNodeSchema as unknown as z.ZodLazy<z.ZodDiscriminatedUnion<'type', z.AnyZodObject[]>>).schema.options,
    'type'
  );

  it('cover their unions exactly, both ways', () => {
    expect(Object.keys(MOD_METHOD_WORDS).sort()).toEqual([...MOD_METHODS].sort());
    expect(Object.keys(MOD_HOOK_WORDS).sort()).toEqual([...MOD_EVENT_KINDS].sort());
    expect(Object.keys(MOD_NODE_WORDS).sort()).toEqual([...nodeTypes].sort());
    expect(Object.keys(MOD_USE_WORDS).sort()).toEqual([...MOD_USES].sort());
    expect(Object.keys(SETTING_WORDS).sort()).toEqual(discriminators(ModSettingSchema.options, 'kind').sort());
    const eventFields = fieldNames(HookEventSchema.options).filter((f) => f !== 'kind');
    expect(Object.keys(MOD_EVENT_FIELD_WORDS).sort()).toEqual(eventFields.sort());
  });

  it('the editor still exports the words it moved', () => {
    expect(editorWords.MOD_USE_WORDS).toBe(MOD_USE_WORDS);
    expect(editorWords.usesInWords).toBe(usesInWords);
    expect(editorWords.panelsInWords).toBe(panelsInWords);
  });

  it('hooksInWords: "as written now", in event order, panel hooks left to the panels line', () => {
    expect(hooksInWords(['command', 'item.completed', 'ui.resolve', 'ui.action'])).toBe(
      'As written now, it runs when an item is ticked and when one of its commands is run.'
    );
    expect(hooksInWords(['ui.resolve', 'atom.changed'])).toBe('');
    expect(hooksInWords([])).toBe('');
    expect(hooksInWords(['timer', 'review.saved', 'item.created'])).toBe(
      "As written now, it runs when an item is added, when the day's review is saved and when one of its timers goes off."
    );
  });

  it('no word in them is an em dash or the old name', () => {
    const all = JSON.stringify([MOD_METHOD_WORDS, MOD_HOOK_WORDS, MOD_NODE_WORDS, MOD_EVENT_FIELD_WORDS, MOD_USE_WORDS]);
    expect(all).not.toMatch(/—/);
    expect(all).not.toMatch(/\bBeacon\b/i);
  });
});
