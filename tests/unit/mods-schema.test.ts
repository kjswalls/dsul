import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MOD_KINDS,
  ModNameSchema,
  ModSlugSchema,
  RECIPE_EVENT_TRIGGERS,
  RECIPE_MAX_STEPS,
  RECIPE_VERBS,
  RecipeManifestSchema,
  UserModRowSchema,
  manifestSchemaFor,
  userModFromRow,
} from '@/lib/mods/schema';
import { ITEM_VERBS } from '@/lib/item-verbs';

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
  it('mods, themes and Looks accept anything until their PRs land', () => {
    for (const kind of MOD_KINDS.filter((k) => k !== 'recipe')) {
      expect(manifestSchemaFor(kind).safeParse({ whatever: [1] }).success, kind).toBe(true);
    }
    expect(manifestSchemaFor('recipe')).toBe(RecipeManifestSchema);
  });
});
