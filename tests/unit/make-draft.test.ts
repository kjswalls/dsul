import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));

import {
  CONTRAST_PROBLEM,
  ECHO_COPY,
  FALLBACK_NAME,
  draftChecks,
  finishModDraft,
  parseMakeDraft,
  scanJsonObjects,
  type DraftEnv,
} from '@/lib/make-draft';
import { MOD_SOURCE_MAX_BYTES, ModManifestSchema, type ModManifest, type UserMod } from '@/lib/mods/schema';
import { MOD_TEMPLATE } from '@/lib/mods/template';

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
    // A mod is a kind Write makes now (build order 10), so it is offered.
    expect(parseMakeDraft('{"kind":"none","suggest":"mod"}', 'theme', ENV)).toEqual({
      ok: false,
      reason: 'not_this_kind',
      suggest: 'mod',
    });
    expect(parseMakeDraft('{"kind":"none","suggest":"plugin"}', 'theme', ENV)).toEqual({ ok: false, reason: 'not_this_kind' });
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
    expect(r.ok === true && r.draft.name).toBe('n'.repeat(60));
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
      expect(r.ok === true && r.problems.join(' ')).toContain(needle);
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
    expect(r.ok === true && r.problems).toEqual(['Step 1 names a dark theme you do not have.', 'Step 2 names a Look you do not have.']);
    // Of the wrong mode is not theirs either.
    const wrongMode = parseMakeDraft(recipe({ ...m, steps: [{ do: 'setTheme', mode: 'light', theme: 'u-1234abcd' }] }), 'recipe', {
      ...ENV,
      rows: [theme],
    });
    expect(wrongMode.ok === true && wrongMode.problems).toEqual(['Step 1 names a light theme you do not have.']);
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
    if (r.ok !== true || r.draft.kind !== 'theme') return;
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
    expect(r.ok === true && r.draft.manifest).toMatchObject({ tokens: { paper0: '#eeeeff', ink0: 'oklch(0.2 0.01 272)' } });
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
    expect(unknown.ok === true && unknown.problems).toEqual(['Pick a light theme.']);
    const wrongMode = parseMakeDraft(look({ version: 1, layout: 'classic', light: 'u-1234abcd', dark: 'night' }), 'look', { ...ENV, rows: [dark] });
    expect(wrongMode.ok === true && wrongMode.problems).toEqual(['Pick a light theme.']);
    const theirs = parseMakeDraft(look({ version: 1, layout: 'classic', light: 'paper', dark: 'u-1234abcd' }), 'look', { ...ENV, rows: [dark] });
    expect(theirs).toMatchObject({ ok: true, problems: [] });
  });

  it('refuses a layout that is not one of LAYOUTS', () => {
    expect(parseMakeDraft(look({ version: 1, layout: 'grid', light: 'paper', dark: 'night' }), 'look', ENV)).toMatchObject({ ok: false });
  });
});

describe('mods', () => {
  const SOURCE = MOD_TEMPLATE.replace('const GOAL = 8;', 'const GOAL = 6;');
  const mod = (source: unknown, name = 'Six glasses') => JSON.stringify({ kind: 'mod', name, source });
  const MANIFEST: ModManifest = ModManifestSchema.parse({
    version: 1,
    uses: ['storage', 'ui'],
    commands: [{ id: 'add-glass', label: 'Add a glass', keywords: ['water', 'drink'] }],
    panels: [{ id: 'water', label: 'Water', icon: 'CupSoda', card: true }],
  });
  const HOOKS = ['command', 'ui.resolve', 'ui.action'] as const;
  const ran = (manifest: unknown = MANIFEST, hooks: readonly string[] = HOOKS) => ({
    manifestJson: JSON.stringify(manifest),
    hooks: [...hooks] as never,
  });
  const pending = { name: 'Six glasses', source: SOURCE };

  describe('the reply', () => {
    it('an envelope goes to the sandbox, its source exactly as written', () => {
      expect(parseMakeDraft(mod(SOURCE), 'mod', ENV)).toEqual({ ok: 'scratch', name: 'Six glasses', source: SOURCE });
    });

    it('an object left open at the end is cut_short, even after one that closed', () => {
      const raw = `${mod(SOURCE, 'Example')}\n{"kind":"mod","name":"Mine","source":"export const manifest = {`;
      expect(parseMakeDraft(raw, 'mod', ENV)).toEqual({ ok: false, reason: 'cut_short' });
      // A recipe keeps the older rule: the closed object is read.
      const recipeRaw = `${recipe(GOOD_RECIPE)}\n{"kind":"recipe","manifest":{`;
      expect(parseMakeDraft(recipeRaw, 'recipe', ENV)).toMatchObject({ ok: true });
    });

    it('over the byte cap is unreadable', () => {
      expect(parseMakeDraft(mod('x'.repeat(MOD_SOURCE_MAX_BYTES + 1)), 'mod', ENV)).toEqual({
        ok: false,
        reason: 'unreadable',
      });
    });

    it.each([
      ['no source', JSON.stringify({ kind: 'mod', name: 'x' })],
      ['a blank source', mod('  ')],
      ['a source that is not text', mod({ code: 1 })],
    ])('%s is unreadable', (_label, raw) => {
      expect(parseMakeDraft(raw, 'mod', ENV)).toEqual({ ok: false, reason: 'unreadable' });
    });

    it('the example repeated back is refused as an echo', () => {
      expect(parseMakeDraft(mod(MOD_TEMPLATE, 'Water'), 'mod', ENV)).toEqual({
        ok: false,
        reason: 'unreadable',
        message: ECHO_COPY,
      });
    });

    it('raw newlines and tabs inside the string are repaired, for a mod only', () => {
      const raw = '{"kind":"mod","name":"Six glasses","source":"' + SOURCE.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '\t"}';
      expect(raw).toContain('\n');
      expect(parseMakeDraft(raw, 'mod', ENV)).toEqual({ ok: 'scratch', name: 'Six glasses', source: SOURCE + '\t' });
      const recipeRaw = '{"kind":"recipe","name":"Two\nlines","manifest":' + JSON.stringify(GOOD_RECIPE) + '}';
      expect(parseMakeDraft(recipeRaw, 'recipe', ENV)).toEqual({ ok: false, reason: 'unreadable' });
      expect(scanJsonObjects(recipeRaw).objects).toEqual([]);
      expect(scanJsonObjects(recipeRaw, { repairControls: true }).objects).toHaveLength(1);
    });

    it('"none" can point at a mod, and a mod ask at a recipe', () => {
      expect(parseMakeDraft('{"kind":"none","suggest":"mod"}', 'recipe', ENV)).toEqual({
        ok: false,
        reason: 'not_this_kind',
        suggest: 'mod',
      });
      expect(parseMakeDraft('{"kind":"none","suggest":"recipe"}', 'mod', ENV)).toEqual({
        ok: false,
        reason: 'not_this_kind',
        suggest: 'recipe',
      });
    });

    it('a mod name must pass the label rule; a recipe name need not', () => {
      expect(parseMakeDraft(mod(SOURCE, 'AI helper'), 'mod', ENV)).toMatchObject({ ok: 'scratch', name: 'New mod' });
      expect(parseMakeDraft(mod(SOURCE, 'Card rhythm'), 'mod', ENV)).toMatchObject({ name: 'New mod' });
      expect(parseMakeDraft(recipe(GOOD_RECIPE, 'Card rhythm'), 'recipe', ENV)).toMatchObject({
        ok: true,
        draft: { name: 'Card rhythm' },
      });
    });
  });

  describe('finishModDraft', () => {
    it('a clean run is a draft with no problems, the manifest the code declared', () => {
      expect(finishModDraft(pending, ran())).toEqual({
        ok: true,
        draft: { kind: 'mod', name: 'Six glasses', source: SOURCE, manifest: MANIFEST, hooks: [...HOOKS] },
        problems: [],
      });
    });

    it('a fault is a draft with no manifest, its message held to the surface rule, Install held', () => {
      const key = 'sk-' + 'a1'.repeat(20);
      const r = finishModDraft(pending, { fault: { code: 'error', message: `bad ${key}` } });
      expect(r).toEqual({
        ok: true,
        draft: { kind: 'mod', name: 'Six glasses', source: SOURCE, manifest: null, hooks: [] },
        problems: ['It would not load: it hit an error.', 'Your mod reported: (message hidden)'],
      });
      expect(finishModDraft(pending, { fault: { code: 'load', message: 'register is not a function' } })).toMatchObject({
        problems: ['It would not load.', 'Your mod reported: register is not a function'],
      });
    });

    it('a manifest the schema refuses is held, by path only', () => {
      const r = finishModDraft(pending, ran({ version: 1, uses: ['ui'], commands: [{ id: 'Go', label: 'Go' }] }));
      expect(r).toMatchObject({ ok: true, draft: { manifest: null }, problems: ['Its manifest is not valid.', 'Check "commands.0.id" in it.'] });
      expect(finishModDraft(pending, { manifestJson: '{', hooks: [] })).toMatchObject({
        problems: ['Its manifest is not valid.'],
      });
    });
  });

  describe('draftChecks', () => {
    const just = (uses: ModManifest['uses'], body: string, extra: Partial<ModManifest> = {}) => ({
      source: `export const manifest = { version: 1, uses: ${JSON.stringify(uses)} };\nexport function register(on) {\n  on('item.completed', async ($, e) => {\n    ${body}\n  });\n}\n`,
      manifest: ModManifestSchema.parse({ version: 1, uses, ...extra }),
    });

    it('the template has none', () => {
      expect(draftChecks(MOD_TEMPLATE, MANIFEST, HOOKS)).toEqual([]);
    });

    it('a panel with no ui.resolve, commands with no command hook, and the reverse, are held', () => {
      expect(draftChecks(SOURCE, MANIFEST, ['command', 'ui.action'])).toEqual([
        'It has panels but no "ui.resolve" hook to draw them.',
      ]);
      expect(draftChecks(SOURCE, MANIFEST, ['ui.resolve', 'ui.action'])).toEqual([
        'It has commands but no "command" hook to run them.',
      ]);
      const bare = ModManifestSchema.parse({ version: 1, uses: ['storage', 'ui'] });
      expect(draftChecks(SOURCE, bare, ['command', 'atom.changed'])).toEqual([
        'It has a "command" hook but no commands.',
        'It listens to a panel but has no panels.',
      ]);
    });

    it('a $ use it did not declare, and a $ method mods do not have, are held', () => {
      const { source, manifest } = just(['ui'], "await $.items.create({ type: 'task', title: 'Stretch' }); await $.ai.ask({});");
      expect(draftChecks(source, manifest, ['item.completed'])).toEqual([
        'It uses $.items.create but did not ask to add and change items.',
        'It calls $.ai.ask, which mods do not have.',
      ]);
    });

    it('$ calls in comments and strings are not read as calls', () => {
      const { source, manifest } = just([], "// $.ai.ask(x)\n/* $.items.create( */ const s = '$.chat.send(';");
      expect(draftChecks(source, manifest, ['item.completed'])).toEqual([]);
    });

    it.each([
      ['a link', "const u = 'https://example.com/x';", 'Its code holds a link. Mods cannot reach the web.'],
      ['a www address', 'const u = "www.example.com";', 'Its code holds a link. Mods cannot reach the web.'],
      ['a key', `const k = 'sk-${'Ab1'.repeat(12)}';`, 'Its code holds something shaped like a key.'],
    ])('a literal holding %s is held', (_label, body, problem) => {
      const { source, manifest } = just([], body);
      expect(draftChecks(source, manifest, ['item.completed'])).toEqual([problem]);
    });

    it('event names and a link in a comment do not trip the literal scan', () => {
      const { source, manifest } = just([], "// see https://example.com\nconst k = ['ui.resolve', 'item.completed', \"atom.changed\"];");
      expect(draftChecks(source, manifest, ['item.completed'])).toEqual([]);
    });

    it('a command label the label rule takes but the surface rule does not is held', () => {
      const m = ModManifestSchema.parse({ ...MANIFEST, commands: [{ id: 'add-glass', label: 'Chat', keywords: ['ask'] }] });
      expect(draftChecks(SOURCE, m, HOOKS)).toEqual([
        'Command 1 has a label that cannot be shown.',
        'Command 1 has a keyword that cannot be shown.',
      ]);
    });
  });
});
