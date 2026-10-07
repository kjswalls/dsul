import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));

import { CONTRAST_PROBLEM, FALLBACK_NAME, parseMakeDraft, type DraftEnv } from '@/lib/make-draft';
import type { UserMod } from '@/lib/mods/schema';

/**
 * A "Write with AI" reply, checked (lib/make-draft.ts): the JSON is found,
 * the envelope read, the manifest held to the same schemas and run rules as
 * every saved row, plus the draft's own three rules (trigger-only steps, no
 * contrast override, refs of the person's own that exist).
 */

const ENV: DraftEnv = { recipe: { customTypeNames: [] }, rows: [] };

const recipe = (manifest: unknown, name = 'Stretch after a run') => JSON.stringify({ kind: 'recipe', name, manifest });
const GOOD_RECIPE = {
  version: 1,
  trigger: { on: 'item.completed' },
  steps: [{ do: 'create', type: 'task', title: 'Stretch' }],
};

function row(over: Partial<UserMod>): UserMod {
  return {
    id: crypto.randomUUID(),
    userId: 'u',
    kind: 'theme',
    slug: 'x',
    name: 'Row',
    enabled: false,
    manifest: {},
    disabledReason: null,
    createdAt: '2026-10-07T00:00:00Z',
    updatedAt: '2026-10-07T00:00:00Z',
    ...over,
  };
}

describe('finding the JSON', () => {
  it.each([
    ['bare', recipe(GOOD_RECIPE)],
    ['fenced', '```json\n' + recipe(GOOD_RECIPE) + '\n```'],
    ['in prose', 'Sure! Here it is:\n' + recipe(GOOD_RECIPE) + '\nEnjoy.'],
  ])('accepts a %s reply', (_label, raw) => {
    const r = parseMakeDraft(raw, 'recipe', ENV);
    expect(r).toMatchObject({ ok: true, problems: [], draft: { kind: 'recipe', name: 'Stretch after a run' } });
  });

  it.each([
    ['no JSON', 'I would make a recipe that adds a stretch.'],
    ['empty', ''],
    ['a list', '[1,2]'],
    ['no kind', JSON.stringify({ name: 'x', manifest: GOOD_RECIPE })],
  ])('refuses %s as unreadable', (_label, raw) => {
    expect(parseMakeDraft(raw, 'recipe', ENV)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('takes the last object of the asked kind when the model repeats an example first', () => {
    const other = JSON.stringify({ kind: 'theme', name: 'Moss', manifest: {} });
    const raw = `Like this: ${recipe(GOOD_RECIPE, 'Example')}\nAnd yours: ${recipe(GOOD_RECIPE, 'Yours {not a brace}')}\n${other}`;
    expect(parseMakeDraft(raw, 'recipe', ENV)).toMatchObject({ ok: true, draft: { name: 'Yours {not a brace}' } });
  });

  it('an object opened and never closed is cut_short', () => {
    expect(parseMakeDraft('{"kind":"recipe","manifest":{"version":1', 'recipe', ENV)).toEqual({
      ok: false,
      reason: 'cut_short',
    });
  });

  it('a reply of another kind is wrong_kind, naming it', () => {
    const raw = JSON.stringify({ kind: 'theme', name: 'x', manifest: {} });
    expect(parseMakeDraft(raw, 'recipe', ENV)).toEqual({ ok: false, reason: 'wrong_kind', suggest: 'theme' });
  });

  it('"none" is not_this_kind, with a suggestion only when it names another kind', () => {
    expect(parseMakeDraft('{"kind":"none","suggest":"recipe"}', 'theme', ENV)).toEqual({
      ok: false,
      reason: 'not_this_kind',
      suggest: 'recipe',
    });
    expect(parseMakeDraft('{"kind":"none","suggest":null}', 'theme', ENV)).toEqual({ ok: false, reason: 'not_this_kind' });
    expect(parseMakeDraft('{"kind":"none","suggest":"mod"}', 'theme', ENV)).toEqual({ ok: false, reason: 'not_this_kind' });
  });
});

describe('the name', () => {
  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['not text', 42],
    ['with a control character', 'Bad\u0007name'],
  ])('falls back when %s', (_label, name) => {
    const raw = JSON.stringify({ kind: 'recipe', ...(name !== undefined && { name }), manifest: GOOD_RECIPE });
    expect(parseMakeDraft(raw, 'recipe', ENV)).toMatchObject({ ok: true, draft: { name: FALLBACK_NAME.recipe } });
  });

  it('is clipped to 60 characters', () => {
    const r = parseMakeDraft(recipe(GOOD_RECIPE, 'n'.repeat(90)), 'recipe', ENV);
    expect(r.ok && r.draft.name).toBe('n'.repeat(60));
  });
});

describe('recipes', () => {
  it('refuses a schema failure', () => {
    expect(parseMakeDraft(recipe({ ...GOOD_RECIPE, steps: [{ do: 'delete', item: 'trigger' }] }), 'recipe', ENV)).toEqual({
      ok: false,
      reason: 'unreadable',
    });
    expect(parseMakeDraft(recipe({ ...GOOD_RECIPE, extra: 1 }), 'recipe', ENV)).toMatchObject({ ok: false });
  });

  it('refuses a step aimed at an item by id: the model never sees one', () => {
    const m = { ...GOOD_RECIPE, steps: [{ do: 'complete', item: { id: '11111111-1111-4111-8111-111111111111' } }] };
    expect(parseMakeDraft(recipe(m), 'recipe', ENV)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('turns run-rule failures into problems, which hold Install', () => {
    const timedToast = { version: 1, trigger: { on: 'time', at: '07:00' }, steps: [{ do: 'toast', text: 'Morning' }] };
    const habit = { ...GOOD_RECIPE, steps: [{ do: 'create', type: 'habit', title: 'Floss' }] };
    const unknownType = { ...GOOD_RECIPE, steps: [{ do: 'create', type: 'chore', title: 'Dishes' }] };
    for (const [m, needle] of [
      [timedToast, 'set time'],
      [habit, 'cannot add'],
      [unknownType, 'does not exist'],
    ] as const) {
      const r = parseMakeDraft(recipe(m), 'recipe', ENV);
      expect(r.ok).toBe(true);
      expect(r.ok && r.problems.join(' ')).toContain(needle);
    }
    // A custom type the person has is fine.
    const ok = parseMakeDraft(recipe(unknownType), 'recipe', { ...ENV, recipe: { customTypeNames: ['chore'] } });
    expect(ok).toMatchObject({ ok: true, problems: [] });
  });

  it('a theme or Look ref of the person\'s own must name one they have', () => {
    const theme = row({ kind: 'theme', id: '1234abcd-0000-4000-8000-000000000001', manifest: { version: 1, mode: 'dark', base: 'night', tokens: {} } });
    const look = row({ kind: 'look', id: 'abcdef12-0000-4000-8000-000000000002' });
    const m = {
      version: 1,
      trigger: { on: 'command' },
      steps: [
        { do: 'setTheme', mode: 'dark', theme: 'u-1234abcd' },
        { do: 'applyLook', look: 'u-abcdef12' },
      ],
    };
    expect(parseMakeDraft(recipe(m), 'recipe', { ...ENV, rows: [theme, look] })).toMatchObject({ ok: true, problems: [] });
    const r = parseMakeDraft(recipe(m), 'recipe', ENV);
    expect(r.ok && r.problems).toEqual(['Step 1 names a dark theme you do not have.', 'Step 2 names a Look you do not have.']);
    // Of the wrong mode is not theirs either.
    const wrongMode = parseMakeDraft(recipe({ ...m, steps: [{ do: 'setTheme', mode: 'light', theme: 'u-1234abcd' }] }), 'recipe', {
      ...ENV,
      rows: [theme],
    });
    expect(wrongMode.ok && wrongMode.problems).toEqual(['Step 1 names a light theme you do not have.']);
  });
});

describe('themes', () => {
  const theme = (manifest: unknown) => JSON.stringify({ kind: 'theme', name: 'Moss', manifest });

  it('strips contrastOverride and makes a shortfall a problem', () => {
    const r = parseMakeDraft(
      theme({ version: 1, mode: 'light', base: 'paper', tokens: { ink0: '#f0f0f0' }, contrastOverride: true }),
      'theme',
      ENV
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.draft.kind !== 'theme') return;
    expect('contrastOverride' in r.draft.manifest).toBe(false);
    expect(r.draft.warnings.length).toBeGreaterThan(0);
    expect(r.problems).toEqual([CONTRAST_PROBLEM]);
  });

  it('refuses alpha out of bounds, and alpha where none is allowed', () => {
    expect(parseMakeDraft(theme({ version: 1, mode: 'light', base: 'paper', tokens: { scrim: 'oklch(0.2 0 0 / 90%)' } }), 'theme', ENV)).toMatchObject({ ok: false });
    expect(parseMakeDraft(theme({ version: 1, mode: 'light', base: 'paper', tokens: { limeSolid: 'oklch(0.8 0.1 90 / 50%)' } }), 'theme', ENV)).toMatchObject({ ok: false });
    expect(parseMakeDraft(theme({ version: 1, mode: 'light', base: 'night', tokens: {} }), 'theme', ENV)).toMatchObject({ ok: false });
    expect(parseMakeDraft(theme({ version: 1, mode: 'light', base: 'paper', tokens: { paper0: 'url(x)' } }), 'theme', ENV)).toMatchObject({ ok: false });
  });

  it('re-prints every value in the host\'s own form', () => {
    const r = parseMakeDraft(theme({ version: 1, mode: 'light', base: 'paper', tokens: { paper0: '#EEF', ink0: 'oklch(20% 0.0100 272)' } }), 'theme', ENV);
    expect(r.ok && r.draft.manifest).toMatchObject({ tokens: { paper0: '#eeeeff', ink0: 'oklch(0.2 0.01 272)' } });
  });
});

describe('Looks', () => {
  const look = (manifest: unknown) => JSON.stringify({ kind: 'look', name: 'Deep work', manifest });

  it('takes built-ins as they are', () => {
    expect(parseMakeDraft(look({ version: 1, layout: 'notebook', light: 'paper', dark: 'night' }), 'look', ENV)).toMatchObject({
      ok: true,
      problems: [],
    });
  });

  it('an unknown or wrong-mode ref of the person\'s own is a problem', () => {
    const dark = row({ kind: 'theme', id: '1234abcd-0000-4000-8000-000000000001', manifest: { version: 1, mode: 'dark', base: 'night', tokens: {} } });
    const unknown = parseMakeDraft(look({ version: 1, layout: 'classic', light: 'u-99999999', dark: 'night' }), 'look', ENV);
    expect(unknown.ok && unknown.problems).toEqual(['Pick a light theme.']);
    const wrongMode = parseMakeDraft(look({ version: 1, layout: 'classic', light: 'u-1234abcd', dark: 'night' }), 'look', { ...ENV, rows: [dark] });
    expect(wrongMode.ok && wrongMode.problems).toEqual(['Pick a light theme.']);
    const theirs = parseMakeDraft(look({ version: 1, layout: 'classic', light: 'paper', dark: 'u-1234abcd' }), 'look', { ...ENV, rows: [dark] });
    expect(theirs).toMatchObject({ ok: true, problems: [] });
  });

  it('refuses a layout that is not one of LAYOUTS', () => {
    expect(parseMakeDraft(look({ version: 1, layout: 'grid', light: 'paper', dark: 'night' }), 'look', ENV)).toMatchObject({ ok: false });
  });
});
