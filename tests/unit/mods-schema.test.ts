import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ModNameSchema,
  ModSlugSchema,
  RECIPE_EVENT_TRIGGERS,
  RECIPE_MAX_STEPS,
  RECIPE_VERBS,
  LookManifestSchema,
  RecipeManifestSchema,
  ThemeManifestSchema,
  UserModRowSchema,
  manifestSchemaFor,
  userModFromRow,
} from '@/lib/mods/schema';
import {
  MOD_EVENT_KINDS,
  ModManifestSchema,
  ModTitleSchema,
  ModToastTextSchema,
  isModLabel,
  manifestsEqual,
  modDisplayLabel,
  parseModManifest,
  parseModSettings,
  consentWidened,
  usesWidened,
} from '@/lib/mods/schema';
import { MOD_MANIFEST_MAX_BYTES, MOD_WRITES_PER_HOOK } from '@/lib/mods/limits';
import { MOD_UI_EVENT_KINDS } from '@/lib/mods/protocol';
import { MOD_LABEL_FORBIDDEN_RE } from '@/lib/mods/labels';
import { RUN_WRITE_CAP } from '@/lib/recipes/limits';
import { MODEL_PROVIDERS } from '@/lib/ai-types';
import { ITEM_VERBS } from '@/lib/item-verbs';
import { LAYOUTS } from '@/lib/layout-themes';
import { DARK_LOOKS, LIGHT_LOOKS } from '@/lib/theme-looks';
import { DARK_BASES, LIGHT_BASES } from '@/lib/mods/theme-grammar';

const RECIPE = {
  version: 1,
  trigger: { on: 'item.completed' },
  filters: { types: ['habit'], title: { contains: 'Run' }, weekdays: [1, 3, 5], openToday: true },
  steps: [
    { do: 'create', type: 'task', title: 'Stretch 10 min', bucket: 'evening' },
    { do: 'toast', text: 'Legs next' },
    { do: 'reschedule', item: 'trigger', inDays: 2 },
    { do: 'goto', scope: 'day', layout: 'schedule' },
  ],
};

describe('slug and name', () => {
  it('slugs follow 061: lowercase, starts with a letter, at most 30', () => {
    for (const ok of ['a', 'water', 'deep-work', 'a' + 'b'.repeat(29)]) {
      expect(ModSlugSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['', '-a', '1a', 'A', 'a_b', 'a' + 'b'.repeat(30)]) {
      expect(ModSlugSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('names are 1 to 60 code points, not blank, no control characters', () => {
    expect(ModNameSchema.safeParse('').success).toBe(false);
    expect(ModNameSchema.safeParse('   ').success).toBe(false);
    expect(ModNameSchema.safeParse('a\nb').success).toBe(false);
    expect(ModNameSchema.safeParse('a\u0085b').success).toBe(false);
    // Emoji are two UTF-16 units and one code point, as char_length counts.
    expect(ModNameSchema.safeParse('💧'.repeat(60)).success).toBe(true);
    expect(ModNameSchema.safeParse('💧'.repeat(61)).success).toBe(false);
  });
});

describe('user_mods row', () => {
  it('parses a row and maps it to camelCase', () => {
    const raw = {
      id: '11111111-1111-4111-8111-111111111111',
      user_id: '22222222-2222-4222-8222-222222222222',
      kind: 'theme',
      slug: 'moss',
      name: 'Moss',
      enabled: false,
      manifest: { anything: true },
      disabled_reason: null,
      created_at: '2026-10-07T00:00:00Z',
      updated_at: '2026-10-07T00:00:00Z',
    };
    const parsed = UserModRowSchema.parse(raw);
    expect(userModFromRow(parsed)).toMatchObject({ userId: raw.user_id, kind: 'theme', disabledReason: null });
    expect(UserModRowSchema.safeParse({ ...raw, kind: 'plugin' }).success).toBe(false);
    expect(UserModRowSchema.safeParse({ ...raw, source: 'x'.repeat(65537) }).success).toBe(false);
  });
});

describe('recipe manifest', () => {
  it('a valid recipe round-trips', () => {
    expect(RecipeManifestSchema.parse(RECIPE)).toEqual(RECIPE);
  });

  it('filters default to none', () => {
    const { filters, ...rest } = RECIPE;
    void filters;
    expect(RecipeManifestSchema.parse(rest).filters).toEqual({});
  });

  it('refuses unknown keys anywhere', () => {
    expect(RecipeManifestSchema.safeParse({ ...RECIPE, extra: 1 }).success).toBe(false);
    expect(
      RecipeManifestSchema.safeParse({ ...RECIPE, steps: [{ do: 'toast', text: 'x', css: 'a' }] }).success
    ).toBe(false);
    expect(
      RecipeManifestSchema.safeParse({ ...RECIPE, trigger: { on: 'command', at: '09:00' } }).success
    ).toBe(false);
  });

  it('steps are verbs: never tick, delete, resetStreak or leaveProjectBlock', () => {
    const allowed: readonly string[] = RECIPE_VERBS;
    for (const verb of ['tick', 'delete', 'resetStreak', 'leaveProjectBlock']) {
      expect(allowed).not.toContain(verb);
      expect(
        RecipeManifestSchema.safeParse({ ...RECIPE, steps: [{ do: verb, item: 'trigger' }] }).success,
        verb
      ).toBe(false);
    }
    for (const verb of RECIPE_VERBS) expect(Object.keys(ITEM_VERBS)).toContain(verb);
  });

  it('the event triggers are exactly the kinds lib/mod-events.ts raises', () => {
    const src = readFileSync(resolve(__dirname, '../../lib/mod-events.ts'), 'utf8');
    const declared = src.slice(src.indexOf('export type ModEvent'), src.indexOf('export type ModEventListener'));
    const kinds = [...declared.matchAll(/'([a-z]+\.[a-z]+)'/g)].map((m) => m[1]);
    expect([...new Set(kinds)].sort()).toEqual([...RECIPE_EVENT_TRIGGERS].sort());
  });

  it(`holds at most ${RECIPE_MAX_STEPS} steps`, () => {
    const step = { do: 'toast', text: 'x' };
    expect(RecipeManifestSchema.safeParse({ ...RECIPE, steps: Array(25).fill(step) }).success).toBe(true);
    expect(RecipeManifestSchema.safeParse({ ...RECIPE, steps: Array(26).fill(step) }).success).toBe(false);
    expect(RecipeManifestSchema.safeParse({ ...RECIPE, steps: [] }).success).toBe(false);
  });

  it('refuses a link in a created title', () => {
    for (const title of ['see https://x.test', 'www.example.com', 'HTTP://x']) {
      expect(
        RecipeManifestSchema.safeParse({ ...RECIPE, steps: [{ do: 'create', type: 'task', title }] }).success,
        title
      ).toBe(false);
    }
  });

  it('goto takes only the closed scope and layout lists', () => {
    const goto = (layout: string) =>
      RecipeManifestSchema.safeParse({ ...RECIPE, steps: [{ do: 'goto', scope: 'week', layout }] }).success;
    expect(goto('list')).toBe(true);
    expect(goto('canvas')).toBe(false);
    expect(goto('schedule; drop')).toBe(false);
  });

  it('time triggers are HH:MM', () => {
    const at = (t: string) => RecipeManifestSchema.safeParse({ ...RECIPE, trigger: { on: 'time', at: t } }).success;
    expect(at('07:30')).toBe(true);
    expect(at('23:59')).toBe(true);
    expect(at('24:00')).toBe(false);
    expect(at('7:30')).toBe(false);
  });

  it('weekdays are unique', () => {
    expect(
      RecipeManifestSchema.safeParse({ ...RECIPE, filters: { weekdays: [1, 1] } }).success
    ).toBe(false);
  });
});

describe('placeholders', () => {
  it('recipes and mods each have their own schema', () => {
    expect(manifestSchemaFor('recipe')).toBe(RecipeManifestSchema);
    expect(manifestSchemaFor('mod')).toBe(ModManifestSchema);
    expect(manifestSchemaFor('mod').safeParse({ whatever: [1] }).success).toBe(false);
  });

  it('a theme is the real grammar (lib/mods/theme-grammar.ts), not anything', () => {
    expect(manifestSchemaFor('theme')).toBe(ThemeManifestSchema);
    expect(manifestSchemaFor('theme').safeParse({ whatever: [1] }).success).toBe(false);
    expect(
      manifestSchemaFor('theme').safeParse({ version: 1, mode: 'light', base: 'paper', tokens: { paper0: '#fafafa' } })
        .success
    ).toBe(true);
  });
});

describe('Look manifest', () => {
  const look = (p: Record<string, unknown> = {}) => ({ version: 1, layout: 'classic', light: 'paper', dark: 'night', ...p });

  it('is the real schema for kind look', () => {
    expect(manifestSchemaFor('look')).toBe(LookManifestSchema);
    expect(manifestSchemaFor('look').safeParse({ whatever: [1] }).success).toBe(false);
  });

  it('takes every shipped layout with the built-ins', () => {
    for (const l of LAYOUTS) expect(LookManifestSchema.safeParse(look({ layout: l.value })).success, l.value).toBe(true);
    for (const t of LIGHT_LOOKS) expect(LookManifestSchema.safeParse(look({ light: t.value })).success).toBe(true);
    for (const t of DARK_LOOKS) expect(LookManifestSchema.safeParse(look({ dark: t.value })).success).toBe(true);
  });

  it('takes one of your themes on either side', () => {
    expect(LookManifestSchema.safeParse(look({ light: 'u-abcdef01' })).success).toBe(true);
    expect(LookManifestSchema.safeParse(look({ dark: 'u-abcdef01' })).success).toBe(true);
  });

  it('refuses a remix, the wrong mode, the draft slug, a bad ref, a label and a missing version', () => {
    for (const bad of [
      look({ layout: 'mine' }),
      look({ layout: { sidebar: 'left' } }),
      look({ light: 'night' }),
      look({ dark: 'paper' }),
      look({ light: 'u-00000000' }),
      look({ light: 'u-moss' }),
      look({ dark: 'u-ABCDEF01' }),
      look({ label: 'Deep work' }),
      { layout: 'classic', light: 'paper', dark: 'night' },
    ]) {
      expect(LookManifestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("the built-in lists match theme-looks' (the schema cannot import them)", () => {
    expect([...LIGHT_BASES]).toEqual(LIGHT_LOOKS.map((l) => l.value));
    expect([...DARK_BASES]).toEqual(DARK_LOOKS.map((l) => l.value));
  });
});

describe('mod manifest', () => {
  const OK = { version: 1, uses: ['storage', 'ui'], commands: [{ id: 'log-water', label: 'Log a glass' }] };

  it('takes a plain manifest and fills commands', () => {
    expect(ModManifestSchema.safeParse(OK).success).toBe(true);
    expect(ModManifestSchema.parse({ version: 1, uses: [] })).toEqual({
      version: 1,
      uses: [],
      commands: [],
      panels: [],
      settings: [],
    });
    expect(ModManifestSchema.safeParse({ ...OK, panels: [], settings: [] }).success).toBe(true);
  });

  it('refuses a wrong version, an unknown use, a use or command twice, `run`, and a stray key', () => {
    const bad = [
      { ...OK, version: 2 },
      { ...OK, uses: ['network'] },
      { ...OK, uses: ['ui', 'ui'] },
      { ...OK, commands: [OK.commands[0], OK.commands[0]] },
      { ...OK, commands: [{ id: 'run', label: 'Run' }] },
      { ...OK, commands: [{ id: 'Bad', label: 'Run' }] },
      { ...OK, panels: [{ id: 'x' }] },
      { ...OK, settings: [{ kind: 'toggle', key: 'x' }] },
      { ...OK, slug: 'water' },
    ];
    for (const m of bad) expect(ModManifestSchema.safeParse(m).success, JSON.stringify(m)).toBe(false);
  });

  it('refuses a command label or keyword that could pass for the app', () => {
    expect(ModManifestSchema.safeParse({ ...OK, commands: [{ id: 'a', label: 'Sign in again' }] }).success).toBe(false);
    expect(
      ModManifestSchema.safeParse({ ...OK, commands: [{ id: 'a', label: 'Water', keywords: ['password'] }] }).success
    ).toBe(false);
  });

  it('reads only a mod row, and only a valid manifest', () => {
    expect(parseModManifest({ kind: 'mod', manifest: OK })?.uses).toEqual(['storage', 'ui']);
    expect(parseModManifest({ kind: 'recipe', manifest: OK })).toBeNull();
    expect(parseModManifest({ kind: 'mod', manifest: { version: 1 } })).toBeNull();
  });

  it('knows when uses widened', () => {
    expect(usesWidened({ uses: ['ui'] }, { uses: ['ui'] })).toBe(false);
    expect(usesWidened({ uses: ['ui', 'storage'] }, { uses: ['ui'] })).toBe(false);
    expect(usesWidened({ uses: ['ui'] }, { uses: ['ui', 'items:write'] })).toBe(true);
    expect(usesWidened(null, { uses: ['ui'] })).toBe(true);
  });

  it('compares manifests by value, whatever the key order or a missing commands', () => {
    expect(manifestsEqual({ version: 1, uses: [] }, { uses: [], commands: [], version: 1 })).toBe(true);
    expect(manifestsEqual(OK, { commands: [{ label: 'Log a glass', id: 'log-water' }], uses: ['storage', 'ui'], version: 1 })).toBe(
      true
    );
    expect(manifestsEqual(OK, { ...OK, uses: ['ui', 'storage'] })).toBe(false);
    expect(manifestsEqual(OK, { ...OK, panels: [] })).toBe(true);
    expect(manifestsEqual(OK, { ...OK, panels: [{ id: 'water', label: 'Water' }] })).toBe(false);
  });

  it('hears the recipe triggers, then command and timer, and caps writes as a recipe run does', () => {
    expect(MOD_EVENT_KINDS).toEqual([...RECIPE_EVENT_TRIGGERS, 'command', 'timer', ...MOD_UI_EVENT_KINDS]);
    expect(MOD_WRITES_PER_HOOK).toBe(RUN_WRITE_CAP);
  });
});

describe('mod panels and settings (build order 9)', () => {
  const OK = { version: 1, uses: ['storage', 'ui'] };
  const ok = (m: object) => ModManifestSchema.safeParse({ ...OK, ...m }).success;

  it('takes panels, one card at most, under "ui"', () => {
    expect(ok({ panels: [{ id: 'water', label: 'Water', icon: 'CupSoda', card: true }, { id: 'run', label: 'Runs' }] })).toBe(true);
    expect(ok({ uses: ['storage'], panels: [{ id: 'water', label: 'Water' }] })).toBe(false);
    expect(ok({ panels: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] })).toBe(false);
    expect(ok({ panels: [{ id: 'a', label: 'A', card: true }, { id: 'b', label: 'B', card: true }] })).toBe(false);
    expect(ok({ panels: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, label: `P${i}` })) })).toBe(false);
  });

  it('refuses a panel label under the surface rule, an icon off the list and a stray key', () => {
    expect(ok({ panels: [{ id: 'a', label: 'Chat' }] })).toBe(false);
    expect(ok({ panels: [{ id: 'a', label: 'Your model' }] })).toBe(false);
    expect(ok({ panels: [{ id: 'a', label: 'Water', icon: 'Lock' }] })).toBe(false);
    expect(ok({ panels: [{ id: 'a', label: 'Water', icon: 'NotAnIcon' }] })).toBe(false);
    expect(ok({ panels: [{ id: 'a', label: 'Water', style: 'x' }] })).toBe(false);
  });

  it('takes settings of four kinds, held to their own values', () => {
    expect(
      ok({
        settings: [
          { kind: 'toggle', key: 'loud', label: 'Loud', default: true },
          { kind: 'number', key: 'goal', label: 'Goal', default: 8, min: 1, max: 20 },
          { kind: 'text', key: 'unit', label: 'Unit', default: 'glass', maxLength: 20 },
          { kind: 'select', key: 'size', label: 'Size', options: [{ value: 'small', label: 'Small' }], default: 'small' },
        ],
      })
    ).toBe(true);
    expect(ok({ settings: [{ kind: 'toggle', key: 'a', label: 'A' }, { kind: 'toggle', key: 'a', label: 'B' }] })).toBe(false);
    expect(ok({ settings: [{ kind: 'number', key: 'a', label: 'A', min: 5, max: 1 }] })).toBe(false);
    expect(ok({ settings: [{ kind: 'number', key: 'a', label: 'A', default: 30, max: 20 }] })).toBe(false);
    expect(ok({ settings: [{ kind: 'select', key: 'a', label: 'A', options: [{ value: 'x', label: 'X' }], default: 'y' }] })).toBe(false);
    expect(ok({ settings: [{ kind: 'text', key: 'a', label: 'A', default: 'Sign in' }] })).toBe(false);
    expect(ok({ settings: [{ kind: 'text', key: 'a', label: 'API secret' }] })).toBe(false);
  });

  it('fits a realistic large manifest in 8KB', () => {
    const big = {
      version: 1,
      uses: ['storage', 'ui', 'items:read', 'items:write'],
      commands: Array.from({ length: 5 }, (_, i) => ({ id: `cmd-${i}`, label: `Log water ${i}`, keywords: ['drink', 'glass'] })),
      panels: Array.from({ length: 4 }, (_, i) => ({ id: `panel-${i}`, label: `Water ${i}`, icon: 'CupSoda', card: i === 0 })),
      settings: Array.from({ length: 10 }, (_, i) => ({ kind: 'number', key: `goal-${i}`, label: `Goal ${i}`, default: 8, min: 1, max: 20 })),
    };
    expect(ModManifestSchema.safeParse(big).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeLessThanOrEqual(MOD_MANIFEST_MAX_BYTES);
  });

  it('parses stored settings against the declaration, falling back to the default, then null', () => {
    const m = ModManifestSchema.parse({
      ...OK,
      settings: [
        { kind: 'toggle', key: 'loud', label: 'Loud', default: true },
        { kind: 'number', key: 'goal', label: 'Goal', default: 8, min: 1, max: 20 },
        { kind: 'text', key: 'unit', label: 'Unit', maxLength: 10 },
        { kind: 'select', key: 'size', label: 'Size', options: [{ value: 'small', label: 'Small' }] },
      ],
    });
    expect(parseModSettings(m, { loud: false, goal: 12, unit: 'cup', size: 'small', extra: 1 })).toEqual({
      loud: false,
      goal: 12,
      unit: 'cup',
      size: 'small',
    });
    expect(parseModSettings(m, { loud: 'yes', goal: 99, unit: 'x'.repeat(11), size: 'huge' })).toEqual({
      loud: true,
      goal: 8,
      unit: null,
      size: null,
    });
    expect(parseModSettings(m, { unit: 'sk_live_abcdef123' }).unit).toBeNull();
    expect(parseModSettings(m, 'not an object')).toEqual({ loud: true, goal: 8, unit: null, size: null });
    expect(parseModSettings(m, [1, 2])).toEqual({ loud: true, goal: 8, unit: null, size: null });
    expect(parseModSettings(null, { a: 1 })).toEqual({});
  });

  it('counts a first card panel as widening consent, and nothing else about panels', () => {
    const base = { uses: ['ui' as const], panels: [] };
    const card = { uses: ['ui' as const], panels: [{ id: 'a', label: 'A', card: true }] };
    const plain = { uses: ['ui' as const], panels: [{ id: 'a', label: 'A' }] };
    expect(consentWidened(base, plain)).toBe(false);
    expect(consentWidened(base, card)).toBe(true);
    expect(consentWidened(plain, card)).toBe(true);
    expect(consentWidened(card, card)).toBe(false);
    expect(consentWidened(card, plain)).toBe(false);
    expect(consentWidened(base, { uses: ['ui', 'storage'], panels: [] })).toBe(true);
    expect(consentWidened(null, base)).toBe(true);
  });
});

describe('mod labels', () => {
  it('refuses every word that could pass for the app', () => {
    for (const label of [
      'AI helper',
      'Settings',
      'Setting',
      'Sign in',
      'sign-up',
      'Log out',
      'Login',
      'logout',
      'Account',
      'API key',
      'Keys',
      'Password',
      'Passcode',
      'Session',
      'Verify',
      'Verification',
      'Billing',
      'Payment',
      'Card',
      'Beacon',
      'OpenAI',
      'Claude',
      'Gemini',
      'Google',
      'OpenRouter',
      'OpenClaw',
      'Anthropic',
    ]) {
      expect(isModLabel(label), label).toBe(false);
    }
  });

  it('refuses plurals, joined words and look-alikes written wholly in another script', () => {
    for (const label of [
      'Accounts',
      'Sessions',
      'Logins',
      'Cards',
      'Passkey',
      'Credentials',
      'API token',
      'my_settings',
      'Settings2',
      '\u0410\u0406',
      '\u0391\u0399',
      '\u041a\u0435\u0443\u0455',
    ]) {
      expect(isModLabel(label), label).toBe(false);
    }
    for (const label of ['Said hello', 'Aim high', 'Flashcards', 'Monkeys']) {
      expect(isModLabel(label), label).toBe(true);
    }
  });

  it('holds the provider names to the AI connection list', () => {
    for (const p of MODEL_PROVIDERS.filter((p) => p !== 'custom')) expect(MOD_LABEL_FORBIDDEN_RE.test(p), p).toBe(true);
  });

  it('refuses links, bare domains, key-shaped values, invisible characters and mixed scripts', () => {
    for (const label of [
      'see https://x.test',
      'www.example',
      'evil.com/x',
      'pay.example',
      'sk-abcdef123',
      'AIzaSyabcdef',
      'Wa\u200Bter',
      'Water\u202E',
      '\uFEFFWater',
      'S\u0435ttings',
      'W\u0430ter',
      '\uFF21\uFF29',
      'a\u0085b',
    ]) {
      expect(isModLabel(label), JSON.stringify(label)).toBe(false);
    }
  });

  it('takes a plain label, and one written wholly in another script', () => {
    for (const label of ['Water counter', 'Глоток воды', 'Νερό', '💧 Water', 'Deep work: 25 min']) {
      expect(isModLabel(label), label).toBe(true);
    }
  });

  it('shows the slug when the name fails the rule', () => {
    expect(modDisplayLabel({ name: 'Water', slug: 'water' })).toBe('Water');
    expect(modDisplayLabel({ name: 'Sign in', slug: 'water' })).toBe('water');
    expect(modDisplayLabel({ name: 'x'.repeat(61), slug: 'water' })).toBe('water');
  });
});

describe('mod titles and toasts', () => {
  it('a title is at most 120, trimmed and NFKC-normalised, with no link, domain or key', () => {
    expect(ModTitleSchema.parse('  Drink water  ')).toBe('Drink water');
    expect(ModTitleSchema.parse('\uFF37ater')).toBe('Water');
    expect(ModTitleSchema.safeParse('x'.repeat(120)).success).toBe(true);
    for (const bad of ['x'.repeat(121), '', 'see https://x.test', 'go to evil.com/x', 'sk-abcdef123', 'AIzaSyabcdef', 'Wa\u200Bter']) {
      expect(ModTitleSchema.safeParse(bad).success, bad).toBe(false);
    }
    // A title is not a label: the app's words are fine in one.
    expect(ModTitleSchema.safeParse('Update account settings').success).toBe(true);
  });

  it('a toast is a title that also passes the label rule', () => {
    expect(ModToastTextSchema.safeParse('3 glasses today').success).toBe(true);
    expect(ModToastTextSchema.safeParse('Sign in again to keep going').success).toBe(false);
    expect(ModToastTextSchema.safeParse('Your Gemini key expired').success).toBe(false);
  });
});
